// CSV writer with spreadsheet formula-injection defence (OWASP): any text cell whose first
// non-whitespace character is = + - @, or that starts with a tab/CR/LF, is prefixed with a single
// quote so spreadsheet apps treat it as text. Every cell is quoted.
const DANGEROUS = /^[\s]*[=+\-@]|^[\t\r\n]/;

export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '""';
  let s: string;
  if (typeof value === "number") {
    s = Number.isFinite(value) ? String(value) : "";
  } else {
    s = String(value);
    if (DANGEROUS.test(s)) s = `'${s}`;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  // BOM so Excel opens UTF-8 names correctly; CRLF line endings per RFC 4180.
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
