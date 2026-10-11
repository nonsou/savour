// These migrations were applied to savour-dev on 11 October 2026. Repair with a forward migration.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const pins = {
  "20261011144333_m3_actions_inbox.sql": "5751b0341d5516da11a0aaa6b33be2e3cbd10af718e3ab499f69e86744033cce",
  "20261011144335_m3_report_snapshot.sql": "a2f74c6a0229b4c1b71f4b198a795cf08736e4c1d536f7533f3de46a1af3600a",
  "20261011144337_m3_analytics.sql": "efa8733057fbce7594163945c4e05ab7cb84e3b58ee016e9ef130828c0c62267",
};
describe("Sol: applied M3 migrations are sealed", () => {
  for (const [name, hash] of Object.entries(pins)) {
    it(`${name} preserves its applied bytes`, () => {
      expect(createHash("sha256").update(readFileSync(join(import.meta.dirname, "../../supabase/migrations", name))).digest("hex")).toBe(hash);
    });
  }
});
