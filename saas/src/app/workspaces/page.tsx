import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SimpleTopbar } from "@/components/topbar";
import { requireUser, ROLE_LABELS, type Role } from "@/lib/auth";
import { createWorkspace } from "./actions";

export const metadata = { title: "Your businesses — SAVOUR" };

const TIMEZONES = ["Africa/Lagos", "Africa/Accra", "Africa/Nairobi", "Africa/Johannesburg", "Europe/London",
  "Europe/Paris", "America/New_York", "America/Chicago", "America/Los_Angeles", "America/Toronto", "Asia/Dubai", "UTC"];

export default async function WorkspacesPage() {
  const { supabase, user } = await requireUser("/workspaces");
  const { data, error } = await supabase
    .from("memberships").select("role, workspace_id, workspaces(name, timezone)")
    .eq("user_id", user.id).eq("status", "active");
  const rows = (data ?? []) as unknown as { role: Role; workspace_id: string; workspaces: { name: string; timezone: string } | null }[];
  return (
    <>
      <SimpleTopbar />
      <main className="container stack">
        <h1>Your businesses</h1>
        <p className="muted small">Signed in as {user.email}. Switching business is always a deliberate choice.</p>
        {error && <p className="notice error">Could not load your businesses. Reload to try again.</p>}
        {rows.length === 0 && !error && <p className="notice">You are not a member of any business yet. Create one below, or open an invitation link.</p>}
        <div className="grid">
          {rows.filter((r) => r.workspaces).map((r) => (
            <Link key={r.workspace_id} href={`/w/${r.workspace_id}`} className="card" style={{ textDecoration: "none", color: "inherit" }}>
              <h2>{r.workspaces!.name}</h2>
              <p className="muted small">{ROLE_LABELS[r.role]} · {r.workspaces!.timezone}</p>
            </Link>
          ))}
        </div>
        <section className="card" style={{ maxWidth: 560 }}>
          <h2>Create a business</h2>
          <p className="muted small">You become its owner. Requires a verified email address.</p>
          <ActionForm action={createWorkspace}>
            <div className="field"><label htmlFor="name">Business name</label><input id="name" name="name" required maxLength={120} /></div>
            <div className="field"><label htmlFor="display_name">Your name</label><input id="display_name" name="display_name" required maxLength={80} /></div>
            <div className="field"><label htmlFor="country">Country</label><input id="country" name="country" defaultValue="Nigeria" required /></div>
            <div className="field"><label htmlFor="timezone">Timezone</label>
              <select id="timezone" name="timezone" defaultValue="Africa/Lagos">
                {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
              </select></div>
            <SubmitButton pendingText="Creating…">Create business</SubmitButton>
          </ActionForm>
        </section>
      </main>
    </>
  );
}
