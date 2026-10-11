import { describe, expect, it } from "vitest";
import { EXAMPLE_CSV, mapImport, MAX_IMPORT_ROWS, parseCsv } from "@/lib/csv-import";

describe("CSV parsing", () => {
  it("handles BOM, CRLF, quoted commas, escaped quotes and quoted line breaks", () => {
    const text = '﻿name,type\r\n"Suya Spot, Gate 2",vendor\r\n"Tunde ""TJ"" Bello",supplier\r\n"Two\r\nlines",outlet\r\n';
    const r = parseCsv(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records.map((x) => [x.line, ...x.cells])).toEqual([
      [1, "name", "type"], [2, "Suya Spot, Gate 2", "vendor"], [3, 'Tunde "TJ" Bello', "supplier"], [4, "Two\nlines", "outlet"],
    ]);
  });

  it("keeps the source line numbers after a multi-line field and with LF or CR endings", () => {
    const r = mapImport('name,type\n"A\nB",vendor\n\nC,vendor\rD,vendor');
    expect(r.ok && r.rows.map((x) => [x.line, x.cells.name])).toEqual([[2, "A\nB"], [5, "C"], [6, "D"]]);
    expect(r.ok && r.skippedBlank).toBe(1);
  });

  it("keeps Unicode exactly (NFC applied in the database)", () => {
    const r = mapImport("name,type\nỌ̀ṣun Grill,vendor\n日本の屋台,vendor\n");
    expect(r.ok && r.rows.map((x) => x.cells.name)).toEqual(["Ọ̀ṣun Grill", "日本の屋台"]);
  });

  it("reports malformed quoting with a line number", () => {
    expect(parseCsv('name,type\n"open,vendor\n')).toEqual({ ok: false, error: "Line 2: a quoted field is not closed." });
    expect(parseCsv('name,type\n"a"b,vendor\n')).toMatchObject({ ok: false, error: expect.stringContaining("Line 2") });
    expect(parseCsv('name,type\nab"c,vendor\n')).toMatchObject({ ok: false });
  });
});

describe("import mapping (file-level checks only; rows are validated by the database)", () => {
  it("maps the example file", () => {
    const r = mapImport(EXAMPLE_CSV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(3);
    expect(r.rows[1].cells).toMatchObject({ name: "Suya Spot, Gate 2", locations: "Main Site;Annex", contact_email: "" });
    expect(r.rows[2].cells.contact_name).toBe('Tunde "TJ" Bello');
  });

  it("accepts friendly heading variants", () => {
    const r = mapImport("Subject Name, Type ,External ID,Location\nA,vendor,1,Main\n");
    expect(r.ok && r.columns).toEqual(["name", "type", "external_id", "locations"]);
  });

  it.each([
    ["", "The file is empty."],
    ["\r\n\r\n", "The file is empty."],
    ["name,type\n", "The file has a heading row but no subjects."],
    ["name,colour\nA,red\n", "Unknown column(s): colour. Use the example file's headings."],
    ["name,type,name\nA,vendor,B\n", 'Column "name" appears twice.'],
    ["name\nA\n", 'The heading row needs a "type" column.'],
    ["name,type\nA,vendor,extra\n", "Line 2 has more values than there are columns. Quote values that contain commas."],
  ])("rejects %j", (text, error) => {
    expect(mapImport(text)).toEqual({ ok: false, error });
  });

  it("caps the number of rows", () => {
    const text = "name,type\n" + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `S${i},vendor`).join("\n");
    expect(mapImport(text)).toMatchObject({ ok: false, error: expect.stringContaining("At most 500") });
  });

  it("fills short rows with blanks (blank optional cells keep existing values on update)", () => {
    const r = mapImport("name,type,category\nA,vendor\n");
    expect(r.ok && r.rows[0].cells).toEqual({ name: "A", type: "vendor", category: "" });
  });
});
