// Independent reproductions of Sol's draft-review findings. Single-connection structural/state
// regressions; genuine contention is verified separately on savour-dev.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const OWNER = "eeeeeeee-0000-4000-8000-000000003901";
async function fixture(criteria = "[]") {
  const db = new PGlite();
  await db.exec(readFileSync(join(root, "tests/sql/supabase-stub.sql"), "utf8"));
  for (const f of readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(root, "supabase/migrations", f), "utf8"));
  }
  await db.exec(`insert into auth.users (id,email,email_confirmed_at) values ('${OWNER}','sol-action-fixture@savour.test',now());
    select set_config('request.jwt.claims','{"sub":"${OWNER}","role":"authenticated"}',false); set role authenticated;`);
  const id = async (sql: string, params: unknown[] = []) => (await db.query<{ id: string }>(sql + " as id", params)).rows[0].id;
  const ws = await id("select public.create_workspace('Sol action regression','Nigeria','Africa/Lagos','QA Owner')");
  const location = await id("select public.upsert_location($1,null,'Main',false)", [ws]);
  const subject = await id("select public.upsert_subject($1,null,'QA Subject','vendor',false)", [ws]);
  const tv = await id("select public.publish_template($1,null,'QA Template','food_vendors','scored',$2::jsonb)", [ws, criteria]);
  const session = await id("select public.create_session($1,$2,$3,'QA action inspection',(now() at time zone 'Africa/Lagos')::date,$4::uuid[],$5::uuid[],$5::uuid[],24,'09:00'::time)",
    [ws, location, tv, [subject], [OWNER]]);
  const findingArgs = [session, subject, "high", "Cleaning issue", "Recorded observation", null, randomUUID()];
  const createFinding = "select public.create_finding($1,$2,$3,$4,$5,$6,$7) as r";
  const finding = (await db.query<{ r: { finding_id: string; version: number } }>(createFinding, findingArgs)).rows[0].r;
  const action = (await db.query<{ r: { action_id: string } }>(
    "select public.create_action($1,'Cleaning issue','Clean preparation bench','high',$2,(now() at time zone 'Africa/Lagos')::date,$3) as r",
    [finding.finding_id, OWNER, randomUUID()])).rows[0].r.action_id;
  const transition = async (command: string, version: number, evidence: string | null = null, reason: string | null = null) =>
    (await db.query<{ r: { version: number; status: string } }>("select public.transition_action($1,$2,$3,$4,$5,$6) as r",
      [action, command, version, evidence, reason, randomUUID()])).rows[0].r;
  const getAction = async () => (await db.query<{ r: { action: { version: number; status: string; action_required: string; resolution_evidence: string | null } } }>(
    "select public.get_action($1) as r", [action])).rows[0].r.action;
  return { db, ws, location, subject, tv, session, action, finding, findingArgs, createFinding, transition, getAction };
}

describe("Sol: resolution evidence cannot verify different work", () => {
  it("requires return/evidence renewal before substantive ready-action changes can be verified", async () => {
    const f = await fixture();
    try {
      await f.transition("start", 1);
      await f.transition("submit", 2, "Bench cleaned and inspected.");
      let blocked = false;
      try {
        await f.db.query("select public.update_action($1,3,null,'Repair broken refrigerator',null,null,null,'Different required work',$2)", [f.action, randomUUID()]);
      } catch (e) {
        expect(String(e)).toMatch(/invalid_state|return_required|resolution_change|ready_action/);
        blocked = true;
      }
      const after = await f.getAction();
      if (blocked) expect(after).toMatchObject({ status: "ready_for_verification", action_required: "Clean preparation bench", resolution_evidence: "Bench cleaned and inspected." });
      else expect(after).toMatchObject({ status: "in_progress", action_required: "Repair broken refrigerator", resolution_evidence: null });
    } finally { await f.db.close(); }
  }, 120_000);
});

describe("Sol: reminder time and finding replay integrity", () => {
  it("makes a due-today entry stale after the workspace-local date has advanced", async () => {
    const f = await fixture();
    try {
      await f.db.exec("reset role");
      // Establish an actual yesterday deadline and stored due-today reminder. All data is local.
      await f.db.query("update public.actions set due_date=(clock_timestamp() at time zone 'Africa/Lagos')::date - 1 where id=$1", [f.action]);
      await f.db.query("insert into public.notifications(workspace_id,recipient_id,kind,action_id,dedupe_key,meta,created_at) select workspace_id,assignee_id,'action_due_today',id,'old-due-today',jsonb_build_object('due_date',due_date),clock_timestamp()-interval '1 day' from public.actions where id=$1", [f.action]);
      await f.db.exec("set role authenticated");
      const inbox = (await f.db.query<{ r: { items: { kind: string; stale: boolean; body: string | null; link: string | null }[] } }>("select public.get_inbox($1) as r", [f.ws])).rows[0].r;
      expect(inbox.items.find((n) => n.kind === "action_due_today")).toMatchObject({ stale: true, body: null, link: null });
      expect(inbox.items.find((n) => n.kind === "action_overdue")).toMatchObject({ stale: false });
    } finally { await f.db.close(); }
  }, 120_000);

  it("replays the original create-finding receipt after a later withdrawal", async () => {
    const f = await fixture();
    try {
      await f.transition("cancel", 1, null, "Disposable action cancelled before finding withdrawal");
      await f.db.query("select public.withdraw_finding($1,'Withdrawn with reason',1)", [f.finding.finding_id]);
      const replay = (await f.db.query<{ r: { finding_id: string; version: number; replayed: boolean } }>(f.createFinding, f.findingArgs)).rows[0].r;
      expect(replay).toMatchObject({ finding_id: f.finding.finding_id, version: 1, replayed: true });
    } finally { await f.db.close(); }
  }, 120_000);
});

