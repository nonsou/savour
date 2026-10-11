import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { isManager, requireWorkspace } from "@/lib/auth";
import { savedStateKey } from "@/lib/form-keys";
import { SUBJECT_TYPES } from "@/lib/labels";
import { saveCategory, saveContact, saveLocation, saveSubject } from "./actions";

export const metadata = { title: "Locations & subjects — SAVOUR" };

interface Loc { id: string; name: string; archived_at: string | null }
interface Category { id: string; name: string; archived_at: string | null; version: number }
interface Contact { name: string | null; phone: string | null; email: string | null; version: number }
interface DirSubject {
  id: string; name: string; subject_type: string; archived_at: string | null; is_sample: boolean; version: number;
  category_id: string | null; external_id: string | null; location_ids: string[]; contact: Contact | null;
}

export default async function SetupPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { supabase, ctx } = await requireWorkspace(ws);
  if (!isManager(ctx.role)) notFound();
  const [locs, dir] = await Promise.all([
    supabase.from("locations").select("id, name, archived_at").eq("workspace_id", ws).order("name"),
    supabase.rpc("get_subject_directory", { p_ws: ws }),
  ]);
  const locations = (locs.data ?? []) as Loc[];
  const directory = (dir.data ?? { categories: [], subjects: [] }) as { categories: Category[]; subjects: DirSubject[] };
  const categories = directory.categories;
  const subjects = directory.subjects;
  const activeCats = categories.filter((c) => !c.archived_at);
  const wsInput = <input type="hidden" name="ws" value={ws} />;
  const typeLabel = (t: string) => SUBJECT_TYPES.find(([v]) => v === t)?.[1] ?? t;
  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name;

  return (
    <>
      <div className="row between">
        <h1>Locations &amp; subjects</h1>
        <Link className="btn" href={`/w/${ws}/setup/import`}>Import subjects from CSV</Link>
      </div>
      {(locs.error || dir.error) && <p className="notice error">Could not load setup data. Reload to try again.</p>}
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
          <h2>Categories</h2>
          <p className="muted small">Optional labels for organising subjects (for example Grills, Drinks, Cleaning). They never change templates or scores.</p>
          <ActionForm action={saveCategory} resetOnSuccess>
            {wsInput}
            <div className="field"><label htmlFor="cat-name">New category</label><input id="cat-name" name="name" required maxLength={80} /></div>
            <SubmitButton>Add category</SubmitButton>
          </ActionForm>
          {!dir.error && categories.length === 0 && <p className="muted">No categories yet.</p>}
          {categories.map((c) => (
            <details key={c.id}>
              <summary>{c.name} {c.archived_at && <span className="badge">Archived</span>}</summary>
              <ActionForm action={saveCategory}>
                {wsInput}<input type="hidden" name="id" value={c.id} />
                <div key={savedStateKey(c.name, c.archived_at, c.version)}>
                  <input type="hidden" name="version" value={c.version} />
                  <div className="field"><label htmlFor={`c-${c.id}`}>Name</label><input id={`c-${c.id}`} name="name" defaultValue={c.name} required maxLength={80} /></div>
                  <label className="check"><input type="checkbox" name="archived" defaultChecked={!!c.archived_at} /> Archived (cannot be newly assigned)</label>
                </div>
                <SubmitButton className="btn">Save</SubmitButton>
              </ActionForm>
            </details>
          ))}
        </section>
      </div>

      <section className="card stack">
        <h2>Subjects</h2>
        <p className="muted small">Vendors, outlets, operations, suppliers or service providers. Archiving keeps history and the same record; names must be unique.
          Contacts are private to owners and admins and never appear in reports or to assessors.</p>
        <ActionForm action={saveSubject} resetOnSuccess>
          {wsInput}
          <div className="grid">
            <div className="field"><label htmlFor="sub-name">New subject</label><input id="sub-name" name="name" required maxLength={120} /></div>
            <div className="field"><label htmlFor="sub-type">Type</label>
              <select id="sub-type" name="subject_type">{SUBJECT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div className="field"><label htmlFor="sub-cat">Category <span className="hint">(optional)</span></label>
              <select id="sub-cat" name="category" defaultValue=""><option value="">None</option>{activeCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div className="field"><label htmlFor="sub-ext">External ID <span className="hint">(optional; used to update by CSV)</span></label>
              <input id="sub-ext" name="external_id" maxLength={64} /></div>
          </div>
          <SubmitButton>Add subject</SubmitButton>
        </ActionForm>
        {!dir.error && subjects.length === 0 && <p className="muted">No subjects yet. Add them here or <Link href={`/w/${ws}/setup/import`}>import a CSV</Link>.</p>}
        {subjects.map((x) => (
          <details key={x.id}>
            <summary>
              {x.name} <span className="muted small">({typeLabel(x.subject_type)}{catName(x.category_id) ? ` · ${catName(x.category_id)}` : ""}{x.external_id ? ` · ${x.external_id}` : ""})</span>
              {x.is_sample && <span className="badge sample"> SAMPLE</span>} {x.archived_at && <span className="badge">Archived</span>}
            </summary>
            <div className="stack">
              <ActionForm action={saveSubject}>
                {wsInput}<input type="hidden" name="id" value={x.id} />
                <div key={savedStateKey(x.name, x.subject_type, x.archived_at, x.category_id, x.external_id, x.location_ids, x.version)}>
                  <input type="hidden" name="version" value={x.version} />
                  <div className="grid">
                    <div className="field"><label htmlFor={`s-${x.id}`}>Name</label><input id={`s-${x.id}`} name="name" defaultValue={x.name} required maxLength={120} /></div>
                    <div className="field"><label htmlFor={`st-${x.id}`}>Type</label>
                      <select id={`st-${x.id}`} name="subject_type" defaultValue={x.subject_type}>{SUBJECT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                    <div className="field"><label htmlFor={`sc-${x.id}`}>Category</label>
                      <select id={`sc-${x.id}`} name="category" defaultValue={x.category_id ?? ""}>
                        <option value="">None</option>
                        {categories.filter((c) => !c.archived_at || c.id === x.category_id).map((c) => <option key={c.id} value={c.id}>{c.name}{c.archived_at ? " (archived)" : ""}</option>)}
                      </select></div>
                    <div className="field"><label htmlFor={`se-${x.id}`}>External ID</label><input id={`se-${x.id}`} name="external_id" defaultValue={x.external_id ?? ""} maxLength={64} /></div>
                  </div>
                  <fieldset><legend>Usual locations <span className="hint">(helps build rosters; does not limit assessment)</span></legend>
                    {locations.filter((l) => !l.archived_at || x.location_ids.includes(l.id)).map((l) => (
                      <label key={l.id} className="check"><input type="checkbox" name="locations" value={l.id} defaultChecked={x.location_ids.includes(l.id)} /> {l.name}{l.archived_at ? " (archived)" : ""}</label>
                    ))}
                    {locations.length === 0 && <p className="muted small">No locations yet.</p>}
                  </fieldset>
                  <label className="check"><input type="checkbox" name="archived" defaultChecked={!!x.archived_at} /> Archived (kept in history, hidden from new sessions)</label>
                </div>
                <SubmitButton className="btn">Save subject</SubmitButton>
              </ActionForm>
              <ActionForm action={saveContact}>
                {wsInput}<input type="hidden" name="subject" value={x.id} />
                <div key={savedStateKey(x.contact?.name, x.contact?.phone, x.contact?.email, x.contact?.version ?? 0)}>
                  <input type="hidden" name="version" value={x.contact?.version ?? 0} />
                  <fieldset><legend>Private contact <span className="hint">(owners and admins only; leave all blank to remove)</span></legend>
                    <div className="grid">
                      <div className="field"><label htmlFor={`cn-${x.id}`}>Contact name</label><input id={`cn-${x.id}`} name="contact_name" defaultValue={x.contact?.name ?? ""} maxLength={120} autoComplete="off" /></div>
                      <div className="field"><label htmlFor={`cp-${x.id}`}>Phone</label><input id={`cp-${x.id}`} name="contact_phone" type="tel" defaultValue={x.contact?.phone ?? ""} maxLength={40} autoComplete="off" /></div>
                      <div className="field"><label htmlFor={`ce-${x.id}`}>Email</label><input id={`ce-${x.id}`} name="contact_email" type="email" defaultValue={x.contact?.email ?? ""} maxLength={254} autoComplete="off" /></div>
                    </div>
                  </fieldset>
                </div>
                <SubmitButton className="btn">Save contact</SubmitButton>
              </ActionForm>
            </div>
          </details>
        ))}
      </section>
    </>
  );
}
