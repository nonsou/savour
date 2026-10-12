import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { SimpleTopbar } from "@/components/topbar";
import { requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/report";
import { MfaPanel, type Factor } from "../w/[ws]/security/mfa";
import { createConnection, disableConnection, enableConnection, proposePrice, setDefault, setExpectedOrg } from "./actions";
import { SecretForm, TestButton } from "./secret-form";

export const metadata = { title: "Platform admin — SAVOUR" };

interface Connection {
  id: string; provider_code: string; label: string; status: string; accepting_new: boolean; version: number;
  credential: { configured: boolean; version: number; fingerprint: string | null; stored_at: string | null; pending: boolean; pending_fingerprint: string | null; previous_retire_after: string | null };
  webhook_secret: { configured: boolean; version: number; fingerprint: string | null; previous_valid_until: string | null };
  expected_organization_id: string | null; ngn_recurring_verified: boolean; last_test_passed_at: string | null;
  tests: { id: string; status: string; credential_version: number; organization_matched: boolean | null; checks: Record<string, string>; started_at: string }[];
  prices: { id: string; currency: string; version: number; status: string; amount: string; provider_product_id: string; recurring_capability: string }[];
  pinned_subscriptions: number; pending_checkouts: number;
}
interface Overview {
  admin: { aal: string }; providers: { code: string; display_name: string; adapter_status: string; adapter_version: string | null; note: string }[];
  connections: Connection[]; default_connection_id: string | null; settings_version: number;
  audit: { action: string; connection_id: string | null; aal: string | null; fingerprint: string | null; created_at: string }[];
}

// Founder-only provider administration, separate from every business dashboard. Access is a database
// fact (platform.admins, enrolled by the database owner); workspace Owners and Admins get "not found".
export default async function PlatformPage() {
  const { supabase } = await requireUser("/platform");
  const { data, error } = await supabase.rpc("platform_overview");
  if (error) notFound();
  const o = data as Overview;
  const tz = "UTC";
  const mfa = o.admin.aal === "aal2";
  const [factors, aal] = mfa ? [null, null] : await Promise.all([supabase.auth.mfa.listFactors(), supabase.auth.mfa.getAuthenticatorAssuranceLevel()]);
  const available = o.providers.filter((p) => p.adapter_status === "available");
  return (
    <>
      <SimpleTopbar />
      <main className="container stack">
        <h1>Platform admin: payment providers</h1>
        <p className="notice sample">Sandbox only. No live keys are accepted and nothing here activates live payments. Times in UTC.</p>
        <p><Link href="/platform/operations">Billing operations monitor (read-only)</Link></p>
        {mfa ? (
          <p className="notice ok" role="status">Two-step verification: verified for this session.</p>
        ) : (
          <section className="card stack">
            <h2>Two-step verification required for changes</h2>
            <p>You can read this page now. Storing credentials, testing, enabling, disabling, pricing and changing the default all require a verified authenticator code in this session.</p>
            <MfaPanel initialFactors={(factors?.data?.totp ?? []) as Factor[]} initialAal={aal?.data?.currentLevel ?? null} />
          </section>
        )}

        <section className="card stack" aria-labelledby="reg-h">
          <h2 id="reg-h">Supported providers</h2>
          <ul>
            {o.providers.map((p) => (
              <li key={p.code}><strong>{p.display_name}</strong>: {p.adapter_status === "available" ? `adapter ${p.adapter_version} (sandbox)` : "integration not built yet"}. <span className="small muted">{p.note}</span></li>
            ))}
          </ul>
          <p className="small muted">A provider becomes connectable only after its adapter, contract tests and real sandbox checks ship in code. Entering an arbitrary key or URL here can never connect a new provider.</p>
          <ActionForm action={createConnection}>
            <div className="field"><label htmlFor="provider">Provider</label>
              <select id="provider" name="provider">{available.map((p) => <option key={p.code} value={p.code}>{p.display_name}</option>)}</select></div>
            <div className="field"><label htmlFor="label">Label</label><input id="label" name="label" required maxLength={80} /></div>
            <SubmitButton>Create connection</SubmitButton>
          </ActionForm>
        </section>

        <section className="card stack" aria-labelledby="def-h">
          <h2 id="def-h">Default for new checkouts</h2>
          <p>{o.default_connection_id ? o.connections.find((c) => c.id === o.default_connection_id)?.label : "None: businesses cannot subscribe."} Changing it affects new checkouts only; existing subscriptions keep renewing on their own connection.</p>
          <ActionForm action={setDefault}>
            <input type="hidden" name="version" value={o.settings_version} />
            <div className="field"><label htmlFor="default">Connection</label>
              {/* Keyed by the settings version: React keeps an uncontrolled select's first default and the
                  post-action form reset restores it, so a saved default would otherwise show as the old one.
                  Only the select remounts; the form and its success message stay. */}
              <select key={o.settings_version} id="default" name="connection" defaultValue={o.default_connection_id ?? ""}>
                <option value="">None</option>
                {o.connections.filter((c) => c.status === "enabled").map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select></div>
            <SubmitButton>Save default</SubmitButton>
          </ActionForm>
        </section>

        {o.connections.map((c) => (
          <section key={c.id} className="card stack" aria-labelledby={`c-${c.id}`}>
            <h2 id={`c-${c.id}`}>{c.label} <span className="badge">{c.status}</span>{c.accepting_new && <span className="badge open">accepting new</span>}</h2>
            <p className="small">API key: {c.credential.configured ? `Stored and verified · version ${c.credential.version}, fingerprint ${c.credential.fingerprint}`
              : c.credential.pending ? `Stored — awaiting verification · fingerprint ${c.credential.pending_fingerprint}` : "Not added"}
              {c.credential.configured && c.credential.pending && ` · replacement ${c.credential.pending_fingerprint} stored — awaiting verification`}
              {c.credential.previous_retire_after && ` · previous key retained until ${formatDateTime(c.credential.previous_retire_after, tz)}`}.
              Webhook secret: {c.webhook_secret.configured ? `Stored · version ${c.webhook_secret.version}, fingerprint ${c.webhook_secret.fingerprint}` : "Not added"}
              {c.webhook_secret.previous_valid_until && ` · previous secret valid until ${formatDateTime(c.webhook_secret.previous_valid_until, tz)}`}.
              NGN monthly card billing: {c.ngn_recurring_verified ? "verified" : "not verified"}. Pinned subscriptions {c.pinned_subscriptions}, pending checkouts {c.pending_checkouts}.</p>
            <div className="grid">
              <SecretForm connectionId={c.id} version={c.version} kind="api_key" stored={c.credential.configured || c.credential.pending}
                nextRotationAfter={c.credential.previous_retire_after && new Date(c.credential.previous_retire_after) > new Date() ? formatDateTime(c.credential.previous_retire_after, tz) : null} />
              <SecretForm connectionId={c.id} version={c.version} kind="webhook_secret" stored={c.webhook_secret.configured}
                nextRotationAfter={c.webhook_secret.previous_valid_until && new Date(c.webhook_secret.previous_valid_until) > new Date() ? formatDateTime(c.webhook_secret.previous_valid_until, tz) : null} />
            </div>
            <p className="small muted">Webhook endpoint to register in the Bachs developer portal: <code className="mono">/functions/v1/bachs-webhook?connection={c.id}</code> on the Supabase project.</p>
            <ActionForm action={setExpectedOrg}>
              <input type="hidden" name="connection" value={c.id} /><input type="hidden" name="version" value={c.version} />
              <div className="field"><label htmlFor={`org-${c.id}`}>Expected Bachs account ID</label>
                <input id={`org-${c.id}`} name="org" defaultValue={c.expected_organization_id ?? ""} required maxLength={128} /></div>
              <SubmitButton className="btn">Save account ID</SubmitButton>
            </ActionForm>
            <TestButton connectionId={c.id} />
            {c.tests[0] && <p className="small">Last test: {c.tests[0].status} ({formatDateTime(c.tests[0].started_at, tz)}) · {Object.entries(c.tests[0].checks).map(([k, v]) => `${k} ${v}`).join(", ")}</p>}
            <h3>Prices (Business, monthly)</h3>
            <ul>{c.prices.map((p) => <li key={p.id}>{p.currency} {p.amount} · product {p.provider_product_id} · {p.status} · recurring {p.recurring_capability}</li>)}</ul>
            <ActionForm action={proposePrice}>
              <input type="hidden" name="connection" value={c.id} />
              <div className="row">
                <div className="field"><label htmlFor={`cur-${c.id}`}>Currency</label><select id={`cur-${c.id}`} name="currency"><option>USD</option><option>NGN</option></select></div>
                <div className="field"><label htmlFor={`amt-${c.id}`}>Amount</label><input id={`amt-${c.id}`} name="amount" inputMode="decimal" placeholder="29.00" required /></div>
                <div className="field"><label htmlFor={`prod-${c.id}`}>Bachs product ID</label><input id={`prod-${c.id}`} name="product" required maxLength={128} /></div>
              </div>
              <p className="hint">A sandbox proposal for testing, not an approved price. NGN stays unavailable until monthly naira card billing is verified with real account evidence.</p>
              <SubmitButton className="btn">Propose price</SubmitButton>
            </ActionForm>
            <div className="row">
              {c.status !== "enabled" && (
                <ActionForm action={enableConnection}><input type="hidden" name="connection" value={c.id} /><input type="hidden" name="version" value={c.version} />
                  <SubmitButton className="btn primary">Enable for new checkouts</SubmitButton></ActionForm>
              )}
              {c.status === "enabled" && (
                <ActionForm action={disableConnection}><input type="hidden" name="connection" value={c.id} /><input type="hidden" name="version" value={c.version} />
                  <label className="check"><input type="checkbox" name="confirm" /> Stop new checkouts (existing subscriptions keep renewing and are still verified)</label>
                  <SubmitButton className="btn danger">Disable</SubmitButton></ActionForm>
              )}
            </div>
          </section>
        ))}

        <section className="card stack" aria-labelledby="audit-h">
          <h2 id="audit-h">Audit (latest 50)</h2>
          <ul className="small">{o.audit.map((a, i) => <li key={i}>{formatDateTime(a.created_at, tz)} · {a.action}{a.fingerprint ? ` · ${a.fingerprint}` : ""}{a.aal ? ` · ${a.aal}` : ""}</li>)}</ul>
        </section>
        <p><Link href="/workspaces">Back to businesses</Link></p>
      </main>
    </>
  );
}
