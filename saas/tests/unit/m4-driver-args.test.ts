import { describe, expect, it } from "vitest";
import { toDriverArgs } from "../../supabase/functions/_shared/db.ts";

describe("Postgres driver JSON binding", () => {
  it("preserves JSON text exactly for explicit text binding, including large integers and JSON null", () => {
    for (const json of ['{"amount":9007199254740993}', '{"account":"ok"}', '["a",false]', '"value"', 'false', '7', 'null']) {
      const values = toDriverArgs([["jsonb", json]], value => ({ text: value, oid: 25 }));
      expect(values).toEqual([{ text: json, oid: 25 }]);
    }
  });
  it("rejects malformed JSON without echoing input or invoking the parameter binder", () => {
    let calls = 0;
    expect(() => toDriverArgs([["jsonb", "invalid secret input"]], value => { calls++; return value; })).toThrow("invalid_json_argument");
    expect(calls).toBe(0);
    expect(() => toDriverArgs([["jsonb", {}]], value => value)).toThrow("invalid_json_argument");
  });
  it("keeps SQL null and non-JSON types intact", () => {
    const array = ["a", "b,c"];
    expect(toDriverArgs([["jsonb", null], ["uuid", undefined], ["text", '{"a":1}'], ["boolean", false], ["text[]", array], ["bigint", "9007199254740993"], ["bytea_hex", "deadbeef"]], value => ({ text: value })))
      .toEqual([null, null, '{"a":1}', false, array, "9007199254740993", "deadbeef"]);
  });
});
