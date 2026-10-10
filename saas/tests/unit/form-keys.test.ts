import { describe, expect, it } from "vitest";
import { memberAccessKey, savedStateKey } from "@/lib/form-keys";

const member = (role: string, all = false, locs: string[] = ["l1"]) => ({
  role, all_locations: all, membership_locations: locs.map((location_id) => ({ location_id })),
});

describe("saved-state keys remount edit fields when server data changes", () => {
  it("changes when the saved role, all-locations flag or location set changes", () => {
    const base = memberAccessKey(member("assessor"));
    expect(memberAccessKey(member("viewer"))).not.toBe(base);
    expect(memberAccessKey(member("assessor", true))).not.toBe(base);
    expect(memberAccessKey(member("assessor", false, ["l1", "l2"]))).not.toBe(base);
  });

  it("is stable for the same saved data (no remount, typed input is not discarded)", () => {
    expect(memberAccessKey(member("viewer", false, ["l2", "l1"]))).toBe(memberAccessKey(member("viewer", false, ["l1", "l2"])));
    expect(savedStateKey("Main", null)).toBe(savedStateKey("Main", undefined));
  });

  it("does not collide when values contain separators", () => {
    expect(savedStateKey("a|b", "c")).not.toBe(savedStateKey("a", "b|c"));
  });
});