describe("Sol: repeat evidence links respect live location scope", () => {
  it("does not expose a prior inspection ID to a Viewer who cannot read that location", async () => {
    const f = await fixture('[{"key":"taste","label":"Taste","critical":true}]');
    const VIEWER = "eeeeeeee-0000-4000-8000-000000003902";
    try {
      const approve = async (session: string) => {
        await f.db.query("select public.submit_assessment($1,$2,$3,'early','{\"taste\":2}'::jsonb,null,0,$4,null)", [session, f.subject, OWNER, randomUUID()]);
        await f.db.query("select public.resolve_outcome($1,$2,'early','Observed readiness',1)", [session, f.subject]);
        await f.db.query("select public.approve_session($1,(select data_version from public.sessions where id=$1))", [session]);
      };
      await approve(f.session);
      // M4 fixture: a second location exceeds the trial limit; the database owner lifts it for this
      // disposable workspace only (billing.fixture_uncap_trial, owner-only and audited).
      await f.db.exec(`reset role; select set_config('savour.fixture_mode', 'disposable', false);
        select billing.fixture_uncap_trial('${f.ws}'); set role authenticated;`);
      const location = (await f.db.query<{ id: string }>("select public.upsert_location($1,null,'Viewer location',false) as id", [f.ws])).rows[0].id;
      const current = (await f.db.query<{ id: string }>("select public.create_session($1,$2,$3,'Current inspection',(now() at time zone 'Africa/Lagos')::date,$4::uuid[],$5::uuid[],$5::uuid[],24,'09:00'::time) as id",
        [f.ws, location, f.tv, [f.subject], [OWNER]])).rows[0].id;
      await approve(current);
      const ownerEnvelope = (await f.db.query<{ r: unknown }>("select public.get_session_report($1,null,false,'view') as r", [current])).rows[0].r;
      expect(JSON.stringify(ownerEnvelope)).toContain(f.session); // real generated repeat evidence exists
      await f.db.exec("reset role");
      await f.db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'sol-scoped-viewer@savour.test',now())", [VIEWER]);
      await f.db.query("insert into public.memberships(workspace_id,user_id,role,display_name,email,all_locations) values($1,$2,'viewer','Scoped Viewer','sol-scoped-viewer@savour.test',false)", [f.ws, VIEWER]);
      await f.db.query("insert into public.membership_locations(workspace_id,membership_id,location_id) select workspace_id,id,$3 from public.memberships where workspace_id=$1 and user_id=$2", [f.ws, VIEWER, location]);
      await f.db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: VIEWER, role: "authenticated" })]);
      await f.db.exec("set role authenticated");
      await expect(f.db.query("select public.get_session_report($1,null,false,'view')", [f.session])).rejects.toThrow(/forbidden/);
      const envelope = (await f.db.query<{ r: unknown }>("select public.get_session_report($1,null,false,'view') as r", [current])).rows[0].r;
      expect(JSON.stringify(envelope)).not.toContain(f.session);
      const analysis = (await f.db.query<{ r: unknown }>("select public.get_analytics($1,'approved','{}'::jsonb,'view') as r", [f.ws])).rows[0].r;
      expect(JSON.stringify(analysis)).not.toContain(f.session);

      // The linked finding is also exposed to its Assessor through action detail and direct table
      // SELECT. Those surfaces must not bypass the same source restriction.
      await f.db.exec("reset role");
      await f.db.query("update public.memberships set role='assessor' where workspace_id=$1 and user_id=$2", [f.ws, VIEWER]);
      await f.db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: OWNER, role: "authenticated" })]);
      await f.db.exec("set role authenticated");
      const generated = (ownerEnvelope as { inputs: { findings: { kind: string; finding_id: string }[] } }).inputs.findings.find((x) => x.kind === "generated")!.finding_id;
      const assigned = (await f.db.query<{ r: { action_id: string } }>(
        "select public.create_action($1,'Critical observation','Resolve critical observation','critical',$2,(now() at time zone 'Africa/Lagos')::date,$3) as r",
        [generated, VIEWER, randomUUID()])).rows[0].r.action_id;
      await f.db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: VIEWER, role: "authenticated" })]);
      const detail = (await f.db.query<{ r: unknown }>("select public.get_action($1) as r", [assigned])).rows[0].r;
      expect(JSON.stringify(detail)).not.toContain(f.session);
      let rawRows: unknown[] = [];
      try {
        rawRows = (await f.db.query("select detail from public.findings where id=$1", [generated])).rows;
      } catch (e) {
        expect(String(e)).toMatch(/permission denied/);
      }
      expect(JSON.stringify(rawRows)).not.toContain(f.session);
    } finally { await f.db.close(); }
  }, 120_000);
});
