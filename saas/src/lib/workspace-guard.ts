// Route/form business context. The database authorizes every entity on its own, but a person who
// belongs to two businesses could open or post an ID from business B under business A's URL and
// header. Before showing or changing an entity, check it belongs to the business in the route.
// Reads go through the caller's own client (RLS), and workspace_id never changes after creation
// (keep_workspace triggers), so the check cannot race with the write that follows.
import { isUuid } from "./auth";

export type GuardTable = "sessions" | "findings" | "actions";

interface Query {
  select(columns: string): { eq(column: string, value: string): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> } };
}
export interface GuardClient { from(table: GuardTable): Query }

export async function entityInWorkspace(client: GuardClient, table: GuardTable, id: string, ws: string): Promise<boolean> {
  if (!isUuid(id) || !isUuid(ws)) return false;
  const { data, error } = await client.from(table).select("workspace_id").eq("id", id).maybeSingle();
  return !error && (data as { workspace_id?: string } | null)?.workspace_id === ws;
}

export const WRONG_BUSINESS = "This item is not part of this business, or you no longer have access to it. Nothing was changed. Reload the page.";
