// M5 OPS02: outcome classifier, privacy-safe logging, bounded deferred recording, the instrumented save
// action and export routes (results unchanged), and the operations page application section.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_LIMITS, APP_PROVENANCE, assessApp, classifyRejection, OPS, sustained, validateAppSnapshot, type AppSnapshot, type OpCounts,
} from "@/lib/application-outcomes";
import { observeOutcome, observed, recordBounded, type Recorder, type TelemetryDeps } from "@/lib/outcome-telemetry";

const state = vi.hoisted(() => ({
  tasks: [] as (() => Promise<void>)[],
  after: vi.fn(),
  rpc: vi.fn(),
  getUser: vi.fn(),
  revalidate: vi.fn(),
  buildPdf: vi.fn(),
  buildAnalyticsPdf: vi.fn(),
  buildAnalytics: vi.fn(),
  user: true,
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: state.after }));
vi.mock("next/cache", () => ({ revalidatePath: state.revalidate }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); }, redirect: (u: string) => { throw new Error(`REDIRECT ${u}`); },
}));
const abortable = (r: unknown) => ({ abortSignal: () => Promise.resolve(r), then: (f: (v: unknown) => unknown) => Promise.resolve(r).then(f) });
const client = () => ({ auth: { getUser: state.getUser }, rpc: (fn: string, args?: unknown) => abortable(state.rpc(fn, args)) });
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  requireUser: async (next?: string) => {
    if (!state.user) throw new Error(`REDIRECT /login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
    return { supabase: client(), user: { id: "u" } };
  },
}));
vi.mock("@/lib/pdf", () => ({ buildPdf: state.buildPdf, buildAnalyticsPdf: state.buildAnalyticsPdf }));
vi.mock("@/lib/report", () => ({
  buildCsv: () => "CSV_BODY", exportFilename: (_: unknown, f: string) => `report.${f}`,
  buildDashboardCsv: () => "DASH_BODY",
}));
vi.mock("@/lib/scoring", () => ({ isKnownFormula: (v: string) => v === "f1" }));
vi.mock("@/lib/analytics", () => ({ buildAnalytics: state.buildAnalytics, parseFilters: () => ({ filters: {} }) }));
vi.mock("@/lib/analytics-export", () => ({ analyticsFilename: (_: unknown, f: string) => `analytics.${f}`, buildAnalyticsCsv: () => "ANALYTICS_CSV" }));

const { NextRequest } = await import("next/server");
const action = await import("@/app/w/[ws]/sessions/[id]/actions");
const reportRoute = await import("@/app/w/[ws]/sessions/[id]/report/export/route");
const analyticsRoute = await import("@/app/w/[ws]/analytics/export/route");
const dashboardRoute = await import("@/app/w/[ws]/export/route");
const page = await import("@/app/platform/operations/page");

const WS = "eeeeeeee-5300-4000-8000-000000000001";
const SID = "eeeeeeee-5300-4000-8000-000000000002";
const SECRET_MARKERS = ["MARKER_NOTE", "MARKER_PAYLOAD", "MARKER_ERR", WS, SID, "redact", "revision", "format=", "http", "@"];

let logs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((l: unknown) => { logs.push(String(l)); });
  state.tasks = [];
  state.after.mockReset().mockImplementation((t: () => Promise<void>) => { state.tasks.push(t); });
  state.rpc.mockReset();
  state.getUser.mockReset().mockResolvedValue({ data: { user: { id: "u" } } });
  state.revalidate.mockReset();
  state.buildPdf.mockReset().mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  state.buildAnalyticsPdf.mockReset().mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  state.buildAnalytics.mockReset().mockReturnValue({});
  state.user = true;
});
afterEach(() => { logSpy.mockRestore(); vi.useRealTimers(); });

const events = () => logs.map((l) => JSON.parse(l) as Record<string, string>);
const outcomes = () => events().filter((e) => e.event === "application_outcome").map((e) => `${e.op}:${e.outcome}`);
const noLeak = () => { for (const l of logs) for (const m of SECRET_MARKERS) expect(l, m).not.toContain(m); };
const runTasks = async () => { for (const t of state.tasks.splice(0)) await t(); };

const fakeDeps = (over: Partial<TelemetryDeps> = {}) => {
  const lines: string[] = [];
  const scheduled: (() => Promise<void>)[] = [];
  const deps: TelemetryDeps = {
    log: (l) => lines.push(l), schedule: (t) => scheduled.push(t), uuid: () => "00000000-0000-4000-8000-0000000000aa",
    now: () => new Date("2026-10-12T22:00:00.000Z"), timeoutMs: 750, ...over,
  };
  return { deps, lines, scheduled };
};

// ---------------------------------------------------------------------------
describe("classifier", () => {
  it("known business codes are rejected; anything else, including near misses and non-strings, is failed", () => {
    for (const c of ["stale_version", "forbidden", "not_found", "not_authenticated", "not_assigned", "window_closed", "invalid_filter", "invalid_score"]) {
      expect(classifyRejection(c), c).toBe("rejected");
    }
    for (const c of ["canceling statement due to statement timeout", "TypeError: fetch failed", "JWT expired", "billing_not_initialized",
      "Forbidden", " forbidden", "forbidden: x", "", null, undefined, 42, { message: "forbidden" }]) {
      expect(classifyRejection(c), String(c)).toBe("failed");
    }
  });
});

describe("observation helper", () => {
  it("logs exactly the static fields with a server UUID, then schedules one recording", async () => {
    const { deps, lines, scheduled } = fakeDeps();
    const record = vi.fn<Recorder>(async () => ({ error: null }));
    observeOutcome("report_pdf", "success", record, deps);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: "application_outcome", id: "00000000-0000-4000-8000-0000000000aa", op: "report_pdf", outcome: "success", at: "2026-10-12T22:00:00.000Z" }]);
    expect(record).not.toHaveBeenCalled(); // deferred until after the response
    expect(scheduled).toHaveLength(1);
    await scheduled[0]();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0].slice(0, 2)).toEqual(["report_pdf", "success"]);
    expect(record.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
    expect(lines).toHaveLength(1);
  });
  it("without a session recorder it only logs (signed-out callers are never counted)", () => {
    const { deps, lines, scheduled } = fakeDeps();
    observeOutcome("dashboard_csv", "rejected", null, deps);
    expect(lines).toHaveLength(1);
    expect(scheduled).toHaveLength(0);
  });
  it("a throwing console or scheduler never reaches the caller; a scheduling error logs a static line", () => {
    const record = vi.fn<Recorder>();
    expect(() => observeOutcome("report_csv", "success", record, fakeDeps({ log: () => { throw new Error("EPIPE"); } }).deps)).not.toThrow();
    const { deps, lines } = fakeDeps({ schedule: () => { throw new Error("after() outside request scope MARKER_ERR"); } });
    expect(() => observeOutcome("report_csv", "success", record, deps)).not.toThrow();
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(["application_outcome", "telemetry_recording_failed"]);
    expect(lines.join()).not.toContain("MARKER_ERR");
    expect(record).not.toHaveBeenCalled();
  });
  it.each([
    ["database error", async () => ({ error: { message: "relation does not exist MARKER_ERR" } })],
    ["rejected promise", async () => { throw new Error("fetch failed MARKER_ERR"); }],
    ["synchronous throw", () => { throw new Error("MARKER_ERR"); }],
  ] as [string, Recorder][])("%s: one static telemetry_recording_failed line, no raw text, no recursion, never rejects", async (_, record) => {
    const { deps, lines } = fakeDeps();
    const spy = vi.fn(record);
    await expect(recordBounded(spy, "assessment_save", "failed", deps)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: "telemetry_recording_failed", op: "assessment_save", at: "2026-10-12T22:00:00.000Z" }]);
  });
  it("a hung recorder is aborted and abandoned at the bound", async () => {
    vi.useFakeTimers();
    const { deps, lines } = fakeDeps();
    let signal: AbortSignal | undefined;
    const done = recordBounded((_, __, s) => { signal = s; return new Promise(() => {}); }, "analytics_pdf", "success", deps);
    await vi.advanceTimersByTimeAsync(749);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBeUndefined();
    expect(signal!.aborted).toBe(true);
    expect(JSON.parse(lines[0]).event).toBe("telemetry_recording_failed");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("observed() returns the body's value untouched and rethrows the original error after observing failed", async () => {
    const { deps, lines } = fakeDeps();
    const value = { ok: true, version: 7, replayed: false };
    await expect(observed("assessment_save", async () => ({ outcome: "success", value }), deps)).resolves.toBe(value);
    const boom = new Error("render exploded MARKER_ERR");
    await expect(observed("report_pdf", async () => { throw boom; }, deps)).rejects.toBe(boom);
    expect(lines.map((l) => [JSON.parse(l).op, JSON.parse(l).outcome])).toEqual([["assessment_save", "success"], ["report_pdf", "failed"]]);
    expect(lines.join()).not.toContain("MARKER_ERR");
  });
  it("is imported only by server modules (no client component pulls in after or the recorder)", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(p); } };
    const src = join(import.meta.dirname, "..", "..", "src");
    walk(src);
    const importers = files.filter((f) => readFileSync(f, "utf8").includes("@/lib/outcome-telemetry")).map((f) => f.slice(src.length + 1)).sort();
    expect(importers).toEqual(["app/w/[ws]/analytics/export/route.ts", "app/w/[ws]/export/route.ts", "app/w/[ws]/sessions/[id]/actions.ts",
      "app/w/[ws]/sessions/[id]/report/export/route.ts"]);
    expect(readFileSync(join(src, "app/w/[ws]/sessions/[id]/actions.ts"), "utf8")).toMatch(/^"use server";/);
  });
});

// ---------------------------------------------------------------------------
const payload = { ws: WS, session: SID, subject: SID, assessor: SID, observed: null, answers: { c1: { score: 3 } },
  notes: "MARKER_NOTE", expectedVersion: 2, idempotencyKey: SID, reason: "MARKER_PAYLOAD" } as unknown as Parameters<typeof action.submitAssessment>[0];

describe("submitAssessment", () => {
  it("success: same receipt, revalidates, logs success and records through the session after the response", async () => {
    state.rpc.mockReturnValue({ data: { version: 3, replayed: false }, error: null });
    expect(await action.submitAssessment(payload)).toEqual({ ok: true, version: 3, replayed: false });
    expect(state.revalidate).toHaveBeenCalledWith(`/w/${WS}/sessions/${SID}`);
    expect(outcomes()).toEqual(["assessment_save:success"]);
    expect(state.rpc.mock.calls.map((c) => c[0])).toEqual(["submit_assessment"]);
    await runTasks();
    expect(state.rpc.mock.calls[1]).toEqual(["record_application_outcome", { p_op: "assessment_save", p_outcome: "success" }]);
    noLeak();
  });
  it("replay keeps replayed=true and is counted as replayed", async () => {
    state.rpc.mockReturnValue({ data: { version: 3, replayed: true }, error: null });
    expect(await action.submitAssessment(payload)).toEqual({ ok: true, version: 3, replayed: true });
    expect(outcomes()).toEqual(["assessment_save:replayed"]);
  });
  it("stale_version is rejected with the original friendly message and code", async () => {
    state.rpc.mockReturnValue({ data: null, error: { message: "stale_version" } });
    const r = await action.submitAssessment(payload);
    expect(r).toEqual({ ok: false, code: "stale_version", error: expect.stringContaining("changed by someone else") });
    expect(outcomes()).toEqual(["assessment_save:rejected"]);
    expect(state.revalidate).not.toHaveBeenCalled();
  });
  it("an unknown database error is failed; the response still carries the original code", async () => {
    state.rpc.mockReturnValue({ data: null, error: { message: "MARKER_ERR deadlock detected" } });
    const r = await action.submitAssessment(payload);
    expect(r).toMatchObject({ ok: false, code: "MARKER_ERR deadlock detected" });
    expect(outcomes()).toEqual(["assessment_save:failed"]);
    noLeak();
  });
  it("a thrown error is observed as failed and the same error is rethrown", async () => {
    const boom = new Error("socket hang up MARKER_ERR");
    state.rpc.mockImplementation(() => { throw boom; });
    await expect(action.submitAssessment(payload)).rejects.toBe(boom);
    expect(outcomes()).toEqual(["assessment_save:failed"]);
    noLeak();
  });
  it("the sign-in redirect stays outside the observation (nothing logged, nothing scheduled)", async () => {
    state.user = false;
    await expect(action.submitAssessment(payload)).rejects.toThrow("REDIRECT /login");
    expect(logs).toEqual([]);
    expect(state.after).not.toHaveBeenCalled();
  });
  it("a failing or hung counter update cannot change the result", async () => {
    state.rpc.mockImplementation((fn: string) => fn === "record_application_outcome" ? { data: null, error: { message: "permission denied" } }
      : { data: { version: 4, replayed: false }, error: null });
    expect(await action.submitAssessment(payload)).toEqual({ ok: true, version: 4, replayed: false });
    await runTasks();
    expect(events().map((e) => e.event)).toEqual(["application_outcome", "telemetry_recording_failed"]);
  });
});

// ---------------------------------------------------------------------------
const req = (path: string) => new NextRequest(`http://localhost${path}`);
const env = (over: Record<string, unknown> = {}) => ({ meta: { workspace_id: WS }, inputs: { formula_version: "f1" }, ...over });
const reportGet = (q: string, id = SID) => reportRoute.GET(req(`/w/${WS}/sessions/${id}/report/export?${q}`), { params: Promise.resolve({ ws: WS, id }) });
const analyticsGet = (q: string, ws = WS) => analyticsRoute.GET(req(`/w/${ws}/analytics/export?${q}`), { params: Promise.resolve({ ws }) });
const dashboardGet = (ws = WS) => dashboardRoute.GET(req(`/w/${ws}/export`), { params: Promise.resolve({ ws }) });
const PRIVATE = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
const expectPrivate = (r: Response) => { for (const [k, v] of Object.entries(PRIVATE)) expect(r.headers.get(k)).toBe(v); };

describe("report export route", () => {
  it("csv and pdf success: same body, type and attachment headers; generated (not delivered) is success", async () => {
    state.rpc.mockReturnValue({ data: env(), error: null });
    const csv = await reportGet("format=csv&redact=1&revision=2");
    expect([csv.status, await csv.text(), csv.headers.get("content-type"), csv.headers.get("content-disposition")])
      .toEqual([200, "CSV_BODY", "text/csv; charset=utf-8", 'attachment; filename="report.csv"']);
    expectPrivate(csv);
    expect(state.rpc.mock.calls[0]).toEqual(["get_session_report", { p_session: SID, p_revision: 2, p_redact: true, p_purpose: "csv" }]);
    const pdf = await reportGet("format=pdf");
    expect([pdf.status, pdf.headers.get("content-type")]).toEqual([200, "application/pdf"]);
    expect(outcomes()).toEqual(["report_csv:success", "report_pdf:success"]);
    await runTasks();
    expect(state.rpc.mock.calls.filter((c) => c[0] === "record_application_outcome").map((c) => c[1]))
      .toEqual([{ p_op: "report_csv", p_outcome: "success" }, { p_op: "report_pdf", p_outcome: "success" }]);
    noLeak();
  });
  it("bad format is a 400 with no observation (no operation); a bad id is a rejected 400 before sign-in", async () => {
    expect((await reportGet("format=xml")).status).toBe(400);
    expect(logs).toEqual([]);
    const r = await reportGet("format=csv", "nope");
    expect([r.status, await r.text()]).toEqual([400, "Bad request"]);
    expect(outcomes()).toEqual(["report_csv:rejected"]);
    expect(state.after).not.toHaveBeenCalled();
  });
  it("signed out: 401 unchanged, logged as rejected, nothing recorded in the database", async () => {
    state.getUser.mockResolvedValue({ data: { user: null } });
    const r = await reportGet("format=pdf");
    expect([r.status, await r.text()]).toEqual([401, "Sign in required"]);
    expect(outcomes()).toEqual(["report_pdf:rejected"]);
    expect(state.after).not.toHaveBeenCalled();
  });
  it("denial and not-found are rejected; a technical RPC error keeps the legacy 404 but is failed", async () => {
    state.rpc.mockReturnValueOnce({ data: null, error: { message: "forbidden" } });
    expect((await reportGet("format=csv")).status).toBe(403);
    state.rpc.mockReturnValueOnce({ data: null, error: null });
    expect((await reportGet("format=csv")).status).toBe(404);
    state.rpc.mockReturnValueOnce({ data: env({ meta: { workspace_id: SID } }), error: null });
    expect((await reportGet("format=csv")).status).toBe(404);
    state.rpc.mockReturnValueOnce({ data: null, error: { message: "MARKER_ERR connection terminated" } });
    const r = await reportGet("format=csv");
    expect([r.status, await r.text()]).toEqual([404, "Not found"]);
    expect(outcomes()).toEqual(["report_csv:rejected", "report_csv:rejected", "report_csv:rejected", "report_csv:failed"]);
    noLeak();
  });
  it("unsupported formula keeps its 422 and is failed; a thrown PDF render is failed and rethrown unchanged", async () => {
    state.rpc.mockReturnValue({ data: env({ inputs: { formula_version: "f9" } }), error: null });
    expect((await reportGet("format=pdf")).status).toBe(422);
    state.rpc.mockReturnValue({ data: env(), error: null });
    const boom = new Error("font missing MARKER_ERR");
    state.buildPdf.mockRejectedValue(boom);
    await expect(reportGet("format=pdf")).rejects.toBe(boom);
    expect(outcomes()).toEqual(["report_pdf:failed", "report_pdf:failed"]);
    noLeak();
  });
});

describe("analytics export route", () => {
  it("success csv/pdf; invalid filter and denial are rejected with unchanged statuses", async () => {
    state.rpc.mockReturnValue({ data: { records: [] }, error: null });
    const csv = await analyticsGet("format=csv&mode=provisional&location=MARKER_PAYLOAD");
    expect([csv.status, await csv.text(), csv.headers.get("content-disposition")]).toEqual([200, "ANALYTICS_CSV", 'attachment; filename="analytics.csv"']);
    expect((await analyticsGet("format=pdf")).headers.get("content-type")).toBe("application/pdf");
    state.rpc.mockReturnValueOnce({ data: null, error: { message: "invalid_filter" } });
    const bad = await analyticsGet("format=csv");
    expect([bad.status, await bad.text()]).toEqual([400, "Invalid filter"]);
    state.rpc.mockReturnValueOnce({ data: null, error: { message: "forbidden" } });
    expect((await analyticsGet("format=csv")).status).toBe(403);
    expect(outcomes()).toEqual(["analytics_csv:success", "analytics_pdf:success", "analytics_csv:rejected", "analytics_csv:rejected"]);
    noLeak();
  });
  it("a technical RPC error is failed behind the legacy 404", async () => {
    state.rpc.mockReturnValue({ data: null, error: { message: "MARKER_ERR timeout" } });
    expect((await analyticsGet("format=pdf")).status).toBe(404);
    expect(outcomes()).toEqual(["analytics_pdf:failed"]);
  });
  it("buildAnalytics exception keeps the 422 response but is failed; a thrown render is failed and rethrown", async () => {
    state.rpc.mockReturnValue({ data: { records: [] }, error: null });
    state.buildAnalytics.mockImplementation(() => { throw new Error("Mixed data."); });
    const r = await analyticsGet("format=csv");
    expect([r.status, await r.text()]).toEqual([422, "Mixed data. Nothing exported."]);
    state.buildAnalytics.mockReturnValue({});
    const boom = new Error("pdf MARKER_ERR");
    state.buildAnalyticsPdf.mockRejectedValue(boom);
    await expect(analyticsGet("format=pdf")).rejects.toBe(boom);
    expect(outcomes()).toEqual(["analytics_csv:failed", "analytics_pdf:failed"]);
  });
  it("bad format: no observation; bad workspace: rejected 400; signed out: rejected 401 not recorded", async () => {
    expect((await analyticsGet("format=doc")).status).toBe(400);
    expect((await analyticsGet("format=csv", "x")).status).toBe(400);
    state.getUser.mockResolvedValue({ data: { user: null } });
    expect((await analyticsGet("format=csv")).status).toBe(401);
    expect(outcomes()).toEqual(["analytics_csv:rejected", "analytics_csv:rejected"]);
    expect(state.after).not.toHaveBeenCalled();
  });
});

describe("dashboard export route", () => {
  const ctx = { data: { workspace: { name: "MARKER_PAYLOAD", timezone: "UTC" } }, error: null };
  it("success keeps the body and headers", async () => {
    state.rpc.mockImplementation((fn: string) => fn === "workspace_context" ? ctx : { data: {}, error: null });
    const r = await dashboardGet();
    expect([r.status, await r.text(), r.headers.get("content-type")]).toEqual([200, "DASH_BODY", "text/csv; charset=utf-8"]);
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="savour-dashboard-\d{4}-\d{2}-\d{2}\.csv"$/);
    expectPrivate(r);
    expect(outcomes()).toEqual(["dashboard_csv:success"]);
    noLeak();
  });
  it("denied 403 and missing context 404 are rejected; a technical error on either call is failed", async () => {
    state.rpc.mockImplementation((fn: string) => fn === "workspace_context" ? ctx : { data: null, error: { message: "forbidden" } });
    expect((await dashboardGet()).status).toBe(403);
    state.rpc.mockImplementation((fn: string) => fn === "workspace_context" ? { data: null, error: null } : { data: {}, error: null });
    expect((await dashboardGet()).status).toBe(404);
    state.rpc.mockImplementation((fn: string) => fn === "workspace_context" ? { data: null, error: { message: "MARKER_ERR" } } : { data: {}, error: null });
    expect((await dashboardGet()).status).toBe(404);
    state.rpc.mockImplementation(() => { throw new Error("MARKER_ERR network"); });
    await expect(dashboardGet()).rejects.toThrow("MARKER_ERR network");
    expect(outcomes()).toEqual(["dashboard_csv:rejected", "dashboard_csv:rejected", "dashboard_csv:failed", "dashboard_csv:failed"]);
    noLeak();
  });
});

// ---------------------------------------------------------------------------
// Snapshot validation and the operations page section
// ---------------------------------------------------------------------------
const OBS = "2026-10-12T22:30:00.123456+00:00";
const FROM = "2026-10-11T23:00:00+00:00";
const zero = (op: OpCounts["op"]): OpCounts => ({ op, success: 0, replayed: 0, rejected: 0, failed: 0, capped_buckets: 0, latest_reported_at: null, failed_hours: [] });
const appSnap = (ops: Partial<Record<OpCounts["op"], Partial<OpCounts>>> = {}, over: Partial<AppSnapshot> = {}): AppSnapshot => ({
  observed_at: OBS, window_start: FROM, bucket_cap: 1000, stored_buckets: 12, reporting_actors_24h: 2,
  operations: OPS.map((op) => ({ ...zero(op), ...ops[op] })), ...over,
});
const busy = appSnap({
  assessment_save: { success: 40, replayed: 2, rejected: 3, failed: 2, latest_reported_at: "2026-10-12T22:29:00+00:00",
    failed_hours: ["2026-10-12T21:00:00+00:00", "2026-10-12T22:00:00+00:00"] },
  report_pdf: { success: 5, failed: 1, latest_reported_at: "2026-10-12T10:15:00+00:00", failed_hours: ["2026-10-12T10:00:00+00:00"] },
  report_csv: { success: 1, latest_reported_at: "2026-10-12T09:00:00+00:00" },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed-payload tests mutate arbitrary JSON
type Json = Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("application snapshot validation fails closed", () => {
  it("accepts the exact shape and evaluates sustained, single-hour, not-measured and zero-failure operations", () => {
    const ev = assessApp(clone(busy));
    expect(ev.status).toBe("sustained_failures");
    expect(ev.ops.map((o) => o.status)).toEqual(["sustained_failures", "failures_reported", "no_failures_reported", "not_measured", "not_measured", "not_measured"]);
    expect(assessApp(appSnap({}, { stored_buckets: 0, reporting_actors_24h: 0 })).status).toBe("not_measured");
    expect(sustained(["2026-10-12T19:00:00+00:00", "2026-10-12T21:00:00+00:00"])).toBe(false);
  });
  const bad: [string, (s: Json) => void][] = [
    ["extra key", (s) => { s.actor_ids = []; }],
    ["extra op key", (s) => { s.operations[0].error = "x"; }],
    ["unknown op", (s) => { s.operations[1].op = "billing_sync"; }],
    ["ops out of order", (s) => { [s.operations[0], s.operations[1]] = [s.operations[1], s.operations[0]]; }],
    ["missing op", (s) => { s.operations.pop(); }],
    ["negative count", (s) => { s.operations[0].success = -1; }],
    ["string count", (s) => { s.operations[0].failed = "2"; }],
    ["counts without latest", (s) => { s.operations[0].latest_reported_at = null; }],
    ["latest without counts", (s) => { s.operations[4].latest_reported_at = OBS; }],
    ["failed without hours", (s) => { s.operations[1].failed_hours = []; }],
    ["hour not whole", (s) => { s.operations[1].failed_hours = ["2026-10-12T10:30:00+00:00"]; }],
    ["hour outside window", (s) => { s.operations[1].failed_hours = ["2026-10-11T22:00:00+00:00"]; }],
    ["future hour", (s) => { s.operations[1].failed_hours = ["2026-10-12T23:00:00+00:00"]; }],
    ["unsorted hours", (s) => { s.operations[0].failed_hours.reverse(); }],
    ["future latest", (s) => { s.operations[0].latest_reported_at = "2026-10-12T22:31:00+00:00"; }],
    ["window not aligned to observation", (s) => { s.window_start = "2026-10-11T22:00:00+00:00"; }],
    ["non-UTC time", (s) => { s.observed_at = "2026-10-12T23:30:00+01:00"; }],
    ["impossible date", (s) => { s.operations[2].latest_reported_at = "2026-02-30T09:00:00+00:00"; }],
    ["wrong cap", (s) => { s.bucket_cap = 5; }],
    ["counts without actors", (s) => { s.reporting_actors_24h = 0; }],
    ["capped beyond total", (s) => { s.operations[2].capped_buckets = 1; }],
    ["not an object", (s) => { s.operations = {}; }],
  ];
  it.each(bad)("%s -> invalid, nothing shown", (_, mutate) => {
    const s = clone(busy) as unknown as Json;
    mutate(s);
    expect(validateAppSnapshot(s).ok).toBe(false);
    expect(assessApp(s)).toEqual({ status: "invalid", snapshot: null, ops: [] });
  });
  // One actor, every hour of the window, all four outcomes capped: 96 buckets of 1000 on one operation.
  const HOURS = Array.from({ length: 24 }, (_, i) => new Date(Date.parse("2026-10-11T23:00:00Z") + i * 3_600_000).toISOString().replace(".000Z", "+00:00"));
  const fullActor = (over: Partial<OpCounts> = {}, top: Partial<AppSnapshot> = {}) => appSnap({ report_pdf: {
    success: 24_000, replayed: 24_000, rejected: 24_000, failed: 24_000, capped_buckets: 96, latest_reported_at: OBS, failed_hours: HOURS, ...over,
  } }, { reporting_actors_24h: 1, stored_buckets: 96, ...top });
  it("accepts the legal multi-outcome upper bound (actors x 24 slots x 4 outcomes x 1000 per operation)", () => {
    const v = validateAppSnapshot(clone(fullActor()));
    expect(v.ok).toBe(true);
    expect(assessApp(clone(fullActor())).ops[1]).toMatchObject({ status: "sustained_failures", counts: { success: 24_000, failed: 24_000, capped_buckets: 96 } });
    // Two actors double every bound.
    expect(validateAppSnapshot(clone(fullActor({ success: 48_000, capped_buckets: 120 }, { reporting_actors_24h: 2, stored_buckets: 200 }))).ok).toBe(true);
  });
  it.each([
    ["one outcome above actors x 24 x cap", fullActor({ success: 24_001 })],
    ["failures above actors x failed hours x cap", fullActor({ failed: 2_001, failed_hours: HOURS.slice(0, 2) })],
    ["one failed hour but more than one bucket of failures for one actor", appSnap({ report_csv: { failed: 1_001, latest_reported_at: OBS, failed_hours: [HOURS[3]] } }, { reporting_actors_24h: 1 })],
    ["more capped buckets than 24 x 4 per actor", fullActor({ capped_buckets: 97 }, { stored_buckets: 200 })],
    ["more capped buckets than stored buckets", fullActor({}, { stored_buckets: 95 })],
  ])("rejects impossible totals: %s", (_, s) => {
    expect(validateAppSnapshot(clone(s)).ok).toBe(false);
  });
  it("null, arrays and primitives are invalid", () => { for (const v of [null, undefined, [], "x", 0]) expect(assessApp(v).status).toBe("invalid"); });
});

const billing = () => ({ observed_at: "2026-10-12T22:30:00+00:00", worker_connection_ids: [], connections: [], unassigned_reviews: { open: 0, oldest_created_at: null } });
const render = async (bill: { data: unknown; error: unknown }, app: { data: unknown; error: unknown }) => {
  state.rpc.mockImplementation((fn: string) => (fn === "platform_operations_snapshot" ? bill : app));
  return renderToStaticMarkup(await page.default());
};
const section = (html: string) => html.slice(html.indexOf('aria-labelledby="app-h"'), html.indexOf('aria-labelledby="guide-h"'));

describe("operations page: application outcomes section", () => {
  it("non-admins are stopped by the billing call before the application snapshot is read", async () => {
    await expect(render({ data: null, error: { message: "forbidden" } }, { data: busy, error: null })).rejects.toThrow("NOT_FOUND");
    expect(state.rpc.mock.calls.map((c) => c[0])).toEqual(["platform_operations_snapshot"]);
  });
  it("a denial on the second read (admin revoked in between) is not found; a lost session goes to login", async () => {
    await expect(render({ data: billing(), error: null }, { data: null, error: { message: "forbidden" } })).rejects.toThrow("NOT_FOUND");
    await expect(render({ data: billing(), error: null }, { data: null, error: { message: "not_authenticated" } })).rejects.toThrow("REDIRECT /login");
  });
  it("shows counts, provenance, the sustained rule and limits, with the capture time and no hash links", async () => {
    const html = await render({ data: billing(), error: null }, { data: busy, error: null });
    const s = section(html);
    expect(s).toContain("Reported failures in two consecutive hours");
    const esc = (t: string) => t.replace(/'/g, "&#x27;");
    expect(s).toContain(esc(APP_PROVENANCE));
    for (const l of APP_LIMITS) expect(s).toContain(esc(l));
    expect(s).toContain("Captured 2026-10-12 22:30:00 UTC by the database clock. Window: 2026-10-11 23:00 UTC to now.");
    expect(s).toMatch(/<th scope="row">Inspection assessment save <span class="small muted">\(assessment_save\)<\/span><\/th><td>Failures in two consecutive hours<\/td><td>40<\/td><td>2<\/td><td>3<\/td><td>2 \(hours: 21, 22\)<\/td>/);
    expect(s).toContain('Analytics PDF export <span class="small muted">(analytics_pdf)</span></th><td>Not measured (nothing reported)</td><td colSpan="5">not measured</td>');
    expect(s).toContain("does not mean saves and exports are healthy");
    expect(s).toContain("Proposed signal");
    expect(s).toMatch(/<div class="table-wrap" role="region" aria-label="Reported outcomes by operation, last 24 hours" tabindex="0">/);
    expect(s).toContain('<a class="btn" href="/platform/operations">Refresh</a>');
    expect(s).not.toMatch(/href="#|<form|<button|method="post"/);
    expect(html).toMatch(new RegExp('<h2 id="status-h"[^>]*>Not measured</h2>')); // billing section still rendered on its own
  });
  it("keeps provenance and the no-health notice visible; detailed limits, the rule and storage sit in a native details element", async () => {
    const s = section(await render({ data: billing(), error: null }, { data: busy, error: null }));
    const open = s.indexOf("<details>");
    const close = s.indexOf("</details>");
    expect(open).toBeGreaterThan(s.indexOf("</table>"));
    const inside = s.slice(open, close);
    const outside = s.slice(0, open) + s.slice(close);
    expect(inside).toMatch(/^<details><summary>What is and is not counted, the failure rule and storage limits<\/summary>/);
    for (const l of APP_LIMITS) expect(inside).toContain(l.replace(/'/g, "&#x27;"));
    expect(inside).toContain("Proposed signal");
    expect(inside).toContain("does not prove a continuous outage");
    expect(inside).toContain("Stored hourly buckets 12");
    expect(outside).toContain(APP_PROVENANCE.replace(/'/g, "&#x27;"));
    expect(outside).toContain("does not mean saves and exports are healthy");
    expect(outside).not.toMatch(/Proposed signal|Stored hourly buckets/);
    // The global stylesheet gives every summary a 44px target.
    expect(readFileSync(join(import.meta.dirname, "..", "..", "src", "app", "globals.css"), "utf8")).toMatch(/details > summary \{[^}]*min-height: 44px/);
  });
  it("app snapshot unavailable never looks like zero, while the billing section still renders", async () => {
    const html = await render({ data: billing(), error: null }, { data: null, error: { message: "MARKER_ERR timeout" } });
    const s = section(html);
    expect(s).toContain("Error: application outcome counts could not be read");
    expect(s).toContain("do not read this as zero");
    expect(s).toContain('<a class="btn" href="/platform/operations">Retry</a>');
    expect(s).not.toMatch(/<table|No failures reported<|MARKER/);
    expect(html).toContain("Captured 2026-10-12 22:30:00 UTC by the database clock. Refresh to read again.");
  });
  it("billing unavailable does not hide valid application counts (and vice versa the labels stay separate)", async () => {
    const html = await render({ data: null, error: { message: "MARKER_ERR" } }, { data: busy, error: null });
    expect(html).toContain("SNAPSHOT_UNAVAILABLE");
    expect(section(html)).toContain("<td>40</td>");
    expect(html).not.toContain("MARKER");
  });
  it("an invalid application snapshot shows the error state and none of its payload", async () => {
    const s = clone(busy) as unknown as Json;
    s.operations[0].note = "MARKER_PAYLOAD";
    const html = await render({ data: billing(), error: null }, { data: s, error: null });
    expect(section(html)).toContain("Error: application outcome counts unusable");
    expect(html).not.toContain("MARKER");
    expect(section(html)).not.toContain("<table");
  });
  it("with zero failures, the wording is not a health claim", async () => {
    const html = await render({ data: billing(), error: null }, { data: appSnap(Object.fromEntries(OPS.map((op) => [op, { success: 1, latest_reported_at: OBS }]))), error: null });
    const s = section(html);
    expect(s).toContain("No failures reported");
    expect(s).not.toMatch(/all systems|operational|working normally/i);
    expect(s).toContain("does not mean saves and exports are healthy");
  });
});
