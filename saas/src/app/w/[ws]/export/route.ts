import { NextResponse, type NextRequest } from "next/server";
import { isUuid } from "@/lib/auth";
import { buildDashboardCsv, type Dashboard } from "@/lib/report";
import { createClient } from "@/lib/supabase/server";

const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

// Dashboard CSV. public.get_dashboard enforces role and scope and returns redacted inputs.
export async function GET(_: NextRequest, { params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  if (!isUuid(ws)) return new NextResponse("Bad request", { status: 400, headers: PRIVATE });
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return new NextResponse("Sign in required", { status: 401, headers: PRIVATE });
  const [{ data, error }, ctx] = await Promise.all([
    supabase.rpc("get_dashboard", { p_ws: ws }),
    supabase.rpc("workspace_context", { p_ws: ws }),
  ]);
  if (error || !data || !ctx.data) return new NextResponse("Not found", { status: error?.message === "forbidden" ? 403 : 404, headers: PRIVATE });
  const workspace = (ctx.data as { workspace: { name: string; timezone: string } }).workspace;
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(buildDashboardCsv(data as Dashboard, workspace), {
    headers: { ...PRIVATE, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="savour-dashboard-${date}.csv"` },
  });
}
