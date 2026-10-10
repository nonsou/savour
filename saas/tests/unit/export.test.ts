import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "@/lib/csv";
import { buildPdf, makeSanitizer, wrapText } from "@/lib/pdf";
import { buildCsv, exportFilename, type ReportEnvelope } from "@/lib/report";
import { summarizeSession } from "@/lib/scoring";
import { draftFromAnswers, slugKey, validateCriteria, validateDraft } from "@/lib/validation";
import { assessment, inputs, subject, TWO } from "./fixtures";

const envelope = (redacted: boolean): ReportEnvelope => ({
  meta: {
    status: "approved", revision: 1, approved_at: "2026-10-10T15:00:00Z", approver_name: "Rita Reviewer",
    formula_version: "savour-m1.1", is_current: true, redacted, session_status: "approved",
    session_revision: 1, reopen_reason: null,
  },
  inputs: inputs("scored", [
    subject("early", [
      assessment({ taste: 4, hygiene: 5 }, redacted ? "Assessor 1" : "Ayo Assessor", { notes: "=HYPERLINK(\"http://x\")" }),
    ], { name: "+Vendor One" }),
    subject("absent", [], { subject_id: "s2", name: "Vendor Two", outcome_reason: "Did not arrive" }),
  ]),
  revisions: [],
});

describe("CSV formula-injection defence", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "  =1"])("neutralises %j", (v) => {
    expect(csvCell(v).startsWith(`"'`)).toBe(true);
  });
  it("escapes quotes and leaves plain text and numbers alone", () => {
    expect(csvCell('a "b"')).toBe('"a ""b"""');
    expect(csvCell(93.3)).toBe('"93.3"');
    expect(csvCell(null)).toBe('""');
    expect(toCsv([["a", 1]])).toBe('﻿"a","1"\r\n');
  });
  it("applies to subject names and notes in exports", () => {
    const csv = buildCsv(envelope(false));
    expect(csv).toContain(`"'+Vendor One"`);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).not.toMatch(/(^|,)"[=+\-@]/m);
  });
});

describe("export consistency and redaction", () => {
  it("CSV numbers match the shared calculation", () => {
    const env = envelope(false);
    const subj = summarizeSession(env.inputs).subjects[0];
    const csv = buildCsv(env);
    expect(subj.quality).toBe(90);
    expect(csv).toContain(`"'+Vendor One","Early and ready","","5","90","93.3"`);
    expect(csv).toContain(`"Vendor Two","Absent","Did not arrive","0","",""`);
    expect(csv).toContain("Africa/Lagos");
    expect(csv).toContain("Approved — revision 1");
  });

  it("redacted envelopes produce no assessor identity in CSV, PDF content or metadata", async () => {
    const env = envelope(true);
    expect(buildCsv(env)).not.toContain("Ayo");
    const bytes = await buildPdf(env);
    const doc = await PDFDocument.load(bytes);
    const meta = [doc.getTitle(), doc.getAuthor(), doc.getSubject(), doc.getCreator(), doc.getProducer(), doc.getKeywords()].join("|");
    expect(meta).not.toContain("Ayo");
    expect(meta).toContain("SAVOUR");
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("Ayo");
    expect(exportFilename(env, "pdf")).toBe("savour-Saturday-panel-2026-10-10-r1-redacted.pdf");
  });
});

describe("PDF text fidelity", () => {
  async function embedded() {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync(join(process.cwd(), "src/assets/fonts/NotoSans-Regular.ttf")), { subset: true });
    return font;
  }

  it.each(["Ọlá Àdìgún", "Ẹ̀kọ́ Bùkátà", "Ṣadé Ọ̀ṣun", "Ñandú Café", "Zoë Łódź"])("preserves the local name %s", async (name) => {
    const { clean, missing } = makeSanitizer(await embedded());
    expect(clean(name)).toBe(name.normalize("NFC"));
    expect(missing()).toBe(0);
  });

  it("marks (never silently drops) characters the font cannot draw", async () => {
    const { clean, missing } = makeSanitizer(await embedded());
    expect(clean("Stall 🍲 ok")).toBe("Stall \u25A1 ok");
    expect(missing()).toBe(1);
  });

  it("wraps a 2000-character unbroken note inside the page without losing text", async () => {
    const font = await embedded();
    const note = "Ọ".repeat(400) + "x".repeat(1600);
    const lines = wrapText(note, font, 9, 500);
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) expect(font.widthOfTextAtSize(l, 9)).toBeLessThanOrEqual(500);
    expect(lines.join("")).toBe(note);
    const words = wrapText("short words then " + "y".repeat(300) + " end", font, 9, 200);
    expect(words.join(" ").replace(/ /g, "")).toBe(("short words then " + "y".repeat(300) + " end").replace(/ /g, ""));
  });

  it("renders a multi-page PDF for long notes and Unicode names", async () => {
    const env = envelope(false);
    env.inputs.subjects[0].name = "Ọlá Àdìgún Foods";
    env.inputs.subjects[0].assessments[0].notes = "n".repeat(2000);
    const bytes = await buildPdf(env);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    // pdf-lib's font subsetting dropped most glyphs from Noto Sans (blank text, ~15 KB file; seen
    // in visual QA). Fonts must be embedded in full, which makes the file several hundred KB.
    expect(bytes.length).toBeGreaterThan(300_000);
    expect(doc.getTitle()).toContain("Saturday panel");
  });
});

describe("client validation mirrors the server rules", () => {
  it("accepts complete answers and reports per-field errors", () => {
    expect(validateDraft(TWO, { taste: { score: 4 }, hygiene: { na: true, reason: "Closed" } }))
      .toEqual({ ok: true, answers: { taste: 4, hygiene: { na: "Closed" } } });
    const bad = validateDraft(TWO, { taste: { na: true, reason: "x" }, hygiene: { na: true } });
    expect(bad).toEqual({ ok: false, errors: { taste: "N/A is not allowed for this criterion.", hygiene: "Give a reason for N/A." } });
    expect(validateDraft(TWO, {}).ok).toBe(false);
  });
  it("round-trips stored answers into a draft", () => {
    expect(draftFromAnswers({ taste: 4, hygiene: { na: "x" } })).toEqual({ taste: { score: 4 }, hygiene: { na: true, reason: "x" } });
  });
  it("validates template criteria", () => {
    expect(slugKey("Issue resolution!")).toBe("issue_resolution");
    expect(slugKey("5S audit")).toBe("c_5s_audit");
    expect(validateCriteria([], false)).toMatch(/at least one/);
    expect(validateCriteria([], true)).toBeNull();
    expect(validateCriteria([{ key: "a", label: "A", allow_na: false }, { key: "a", label: "B", allow_na: false }], false)).toMatch(/Duplicate/);
  });
});
