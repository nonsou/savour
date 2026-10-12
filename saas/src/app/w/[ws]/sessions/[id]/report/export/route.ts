import { NextResponse, type NextRequest } from "next/server";
import { classifyRejection } from "@/lib/application-outcomes";
import { isUuid } from "@/lib/auth";
import { observed, sessionRecorder } from "@/lib/outcome-telemetry";
import { buildPdf } from "@/lib/pdf";
import { buildCsv, exportFilename, type ReportEnvelope } from "@/lib/report";
import { isKnownFormula } from "@/lib/scoring";
import { createClient } from "@/lib/supabase/server";

const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

// Authorization, scope and redaction happen in public.get_session_report (which also audits the
// export). This handler only renders what the database returned for this caller.
// M5 OPS02: one outcome per export once the format names the operation (lib/outcome-telemetry). Success
// means the file was generated, not delivered. Responses, statuses and headers are unchanged.
export async function GET(request: NextRequest, { params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws, id } = await params;
  const sp = request.nextUrl.searchParams;
  const format = sp.get("format");
  if (format !== "pdf" && format !== "csv") return new NextResponse("Bad request", { status: 400, headers: PRIVATE });
  return observed(format === "pdf" ? "report_pdf" : "report_csv", async (ctx) => {
    if (!isUuid(id)) return { outcome: "rejected", value: new NextResponse("Bad request", { status: 400, headers: PRIVATE }) };
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return { outcome: "rejected", value: new NextResponse("Sign in required", { status: 401, headers: PRIVATE }) };
    ctx.record = sessionRecorder(supabase);
    const revision = sp.get("revision");
    const { data, error } = await supabase.rpc("get_session_report", {
      p_session: id, p_revision: revision && /^\d+$/.test(revision) ? Number(revision) : null,
      p_redact: sp.get("redact") === "1", p_purpose: format,
    });
    if (error || !data) {
      const status = error?.message === "forbidden" ? 403 : 404;
      // A technical RPC error is a failure even though the legacy response stays 404.
      return { outcome: error ? classifyRejection(error.message) : "rejected",
        value: new NextResponse(status === 403 ? "Forbidden" : "Not found", { status, headers: PRIVATE }) };
    }
    const env = data as ReportEnvelope;
    // A session from another business the user also belongs to is never exported under this business.
    if (env.meta.workspace_id !== ws) return { outcome: "rejected", value: new NextResponse("Not found", { status: 404, headers: PRIVATE }) };
    // Never recompute a snapshot under a formula this build does not implement.
    if (!isKnownFormula(env.inputs.formula_version)) {
      return { outcome: "failed",
        value: new NextResponse(`Unsupported calculation formula ${env.inputs.formula_version}; nothing exported.`, { status: 422, headers: PRIVATE }) };
    }
    const filename = exportFilename(env, format);
    const headers = { ...PRIVATE, "Content-Disposition": `attachment; filename="${filename}"` };
    if (format === "csv") {
      return { outcome: "success", value: new NextResponse(buildCsv(env), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } }) };
    }
    const pdf = await buildPdf(env);
    return { outcome: "success", value: new NextResponse(Buffer.from(pdf), { headers: { ...headers, "Content-Type": "application/pdf" } }) };
  });
}
