"use client";

import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/errors";
import { Status, SubmitButton } from "./forms";

// Creates an invitation and reveals the single-use link once, with a copy button.
export function InviteLinkForm({ action, children }: {
  action: (s: ActionState, f: FormData) => Promise<ActionState>; children: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, null);
  const [copied, setCopied] = useState(false);
  const link = state?.data?.link as string | undefined;
  return (
    <form action={formAction}>
      {children}
      <SubmitButton pendingText="Creating…">Create invitation link</SubmitButton>
      <Status state={state} />
      {link && (
        <div className="notice ok stack">
          <label htmlFor="invite-link">Invitation link (single use, bound to that email)</label>
          <input id="invite-link" className="mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn" onClick={async () => {
            try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setCopied(false); }
          }}>{copied ? "Copied" : "Copy link"}</button>
          <p className="small">Expires {new Date(String(state?.data?.expires_at)).toUTCString()}. Send it privately; the recipient must sign in with the invited email.</p>
        </div>
      )}
    </form>
  );
}
