"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export interface Factor { id: string; friendly_name?: string; status: string }

export function MfaPanel({ initialFactors, initialAal }: { initialFactors: Factor[]; initialAal: string | null }) {
  const [supabase] = useState(() => createClient());
  const [factors, setFactors] = useState<Factor[]>(initialFactors);
  const [aal, setAal] = useState<string | null>(initialAal);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function refresh() {
    const [f, a] = await Promise.all([supabase.auth.mfa.listFactors(), supabase.auth.mfa.getAuthenticatorAssuranceLevel()]);
    setFactors((f.data?.totp ?? []) as Factor[]);
    setAal(a.data?.currentLevel ?? null);
  }

  async function start() {
    setMsg(null);
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `SAVOUR ${new Date().toISOString().slice(0, 10)}` });
    if (error || !data) return setMsg({ kind: "error", text: "Could not start enrollment. Try again." });
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function verify(factorId: string) {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    if (error) return setMsg({ kind: "error", text: "That code was not accepted. Check your authenticator app and try again." });
    setEnroll(null); setCode("");
    setMsg({ kind: "ok", text: "Verified. This browser session is now at assurance level 2 (aal2)." });
    await refresh();
  }

  const verified = factors.filter((f) => f.status === "verified");
  return (
    <div className="stack">
      <p>Current session assurance level: <strong>{aal ?? "…"}</strong></p>
      {verified.length > 0 ? (
        <div className="stack">
          <p className="notice ok">Authenticator app enrolled.</p>
          {aal !== "aal2" && (
            <div className="row">
              <label htmlFor="mfa-code" className="sr-only">Code</label>
              <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 200 }} />
              <button className="btn primary" onClick={() => verify(verified[0].id)}>Verify this session</button>
            </div>
          )}
        </div>
      ) : enroll ? (
        <div className="stack">
          <p>Scan this QR code with an authenticator app, then enter the 6-digit code.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enroll.qr} alt="Authenticator QR code" width={180} height={180} style={{ background: "#fff", padding: 8, borderRadius: 8 }} />
          <p className="small">Or enter this secret manually: <span className="mono">{enroll.secret}</span></p>
          <div className="row">
            <label htmlFor="mfa-enroll-code">Code</label>
            <input id="mfa-enroll-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 200 }} />
            <button className="btn primary" onClick={() => verify(enroll.id)}>Confirm</button>
          </div>
        </div>
      ) : (
        <button className="btn primary" onClick={start}>Set up authenticator app</button>
      )}
      <div aria-live="polite">{msg && <p className={`notice ${msg.kind}`}>{msg.text}</p>}</div>
    </div>
  );
}
