import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SimpleTopbar } from "@/components/topbar";
import { requireUser } from "@/lib/auth";
import {
  ALERT_TEXT, automaticChecksConfirmed, CHECK_FAILING, DETAILS, FRESHNESS_LABELS, GUIDE_APP, GUIDE_BILLING, JOB_LABELS, NO_ALERTS_ACTIVE,
  opLabel, PROVENANCE, SOURCE_LABELS, SUSTAINED_FLAG, validateAlerts, type AlertRow, type AlertsView, type Source, type SourceStatus,
} from "@/lib/operations-alerts";

export const metadata = { title: "Operational alerts — SAVOUR" };
// Every load reads the database; nothing is cached or prerendered (valid because cacheComponents is off).
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const PATH = "/platform/alerts";

// Read-only founder view of the internal alert state. Access is the same database fact as /platform (a live
// platform.admins row); everyone else gets "not found". Nothing here evaluates, acknowledges or changes anything:
// the only interaction is a plain GET reload. Unavailable or invalid data is an error state, never "no alerts".
export default async function AlertsPage() {
  const { supabase } = await requireUser(PATH);
  const { data, error } = await supabase.rpc("platform_operations_alerts");
  if (error?.message === "forbidden") notFound();
  if (error?.message === "not_authenticated") redirect(`/login?next=${encodeURIComponent(PATH)}`);
  const checked = error ? null : validateAlerts(data);
  const v = checked?.ok ? checked.view : null;
  return (
    <>
      <SimpleTopbar />
      <main className="container stack">
        <h1>Operational alerts</h1>
        <section className="notice sample stack" aria-labelledby="prov-h">
          <h2 id="prov-h" style={{ color: "inherit" }}>Who sees this and what it does not do</h2>
          <ul className="small">{PROVENANCE.map((x) => <li key={x}>{x}</li>)}</ul>
        </section>

        {v ? <Status v={v} /> : (
          <section className="notice error" role="status" aria-labelledby="status-h">
            <h2 id="status-h" style={{ color: "inherit" }}>{error ? "Alerts could not be read" : "Alert data unusable"}</h2>
            <p>{error ? "Nothing below is current. Do not read this as no warnings." : "The alert data did not match the expected shape, so none of it is shown. Do not read this as no warnings."}</p>
            <p><a className="btn" href={PATH}>Retry</a></p>
          </section>
        )}

        {v && <Alerts v={v} />}

        <section className="card stack" aria-labelledby="guide-h">
          <h2 id="guide-h">What to do</h2>
          <section className="stack" aria-labelledby="guide-billing">
            <h3 id="guide-billing">Billing warnings</h3>
            <ol className="small">{GUIDE_BILLING.map((x) => <li key={x}>{x}</li>)}</ol>
          </section>
          <section className="stack" aria-labelledby="guide-app">
            <h3 id="guide-app">Save and export warnings</h3>
            <ol className="small">{GUIDE_APP.map((x) => <li key={x}>{x}</li>)}</ol>
          </section>
          <p className="small muted">No warning is escalated automatically and nothing on this page contacts anyone.</p>
        </section>

        <details>
          <summary>How these checks work and what they cannot tell you</summary>
          <ul className="small stack">{DETAILS.map((x) => <li key={x}>{x}</li>)}</ul>
        </details>

        <div className="row">
          <Link className="btn" href="/platform/operations">Operations monitor</Link>
          <Link className="btn" href="/platform">Back to platform admin</Link>
        </div>
      </main>
    </>
  );
}

const utc = (iso: string) => `${iso.replace("T", " ").slice(0, 19)} UTC`;
const at = (iso: string | null) => (iso ? utc(iso) : "never");

function Status({ v }: { v: AlertsView }) {
  const h = v.heartbeat;
  const confirmed = automaticChecksConfirmed(v);
  return (
    <section className={h.cron_freshness === "fresh" ? "notice stack" : "notice sample stack"} role="status" aria-labelledby="status-h">
      <h2 id="status-h" style={{ color: "inherit" }}>{FRESHNESS_LABELS[h.cron_freshness]}</h2>
      <p>{confirmed
        ? "Automatic checks: the schedule entry is active and the latest scheduled run read both sources in the last 10 minutes. It still sends nothing."
        : "Automatic checks are not confirmed right now, so the warnings below may be out of date."}</p>
      <ul className="small">
        <li>{JOB_LABELS[v.scheduler_job]}</li>
        <li>Latest scheduled run: {at(h.last_cron_attempted_at)}. Latest scheduled run that read both sources: {at(h.last_cron_completed_at)}.</li>
        <li>Latest check by hand: {at(h.last_manual_attempted_at)}. A check by hand never counts as a scheduled run.</li>
      </ul>
      <SourceCheck source="billing_authoritative" status={h.billing_status} okAt={h.billing_ok_at} />
      <SourceCheck source="app_unverified" status={h.app_status} okAt={h.app_ok_at} />
      <p className="small">Read {utc(v.observed_at)} by the database clock.</p>
      <p><a className="btn" href={PATH}>Refresh</a></p>
    </section>
  );
}

