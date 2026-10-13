// M5 internal operational alerts: fail-closed validation of the read RPC output and the server-rendered
// /platform/alerts page (denial, unavailable, invalid, provenance, never a health claim), plus the links to it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionAnchor } from "@/lib/operations";
import {
  ALERT_TEXT, automaticChecksConfirmed, CHECK_FAILING, DETAILS, PROVENANCE, validateAlerts, type AlertRow, type AlertsView, type Heartbeat,
} from "@/lib/operations-alerts";

const C1 = "eeeeeeee-5800-4000-8000-000000000001";
const OBS = "2026-10-13T12:00:00.123456+00:00";
const T = (min: number) => new Date(Date.parse("2026-10-13T12:00:00Z") - min * 60_000).toISOString().replace(".000Z", "+00:00");
const neverHb = (): Heartbeat => ({ last_attempt_at: null, last_attempt_trigger: null, billing_status: null, app_status: null, billing_ok_at: null,
  app_ok_at: null, last_cron_attempted_at: null, last_cron_status: null, last_cron_completed_at: null, last_manual_attempted_at: null,
  last_manual_status: null, cron_freshness: "never" });
const freshHb = (over: Partial<Heartbeat> = {}): Heartbeat => ({ last_attempt_at: T(2), last_attempt_trigger: "cron", billing_status: "ok", app_status: "ok",
  billing_ok_at: T(2), app_ok_at: T(2), last_cron_attempted_at: T(2), last_cron_status: "ok", last_cron_completed_at: T(2),
  last_manual_attempted_at: null, last_manual_status: null, cron_freshness: "fresh", ...over });
const billingRow = (over: Partial<AlertRow> = {}): AlertRow => ({ code: "WEBHOOK_BACKLOG_STALE", source: "billing_authoritative", connection_id: C1, op: null,
  severity: "high", active: true, episode_count: 2, first_seen_at: T(300), last_seen_at: T(2), last_changed_at: T(40), cleared_at: null,
  unobserved_since: null, observed_count: 4, observed_oldest_at: T(60), ...over });
const appRow = (over: Partial<AlertRow> = {}): AlertRow => ({ code: "APP_FAILURES_REPORTED", source: "app_unverified", connection_id: null, op: "report_pdf",
  severity: "high", active: true, episode_count: 1, first_seen_at: T(90), last_seen_at: T(2), last_changed_at: T(90), cleared_at: null,
  unobserved_since: null, observed_count: 3, observed_oldest_at: "2026-10-13T10:00:00+00:00", ...over });
const view = (alerts: AlertRow[] = [], over: Partial<AlertsView> = {}): AlertsView => ({
  observed_at: OBS, scheduler_job: "active", heartbeat: freshHb(), alert_limit: 100, alerts_total: alerts.length,
  alerts_active: alerts.filter((a) => a.active).length, alerts_truncated: false, alerts, ...over,
});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed-payload tests mutate arbitrary JSON
type Json = Record<string, any>;

