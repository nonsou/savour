"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { safeNext, siteOrigin } from "@/lib/urls";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function signIn(_: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: str(form, "email"), password: String(form.get("password") ?? "") });
  if (error) return { error: error.code === "email_not_confirmed" ? "Confirm your email first (check your inbox)." : "Email or password is incorrect." };
  redirect(safeNext(form.get("next")));
}

export async function signUp(_: ActionState, form: FormData): Promise<ActionState> {
  const password = String(form.get("password") ?? "");
  if (password.length < 10) return { error: "Use a password of at least 10 characters." };
  const supabase = await createClient();
  const next = safeNext(form.get("next"));
  const { data, error } = await supabase.auth.signUp({
    email: str(form, "email"), password,
    options: { emailRedirectTo: `${await siteOrigin()}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error) return { error: error.message || "Could not create the account." };
  if (data.session) redirect(next);
  return { ok: "Check your inbox to confirm your email, then sign in." };
}

export async function sendCode(_: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const next = safeNext(form.get("next"));
  const { error } = await supabase.auth.signInWithOtp({
    email: str(form, "email"),
    options: { emailRedirectTo: `${await siteOrigin()}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error) return { error: error.status === 429 ? "Too many requests. Wait a minute and try again." : "Could not send the email." };
  return { ok: "Email sent. Use the link, or enter the code below if your email shows one." };
}

export async function verifyCode(_: ActionState, form: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ email: str(form, "email"), token: str(form, "token"), type: "email" });
  if (error) return { error: "That code is invalid or expired." };
  redirect(safeNext(form.get("next")));
}
