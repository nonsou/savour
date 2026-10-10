import { ActionForm, SubmitButton } from "@/components/forms";
import { SimpleTopbar } from "@/components/topbar";
import { requireUser, ROLE_LABELS, type Role } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";
import { acceptInvitation } from "./actions";

export const metadata = { title: "Invitation — SAVOUR", referrer: "no-referrer" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { supabase, user } = await requireUser(`/invite/${token}`);
  const { data, error } = await supabase.rpc("peek_invitation", { p_token: token });
  const info = data as { status: string; workspace_name?: string; role?: Role; expires_at?: string } | null;
  return (
    <>
      <SimpleTopbar />
      <main className="container narrow stack">
        <h1>Invitation</h1>
        {error && <p className="notice error">Could not check this invitation. Reload to try again.</p>}
        {info && info.status !== "valid" && (
          <div className="notice error">
            <p>{friendlyError({ message: info.status })}</p>
            {info.status === "invitation_wrong_account" && <p className="small">You are signed in as {user.email}.</p>}
          </div>
        )}
        {info?.status === "valid" && (
          <section className="card">
            <p>You have been invited to <strong>{info.workspace_name}</strong> as <strong>{ROLE_LABELS[info.role!]}</strong>.</p>
            <p className="muted small">Expires {new Date(info.expires_at!).toUTCString()}. Signed in as {user.email}.</p>
            <ActionForm action={acceptInvitation}>
              <input type="hidden" name="token" value={token} />
              <div className="field"><label htmlFor="display_name">Your name, as colleagues will see it</label>
                <input id="display_name" name="display_name" required maxLength={80} /></div>
              <SubmitButton pendingText="Joining…">Accept invitation</SubmitButton>
            </ActionForm>
          </section>
        )}
      </main>
    </>
  );
}
