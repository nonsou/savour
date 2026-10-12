// M5 OPS01: snapshot validation (fail closed), evaluator thresholds measured only against observed_at,
// status precedence, runbook mapping, and the server-rendered page (denial, unavailable, disclosures).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIONS, actionAnchor, assess, CODES, evaluate, type ActionId, NOT_INSTRUMENTED, OWNERSHIP, THRESHOLDS_MS, validateSnapshot, type Code, type ConnectionFacts, type RunFacts, type Snapshot,
} from "@/lib/operations";

const C1 = "eeeeeeee-5200-4000-8000-000000000001";
const C2 = "eeeeeeee-5200-4000-8000-000000000002";
const OBS = Date.parse("2026-10-12T22:00:00.000Z");
const iso = (msAgo: number) => new Date(OBS - msAgo).toISOString().replace("Z", "+00:00");
const fresh = (): RunFacts => ({ latest_finished_at: iso(60_000), latest_outcome: "success", latest_success_at: iso(60_000),
  unfinished: 0, oldest_unfinished_started_at: null, failed_24h: 0, partial_24h: 0 });
const connection = (over: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
  id: C1, provider_code: "bachs", status: "enabled", worker_required: true,
  webhook: { pending: 0, processing: 0, failed: 0, expired_leases: 0, oldest_received_at: null }, webhook_dead: 0, webhook_quarantined: 0,
  discovery: { pending: 0, processing: 0, retry: 0, expired_leases: 0, oldest_first_seen_at: null }, discovery_dead: 0,
  reviews: { open: 0, oldest_created_at: null }, collisions_24h: 0,
  runs: { process: fresh(), discover: fresh(), reconcile: fresh() }, ...over,
});
const snapshot = (connections: ConnectionFacts[] = [connection()], over: Partial<Snapshot> = {}): Snapshot => ({
  observed_at: iso(0), worker_connection_ids: connections.filter((c) => c.worker_required).map((c) => c.id), connections,
  unassigned_reviews: { open: 0, oldest_created_at: null }, ...over,
});
const codes = (s: Snapshot) => evaluate(s).findings.map((f) => f.code);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed-payload tests mutate arbitrary JSON
type Json = Record<string, any>;

