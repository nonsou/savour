import {
  APP_GUIDE, APP_LIMITS, APP_PROVENANCE, APP_STATUS_LABELS, APP_ZERO_NOTICE, OP_LABELS, SUSTAINED_RULE, type AppEvaluation, type OpStatus,
} from "@/lib/application-outcomes";

const PATH = "/platform/operations";
const utc = (iso: string) => `${iso.replace("T", " ").slice(0, 19)} UTC`;
const hour = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00 UTC`;
const OP_STATUS: Record<OpStatus, string> = {
  sustained_failures: "Failures in two consecutive hours",
  failures_reported: "Failures reported",
  not_measured: "Not measured (nothing reported)",
  no_failures_reported: "No failures reported",
};

// M5 OPS02: inspection save and export outcome counts, kept visually and semantically separate from the
// billing checks above. Server component; no polling, no buttons that run anything. A missing or invalid
// snapshot is an error state, never zeros, and an operation with no reports is "not measured".
export function ApplicationOutcomes({ ev }: { ev: AppEvaluation }) {
  const s = ev.snapshot;
  const ok = ev.status === "no_failures_reported";
  return (
    <section className="card stack" aria-labelledby="app-h">
      <h2 id="app-h">Inspection saves and exports (user-reported counts)</h2>
      <p><strong>{APP_PROVENANCE}</strong></p>

      <div className={`notice ${ok ? "ok" : "sample"}`} role="status" aria-labelledby="app-status-h">
        <h3 id="app-status-h" style={{ color: "inherit" }}>{APP_STATUS_LABELS[ev.status]}</h3>
        {s ? (
          <p>Captured {utc(s.observed_at)} by the database clock. Window: {hour(s.window_start)} to now.</p>
        ) : (
          <p>No counts are shown. Save and export outcomes are not being reported here right now; do not read this as zero.</p>
        )}
        <p className="small">{APP_ZERO_NOTICE}</p>
        <p><a className="btn" href={PATH}>{s ? "Refresh" : "Retry"}</a></p>
      </div>

      {s && (
        <>
          <div className="table-wrap" role="region" aria-label="Reported outcomes by operation, last 24 hours" tabIndex={0}>
            <table className="small">
              <caption>Reported outcomes by operation, last 24 hours</caption>
              <thead><tr><th scope="col">Operation</th><th scope="col">Status</th><th scope="col">Success</th><th scope="col">Replayed</th>
                <th scope="col">Rejected</th><th scope="col">Failed</th><th scope="col">Latest report</th></tr></thead>
              <tbody>
                {ev.ops.map(({ counts: c, status }) => (
                  <tr key={c.op}>
                    <th scope="row">{OP_LABELS[c.op]} <span className="small muted">({c.op})</span></th>
                    <td>{OP_STATUS[status]}</td>
                    {status === "not_measured" ? (
                      <td colSpan={5}>not measured</td>
                    ) : (
                      <>
                        <td>{c.success}</td><td>{c.replayed}</td><td>{c.rejected}</td>
                        <td>{c.failed}{c.failed_hours.length > 0 && ` (hours: ${c.failed_hours.map((h) => h.slice(11, 13)).join(", ")})`}</td>
                        <td>{c.latest_reported_at ? utc(c.latest_reported_at) : "never"}{c.capped_buckets > 0 && ` (${c.capped_buckets} capped)`}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Detail stays one tap away so the counts are readable first; provenance and the no-health notice stay visible above. */}
      <details>
        <summary>What is and is not counted, the failure rule and storage limits</summary>
        <div className="stack">
          <ul className="small">{APP_LIMITS.map((x) => <li key={x}>{x}</li>)}</ul>
          <p className="small">{SUSTAINED_RULE}</p>
          {s && (
            <p className="small">Users reporting in the window {s.reporting_actors_24h}. Stored hourly buckets {s.stored_buckets} (each user keeps at most one per hour slot, operation and outcome; limit {s.bucket_cap} per bucket).</p>
          )}
        </div>
      </details>

      <section className="stack" aria-labelledby="app-guide-h">
        <h3 id="app-guide-h">What to do about save or export failures</h3>
        <ol className="small">{APP_GUIDE.map((step) => <li key={step}>{step}</li>)}</ol>
        <p className="small muted">This section only reads counts. No alert is sent and nothing can be retried or changed from here.</p>
      </section>
    </section>
  );
}
