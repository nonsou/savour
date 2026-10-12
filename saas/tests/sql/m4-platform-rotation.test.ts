// Credential overlap and asynchronous connection-test validity (embedded Postgres, disposable values,
// Vault stand-in). Complements Sol's independent counterexamples in sol-platform-invariants.test.ts.
// "fixture time travel" marks owner-side timestamp edits that cannot elapse in a test; it bypasses the
// immutability triggers only with session_replication_role inside this disposable database.
import { describe, expect, it } from "vitest";
import { friendlyError } from "@/lib/errors";
import { storeSecret } from "../../supabase/functions/_shared/platform-core.ts";
import { harness } from "./m4-harness";

const ADMIN = "eeeeeeee-0000-4000-8000-000000004801";
const K = (n: number) => `sk_sandbox_TESTONLYrotation_key0000${n}`;
const W = (n: number) => `whsec_TESTONLYrotation_secret000${n}`;

async function setup() {
  const h = await harness();
  const conn = await h.connection(ADMIN, "Rotation sandbox", K(1), "acct_rot");
  const admin = h.userRpc(ADMIN, "aal2");
  const version = async () => (await h.q<{ version: number }>("select version from platform.provider_connections where id = $1", [conn]))[0].version;
  const store = async (kind: "api_key" | "webhook_secret", secret: string) =>
    admin("platform_store_secret", { p_conn: conn, p_kind: kind, p_secret: secret, p_expected_version: await version() });
  const begin = async () => (await admin("platform_begin_test", { p_conn: conn })).data as string;
  const gw = h.scoped("billing_gateway");
  const record = (test: string, user = ADMIN) => gw.call<string>("platform.gateway_record_test", [["uuid", test], ["uuid", user], ["boolean", true],
    ["boolean", true], ["jsonb", '{"account":"ok"}'], ["jsonb", "[]"]]);
  const vault = async () => (await h.q<{ v: string }>("select decrypted_secret as v from vault.decrypted_secrets order by created_at")).map((r) => r.v);
  const activeKey = async () => (await h.scoped("billing_worker").call<{ api_key: string; credential_version: number }>("platform.get_credential", [["uuid", conn]]));
  const travel = (sql: string) => h.serial(() => h.pg.exec(`set session_replication_role = replica; ${sql}; set session_replication_role = origin`));
  return { h, conn, admin, store, begin, record, vault, activeKey, travel, gw };
}

describe("credential overlap", () => {
  it("keeps the previous API key through its retention window and refuses a second rotation until it ends", async () => {
    const f = await setup();
    try {
      expect((await f.store("api_key", K(2))).error).toBeNull();
      expect(await f.record(await f.begin())).toBe("passed");
      expect(await f.activeKey()).toMatchObject({ api_key: K(2), credential_version: 2 });
      const refused = await f.store("api_key", K(3));
      expect(refused.error?.message).toBe("rotation_overlap_active");
      expect(await f.vault()).toEqual(expect.arrayContaining([K(1), K(2)]));
      expect(await f.vault()).not.toContain(K(3));
      // fixture time travel: the 25-hour retention of key 1 has ended
      await f.travel(`update platform.provider_connections set previous_retire_after = now() - interval '1 minute' where id = '${f.conn}'`);
      expect((await f.store("api_key", K(3))).error).toBeNull();
      expect(await f.vault()).not.toContain(K(1));                         // only the expired previous key is removed
      expect(await f.activeKey()).toMatchObject({ api_key: K(2) });       // the active key keeps serving until K3 passes a test
      expect(await f.record(await f.begin())).toBe("passed");
      expect(await f.activeKey()).toMatchObject({ api_key: K(3), credential_version: 3 });
      expect(await f.vault()).toEqual(expect.arrayContaining([K(2), K(3)]));
    } finally { await f.h.close(); }
  }, 120_000);

  it("keeps the previous webhook secret valid through its overlap, refusing a third rotation until it ends", async () => {
    const f = await setup();
    try {
      const secrets = async () => (await f.h.scoped("billing_intake").call<{ secrets: string[] }>("platform.get_webhook_secrets", [["uuid", f.conn]])).secrets;
      const first = (await secrets())[0];
      expect((await f.store("webhook_secret", W(2))).error).toBeNull();
      expect(await secrets()).toEqual([W(2), first]);
      const refused = await f.store("webhook_secret", W(3));
      expect(refused.error?.message).toBe("rotation_overlap_active");
      expect(await secrets()).toEqual([W(2), first]);
      const logs: string[] = [];
      const viaEdge = await storeSecret({ userRpc: f.admin, log: (l) => logs.push(l) }, { connectionId: f.conn, kind: "webhook_secret", secret: W(3),
        expectedVersion: (await f.h.q<{ version: number }>("select version from platform.provider_connections where id = $1", [f.conn]))[0].version });
      expect(viaEdge.status).toBe(409);
      expect(viaEdge.body).toEqual({ error: "rotation_overlap_active", retry_after: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/) });
      expect(JSON.stringify([viaEdge, logs])).not.toMatch(/whsec_/);
      // fixture time travel: the 26-hour overlap has ended
      await f.travel(`update platform.provider_connections set previous_webhook_valid_until = now() - interval '1 minute' where id = '${f.conn}'`);
      expect(await secrets()).toEqual([W(2)]);
      expect((await f.store("webhook_secret", W(3))).error).toBeNull();
      expect(await secrets()).toEqual([W(3), W(2)]);
      expect(await f.vault()).not.toContain(first);
    } finally { await f.h.close(); }
  }, 120_000);

  it("explains the retry window to the operator", () => {
    const text = friendlyError({ message: "rotation_overlap_active", details: "2026-10-13 09:40 UTC" });
    expect(text).toContain("2026-10-13 09:40 UTC");
    expect(text).toMatch(/still kept|retries/i);
  });
});

