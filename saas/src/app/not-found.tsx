import Link from "next/link";

export default function NotFound() {
  return (
    <main className="container narrow stack">
      <h1>Not available</h1>
      <p>This page does not exist, or you do not have access to it.</p>
      <Link href="/workspaces" className="btn">Your businesses</Link>
    </main>
  );
}
