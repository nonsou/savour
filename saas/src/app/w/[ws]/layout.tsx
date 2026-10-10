import Link from "next/link";
import { SignOut } from "@/components/topbar";
import { isManager, requireWorkspace, ROLE_LABELS } from "@/lib/auth";

export default async function WorkspaceLayout({ children, params }: {
  children: React.ReactNode; params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  const { ctx } = await requireWorkspace(ws);
  const base = `/w/${ws}`;
  const links: [string, string][] = ctx.role === "assessor" || ctx.role === "guest"
    ? [[base, "My sessions"]]
    : [[base, "Overview"], [`${base}/sessions`, "Sessions"]];
  if (isManager(ctx.role)) links.push([`${base}/setup`, "Locations & subjects"], [`${base}/templates`, "Templates"], [`${base}/team`, "Team"]);
  if (ctx.role !== "guest") links.push([`${base}/security`, "Security"]);
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
            {links.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
          </nav>
        </div>
      </header>
      <main className="container stack">{children}</main>
    </>
  );
}
