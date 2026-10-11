// Legacy regression: approved Milestone 1 snapshots must survive the Milestone 2 migrations
// byte-identical, keep their formula label and redaction, and compute exactly as before; and
// Milestone 1 and 2 snapshots must survive the Milestone 3 migrations the same way.
// Part 1 builds real M1 snapshots on an M1-only schema (one per starter pack), then upgrades.
// Part 2 checks Sol's saved disposable QA snapshots from savour-dev when they are present locally
// (/tmp/savour-m2-legacy-*.json; never committed). PGlite, sequential.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { summarizeSession, type ReportInputs } from "@/lib/scoring";

const root = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const M1 = ["20261010202119_m1_core.sql", "20261010224854_guest_read_closes_with_collection.sql"];
const ALL = readdirSync(join(root, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort();
const M3_FIRST = "20261011144333";
const M2 = ALL.filter((f) => !M1.includes(f) && f < M3_FIRST);
const M3 = ALL.filter((f) => f >= M3_FIRST);

async function m1Db() {
  const db = new PGlite();
  await db.exec(read("tests", "sql", "supabase-stub.sql"));
  for (const f of M1) await db.exec(read("supabase", "migrations", f));
  return db;
}
async function upgrade(db: PGlite, files = M2) {
  for (const f of files) await db.exec(read("supabase", "migrations", f));
}
const SNAP = "select r.id, s.name, r.revision, r.inputs::text as inputs, r.inputs_hash, r.formula_version, r.approver_name, " +
  "private.redact_inputs(r.inputs)::text as redacted, encode(sha256(convert_to(r.inputs::text, 'UTF8')), 'hex') as recomputed " +
  "from public.report_revisions r join public.sessions s on s.id = r.session_id order by s.name, r.revision";
type Snap = { id: string; name: string; revision: number; inputs: string; inputs_hash: string; formula_version: string; redacted: string; recomputed: string };

const r1 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
function headline(inputs: ReportInputs) {
  const s = summarizeSession(inputs);
  return {
    quality: r1(s.quality.mean), combined: r1(s.combined.mean), coverage: [s.coverage.complete, s.coverage.due],
    subjects: s.subjects.map((x) => [x.status, r1(x.quality), r1(x.combined), x.attendancePoints]),
  };
}

describe("Milestone 1 snapshots across the Milestone 2 upgrade", () => {
  it("stay byte-identical, keep formula savour-m1.1 and redaction, and compute the recorded values", async () => {
    const db = await m1Db();
    await db.exec(read("tests", "sql", "m1_legacy_fixture.sql"));
    const before = (await db.query<Snap>(SNAP)).rows;
    expect(before).toHaveLength(4);
    expect(new Set(before.map((r) => r.formula_version))).toEqual(new Set(["savour-m1.1"]));
    const valuesBefore = before.map((r) => headline(JSON.parse(r.inputs)));

    await upgrade(db);
    const after = (await db.query<Snap>(SNAP)).rows;
    expect(after).toEqual(before); // inputs, hash, label, approver and (old vs new) redaction all identical
    for (const r of after) expect(r.recomputed).toBe(r.inputs_hash);
    expect(after.map((r) => headline(JSON.parse(r.inputs)))).toEqual(valuesBefore);

    const byName = Object.fromEntries(after.map((r) => [`${r.name} r${r.revision}`, headline(JSON.parse(r.inputs))]));
    expect(byName["Legacy food panel r1"]).toEqual({
      quality: 85, combined: 71.67, coverage: [2, 2],
      subjects: [["scored", 90, 93.33, 5], ["scored", 80, 50, 1], ["absent", null, null, 0]],
    });
    expect(byName["Legacy kitchen check r1"]).toEqual({
      quality: 60, combined: null, coverage: [1, 2], subjects: [["scored", 60, null, null], ["not_assessed", null, null, null]],
    });
    expect(byName["Legacy supplier review r1"].quality).toBe(90);
    expect(byName["Legacy supplier review r2"].quality).toBe(80);

    // Report reads still serve the stored snapshot with its own formula label.
    await db.exec(`select set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-4000-8000-000000000403","role":"authenticated"}', false); set role authenticated;`);
    const food = (await db.query<{ id: string }>("select id from public.sessions where name = 'Legacy food panel'")).rows[0].id;
    const env = (await db.query<{ r: { meta: { formula_version: string; status: string }; inputs: ReportInputs } }>(
      "select public.get_session_report($1, null, false, 'view') as r", [food])).rows[0].r;
    expect(env.meta).toMatchObject({ formula_version: "savour-m1.1", status: "approved" });
    expect(JSON.stringify(env.inputs)).toBe(JSON.stringify(JSON.parse(after.find((r) => r.name === "Legacy food panel")!.inputs)));
    const dash = (await db.query<{ r: { approved: unknown[] } }>(
      "select public.get_dashboard((select workspace_id from public.sessions where id = $1)) as r", [food])).rows[0].r;
    expect(dash.approved).toHaveLength(3);

    // Reapproving the same evidence after the upgrade stamps savour-m2.1 with identical numbers.
    await db.exec(`reset role; select set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-4000-8000-000000000401","role":"authenticated"}', false); set role authenticated;`);
    await db.query("select public.reopen_session($1, 'Upgrade check')", [food]);
    await db.query("select public.approve_session($1, (select data_version from public.sessions where id = $1))", [food]);
    await db.exec("reset role");
    const rows = (await db.query<{ revision: number; formula_version: string; inputs: ReportInputs }>(
      "select revision, formula_version, inputs from public.report_revisions where session_id = $1 order by revision", [food])).rows;
    expect(rows.map((r) => r.formula_version)).toEqual(["savour-m1.1", "savour-m2.1"]);
    expect(headline(rows[1].inputs)).toEqual(headline(rows[0].inputs));
    expect(rows[1].inputs).toMatchObject({ removed_subjects: [], session: { is_sample: false } });
    expect(JSON.stringify((await db.query(SNAP)).rows.filter((r) => (r as Snap).formula_version === "savour-m1.1")))
      .toBe(JSON.stringify(after));
    await db.close();
  }, 120_000);
});

describe("Milestone 1 and 2 snapshots across the Milestone 3 upgrade", () => {
  it("stay byte-identical with identical redaction; reports say no action state was frozen; reapproval freezes actions", async () => {
    const db = await m1Db();
    await db.exec(read("tests", "sql", "m1_legacy_fixture.sql"));
    await upgrade(db);
    // One m2.1 approval on the M2 schema: reopen and reapprove the supplier review (now r3).
    const owner = `select set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-4000-8000-000000000401","role":"authenticated"}', false); set role authenticated;`;
    await db.exec(owner);
    const supplier = (await db.query<{ id: string }>("select id from public.sessions where name = 'Legacy supplier review'")).rows[0].id;
    await db.query("select public.reopen_session($1, 'M2 recheck')", [supplier]);
    await db.query("select public.approve_session($1, (select data_version from public.sessions where id = $1))", [supplier]);
    await db.exec("reset role");
    const before = (await db.query<Snap>(SNAP)).rows;
    expect(before.map((r) => r.formula_version).sort()).toEqual(["savour-m1.1", "savour-m1.1", "savour-m1.1", "savour-m1.1", "savour-m2.1"]);
    const values = before.map((r) => headline(JSON.parse(r.inputs)));

    await upgrade(db, M3);
    const after = (await db.query<Snap>(SNAP)).rows;
    expect(after).toEqual(before); // inputs, hash, label, approver and (M2 vs M3) redaction all identical
    for (const r of after) expect(r.recomputed).toBe(r.inputs_hash);
    expect(after.map((r) => headline(JSON.parse(r.inputs)))).toEqual(values);

    // Report of a legacy approval: not_recorded; a later action appears only in the dated appendix.
    await db.exec(owner);
    const food = (await db.query<{ id: string }>("select id from public.sessions where name = 'Legacy food panel'")).rows[0].id;
    const subject = (await db.query<{ id: string }>("select subject_id as id from public.session_subjects where session_id = $1 order by subject_name limit 1", [food])).rows[0].id;
    const finding = (await db.query<{ r: { finding_id: string } }>(
      "select public.create_finding($1, $2, 'high', 'Late fix', null, null, gen_random_uuid()) as r", [food, subject])).rows[0].r.finding_id;
    const today = (await db.query<{ d: string }>("select to_char((now() at time zone 'Africa/Lagos')::date + 3, 'YYYY-MM-DD') as d")).rows[0].d;
    await db.query("select public.create_action($1, 'Fix it', 'Do the fix', 'high', 'eeeeeeee-0000-4000-8000-000000000401', $2::date, gen_random_uuid())", [finding, today]);
    const env = (await db.query<{ r: { meta: { actions_snapshot: string; formula_version: string }; inputs: ReportInputs;
      actions_appendix: { snapshot: string; actions: { created_after_snapshot: boolean; in_snapshot: boolean | null }[] } } }>(
      "select public.get_session_report($1, null, false, 'view') as r", [food])).rows[0].r;
    expect(env.meta).toMatchObject({ actions_snapshot: "not_recorded", formula_version: "savour-m1.1" });
    expect(env.inputs).not.toHaveProperty("actions");
    expect(env.actions_appendix.snapshot).toBe("not_recorded");
    expect(env.actions_appendix.actions).toEqual([expect.objectContaining({ created_after_snapshot: true, in_snapshot: null })]);
    await db.exec("reset role");
    expect((await db.query<Snap>(SNAP)).rows).toEqual(before);

    // Reapproval after the upgrade stamps m3.1, computes identically and freezes the action.
    await db.exec(owner);
    await db.query("select public.reopen_session($1, 'Upgrade check')", [food]);
    await db.query("select public.approve_session($1, (select data_version from public.sessions where id = $1))", [food]);
    await db.exec("reset role");
    const rows = (await db.query<{ formula_version: string; inputs: ReportInputs }>(
      "select formula_version, inputs from public.report_revisions where session_id = $1 order by revision", [food])).rows;
    expect(rows.map((r) => r.formula_version)).toEqual(["savour-m1.1", "savour-m3.1"]);
    expect(headline(rows[1].inputs)).toEqual(headline(rows[0].inputs));
    expect(rows[1].inputs.actions).toHaveLength(1);
    expect(rows[1].inputs.subjects.every((x) => "category_id" in x && "subject_type" in x)).toBe(true);
    await db.close();
  }, 120_000);
});

const inputsFile = "/tmp/savour-m2-legacy-inputs.json";
const expectedFile = "/tmp/savour-m2-legacy-expected.json";
const haveQa = existsSync(inputsFile) && existsSync(expectedFile);

describe.skipIf(!haveQa)("saved savour-dev QA snapshots (local files, not committed)", () => {
  it("hash, redact and compute exactly as recorded before Milestone 2", async () => {
    const snaps = JSON.parse(readFileSync(inputsFile, "utf8")) as { session_id: string; revision: number; inputs_hash: string; inputs: ReportInputs }[];
    const expected = JSON.parse(readFileSync(expectedFile, "utf8")) as Record<string, unknown>[];
    const baseline = JSON.parse(read("..", "docs", "milestone-2", "qa-snapshot-baseline.json")) as { snapshots: { session_id: string; revision: number; inputs_hash: string }[] };
    expect(snaps).toHaveLength(baseline.snapshots.length);

    const m1 = await m1Db();
    const m2 = await m1Db();
    await upgrade(m2);
    const m3 = await m1Db();
    await upgrade(m3, [...M2, ...M3]);
    for (const snap of snaps) {
      const base = baseline.snapshots.find((b) => b.session_id === snap.session_id && b.revision === snap.revision)!;
      const q = "select encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex') as h, private.redact_inputs($1::jsonb)::text as red";
      const [a, b] = await Promise.all([m1.query<{ h: string; red: string }>(q, [JSON.stringify(snap.inputs)]),
        m2.query<{ h: string; red: string }>(q, [JSON.stringify(snap.inputs)])]);
      expect(b.rows[0].h).toBe(base.inputs_hash);
      expect(snap.inputs_hash).toBe(base.inputs_hash);
      expect(b.rows[0].red).toBe(a.rows[0].red); // M2 redaction of an m1.1 snapshot is byte-identical
      expect((await m3.query<{ red: string }>(q, [JSON.stringify(snap.inputs)])).rows[0].red).toBe(a.rows[0].red); // and M3's
      expect(snap.inputs.formula_version).toBe("savour-m1.1");

      const exp = expected.find((e) => e.session_id === snap.session_id && e.revision === snap.revision) as {
        quality: unknown; combined: unknown; attendance: unknown; coverage: Record<string, unknown>;
        subjects: { id: string; status: string; quality: number | null; combined: number | null; attendance: number | null }[];
      };
      const s = summarizeSession(snap.inputs);
      expect(s.quality).toEqual(exp.quality);
      expect(s.combined).toEqual(exp.combined);
      expect(s.attendance).toEqual(exp.attendance);
      expect(s.coverage).toMatchObject(exp.coverage);
      expect(s.subjects.map((x) => ({ id: x.subjectId, status: x.status, quality: x.quality, combined: x.combined, attendance: x.attendancePoints })))
        .toEqual(exp.subjects);
    }
    await m1.close();
    await m2.close();
    await m3.close();
  }, 120_000);
});
