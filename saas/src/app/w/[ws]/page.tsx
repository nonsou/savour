import Link from "next/link";
import { isManager, requireWorkspace } from "@/lib/auth";
import { SESSION_STATUS_LABELS } from "@/lib/labels";
import { formatLocalDate, overviewMetrics, setupChecklist, type Dashboard } from "@/lib/report";
import { formatPct, rollupByTemplate, summarizeSession } from "@/lib/scoring";

export const metadata = { title: "Overview — SAVOUR" };

export default async function Overview({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { supabase, ctx } = await requireWorkspace(ws);

  if (ctx.role === "assessor" || ctx.role === "guest") {
    const { data, error } = await supabase.from("sessions").select("id, name, local_date, status, closes_at")
      .eq("workspace_id", ws).order("local_date", { ascending: false });
    const rows = (data ?? []) as { id: string; name: string; local_date: string; status: string; closes_at: string }[];
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
            </Link>
          ))}
        </div>
      </>
    );
  }

  const [{ data, error }, checklist] = await Promise.all([
    supabase.rpc("get_dashboard", { p_ws: ws }),
    isManager(ctx.role) ? Promise.all(["locations", "subjects", "templates", "sessions"].map((t) =>
      supabase.from(t).select("id", { count: "exact", head: true }).eq("workspace_id", ws).then((r) => (r.error ? null : r.count ?? 0)))) : null,
  ]);
  const dash = error ? null : (data as Dashboard | null);
  const metrics = overviewMetrics(dash);
  const reports = metrics ? dash!.approved : [];
  const rollup = rollupByTemplate(reports.map((r) => r.inputs));
  const setup = checklist ? setupChecklist(checklist) : null;
  const steps: [string, number | null, string][] = checklist ? [
    ["Create a location", checklist[0], `/w/${ws}/setup`], ["Add subjects", checklist[1], `/w/${ws}/setup`],
    ["Publish a template (starter pack)", checklist[2], `/w/${ws}/templates`], ["Run a first session", checklist[3], `/w/${ws}/sessions/new`],
  ] : [];

  return (
    <>
      <div className="row between">
        <h1>Overview</h1>
        {reports.length > 0 && <a className="btn" href={`/w/${ws}/export`}>Download CSV</a>}
      </div>
      {setup && !setup.known && <p className="notice warn">Setup progress could not be checked. Reload to try again.</p>}
      {setup?.incomplete && (
        <section className="card highlight">
          <h2>Get started</h2>
          <ol>{steps.map(([label, n, href]) => <li key={label}>{n ? "✓ " : ""}<Link href={href}>{label}</Link></li>)}
            <li><Link href={`/w/${ws}/team`}>Invite a reviewer</Link></li></ol>
        </section>
      )}
      {!metrics && <p className="notice error" role="alert">Analytics are unavailable right now, so no figures are shown. Reload to try again.</p>}
      <p className="muted small">Approved current revisions only. Sessions under revision are listed separately and excluded. Timezone: {ctx.workspace.timezone}.</p>
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
                  <td>{formatPct(s.quality.mean, "No data")}</td>
                  <td>{s.coverage.pct === null ? "N/A" : `${s.coverage.complete}/${s.coverage.due}`}</td>
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
            <li key={u.session_id}><Link href={`/w/${ws}/sessions/${u.session_id}`}>{u.name}</Link> — {formatLocalDate(u.local_date)}, revision {u.revision}{u.reason ? ` (${u.reason})` : ""}</li>
          ))}</ul>
        </section>
      )}
    </>
  );
}
