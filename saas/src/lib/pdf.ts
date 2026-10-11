// Printable PDF rendered server-side with pdf-lib + an embedded Unicode font (Noto Sans, OFL).
// Content comes from the same envelope and summarizeSession() as the UI and CSV. Metadata never
// contains assessor identities; with a redacted envelope none exist in the input either.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { AnalyticsDataset, AnalyticsFilters, AnalyticsResult } from "./analytics";
import { analyticsSections, headerRows as analyticsHeaderRows } from "./analytics-export";
import { SEVERITY_LABELS } from "./labels";
import {
  ACTION_DETAIL_FIELDS, answerText, appendixActionLine, appendixTitle, formatDateTime, frozenActionLine, frozenActionsTitle, notRecordedNote,
  reportHeaderRows, SAMPLE_NOTICE, snapshotState, summaryRows, type ActionLine, type ReportEnvelope,
} from "./report";
import { formatPct, OUTCOME_LABELS, summarizeSession, subjectStatusLabel } from "./scoring";

const FONT_DIR = join(process.cwd(), "src", "assets", "fonts");
const A4: [number, number] = [595.28, 841.89];
const M = 40;
const REPLACEMENT = "□"; // visible box for characters the font cannot draw

// Text normalised to NFC; characters without a glyph become a visible box and are reported.
export function makeSanitizer(font: PDFFont) {
  const supported = new Set(font.getCharacterSet());
  let missing = 0;
  const clean = (t: string) => Array.from(t.normalize("NFC").replace(/[\r\n\t]+/g, " "))
    .map((ch) => {
      if (supported.has(ch.codePointAt(0)!)) return ch;
      missing += 1;
      return REPLACEMENT;
    }).join("");
  return { clean, missing: () => missing };
}

// Greedy word wrap that also hard-breaks words longer than the line (e.g. 2000-character notes).
export function wrapText(t: string, font: PDFFont, size: number, maxW: number): string[] {
  const width = (x: string) => font.widthOfTextAtSize(x, size);
  const out: string[] = [];
  let line = "";
  for (const word of t.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (width(candidate) <= maxW) { line = candidate; continue; }
    if (line) out.push(line);
    line = "";
    for (const ch of Array.from(word)) {
      if (line && width(line + ch) > maxW) { out.push(line); line = ch; } else line += ch;
    }
  }
  out.push(line);
  return out;
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont, private clean: (t: string) => string) {
    this.newPage();
  }
  newPage() { this.page = this.doc.addPage(A4); this.y = A4[1] - M; }
  ensure(h: number) { if (this.y - h < M + 20) this.newPage(); }
  text(t: string, opts: { size?: number; bold?: boolean; x?: number; color?: [number, number, number] } = {}) {
    const size = opts.size ?? 9;
    const font = opts.bold ? this.bold : this.font;
    const x = opts.x ?? M;
    for (const line of wrapText(this.clean(t), font, size, A4[0] - M - x)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: rgb(...(opts.color ?? [0.1, 0.1, 0.1])) });
      this.y -= size + 4;
    }
  }
  // Table row whose cells wrap (never truncate) within their column.
  row(cells: string[], widths: number[], bold = false) {
    const size = 8.5;
    const font = bold ? this.bold : this.font;
    const lines = cells.map((c, i) => wrapText(this.clean(c), font, size, widths[i] - 6));
    const h = Math.max(...lines.map((l) => l.length)) * (size + 3) + 4;
    this.ensure(h);
    let x = M;
    lines.forEach((cell, i) => {
      cell.forEach((line, j) => this.page.drawText(line, { x, y: this.y - size - j * (size + 3), size, font }));
      x += widths[i];
    });
    this.y -= h;
  }
  gap(h = 8) { this.y -= h; }
}

let fontCache: Promise<[Uint8Array, Uint8Array]> | null = null;
const loadFonts = () => (fontCache ??= Promise.all([
  readFile(join(FONT_DIR, "NotoSans-Regular.ttf")), readFile(join(FONT_DIR, "NotoSans-Bold.ttf")),
]).then(([a, b]) => [new Uint8Array(a), new Uint8Array(b)]));

const sum0 = (env: ReportEnvelope) => (env.inputs.session.is_sample ? "SAMPLE - " : "");

// New document with both embedded fonts. Full embedding on purpose: pdf-lib's subsetting dropped
// glyphs from Noto Sans (blank text).
async function newDocument() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await loadFonts();
  const font = await doc.embedFont(regularBytes);
  const bold = await doc.embedFont(boldBytes);
  return { doc, font, bold, ...makeSanitizer(font) };
}

