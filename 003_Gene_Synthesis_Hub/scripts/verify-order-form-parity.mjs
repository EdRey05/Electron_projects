/**
 * Verification harness for the Sequencing Order Form parity work.
 *
 * Checks the React port against the Python original's documented contract:
 *   - B18 order form ID derivation (year letter + MMDD + form number)
 *   - the "no primers anywhere" guard
 *   - sample type classification (PFr / PCR marker vs plasmid)
 *   - column B / F / G / H values on the written rows
 *   - the duplicated-Work-No. row behaviour (one row per matching source row)
 *   - the output IS the Empty Order Form template (sheet name, header row,
 *     merged cells) — not a fresh workbook
 *   - the VLOOKUP path carries the absolute output directory
 *
 * Run:  node scripts/verify-order-form-parity.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "node:fs";
import {
  deriveOrderFormId,
  sampleTypeFor,
  buildFormRows,
  buildOrderFormBytes,
  buildValidationRefPath,
  buildRowFormulas,
  WORKING_CONCENTRATION,
  ORDER_FORM_SHEET_NAME,
} from "../src/subapps/SequencingOrderForm/orderFormBuilder.js";
import * as XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(
  __dirname,
  "..",
  "python-app",
  "Templates",
  "Sequencing_order_form_v5.xlsx"
);

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
};

console.log("=== Sequencing Order Form parity verification ===");

// ---------------------------------------------------------------------------
// 1. B18 order form ID — the Python's documented examples
// ---------------------------------------------------------------------------
console.log("\n--- 1. B18 order form ID derivation ---");
const B18_CASES = [
  ["U0304-1", "Q202603041"],
  ["U1015", "Q202610151"],
  ["T1215-1", "Q202512151"],
  ["S0401", "Q202404011"],
  ["U0304-3", "Q202603043"],
  ["U1015-2", "Q202610152"],
];
for (const [dateId, expected] of B18_CASES) {
  const r = deriveOrderFormId(dateId);
  check(`${dateId} -> ${expected}`, r.id === expected, `got ${r.id}`);
}

console.log("\n--- 2. undecipherable date_ID keeps the template value ---");
for (const bad of ["", "nodigits", "U", "12345"]) {
  const r = deriveOrderFormId(bad);
  check(`'${bad}' -> null + warning`, r.id === null && !!r.warning, `id=${r.id}`);
}

// ---------------------------------------------------------------------------
// 3. Sample type classification
// ---------------------------------------------------------------------------
console.log("\n--- 3. sample type (col B) ---");
const TYPE_CASES = [
  ["PFr_001", "Purified PCR product"],
  ["PCR_002", "Purified PCR product"],
  ["SomePFrThing", "Purified PCR product"],
  ["W-001", "Plasmid"],
  ["Plasmid_003", "Plasmid"],
  ["", "Plasmid"],
];
for (const [sampleId, expected] of TYPE_CASES) {
  check(`'${sampleId}' -> ${expected}`, sampleTypeFor(sampleId) === expected, sampleTypeFor(sampleId));
}

// ---------------------------------------------------------------------------
// 4. Row building: columns B, F, G, H + the duplicated-Work-No. behaviour
// ---------------------------------------------------------------------------
console.log("\n--- 4. row building ---");
const primersDict = {
  "W-001": ["P1(*A)", "P2(*B)"],
  "W-002": ["P3(*C)"],
};
// W-001 appears twice (two source rows) — the Python yields 2 sample rows.
const orderedSamples = [
  ["W-001", "PFr_001"],
  ["W-001", "PFr_001b"],
  ["W-002", "W-002_Vector"],
  ["W-003-no-primers", "X"],
];
const built = buildFormRows(orderedSamples, primersDict, "U0304-1");
check(
  "5 rows built (W-001 x2 samples x2 primers = 4, plus W-002 x1)",
  built.rows.length === 5,
  `got ${built.rows.length}`
);
check("order form id derived", built.orderFormId === "Q202603041", built.orderFormId);
check(
  "missing-primer warning emitted for W-003",
  built.warnings.some((w) => w.includes("W-003")),
  built.warnings.join(" | ")
);
check(
  "no warning for a duplicated Work No.",
  built.warnings.filter((w) => w.includes("W-001")).length === 0
);

// ---------------------------------------------------------------------------
// 5. The written workbook carries the right cells
//
// NOTE: we assert against the RAW sheet XML, not a SheetJS read-back.
// SheetJS does not re-read a formula cell that has no cached <v> value, so
// a read-back would report the formulas as missing even when the file is
// correct. The XML is what Excel actually consumes.
// ---------------------------------------------------------------------------
console.log("\n--- 5. written workbook ---");
const templateBytes = readFileSync(TEMPLATE);
const OUTPUT_DIR = "C:\\runs\\U0304";
const bytes = await buildOrderFormBytes(built, {
  templateBytes,
  outputDir: OUTPUT_DIR,
  seqValidationFilename: "Sequencing_validation_v6.xlsx",
});
const { unzipSync, strFromU8 } = await import("fflate");
const zip = unzipSync(new Uint8Array(bytes));
const sheetXml = strFromU8(zip["xl/worksheets/sheet1.xml"]);

/** Read a cell's literal value out of the raw XML. */
const cellXml = (ref) => {
  const m = sheetXml.match(new RegExp(`<c r="${ref}"[^>]*>([\\s\\S]*?)</c>`));
  return m ? m[1] : "";
};
// The written workbook stores strings in the sharedStrings table (t="s"
// with an index), so the literal text has to be resolved through it.
const sharedStrings = [
  ...strFromU8(zip["xl/sharedStrings.xml"] || new Uint8Array()).matchAll(
    /<si>([\s\S]*?)<\/si>/g
  ),
].map((m) =>
  [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
    .map((t) => t[1])
    .join("")
);
const cellText = (ref) => {
  const inner = cellXml(ref);
  if (!inner) return "";
  const inline = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
  if (inline) return inline[1];
  const v = inner.match(/<v>([\s\S]*?)<\/v>/);
  if (!v) return "";
  // t="s" → shared-string index.
  if (/<c\b[^>]*\bt="s"/.test(sheetXml.match(new RegExp(`<c r="${ref}"[^>]*>`))?.[0] || "")) {
    return sharedStrings[Number(v[1])] ?? "";
  }
  return v[1];
};
const cellFormula = (ref) => {
  const m = cellXml(ref).match(/<f[^>]*>([\s\S]*?)<\/f>/);
  return m ? xmlUnescape(m[1]) : "";
};
/** Undo the XML entity escaping the writer applies to formula text. */
const xmlUnescape = (s) =>
  String(s)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

check("B18 carries the order form ID", cellText("B18") === "Q202603041", cellText("B18"));

// Row 20 is the first data row (W-001 / PFr_001 / primer 1).
check("C20 = sample id", cellText("C20") === "PFr_001", cellText("C20"));
check("B20 = sample type", cellText("B20") === "Purified PCR product", cellText("B20"));
check("D20 = primer", cellText("D20") === "P1(*A)", cellText("D20"));
check("F20 = working concentration", cellText("F20") === WORKING_CONCENTRATION, cellText("F20"));
check("G20 = work no", cellText("G20") === "W-001", cellText("G20"));
check("H20 = date id", cellText("H20") === "U0304-1", cellText("H20"));
check("K20 = primer short", cellText("K20") === "P1", cellText("K20"));
check("E20 = CONCATENATE formula", cellFormula("E20").includes("CONCATENATE"), cellFormula("E20"));
check("I20 = VLOOKUP formula", cellFormula("I20").includes("VLOOKUP"), cellFormula("I20"));
check("I20 references the validation sheet", cellFormula("I20").includes("Sequencing Pending"), cellFormula("I20"));
check("J20 = CONCATENATE formula", cellFormula("J20").includes("CONCATENATE"), cellFormula("J20"));
check("L20 = CONCATENATE formula", cellFormula("L20").includes("CONCATENATE"), cellFormula("L20"));

// The Python iterates SAMPLE-major: for each sample row it writes ALL of
// that Work No.'s primers. So the order is
//   row 20 = (W-001, PFr_001,  P1)
//   row 21 = (W-001, PFr_001,  P2)
//   row 22 = (W-001, PFr_001b, P1)
//   row 23 = (W-001, PFr_001b, P2)
//   row 24 = (W-002, W-002_Vector, P3)
check("C21 = second PRIMER of the first sample", cellText("C21") === "PFr_001", cellText("C21"));
check("D21 = second primer", cellText("D21") === "P2(*B)", cellText("D21"));
check("C22 = second SAMPLE row for W-001", cellText("C22") === "PFr_001b", cellText("C22"));
check("D22 = first primer again", cellText("D22") === "P1(*A)", cellText("D22"));

// Rows 20-23: W-001 (2 primers) x 2 sample rows = 4 rows, then W-002 = row 24.
check("B24 = Plasmid", cellText("B24") === "Plasmid", cellText("B24"));
check("G24 = W-002", cellText("G24") === "W-002", cellText("G24"));
check("row count is 5 (4 for W-001 + 1 for W-002)", built.rows.length === 5, `got ${built.rows.length}`);

// Every formula cell made it into the XML.
const formulaCells = [...sheetXml.matchAll(/<c r="([A-Z]+\d+)"[^>]*><f[^>]*>/g)].map((m) => m[1]);
check("20 formula cells written (4 formulas x 5 rows)", formulaCells.length === 20, `got ${formulaCells.length}`);

// The sheetData is NOT empty — the earlier bug produced an empty sheet.
const sheetData = sheetXml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
check("sheetData is populated", sheetData && sheetData[1].length > 100, sheetData ? `${sheetData[1].length} chars` : "missing");

// ---------------------------------------------------------------------------
// 5b. The output IS the Empty Order Form template
//
// The Python loads the template with openpyxl and MUTATES it, so the output
// keeps the form's real header row (row 19), its 12 merged regions (incl.
// B18:D18), its column widths, its print setup and its sheet name
// ("Order form"). A from-scratch workbook has none of that.
// ---------------------------------------------------------------------------
console.log("\n--- 5b. template fidelity ---");
const wbXml = strFromU8(zip["xl/workbook.xml"]);
const sheetNames = [...wbXml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => m[1]);
check(
  `sheet is named "${ORDER_FORM_SHEET_NAME}" (not "Sheet1")`,
  sheetNames.length === 1 && sheetNames[0] === ORDER_FORM_SHEET_NAME,
  sheetNames.join(", ")
);

const mergeBlock = (sheetXml.match(/<mergeCells[\s\S]*?<\/mergeCells>/) || [""])[0];
const mergeRefs = [...mergeBlock.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]);
check("12 merged regions preserved", mergeRefs.length === 12, `got ${mergeRefs.length}`);
check(
  "B18:D18 block preserved",
  mergeRefs.includes("B18:D18"),
  mergeRefs.join(" ")
);

