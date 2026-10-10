"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/errors";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

// Form bound to a server action. Shows the server's result in an accessible live region;
// success is only announced when the server confirms it.
export function ActionForm({ action, children, className, resetOnSuccess = false }: {
  action: Action; children: React.ReactNode; className?: string; resetOnSuccess?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state?.ok && resetOnSuccess) ref.current?.reset(); }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={className}>
      {children}
      <Status state={state} />
    </form>
  );
}

export function Status({ state }: { state: ActionState }) {
  return (
    <div aria-live="polite" role="status">
      {state?.error && <p className="notice error">{state.error}</p>}
      {state?.ok && <p className="notice ok">{state.ok}</p>}
    </div>
  );
}

export function SubmitButton({ children, className = "btn primary", pendingText = "Saving…" }: {
  children: React.ReactNode; className?: string; pendingText?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? pendingText : children}
    </button>
  );
}
