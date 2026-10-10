import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { isManager, requireWorkspace } from "@/lib/auth";
import { savedStateKey } from "@/lib/form-keys";
import { SUBJECT_TYPES } from "@/lib/labels";
import { saveLocation, saveSubject } from "./actions";

export const metadata = { title: "Locations & subjects — SAVOUR" };

interface Loc { id: string; name: string; archived_at: string | null }
interface Subj extends Loc { subject_type: string }

export default async function SetupPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { supabase, ctx } = await requireWorkspace(ws);
  if (!isManager(ctx.role)) notFound();
  const [locs, subs] = await Promise.all([
    supabase.from("locations").select("id, name, archived_at").eq("workspace_id", ws).order("name"),
    supabase.from("subjects").select("id, name, subject_type, archived_at").eq("workspace_id", ws).order("name"),
  ]);
  const locations = (locs.data ?? []) as Loc[];
  const subjects = (subs.data ?? []) as Subj[];
  const wsInput = <input type="hidden" name="ws" value={ws} />;
  return (
    <>
      <h1>Locations &amp; subjects</h1>
      {(locs.error || subs.error) && <p className="notice error">Could not load setup data. Reload to try again.</p>}
      <div className="grid">
        <section className="card stack">
          <h2>Locations</h2>
          <ActionForm action={saveLocation} resetOnSuccess>
            {wsInput}
            <div className="field"><label htmlFor="loc-name">New location</label><input id="loc-name" name="name" required maxLength={120} /></div>
            <SubmitButton>Add location</SubmitButton>
          </ActionForm>
          {locs.error ? <p className="notice error">Locations unavailable.</p> : locations.length === 0 && <p className="muted">No locations yet.</p>}
          {locations.map((l) => (
            <details key={l.id}>
              <summary>{l.name} {l.archived_at && <span className="badge">Archived</span>}</summary>
              <ActionForm action={saveLocation}>
                {wsInput}<input type="hidden" name="id" value={l.id} />
                <div key={savedStateKey(l.name, l.archived_at)}>
                  <div className="field"><label htmlFor={`l-${l.id}`}>Name</label><input id={`l-${l.id}`} name="name" defaultValue={l.name} required /></div>
                  <label className="check"><input type="checkbox" name="archived" defaultChecked={!!l.archived_at} /> Archived (hidden from new sessions)</label>
                </div>
                <SubmitButton className="btn">Save</SubmitButton>
              </ActionForm>
            </details>
          ))}
        </section>
        <section className="card stack">
          <h2>Subjects</h2>
          <p className="muted small">Vendors, outlets, operations, suppliers or service providers. Archiving keeps history.</p>
          <ActionForm action={saveSubject} resetOnSuccess>
            {wsInput}
            <div className="field"><label htmlFor="sub-name">New subject</label><input id="sub-name" name="name" required maxLength={120} /></div>
            <div className="field"><label htmlFor="sub-type">Type</label>
              <select id="sub-type" name="subject_type">{SUBJECT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <SubmitButton>Add subject</SubmitButton>
          </ActionForm>
          {subs.error ? <p className="notice error">Subjects unavailable.</p> : subjects.length === 0 && <p className="muted">No subjects yet.</p>}
          {subjects.map((x) => (
            <details key={x.id}>
              <summary>{x.name} <span className="muted small">({SUBJECT_TYPES.find(([v]) => v === x.subject_type)?.[1]})</span> {x.archived_at && <span className="badge">Archived</span>}</summary>
              <ActionForm action={saveSubject}>
                {wsInput}<input type="hidden" name="id" value={x.id} />
                <div key={savedStateKey(x.name, x.subject_type, x.archived_at)}>
                  <div className="field"><label htmlFor={`s-${x.id}`}>Name</label><input id={`s-${x.id}`} name="name" defaultValue={x.name} required /></div>
                  <div className="field"><label htmlFor={`st-${x.id}`}>Type</label>
                    <select id={`st-${x.id}`} name="subject_type" defaultValue={x.subject_type}>{SUBJECT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                  <label className="check"><input type="checkbox" name="archived" defaultChecked={!!x.archived_at} /> Archived</label>
                </div>
                <SubmitButton className="btn">Save</SubmitButton>
              </ActionForm>
            </details>
          ))}
        </section>
      </div>
    </>
  );
}
