// Shared embedded-Postgres harness for M4 worker tests: real migrations, scoped roles via SET ROLE,
// user RPCs via request.jwt.claims, and a mock Bachs transport (official schema shapes, no network).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { TransportRequest, TransportResponse } from "../../supabase/functions/_shared/bachs-client.ts";
import { assertAllowed, callSql, type ArgType, type ScopedDb, type ScopedRole } from "../../supabase/functions/_shared/db.ts";
import type { UserRpc } from "../../supabase/functions/_shared/owner-core.ts";

const root = join(import.meta.dirname, "..", "..");
export type Handler = (req: TransportRequest) => TransportResponse | Promise<TransportResponse>;
export const ok = (body: unknown, status = 200): TransportResponse => ({ status, bodyText: JSON.stringify(body) });
export const timeout = (): never => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };

/** stopBefore: apply only migrations sorting before this file name; migrateRest() applies the others later
 *  (to test a backfill over data written by the earlier schema). */
export async function harness(opts: { stopBefore?: string } = {}) {
  const pg = new PGlite();
  await pg.exec(readFileSync(join(root, "tests/sql/supabase-stub.sql"), "utf8"));
  const files = readdirSync(join(root, "supabase/migrations")).filter((x) => x.endsWith(".sql")).sort();
  const later = opts.stopBefore ? files.filter((f) => f >= opts.stopBefore!) : [];
  for (const f of files.filter((x) => !later.includes(x))) {
    await pg.exec(readFileSync(join(root, "supabase/migrations", f), "utf8"));
  }
  const migrateRest = async () => { for (const f of later.splice(0)) await pg.exec(readFileSync(join(root, "supabase/migrations", f), "utf8")); };
  let queue: Promise<unknown> = Promise.resolve();
  // PGlite has one connection: serialize role switches so concurrent awaits never interleave.
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = queue.then(f, f);
    queue = next.catch(() => undefined);
    return next;
  };
  const scoped = (role: ScopedRole): ScopedDb => {
    const run = (fn: string, args: [ArgType, unknown][], set: boolean) => serial(async () => {
      assertAllowed(role, fn);
      await pg.exec(`set role ${role}`);
      try { return (await pg.query<Record<string, unknown>>(callSql(fn, args, set), args.map(([, v]) => v ?? null))).rows; }
      finally { await pg.exec("reset role"); }
    });
    return { role, call: async <T>(fn: string, a: [ArgType, unknown][]) => (await run(fn, a, false))[0]?.r as T,
      rows: async <T>(fn: string, a: [ArgType, unknown][]) => (await run(fn, a, true)) as T[] };
  };
  const userRpc = (uid: string, aal = "aal1"): UserRpc => (fn, args) => serial(async () => {
    const keys = Object.keys(args);
    await pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: uid, role: "authenticated", aal })]);
    await pg.exec("set role authenticated");
    try {
      const r = await pg.query<{ r: unknown }>(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
      return { data: r.rows[0].r, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message, details: (e as { detail?: string }).detail ?? null } };
    } finally {
      await pg.exec("reset role");
    }
  });
  const q = <T>(sql: string, params: unknown[] = []) => serial(async () => (await pg.query<T>(sql, params)).rows);

  const routes = new Map<string, Handler>();
  const seen: TransportRequest[] = [];
  const transport = async (req: TransportRequest) => {
    seen.push(req);
    const u = new URL(req.url);
    const h = routes.get(`${req.method} ${u.pathname}`);
    return h ? h(req) : { status: 404, bodyText: JSON.stringify({ detail: "not found", error_code: "NOT_FOUND" }) };
  };

  /** An enabled, default-or-not Bachs connection created through the real admin path. */
  async function connection(admin: string, label: string, key: string, org: string, makeDefault = true): Promise<string> {
    await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict do nothing`, [admin, `${admin}@m4-harness.test`]);
    await q(`insert into platform.admins (user_id, note) values ($1, 'disposable founder QA fixture') on conflict do nothing`, [admin]);
    const a = userRpc(admin, "aal2");
    const id = (await a("platform_create_connection", { p_provider: "bachs", p_label: label })).data as string;
    await a("platform_store_secret", { p_conn: id, p_kind: "api_key", p_secret: key, p_expected_version: 1 });
    await a("platform_store_secret", { p_conn: id, p_kind: "webhook_secret", p_secret: `whsec_TESTONLY_${label.replace(/\W/g, "")}_000000`, p_expected_version: 2 });
    await a("platform_set_expected_org", { p_conn: id, p_org: org, p_expected_version: 3 });
    const test = (await a("platform_begin_test", { p_conn: id })).data as string;
    await scoped("billing_gateway").call("platform.gateway_record_test", [["uuid", test], ["uuid", admin], ["boolean", true], ["boolean", true],
      ["jsonb", '{"account":"ok"}'], ["jsonb", "[]"]]);
    const version = ((await q<{ version: number }>("select version from platform.provider_connections where id = $1", [id]))[0]).version;
    await a("platform_enable", { p_conn: id, p_expected_version: version });
    if (makeDefault) {
      const sv = ((await q<{ version: number }>("select version from platform.settings"))[0]).version;
      await a("platform_set_default", { p_conn: id, p_expected_version: sv });
    }
    return id;
  }

  return { pg, serial, scoped, userRpc, q, routes, seen, transport, connection, migrateRest, close: () => pg.close() };
}