describe("validation fails closed", () => {
  it("accepts the exact shape", () => expect(validateSnapshot(clone(snapshot())).ok).toBe(true));
  const bad: [string, (s: Json) => void][] = [
    ["extra top-level key", (s) => { s.debug = 1; }],
    ["extra connection key (label)", (s) => { s.connections[0].label = "Main"; }],
    ["missing key", (s) => { delete s.connections[0].reviews; }],
    ["unknown provider", (s) => { s.connections[0].provider_code = "paypal"; }],
    ["unknown status", (s) => { s.connections[0].status = "paused"; }],
    ["unknown outcome", (s) => { s.connections[0].runs.process.latest_outcome = "ok"; }],
    ["free-text error in a run", (s) => { s.connections[0].runs.process.error_code = "boom"; }],
    ["negative count", (s) => { s.connections[0].webhook.pending = -1; }],
    ["fractional count", (s) => { s.connections[0].webhook_dead = 1.5; }],
    ["string count", (s) => { s.connections[0].collisions_24h = "1"; }],
    ["non-UTC timestamp", (s) => { s.observed_at = "2026-10-12T23:00:00+01:00"; }],
    ["malformed timestamp", (s) => { s.observed_at = "yesterday"; }],
    ["infinity timestamp", (s) => { s.observed_at = "infinity"; }],
    ["bad uuid", (s) => { s.connections[0].id = "not-a-uuid"; }],
    ["count without oldest", (s) => { s.connections[0].webhook.pending = 1; }],
    ["oldest without count", (s) => { s.unassigned_reviews.oldest_created_at = s.observed_at; }],
    ["expired leases above processing", (s) => { s.connections[0].discovery.expired_leases = 1; }],
    ["none outcome with a finish time", (s) => { s.connections[0].runs.reconcile.latest_outcome = "none"; }],
    ["success outcome with a different success time", (s) => { s.connections[0].runs.process.latest_success_at = iso(120_000); }],
    ["unfinished count without start", (s) => { s.connections[0].runs.process.unfinished = 1; }],
    ["required flag disagrees with selector list", (s) => { s.connections[0].worker_required = false; }],
    ["selector lists an absent connection", (s) => { s.worker_connection_ids.push(C2); }],
    ["missing mode", (s) => { delete s.connections[0].runs.reconcile; }],
    ["not an object", (s) => { s.connections = {}; }],
  ];
  it.each(bad)("%s -> error state", (_, mutate) => {
    const s = clone(snapshot()) as unknown as Json;
    mutate(s);
    expect(validateSnapshot(s).ok).toBe(false);
    const ev = assess(s);
    expect(ev).toMatchObject({ status: "error", snapshot: null });
    expect(ev.findings.map((f) => f.code)).toEqual(["SNAPSHOT_INVALID"]);
  });
  const withObserved = (t: string) => ({ observed_at: t, worker_connection_ids: [], connections: [], unassigned_reviews: { open: 0, oldest_created_at: null } });
  it.each([
    "2026-02-30T12:00:00+00:00", // Sol's reproduction: Date.parse rolls it to 2 March
    "2025-02-29T00:00:00+00:00", "1900-02-29T00:00:00+00:00", "2026-04-31T00:00:00+00:00", "2026-13-01T00:00:00+00:00",
    "2026-00-10T00:00:00+00:00", "2026-01-00T00:00:00+00:00", "2026-10-12T24:00:00+00:00", "2026-10-12T23:60:00+00:00",
    "2026-10-12T23:59:60+00:00", "2026-10-12T22:00:00.1234567+00:00", "2026-10-12T22:00:00.+00:00", "2026-10-12T22:00:00Z",
    "2026-10-12 22:00:00+00:00", "2026-10-12T22:00:00+00", "+02026-10-12T22:00:00+00:00",
  ])("rejects impossible or non-PostgreSQL-UTC observed_at %s", (t) => {
    expect(validateSnapshot(withObserved(t)).ok).toBe(false);
    expect(assess(withObserved(t))).toMatchObject({ status: "error", snapshot: null, findings: [{ code: "SNAPSHOT_INVALID" }] });
  });
  it.each(["2024-02-29T23:59:59+00:00", "2000-02-29T00:00:00+00:00", "2026-10-12T22:00:00.1+00:00", "2026-10-12T22:00:00.123456+00:00",
    "2026-12-31T23:59:59.999999+00:00", "2026-01-31T00:00:00+00:00"])("accepts genuine PostgreSQL UTC output %s", (t) => {
    expect(validateSnapshot(withObserved(t)).ok).toBe(true);
  });
  it("rejects an impossible nested timestamp (webhook oldest, run finish) too", () => {
    const a = clone(snapshot([connection({ webhook: { pending: 1, processing: 0, failed: 0, expired_leases: 0, oldest_received_at: iso(1000) } })])) as unknown as Json;
    a.connections[0].webhook.oldest_received_at = "2026-02-30T12:00:00+00:00";
    expect(assess(a).status).toBe("error");
    const b = clone(snapshot()) as unknown as Json;
    b.connections[0].runs.process.latest_finished_at = "2026-09-31T12:00:00.5+00:00";
    b.connections[0].runs.process.latest_success_at = "2026-09-31T12:00:00.5+00:00";
    expect(assess(b).status).toBe("error");
  });
  it("microsecond strings keep millisecond threshold precision", () => {
    const s = (frac: string) => snapshot([connection({ webhook: { pending: 1, processing: 0, failed: 0, expired_leases: 0,
      oldest_received_at: `2026-10-12T21:45:00${frac}+00:00` } })], { observed_at: "2026-10-12T22:00:00.000999+00:00" });
    expect(validateSnapshot(s(".000000")).ok).toBe(true);
    expect(codes(s(".000000"))).toEqual([]); // exactly 15 min at millisecond precision
    expect(codes(s(""))).toEqual([]);
    const older = snapshot([connection({ webhook: { pending: 1, processing: 0, failed: 0, expired_leases: 0,
      oldest_received_at: "2026-10-12T21:44:59.999000+00:00" } })], { observed_at: "2026-10-12T22:00:00.000000+00:00" });
    expect(codes(older)).toEqual(["WEBHOOK_BACKLOG_STALE"]);
  });
  it("null and arrays are errors", () => {
    for (const v of [null, undefined, [], "x", 1]) expect(assess(v).status).toBe("error");
  });
});

