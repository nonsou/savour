import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card">
      <h1>Not available</h1>
      <p>This page does not exist, or you no longer have access to it.</p>
      <Link href="/workspaces" className="btn">Your businesses</Link>
    </div>
  );
}
