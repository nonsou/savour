// Exact money conversion, and parity with the database's billing.to_minor (the authoritative check).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { displayMoney, fromMinor, MoneyError, toMinor } from "../../supabase/functions/_shared/money.ts";

const CASES: [string, "NGN" | "USD", string | null][] = [
  ["29.00", "USD", "2900"], ["29", "USD", "2900"], ["29.5", "USD", "2950"], ["0", "USD", "0"], ["0.01", "USD", "1"],
  ["25000.00", "NGN", "2500000"], ["999999999999999", "NGN", null], ["9000000000000.00", "NGN", "900000000000000"],
  ["29.001", "USD", null], ["-1.00", "USD", null], ["1e3", "USD", null], ["01.00", "USD", null], [" 1.00", "USD", null],
  ["1.", "USD", null], [".5", "USD", null], ["1,000.00", "NGN", null], ["", "USD", null], ["9999999999999999", "USD", null],
  ["NaN", "USD", null], ["1.00", "EUR" as "USD", null],
];

describe("exact provider money", () => {
  it("converts decimal strings to minor units without floats and refuses everything else", () => {
    for (const [amount, cur, want] of CASES) {
      if (want === null) expect(() => toMinor(amount, cur), amount).toThrow(MoneyError);
      else expect(toMinor(amount, cur).toString(), amount).toBe(want);
    }
    expect(() => toMinor(29 as unknown as string, "USD")).toThrow(MoneyError);
  });

  it("formats back at currency precision and never mixes currencies", () => {
    expect(fromMinor(2900n, "USD")).toBe("29.00");
    expect(fromMinor(5n, "USD")).toBe("0.05");
    expect(displayMoney(2500000n, "NGN")).toBe("₦25,000.00");
    expect(displayMoney("2900", "USD")).toBe("US$29.00");
    // 0.1 + 0.2 style float errors cannot occur: values stay integers.
    expect(toMinor("0.10", "USD") + toMinor("0.20", "USD")).toBe(toMinor("0.30", "USD"));
  });

  it("agrees with billing.to_minor in the database on every case", async () => {
    const root = join(import.meta.dirname, "..", "..");
    const db = new PGlite();
    await db.exec(readFileSync(join(root, "tests/sql/supabase-stub.sql"), "utf8"));
    for (const f of readdirSync(join(root, "supabase/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
      await db.exec(readFileSync(join(root, "supabase/migrations", f), "utf8"));
    }
    for (const [amount, cur, want] of CASES) {
      let sql: string | null;
      try { sql = (await db.query<{ v: string }>("select billing.to_minor($1, $2)::text as v", [amount, cur])).rows[0].v; } catch { sql = null; }
      expect(sql, amount).toBe(want);
    }
    await db.close();
  }, 60_000);
});