describe("thresholds are strict and measured against observed_at", () => {
  const backlogAt = (ms: number) => snapshot([connection({ webhook: { pending: 1, processing: 0, failed: 0, expired_leases: 0, oldest_received_at: iso(ms) } })]);
  const discoveryAt = (ms: number) => snapshot([connection({ discovery: { pending: 0, processing: 0, retry: 1, expired_leases: 0, oldest_first_seen_at: iso(ms) } })]);
  it("webhook and discovery backlog: exactly 15 minutes is not stale, 1 ms more is", () => {
    expect(codes(backlogAt(THRESHOLDS_MS.backlog))).not.toContain("WEBHOOK_BACKLOG_STALE");
    expect(codes(backlogAt(THRESHOLDS_MS.backlog + 1))).toContain("WEBHOOK_BACKLOG_STALE");
    expect(codes(discoveryAt(THRESHOLDS_MS.backlog))).not.toContain("DISCOVERY_BACKLOG_STALE");
    expect(codes(discoveryAt(THRESHOLDS_MS.backlog + 1))).toContain("DISCOVERY_BACKLOG_STALE");
  });
  it.each([["process", 5 * 60_000], ["discover", 2 * 3_600_000], ["reconcile", 26 * 3_600_000]] as const)("%s run freshness boundary %i ms", (mode, limit) => {
    const at = (ms: number) => snapshot([connection({ runs: { ...connection().runs, [mode]: { ...fresh(), latest_finished_at: iso(ms), latest_success_at: iso(ms) } } })]);
    expect(evaluate(at(limit)).status).toBe("within_thresholds");
    const ev = evaluate(at(limit + 1));
    expect(ev.status).toBe("attention");
    expect(ev.findings).toEqual([{ code: "RUN_STALE", status: "attention", connection_id: C1, mode }]);
  });
  it("unfinished run: exactly 5 minutes is not stuck, 1 ms more is", () => {
    const at = (ms: number) => snapshot([connection({ runs: { ...connection().runs, process: { ...fresh(), unfinished: 1, oldest_unfinished_started_at: iso(ms) } } })]);
    expect(codes(at(THRESHOLDS_MS.unfinishedRun))).toEqual([]);
    expect(codes(at(THRESHOLDS_MS.unfinishedRun + 1))).toEqual(["RUN_STUCK"]);
  });
  it("a future timestamp is an error, never clamped to healthy", () => {
    const ev = evaluate(backlogAt(-1));
    expect(ev.status).toBe("error");
    expect(ev.findings[0].code).toBe("FUTURE_TIMESTAMP");
    const run = snapshot([connection({ runs: { ...connection().runs, reconcile: { ...fresh(), latest_finished_at: iso(-1000), latest_success_at: iso(-1000) } } })]);
    expect(evaluate(run).status).toBe("error");
    const notRequired = snapshot([connection({ worker_required: false, runs: { ...connection().runs, process: { ...fresh(), latest_finished_at: iso(-5), latest_success_at: iso(-5) } } })]);
    expect(evaluate(notRequired).status).toBe("error");
  });
  it("expired leases count on their own; a future retry time is still backlog by its received age", () => {
    const s = snapshot([connection({ webhook: { pending: 0, processing: 1, failed: 0, expired_leases: 1, oldest_received_at: iso(1000) },
      discovery: { pending: 0, processing: 1, retry: 0, expired_leases: 1, oldest_first_seen_at: iso(1000) } })]);
    expect(codes(s).sort()).toEqual(["DISCOVERY_LEASE_EXPIRED", "WEBHOOK_LEASE_EXPIRED"]);
  });
});

