import { NextResponse, type NextRequest } from "next/server";
import { classifyRejection } from "@/lib/application-outcomes";
import { isUuid } from "@/lib/auth";
import { observed, sessionRecorder } from "@/lib/outcome-telemetry";
import { buildDashboardCsv, type Dashboard } from "@/lib/report";
import { createClient } from "@/lib/supabase/server";

const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

// Dashboard CSV. public.get_dashboard enforces role and scope and returns redacted inputs.
// M5 OPS02: one outcome per export (lib/outcome-telemetry). Success means the file was generated, not
// delivered. Responses, statuses and headers are unchanged.
export async function GET(_: NextRequest, { params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return observed("dashboard_csv", async (ctx) => {
    if (!isUuid(ws)) return { outcome: "rejected", value: new NextResponse("Bad request", { status: 400, headers: PRIVATE }) };
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return { outcome: "rejected", value: new NextResponse("Sign in required", { status: 401, headers: PRIVATE }) };
    ctx.record = sessionRecorder(supabase);
    const [{ data, error }, ctxResult] = await Promise.all([
      supabase.rpc("get_dashboard", { p_ws: ws }),
      supabase.rpc("workspace_context", { p_ws: ws }),
    ]);
    if (error || !data || !ctxResult.data) {
      // A technical error from either call is a failure even though the legacy response stays 404.
      const rpcError = error ?? ctxResult.error;
      return { outcome: rpcError ? classifyRejection(rpcError.message) : "rejected",
        value: new NextResponse("Not found", { status: error?.message === "forbidden" ? 403 : 404, headers: PRIVATE }) };
    }
    const workspace = (ctxResult.data as { workspace: { name: string; timezone: string } }).workspace;
    const date = new Date().toISOString().slice(0, 10);
    return { outcome: "success", value: new NextResponse(buildDashboardCsv(data as Dashboard, workspace), {
      headers: { ...PRIVATE, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="savour-dashboard-${date}.csv"` },
    }) };
  });
}
