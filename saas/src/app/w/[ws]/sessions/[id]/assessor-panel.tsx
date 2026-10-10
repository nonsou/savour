import Link from "next/link";
import { OUTCOME_LABELS } from "@/lib/scoring";
import type { loadSession } from "./data";

type Data = Awaited<ReturnType<typeof loadSession>>;

export function AssessorPanel({ ws, data, collecting }: { ws: string; data: Data; collecting: boolean }) {
  const mine = data.assignments.filter((a) => a.user_id === data.user.id);
  return (
    <section className="card stack">
      <h2>My assessments</h2>
      {!collecting && <p className="notice warn">Collection is closed. You can no longer submit or change your own assessments here.</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Subject</th><th>My status</th><th></th></tr></thead>
          <tbody>
            {mine.map((a) => {
              const roster = data.roster.find((r) => r.subject_id === a.subject_id);
              const mineA = data.assessments.find((x) => x.subject_id === a.subject_id && x.assessor_id === data.user.id);
              const blocked = roster?.outcome === "absent" || roster?.outcome === "not_assessed";
              let status = "Not started";
              if (blocked) status = `Reviewer recorded ${OUTCOME_LABELS[roster!.outcome].toLowerCase()} — no scores needed`;
              else if (mineA?.state === "cleared") status = "Cleared — fresh scores required";
              else if (mineA?.observed_attendance === "absent") status = "Absent observation submitted";
              else if (mineA) status = `Submitted (version ${mineA.version})`;
              return (
                <tr key={a.subject_id}>
                  <td>{roster?.subject_name ?? "Subject"}</td>
                  <td>{status}</td>
                  <td>{collecting && !blocked && (
                    <Link className="btn primary" href={`/w/${ws}/sessions/${data.session.id}/assess/${a.subject_id}`}>
                      {mineA ? "Edit" : "Assess"}
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
