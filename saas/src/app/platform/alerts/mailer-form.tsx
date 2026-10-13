"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Status, SubmitButton } from "@/components/forms";
import { disableAutomaticEmail, enableAutomaticEmail } from "./mailer-actions";

// Switch form for automatic email. The form carries only the confirmation tick.
export function MailerForm({ enable }: { enable: boolean }) {
  const [state, formAction] = useActionState(enable ? enableAutomaticEmail : disableAutomaticEmail, null);
  return (
    <form action={formAction} className="stack">
      <label className="check">
        <input type="checkbox" name="confirm" required />
        {enable
          ? "Switch automatic email on. I understand it is development only, goes only to the owner test address, is capped at 5 attempts per UTC day, promises no response time, and accepted does not mean delivered."
          : "Switch automatic email off. Nothing new will be sent until it is switched on again."}
      </label>
      <div><SubmitButton className={enable ? "btn primary" : "btn danger"} pendingText="Saving…">
        {enable ? "Switch automatic email on" : "Switch automatic email off"}</SubmitButton></div>
      <Status state={state} />
      {state?.data?.mfa === true && (
        <p><Link className="btn" href="/platform#mfa">Go to two-step verification</Link></p>
      )}
    </form>
  );
}
