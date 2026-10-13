"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Status, SubmitButton } from "@/components/forms";
import { DAILY_LIMIT, VERIFICATION_FROM, VERIFICATION_TO } from "@/lib/alert-email";
import { sendVerificationEmail } from "./actions";

// The single manual send. The form carries only the confirmation tick; everything else is fixed on the server.
export function VerificationForm() {
  const [state, formAction] = useActionState(sendVerificationEmail, null);
  return (
    <form action={formAction} className="stack">
      <ul className="small" style={{ overflowWrap: "anywhere" }}>
        <li>To: <strong>{VERIFICATION_TO}</strong> (fixed)</li>
        <li>From: <strong>{VERIFICATION_FROM}</strong> (fixed)</li>
        <li>Limit: {DAILY_LIMIT} attempt per UTC day, no retries. A failed or unclear attempt still uses the day.</li>
      </ul>
      <label className="check">
        <input type="checkbox" name="confirm" required />
        Send one verification email now. I understand it is a test, not an alert, and uses today&apos;s only attempt.
      </label>
      <div><SubmitButton pendingText="Sending…">Send verification email</SubmitButton></div>
      <Status state={state} />
      {state?.data?.mfa === true && (
        <p><Link className="btn" href="/platform#mfa">Go to two-step verification</Link></p>
      )}
    </form>
  );
}
