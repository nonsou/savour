// The cron setup is source only (applied by the operator). It must read the worker URL and token from
// Vault, validate them before scheduling, mark runs as cron, and contain no literal secret.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(import.meta.dirname, "..", "..", "supabase", "cron", "bachs_worker_schedule.sql"), "utf8");
describe("billing worker cron source", () => {
  it("validates extensions and Vault secrets before scheduling, and schedules the four modes", () => {
    expect(sql.indexOf("pg_cron is not enabled")).toBeLessThan(sql.indexOf("cron.schedule("));
    expect(sql).toContain("vault.decrypted_secrets where name = 'savour_billing_worker_token'");
    expect(sql).toContain("length(decrypted_secret) < 32");
    expect(sql).toMatch(/'trigger', 'cron'/);
    for (const job of ["savour-billing-process", "savour-billing-housekeeping", "savour-billing-discover", "savour-billing-reconcile"]) expect(sql).toContain(`cron.schedule('${job}'`);
  });
  it("contains no literal token, key or project URL", () => {
    const executable = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(executable).not.toMatch(/sk_(sandbox|live)_|whsec_|Bearer [A-Za-z0-9]{16,}|https:\/\/[a-z0-9]{10,}\.supabase\.co/);
    expect(executable).not.toMatch(/[A-Fa-f0-9]{32,}/);
  });
});
