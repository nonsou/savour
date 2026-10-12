"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

/**
 * Delay before automatic check number `attempt`, or null once automatic checks stop. Every 5 s for the
 * first minute, then every 15 s up to 4 minutes in total: confirmation can need two runs of the
 * once-a-minute billing worker, and the window stays bounded so an abandoned tab does not poll forever.
 */
export function nextCheckDelay(attempt: number): number | null {
  if (attempt < 12) return 5_000;
  if (attempt < 24) return 15_000;
  return null;
}

/** Re-reads the server-verified billing state on a bounded schedule. Never trusts the redirect. */
export function RefreshPoller({ active }: { active: boolean }) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [wasActive, setWasActive] = useState(active);
  const [checking, startCheck] = useTransition();
  // A checkout that becomes pending again gets a fresh window.
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setAttempt(0);
  }
  const delay = active ? nextCheckDelay(attempt) : null;
  useEffect(() => {
    if (delay === null) return;
    const id = setTimeout(() => { router.refresh(); setAttempt((a) => a + 1); }, delay);
    return () => clearTimeout(id);
  }, [attempt, delay, router]);
  if (!active) return null;
  if (delay !== null) return <p className="small muted" aria-live="polite">Checking with Bachs… this page updates on its own.</p>;
  const checkAgain = () => startCheck(() => { router.refresh(); setAttempt(0); });
  return (
    <div className="stack">
      <p className="small muted" aria-live="polite">
        {checking ? "Checking with Bachs…" : "Bachs has not confirmed the payment yet. Confirmation can take a few minutes. You can check again or leave this page; access updates once SAVOUR verifies the payment."}
      </p>
      <p><button type="button" className="btn" onClick={checkAgain} disabled={checking}>Check again</button></p>
    </div>
  );
}
