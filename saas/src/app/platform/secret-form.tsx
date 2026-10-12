"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { friendlyError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/client";

async function errorText(error: unknown, fallback: string) {
  let body: { error?: string; retry_after?: string } = {};
  try { body = await (error as { context?: Response })?.context?.json(); } catch { body = {}; }
  return body?.error ? friendlyError({ message: body.error, details: body.retry_after ?? null }) : fallback;
}

// Write-only credential entry. The value goes from this browser directly to the platform-credentials
// Edge function with your Supabase session; it never passes through the SAVOUR web server, is never
// shown again, and only a fingerprint comes back. Two-step verification (aal2) is required.
export function SecretForm({ connectionId, version, kind, nextRotationAfter, stored = false }: { connectionId: string; version: number; kind: "api_key" | "webhook_secret";
  nextRotationAfter: string | null; stored?: boolean }) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem("secret") as HTMLInputElement;
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.functions.invoke("platform-credentials", {
      body: { connection_id: connectionId, kind, secret: input.value, expected_version: version } });
    input.value = "";
    setBusy(false);
    if (error || !data?.fingerprint) {
      setMsg({ kind: "error", text: await errorText(error, "Not stored. Check the value format and try again.") });
      return;
    }
    const what = kind === "api_key" ? "API key" : "Webhook signing secret";
    setMsg({ kind: "ok", text: `${what} stored securely. Fingerprint ${data.fingerprint}.${data.pending_test ? " Awaiting verification: run the connection test to activate it." : ""}` });
    router.refresh();
  }
  const hasStored = stored || msg?.kind === "ok";
  const label = kind === "api_key" ? "Sandbox API key (sk_sandbox_…)" : "Webhook signing secret";
  return (
    <form onSubmit={submit} className="stack" autoComplete="off">
      <div className="field">
        <label htmlFor={`${connectionId}-${kind}`}>{label}</label>
        <input id={`${connectionId}-${kind}`} name="secret" type="password" required minLength={16} maxLength={512} autoComplete="off" spellCheck={false}
          placeholder={hasStored ? "Stored securely. Enter a new value only to replace it." : undefined} />
        <p className="hint">{hasStored && <strong>Stored securely. The saved value stays hidden. </strong>}Write-only. Stored in Supabase Vault; never displayed again. Live keys are refused.
          {kind === "api_key" ? " The previous key is kept for 25 hours after a new key passes its test." : " The previous secret stays valid for 26 hours so Bachs retries and resends still verify."}
          {nextRotationAfter ? ` Next rotation possible after ${nextRotationAfter}.` : ""}</p>
      </div>
      <button className="btn" type="submit" disabled={busy} aria-busy={busy}>{busy ? "Storing…" : `${hasStored ? "Replace" : "Store"} ${kind === "api_key" ? "API key" : "webhook secret"}`}</button>
      <div aria-live="polite" role="status">{msg && <p className={`notice ${msg.kind}`}>{msg.text}</p>}</div>
    </form>
  );
}

export function TestButton({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.functions.invoke("platform-provider-test", { body: { connection_id: connectionId } });
    setBusy(false);
    if (error) { setMsg(await errorText(error, "Test could not run. Try again.")); return; }
    setMsg(`Test ${data?.outcome ?? "unknown"}: ${Object.entries(data?.checks ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
    router.refresh();
  }
  return (
    <div className="stack">
      <button className="btn" type="button" onClick={run} disabled={busy} aria-busy={busy}>{busy ? "Testing…" : "Run read-only connection test"}</button>
      <p className="hint">Checks the key, the expected account, that adaptive (FX) pricing is off, and each proposed product. It does not prove subscriptions, renewals or webhooks work.</p>
      <div aria-live="polite" role="status">{msg && <p className="notice">{msg}</p>}</div>
    </div>
  );
}
