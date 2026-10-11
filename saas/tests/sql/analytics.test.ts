// End to end: real approvals on embedded Postgres -> public.get_analytics -> buildAnalytics -> CSV/PDF,
// exactly as the analytics page and export route do. Six comparable food sessions for one subject
// fall exactly 10 points; all three starter packs and a SAMPLE session are present. Sequential (PGlite).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildAnalytics, type AnalyticsDataset } from "@/lib/analytics";
import { analyticsSections, buildAnalyticsCsv } from "@/lib/analytics-export";
import { buildPdf, buildAnalyticsPdf } from "@/lib/pdf";
import { buildCsv, type ReportEnvelope } from "@/lib/report";

const root = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const OWNER = "eeeeeeee-0000-4000-8000-000000000801";

async function setup() {
  const d = new PGlite();
  await d.exec(read("tests", "sql", "supabase-stub.sql"));
  for (const f of readdirSync(join(root, "supabase", "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    await d.exec(read("supabase", "migrations", f));
  }
  await d.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'analytics-fixture@savour.test', now());
    select set_config('request.jwt.claims', '{"sub":"${OWNER}","role":"authenticated"}', false); set role authenticated;`);
  const one = async <T>(sql: string, args: unknown[] = []) => (await d.query<{ v: T }>(sql, args)).rows[0].v;
  const ws = await one<string>("select public.create_workspace('Analytics E2E', 'Nigeria', 'Africa/Lagos', 'Ọlá Adéyẹmí') as v");
  const loc = await one<string>("select public.upsert_location($1, null, 'Main', false) as v", [ws]);
  const cat = await one<{ id: string }>("select public.save_category($1, null, 'Grills', false, null) as v", [ws]);
  const alpha = await one<string>("select public.upsert_subject($1, null, '=Alpha Stall', 'vendor', false) as v", [ws]);
  await d.query("select public.save_subject($1, $2, '=Alpha Stall', 'vendor', $3, null, '{}', false, 1)", [ws, alpha, cat.id]);
  const beta = await one<string>("select public.upsert_subject($1, null, 'Beta Kitchen', 'operation', false) as v", [ws]);
  const tv = async (name: string, pack: string, mode: string, criteria: unknown) =>
    one<string>("select public.publish_template($1, null, $2, $3::public.starter_pack, $4::public.attendance_mode, $5::jsonb, null) as v",
      [ws, name, pack, mode, JSON.stringify(criteria)]);
  const food = await tv("Food vendors", "food_vendors", "scored",
    [{ key: "taste", label: "Taste", critical: true }, { key: "hygiene", label: "Hygiene", allow_na: true }]);
  const rest = await tv("Restaurant operations", "restaurant_ops", "off", [{ key: "hygiene", label: "Hygiene" }, { key: "safety", label: "Safety" }]);
  const sup = await tv("Supplier and service quality", "supplier_service", "off", [{ key: "quality", label: "Quality", trigger_at_or_below: 2 }]);

  async function approve(template: string, date: string, rows: { subject: string; outcome: string; answers: object; observed?: string }[]) {
    const sid = await one<string>(`select public.create_session($1, $2, $3, 'Panel ' || $4, $4::date, $5::uuid[], array[$6::uuid], array[$6::uuid], 48,
      case when (select attendance_mode from public.template_versions where id = $3) = 'scored' then '09:00'::time end) as v`,
      [ws, loc, template, date, rows.map((r) => r.subject), OWNER]);
    for (const r of rows) {
      await d.query("select public.submit_assessment($1, $2, $3, $4::public.subject_outcome, $5::jsonb, null, 0, gen_random_uuid(), null)",
        [sid, r.subject, OWNER, r.observed ?? null, JSON.stringify(r.answers)]);
      await d.query("select public.resolve_outcome($1, $2, $3::public.subject_outcome, null, 1)", [sid, r.subject, r.outcome]);
    }
    await d.query("select public.approve_session($1, (select data_version from public.sessions where id = $1))", [sid]);
    return sid;
  }
  const q90 = { taste: 5, hygiene: 4 };
  const q80 = { taste: 4, hygiene: 4 };
  const outcomes = ["early", "early", "early", "late", "middle", "late"];
  for (let i = 0; i < 6; i++) {
    await approve(food, `2026-09-0${i + 1}`, [
      { subject: alpha, outcome: outcomes[i], answers: i < 3 ? q90 : q80 },
      { subject: beta, outcome: "early", answers: { taste: 5, hygiene: 5 } },
    ]);
  }
  await approve(rest, "2026-09-07", [{ subject: beta, outcome: "assessed", answers: { hygiene: 4, safety: 3 } }]);
  const supId = await approve(sup, "2026-09-08", [{ subject: alpha, outcome: "assessed", answers: { quality: 2 } }]);
  const sample = await one<string>("select public.create_sample_session($1, $2, $3) as v", [ws, loc, food]);
  for (const s of (await d.query<{ id: string }>("select subject_id as id from public.session_subjects where session_id = $1", [sample])).rows) {
    await d.query("select public.submit_assessment($1, $2, $3, null, $4::jsonb, null, 0, gen_random_uuid(), null)", [sample, s.id, OWNER, JSON.stringify({ taste: 1, hygiene: 1 })]);
    await d.query("select public.resolve_outcome($1, $2, 'early', null, 1)", [sample, s.id]);
  }
  await d.query("select public.approve_session($1, (select data_version from public.sessions where id = $1))", [sample]);
  return { d, ws, alpha, beta, supId, cat: cat.id };
}

describe("analytics end to end on real approvals", () => {
  it("reconciles the page, CSV and PDF from one dataset, with exact rule boundaries and no samples", async () => {
    const { d, ws, alpha, supId } = await setup();
    const ds = (await d.query<{ v: AnalyticsDataset }>("select public.get_analytics($1, 'approved', '{}', 'csv') as v", [ws])).rows[0].v;
    expect(ds.total).toBe(8);                       // six food + restaurant + supplier; the sample is excluded in SQL
    expect(ds.records.every((r) => !r.inputs.session.is_sample)).toBe(true);
    const r = buildAnalytics(ds, {});
    expect(r.excludedSamples).toBe(0);
    expect(r.versionGroups.map((g) => g.label)).toEqual(["Food vendors v1", "Restaurant operations v1", "Supplier and service quality v1"]);

    const decline = r.attention.flags.find((f) => f.kind === "decline")!;
    expect(decline.subjectId).toBe(alpha);
    expect(decline.value).toBeCloseTo(-10, 9);
    const late = r.attention.flags.find((f) => f.kind === "attendance")!;
    expect(late.subjectId).toBe(alpha);
    // The supplier trigger raised a current high finding (not critical): no critical flag from it.
    expect(ds.findings.map((f) => [f.session_id, f.severity, f.current])).toEqual([[supId, "high", true]]);
    expect(r.attention.flags.some((f) => f.kind === "critical")).toBe(false);

    // Category recorded at approval; Alpha's quality never mixes with Beta's pack/version.
    const grills = r.categories.filter((c) => c.label === "Grills");
    expect(grills.map((c) => [c.versionLabel, c.counts.subjectSessions])).toEqual([["Food vendors v1", 6], ["Supplier and service quality v1", 1]]);
    const foodGroup = r.versionGroups[0];
    expect(foodGroup.quality.map((g) => [g.n, Math.round(g.quality! * 100) / 100])).toEqual([[12, 92.5]]);

    // CSV and PDF are built from the same sections.
    const csv = buildAnalyticsCsv(ds, {}, r);
    for (const s of analyticsSections(ds, r)) expect(csv).toContain(`"${s.title}"`);
    expect(csv).toContain(`"Subject-sessions","14"`);
    expect(csv).toContain(`"'=Alpha Stall"`);
    expect(csv).not.toMatch(/(^|,)"[=+\-@]/m);
    expect(csv).not.toContain("Ọlá Adéyẹmí");      // no assessor/approver identities in analytics
    const pdf = await PDFDocument.load(await buildAnalyticsPdf(ds, {}, r));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);

    // A filter is the same dataset narrowed, and the export audit records it.
    const only = (await d.query<{ v: AnalyticsDataset }>("select public.get_analytics($1, 'approved', $2::jsonb, 'view') as v",
      [ws, JSON.stringify({ pack: "supplier_service" })])).rows[0].v;
    expect(buildAnalytics(only, {}).counts.subjectSessions).toBe(1);
    await d.exec("reset role");
    const audits = (await d.query<{ n: number }>("select count(*)::int as n from public.audit_events where action = 'analytics.exported'")).rows[0].n;
    expect(audits).toBe(1);
    await d.close();
  }, 120_000);

  it("report exports of a real m3.1 approval show the frozen section and a later closure in the dated appendix", async () => {
    const { d, supId } = await setup();
    const finding = (await d.query<{ id: string }>("select id from public.findings where session_id = $1", [supId])).rows[0].id;
    const action = (await d.query<{ r: { action_id: string } }>("select public.create_action($1, '+Late deliveries', 'Agree a delivery window', 'high', $2, (now() at time zone 'Africa/Lagos')::date + 2, gen_random_uuid()) as r",
      [finding, OWNER])).rows[0].r.action_id;
    const step = (cmd: string, v: number, evidence: string | null, reason: string | null) =>
      d.query("select public.transition_action($1, $2, $3, $4, $5, gen_random_uuid())", [action, cmd, v, evidence, reason]);
    await step("start", 1, null, null);
    await step("submit", 2, "Ẹ̀kọ́ depot agreed 07:00–09:00 window; =signed note on file", null);
    await step("verify", 3, null, "Owner-only business; checked the signed note");
    const env = (await d.query<{ v: ReportEnvelope }>("select public.get_session_report($1, null, false, 'csv') as v", [supId])).rows[0].v;
    expect(env.meta.actions_snapshot).toBe("frozen");
    expect(env.inputs.actions).toEqual([]);           // the action came after approval
    expect(env.actions_appendix!.actions[0]).toMatchObject({ created_after_snapshot: true, in_snapshot: false, status: "closed" });
    const csv = buildCsv(env);
    expect(csv).toContain("Quality scored 2 (at or below 2)");
    expect(csv).toContain(`"'+Late deliveries"`);
    expect(csv).toContain("Created after this approval");
    expect(csv).toContain("Ẹ̀kọ́ depot agreed 07:00–09:00 window; =signed note on file");
    expect(csv).toContain(`"Closed"`);
    expect(csv).toContain("Ọlá Adéyẹmí");            // identified export names the assignee
    expect((await PDFDocument.load(await buildPdf(env))).getPageCount()).toBeGreaterThanOrEqual(1);

    // Redacted export of the same report: no assignee/assessor/approver-free identity leaks except the
    // approver name M1 always shows; the assignee is pseudonymous in the appendix.
    const red = (await d.query<{ v: ReportEnvelope }>("select public.get_session_report($1, null, true, 'pdf') as v", [supId])).rows[0].v;
    expect(red.actions_appendix!.actions[0].assignee_label).toBe("Assigned staff member");
    const redCsv = buildCsv(red);
    expect(redCsv).toContain("Assigned staff member");
    expect(redCsv).toContain("Ẹ̀kọ́ depot agreed");     // evidence text kept (free text disclosure applies)
    expect(redCsv.replace(/"Approved by","Ọlá Adéyẹmí"/, "")).not.toContain("Ọlá Adéyẹmí");
    const pdf = await PDFDocument.load(await buildPdf(red));
    expect([pdf.getTitle(), pdf.getAuthor(), pdf.getSubject()].join("|")).not.toContain("Ọlá");
    await d.close();
  }, 120_000);
});