describe("run outcomes and measurement", () => {
  it("latest failure after an earlier success is attention (the earlier success never hides it)", () => {
    const s = snapshot([connection({ runs: { ...connection().runs, process: { ...fresh(), latest_finished_at: iso(30_000), latest_outcome: "failure",
      latest_success_at: iso(200_000), failed_24h: 1 } } })]);
    expect(evaluate(s).findings.map((f) => [f.code, f.mode])).toEqual([["RUN_LATEST_FAILED", "process"]]);
  });
  it("an unfinished run after a failed run still reports the failure; partial has its own code", () => {
    const s = snapshot([connection({ runs: { ...connection().runs,
      process: { ...fresh(), latest_finished_at: iso(30_000), latest_outcome: "failure", latest_success_at: null, unfinished: 1, oldest_unfinished_started_at: iso(10_000) },
      discover: { ...fresh(), latest_outcome: "partial", latest_success_at: iso(3_600_000) } } })]);
    expect(codes(s).sort()).toEqual(["RUN_LATEST_FAILED", "RUN_LATEST_PARTIAL"]);
  });
  it("a required connection with no finished run is not measured, never healthy", () => {
    const none: RunFacts = { latest_finished_at: null, latest_outcome: "none", latest_success_at: null, unfinished: 0, oldest_unfinished_started_at: null, failed_24h: 0, partial_24h: 0 };
    const ev = evaluate(snapshot([connection({ runs: { process: none, discover: fresh(), reconcile: fresh() } })]));
    expect(ev.status).toBe("not_measured");
    expect(ev.findings.map((f) => f.code)).toEqual(["RUN_NEVER_FINISHED"]);
  });
  it("zero required connections is not measured", () => {
    expect(evaluate(snapshot([])).findings.map((f) => f.code)).toEqual(["NO_WORKER_CONNECTIONS"]);
    expect(evaluate(snapshot([])).status).toBe("not_measured");
  });
  it("runs on a connection the worker does not serve never make it look healthy; its queue issues still need attention", () => {
    const off = connection({ id: C2, status: "disabled", worker_required: false });
    expect(evaluate(snapshot([connection(), off])).status).toBe("not_measured");
    const withReview = connection({ id: C2, status: "draft", worker_required: false, reviews: { open: 1, oldest_created_at: iso(1000) } });
    const ev = evaluate(snapshot([connection(), withReview]));
    expect(ev.status).toBe("attention");
    expect(ev.findings.map((f) => f.code)).toEqual(["REVIEWS_OPEN", "WORKER_NOT_REQUIRED"]);
  });
  it("counts unassigned reviews globally; zero open items raise nothing", () => {
    expect(codes(snapshot(undefined, { unassigned_reviews: { open: 2, oldest_created_at: iso(5000) } }))).toEqual(["REVIEWS_UNASSIGNED_OPEN"]);
    expect(evaluate(snapshot()).status).toBe("within_thresholds");
  });
});

