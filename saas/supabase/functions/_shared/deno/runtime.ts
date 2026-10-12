// Deno/Supabase Edge runtime wiring only (excluded from the Node typecheck; Sol runs deno check and
// deploys). Database connections use the scoped login roles; the auto-injected service-role key is
// never read. Provider API keys and webhook secrets come from Vault through the scoped functions.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { assertAllowed, callSql, type ArgType, type ScopedDb, type ScopedRole } from "../db.ts";
import { ENV } from "../http.ts";
import type { UserRpc } from "../owner-core.ts";

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing configuration ${name}`);
  return v;
}

const pools = new Map<string, ReturnType<typeof postgres>>();

export function scopedDb(role: ScopedRole, urlEnv: string): ScopedDb {
  const url = env(urlEnv);
  if (!new URL(url).username.startsWith(role)) throw new Error(`${urlEnv} must connect as ${role}`);
  let sql = pools.get(role);
  if (!sql) {
    sql = postgres(url, { max: 2, prepare: false, idle_timeout: 20, connect_timeout: 5, ssl: "require" });
    pools.set(role, sql);
  }
  const conn = sql;
  const run = async (fn: string, args: [ArgType, unknown][], setReturning: boolean) => {
    assertAllowed(role, fn);
    // deno-lint-ignore no-explicit-any
    return await conn.unsafe(callSql(fn, args, setReturning), args.map(([, v]) => (v === null || v === undefined ? null : v)) as any[]);
  };
  return {
    role,
    async call<T>(fn: string, args: [ArgType, unknown][]) { return (await run(fn, args, false))[0]?.r as T; },
    async rows<T>(fn: string, args: [ArgType, unknown][]) { return (await run(fn, args, true)) as unknown as T[]; },
  };
}

/** Validates the caller's Supabase JWT with the Auth server and returns a user-scoped RPC client. */
export async function authenticatedUser(req: Request): Promise<{ userId: string; userRpc: UserRpc } | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = /^Bearer (.+)$/.exec(auth)?.[1];
  if (!token) return null;
  const client = createClient(env(ENV.supabaseUrl), env(ENV.supabaseAnonKey), {
    global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return {
    userId: data.user.id,
    userRpc: async (fn, args) => {
      const r = await client.rpc(fn, args);
      return { data: r.data, error: r.error ? { message: r.error.message, details: r.error.details ?? null } : null };
    },
  };
}

export const log = (line: string) => console.log(line);