function setMetadata(doc: PDFDocument, title: string, subject: string, generatedAt: Date) {
  doc.setTitle(title);
  doc.setAuthor("SAVOUR");
  doc.setCreator("SAVOUR");
  doc.setProducer("SAVOUR");
  doc.setSubject(subject);
  doc.setKeywords([]);
  doc.setCreationDate(generatedAt);
  doc.setModificationDate(generatedAt);
}

function finish(doc: PDFDocument, font: PDFFont) {
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length}`, { x: A4[0] - M - 60, y: 20, size: 8, font }));
  return doc.save();
}

// Headline plus every detail field of the shared action presentation (same fields as CSV and page).
function writeAction(w: Writer, line: ActionLine, extra: string[] = []) {
  w.text(`${line.status} — ${line.subject}: ${line.issue} (${line.severity}; due ${line.due}; ${line.assignee})`, { x: M + 10 });
  for (const f of ACTION_DETAIL_FIELDS) {
    const v = line[f.key];
    if (v) w.text(`${f.label}: ${v}`, { x: M + 20, color: [0.3, 0.3, 0.3] });
  }
  for (const e of extra) w.text(e, { x: M + 20, size: 8, color: [0.3, 0.3, 0.3] });
}

// Findings and actions frozen at approval, then the separately dated live appendix.
function writeFindingsAndActions(w: Writer, env: ReportEnvelope) {
  const nameOf = (id: string) => env.inputs.subjects.find((s) => s.subject_id === id)?.name
    ?? env.inputs.removed_subjects?.find((s) => s.subject_id === id)?.name ?? "Subject";
  w.gap();
  w.text(frozenActionsTitle(env), { size: 12, bold: true });
  if (snapshotState(env) === "not_recorded") {
    w.text(notRecordedNote(env), { x: M + 10 });
  } else {
    const findings = env.inputs.findings ?? [];
    if (!findings.length) w.text("No findings.", { x: M + 10 });
    for (const f of findings) {
      w.text(`${SEVERITY_LABELS[f.severity]} — ${nameOf(f.subject_id)}: ${f.title} (${f.kind === "generated" ? "template trigger" : "raised by reviewer"}, revision ${f.revision})`, { x: M + 10 });
      if (typeof f.detail?.rule === "string") w.text(`Rule: ${f.detail.rule}`, { x: M + 20, size: 8, color: [0.3, 0.3, 0.3] });
    }
    const actions = env.inputs.actions ?? [];
    if (!actions.length) w.text("No corrective actions.", { x: M + 10 });
    for (const a of actions) writeAction(w, frozenActionLine(env.inputs, a));
  }
  const ap = env.actions_appendix;
  if (!ap) return;
  w.gap();
  w.text(appendixTitle(env), { size: 12, bold: true, color: [0.6, 0.35, 0.05] });
  w.text("Live state read when this file was generated. It is not part of the approved evidence above.", { size: 8, color: [0.3, 0.3, 0.3] });
  if (!ap.actions.length) w.text("No corrective actions.", { x: M + 10 });
  for (const a of ap.actions) {
    const line = appendixActionLine(env, a);
    writeAction(w, line, [`${line.comparison}. Last updated ${line.updated}.`]);
  }
}

export async function buildPdf(env: ReportEnvelope, generatedAt = new Date()): Promise<Uint8Array> {
  const { doc, font, bold, clean, missing } = await newDocument();

  const s = env.inputs.session;
  setMetadata(doc, clean(`SAVOUR report - ${sum0(env)}${s.name} - ${s.local_date} - r${env.meta.revision}`), clean(env.inputs.workspace.name), generatedAt);

  const w = new Writer(doc, font, bold, clean);
  const sum = summarizeSession(env.inputs);

  w.text("SAVOUR session report", { size: 16, bold: true });
  if (sum.isSample) w.text(SAMPLE_NOTICE, { size: 11, bold: true, color: [0.7, 0.2, 0.1] });
  if (env.meta.status !== "approved") w.text("PROVISIONAL - NOT APPROVED", { size: 11, bold: true, color: [0.7, 0.2, 0.1] });
  w.gap(4);
  for (const [k, v] of reportHeaderRows(env, generatedAt)) w.text(`${k}: ${v}`);
  w.gap();
  w.text("Summary", { size: 12, bold: true });
  for (const [k, v] of summaryRows(sum)) w.text(`${k}: ${v}`);
  w.gap();

  w.text("Subjects", { size: 12, bold: true });
  const widths = [140, 100, 45, 60, 60, 110];
  w.row(["Subject", "Outcome", "Att.", "Quality", "Combined", "Status"], widths, true);
  for (const r of sum.subjects) {
    w.row([r.name, OUTCOME_LABELS[r.outcome], r.attendancePoints === null ? "-" : `${r.attendancePoints}/5`,
      formatPct(r.quality, "-"), formatPct(r.combined, "-"), subjectStatusLabel(r)], widths);
  }
  w.gap();

  w.text("Assessment detail", { size: 12, bold: true });
  for (const r of sum.subjects) {
    w.text(`${r.name} - ${OUTCOME_LABELS[r.outcome]}${r.outcomeReason ? ` (${r.outcomeReason})` : ""}`, { bold: true });
    if (r.assessments.length === 0) w.text("No current responses.", { x: M + 10 });
    if (r.status === "mixed_na") w.text(`Assessors used ${r.applicabilitySets.length} different N/A patterns, so no combined subject score is shown.`, { x: M + 10 });
    if (r.restored) w.text(`Restored to the roster${r.restored.reason ? ` (${r.restored.reason})` : ""}; earlier responses were retained.`, { x: M + 10 });
    for (const wv of r.waivers) {
      w.text(`${wv.assessor_label}: response waived - ${wv.reason} (${formatDateTime(wv.waived_at, env.inputs.workspace.timezone)}). Still counted as missing.`, { x: M + 10, color: [0.6, 0.35, 0.05] });
    }
    for (const a of r.assessments) {
      const answers = env.inputs.template.criteria
        .map((c) => `${c.label} ${a.answers ? answerText(a.answers[c.key]) : "-"}`).join(", ");
      w.text(`${a.assessor_label}: ${a.answers ? answers : "No scores"}${a.result.pct !== null ? ` = ${formatPct(a.result.pct)} (${a.result.applicable} of ${a.result.total} applicable)` : ""}`, { x: M + 10 });
      if (a.notes) w.text(`Notes: ${a.notes}`, { x: M + 20, color: [0.3, 0.3, 0.3] });
      if (a.absence_reason) w.text(`Absence reason: ${a.absence_reason}`, { x: M + 20, color: [0.3, 0.3, 0.3] });
    }
  }
  if (sum.removed.length) {
    w.gap();
    w.text("Removed from roster (not in totals)", { size: 12, bold: true });
    for (const r of sum.removed) {
      w.text(`${r.name}${r.reason ? ` - ${r.reason}` : ""}; removed ${formatDateTime(r.removed_at, env.inputs.workspace.timezone)}; ${r.retained_responses} response(s) retained in history.`, { x: M + 10 });
    }
  }
  writeFindingsAndActions(w, env);
  w.gap();
  w.text("Scoring definitions: quality % = applicable scores / (5 x applicable criteria). N/A is excluded from the denominator; all N/A is Not assessed. Combined % (scored readiness only) = (quality points + attendance points) / (quality maximum + 5). Absence has no quality or combined score. Subjects with missing responses (including waived responses) or mixed N/A patterns are excluded from averages. Free-text notes may contain names; review before sharing.", { size: 8, color: [0.3, 0.3, 0.3] });
  if (missing() > 0) {
    w.text(`${missing()} character(s) could not be drawn with the report font and are shown as ${REPLACEMENT}. The CSV export contains the exact original text.`, { size: 8, bold: true, color: [0.7, 0.2, 0.1] });
  }

  return finish(doc, font);
}

// Analytics PDF: the same header rows and sections as the analytics CSV (analytics-export.ts).
export async function buildAnalyticsPdf(ds: AnalyticsDataset, filters: AnalyticsFilters, result: AnalyticsResult,
  generatedAt = new Date()): Promise<Uint8Array> {
  const { doc, font, bold, clean, missing } = await newDocument();
  setMetadata(doc, clean(`SAVOUR analytics - ${ds.mode} - ${ds.today}`), clean(ds.workspace_name), generatedAt);
  const w = new Writer(doc, font, bold, clean);
  w.text("SAVOUR analytics", { size: 16, bold: true });
  if (ds.mode === "provisional") w.text("PROVISIONAL - NOT APPROVED. Never combined with approved figures.", { size: 11, bold: true, color: [0.7, 0.2, 0.1] });
  for (const [k, v] of analyticsHeaderRows(ds, filters, result)) w.text(`${k}: ${v}`);
  for (const sec of analyticsSections(ds, result)) {
    w.gap();
    w.text(sec.title, { size: 12, bold: true });
    if (sec.note) w.text(sec.note, { size: 8, color: [0.3, 0.3, 0.3] });
    if (!sec.rows.length) { w.text("None.", { x: M + 10 }); continue; }
    // Each row as labelled lines: wide tables do not fit A4 columns legibly.
    for (const row of sec.rows) {
      w.text(row.map((cell, i) => `${sec.header[i]}: ${cell === null ? "—" : cell}`).join(" · "), { x: M + 10, size: 8 });
      w.gap(2);
    }
  }
  if (missing() > 0) {
    w.text(`${missing()} character(s) could not be drawn with the report font and are shown as ${REPLACEMENT}. The CSV export contains the exact original text.`, { size: 8, bold: true, color: [0.7, 0.2, 0.1] });
  }
  return finish(doc, font);
}
