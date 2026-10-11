// Independent Sol regression: freeze the M2 redaction before replaying M3. Keep both the
// deterministic fixture and the optional 15 disposable development approvals (never committed).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { assessment, inputs, subject } from "../unit/fixtures";
import type { ReportInputs } from "@/lib/scoring";

const root = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const dir = join(root, "supabase", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
async function m2Db() {
  const db = new PGlite();
  await db.exec(read("tests", "sql", "supabase-stub.sql"));
  for (const f of files.filter((f) => f <= "20261010235525_m2_fk_covering_indexes.sql")) await db.exec(read("supabase", "migrations", f));
  return db;
}
async function upgrade(db: PGlite) {
  for (const f of files.filter((f) => f > "20261010235525_m2_fk_covering_indexes.sql")) await db.exec(read("supabase", "migrations", f));
}
async function red(db: PGlite, p: ReportInputs) {
  return (await db.query<{ result: string }>("select private.redact_inputs($1::jsonb)::text as result", [JSON.stringify(p)])).rows[0].result;
}

describe("Sol: M2 identity redaction survives M3", () => {
  it("preserves M2 waivers, names, ordering, absence and removed evidence byte for byte", async () => {
    const p = inputs("scored", [
      subject("early", [assessment({ taste: 4, hygiene: 5 }, "Private assessor Z", { assessor_id: "z", notes: "Names in notes remain a disclosed sharing limitation." })], {
        required_assessors: 2, waived_assessors: 1,
        waivers: [{ assessor_id: "a", assessor_label: "Private assessor A", reason: "Unavailable", waived_at: "2026-10-10T10:00:00Z", waived_by_label: "Private reviewer" }],
        restored: { restored_at: "2026-10-10T09:00:00Z", reason: "Returned to roster" },
      }),
      subject("absent", [], { subject_id: "absent", required_assessors: 1, outcome_reason: "Absent with reason" }),
      subject("middle", [assessment({ taste: 5, hygiene: { na: "No kitchen" } }, "Private assessor A", { assessor_id: "a" })]),
    ]);
    p.formula_version = "savour-m2.1";
    p.removed_subjects = [{ subject_id: "removed", name: "Removed subject", removed_at: "2026-10-10T08:00:00Z", reason: "Recorded removal", retained_responses: 1 }];
    const db = await m2Db();
    try {
      const before = await red(db, p);
      await upgrade(db);
      expect(await red(db, p)).toBe(before);
      expect(before).not.toContain("Private assessor");
      expect(before).not.toContain("Private reviewer");
      expect(JSON.parse(before).subjects[0]).toMatchObject({ waived_assessors: 1, waivers: [{ assessor_label: "Assessor 1" }] });
    } finally { await db.close(); }
  }, 120_000);
});

const qaFile = "/tmp/savour-m3-legacy-envelopes.json";
describe.skipIf(!existsSync(qaFile))("Sol: all 15 pre-M3 disposable approvals", () => {
  it("retains their recorded body hashes and exact previously captured redacted bodies", async () => {
    const qa = JSON.parse(readFileSync(qaFile, "utf8")) as { session_id: string; revision: number; inputs: ReportInputs; redacted: ReportInputs }[];
    const pins = JSON.parse(read("..", "docs", "milestone-3", "qa-snapshot-baseline.json")) as { session_id: string; revision: number; inputs_hash: string }[];
    const db = await m2Db();
    try {
      await upgrade(db);
      expect(qa).toHaveLength(15);
      for (const snap of qa) {
        const pin = pins.find((p) => p.session_id === snap.session_id && p.revision === snap.revision)!;
        const { rows } = await db.query<{ hash: string; actual: ReportInputs }>(
          "select encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex') as hash, private.redact_inputs($1::jsonb) as actual", [JSON.stringify(snap.inputs)]);
        expect(rows[0].hash).toBe(pin.inputs_hash);
        expect(rows[0].actual).toEqual(snap.redacted);
      }
    } finally { await db.close(); }
  }, 120_000);
});
