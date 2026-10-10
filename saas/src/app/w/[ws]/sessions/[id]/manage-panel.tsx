import { ActionForm, SubmitButton } from "@/components/forms";
import { InviteLinkForm } from "@/components/invite-link-form";
import { ROLE_LABELS, type Role } from "@/lib/auth";
import { cancelSession, inviteGuest, reopenSession, setAssignment } from "./actions";
import type { loadSession } from "./data";

type Data = Awaited<ReturnType<typeof loadSession>>;

export async function ManagePanel({ ws, data }: { ws: string; data: Data }) {
  const { session } = data;
  const { data: members } = await data.supabase.from("memberships")
    .select("user_id, role, display_name, guest_session_id").eq("workspace_id", ws).eq("status", "active")
    .in("role", ["owner", "admin", "reviewer", "assessor", "guest"]).order("display_name");
  const people = ((members ?? []) as { user_id: string; role: Role; display_name: string; guest_session_id: string | null }[])
    .filter((m) => m.role !== "guest" || m.guest_session_id === session.id);
  const nameOf = (id: string) => people.find((p) => p.user_id === id)?.display_name ?? "Former member";
  const editable = session.status === "open" || session.status === "in_review";
  const hidden = <><input type="hidden" name="ws" value={ws} /><input type="hidden" name="session" value={session.id} /></>;
  const collecting = data.collecting;

  return (
    <section className="stack">
      <h2>Manage session</h2>
      {editable && (
        <div className="card stack">
          <h3>Assignments</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Subject</th><th>Assigned</th></tr></thead>
            <tbody>{data.roster.map((r) => (
              <tr key={r.subject_id}><td>{r.subject_name}</td>
                <td>{data.assignments.filter((a) => a.subject_id === r.subject_id).map((a) => nameOf(a.user_id)).join(", ") || "—"}</td></tr>
            ))}</tbody>
          </table></div>
          <ActionForm action={setAssignment}>
            {hidden}<input type="hidden" name="data_version" value={session.data_version} />
            <div className="grid">
              <div className="field"><label htmlFor="as-user">Person</label>
                <select id="as-user" name="user" required>{people.map((p) => <option key={p.user_id} value={p.user_id}>{p.display_name} ({ROLE_LABELS[p.role]})</option>)}</select></div>
              <div className="field"><label htmlFor="as-mode">Change</label>
                <select id="as-mode" name="assigned"><option value="true">Assign</option><option value="false">Remove</option></select></div>
            </div>
            <fieldset><legend>Subjects</legend>
              {data.roster.map((r) => <label key={r.subject_id} className="check"><input type="checkbox" name="subject" value={r.subject_id} /> {r.subject_name}</label>)}
            </fieldset>
            <p className="hint">Staff must hold this session&apos;s location. Removing an assignment ends that person&apos;s access to the subject on their next request.</p>
            <SubmitButton className="btn">Update assignments</SubmitButton>
          </ActionForm>
        </div>
      )}
      {collecting && (
        <div className="card stack">
          <h3>Invite a guest assessor</h3>
          <p className="small">A guest can only see and submit the subjects you choose, in this session only, until collection closes. They never see reports or other businesses&apos; data.</p>
          <InviteLinkForm action={inviteGuest}>
            {hidden}
            <div className="field"><label htmlFor="g-email">Guest email</label><input id="g-email" name="email" type="email" required /></div>
            <fieldset><legend>Permitted subjects</legend>
              {data.roster.map((r) => <label key={r.subject_id} className="check"><input type="checkbox" name="subjects" value={r.subject_id} /> {r.subject_name}</label>)}
            </fieldset>
          </InviteLinkForm>
        </div>
      )}
      {session.status === "approved" && (
        <ActionForm action={reopenSession} className="card">
          {hidden}
          <h3>Reopen for revision</h3>
          <p className="small">Creates revision {session.revision + 1}. The approved revision {session.revision} stays exactly as approved; this session leaves analytics until reapproved. Collection is not reopened.</p>
          <div className="field"><label htmlFor="reopen-reason">Reason (required)</label><input id="reopen-reason" name="reason" required maxLength={500} /></div>
          <SubmitButton className="btn" pendingText="Reopening…">Reopen</SubmitButton>
        </ActionForm>
      )}
      {editable && (
        <ActionForm action={cancelSession} className="card">
          {hidden}
          <h3>Cancel session</h3>
          <p className="small">Keeps submitted evidence, excludes the session from analytics. Cannot be undone.</p>
          <div className="field"><label htmlFor="cancel-reason">Reason (required)</label><input id="cancel-reason" name="reason" required maxLength={500} /></div>
          <label className="check"><input type="checkbox" name="confirm" required /> I understand this cancels the session.</label>
          <SubmitButton className="btn danger" pendingText="Cancelling…">Cancel session</SubmitButton>
        </ActionForm>
      )}
    </section>
  );
}