describe("status precedence and runbook mapping", () => {
  it("error > attention > not measured > within thresholds", () => {
    const off = connection({ id: C2, worker_required: false, webhook_dead: 1, discovery: { pending: 1, processing: 0, retry: 0, expired_leases: 0, oldest_first_seen_at: iso(-1) } });
    const ev = evaluate(snapshot([connection(), off]));
    expect(ev.status).toBe("error");
    expect(ev.findings.map((f) => f.status)).toEqual(["error", "attention", "not_measured"]);
  });
  it("every code maps to a named runbook action that exists in the runbook", () => {
    const doc = readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "milestone-5", "operations-runbooks.md"), "utf8");
    for (const [code, c] of Object.entries(CODES) as [Code, (typeof CODES)[Code]][]) {
      expect(c.action, code).toMatch(/^RB-[A-Z]+-\d{2}$/);
      expect(doc, `${code} -> ${c.action}`).toContain(`### ${c.action}`);
      expect(doc, code).toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// Server-rendered page
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); }, redirect: (u: string) => { throw new Error(`REDIRECT ${u}`); },
}));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ supabase: { rpc: state.rpc } }) }));
const page = await import("@/app/platform/operations/page");
const render = async (result: { data: unknown; error: unknown }) => {
  state.rpc.mockResolvedValue(result);
  return renderToStaticMarkup(await page.default());
};
const always = (html: string) => {
  expect(html).toContain("Detection happens only when an operator opens or refreshes this page");
  expect(html).toContain("does not mean the platform is healthy");
  for (const x of NOT_INSTRUMENTED) expect(html).toContain(x.replace(/&/g, "&amp;"));
  for (const o of OWNERSHIP) expect(html).toContain(`${o.role}: UNASSIGNED`);
  expect(html).toContain('href="/platform/operations"');
  // The full guide renders every time, one heading per action ID, plus incident communication.
  for (const id of Object.keys(ACTIONS) as ActionId[]) expect(html).toContain(`<h3 id="${actionAnchor(id)}">${ACTIONS[id].title}</h3>`);
  expect(html).toContain('<h3 id="guide-incident">');
  expect(html).toContain("sent only after the owner approves it");
  // No repository paths, SQL, schema names or credential/provider commands in the product UI.
  expect(html).not.toMatch(/docs\/|milestone-5|\.md\b|\bselect |billing\.|platform\.|private\.|operator_|sk_sandbox|whsec|curl|Bearer/i);
};
const anchorsResolve = (html: string) => {
  const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  for (const h of hrefs) expect(html, h).toContain(`id="${h}"`);
  return hrefs;
};

