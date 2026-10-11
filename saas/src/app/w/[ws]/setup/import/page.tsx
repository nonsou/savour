import Link from "next/link";
import { notFound } from "next/navigation";
import { isManager, requireWorkspace } from "@/lib/auth";
import { EXAMPLE_CSV, IMPORT_COLUMNS, MAX_IMPORT_ROWS } from "@/lib/csv-import";
import { ImportClient } from "./import-client";

export const metadata = { title: "Import subjects — SAVOUR" };

export default async function ImportPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { ctx } = await requireWorkspace(ws);
  if (!isManager(ctx.role)) notFound();
  return (
    <>
      <div className="row between">
        <h1>Import subjects</h1>
        <Link className="btn" href={`/w/${ws}/setup`}>Back to setup</Link>
      </div>
      <section className="card stack small">
        <p>Upload or paste a CSV file (up to {MAX_IMPORT_ROWS} subjects). Nothing is saved until you review the check and confirm.
          If any row has a problem, nothing is imported.</p>
        <ul>
          <li>Columns: <code>{IMPORT_COLUMNS.join(", ")}</code>. Only <code>name</code> and <code>type</code> are required.</li>
          <li><code>type</code> is vendor, outlet, operation, supplier or service_provider. <code>category</code> and <code>locations</code> must
            already exist (separate several locations with <code>;</code>).</li>
          <li><code>external_id</code> is the only way to update an existing subject. A row whose name matches an existing subject
            without its external ID is an error; subjects are never merged by name.</li>
          <li>On an update, blank cells keep the current value. Archived subjects are never restored by import.</li>
          <li>Contacts are private to owners and admins.</li>
        </ul>
        <a className="btn" download="savour-subjects-example.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(EXAMPLE_CSV)}`}>Download example CSV</a>
      </section>
      <ImportClient ws={ws} />
    </>
  );
}
