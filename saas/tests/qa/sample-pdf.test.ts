// Disposable QA artefact: renders a sample report with the app's own buildPdf so a human can
// check fonts, wrapping and layout. Runs only when QA_SAMPLE_PDF is set to an output path:
//   QA_SAMPLE_PDF=/tmp/savour-qa/sample-report.pdf npx vitest run tests/qa
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildPdf } from "@/lib/pdf";
import type { ReportEnvelope } from "@/lib/report";
import { summarizeSession } from "@/lib/scoring";
import { assessment, inputs, subject, TWO } from "../unit/fixtures";

const out = process.env.QA_SAMPLE_PDF;

export function sampleEnvelope(): ReportEnvelope {
  const doc = inputs("scored", [
    subject("early", [
      assessment({ taste: 4, hygiene: 5 }, "Ọlábísí Adéyẹmí", { notes: "Jollof well seasoned; stall clean. " }),
      assessment({ taste: 4, hygiene: 5 }, "Chinedu Okafor", { notes: "Q".repeat(2000) }),
    ], { subject_id: "s1", name: "Ọlá's Kitchen" }),
    subject("middle", [assessment({ taste: 5, hygiene: 4 }, "Ọlábísí Adéyẹmí")], { subject_id: "s2", name: "Ẹ̀kọ́ Bùkátà", required_assessors: 1 }),
    subject("absent", [], { subject_id: "s3", name: "Àdùnní Foods", outcome_reason: "Did not arrive; notified at 08:40", required_assessors: 2 }),
  ], TWO);
  doc.workspace.name = "Ìbàdàn Food Panel (QA sample)";
  doc.session.name = "Saturday panel — QA sample";
  return {
    meta: { status: "approved", revision: 1, approved_at: "2026-10-10T15:00:00Z", approver_name: "Ṣadé Ògúnlẹ̀yẹ",
      formula_version: "savour-m1.1", is_current: true, redacted: false, session_status: "approved",
      session_revision: 1, reopen_reason: null },
    inputs: doc, revisions: [],
  };
}

describe.skipIf(!out)("QA sample PDF", () => {
  it(`writes ${out}`, async () => {
    const env = sampleEnvelope();
    const sum = summarizeSession(env.inputs);
    expect(sum.subjects.map((s) => [s.status, s.quality, s.combined])).toEqual([
      ["scored", 90, (14 / 15) * 100], ["scored", 90, 80], ["absent", null, null]]);
    const bytes = await buildPdf(env, new Date("2026-10-10T16:00:00Z"));
    mkdirSync(dirname(out!), { recursive: true });
    writeFileSync(out!, bytes);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    console.log(`QA sample written: ${out} (${pdf.getPageCount()} pages, ${bytes.length} bytes)`);
  });
});
