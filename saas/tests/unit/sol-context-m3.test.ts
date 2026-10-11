// Independent boundary check: invoke the real server-action wrappers with a caller whose RLS
// client can see an entity in business B. A form naming business A must never reach a mutation RPC.
import { beforeEach, describe, expect, it, vi } from "vitest";
const A = "eeeeeeee-0000-4000-8000-000000004101";
const B = "eeeeeeee-0000-4000-8000-000000004102";
const ITEM = "eeeeeeee-0000-4000-8000-000000004103";
const state = vi.hoisted(() => ({ workspace: "", rpc: vi.fn(), refresh: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: state.refresh }));
vi.mock("@/lib/auth", () => ({
  isUuid: (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  requireUser: async () => ({ supabase: {
    rpc: state.rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { workspace_id: state.workspace }, error: null }) }) }) }),
  } }),
}));
import { createFinding, withdrawFinding, createAction, updateAction, transitionAction } from "@/app/w/[ws]/actions/commands";
const form = () => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ ws: A, session: ITEM, finding: ITEM, action: ITEM, subject: ITEM,
    command: "verify", version: "3", confirm: "on", idempotency_key: ITEM })) f.set(k, v);
  return f;
};
beforeEach(() => { state.workspace = B; state.rpc.mockReset(); state.refresh.mockReset(); });
describe("Sol: business context at actual mutation entry points", () => {
  for (const [name, command] of Object.entries({ createFinding, withdrawFinding, createAction, updateAction, transitionAction })) {
    it(`${name} refuses a B entity under an A form even when the caller can read both businesses`, async () => {
      expect(await command({}, form())).toHaveProperty("error");
      expect(state.rpc).not.toHaveBeenCalled();
      expect(state.refresh).not.toHaveBeenCalled();
    });
  }
  it("allows matching business context to reach the database's live authorization", async () => {
    state.workspace = A;
    state.rpc.mockResolvedValue({ data: { action_id: ITEM, version: 4 }, error: null });
    expect(await transitionAction({}, form())).toHaveProperty("ok");
    expect(state.rpc).toHaveBeenCalledOnce();
    expect(state.rpc.mock.calls[0][0]).toBe("transition_action");
  });
});