// The real header row (19) must still be there.
check("row 19 header preserved", /<row r="19"/.test(sheetXml));
check("B19 header = 'Sample Type'", cellText("B19") === "Sample Type", cellText("B19"));
check("C19 header = 'Sequence Sample ID'", cellText("C19") === "Sequence Sample ID", cellText("C19"));
check("L19 header = 'New File Name'", cellText("L19") === "New File Name", cellText("L19"));

// The template's column widths + print setup must survive.
check("column widths preserved", (sheetXml.match(/<col /g) || []).length >= 12, `${(sheetXml.match(/<col /g) || []).length} cols`);
check("print setup preserved", /<pageSetup\b/.test(sheetXml) && /<headerFooter\b/.test(sheetXml));
check(
  "conditional formatting rule preserved",
  /<conditionalFormatting[^>]*>\s*<cfRule\b/.test(sheetXml),
  (sheetXml.match(/<conditionalFormatting[\s\S]*?<\/conditionalFormatting>/) || [""])[0].slice(0, 120)
);

// ---------------------------------------------------------------------------
// 5c. The VLOOKUP path — the Python's absolute output dir + bracketed file
// ---------------------------------------------------------------------------
console.log("\n--- 5c. VLOOKUP path ---");
const refPath = buildValidationRefPath(OUTPUT_DIR, "Sequencing_validation_v6.xlsx");
check(
  "ref path = <output_dir>/[<file>]Sequencing Pending",
  refPath === "C:\\runs\\U0304/[Sequencing_validation_v6.xlsx]Sequencing Pending",
  refPath
);
const i20 = cellFormula("I20");
check("I20 embeds the absolute output dir", i20.includes("C:\\runs\\U0304/"), i20);
check(
  "I20 embeds the bracketed validation filename",
  i20.includes("[Sequencing_validation_v6.xlsx]Sequencing Pending"),
  i20
);
check("I20 uses $D:$K,8,0", i20.includes("$D:$K,8,0"), i20);

