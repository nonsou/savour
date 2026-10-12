import { NextResponse, type NextRequest } from "next/server";
import { buildAnalytics, parseFilters, type AnalyticsDataset } from "@/lib/analytics";
import { analyticsFilename, buildAnalyticsCsv } from "@/lib/analytics-export";
import { classifyRejection } from "@/lib/application-outcomes";
import { isUuid } from "@/lib/auth";
import { observed, sessionRecorder } from "@/lib/outcome-telemetry";
import { buildAnalyticsPdf } from "@/lib/pdf";
import { createClient } from "@/lib/supabase/server";

const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

// Analytics CSV/PDF. public.get_analytics authorizes the caller, applies scope, redaction and
// sample exclusion, and audits the export with its filters. The file is built by the same
// buildAnalytics() the page uses.
// M5 OPS02: one outcome per export once the format names the operation (lib/outcome-telemetry). Success
// means the file was generated, not delivered. Responses, statuses and headers are unchanged.
export async function GET(request: NextRequest, { params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const sp = request.nextUrl.searchParams;
  const format = sp.get("format");
  if (format !== "pdf" && format !== "csv") return new NextResponse("Bad request", { status: 400, headers: PRIVATE });
  return observed(format === "pdf" ? "analytics_pdf" : "analytics_csv", async (ctx) => {
    if (!isUuid(ws)) return { outcome: "rejected", value: new NextResponse("Bad request", { status: 400, headers: PRIVATE }) };
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return { outcome: "rejected", value: new NextResponse("Sign in required", { status: 401, headers: PRIVATE }) };
    ctx.record = sessionRecorder(supabase);
    const { filters } = parseFilters(Object.fromEntries(sp.entries()));
    const mode = sp.get("mode") === "provisional" ? "provisional" : "approved";
    const { data, error } = await supabase.rpc("get_analytics", { p_ws: ws, p_mode: mode, p_filters: filters, p_purpose: format });
    if (error || !data) {
      const status = error?.message === "forbidden" ? 403 : error?.message === "invalid_filter" ? 400 : 404;
      // A technical RPC error is a failure even though the legacy response stays 404.
      return { outcome: error ? classifyRejection(error.message) : "rejected",
        value: new NextResponse(status === 403 ? "Forbidden" : status === 400 ? "Invalid filter" : "Not found", { status, headers: PRIVATE }) };
    }
    const ds = data as AnalyticsDataset;
    let result;
    try { result = buildAnalytics(ds, filters); } catch (e) {
      // The 422 response is unchanged; nothing was exported, so the observation is a failure.
      return { outcome: "failed", value: new NextResponse(`${(e as Error).message} Nothing exported.`, { status: 422, headers: PRIVATE }) };
    }
    const headers = { ...PRIVATE, "Content-Disposition": `attachment; filename="${analyticsFilename(ds, format)}"` };
    if (format === "csv") {
      return { outcome: "success",
        value: new NextResponse(buildAnalyticsCsv(ds, filters, result), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } }) };
    }
    const pdf = await buildAnalyticsPdf(ds, filters, result);
    return { outcome: "success", value: new NextResponse(Buffer.from(pdf), { headers: { ...headers, "Content-Type": "application/pdf" } }) };
  });
}
