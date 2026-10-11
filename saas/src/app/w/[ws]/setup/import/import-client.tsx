"use client";

import { useState } from "react";
import type { ImportPlan, ImportReceipt } from "@/lib/csv-import";
import { commitImport, previewImport } from "../actions";

type Phase = "idle" | "checking" | "checked" | "importing" | "imported" | "failed";
const ACTION_LABELS = { create: "New", update: "Update", unchanged: "No change", error: "Error" } as const;

export function ImportClient({ ws }: { ws: string }) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  // The preview belongs to exactly the text it checked; editing the text discards it.
  const [preview, setPreview] = useState<{ plan: ImportPlan; text: string; key: string; skipped: number } | null>(null);
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const busy = phase === "checking" || phase === "importing";

  function edit(next: string) {
    setText(next);
    if (preview && next !== preview.text) { setPreview(null); setConfirmed(false); setPhase("idle"); setMessage("The file changed. Check it again."); }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 512 * 1024) { setMessage("The file is larger than 512 KB."); return; }
    edit(await file.text());
  }

  async function check() {
    setPhase("checking"); setMessage(null); setReceipt(null); setConfirmed(false);
    try {
      const r = await previewImport(ws, text);
      if (!r.ok) { setPreview(null); setPhase("failed"); setMessage(r.error); return; }
      // A fresh idempotency key per checked file: a retry of this import reuses it.
      setPreview({ plan: r.plan, text, key: crypto.randomUUID(), skipped: r.skippedBlank });
      setPhase("checked");
    } catch {
      setPhase("failed"); setMessage("Could not reach the server. Nothing was saved. Try again.");
    }
  }

  async function commit() {
    if (!preview) return;
    setPhase("importing"); setMessage(null);
    try {
      const r = await commitImport(ws, preview.text, preview.key, preview.plan.plan_hash);
      if (r.ok) { setReceipt(r.receipt); setPhase("imported"); return; }
      if (r.code === "stale_preview" || r.code === "import_invalid") setPreview(null);
      setPhase("failed"); setMessage(r.error);
    } catch {
      setPhase("failed");
      setMessage("Could not reach the server, so the result is unknown. Press Import again: the same file and check cannot be imported twice.");
    }
  }

  const plan = preview?.plan;
  const n = plan ? plan.counts.create + plan.counts.update : 0;
  return (
    <section className="card stack">
      <div className="field">
        <label htmlFor="csv-file">CSV file</label>
        <input id="csv-file" type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => void onFile(e.target.files?.[0])} />
      </div>
      <div className="field">
        <label htmlFor="csv-text">Or paste CSV text</label>
        <textarea id="csv-text" value={text} disabled={busy} rows={8} spellCheck={false} onChange={(e) => edit(e.target.value)} />
      </div>
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || !text.trim()} aria-busy={phase === "checking"} onClick={() => void check()}>
          {phase === "checking" ? "Checking…" : "Check file"}
        </button>
      </div>
      <div aria-live="polite" role="status">
        {message && <p className={`notice ${phase === "failed" ? "error" : "warn"}`}>{message}</p>}
        {receipt && (
          <p className="notice ok">
            {receipt.replayed ? "Already imported (confirmed earlier attempt): " : "Imported: "}
            {receipt.created} new, {receipt.updated} updated, {receipt.unchanged} unchanged.
          </p>
        )}
      </div>
      {plan && (
        <>
          <p className="small">
            {plan.counts.create} new · {plan.counts.update} update · {plan.counts.unchanged} unchanged · <strong>{plan.counts.error} with errors</strong>
            {preview!.skipped ? ` · ${preview!.skipped} blank row(s) skipped` : ""}
          </p>
          <div className="table-wrap">
            <table className="import-table">
              <thead><tr><th>Line</th><th>Result</th><th>Name</th><th>Details</th></tr></thead>
              <tbody>
                {plan.rows.map((r) => (
                  <tr key={r.line}>
                    <td>{r.line}</td>
                    <td><span className={`badge ${r.action === "error" ? "cancelled" : r.action === "update" ? "in_review" : ""}`}>{ACTION_LABELS[r.action]}</span></td>
                    <td>{r.name ?? "—"}{r.external_id && <div className="hint">{r.external_id}</div>}</td>
                    <td className={r.action === "error" ? "errors" : "wide"}>
                      {r.action === "error" && <ul>{r.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
                      {r.action === "update" && r.before && (
                        <ul>{r.changes.map((c) => <li key={c}>{changeText(c, r)}</li>)}</ul>
                      )}
                      {r.action === "create" && <span className="small">{[r.type, r.category, r.locations?.join(", ")].filter(Boolean).join(" · ")}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.valid && n > 0 && phase !== "imported" && (
            <div className="stack">
              <label className="check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />
                I have reviewed {plan.counts.create} new and {plan.counts.update} updated subject(s).</label>
              <button type="button" className="btn primary" disabled={!confirmed || busy} aria-busy={phase === "importing"} onClick={() => void commit()}>
                {phase === "importing" ? "Importing…" : phase === "failed" ? "Retry import" : `Import ${n} subject(s)`}
              </button>
            </div>
          )}
          {plan.valid && n === 0 && <p className="notice">Nothing to import: every row matches the current directory.</p>}
          {!plan.valid && <p className="notice error">Fix the rows marked Error and check the file again. Nothing has been imported.</p>}
        </>
      )}
    </section>
  );
}

function changeText(c: string, r: import("@/lib/csv-import").ImportPlanRow): string {
  const b = r.before!;
  switch (c) {
    case "name": return `Name: ${b.name} → ${r.name}`;
    case "type": return `Type: ${b.type} → ${r.type}`;
    case "category": return `Category: ${b.category ?? "none"} → ${r.category}`;
    case "locations": return `Locations: ${b.locations.join(", ") || "none"} → ${r.locations?.join(", ") || "none"}`;
    case "contact": {
      const f = (x: typeof r.contact) => (x ? [x.name, x.phone, x.email].filter(Boolean).join(", ") : "none");
      return `Contact: ${f(b.contact)} → ${f(r.contact)}`;
    }
    default: return c;
  }
}