// The formula strings must match the Python's exactly.
const pyFormulas = buildRowFormulas(20, refPath);
check("E20 matches the Python's CONCATENATE", cellFormula("E20") === pyFormulas.E, cellFormula("E20"));
check("I20 matches the Python's VLOOKUP", i20 === pyFormulas.I, i20);
check("J20 matches the Python's CONCATENATE", cellFormula("J20") === pyFormulas.J, cellFormula("J20"));
check("L20 matches the Python's CONCATENATE", cellFormula("L20") === pyFormulas.L, cellFormula("L20"));

// ---------------------------------------------------------------------------
// 6. The no-primers-anywhere guard
// ---------------------------------------------------------------------------
console.log("\n--- 6. no primers anywhere ---");
const emptyBuilt = buildFormRows([["W-999", "X"]], { "W-999": [] }, "U0304-1");
check("zero rows when no primers", emptyBuilt.rows.length === 0, `got ${emptyBuilt.rows.length}`);
check("warning present", emptyBuilt.warnings.length > 0);

// ---------------------------------------------------------------------------
// 7. The Sequencing Pending row-98 cap is in EXCEL ROW space
//
// The Python reads `iter_rows(min_row=2, max_row=98)` — EXCEL row 98,
// blanks included. The old React reader collapsed the blank rows and then
// capped at 98 POPULATED rows, so it read a different (usually larger) set
// of rows. On the real template (108 sheet rows, only Excel rows 3-5
// populated) the old reader produced 97 entries with no Excel-row-98 limit
// at all.
// ---------------------------------------------------------------------------
console.log("\n--- 7. Sequencing Pending Excel-row-98 cap ---");
const {
  getSequenceSampleId,
  SEQUENCE_PENDING_MAX_EXCEL_ROW,
} = await import("../src/subapps/SequencingOrderForm/dataExtractors.js");
check("the cap is EXCEL row 98", SEQUENCE_PENDING_MAX_EXCEL_ROW === 98, String(SEQUENCE_PENDING_MAX_EXCEL_ROW));

