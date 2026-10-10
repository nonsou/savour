import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { InviteLinkForm } from "@/components/invite-link-form";
import { isManager, requireWorkspace, ROLE_LABELS, type Role } from "@/lib/auth";
import { memberAccessKey } from "@/lib/form-keys";
import { formatDateTime } from "@/lib/report";
import { createInvitation, revokeInvitation, revokeMember, updateMember } from "./actions";

export const metadata = { title: "Team — SAVOUR" };

interface Member { user_id: string; role: Role; display_name: string; email: string; all_locations: boolean; status: string; membership_locations: { location_id: string }[] }
interface Invite { id: string; email: string; role: Role; expires_at: string; revoked_at: string | null; accepted_at: string | null; all_locations: boolean; location_ids: string[]; session_id: string | null }
interface Audit { id: number; action: string; created_at: string; actor_id: string | null; detail: Record<string, unknown> }

export default async function TeamPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { supabase, ctx, user } = await requireWorkspace(ws);
  if (!isManager(ctx.role)) notFound();
  const [mem, inv, loc, aud] = await Promise.all([
    supabase.from("memberships").select("user_id, role, display_name, email, all_locations, status, membership_locations(location_id)").eq("workspace_id", ws).order("display_name"),
    supabase.from("invitations").select("id, email, role, expires_at, revoked_at, accepted_at, all_locations, location_ids, session_id").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(50),
    supabase.from("locations").select("id, name").eq("workspace_id", ws).is("archived_at", null).order("name"),
    supabase.from("audit_events").select("id, action, created_at, actor_id, detail").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(25),
  ]);
  const members = (mem.data ?? []) as Member[];
  const invites = ((inv.data ?? []) as Invite[]).filter((i) => !i.session_id);
  const locations = (loc.data ?? []) as { id: string; name: string }[];
  const audit = (aud.data ?? []) as Audit[];
  const tz = ctx.workspace.timezone;
  const nameOf = (id: string | null) => members.find((m) => m.user_id === id)?.display_name ?? "—";
  const invitable: Role[] = ctx.role === "owner" ? ["admin", "reviewer", "assessor", "viewer"] : ["reviewer", "assessor", "viewer"];
  const editableRoles: Role[] = ctx.role === "owner" ? ["admin", "reviewer", "assessor", "viewer"] : ["reviewer", "assessor", "viewer"];
  const hidden = <input type="hidden" name="ws" value={ws} />;
  const locationBoxes = (selected: string[] = [], prefix = "n") => locations.map((l) => (
    <label key={l.id} className="check"><input type="checkbox" name="locations" value={l.id} defaultChecked={selected.includes(l.id)} id={`${prefix}-${l.id}`} /> {l.name}</label>
  ));
  const inviteStatus = (i: Invite) => i.accepted_at ? "Accepted" : i.revoked_at ? "Revoked" : new Date(i.expires_at) < new Date() ? "Expired" : "Pending";

  return (
    <>
      <h1>Team</h1>
      {(mem.error || inv.error) && <p className="notice error">Could not load team data. Reload to try again.</p>}
      <section className="card stack">
        <h2>Invite staff</h2>
        <p className="small muted">The link works once, for the invited email only, within 7 days. No email is sent: copy the link and share it privately. Owners cannot be invited.</p>
        <InviteLinkForm action={createInvitation}>
          {hidden}
          <div className="field"><label htmlFor="inv-email">Email</label><input id="inv-email" name="email" type="email" required /></div>
          <div className="field"><label htmlFor="inv-role">Role</label>
            <select id="inv-role" name="role">{invitable.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></div>
          <fieldset><legend>Locations (not needed for Admin)</legend>
            <label className="check"><input type="checkbox" name="all_locations" /> All locations</label>
            {locationBoxes()}
          </fieldset>
        </InviteLinkForm>
      </section>

      <section className="card stack">
        <h2>Members</h2>
        {members.map((m) => {
          const self = m.user_id === user.id;
          const locked = m.role === "owner" || m.role === "guest" || (ctx.role === "admin" && m.role === "admin");
          return (
            <details key={m.user_id}>
              <summary>{m.display_name} <span className="muted small">{m.email}</span> <span className="badge">{ROLE_LABELS[m.role]}</span>{m.status === "revoked" && <span className="badge cancelled">Removed</span>}{self && " (you)"}</summary>
              {m.status === "active" && !self && !locked && (
                <ActionForm action={updateMember}>
                  {hidden}<input type="hidden" name="user" value={m.user_id} />
                  <div key={memberAccessKey(m)}>
                    <div className="field"><label htmlFor={`r-${m.user_id}`}>Role</label>
                      <select id={`r-${m.user_id}`} name="role" defaultValue={m.role}>{editableRoles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></div>
                    <fieldset><legend>Locations</legend>
                      <label className="check"><input type="checkbox" name="all_locations" defaultChecked={m.all_locations} /> All locations</label>
                      {locationBoxes(m.membership_locations.map((x) => x.location_id), m.user_id)}
                    </fieldset>
                  </div>
                  <SubmitButton className="btn">Save access</SubmitButton>
                </ActionForm>
              )}
              {m.status === "active" && (self ? m.role !== "owner" : !(ctx.role === "admin" && (m.role === "owner" || m.role === "admin"))) && (
                <ActionForm action={revokeMember}>
                  {hidden}<input type="hidden" name="user" value={m.user_id} />
                  <label className="check"><input type="checkbox" name="confirm" required /> {self ? "Leave this business" : `Remove ${m.display_name}`}</label>
                  <SubmitButton className="btn danger" pendingText="Removing…">{self ? "Leave" : "Remove member"}</SubmitButton>
                </ActionForm>
              )}
              {self && <p className="hint">You cannot change your own role. A business always keeps at least one owner.</p>}
            </details>
          );
        })}
      </section>

      <section className="card table-wrap">
        <h2>Invitations</h2>
        {inv.error ? <p className="notice error">Invitations unavailable.</p> : invites.length === 0 ? <p className="muted">No staff invitations yet.</p> : (
          <table>
            <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th></th></tr></thead>
            <tbody>{invites.map((i) => (
              <tr key={i.id}><td>{i.email}</td><td>{ROLE_LABELS[i.role]}</td><td>{inviteStatus(i)}</td><td className="small">{formatDateTime(i.expires_at, tz)}</td>
                <td>{inviteStatus(i) === "Pending" && (
                  <ActionForm action={revokeInvitation}>{hidden}<input type="hidden" name="id" value={i.id} /><SubmitButton className="btn danger">Revoke</SubmitButton></ActionForm>
                )}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="card table-wrap">
        <h2>Recent activity</h2>
        {aud.error ? <p className="notice error">Activity unavailable.</p> : audit.length === 0 ? <p className="muted">No activity yet.</p> : (
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th></tr></thead>
            <tbody>{audit.map((a) => (
              <tr key={a.id}><td className="small">{formatDateTime(a.created_at, tz)}</td><td>{nameOf(a.actor_id)}</td><td>{a.action}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
