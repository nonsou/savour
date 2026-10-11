import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { isManager, requireWorkspace } from "@/lib/auth";
import { ATTENDANCE_MODE_LABELS } from "@/lib/labels";
import { STARTER_PACKS } from "@/lib/packs";
import type { AttendanceMode, Criterion } from "@/lib/scoring";
import { installPack, publishTemplate } from "./actions";
import { TemplateEditor } from "./editor";

export const metadata = { title: "Templates — SAVOUR" };

interface Version { id: string; version: number; name: string; attendance_mode: AttendanceMode; criteria: Criterion[]; published_at: string }
interface Template { id: string; name: string; pack: string; latest_version: number; template_versions: Version[] }

export default async function TemplatesPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { supabase, ctx } = await requireWorkspace(ws);
  if (!isManager(ctx.role)) notFound();
  const { data, error } = await supabase.from("templates")
    .select("id, name, pack, latest_version, template_versions(id, version, name, attendance_mode, criteria, published_at)")
    .eq("workspace_id", ws).order("created_at");
  const templates = (data ?? []) as Template[];
  return (
    <>
      <h1>Templates</h1>
      {error && <p className="notice error">Could not load templates. Reload to try again.</p>}
      <section className="card">
        <h2>Starter packs</h2>
        <p className="muted small">Editable examples, not regulatory standards. Installing publishes version 1 of a new template.</p>
        <div className="grid">
          {STARTER_PACKS.map((p) => (
            <ActionForm key={p.id} action={installPack} className="card">
              <input type="hidden" name="ws" value={ws} /><input type="hidden" name="pack" value={p.id} />
              <h3>{p.name}</h3>
              <p className="small muted">{p.description}</p>
              <p className="small">{ATTENDANCE_MODE_LABELS[p.attendanceMode]} · {p.criteria.map((c) => c.label).join(", ")}</p>
              <SubmitButton className="btn" pendingText="Installing…">Install</SubmitButton>
            </ActionForm>
          ))}
        </div>
      </section>

      {templates.length === 0 && !error && <p className="notice">No templates yet. Install a starter pack or create a custom template below.</p>}
      {templates.map((t) => {
        const versions = [...t.template_versions].sort((a, b) => b.version - a.version);
        const latest = versions[0];
        return (
          <section key={t.id} className="card stack">
            <div className="row between">
              <h2>{t.name}</h2>
              <span className="badge">v{t.latest_version} · {ATTENDANCE_MODE_LABELS[latest?.attendance_mode ?? "off"]}</span>
            </div>
            {latest && <p className="small">{latest.criteria.map((c) => `${c.label}${c.allow_na ? " (N/A allowed)" : ""}`).join(" · ") || "Attendance only"}</p>}
            <p className="muted small">Versions: {versions.map((v) => `v${v.version} (${new Date(v.published_at).toISOString().slice(0, 10)})`).join(", ")}</p>
            {latest && (
              <details>
                <summary>Edit and publish a new version</summary>
                <TemplateEditor ws={ws} templateId={t.id} name={t.name} pack={t.pack} mode={latest.attendance_mode}
                  criteria={latest.criteria} action={publishTemplate} />
              </details>
            )}
          </section>
        );
      })}

      <section className="card">
        <details>
          <summary><strong>Create a custom template</strong></summary>
          <TemplateEditor ws={ws} templateId={null} name="" pack="custom" mode="off" criteria={[]} action={publishTemplate} />
        </details>
      </section>
    </>
  );
}
