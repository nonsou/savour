// End-to-end import path on embedded Postgres: the server-side parser output (mapImport) goes
// to preview and commit exactly as the server action sends it. Sequential (PGlite).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { EXAMPLE_CSV, mapImport, type ImportPlan, type ImportReceipt } from "@/lib/csv-import";

const root = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const OWNER = "eeeeeeee-0000-4000-8000-000000000501";

async function db() {
  const d = new PGlite();
  await d.exec(read("tests", "sql", "supabase-stub.sql"));
  for (const f of readdirSync(join(root, "supabase", "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    await d.exec(read("supabase", "migrations", f));
  }
  await d.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'import-fixture@savour.test', now());
    select set_config('request.jwt.claims', '{"sub":"${OWNER}","role":"authenticated"}', false); set role authenticated;`);
  const ws = (await d.query<{ id: string }>("select public.create_workspace('Import QA', 'Nigeria', 'Africa/Lagos', 'Owner') as id")).rows[0].id;
  // M4 fixture: two locations exceed the trial limit; the database owner lifts it for this disposable
  // workspace only (billing.fixture_uncap_trial, owner-only and audited).
  await d.exec(`reset role; select set_config('savour.fixture_mode', 'disposable', false);
    select billing.fixture_uncap_trial('${ws}'); set role authenticated;`);
  await d.query("select public.upsert_location($1, null, 'Main Site', false)", [ws]);
  await d.query("select public.upsert_location($1, null, 'Annex', false)", [ws]);
  await d.query("select public.save_category($1, null, 'Grills', false, null)", [ws]);
  return { d, ws };
}
const rows = (text: string) => { const m = mapImport(text); if (!m.ok) throw new Error(m.error); return JSON.stringify(m.rows); };

describe("CSV import end to end", () => {
  it("previews without writing, commits atomically once, and replays the identical receipt", async () => {
    const { d, ws } = await db();
    const payload = rows("﻿" + EXAMPLE_CSV + "\r\n,,\r\n");
    const plan = (await d.query<{ p: ImportPlan }>("select public.preview_subject_import($1, $2::jsonb) as p", [ws, payload])).rows[0].p;
    expect(plan).toMatchObject({ valid: true, counts: { create: 3, update: 0, error: 0 } });
    expect(plan.rows[1]).toMatchObject({ name: "Suya Spot, Gate 2", locations: ["Main Site", "Annex"], category: "Grills" });
    expect((await d.query<{ n: number }>("select count(*)::int as n from public.subjects")).rows[0].n).toBe(0);
    const key = "eeeeeeee-0000-4000-8000-0000000005aa";
    const commit = "select public.commit_subject_import($1, $2, $3::jsonb, $4) as r";
    const first = (await d.query<{ r: ImportReceipt }>(commit, [ws, key, payload, plan.plan_hash])).rows[0].r;
    const again = (await d.query<{ r: ImportReceipt }>(commit, [ws, key, payload, plan.plan_hash])).rows[0].r;
    expect(first).toMatchObject({ created: 3, replayed: false });
    expect({ ...again, replayed: false }).toEqual(first);
    expect((await d.query<{ n: number }>("select count(*)::int as n from public.subjects")).rows[0].n).toBe(3);
    // Re-importing the same file without a new key: every row matches by external ID, nothing changes.
    const plan2 = (await d.query<{ p: ImportPlan }>("select public.preview_subject_import($1, $2::jsonb) as p", [ws, payload])).rows[0].p;
    expect(plan2.counts).toMatchObject({ create: 0, update: 0, unchanged: 3 });
    await d.close();
  }, 120_000);

  it("reports row errors with source line numbers and writes nothing", async () => {
    const { d, ws } = await db();
    const text = 'name,type,external_id,category\n"Two\nlines",vendor,,\nGood,vendor,X1,\nDup,vendor,x1,\n,vendor,,\nOther,robot,,Nope\n';
    const plan = (await d.query<{ p: ImportPlan }>("select public.preview_subject_import($1, $2::jsonb) as p", [ws, rows(text)])).rows[0].p;
    expect(plan.valid).toBe(false);
    const byLine = Object.fromEntries(plan.rows.map((r) => [r.line, r.errors.join(" ")]));
    expect(byLine[2]).toContain("line breaks");
    expect(byLine[4]).toContain("lines 4, 5");
    expect(byLine[5]).toContain("lines 4, 5");
    expect(byLine[6]).toContain("Name is required");
    expect(byLine[7]).toMatch(/Type must be.*Unknown category "Nope"/);
    await expect(d.query("select public.commit_subject_import($1, gen_random_uuid(), $2::jsonb, $3)", [ws, rows(text), plan.plan_hash]))
      .rejects.toThrow(/import_invalid/);
    expect((await d.query<{ n: number }>("select count(*)::int as n from public.subjects")).rows[0].n).toBe(0);
    await d.close();
  }, 120_000);
});
