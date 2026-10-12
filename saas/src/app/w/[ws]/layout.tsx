import Link from "next/link";
import { SignOut } from "@/components/topbar";
import { isManager, requireWorkspace, ROLE_LABELS } from "@/lib/auth";
import { accessBanner } from "@/lib/billing";
import { formatDateTime } from "@/lib/report";

export default async function WorkspaceLayout({ children, params }: {
  children: React.ReactNode; params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  const { ctx } = await requireWorkspace(ws);
  const base = `/w/${ws}`;
  const links: [string, string][] = ctx.role === "assessor" || ctx.role === "guest"
    ? [[base, "My sessions"]]
    : [[base, "Overview"], [`${base}/sessions`, "Sessions"]];
  // Milestone 3: actions and inbox for staff; analytics for roles that may read reports.
  if (ctx.role === "assessor") links.push([`${base}/actions`, "My actions"]);
  else if (ctx.role !== "guest" && ctx.role !== "viewer") links.push([`${base}/actions`, "Actions"]);
  if (ctx.role !== "assessor" && ctx.role !== "guest") links.push([`${base}/analytics`, "Analytics"]);
  if (ctx.role !== "guest" && ctx.role !== "viewer") links.push([`${base}/inbox`, "Inbox"]);
  if (isManager(ctx.role)) links.push([`${base}/setup`, "Locations & subjects"], [`${base}/templates`, "Templates"], [`${base}/team`, "Team"]);
  if (ctx.role === "owner") links.push([`${base}/billing`, "Billing"]);
  if (ctx.role !== "guest") links.push([`${base}/security`, "Security"]);
  // Milestone 4: one banner from the context already loaded for this page (no extra request).
  const banner = accessBanner(ctx.access, ctx.role, (iso) => formatDateTime(iso, ctx.workspace.timezone));
  return (
    <>
      <header className="topbar">
        <div className="container">
          <div className="row between">
            <Link href={base} className="brand">SAVOUR<span>{ctx.workspace.name}</span></Link>
            <div className="row">
              <span className="badge">{ROLE_LABELS[ctx.role]}</span>
              <Link href="/workspaces" className="btn">Switch</Link>
              <SignOut />
            </div>
          </div>
          <nav className="nav" aria-label="Workspace">
            {/* The inbox page syncs due reminders when opened, so it is never prefetched. */}
            {links.map(([href, label]) => <Link key={href} href={href} prefetch={href.endsWith("/inbox") ? false : undefined}>{label}</Link>)}
          </nav>
        </div>
      </header>
      <main className="container stack">
        {banner && (
          <p className={`notice ${banner.tone === "info" ? "" : banner.tone}`} role={banner.tone === "info" ? "status" : "alert"}>
            {banner.text}{banner.billingLink && <> <Link href={`${base}/billing`}>Billing</Link></>}
          </p>
        )}
        {children}
      </main>
    </>
  );
}
