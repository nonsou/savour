import Link from "next/link";
import { notFound } from "next/navigation";
import {
  buildAnalytics, filterSummary, filtersToQuery, formatMean, modeLabel, NOT_RECORDED, NOT_RECORDED_LABEL, PACK_LABELS, parseFilters,
  RULES, type AnalyticsDataset, type AnalyticsMode, type AnalyticsResult, type FlagSource,
} from "@/lib/analytics";
import { analyticsSections, FLAG_LABELS, FLAG_SOURCES, STATUS_LABELS, type Section } from "@/lib/analytics-export";
import { canReviewRole, canSeeReports, requireWorkspace } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";
import { formatDateTime, formatLocalDate } from "@/lib/report";
import { OUTCOME_LABELS } from "@/lib/scoring";

export const metadata = { title: "Analytics — SAVOUR" };

export default async function AnalyticsPage({ params, searchParams }: {
  params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ws } = await params;
  const sp = await searchParams;
  const { supabase, ctx } = await requireWorkspace(ws);
  if (!canSeeReports(ctx.role)) notFound();
  const reviewer = canReviewRole(ctx.role);
  const mode: AnalyticsMode = sp.mode === "provisional" && reviewer ? "provisional" : "approved";
  const { filters, ignored } = parseFilters(sp);
  const { data, error } = await supabase.rpc("get_analytics", { p_ws: ws, p_mode: mode, p_filters: filters, p_purpose: "view" });
  const ds = error ? null : (data as AnalyticsDataset);
  let result: AnalyticsResult | null = null;
  let problem: string | null = null;
  if (ds) {
    try { result = buildAnalytics(ds, filters); } catch (e) { problem = (e as Error).message; }
  }
  const sections = ds && result ? analyticsSections(ds, result) : [];
  const section = (title: string) => sections.find((s) => s.title === title);
  const q = (extra: Record<string, string> = {}) => filtersToQuery(filters, { ...(mode === "provisional" ? { mode } : {}), ...extra });
  const base = `/w/${ws}/analytics`;
  const sourceHref = (s: FlagSource) => s.actionId ? `/w/${ws}/actions/${s.actionId}`
    : s.findingId ? `/w/${ws}/sessions/${s.sessionId}` : s.sessionId ? `/w/${ws}/sessions/${s.sessionId}/report${s.revision ? `?revision=${s.revision}` : ""}` : null;
  const opt = ds?.options;

  return (
    <>
      <div className="row between">
        <h1>Analytics</h1>
        {ds && result && (
          <div className="row no-print">
            <a className="btn" href={`${base}/export?${q({ format: "csv" })}`}>Download CSV</a>
            <a className="btn" href={`${base}/export?${q({ format: "pdf" })}`}>Download PDF</a>
          </div>
        )}
      </div>
      {reviewer && (
        <nav className="row small" aria-label="Data mode">
          <Link className={`btn${mode === "approved" ? " primary" : ""}`} href={`${base}?${filtersToQuery(filters)}`} aria-current={mode === "approved" ? "page" : undefined}>Approved</Link>
          <Link className={`btn${mode === "provisional" ? " primary" : ""}`} href={`${base}?${filtersToQuery(filters, { mode: "provisional" })}`} aria-current={mode === "provisional" ? "page" : undefined}>Provisional (not approved)</Link>
        </nav>
      )}
      <p className={mode === "provisional" ? "notice warn" : "muted small"}>{modeLabel(mode)}</p>

      <details className="card no-print" open={Object.keys(filters).length > 0}>
        <summary><strong>Filters</strong> <span className="hint">{ds ? filterSummary(ds, filters, result ?? undefined) : ""}</span></summary>
        <form method="get" action={base} className="stack">
          {mode === "provisional" && <input type="hidden" name="mode" value="provisional" />}
          <div className="grid">
            <div className="field"><label htmlFor="f-from">From ({ctx.workspace.timezone} session date)</label><input id="f-from" name="from" type="date" defaultValue={filters.from} /></div>
            <div className="field"><label htmlFor="f-to">To</label><input id="f-to" name="to" type="date" defaultValue={filters.to} /></div>
            <div className="field"><label htmlFor="f-loc">Location</label>
              <select id="f-loc" name="location_id" defaultValue={filters.location_id ?? ""}><option value="">All locations</option>
                {opt?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
            <div className="field"><label htmlFor="f-pack">Pack</label>
              <select id="f-pack" name="pack" defaultValue={filters.pack ?? ""}><option value="">All packs</option>
                {opt?.packs.map((p) => <option key={p} value={p}>{PACK_LABELS[p] ?? p}</option>)}</select></div>
            <div className="field"><label htmlFor="f-tv">Template version</label>
              <select id="f-tv" name="template_version_id" defaultValue={filters.template_version_id ?? ""}><option value="">All versions</option>
                {opt?.template_versions.map((v) => <option key={v.id} value={v.id}>{v.name} v{v.version}</option>)}</select></div>
            <div className="field"><label htmlFor="f-cat">Category (as recorded at approval)</label>
              <select id="f-cat" name="category_id" defaultValue={filters.category_id ?? ""}><option value="">All categories</option>
                {result?.categoryOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div className="field"><label htmlFor="f-type">Subject type (as recorded at approval)</label>
              <select id="f-type" name="subject_type" defaultValue={filters.subject_type ?? ""}><option value="">All types</option>
                {result?.typeOptions.map((t) => <option key={t} value={t}>{t === NOT_RECORDED ? NOT_RECORDED_LABEL : t.replace(/_/g, " ")}</option>)}</select></div>
            <div className="field"><label htmlFor="f-sub">Subject</label>
              <select id="f-sub" name="subject_id" defaultValue={filters.subject_id ?? ""}><option value="">All subjects</option>
                {result?.subjectOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          </div>
          <div className="row"><button className="btn primary" type="submit">Apply filters</button>
            <Link className="btn" href={mode === "provisional" ? `${base}?mode=provisional` : base}>Clear</Link></div>
        </form>
      </details>

      {error && <p className="notice error" role="alert">{friendlyError(error)} No figures are shown.</p>}
      {problem && <p className="notice error" role="alert">{problem}</p>}
      {ignored.length > 0 && <p className="notice warn">Some filter values were not valid and were ignored: {ignored.join(", ")}.</p>}
      {ds?.truncated && <p className="notice warn">Only the latest 1,000 of {ds.total} sessions are included. Narrow the dates to see the rest.</p>}
      {result && result.unsupported.length > 0 && <p className="notice error">{result.unsupported.length} session(s) use a calculation this version cannot show and are left out.</p>}
      {result && result.excludedSamples > 0 && <p className="notice error">{result.excludedSamples} SAMPLE record(s) reached analytics and were excluded.</p>}

      {ds && result && (
        <>
          <p className="muted small">Generated {formatDateTime(ds.generated_at, ds.timezone)} · Filters: {filterSummary(ds, filters, result)} · Assessor identities are never shown in analytics.</p>
          <section className="stack" aria-labelledby="ov">
            <h2 id="ov">Overview</h2>
            {result.counts.subjectSessions === 0 && <p className="notice">No data for these filters. (No data is not the same as a zero score.)</p>}
            <div className="grid">
              <div className="card"><div className="stat">{result.sessions}</div><div>Sessions</div></div>
              <div className="card"><div className="stat">{result.counts.subjectSessions}</div><div>Subject-sessions ({result.counts.scored} scored)</div></div>
              <div className="card"><div className="stat">{result.coverage.pct === null ? "No data" : formatMean(result.coverage.pct)}</div>
                <div>Coverage {result.coverage.pct === null ? "" : `(${result.coverage.complete} of ${result.coverage.due})`}</div></div>
              <div className="card"><div className="stat">{result.attendance ? formatMean(result.attendance.rate) : "Off"}</div>
                <div>Attendance rate{result.attendance ? ` (${result.attendance.unknown} unknown)` : " — no attendance-on sessions"}</div></div>
            </div>
            <SectionTable s={section("Overview")} />
            <SectionTable s={section("By template version, formula and applicable criteria")} />
            {result.versionBreaks.length > 0 && <SectionTable s={section("Version breaks")} />}
          </section>

          <section className="stack" aria-labelledby="na">
            <h2 id="na">Needs attention</h2>
            {!result.attention.available ? <p className="notice">Needs attention uses approved data only. Switch to Approved to see flags.</p> : (
              <>
                <p className="small muted">{RULES.disclaimer}{!result.attention.liveFlags && " Open-finding and overdue-action flags are visible to reviewers only."}</p>
                {result.attention.flags.length === 0 && <p className="notice ok">No flags for these filters.</p>}
                {result.attention.flags.map((f, i) => (
                  <article key={`${f.kind}-${f.subjectId}-${i}`} className={`card flag flag-${f.kind}`}>
                    <h3>{FLAG_LABELS[f.kind]}: {f.subjectName} <span className="badge">{FLAG_SOURCES[f.kind]}</span></h3>
                    <p className="small">{f.detail}</p>
                    <details><summary className="small">Rule and sources</summary>
                      <p className="hint">{RULES[f.kind]}</p>
                      <ul className="small">{f.sources.map((s, j) => {
                        const href = sourceHref(s);
                        return <li key={j}>{href ? <Link href={href}>{s.label}</Link> : s.label}</li>;
                      })}</ul>
                    </details>
                  </article>
                ))}
                {result.attention.insufficient.length > 0 && (
                  <details className="card"><summary>Insufficient data for a rule ({result.attention.insufficient.length})</summary>
                    <ul className="small">{result.attention.insufficient.map((x, i) => <li key={i}>{FLAG_LABELS[x.kind]} — {x.subjectName}: {x.detail}</li>)}</ul>
                  </details>
                )}
              </>
            )}
          </section>

          <section className="stack" aria-labelledby="loc"><h2 id="loc">Location comparison</h2><SectionTable s={section("Locations")} /></section>
          <section className="stack" aria-labelledby="cat"><h2 id="cat">Category comparison</h2><SectionTable s={section("Categories")} /></section>

          <section className="stack" aria-labelledby="hist">
            <h2 id="hist">Subject history</h2>
            {!filters.subject_id && <p className="small muted">Choose a subject to see its full timeline. Each subject keeps a stable ID, so renames never split or merge its history.</p>}
            {result.histories.length === 0 && <p className="muted small">No subjects for these filters.</p>}
            {!filters.subject_id && result.histories.length > 0 && (
              <div className="table-wrap card"><table>
                <thead><tr><th>Subject</th><th>Sessions</th><th>Latest</th><th>Latest quality</th></tr></thead>
                <tbody>{result.histories.map((h) => {
                  const last = h.points[h.points.length - 1];
                  return (
                    <tr key={h.subjectId}>
                      <td><Link href={`${base}?${filtersToQuery({ ...filters, subject_id: h.subjectId }, mode === "provisional" ? { mode } : {})}#hist`}>{h.currentName ?? h.names[h.names.length - 1]}</Link>
                        {h.names.length > 1 && <div className="hint">Earlier names: {h.names.filter((x) => x !== h.currentName).join(", ")}</div>}</td>
                      <td>{h.points.length}</td><td>{formatLocalDate(last.localDate)}</td><td>{formatMean(last.quality)}</td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
            {filters.subject_id && result.histories.map((h) => (
              <div key={h.subjectId} className="card table-wrap">
                <h3>{h.currentName ?? h.names[h.names.length - 1]}{h.archived ? " (archived)" : ""}</h3>
                {h.names.some((x) => x !== h.currentName) && <p className="hint">Names at approval: {h.names.join(", ")}</p>}
                <table>
                  <thead><tr><th>Date</th><th>Session</th><th>Template</th><th>Status</th><th>Quality</th><th>Combined</th><th>Attendance</th></tr></thead>
                  <tbody>{h.points.map((p) => (
                    <tr key={`${p.sessionId}-${p.revision}`} className={p.versionBreak ? "version-break" : undefined}>
                      <td>{formatLocalDate(p.localDate)}{p.versionBreak && <div className="badge in_review">Version break</div>}</td>
                      <td><Link href={`/w/${ws}/sessions/${p.sessionId}/report${mode === "approved" ? `?revision=${p.revision}` : ""}`}>{p.sessionName}</Link> r{p.revision}
                        {p.nameAtApproval !== (h.currentName ?? p.nameAtApproval) && <div className="hint">as “{p.nameAtApproval}”</div>}</td>
                      <td>{p.templateLabel}<div className="hint">{p.formula}</div></td>
                      <td>{STATUS_LABELS[p.status]}</td><td>{formatMean(p.quality)}</td>
                      <td>{p.combined === null ? "—" : formatMean(p.combined)}</td>
                      <td>{p.attendanceMode === "off" ? "Off" : OUTCOME_LABELS[p.outcome]}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ))}
          </section>
        </>
      )}
    </>
  );
}

function SectionTable({ s }: { s: Section | undefined }) {
  if (!s) return null;
  return (
    <div className="card table-wrap">
      <h3>{s.title}</h3>
      {s.note && <p className="hint">{s.note}</p>}
      {s.rows.length === 0 ? <p className="muted small">None.</p> : (
        <table>
          <thead><tr>{s.header.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{s.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c === null ? "—" : String(c)}</td>)}</tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
