// The 15 approved development snapshots taken before Milestone 3 (docs/milestone-3/qa-snapshot-baseline.json)
// are pinned on savour-dev by Sol's read-only script. This checks that every baseline row appears in
// that script with the same session, revision, hash and formula, so the two cannot drift. Neither file
// is modified by Milestone 3 code.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const baselineFile = join(root, "..", "docs", "milestone-3", "qa-snapshot-baseline.json");
const pinFile = join(root, "supabase", "tests", "sol_m3_snapshot_pin.sql");

describe.skipIf(!existsSync(baselineFile) || !existsSync(pinFile))("Milestone 3 snapshot baseline", () => {
  it("pins all 15 baseline approvals with matching hash, body hash and formula", () => {
    const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as
      { session_id: string; revision: number; inputs_hash: string; formula_version: string; content_sha256: string }[];
    const pin = readFileSync(pinFile, "utf8");
    expect(baseline).toHaveLength(15);
    for (const b of baseline) {
      expect(pin).toContain(`('${b.session_id}'::uuid, ${b.revision}, '${b.inputs_hash}', '${b.formula_version}', '${b.content_sha256}')`);
      expect(["savour-m1.1", "savour-m2.1"]).toContain(b.formula_version);
    }
    expect(pin).toMatch(/rollback;\s*$/);
    expect(pin).toContain("set transaction read only");
  });
});
