"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Re-reads the server-verified billing state every 5 s for up to 60 s. Never trusts the redirect. */
export function RefreshPoller({ active }: { active: boolean }) {
  const router = useRouter();
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    if (!active || ticks >= 12) return;
    const id = setTimeout(() => { router.refresh(); setTicks((t) => t + 1); }, 5000);
    return () => clearTimeout(id);
  }, [active, ticks, router]);
  if (!active) return null;
  return <p className="small muted" aria-live="polite">{ticks < 12 ? "Checking with Bachs… this page updates on its own." : "Still confirming. You can leave this page; the status updates when Bachs confirms the payment."}</p>;
}
