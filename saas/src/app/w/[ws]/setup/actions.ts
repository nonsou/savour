"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { mapImport, type ImportPlan, type ImportReceipt } from "@/lib/csv-import";
import { friendlyError, type ActionState } from "@/lib/errors";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const idOrNull = (f: FormData) => s(f, "id") || null;
const versionOrNull = (f: FormData) => (s(f, "version") === "" ? null : Number(s(f, "version")));

export async function saveLocation(_: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const ws = s(form, "ws");
  const { error } = await supabase.rpc("upsert_location", {
    p_ws: ws, p_id: idOrNull(form), p_name: s(form, "name"), p_archived: form.get("archived") === "on",
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/w/${ws}`, "layout");
  return { ok: "Location saved." };
}

export async function saveCategory(_: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const ws = s(form, "ws");
  const { error } = await supabase.rpc("save_category", {
    p_ws: ws, p_id: idOrNull(form), p_name: s(form, "name"), p_archived: form.get("archived") === "on",
    p_expected_version: versionOrNull(form),
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/w/${ws}`, "layout");
  return { ok: "Category saved." };
}

// Subjects are saved through save_subject (directory lock + optimistic version). Location links
// are advisory (they help build rosters); they never limit who may assess the subject.
export async function saveSubject(_: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const ws = s(form, "ws");
  const { error } = await supabase.rpc("save_subject", {
    p_ws: ws, p_id: idOrNull(form), p_name: s(form, "name"), p_type: s(form, "subject_type"),
    p_category: s(form, "category") || null, p_external_id: s(form, "external_id") || null,
    p_location_ids: form.getAll("locations").map(String).filter(Boolean), p_archived: form.get("archived") === "on",
    p_expected_version: versionOrNull(form),
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/w/${ws}`, "layout");
  return { ok: "Subject saved." };
}

export async function saveContact(_: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const ws = s(form, "ws");
  const { data, error } = await supabase.rpc("save_subject_contact", {
    p_ws: ws, p_subject: s(form, "subject"), p_name: s(form, "contact_name") || null,
    p_phone: s(form, "contact_phone") || null, p_email: s(form, "contact_email") || null,
    p_expected_version: versionOrNull(form),
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/w/${ws}`, "layout");
  return { ok: data === 0 ? "Contact removed." : "Contact saved." };
}

// CSV import. The file text is parsed here and every row is validated again by the database;
// preview writes nothing. Commit re-plans inside the directory lock and refuses a plan that
// differs from the one shown (stale_preview). The same key + same file returns the original
// receipt, so a retry after a lost response cannot import twice.
export type PreviewResult = { ok: true; plan: ImportPlan; skippedBlank: number } | { ok: false; error: string };
export type CommitResult = { ok: true; receipt: ImportReceipt } | { ok: false; error: string; code?: string };

export async function previewImport(ws: string, text: string): Promise<PreviewResult> {
  const { supabase } = await requireUser();
  const mapped = mapImport(text);
  if (!mapped.ok) return { ok: false, error: mapped.error };
  const { data, error } = await supabase.rpc("preview_subject_import", { p_ws: ws, p_rows: mapped.rows });
  if (error) return { ok: false, error: friendlyError(error) };
  return { ok: true, plan: data as ImportPlan, skippedBlank: mapped.skippedBlank };
}

export async function commitImport(ws: string, text: string, key: string, planHash: string): Promise<CommitResult> {
  const { supabase } = await requireUser();
  const mapped = mapImport(text);
  if (!mapped.ok) return { ok: false, error: mapped.error };
  const { data, error } = await supabase.rpc("commit_subject_import", {
    p_ws: ws, p_idempotency_key: key, p_rows: mapped.rows, p_expected_plan_hash: planHash,
  });
  if (error) return { ok: false, error: friendlyError(error), code: error.message };
  revalidatePath(`/w/${ws}`, "layout");
  return { ok: true, receipt: data as ImportReceipt };
}
