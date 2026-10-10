import Link from "next/link";
import { isManager, requireWorkspace } from "@/lib/auth";
import { SESSION_STATUS_LABELS } from "@/lib/labels";
import { formatLocalDate } from "@/lib/report";

export const metadata = { title: "Sessions — SAVOUR" };

interface Row { id: string; name: string; local_date: string; status: string; revision: number; locations: { name: string } | null }

export default async function SessionsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { supabase, ctx } = await requireWorkspace(ws);
  const { data, error } = await supabase.from("sessions")
    .select("id, name, local_date, status, revision, locations(name)")
    .eq("workspace_id", ws).order("local_date", { ascending: false }).order("created_at", { ascending: false }).limit(200);
  const rows = (data ?? []) as unknown as Row[];
  return (
    <>
      <div className="row between">
        <h1>Sessions</h1>
        {isManager(ctx.role) && <Link href={`/w/${ws}/sessions/new`} className="btn primary">New session</Link>}
      </div>
      {ctx.role === "viewer" && <p className="muted small">Viewers see sessions with an approved report in their locations.</p>}
      {error && <p className="notice error">Could not load sessions. Reload to try again.</p>}
      {rows.length === 0 && !error && <p className="notice">No sessions to show yet.</p>}
      {rows.length > 0 && (
        <div className="table-wrap card">
          <table>
            <thead><tr><th>Session</th><th>Date</th><th>Location</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/w/${ws}/sessions/${r.id}`}>{r.name}</Link></td>
                  <td>{formatLocalDate(r.local_date)}</td>
                  <td>{r.locations?.name ?? "—"}</td>
                  <td><span className={`badge ${r.status}`}>{SESSION_STATUS_LABELS[r.status]}</span>
                    {r.revision > 1 && r.status === "in_review" && <span className="badge in_review"> Under revision (r{r.revision})</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
