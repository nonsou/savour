import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) redirect("/workspaces");
  return (
    <main className="container narrow stack" style={{ paddingTop: "12vh" }}>
      <p className="brand" style={{ fontSize: "2rem" }}>SAVOUR</p>
      <h1>Inspections your team can trust</h1>
      <p className="muted">
        Run assessments on a phone, review and approve results, and share consistent reports for food vendors,
        restaurant operations and suppliers.
      </p>
      <Link href="/login" className="btn primary block">Sign in or create an account</Link>
    </main>
  );
}