describe("read validation fails closed", () => {
  it("accepts the never-run state, a fresh state with alerts, and a stale or unavailable scheduled check", () => {
    expect(validateAlerts(view([], { scheduler_job: "not_measured", heartbeat: neverHb() })).ok).toBe(true);
    expect(validateAlerts(clone(view([billingRow(), appRow(), appRow({ op: "report_csv", active: false, cleared_at: T(1), severity: "warning" })]))).ok).toBe(true);
    const stale = freshHb({ last_attempt_at: T(11), billing_ok_at: T(11), app_ok_at: T(11), last_cron_attempted_at: T(11), last_cron_completed_at: T(11), cron_freshness: "stale" });
    expect(validateAlerts(view([], { heartbeat: stale })).ok).toBe(true);
    const down = freshHb({ billing_status: "unavailable", billing_ok_at: T(30), last_cron_status: "billing_unavailable", last_cron_completed_at: T(30), cron_freshness: "unavailable" });
    expect(validateAlerts(view([], { heartbeat: down })).ok).toBe(true);
    const manualAfter = freshHb({ last_attempt_at: T(1), last_attempt_trigger: "manual", billing_ok_at: T(1), app_ok_at: T(1), last_manual_attempted_at: T(1),
      last_manual_status: "ok", last_cron_status: "billing_unavailable", last_cron_completed_at: T(30), cron_freshness: "unavailable" });
    expect(validateAlerts(view([], { heartbeat: manualAfter })).ok).toBe(true);
  });
  const bad: [string, (v: Json) => void][] = [
    ["extra top-level key", (v) => { v.debug = "x"; }],
    ["extra alert key (raw error)", (v) => { v.alerts[0].error = "boom"; }],
    ["extra heartbeat key", (v) => { v.heartbeat.sqlerrm = "x"; }],
    ["unknown code", (v) => { v.alerts[0].code = "RUN_STALE"; }],
    ["source disagrees with code", (v) => { v.alerts[0].source = "app_unverified"; }],
    ["billing alert without connection", (v) => { v.alerts[0].connection_id = null; }],
    ["app alert with unknown op", (v) => { v.alerts[1].op = "billing_sync"; }],
    ["active with cleared time", (v) => { v.alerts[0].cleared_at = T(1); }],
    ["app alert marked unobserved", (v) => { v.alerts[1].unobserved_since = T(1); }],
    ["zero episodes", (v) => { v.alerts[0].episode_count = 0; }],
    ["string count", (v) => { v.alerts[0].observed_count = "4"; }],
    ["future alert time", (v) => { v.alerts[0].last_seen_at = "2026-10-13T12:05:00+00:00"; }],
    ["impossible date", (v) => { v.alerts[0].first_seen_at = "2026-02-30T00:00:00+00:00"; }],
    ["non-UTC time", (v) => { v.observed_at = "2026-10-13T13:00:00+01:00"; }],
    ["unknown scheduler state", (v) => { v.scheduler_job = "running"; }],
    ["fresh while the latest scheduled run failed", (v) => { v.heartbeat.last_cron_status = "app_unavailable"; v.heartbeat.app_status = "unavailable"; v.heartbeat.app_ok_at = null; }],
    ["fresh but older than 10 minutes", (v) => { for (const k of ["last_attempt_at", "billing_ok_at", "app_ok_at", "last_cron_attempted_at", "last_cron_completed_at"]) v.heartbeat[k] = T(12); }],
    ["never but a scheduled attempt exists", (v) => { v.heartbeat.cron_freshness = "never"; }],
    ["ok source not read at the latest attempt", (v) => { v.heartbeat.billing_ok_at = T(5); }],
    ["latest attempt trigger disagrees", (v) => { v.heartbeat.last_attempt_trigger = "manual"; }],
    ["totals below the listed rows", (v) => { v.alerts_total = 1; }],
    ["hidden rows without truncation flag", (v) => { v.alerts_total = 150; }],
    ["truncation flag without hidden rows", (v) => { v.alerts_truncated = true; }],
    ["active count disagrees", (v) => { v.alerts_active = 5; }],
    ["inactive listed before active", (v) => { v.alerts[0].active = false; v.alerts[0].cleared_at = T(1); v.alerts_active = 1; }],
    ["duplicate slot", (v) => { v.alerts[1] = clone(v.alerts[0]); }],
    ["wrong limit", (v) => { v.alert_limit = 500; }],
    ["not an object", (v) => { v.alerts = {}; }],
  ];
  it.each(bad)("%s -> invalid", (_, mutate) => {
    const v = clone(view([billingRow(), appRow()])) as unknown as Json;
    mutate(v);
    expect(validateAlerts(v).ok).toBe(false);
  });
  it("null, arrays and primitives are invalid", () => { for (const v of [null, undefined, [], "x", 0]) expect(validateAlerts(v).ok).toBe(false); });
  it("automatic checks are confirmed only for an active job with a fresh scheduled run", () => {
    expect(automaticChecksConfirmed(view())).toBe(true);
    for (const job of ["inactive", "absent", "not_measured"] as const) expect(automaticChecksConfirmed(view([], { scheduler_job: job }))).toBe(false);
    expect(automaticChecksConfirmed(view([], { heartbeat: neverHb() }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); }, redirect: (u: string) => { throw new Error(`REDIRECT ${u}`); },
}));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ supabase: { rpc: state.rpc } }) }));
const page = await import("@/app/platform/alerts/page");
const opsPage = await import("@/app/platform/operations/page");
const src = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "..", "src", ...p), "utf8");
const render = async (result: { data: unknown; error: unknown }) => {
  state.rpc.mockResolvedValue(result);
  return renderToStaticMarkup(await page.default());
};
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const always = (html: string) => {
  expect(html).toContain("<h1>Operational alerts</h1>");
  for (const p of PROVENANCE) expect(html).toContain(esc(p));
  // The owner chose email plus this page; automatic email is development only and switchable, and nothing claims
  // delivery. The manual verification test is separate.
  expect(html).toContain("Automatic email is development only");
  expect(html).toContain("Accepted by the email service is not confirmed delivery and no email is promised");
  expect(html).toContain("a manual test email to the owner address");
  expect(html).toContain("Support hours: awaiting the owner&#x27;s choice");
  expect(html).toContain("<details><summary>How these checks work and what they cannot tell you</summary>");
  for (const d of DETAILS) expect(html).toContain(esc(d));
  // Only internal platform paths in the page body (the shared topbar is unchanged); no developer, SQL or scheduler detail.
  const main = html.slice(html.indexOf("<main"));
  for (const m of main.matchAll(/href="([^"]+)"/g)) expect(m[1]).toMatch(/^\/platform(\/(alerts|operations))?(#[a-z0-9-]+)?$/);
  expect(main).not.toMatch(/docs\/|milestone-5|\.md\b|\bselect |billing\.|platform\.|private\.|operations\.|cron|pg_|sqlerrm/i);
  expect(main).not.toMatch(/<form|<button|method="post"/);
  expect(main).not.toMatch(/healthy|all systems|all clear|resolved/i);
};

