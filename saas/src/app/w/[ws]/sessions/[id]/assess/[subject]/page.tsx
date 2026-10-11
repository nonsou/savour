import { notFound } from "next/navigation";
import { isUuid } from "@/lib/auth";
import { loadSession } from "../../data";
import { AssessmentForm } from "./assessment-form";

export const metadata = { title: "Assessment — SAVOUR" };

export default async function AssessPage({ params, searchParams }: {
  params: Promise<{ ws: string; id: string; subject: string }>;
  searchParams: Promise<{ assessor?: string }>;
}) {
  const { ws, id, subject } = await params;
  const sp = await searchParams;
  const d = await loadSession(ws, id);
  if (!d.template || !isUuid(subject)) notFound();
  const roster = d.roster.find((r) => r.subject_id === subject);
  if (!roster) notFound();
  const target = d.canReview && isUuid(sp.assessor) ? sp.assessor : d.user.id;
  if (!d.assignments.some((a) => a.subject_id === subject && a.user_id === target)) notFound();
  const collecting = d.collecting;
  // Reviewers amending someone else's work, or their own after collection, must give a reason.
  const amend = d.canReview && (target !== d.user.id || !collecting);
  const editable = d.session.status === "open" || d.session.status === "in_review";
  const existing = d.assessments.find((a) => a.subject_id === subject && a.assessor_id === target) ?? null;
  const backHref = `/w/${ws}/sessions/${id}`;
  const blocked = roster.outcome === "absent" || roster.outcome === "not_assessed";
  const correction = d.corrections.find((c) => c.subject_id === subject && c.assessor_id === target && c.status === "open");

  return (
    <section className="card stack">
      <div>
        <h1>{roster.subject_name}</h1>
        <p className="muted small">{d.session.name} · {d.template.name} v{d.template.version}
          {d.session.expected_ready_time && ` · Ready by ${d.session.expected_ready_time.slice(0, 5)}`}
          {target !== d.user.id && ` · Amending ${existing?.assessor_name ?? "an assessor"}'s response`}</p>
      </div>
      {d.session.is_sample && <p className="notice sample">SAMPLE — practice inspection. Never counted in business totals.</p>}
      {correction && (
        <div className="notice warn" role="status">
          <strong>Correction requested by {correction.requester_name}:</strong> {correction.reason}
          <div className="hint">{target === d.user.id ? "Update your response below and save; the request closes when your corrected response is saved." : "Saving an amendment with a reason resolves this request."}</div>
        </div>
      )}
      {!editable || (!amend && !collecting) ? (
        <p className="notice warn">This assessment can no longer be changed here (collection closed or session locked).</p>
      ) : blocked ? (
        <p className="notice warn">The reviewer recorded this subject as {roster.outcome === "absent" ? "absent" : "not assessed"}. Quality scores are not accepted unless that outcome changes.</p>
      ) : (
        <AssessmentForm ws={ws} session={id} subject={subject} assessor={target} criteria={d.template.criteria}
          mode={d.template.attendance_mode} amend={amend} backHref={backHref}
          existing={existing && { observed: existing.observed_attendance, answers: existing.answers, notes: existing.notes,
            absence_reason: existing.absence_reason, version: existing.version, state: existing.state }} />
      )}
    </section>
  );
}