describe("operations page", () => {
  beforeEach(() => state.rpc.mockReset());
  it("is dynamic and has no polling, client component or write path", () => {
    expect(page.dynamic).toBe("force-dynamic");
    const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "app", "platform", "operations", "page.tsx"), "utf8");
    expect(src).not.toMatch(/"use client"|"use server"|setInterval|setTimeout|useEffect|<form|method="post"|router\.refresh/);
  });
  it("calls only the read RPC with no arguments", async () => {
    await render({ data: snapshot(), error: null });
    expect(state.rpc.mock.calls).toEqual([["platform_operations_snapshot"]]);
  });
  it("denied non-admin: not found; missing session: login", async () => {
    await expect(render({ data: null, error: { message: "forbidden" } })).rejects.toThrow("NOT_FOUND");
    await expect(render({ data: null, error: { message: "not_authenticated" } })).rejects.toThrow("REDIRECT /login?next=%2Fplatform%2Foperations");
  });
  it("any other error shows unavailable with a retry link, no message, no fabricated empty or healthy state", async () => {
    const html = await render({ data: null, error: { message: "canceling statement due to statement timeout MARKER_DB", details: "MARKER_DETAIL" } });
    always(html);
    expect(html).toContain("Error: snapshot unusable");
    expect(html).toContain("SNAPSHOT_UNAVAILABLE");
    expect(anchorsResolve(html)).toEqual(["guide-rb-ops-01"]);
    expect(html).toContain(`What to do: ${ACTIONS["RB-OPS-01"].title}`);
    expect(html).toContain('<a class="btn" href="/platform/operations">Retry</a>');
    expect(html).not.toMatch(/MARKER|statement timeout|within thresholds|Unresolved 0/);
  });
  it("invalid data shows the error state and none of the payload", async () => {
    const s = clone(snapshot()) as unknown as Json;
    s.connections[0].label = "MARKER_LABEL";
    const html = await render({ data: s, error: null });
    always(html);
    expect(html).toContain("SNAPSHOT_INVALID");
    expect(html).not.toContain("MARKER");
    expect(html).not.toContain(C1);
  });
  it("a valid snapshot shows the database capture time, metrics, findings with actions and the disclosures", async () => {
    const s = snapshot([connection({ webhook: { pending: 3, processing: 0, failed: 0, expired_leases: 0, oldest_received_at: iso(THRESHOLDS_MS.backlog + 1) } })]);
    const html = await render({ data: s, error: null });
    always(html);
    expect(html).toContain("Captured 2026-10-12 22:00:00 UTC by the database clock");
    expect(html).toContain("Attention needed");
    expect(html).toContain("WEBHOOK_BACKLOG_STALE");
    expect(html).toMatch(/<a[^>]*href="#guide-rb-bill-01"[^>]*>What to do: Billing events are waiting too long<\/a>/);
    expect(html).toContain("pending 3");
    expect(html).toContain(C1);
    expect(html).toContain('<a class="btn" href="/platform/operations">Refresh</a>');
  });
  it("every finding links to a guide heading that exists on the page, for every action ID", async () => {
    // One finding per code family, so every distinct action ID is linked at least once.
    const none: RunFacts = { latest_finished_at: null, latest_outcome: "none", latest_success_at: null, unfinished: 0, oldest_unfinished_started_at: null, failed_24h: 0, partial_24h: 0 };
    const busy = connection({
      webhook: { pending: 0, processing: 1, failed: 0, expired_leases: 1, oldest_received_at: iso(THRESHOLDS_MS.backlog + 1) },
      webhook_dead: 1, collisions_24h: 1, reviews: { open: 1, oldest_created_at: iso(1000) },
      runs: { process: { ...fresh(), latest_outcome: "failure", latest_success_at: null }, discover: none,
        reconcile: { ...fresh(), latest_finished_at: iso(THRESHOLDS_MS.run.reconcile + 1), latest_success_at: iso(THRESHOLDS_MS.run.reconcile + 1) } },
    });
    const off = connection({ id: C2, worker_required: false, reviews: { open: 0, oldest_created_at: null } });
    const future = snapshot([busy, off], { unassigned_reviews: { open: 1, oldest_created_at: iso(-1) } });
    const linked = new Set([
      ...anchorsResolve(await render({ data: future, error: null })),
      ...anchorsResolve(await render({ data: null, error: { message: "x" } })),
    ]);
    expect([...linked].sort()).toEqual((Object.keys(ACTIONS) as ActionId[]).map(actionAnchor).sort());
    expect(new Set(Object.values(CODES).map((c) => c.action))).toEqual(new Set(Object.keys(ACTIONS)));
  });
  it("guide steps name pending assignments and human-approved outbound messages", () => {
    const all = Object.values(ACTIONS).flatMap((a) => a.steps).join("\n");
    expect(all).toMatch(/escalation contact\. Not yet assigned/);
    expect(all).toMatch(/trusted database operator \(not yet assigned\)/);
    for (const a of Object.values(ACTIONS)) expect(a.steps.length).toBeGreaterThanOrEqual(2);
  });
  it("the six-column run table scrolls in a labelled region with a caption", async () => {
    const html = await render({ data: snapshot(), error: null });
    expect(html).toMatch(/<div class="table-wrap" role="region" aria-label="Scheduled runs for bachs connection eeeeeeee" tabindex="0"><table class="small"><caption>Scheduled runs for bachs connection eeeeeeee<\/caption>/);
    expect(html.match(/<th scope="col">/g)).toHaveLength(6);
    expect(html.match(/<table/g)).toHaveLength(html.match(/class="table-wrap"/g)!.length);
  });
  it("within thresholds is worded as billing-only", async () => {
    const html = await render({ data: snapshot(), error: null });
    const status = html.slice(html.indexOf('role="status"'), html.indexOf("</section>", html.indexOf('role="status"')));
    expect(status).toContain('<h2 id="status-h">Billing checks within thresholds</h2>');
    expect(status).not.toMatch(/healthy|incident|all systems/i);
    expect(html).toContain("does not mean the platform is healthy or that there are no incidents");
  });
});
