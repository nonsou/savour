// CSV parsing for the subject import. Runs on the server (server action) before the database
// validates every value again in private.plan_subject_import; nothing here is trusted by the
// database. RFC 4180 style: comma separated, double-quoted fields may contain commas, quotes ("")
// and line breaks; CRLF, LF or CR line endings; an optional UTF-8 BOM; blank rows are skipped.

export const IMPORT_COLUMNS = ["name", "type", "external_id", "category", "locations",
  "contact_name", "contact_phone", "contact_email"] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];
export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_BYTES = 512 * 1024;

export const EXAMPLE_CSV = [
  "name,type,external_id,category,locations,contact_name,contact_phone,contact_email",
  `Mama Put Kitchen,vendor,V-001,Grills,Main Site,Ada Obi,+234 800 000 0001,ada@example.com`,
  `"Suya Spot, Gate 2",vendor,V-002,Grills,Main Site;Annex,,,`,
  `Fresh Farms Ltd,supplier,SUP-01,,,"Tunde ""TJ"" Bello",,orders@example.com`,
].join("\r\n") + "\r\n";

export interface ParsedRecord { line: number; cells: string[] }

// Splits CSV text into records, remembering the source line each record starts on.
export function parseCsv(text: string): { ok: true; records: ParsedRecord[] } | { ok: false; error: string } {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const records: ParsedRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let line = 1;
  let start = 1;
  let quoted = false;
  let afterQuote = false;
  let i = 0;
  const endCell = () => { cells.push(cell); cell = ""; afterQuote = false; };
  const endRecord = () => { endCell(); records.push({ line: start, cells }); cells = []; };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; afterQuote = true; i += 1; continue;
      }
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && src[i + 1] === "\n") i += 1;
        cell += "\n"; line += 1; i += 1; continue;
      }
      cell += ch; i += 1; continue;
    }
    if (ch === ",") { endCell(); i += 1; continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      endRecord(); line += 1; start = line; i += 1; continue;
    }
    if (ch === '"') {
      if (cell.trim() !== "" || afterQuote) return { ok: false, error: `Line ${line}: a quote must start the field.` };
      cell = ""; quoted = true; i += 1; continue;
    }
    if (afterQuote) {
      if (ch === " " || ch === "\t") { i += 1; continue; }
      return { ok: false, error: `Line ${line}: unexpected text after a closing quote.` };
    }
    cell += ch; i += 1;
  }
  if (quoted) return { ok: false, error: `Line ${start}: a quoted field is not closed.` };
  if (cell !== "" || cells.length > 0) endRecord();
  return { ok: true, records };
}

const HEADER_ALIASES: Record<string, ImportColumn> = {
  subject: "name", subject_name: "name", subject_type: "type", externalid: "external_id", id: "external_id",
  location: "locations", email: "contact_email", phone: "contact_phone",
};

export function normalizeHeader(h: string): string {
  const k = h.normalize("NFC").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return HEADER_ALIASES[k] ?? k;
}

export interface ImportRow { line: number; cells: Partial<Record<ImportColumn, string>> }
export type MappedImport =
  | { ok: true; rows: ImportRow[]; skippedBlank: number; columns: ImportColumn[] }
  | { ok: false; error: string };

// Header + data rows -> the row shape sent to preview/commit. File-level problems stop here
// with one message; row-level problems are left to the database so they are reported per line.
export function mapImport(text: string): MappedImport {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) return { ok: false, error: "The file is larger than 512 KB." };
  const parsed = parseCsv(text);
  if (!parsed.ok) return parsed;
  const isBlank = (r: ParsedRecord) => r.cells.every((c) => c.trim() === "");
  const nonBlank = parsed.records.filter((r) => !isBlank(r));
  if (nonBlank.length === 0) return { ok: false, error: "The file is empty." };
  const [header, ...data] = nonBlank;
  const columns = header.cells.map(normalizeHeader);
  const unknown = columns.filter((c) => !(IMPORT_COLUMNS as readonly string[]).includes(c));
  if (unknown.length) return { ok: false, error: `Unknown column(s): ${unknown.join(", ")}. Use the example file's headings.` };
  const dup = columns.find((c, i) => columns.indexOf(c) !== i);
  if (dup) return { ok: false, error: `Column "${dup}" appears twice.` };
  for (const required of ["name", "type"] as const) {
    if (!columns.includes(required)) return { ok: false, error: `The heading row needs a "${required}" column.` };
  }
  if (data.length === 0) return { ok: false, error: "The file has a heading row but no subjects." };
  if (data.length > MAX_IMPORT_ROWS) return { ok: false, error: `At most ${MAX_IMPORT_ROWS} subjects per import (this file has ${data.length}).` };
  const rows: ImportRow[] = [];
  for (const r of data) {
    if (r.cells.slice(columns.length).some((c) => c.trim() !== "")) {
      return { ok: false, error: `Line ${r.line} has more values than there are columns. Quote values that contain commas.` };
    }
    const cells: ImportRow["cells"] = {};
    columns.forEach((c, i) => { cells[c as ImportColumn] = r.cells[i] ?? ""; });
    rows.push({ line: r.line, cells });
  }
  return { ok: true, rows, skippedBlank: parsed.records.length - nonBlank.length, columns: columns as ImportColumn[] };
}

// Database plan returned by preview_subject_import / recomputed by commit_subject_import.
export interface ImportPlanRow {
  line: number;
  action: "create" | "update" | "unchanged" | "error";
  errors: string[];
  subject_id: string | null;
  name: string | null;
  type: string | null;
  external_id: string | null;
  category: string | null;
  locations: string[] | null;
  contact: { name: string | null; phone: string | null; email: string | null } | null;
  changes: string[];
  before: { name: string; type: string; category: string | null; locations: string[]; contact: ImportPlanRow["contact"] } | null;
}
export interface ImportPlan {
  rows: ImportPlanRow[];
  counts: { create: number; update: number; unchanged: number; error: number };
  valid: boolean;
  plan_hash: string;
}
export interface ImportReceipt {
  import_id: string; created: number; updated: number; unchanged: number; rows: number; replayed: boolean;
}
