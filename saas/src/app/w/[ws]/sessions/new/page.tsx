import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { isManager, requireWorkspace, ROLE_LABELS, type Role } from "@/lib/auth";
import { ATTENDANCE_MODE_LABELS } from "@/lib/labels";
import { createSession } from "../actions";

export const metadata = { title: "New session — SAVOUR" };

interface Member { user_id: string; role: Role; display_name: string; all_locations: boolean; membership_locations: { location_id: string }[] }
interface Tpl { id: string; name: string; latest_version: number; template_versions: { id: string; version: number; attendance_mode: string }[] }

export default async function NewSessionPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { supabase, ctx, user } = await requireWorkspace(ws);
  if (!isManager(ctx.role)) notFound();
  const [locs, tpls, subs, mems] = await Promise.all([
    supabase.from("locations").select("id, name").eq("workspace_id", ws).is("archived_at", null).order("name"),
    supabase.from("templates").select("id, name, latest_version, template_versions(id, version, attendance_mode)").eq("workspace_id", ws).order("name"),
    supabase.from("subjects").select("id, name").eq("workspace_id", ws).is("archived_at", null).eq("is_sample", false).order("name"),
    supabase.from("memberships").select("user_id, role, display_name, all_locations, membership_locations(location_id)")
      .eq("workspace_id", ws).eq("status", "active").in("role", ["owner", "admin", "reviewer", "assessor"]).order("display_name"),
  ]);
  const locations = (locs.data ?? []) as { id: string; name: string }[];
  const subjects = (subs.data ?? []) as { id: string; name: string }[];
  const members = (mems.data ?? []) as Member[];
  const versions = ((tpls.data ?? []) as Tpl[]).flatMap((t) => {
    const v = t.template_versions.find((x) => x.version === t.latest_version);
    return v ? [{ id: v.id, label: `${t.name} v${v.version} — ${ATTENDANCE_MODE_LABELS[v.attendance_mode]}` }] : [];
  });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.workspace.timezone }).format(new Date());
  const scope = (m: Member) => m.role === "owner" || m.role === "admin" || m.all_locations ? "all locations"
    : locations.filter((l) => m.membership_locations.some((x) => x.location_id === l.id)).map((l) => l.name).join(", ") || "no locations";
  const missing = [!locations.length && "a location", !versions.length && "a template", !subjects.length && "subjects"].filter(Boolean);

  if (missing.length) {
    return (
      <div className="card stack">
        <h1>New session</h1>
        <p className="notice warn">Before creating a session, add {missing.join(", ")}.</p>
        <div className="row">
          <Link className="btn" href={`/w/${ws}/setup`}>Locations &amp; subjects</Link>
          <Link className="btn" href={`/w/${ws}/templates`}>Templates</Link>
        </div>
      </div>
    );
  }
  return (
    <section className="card">
      <h1>New session</h1>
      <p className="muted small">This saves a <strong>draft</strong>. Assessors cannot see or submit it until you review it and press Open on the session page; owners, admins and the session’s reviewers can prepare it.
        Collection then runs for the window you set (default 48 hours, counted from opening). You can finish the roster, assessors and reviewers on the draft.</p>
      <ActionForm action={createSession}>
        <input type="hidden" name="ws" value={ws} />
        <div className="field"><label htmlFor="name">Session name</label><input id="name" name="name" required maxLength={120} /></div>
        <div className="grid">
          <div className="field"><label htmlFor="local_date">Date ({ctx.workspace.timezone})</label>
            <input id="local_date" name="local_date" type="date" defaultValue={today} required /></div>
          <div className="field"><label htmlFor="location">Location</label>
            <select id="location" name="location" required>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
          <div className="field"><label htmlFor="template_version">Template</label>
            <select id="template_version" name="template_version" required>{versions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></div>
          <div className="field"><label htmlFor="ready_time">Expected ready time <span className="hint">(required for scored readiness)</span></label>
            <input id="ready_time" name="ready_time" type="time" /></div>
          <div className="field"><label htmlFor="window_hours">Collection window (hours)</label>
            <input id="window_hours" name="window_hours" type="number" min={1} max={168} defaultValue={48} required /></div>
        </div>
        <fieldset><legend>Roster subjects <span className="hint">(can be completed later on the draft)</span></legend>
          {subjects.map((s) => <label key={s.id} className="check"><input type="checkbox" name="subjects" value={s.id} /> {s.name}</label>)}
        </fieldset>
        <fieldset><legend>Assessors (each is assigned every roster subject)</legend>
          <p className="hint">Assessors must hold the chosen location. Guests are invited from the session page.</p>
          {members.map((m) => <label key={m.user_id} className="check"><input type="checkbox" name="assessors" value={m.user_id} /> {m.display_name} <span className="hint">({ROLE_LABELS[m.role]}; {scope(m)})</span></label>)}
        </fieldset>
        <fieldset><legend>Reviewers</legend>
          <p className="hint">At least one reviewer is needed to open. Owners and admins may list themselves.</p>
          {members.filter((m) => m.role === "reviewer" || m.role === "owner" || m.role === "admin").map((m) => (
            <label key={m.user_id} className="check"><input type="checkbox" name="reviewers" value={m.user_id} defaultChecked={m.user_id === user.id} /> {m.display_name} <span className="hint">({ROLE_LABELS[m.role]}; {scope(m)})</span></label>
          ))}
        </fieldset>
        <SubmitButton pendingText="Saving draft…">Save draft</SubmitButton>
      </ActionForm>
    </section>
  );
}
