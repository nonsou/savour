import { isManager, requireWorkspace } from "@/lib/auth";
import { MfaPanel, type Factor } from "./mfa";

export const metadata = { title: "Security — SAVOUR" };

export default async function SecurityPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { ctx, supabase } = await requireWorkspace(ws);
  const [factors, aal] = await Promise.all([
    supabase.auth.mfa.listFactors(), supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  return (
    <section className="card stack">
      <h1>Two-step verification</h1>
      {isManager(ctx.role) && (
        <p className="notice warn">
          Owners and admins will be required to use two-step verification before paid launch. In this milestone it is
          available but <strong>not yet enforced</strong>.
        </p>
      )}
      {(factors.error || aal.error) && <p className="notice error">Could not load your two-step settings. Reload to try again.</p>}
      <MfaPanel initialFactors={(factors.data?.totp ?? []) as Factor[]} initialAal={aal.data?.currentLevel ?? null} />
    </section>
  );
}
