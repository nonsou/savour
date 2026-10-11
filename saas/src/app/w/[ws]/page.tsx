import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { isManager, requireWorkspace } from "@/lib/auth";
import { ATTENDANCE_MODE_LABELS, SESSION_STATUS_LABELS } from "@/lib/labels";
import { formatLocalDate, overviewMetrics, partitionReports, setupSteps, type Dashboard, type SetupProgress } from "@/lib/report";
import { formatPct, rollupByTemplate, summarizeSession } from "@/lib/scoring";
import { createSample } from "./sessions/actions";

interface Tpl { id: string; name: string; latest_version: number; template_versions: { id: string; version: number; attendance_mode: string }[] }

export const metadata = { title: "Overview — SAVOUR" };

export default async function Overview({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { supabase, ctx } = await requireWorkspace(ws);

  if (ctx.role === "assessor" || ctx.role === "guest") {
    const { data, error } = await supabase.from("sessions").select("id, name, local_date, status, closes_at, is_sample")
      .eq("workspace_id", ws).order("local_date", { ascending: false });
    const rows = (data ?? []) as { id: string; name: string; local_date: string; status: string; closes_at: string; is_sample: boolean }[];
    return (
      <>
        <h1>My sessions</h1>
        {error && <p className="notice error">Could not load your sessions. Reload to try again.</p>}
        {!error && rows.length === 0 && <p className="notice">You have no assigned sessions right now.</p>}
        <div className="grid">
          {rows.map((r) => (
            <Link key={r.id} href={`/w/${ws}/sessions/${r.id}`} className="card" style={{ color: "inherit", textDecoration: "none" }}>
              <h2>{r.name}</h2>
              <p className="small muted">{formatLocalDate(r.local_date)}</p>
              <span className={`badge ${r.status}`}>{SESSION_STATUS_LABELS[r.status]}</span>
              {r.is_sample && <span className="badge sample"> SAMPLE</span>}
            </Link>
          ))}
        </div>
      </>
    );
  }

  const manager = isManager(ctx.role);
  const [{ data, error }, progressRes, tplRes, locRes] = await Promise.all([
    supabase.rpc("get_dashboard", { p_ws: ws }),
    manager ? supabase.rpc("get_setup_progress", { p_ws: ws }) : null,
    manager ? supabase.from("templates").select("id, name, latest_version, template_versions(id, version, attendance_mode)").eq("workspace_id", ws).order("name") : null,
    manager ? supabase.from("locations").select("id, name").eq("workspace_id", ws).is("archived_at", null).order("name") : null,
  ]);
  const dash = error ? null : (data as Dashboard | null);
  const metrics = overviewMetrics(dash);
  const parts = metrics ? partitionReports(dash!.approved) : null;
  const reports = parts?.business ?? [];
  const rollup = rollupByTemplate(reports.map((r) => r.inputs));
  const progress = progressRes && !progressRes.error ? (progressRes.data as SetupProgress) : null;
  const steps = progress ? setupSteps(progress, ws) : [];
  const setupIncomplete = steps.some((x) => !x.done && !x.optional);
  const versions = ((tplRes?.data ?? []) as Tpl[]).flatMap((t) => {
    const v = t.template_versions.find((x) => x.version === t.latest_version);
    return v ? [{ id: v.id, label: `${t.name} v${v.version} — ${ATTENDANCE_MODE_LABELS[v.attendance_mode]}` }] : [];
  });
  const locations = (locRes?.data ?? []) as { id: string; name: string }[];

  return (
    <>
      <div className="row between">
        <h1>Overview</h1>
        {reports.length > 0 && <a className="btn" href={`/w/${ws}/export`}>Download CSV</a>}
      </div>
      {manager && progressRes?.error && <p className="notice warn">Setup progress could not be checked. Reload to try again.</p>}
      {setupIncomplete && (
        <section className="card highlight">
          <h2>Get started</h2>
          <ul className="steps">{steps.map((x) => (
            <li key={x.key}><span className={x.done ? "done" : "muted"} aria-hidden="true">{x.done ? "✓" : "○"}</span>
              <Link href={x.href}>{x.label}</Link>{x.optional && <span className="hint">optional</span>}
              <span className="sr-only">{x.done ? "done" : "not done"}</span></li>
          ))}</ul>
        </section>
      )}
      {manager && progress && (
        <section className="card stack">
          <h2>Practice inspection</h2>
          <p className="small">Creates a <strong>SAMPLE</strong> session with two practice subjects suited to the template. You are the assessor and
            reviewer, so you can try assessment, review, approval and reports. Samples never count in totals, dashboards or setup progress.</p>
          {progress.samples.latest_session_id && <p className="small"><Link href={`/w/${ws}/sessions/${progress.samples.latest_session_id}`}>Open your latest sample</Link>
            {" "}({progress.samples.sessions} sample session(s), {progress.samples.approved} approved)</p>}
          {versions.length && locations.length ? (
            <ActionForm action={createSample}>
              <input type="hidden" name="ws" value={ws} />
              <div className="grid">
                <div className="field"><label htmlFor="sample-tpl">Template</label>
                  <select id="sample-tpl" name="template_version" required>{versions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></div>
                <div className="field"><label htmlFor="sample-loc">Location</label>
                  <select id="sample-loc" name="location" required>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
              </div>
              <SubmitButton className="btn" pendingText="Creating sample…">Start a SAMPLE inspection</SubmitButton>
            </ActionForm>
          ) : <p className="muted small">Add a location and install a starter pack first.</p>}
        </section>
      )}
      {!metrics && <p className="notice error" role="alert">Analytics are unavailable right now, so no figures are shown. Reload to try again.</p>}
      {(parts?.unsupported.length ?? 0) > 0 && <p className="notice error" role="alert">{parts!.unsupported.length} approved report(s) use a calculation this version cannot show. They are left out of every figure below.</p>}
      <p className="muted small">Approved current revisions only. Sessions under revision and SAMPLE practice sessions are excluded. Timezone: {ctx.workspace.timezone}.</p>
      <div className="grid">
        <div className="card"><div className="stat">{metrics?.approved ?? "—"}</div><div>Approved sessions</div></div>
        <div className="card"><div className="stat">{metrics?.subjectsScored ?? "—"}</div><div>Distinct subjects with a quality score</div></div>
        <div className="card"><div className="stat">{metrics?.underRevision ?? "—"}</div><div>Under revision (excluded)</div></div>
      </div>
      {metrics?.approved === 0 && <p className="notice">No approved sessions yet. Results appear here after a reviewer approves a session.</p>}
      {rollup.length > 0 && (
        <section className="card table-wrap">
          <h2>By template version (like-for-like)</h2>
          <table>
            <thead><tr><th>Template</th><th>Sessions</th><th>Subject-sessions</th><th>Mean quality</th><th>Mean combined</th><th>Attendance rate</th></tr></thead>
            <tbody>{rollup.map((r) => (
              <tr key={r.templateVersionId}><td>{r.label}</td><td>{r.sessions}</td><td>{r.subjectSessions}</td>
                <td>{formatPct(r.quality, "No data")}</td>
                <td>{r.attendanceMode === "scored" ? formatPct(r.combined, "No data") : "—"}</td>
                <td>{r.attendanceMode === "off" ? "—" : formatPct(r.attendanceRate, "No data")}</td></tr>
            ))}</tbody>
          </table>
        </section>
      )}
      {reports.length > 0 && (
        <section className="card table-wrap">
          <h2>Approved sessions</h2>
          <table>
            <thead><tr><th>Session</th><th>Date</th><th>Quality</th><th>Coverage</th><th>Revision</th></tr></thead>
            <tbody>{reports.map((r) => {
              const s = summarizeSession(r.inputs);
              return (
                <tr key={r.session_id}>
                  <td><Link href={`/w/${ws}/sessions/${r.session_id}/report`}>{r.inputs.session.name}</Link></td>
                  <td>{formatLocalDate(r.inputs.session.local_date)}</td>
                  <td>{s.attendanceOnly ? "Attendance only" : formatPct(s.quality.mean, "No data")}</td>
                  <td>{s.coverage.pct === null ? "N/A" : `${s.coverage.complete}/${s.coverage.due}`}{s.coverage.waivedSubjects ? <div className="hint">{s.coverage.waivedSubjects} with waived work</div> : null}</td>
                  <td>r{r.revision}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </section>
      )}
      {(dash?.under_revision.length ?? 0) > 0 && (
        <section className="card">
          <h2>Under revision</h2>
          <ul>{dash!.under_revision.map((u) => (
            <li key={u.session_id}><Link href={`/w/${ws}/sessions/${u.session_id}`}>{u.name}</Link> — {formatLocalDate(u.local_date)}, revision {u.revision}{u.status === "open" ? ", collection reopened" : ""}{u.reason ? ` (${u.reason})` : ""}</li>
          ))}</ul>
        </section>
      )}
    </>
  );
}