// A synthetic "Sequencing Pending" sheet: work rows at EXCEL rows 97, 98
// and 99. Only 97 and 98 are inside the Python's window.
const synthAoa = [];
for (let r = 0; r < 110; r++) synthAoa.push([]);
synthAoa[0][0] = "Work No.";
synthAoa[0][3] = "Plasmid No.";
synthAoa[96][0] = "W-97"; synthAoa[96][3] = "S97"; // Excel row 97
synthAoa[97][0] = "W-98"; synthAoa[97][3] = "S98"; // Excel row 98 -> INCLUDED
synthAoa[98][0] = "W-99"; synthAoa[98][3] = "S99"; // Excel row 99 -> EXCLUDED
const synthSheet = XLSX.utils.aoa_to_sheet(synthAoa);
const synthWb = XLSX.write(
  { SheetNames: ["Sequencing Pending"], Sheets: { "Sequencing Pending": synthSheet } },
  { bookType: "xlsx", type: "array" }
);
// A File-like object with just the arrayBuffer() the extractor needs.
const synthFile = { arrayBuffer: async () => synthWb };
const synthSamples = await getSequenceSampleId(synthFile, null);
const synthWorkNos = synthSamples.map(([w]) => w);
check(
  "Excel row 99 is EXCLUDED (the old reader included it)",
  !synthWorkNos.includes("W-99"),
  synthWorkNos.join(", ")
);
check("Excel row 98 is INCLUDED", synthWorkNos.includes("W-98"), synthWorkNos.join(", "));
check("Excel row 97 is INCLUDED", synthWorkNos.includes("W-97"), synthWorkNos.join(", "));
check("exactly 2 rows read", synthSamples.length === 2, `got ${synthSamples.length}`);
check(
  "the sample ID comes from column D",
  synthSamples.find(([w]) => w === "W-98")?.[1] === "S98",
  JSON.stringify(synthSamples)
);

// The real template: only Excel rows 3-5 are populated, and 94 of Excel
// rows 2-98 are blank. Both readers agree here — but the OLD reader read
// 97 populated rows with no Excel-row-98 limit.
const realTemplate = path.join(
  __dirname,
  "..",
  "python-app",
  "Templates",
  "Sequencing_validation_v6.xlsx"
);
const realBytes = readFileSync(realTemplate);
const realFile = {
  arrayBuffer: async () => realBytes.buffer.slice(realBytes.byteOffset, realBytes.byteOffset + realBytes.byteLength),
};
const realSamples = await getSequenceSampleId(realFile, null);
check(
  "real template -> 3 rows (Excel rows 3, 4, 5)",
  realSamples.length === 3,
  JSON.stringify(realSamples)
);
check(
  "real template -> the rows are the populated ones",
  realSamples.map(([w]) => w).join(",") === "XV1510005,XV14C0001,ZP14C0004",
  realSamples.map(([w]) => w).join(",")
);
check(
  "real template -> the sample IDs come from column D",
  realSamples.every(([, id]) => /^T\d{4}P/.test(String(id))),
  JSON.stringify(realSamples)
);

console.log("\n=== RESULT:", failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`, "===");
process.exit(failures === 0 ? 0 : 1);
