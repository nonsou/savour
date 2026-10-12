import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SimpleTopbar } from "@/components/topbar";
import { requireUser } from "@/lib/auth";
import {
  ACTIONS, actionAnchor, assess, CODES, DETECTION_NOTICE, errorEvaluation, INCIDENT_STEPS, MODES, NOT_INSTRUMENTED, OWNERSHIP, SCOPE_NOTICE,
  STATUS_LABELS, type ActionId, type ConnectionFacts, type Evaluation, type Finding,
} from "@/lib/operations";

export const metadata = { title: "Billing operations — SAVOUR" };
// Every load reads the database; nothing is cached or prerendered (valid because cacheComponents is off).
export const dynamic = "force-dynamic";

const PATH = "/platform/operations";

// Read-only founder view of billing worker and queue state. Access is the same database fact as
// /platform (a live platform.admins row); everyone else gets "not found". Only the two known actor codes
// are mapped; any other failure is shown as unavailable without its message. The guide, scope and
// ownership sections render on every load, including the error state.
export default async function OperationsPage() {
  const { supabase } = await requireUser(PATH);
  const { data, error } = await supabase.rpc("platform_operations_snapshot");
  if (error?.message === "forbidden") notFound();
  if (error?.message === "not_authenticated") redirect(`/login?next=${encodeURIComponent(PATH)}`);
  const ev: Evaluation = error ? errorEvaluation("SNAPSHOT_UNAVAILABLE") : assess(data);
  const s = ev.snapshot;
  return (
    <>
      <SimpleTopbar />
      <main className="container stack">
        <h1>Billing operations (read-only)</h1>
        <section className="card stack" aria-labelledby="scope-h">
          <h2 id="scope-h">What this page does and does not cover</h2>
          <p><strong>{DETECTION_NOTICE}</strong></p>
          <p>{SCOPE_NOTICE}</p>
          <p>Not instrumented (no data on this page):</p>
          <ul className="small">{NOT_INSTRUMENTED.map((x) => <li key={x}>{x}</li>)}</ul>
        </section>

        <section className={`notice ${ev.status === "within_thresholds" ? "ok" : "sample"}`} role="status" aria-labelledby="status-h">
          <h2 id="status-h">{STATUS_LABELS[ev.status]}</h2>
          {s ? (
            <p>Captured {utc(s.observed_at)} by the database clock. Refresh to read again.</p>
          ) : (
            <p>No snapshot is shown. Nothing on this page is current.</p>
          )}
          <p><a className="btn" href={PATH}>{s ? "Refresh" : "Retry"}</a></p>
        </section>

        {ev.findings.length > 0 && (
          <section className="card stack" aria-labelledby="find-h">
            <h2 id="find-h">Findings</h2>
            <ul className="stack">{ev.findings.map((f, i) => <FindingItem key={i} f={f} />)}</ul>
          </section>
        )}

        {s && (
          <>
            {s.connections.map((c) => <ConnectionCard key={c.id} c={c} />)}
            <section className="card stack" aria-labelledby="unassigned-h">
              <h2 id="unassigned-h">Review items without a connection</h2>
              <p className="small">Unresolved {s.unassigned_reviews.open}{s.unassigned_reviews.oldest_created_at && `, oldest ${utc(s.unassigned_reviews.oldest_created_at)}`}</p>
            </section>
          </>
        )}

        <section className="card stack" aria-labelledby="guide-h">
          <h2 id="guide-h">What to do</h2>
          <p className="small">Each finding links to its steps here. Nothing on this page changes billing or contacts anyone.</p>
          {(Object.keys(ACTIONS) as ActionId[]).map((id) => (
            <section key={id} className="stack" aria-labelledby={actionAnchor(id)}>
              <h3 id={actionAnchor(id)}>{ACTIONS[id].title}</h3>
              <ol className="small">{ACTIONS[id].steps.map((step) => <li key={step}>{step}</li>)}</ol>
            </section>
          ))}
          <section className="stack" aria-labelledby="guide-incident">
            <h3 id="guide-incident">Telling people about a problem</h3>
            <ol className="small">{INCIDENT_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
          </section>
        </section>

        <section className="card stack" aria-labelledby="own-h">
          <h2 id="own-h">Ownership</h2>
          <ul className="small">{OWNERSHIP.map((o) => <li key={o.role}>{o.role}: {o.value}</li>)}</ul>
          <p className="small muted">Placeholders stay UNASSIGNED until the owner names them. Outside alerts and customer messages are not set up.</p>
        </section>
        <p><Link href="/platform">Back to platform admin</Link></p>
      </main>
    </>
  );
}

const utc = (iso: string) => `${iso.replace("T", " ").slice(0, 19)} UTC`;
const shortId = (id: string) => id.slice(0, 8);

function FindingItem({ f }: { f: Finding }) {
  const c = CODES[f.code];
  return (
    <li>
      {c.message}{f.connection_id && ` Connection ${shortId(f.connection_id)}.`}{f.mode && ` Scheduled ${f.mode} run.`}{" "}
      <a href={`#${actionAnchor(c.action)}`}>What to do: {ACTIONS[c.action].title}</a>{" "}
      <span className="small muted">({f.code})</span>
    </li>
  );
}

function ConnectionCard({ c }: { c: ConnectionFacts }) {
  const w = c.webhook;
  const d = c.discovery;
  const caption = `Scheduled runs for ${c.provider_code} connection ${shortId(c.id)}`;
  return (
    <section className="card stack" aria-labelledby={`oc-${c.id}`}>
      <h2 id={`oc-${c.id}`}>{c.provider_code} connection {shortId(c.id)} <span className="badge">{c.status}</span></h2>
      <p className="small" style={{ overflowWrap: "anywhere" }}>ID <code className="mono">{c.id}</code>. {c.worker_required ? "Served by the billing worker (key stored)." : "Not served by the billing worker; run times not measured."}</p>
      <p className="small">Webhook inbox: pending {w.pending}, processing {w.processing} (expired leases {w.expired_leases}), failed {w.failed}
        {w.oldest_received_at && `, oldest received ${utc(w.oldest_received_at)}`}. Dead {c.webhook_dead}, quarantined {c.webhook_quarantined}.
        ID collisions in the last 24 hours {c.collisions_24h}.</p>
      <p className="small">Payment discovery: pending {d.pending}, processing {d.processing} (expired leases {d.expired_leases}), retry {d.retry}
        {d.oldest_first_seen_at && `, oldest first seen ${utc(d.oldest_first_seen_at)}`}. Dead {c.discovery_dead}.</p>
      <p className="small">Unresolved review items {c.reviews.open}{c.reviews.oldest_created_at && `, oldest ${utc(c.reviews.oldest_created_at)}`}.</p>
      {/* Six columns: scrolls inside its own region on narrow screens instead of widening the page. */}
      <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
        <table className="small">
          <caption>{caption}</caption>
          <thead><tr><th scope="col">Mode</th><th scope="col">Latest finished</th><th scope="col">Outcome</th><th scope="col">Latest success</th><th scope="col">Unfinished (oldest start)</th><th scope="col">Failed / partial, 24 h</th></tr></thead>
          <tbody>
            {MODES.map((m) => {
              const r = c.runs[m];
              return (
                <tr key={m}>
                  <th scope="row">{m}</th><td>{r.latest_finished_at ? utc(r.latest_finished_at) : "never"}</td><td>{r.latest_outcome}</td>
                  <td>{r.latest_success_at ? utc(r.latest_success_at) : "never"}</td>
                  <td>{r.unfinished}{r.oldest_unfinished_started_at && ` (${utc(r.oldest_unfinished_started_at)})`}</td>
                  <td>{r.failed_24h} / {r.partial_24h}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
