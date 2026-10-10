"use client";

export default function WorkspaceError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card" role="alert">
      <h1>Something went wrong</h1>
      <p>The page could not be loaded. Nothing was changed. Check your connection and try again.</p>
      <button className="btn primary" onClick={reset}>Try again</button>
    </div>
  );
}
