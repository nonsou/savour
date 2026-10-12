// Sol's independent counterexamples: credential overlap and asynchronous operator authorization.
// Disposable values and embedded PostgreSQL only; no provider credentials or cloud changes.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
const ADMIN = "eeeeeeee-5555-4000-8000-000000000001";
async function fixture() {
  const root = join(import.meta.dirname, "..", "..");
  const db = new PGlite();
  await db.exec(readFileSync(join(root, "tests/sql/supabase-stub.sql"), "utf8"));
  for (const f of readdirSync(join(root, "supabase/migrations")).filter(f => f.endsWith(".sql")).sort())
    await db.exec(readFileSync(join(root, "supabase/migrations", f), "utf8"));
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [ADMIN, "sol-m4-rotation@savour.test"]);
  await db.query("insert into platform.admins(user_id,note) values($1,'Disposable independent admin fixture')", [ADMIN]);
  async function asAdmin() {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({sub:ADMIN,role:"authenticated",aal:"aal2"})]);
    await db.exec("set role authenticated");
  }
  await asAdmin();
  const conn = (await db.query<{v:string}>("select public.platform_create_connection('bachs','Sol rotation fixture') as v")).rows[0].v;
  async function version() {
    return (await db.query<{v:number}>("select (x->>'version')::int as v from jsonb_array_elements(public.platform_overview()->'connections') x where x->>'id'=$1", [conn])).rows[0].v;
  }
  async function store(kind:string, secret:string) {
    return db.query("select public.platform_store_secret($1,$2,$3,$4)", [conn,kind,secret,await version()]);
  }
  async function startTest() {
    return (await db.query<{v:string}>("select public.platform_begin_test($1) as v", [conn])).rows[0].v;
  }
  async function finishTest(test:string) {
    await db.exec("reset role; set role billing_gateway");
    try {
      return (await db.query<{v:string}>("select platform.gateway_record_test($1,$2,true,true,'{\"account\":\"ok\"}'::jsonb,'[]'::jsonb) as v", [test,ADMIN])).rows[0].v;
    } finally { await db.exec("reset role"); }
  }
  return {db,conn,asAdmin,version,store,startTest,finishTest};
}

it("retains a webhook secret across its retry overlap even after a rapid third rotation", async () => {
  const f = await fixture();
  const a = "whsec_TESTONLYsol_rotation_A00001";
  try {
    await f.store("webhook_secret",a);
    await f.store("webhook_secret","whsec_TESTONLYsol_rotation_B00002");
    try { await f.store("webhook_secret","whsec_TESTONLYsol_rotation_C00003"); } catch { /* refusing overlap is allowed */ }
    await f.db.exec("reset role");
    const secrets = (await f.db.query<{decrypted_secret:string}>("select decrypted_secret from vault.decrypted_secrets")).rows;
    expect(secrets.map(x=>x.decrypted_secret)).toContain(a);
  } finally { await f.db.close(); }
},120_000);

it("does not certify a different organization with a previously started connection test", async () => {
  const f = await fixture();
  try {
    await f.store("api_key","sk_sandbox_TESTONLYsol_admin_key00001");
    await f.db.query("select public.platform_set_expected_org($1,'acct_sol_A',$2)",[f.conn,await f.version()]);
    const test = await f.startTest();
    await f.db.exec("reset role; set role billing_gateway");
    await f.db.query("select platform.gateway_test_context($1,$2)",[test,ADMIN]);
    await f.asAdmin();
    await f.db.query("select public.platform_set_expected_org($1,'acct_sol_B',$2)",[f.conn,await f.version()]);
    let outcome = "";
    try { outcome = await f.finishTest(test); } catch { /* stale test rejection is allowed */ }
    expect(outcome).not.toBe("passed");
    await f.db.exec("reset role");
    expect((await f.db.query<{certified:boolean}>("select last_test_passed_at is not null as certified from platform.provider_connections where id=$1",[f.conn])).rows[0].certified).toBe(false);
  } finally { await f.db.close(); }
},120_000);

it("does not finish an operator test after that operator has been revoked", async () => {
  const f = await fixture();
  try {
    await f.store("api_key","sk_sandbox_TESTONLYsol_admin_key00001");
    await f.db.query("select public.platform_set_expected_org($1,'acct_sol_A',$2)",[f.conn,await f.version()]);
    const test = await f.startTest();
    await f.db.exec("reset role; set role billing_gateway");
    await f.db.query("select platform.gateway_test_context($1,$2)",[test,ADMIN]);
    await f.db.exec("reset role");
    await f.db.query("update platform.admins set revoked_at=now() where user_id=$1",[ADMIN]);
    let outcome = "";
    try { outcome = await f.finishTest(test); } catch { /* revoked operator rejection is allowed */ }
    expect(outcome).not.toBe("passed");
    await f.db.exec("reset role");
    expect((await f.db.query<{certified:boolean}>("select last_test_passed_at is not null as certified from platform.provider_connections where id=$1",[f.conn])).rows[0].certified).toBe(false);
  } finally { await f.db.close(); }
},120_000);
