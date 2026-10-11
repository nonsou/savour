import { describe, expect, it } from "vitest";
import { entityInWorkspace, type GuardClient } from "@/lib/workspace-guard";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";

// Stub of the caller's RLS-scoped client: returns the row's business, or nothing when RLS hides it.
const client = (row: { workspace_id: string } | null, error: unknown = null): GuardClient & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    from: (table) => ({ select: (cols) => ({ eq: (col, value) => ({ maybeSingle: async () => {
      calls.push(`${table}.${cols} ${col}=${value}`);
      return { data: row, error };
    } }) }) }),
  };
};

describe("route/form business context", () => {
  it("allows an entity of the business in the route", async () => {
    const c = client({ workspace_id: A });
    expect(await entityInWorkspace(c, "actions", ITEM, A)).toBe(true);
    expect(c.calls).toEqual([`actions.workspace_id id=${ITEM}`]);
  });

  it("refuses an entity of another business the user also belongs to", async () => {
    expect(await entityInWorkspace(client({ workspace_id: B }), "findings", ITEM, A)).toBe(false);
  });

  it("refuses hidden rows, errors and malformed IDs without querying", async () => {
    expect(await entityInWorkspace(client(null), "sessions", ITEM, A)).toBe(false);
    expect(await entityInWorkspace(client({ workspace_id: A }, { message: "x" }), "sessions", ITEM, A)).toBe(false);
    const c = client({ workspace_id: A });
    expect(await entityInWorkspace(c, "sessions", "not-a-uuid", A)).toBe(false);
    expect(await entityInWorkspace(c, "sessions", ITEM, "nope")).toBe(false);
    expect(c.calls).toEqual([]);
  });
});