describe("alerts page", () => {
  beforeEach(() => state.rpc.mockReset());
  it("is dynamic, uncached and read-only: no client component, polling or write path", () => {
    expect(page.dynamic).toBe("force-dynamic");
    expect(page.fetchCache).toBe("force-no-store");
    expect(src("app", "platform", "alerts", "page.tsx")).not.toMatch(/"use client"|"use server"|setInterval|setTimeout|useEffect|<form|method="post"|router\.refresh/);
  });
  it("calls only the two read RPCs, with no arguments (a page load never reserves or sends)", async () => {
    await render({ data: view(), error: null });
    expect(state.rpc.mock.calls).toEqual([["platform_operations_alerts"], ["platform_alert_email_verifications"], ["platform_operations_mailer"]]);
  });
  it("non-admin: not found; missing session: login", async () => {
    await expect(render({ data: null, error: { message: "forbidden" } })).rejects.toThrow("NOT_FOUND");
    await expect(render({ data: null, error: { message: "not_authenticated" } })).rejects.toThrow("REDIRECT /login?next=%2Fplatform%2Falerts");
  });
  it("any other error: unavailable, retry, no message and never an empty or quiet state", async () => {
    const html = await render({ data: null, error: { message: "canceling statement MARKER_DB", details: "MARKER_DETAIL" } });
    always(html);
    expect(html).toContain("Alerts could not be read");
    expect(html).toContain('<a class="btn" href="/platform/alerts">Retry</a>');
    expect(html).not.toMatch(/MARKER|No warning is active|Active warnings|Scheduled check:/);
  });
  it("invalid data: error state, none of the payload", async () => {
    const v = clone(view([billingRow()])) as unknown as Json;
    v.alerts[0].note = "MARKER_NOTE";
    const html = await render({ data: v, error: null });
    always(html);
    expect(html).toContain("Alert data unusable");
    expect(html).not.toMatch(/MARKER|eeeeeeee-5800|Active warnings/);
  });
  it("never run: says so, does not confirm automatic checks, and the empty list is not a health claim", async () => {
    const html = await render({ data: view([], { scheduler_job: "not_measured", heartbeat: neverHb() }), error: null });
    always(html);
    expect(html).toContain("Scheduled check: has never run");
    expect(html).toContain("Automatic checks are not confirmed right now");
    expect(html).toContain("Schedule entry: not measured");
    expect(html).toContain("never checked.");
    expect(html).toContain("This is not a health statement");
  });
  it("automatic-check notice only when the job is active and the latest scheduled run is fresh", async () => {
    expect(await render({ data: view(), error: null })).toContain("Automatic checks: the schedule entry is active");
    expect(await render({ data: view([], { scheduler_job: "not_measured" }), error: null })).not.toContain("Automatic checks: the schedule entry is active");
  });
  it("a failing source says its warnings were left unchanged, while the other source still shows", async () => {
    const hb = freshHb({ billing_status: "unavailable", billing_ok_at: T(30), last_cron_status: "billing_unavailable", last_cron_completed_at: T(30), cron_freshness: "unavailable" });
    const html = await render({ data: view([billingRow(), appRow()], { heartbeat: hb }), error: null });
    always(html);
    expect(html).toContain("Scheduled check: latest run could not read a source");
    expect(html).toContain(CHECK_FAILING);
    expect(html.match(new RegExp(CHECK_FAILING.slice(0, 40), "g"))).toHaveLength(1);
    expect(html).toContain("Saves and exports (unverified user reports):</strong> read in the latest check.");
    expect(html).toContain("Latest scheduled run that read both sources: 2026-10-13 11:30:00 UTC");
  });
  it("active and no-longer-observed warnings are separate; app expiry is not recovery; unobserved connections are kept", async () => {
    const html = await render({ data: view([
      billingRow({ unobserved_since: T(5) }), appRow(),
      billingRow({ code: "DISCOVERY_BACKLOG_STALE", active: false, cleared_at: T(1) }),
      appRow({ op: "report_csv", severity: "warning", active: false, cleared_at: T(1) }),
    ]), error: null });
    always(html);
    const activeSec = html.slice(html.indexOf('id="active-h"'), html.indexOf('id="past-h"'));
    const pastSec = html.slice(html.indexOf('id="past-h"'), html.indexOf('id="guide-h"'));
    expect(activeSec).toContain("Active warnings (2)");
    expect(activeSec).toContain(ALERT_TEXT.WEBHOOK_BACKLOG_STALE.title);
    expect(activeSec).toContain("Session report PDF export");
    expect(activeSec).toContain("two adjacent UTC hours");
    expect(activeSec).toContain("has not been listed in billing checks since 2026-10-13 11:55:00 UTC. The warning is kept as it was, not cleared.");
    expect(activeSec).toContain(C1);
    expect(pastSec).toContain("No longer observed: a billing check at 2026-10-13 11:59:00 UTC found this condition absent.");
    expect(pastSec).toContain("No longer reported: a check at 2026-10-13 11:59:00 UTC found no failures reported in the current window. This is not confirmed recovery.");
    expect(html).toContain('href="/platform/operations#guide-rb-bill-01"');
    expect(html).toContain('href="/platform/operations#app-guide-h"');
    expect(html).toContain('<a class="btn" href="/platform/alerts">Refresh</a>');
  });
  it("the guide links resolve to headings on the Operations monitor", () => {
    expect(actionAnchor("RB-BILL-01")).toBe("guide-rb-bill-01");
    expect(src("app", "platform", "operations", "application-outcomes.tsx")).toContain('id="app-guide-h"');
  });
  it("a truncated list says how many are shown out of the full totals", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => billingRow({ connection_id: `eeeeeeee-5800-4000-8000-${String(i).padStart(12, "0")}` }));
    const html = await render({ data: view(rows, { alerts_total: 140, alerts_active: 120, alerts_truncated: true }), error: null });
    expect(html).toContain("Showing 100 of 140 stored warnings (120 active)");
  });
  it("cards wrap on narrow screens; the summary uses the global 44px rule", async () => {
    const html = await render({ data: view([billingRow()]), error: null });
    expect(html).toMatch(/<li class="card stack"><h3 class="row">/);
    expect(html).toContain('style="overflow-wrap:anywhere"');
    expect(src("app", "globals.css")).toMatch(/details > summary \{[^}]*min-height: 44px/);
  });
});

describe("links to the alerts page", () => {
  it("the Operations monitor links to it", async () => {
    state.rpc.mockImplementation((fn: string) => fn === "platform_operations_snapshot"
      ? { data: { observed_at: OBS, worker_connection_ids: [], connections: [], unassigned_reviews: { open: 0, oldest_created_at: null } }, error: null }
      : { data: null, error: { message: "x" } });
    expect(renderToStaticMarkup(await opsPage.default())).toContain('<a class="btn" href="/platform/alerts">Operational alerts</a>');
  });
  it("platform admin links to both, with the monitor labelled for what it now covers", () => {
    const s = src("app", "platform", "page.tsx");
    expect(s).toContain('<Link className="btn" href="/platform/operations">Operations monitor (read-only)</Link>');
    expect(s).toContain('<Link className="btn" href="/platform/alerts">Operational alerts</Link>');
    expect(s).not.toContain("Billing operations monitor");
  });
});
