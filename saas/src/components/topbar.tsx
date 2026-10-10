import Link from "next/link";

export function SignOut() {
  return (
    <form action="/auth/signout" method="post">
      <button className="btn" type="submit">Sign out</button>
    </form>
  );
}

export function SimpleTopbar() {
  return (
    <header className="topbar">
      <div className="container row between">
        <Link href="/workspaces" className="brand">SAVOUR</Link>
        <SignOut />
      </div>
    </header>
  );
}
