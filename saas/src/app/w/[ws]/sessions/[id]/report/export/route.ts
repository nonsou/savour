import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/auth";
import { buildPdf } from "@/lib/pdf";
import { buildCsv, exportFilename, type ReportEnvelope } from "@/lib/report";
import { createClient } from "@/lib/supabase/server";

const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

// Authorization, scope and redaction happen in public.get_session_report (which also audits the
// export). This handler only renders what the database returned for this caller.
export async function GET(request: NextRequest, { params }: { params: Promise<{ ws: string; id: string }> }) {
  const { id } = await params;
  const sp = request.nextUrl.searchParams;
  const format = sp.get("format");
  if (!isUuid(id) || (format !== "pdf" && format !== "csv")) return new NextResponse("Bad request", { status: 400, headers: PRIVATE });
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return new NextResponse("Sign in required", { status: 401, headers: PRIVATE });
  const revision = sp.get("revision");
  const { data, error } = await supabase.rpc("get_session_report", {
    p_session: id, p_revision: revision && /^\d+$/.test(revision) ? Number(revision) : null,
    p_redact: sp.get("redact") === "1", p_purpose: format,
  });
  if (error || !data) {
    const status = error?.message === "forbidden" ? 403 : 404;
    return new NextResponse(status === 403 ? "Forbidden" : "Not found", { status, headers: PRIVATE });
  }
  const env = data as ReportEnvelope;
  const filename = exportFilename(env, format);
  const headers = { ...PRIVATE, "Content-Disposition": `attachment; filename="${filename}"` };
  if (format === "csv") {
    return new NextResponse(buildCsv(env), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
  }
  const pdf = await buildPdf(env);
  return new NextResponse(Buffer.from(pdf), { headers: { ...headers, "Content-Type": "application/pdf" } });
}
