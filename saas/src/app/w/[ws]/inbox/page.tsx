import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { requireWorkspace } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";
import { ACTION_STATUS_LABELS } from "@/lib/labels";
import { formatDateTime, formatLocalDate } from "@/lib/report";
import { markAllRead, markRead } from "../actions/commands";

export const metadata = { title: "Inbox — SAVOUR" };

interface InboxItem {
  id: string; kind: string; created_at: string; read_at: string | null; stale: boolean;
  title: string | null; body: string | null; status: string | null; link: string | null;
}
interface Inbox { today: string; synced_at: string; reminders_created: number; timezone: string; unread: number; items: InboxItem[] }

export default async function InboxPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { supabase, ctx } = await requireWorkspace(ws);
  // Viewer and Guest have no inbox in Milestone 3 (refused by the RPC as well).
  if (!["owner", "admin", "reviewer", "assessor"].includes(ctx.role)) notFound();
  // Opening the inbox runs the idempotent due-date sync for your own actions, then reads.
  const { data, error } = await supabase.rpc("get_inbox", { p_ws: ws });
  const inbox = error ? null : (data as Inbox);
  const hidden = <input type="hidden" name="ws" value={ws} />;
  return (
    <>
      <div className="row between">
        <h1>Inbox</h1>
        {inbox && inbox.unread > 0 && (
          <ActionForm action={markAllRead}>{hidden}<SubmitButton className="btn" pendingText="Marking…">Mark all read</SubmitButton></ActionForm>
        )}
      </div>
      <p className="small muted">In-app notices only — SAVOUR does not send email, SMS or WhatsApp. Due-date reminders are created when you open
        this inbox (checked {inbox ? formatDateTime(inbox.synced_at, inbox.timezone) : "—"}, business date {inbox ? formatLocalDate(inbox.today) : "—"}).
        Notices whose access or condition has ended stay listed without details.</p>
      {error && <p className="notice error">{friendlyError(error)}</p>}
      {inbox && inbox.items.length === 0 && <p className="notice">Nothing here yet.</p>}
      {inbox && inbox.items.length > 0 && (
        <ul className="inbox">
          {inbox.items.map((n) => (
            <li key={n.id} className={`card inbox-item${n.read_at ? " read" : ""}${n.stale ? " stale" : ""}`}>
              <div className="row between">
                <div>
                  {n.stale ? (
                    <><strong>No longer available</strong><div className="small muted">This notice no longer applies or you no longer have access to it.</div></>
                  ) : (
                    <>
                      <strong>{n.link ? <Link href={n.link}>{n.title}</Link> : n.title}</strong>
                      <div className="small">{n.body}{n.status ? ` · now ${ACTION_STATUS_LABELS[n.status] ?? n.status}` : ""}</div>
                    </>
                  )}
                  <div className="hint">{formatDateTime(n.created_at, ctx.workspace.timezone)}{n.read_at ? " · read" : ""}</div>
                </div>
                {!n.read_at && (
                  <ActionForm action={markRead}>
                    {hidden}<input type="hidden" name="notification" value={n.id} />
                    <SubmitButton className="btn" pendingText="…">Mark read</SubmitButton>
                  </ActionForm>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
