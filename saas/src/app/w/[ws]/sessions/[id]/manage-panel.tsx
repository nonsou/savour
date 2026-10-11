import { ActionForm, SubmitButton } from "@/components/forms";
import { InviteLinkForm } from "@/components/invite-link-form";
import { ROLE_LABELS, type Role } from "@/lib/auth";
import { savedStateKey } from "@/lib/form-keys";
import { ATTENDANCE_MODE_LABELS } from "@/lib/labels";
import { formatDateTime } from "@/lib/report";
import {
  cancelSession, inviteGuest, openSession, reopenCollection, reopenSession, setAssignment, setReviewer,
  setRosterSubjects, updateDraft, updateWindow,
} from "./actions";
import type { loadSession } from "./data";

type Data = Awaited<ReturnType<typeof loadSession>>;
interface Member { user_id: string; role: Role; display_name: string; guest_session_id: string | null }
interface Tpl { id: string; name: string; latest_version: number; template_versions: { id: string; version: number; attendance_mode: string }[] }

// Owner/Admin scope management. Every change is authorized, versioned and audited in the
// database; reasons are required there once the session has opened (this form only asks).
export async function ManagePanel({ ws, data }: { ws: string; data: Data }) {
  const { session, ctx } = data;
  const draft = session.status === "draft";
  const editable = draft || session.status === "open" || session.status === "in_review";
  const [members, subs, locs, tpls] = await Promise.all([
    data.supabase.from("memberships").select("user_id, role, display_name, guest_session_id").eq("workspace_id", ws).eq("status", "active")
      .in("role", ["owner", "admin", "reviewer", "assessor", "guest"]).order("display_name"),
    data.supabase.from("subjects").select("id, name").eq("workspace_id", ws).is("archived_at", null).eq("is_sample", session.is_sample).order("name"),
    draft ? data.supabase.from("locations").select("id, name").eq("workspace_id", ws).is("archived_at", null).order("name") : null,
    draft ? data.supabase.from("templates").select("id, name, latest_version, template_versions(id, version, attendance_mode)").eq("workspace_id", ws).order("name") : null,
  ]);
  const people = ((members.data ?? []) as Member[]).filter((m) => m.role !== "guest" || m.guest_session_id === session.id);
  const staff = people.filter((m) => m.role !== "guest");
  const reviewerCandidates = staff.filter((m) => ["owner", "admin", "reviewer"].includes(m.role));
  const nameOf = (id: string) => people.find((p) => p.user_id === id)?.display_name ?? "Former member";
  const onRoster = new Set(data.roster.map((r) => r.subject_id));
  const removed = new Map(data.removedRoster.map((r) => [r.subject_id, r]));
  const addable = ((subs.data ?? []) as { id: string; name: string }[]).filter((x) => !onRoster.has(x.id));
  const tz = ctx.workspace.timezone;
  const canReopenCollection = session.status === "in_review" || data.windowExpired;
  const hidden = (
    <><input type="hidden" name="ws" value={ws} /><input type="hidden" name="session" value={session.id} />
      <input type="hidden" name="data_version" value={session.data_version} /></>
  );
  const reason = (id: string, label = "Reason") => (
    <div className="field"><label htmlFor={id}>{label} {draft ? <span className="hint">(optional in a draft)</span> : <span className="hint">(required; kept in the audit log)</span>}</label>
      <input id={id} name="reason" required={!draft} maxLength={500} /></div>
  );

  const versions = ((tpls?.data ?? []) as Tpl[]).flatMap((t) => t.template_versions.filter((v) => v.version === t.latest_version || v.id === session.template_version_id)
    .map((v) => ({ id: v.id, label: `${t.name} v${v.version} — ${ATTENDANCE_MODE_LABELS[v.attendance_mode]}` })));
  const locations = (locs?.data ?? []) as { id: string; name: string }[];

  return (
    <section className="stack">
      <h2>Manage session</h2>

      {draft && (
        <ActionForm action={updateDraft} className="card">
          {hidden}
          <h3>Draft details</h3>
          <div key={savedStateKey(session.name, session.local_date, session.location_id, session.template_version_id, session.planned_window_hours, session.expected_ready_time)} className="grid">
            <div className="field"><label htmlFor="d-name">Session name</label><input id="d-name" name="name" defaultValue={session.name} required maxLength={120} /></div>
            <div className="field"><label htmlFor="d-date">Date ({tz})</label><input id="d-date" name="local_date" type="date" defaultValue={session.local_date} required /></div>
            <div className="field"><label htmlFor="d-loc">Location</label>
              <select id="d-loc" name="location" defaultValue={session.location_id}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
            <div className="field"><label htmlFor="d-tpl">Template</label>
              <select id="d-tpl" name="template_version" defaultValue={session.template_version_id}>{versions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></div>
            <div className="field"><label htmlFor="d-ready">Expected ready time <span className="hint">(scored readiness)</span></label>
              <input id="d-ready" name="ready_time" type="time" defaultValue={session.expected_ready_time?.slice(0, 5) ?? ""} /></div>
            <div className="field"><label htmlFor="d-hours">Collection window (hours from opening)</label>
              <input id="d-hours" name="window_hours" type="number" min={1} max={168} defaultValue={session.planned_window_hours ?? 48} required /></div>
          </div>
          <SubmitButton className="btn">Save draft details</SubmitButton>
        </ActionForm>
      )}

      {editable && (
        <div className="card stack">
          <h3>Roster</h3>
          <p className="small">{data.roster.length} subject(s): {data.roster.map((r) => r.subject_name).join(", ") || "none yet"}.</p>
          {data.removedRoster.length > 0 && (
            <div className="notice warn small">
              <strong>Removed from this session</strong> (responses kept in history, not in totals):
              <ul>{data.removedRoster.map((r) => <li key={r.subject_id}>{r.subject_name}{r.removal_reason ? ` — ${r.removal_reason}` : ""}{r.removed_at ? ` (${formatDateTime(r.removed_at, tz)})` : ""}</li>)}</ul>
            </div>
          )}
          {(addable.length > 0) && (
            <ActionForm action={setRosterSubjects}>
              {hidden}<input type="hidden" name="on" value="true" />
              <fieldset><legend>Add {session.is_sample ? "sample " : ""}subjects</legend>
                {addable.map((x) => <label key={x.id} className="check"><input type="checkbox" name="subject" value={x.id} /> {x.name}{removed.has(x.id) && <span className="hint"> (restore: earlier responses come back)</span>}</label>)}
              </fieldset>
              {reason("roster-add-reason")}
              <SubmitButton className="btn">Add to roster</SubmitButton>
            </ActionForm>
          )}
          {data.roster.length > 0 && (
            <ActionForm action={setRosterSubjects}>
              {hidden}<input type="hidden" name="on" value="false" />
              <fieldset><legend>Remove subjects</legend>
                {data.roster.map((r) => <label key={r.subject_id} className="check"><input type="checkbox" name="subject" value={r.subject_id} /> {r.subject_name}</label>)}
              </fieldset>
              <p className="hint">{draft ? "A draft has no responses yet, so removal simply drops the subject." : "Removal keeps every response and its history; the subject leaves this session's totals and is listed as removed in reports. Approved reports never change."}</p>
              {reason("roster-remove-reason")}
              <SubmitButton className="btn danger">Remove from roster</SubmitButton>
            </ActionForm>
          )}
        </div>
      )}

      {editable && (
        <div className="card stack">
          <h3>Assignments</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Subject</th><th>Assigned</th></tr></thead>
            <tbody>{data.roster.map((r) => (
              <tr key={r.subject_id}><td>{r.subject_name}</td>
                <td>{data.assignments.filter((a) => a.subject_id === r.subject_id).map((a) => nameOf(a.user_id) + (a.waived_at ? " (waived)" : "")).join(", ") || "—"}</td></tr>
            ))}</tbody>
          </table></div>
          <ActionForm action={setAssignment}>
            {hidden}
            <div className="grid">
              <div className="field"><label htmlFor="as-user">Person</label>
                <select id="as-user" name="user" required>{people.filter((p) => !draft || p.role !== "guest").map((p) => <option key={p.user_id} value={p.user_id}>{p.display_name} ({ROLE_LABELS[p.role]})</option>)}</select></div>
              <div className="field"><label htmlFor="as-mode">Change</label>
                <select id="as-mode" name="assigned"><option value="true">Assign</option><option value="false">Remove</option></select></div>
            </div>
            <fieldset><legend>Subjects</legend>
              {data.roster.map((r) => <label key={r.subject_id} className="check"><input type="checkbox" name="subject" value={r.subject_id} /> {r.subject_name}</label>)}
            </fieldset>
            <div className="field"><label htmlFor="as-reason">Reason <span className="hint">(recommended; kept in the audit log)</span></label><input id="as-reason" name="reason" maxLength={500} /></div>
            <p className="hint">Staff must hold this session&apos;s location. Removing an assignment ends that person&apos;s access to the subject on their next request
              and removes it from the required count. To excuse missing work but keep it visible, use a waiver in Review instead.</p>
            <SubmitButton className="btn">Update assignments</SubmitButton>
          </ActionForm>
        </div>
      )}

      {editable && (
        <div className="card stack">
          <h3>Reviewers</h3>
          <p className="small">{data.reviewerIds.map(nameOf).join(", ") || "None yet — at least one is needed to open."}</p>
          <ActionForm action={setReviewer}>
            {hidden}
            <div className="grid">
              <div className="field"><label htmlFor="rv-user">Person</label>
                <select id="rv-user" name="user" required>{reviewerCandidates.map((p) => <option key={p.user_id} value={p.user_id}>{p.display_name} ({ROLE_LABELS[p.role]})</option>)}</select></div>
              <div className="field"><label htmlFor="rv-mode">Change</label>
                <select id="rv-mode" name="on"><option value="true">Add reviewer</option><option value="false">Remove reviewer</option></select></div>
            </div>
            {reason("rv-reason")}
            <SubmitButton className="btn">Update reviewers</SubmitButton>
          </ActionForm>
        </div>
      )}

      {draft && (
        <ActionForm action={openSession} className="card highlight">
          {hidden}
          <h3>Open collection</h3>
          <p className="small">Opening checks the location, template, roster, assessors and at least one reviewer on the server. Collection starts now and closes after {session.planned_window_hours ?? 48} hour(s). Guests are invited after opening.</p>
          <label className="check"><input type="checkbox" name="confirm" required /> Open this session for assessors now.</label>
          <SubmitButton pendingText="Opening…">Open session</SubmitButton>
        </ActionForm>
      )}

      {data.collecting && (
        <ActionForm action={updateWindow} className="card">
          {hidden}
          <h3>Change collection close</h3>
          <p className="small">Currently closes {formatDateTime(session.closes_at, tz)}. The new close is counted from now. Live guest access moves with it.</p>
          <div className="field"><label htmlFor="w-hours">Close in (hours from now)</label><input id="w-hours" name="hours" type="number" min={1} max={168} defaultValue={24} required /></div>
          {reason("w-reason")}
          <SubmitButton className="btn">Change close time</SubmitButton>
        </ActionForm>
      )}

      {canReopenCollection && (
        <ActionForm action={reopenCollection} className="card">
          {hidden}
          <h3>Reopen collection</h3>
          <p className="small">Lets assigned assessors submit again for the hours you choose. Evidence is kept and no approved report changes.
            Guests whose access already expired or was revoked are not brought back: send them a new invitation after reopening.</p>
          <div className="field"><label htmlFor="rc-hours">Collect for (hours from now)</label><input id="rc-hours" name="hours" type="number" min={1} max={168} defaultValue={24} required /></div>
          <div className="field"><label htmlFor="rc-reason">Reason (required)</label><input id="rc-reason" name="reason" required maxLength={500} /></div>
          <label className="check"><input type="checkbox" name="confirm" required /> Reopen collection for this session.</label>
          <SubmitButton className="btn" pendingText="Reopening…">Reopen collection</SubmitButton>
        </ActionForm>
      )}

      {data.collecting && !session.is_sample && (
        <div className="card stack">
          <h3>Invite a guest assessor</h3>
          <p className="small">A guest can only see and submit the subjects you choose, in this session only, until collection closes. They never see reports or other businesses&apos; data.</p>
          <InviteLinkForm action={inviteGuest}>
            <input type="hidden" name="ws" value={ws} /><input type="hidden" name="session" value={session.id} />
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
          <p className="small">Creates revision {session.revision + 1}. The approved revision {session.revision} stays exactly as approved; this session leaves analytics until reapproved.
            Collection is not reopened: reviewers can correct and reapprove. To let assessors submit again, reopen collection afterwards.</p>
          <div className="field"><label htmlFor="reopen-reason">Reason (required)</label><input id="reopen-reason" name="reason" required maxLength={500} /></div>
          <SubmitButton className="btn" pendingText="Reopening…">Reopen for revision</SubmitButton>
        </ActionForm>
      )}

      {editable && (
        <ActionForm action={cancelSession} className="card">
          <input type="hidden" name="ws" value={ws} /><input type="hidden" name="session" value={session.id} />
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
