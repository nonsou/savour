import Link from "next/link";
import { OUTCOME_LABELS } from "@/lib/scoring";
import type { loadSession } from "./data";

type Data = Awaited<ReturnType<typeof loadSession>>;

export function AssessorPanel({ ws, data, collecting }: { ws: string; data: Data; collecting: boolean }) {
  // Only assignments on the active roster. Reviewers can still read assignments on removed subjects
  // (evidence and history are kept), but those are not work to do here.
  const mine = data.assignments.filter((a) => a.user_id === data.user.id && data.roster.some((r) => r.subject_id === a.subject_id));
  return (
    <section className="card stack">
      <h2>My assessments</h2>
      {!collecting && (data.session.status === "draft"
        ? <p className="notice">This session is still a draft. Assessments begin after it is opened.</p>
        : <p className="notice warn">Collection is closed. You can no longer submit or change your own assessments here.</p>)}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Subject</th><th>My status</th><th></th></tr></thead>
          <tbody>
            {mine.map((a) => {
              const roster = data.roster.find((r) => r.subject_id === a.subject_id);
              const mineA = data.assessments.find((x) => x.subject_id === a.subject_id && x.assessor_id === data.user.id);
              const blocked = roster?.outcome === "absent" || roster?.outcome === "not_assessed";
              const cr = data.corrections.find((c) => c.subject_id === a.subject_id && c.assessor_id === data.user.id && c.status === "open");
              let status = "Not started";
              if (blocked) status = `Reviewer recorded ${OUTCOME_LABELS[roster!.outcome].toLowerCase()} — no scores needed`;
              else if (mineA?.state === "cleared") status = "Cleared — fresh scores required";
              else if (mineA?.observed_attendance === "absent") status = "Absent observation submitted";
              else if (mineA) status = `Submitted (version ${mineA.version})`;
              if (a.waived_at && !mineA?.answers) status = `${status} — waived by reviewer`;
              return (
                <tr key={a.subject_id}>
                  <td>{roster?.subject_name ?? "Subject"}</td>
                  <td>{status}{cr && <div className="notice warn small">Correction requested: {cr.reason}</div>}</td>
                  <td>{collecting && !blocked && (
                    <Link className="btn primary" href={`/w/${ws}/sessions/${data.session.id}/assess/${a.subject_id}`}>
                      {cr ? "Correct" : mineA ? "Edit" : "Assess"}
                    </Link>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
