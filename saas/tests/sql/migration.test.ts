// Replays every migration on an empty embedded Postgres (PGlite) and runs the transactional
// security test. PGlite is single-connection: true parallel lock contention is not exercised
// here (see README "Known gaps"); the stale-version guards are.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

async function freshDb() {
  const db = new PGlite();
  await db.exec(read("tests", "sql", "supabase-stub.sql"));
  const dir = join(root, "supabase", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(read("supabase", "migrations", file));
  }
  return db;
}

describe("database migration and security script", () => {
  it("replays from an empty schema and passes every security expectation", async () => {
    const db = await freshDb();
    const results = await db.exec(read("supabase", "tests", "m1_security.sql"));
    const passed = results.flatMap((r) => r.rows).find((row) => row && "passed" in row) as
      | { passed: number }
      | undefined;
    expect(Number(passed?.passed)).toBeGreaterThanOrEqual(100);
    // The script rolls back: no fixture data remains.
    const left = await db.query<{ n: number }>("select count(*)::int as n from public.workspaces");
    expect(left.rows[0].n).toBe(0);
    await db.close();
  }, 120_000);

  it("enables RLS on every public table and grants clients no write privileges", async () => {
    const db = await freshDb();
    const noRls = await db.query(
      "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace " +
        "where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity",
    );
    expect(noRls.rows).toEqual([]);
    const writes = await db.query(
      "select table_name, privilege_type from information_schema.role_table_grants " +
        "where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'",
    );
    expect(writes.rows).toEqual([]);
    const definerInPublic = await db.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
        "where n.nspname = 'public' and p.prosecdef",
    );
    expect(definerInPublic.rows).toEqual([]);
    const unsafeDefiner = await db.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
        "where n.nspname = 'private' and p.prosecdef and not coalesce('search_path=\"\"' = any (p.proconfig), false)",
    );
    expect(unsafeDefiner.rows).toEqual([]);
    const anonExec = await db.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
        "where n.nspname in ('public','private') and (has_function_privilege('anon', p.oid, 'execute'))",
    );
    expect(anonExec.rows).toEqual([]);
    await db.close();
  }, 120_000);
});