describe("asynchronous connection tests certify only what they started with", () => {
  it("a replaced pending key gets a new version, so the older test cannot promote it", async () => {
    const f = await setup();
    try {
      await f.store("api_key", K(2));
      const test = await f.begin();
      await f.store("api_key", K(4));                                    // replaces the untested pending key
      expect(await f.record(test)).toBe("credential_changed");
      expect(await f.activeKey()).toMatchObject({ api_key: K(1), credential_version: 1 });
      const row = (await f.h.q<{ pending_version: number; status: string }>(
        "select c.pending_version, t.status from platform.provider_connections c join platform.connection_tests t on t.connection_id = c.id where t.id = $1", [test]))[0];
      expect(row).toEqual({ pending_version: 3, status: "failed" });
      expect(await f.vault()).not.toContain(K(2));
      expect(await f.record(await f.begin())).toBe("passed");
      expect(await f.activeKey()).toMatchObject({ api_key: K(4), credential_version: 3 });
    } finally { await f.h.close(); }
  }, 120_000);

  it("rejects completion after the price set changed, after expiry, or for a revoked operator; the key is not readable either", async () => {
    const f = await setup();
    try {
      const t1 = await f.begin();
      await f.admin("platform_propose_price", { p_conn: f.conn, p_currency: "USD", p_amount: "29.00", p_product_id: "prod_rot" });
      expect(await f.record(t1)).toBe("prices_changed");
      expect((await f.h.q("select 1 from billing.plan_prices where connection_id = $1 and status = 'configured'", [f.conn])).length).toBe(0);

      const t2 = await f.begin();
      // fixture time travel: the test started 11 minutes ago
      await f.travel(`update platform.connection_tests set started_at = clock_timestamp() - interval '11 minutes' where id = '${t2}'`);
      await expect(f.gw.call("platform.gateway_test_context", [["uuid", t2], ["uuid", ADMIN]])).rejects.toThrow(/test_expired/);
      expect(await f.record(t2)).toBe("test_expired");

      const t3 = await f.begin();
      await f.h.q("update platform.admins set revoked_at = now() where user_id = $1", [ADMIN]);
      await expect(f.gw.call("platform.gateway_test_context", [["uuid", t3], ["uuid", ADMIN]])).rejects.toThrow(/admin_revoked/);
      expect(await f.record(t3)).toBe("admin_revoked");
      const tests = await f.h.q<{ id: string; status: string; checks: { stale?: string } }>("select id::text, status, checks from platform.connection_tests where id = any($1::uuid[])", [[t1, t2, t3]]);
      expect([t1, t2, t3].map((id) => tests.find((t) => t.id === id)!).map((t) => `${t.status}:${t.checks.stale}`)).toEqual(["failed:prices_changed", "failed:test_expired", "failed:admin_revoked"]);
      const audit = await f.h.q<{ after: string }>("select after::text from platform.admin_audit where action = 'connection.test_rejected'");
      expect(audit).toHaveLength(3);
      expect(JSON.stringify(audit)).not.toMatch(/sk_sandbox_|whsec_/);
    } finally { await f.h.close(); }
  }, 120_000);
});
