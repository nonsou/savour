// Independent regression for four writer gaps reproduced before the M4 repair.
// Embedded PostgreSQL assertions; real contention is verified separately.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("preserves an expired workspace while denying directory creation and edits", async () => {
  const root = join(import.meta.dirname, "..", "..");
  const db = new PGlite();
  try {
    await db.exec(readFileSync(join(root, "tests/sql/supabase-stub.sql"), "utf8"));
    const dir = join(root, "supabase/migrations");
    const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
    const boundary = "20261011171453";
    for (const f of files.filter(f => f < boundary)) await db.exec(readFileSync(join(dir, f), "utf8"));
    const uid = "eeeeeeee-4444-4000-8000-000000000001";
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [uid, "sol-m4-readonly@savour.test"]);
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({sub:uid,role:"authenticated",aal:"aal1"})]);
    await db.exec("set role authenticated");
    const ws = (await db.query<{v:string}>("select public.create_workspace('Sol expired trial fixture','Nigeria','Africa/Lagos','Sol fixture') as v")).rows[0].v;
    const subject = (await db.query<{v:string}>("select public.upsert_subject($1,null,'Existing fixture vendor','vendor',false) as v", [ws])).rows[0].v;
    const location = (await db.query<{v:string}>("select public.upsert_location($1,null,'Existing fixture location',false) as v", [ws])).rows[0].v;
    await db.exec("reset role");
    await db.query("update public.workspaces set created_at=now()-interval '15 days' where id=$1", [ws]);
    for (const f of files.filter(f => f >= boundary)) await db.exec(readFileSync(join(dir, f), "utf8"));
    await db.exec("set role authenticated");
    const context = (await db.query<{v:{access:{state:string}}}>("select public.workspace_context($1) as v", [ws])).rows[0].v;
    expect(context.access.state).toBe("read_only");
    const writers: [string, unknown[]][] = [
      ["select public.save_category($1,null,'New category after expiry',false,null)", [ws]],
      ["select public.save_subject_contact($1,$2,'New contact after expiry',null,null,0)", [ws,subject]],
      ["select public.upsert_subject($1,$2,'Renamed after expiry','vendor',false)", [ws,subject]],
      ["select public.upsert_location($1,$2,'Renamed after expiry',false)", [ws,location]],
    ];
    for (const [sql, args] of writers) await expect(db.query(sql, args)).rejects.toThrow(/read_only/);
    await db.exec("reset role");
    expect((await db.query<{name:string}>("select name from public.subjects where id=$1", [subject])).rows[0].name).toBe("Existing fixture vendor");
    expect((await db.query<{name:string}>("select name from public.locations where id=$1", [location])).rows[0].name).toBe("Existing fixture location");
    expect((await db.query<{n:number}>("select count(*)::int as n from public.categories where workspace_id=$1", [ws])).rows[0].n).toBe(0);
    expect((await db.query<{n:number}>("select count(*)::int as n from public.subject_contacts where workspace_id=$1", [ws])).rows[0].n).toBe(0);
  } finally { await db.close(); }
}, 120_000);
