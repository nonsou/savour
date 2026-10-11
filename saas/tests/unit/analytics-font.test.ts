// Browser QA found the generated decline sentence used "→", which the embedded report font cannot
// draw: the PDF showed a box and the unsupported-character warning although no user text needed it.
// Generated analytics text must be drawable by the actual embedded fonts; user-authored text keeps
// its exact characters and the honest box/warning fallback.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildAnalytics, RULES, type AnalyticsDataset, type AnalyticsRecord } from "@/lib/analytics";
import { analyticsSections, headerRows } from "@/lib/analytics-export";
import { makeSanitizer } from "@/lib/pdf";
import type { Outcome } from "@/lib/scoring";
import { assessment, inputs, subject } from "./fixtures";

async function fonts() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const dir = join(process.cwd(), "src", "assets", "fonts");
  // Embedded in full, exactly as buildPdf / buildAnalyticsPdf do.
  return Promise.all(["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"].map((f) => doc.embedFont(readFileSync(join(dir, f)))));
}

// Six scored-attendance inspections: 80% three times, then 70% three times; late in two of the last three.
function dataset(): AnalyticsDataset {
  const outcomes: Outcome[] = ["early", "early", "early", "late", "middle", "late"];
  const records: AnalyticsRecord[] = outcomes.map((o, i) => {
    const p = inputs("scored", [subject(o, [assessment(i < 3 ? { taste: 4, hygiene: 4 } : { taste: 4, hygiene: 3 })], { subject_id: "s1", name: "Alpha Stall" })]);
    p.formula_version = "savour-m3.1";
    p.session.id = `session-${i + 1}`; p.session.local_date = `2026-10-0${i + 1}`;
    return { session_id: p.session.id, revision: 1, approved_at: `2026-10-0${i + 1}T12:00:00Z`, local_date: p.session.local_date,
      location_id: "loc", location_now: "Main Site", template_version_id: "tv1", template_name: "Food panel", template_version: 1,
      pack: "food_vendors", mode: "approved", inputs: p };
  });
  return { mode: "approved", role: "owner", filters: {}, today: "2026-10-11", timezone: "Africa/Lagos", workspace_name: "QA Foods",
    generated_at: "2026-10-11T12:00:00Z", total: 6, truncated: false, live_flags_visible: true, records, findings: [], actions: [],
    options: { locations: [{ id: "loc", name: "Main Site" }], template_versions: [], packs: ["food_vendors"], first_date: null, last_date: null },
    categories_now: [], subjects_now: [] };
}

describe("generated analytics text is drawable by the embedded report fonts", () => {
  it("the decline sentence uses plain words and only supported glyphs", async () => {
    const ds = dataset();
    const r = buildAnalytics(ds, {});
    const decline = r.attention.flags.find((f) => f.kind === "decline")!;
    expect(decline.detail).toBe("Mean quality fell 10.0 points: 80.0% to 70.0% (Food panel v1, savour-m3.1).");
    expect(r.attention.flags.some((f) => f.kind === "attendance")).toBe(true);
    for (const font of await fonts()) {
      const s = makeSanitizer(font);
      expect(s.clean(decline.detail)).toBe(decline.detail);
      expect(s.missing()).toBe(0);
    }
  });

  it("every generated string in the analytics CSV/PDF sections is covered (fixture user text is plain ASCII)", async () => {
    const ds = dataset();
    const r = buildAnalytics(ds, {});
    const texts = [
      ...headerRows(ds, {}, r).flat(), ...Object.values(RULES),
      ...analyticsSections(ds, r).flatMap((s) => [s.title, s.note ?? "", ...s.header, ...s.rows.flat().map((c) => (c === null ? "" : String(c)))]),
    ];
    for (const font of await fonts()) {
      const s = makeSanitizer(font);
      const unsupported = texts.flatMap((t) => [...t].filter((ch) => s.clean(ch) !== ch));
      expect([...new Set(unsupported)]).toEqual([]);
    }
  });

  it("user-authored text keeps its exact characters and the honest fallback", async () => {
    const [regular] = await fonts();
    const s = makeSanitizer(regular);
    expect(s.clean("Ọlá’s stall → gate 2 🍲")).toBe("Ọlá’s stall □ gate 2 □");
    expect(s.missing()).toBe(2);
  });
});