function SourceCheck({ source, status, okAt }: { source: Source; status: SourceStatus | null; okAt: string | null }) {
  return (
    <div className="stack">
      <p className="small"><strong>{SOURCE_LABELS[source]}:</strong>{" "}
        {status === null ? "never checked." : status === "ok" ? "read in the latest check." : "failing in the latest check."}{" "}
        Last read successfully: {at(okAt)}.</p>
      {status === "unavailable" && <p className="small"><strong>{CHECK_FAILING}</strong></p>}
    </div>
  );
}

function Alerts({ v }: { v: AlertsView }) {
  const active = v.alerts.filter((a) => a.active);
  const past = v.alerts.filter((a) => !a.active);
  return (
    <>
      {v.alerts_truncated && (
        <p className="notice sample" role="note">Showing {v.alerts.length} of {v.alerts_total} stored warnings ({v.alerts_active} active). Active and high warnings are listed first.</p>
      )}
      <section className="card stack" aria-labelledby="active-h">
        <h2 id="active-h">Active warnings ({v.alerts_active})</h2>
        {active.length === 0 ? <p className="small">{NO_ALERTS_ACTIVE}</p> : (
          <ul className="stack">{active.map((a) => <AlertCard key={`${a.code}:${a.connection_id ?? a.op}`} a={a} />)}</ul>
        )}
      </section>
      {past.length > 0 && (
        <section className="card stack" aria-labelledby="past-h">
          <h2 id="past-h">No longer observed</h2>
          <p className="small">Kept for reference. For saves and exports this means no longer reported, not confirmed fixed.</p>
          <ul className="stack">{past.map((a) => <AlertCard key={`${a.code}:${a.connection_id ?? a.op}`} a={a} />)}</ul>
        </section>
      )}
    </>
  );
}

function AlertCard({ a }: { a: AlertRow }) {
  const t = ALERT_TEXT[a.code];
  const billing = a.source === "billing_authoritative";
  return (
    <li className="card stack">
      <h3 className="row">{t.title} <span className="badge">{a.severity === "high" ? "High" : "Warning"}</span> <span className="badge">{SOURCE_LABELS[a.source]}</span></h3>
      <p className="small" style={{ overflowWrap: "anywhere" }}>
        {billing ? <>Connection <code className="mono">{a.connection_id}</code></> : <>{opLabel(a.op!)}</>}
      </p>
      <p className="small">{t.message}</p>
      {!billing && a.severity === "high" && <p className="small">{SUSTAINED_FLAG}</p>}
      {a.active ? (
        <p className="small">Active since {utc(a.last_changed_at)}. Last seen {utc(a.last_seen_at)}.</p>
      ) : billing ? (
        <p className="small">No longer observed: a billing check at {utc(a.cleared_at!)} found this condition absent.</p>
      ) : (
        <p className="small">No longer reported: a check at {utc(a.cleared_at!)} found no failures reported in the current window. This is not confirmed recovery.</p>
      )}
      {a.unobserved_since && (
        <p className="small"><strong>This connection has not been listed in billing checks since {utc(a.unobserved_since)}. The warning is kept as it was, not cleared.</strong></p>
      )}
      <p className="small">
        {billing ? `Waiting items at last sighting ${a.observed_count}, oldest from ${utc(a.observed_oldest_at)}.`
          : `Failures reported at last sighting ${a.observed_count}, earliest failed hour ${utc(a.observed_oldest_at)}.`}{" "}
        First seen {utc(a.first_seen_at)}. Became active {a.episode_count} {a.episode_count === 1 ? "time" : "times"}.
      </p>
      <p><a className="btn" href={t.guide}>What to do</a></p>
    </li>
  );
}
