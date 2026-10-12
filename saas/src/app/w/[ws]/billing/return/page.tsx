import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { CHECKOUT_STATUS_LABELS, type OwnerBilling } from "@/lib/billing";
import { friendlyError } from "@/lib/errors";
import { formatDateTime } from "@/lib/report";
import { RefreshPoller } from "../refresh-poller";

export const metadata = { title: "Payment status — SAVOUR" };

// The redirect from Bachs proves nothing: query parameters (checkout_id, intent) are ignored and the
// page shows only what the server verified from Bachs (get_billing).
export default async function BillingReturnPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { supabase, ctx } = await requireWorkspace(ws);
  if (ctx.role !== "owner") notFound();
  const { data, error } = await supabase.rpc("get_billing", { p_ws: ws });
  if (error) return <p className="notice error">{friendlyError(error)}</p>;
  const b = data as OwnerBilling;
  const paid = ["active", "cancel_scheduled"].includes(b.access.state) && !b.pending_checkout;
  const pending = b.pending_checkout;
  return (
    <section className="card stack">
      <h1>Payment status</h1>
      {paid && <p className="notice ok" role="status">Payment confirmed by Bachs. Paid through {formatDateTime(b.access.paid_through, ctx.workspace.timezone)}.</p>}
      {!paid && pending && (
        <p className="notice warn" role="status">Payment processing: {CHECKOUT_STATUS_LABELS[pending.status] ?? pending.status}. Access changes only after SAVOUR verifies the payment with Bachs.</p>
      )}
      {!paid && !pending && <p className="notice">No verified payment yet. If you cancelled or closed the payment page, nothing was charged.</p>}
      <RefreshPoller active={!paid && !!pending} />
      <p><Link href={`/w/${ws}/billing`} className="btn">Back to billing</Link></p>
    </section>
  );
}
