/**
 * Sequencing Order Form — template round-trip harness.
 *
 * The Python mutates the Empty Order Form template, so the output keeps:
 *   - the sheet name "Order form"
 *   - the real header row (row 19), not a synthetic one at row 1
 *   - the 12 merged regions (including B18:D18)
 *   - the column widths, print setup and page margins
 *   - the data starting at row 20
 *   - B18 carrying the order form ID
 *   - the formula cells in E/I/J/L
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import ExcelJS from "exceljs";
import { unzipSync, strFromU8 } from "fflate";
import { buildOrderFormBytes, buildFormRows } from "../src/subapps/SequencingOrderForm/orderFormBuilder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(__dirname, "..", "python-app", "Templates", "Sequencing_order_form_v5.xlsx");

let failures = 0;
let checks = 0;
function check(name, cond, detail = "") {
  checks += 1;
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`);
  }
}

console.log("=== TEMPLATE BASELINE ===");
const tplBytes = readFileSync(TEMPLATE);
const tplWb = new ExcelJS.Workbook();
await tplWb.xlsx.load(tplBytes);
const tplWs = tplWb.getWorksheet(1);
console.log("  sheet name:", tplWs.name);
console.log("  merges:", (tplWs.model.merges || []).length);
console.log("  B19 (header row):", JSON.stringify(tplWs.getCell("B19").value));
console.log("  B18:", JSON.stringify(tplWs.getCell("B18").value));

// --- what the app now produces ---
// buildFormRows() takes the ordered samples + a primer dictionary and
// returns the rows the form needs.
// buildFormRows takes [[workNo, sampleId], ...] and a
// { workNo -> [primer, ...] } dictionary. One row is emitted per primer.
const orderedSamples = [
  ["W-001", "T0131P1A4"],
  ["W-002", "T0131P1A5"],
];
const primersDict = {
  "W-001": ["P1A4-F"],
  "W-002": ["P1A5-F", "P1A5-R"],
};

const built = buildFormRows(orderedSamples, primersDict, "U1020-1");
console.log("  buildFormRows ->", JSON.stringify(built.rows?.slice(0, 2) ?? built).slice(0, 400));

const outBytes = await buildOrderFormBytes(
  { ...built, orderFormId: "U1020-0042" },
  {
    templateBytes: tplBytes,
    outputDir: "C:/seq/U1020-1",
    seqValidationFilename: "Sequencing_validation_v6.xlsx",
  }
);

console.log("\n=== OUTPUT ===");
const outWb = new ExcelJS.Workbook();
await outWb.xlsx.load(outBytes);
const outWs = outWb.getWorksheet(1);
console.log("  sheet name:", outWs.name);
console.log("  merges:", (outWs.model.merges || []).length);
console.log("  B19:", JSON.stringify(outWs.getCell("B19").value));
console.log("  B18:", JSON.stringify(outWs.getCell("B18").value));

console.log("\n=== CHECKS ===");
check("sheet is named 'Order form'", outWs.name === "Order form", outWs.name);
check("the 12 merged regions survive", (outWs.model.merges || []).length === (tplWs.model.merges || []).length, String((outWs.model.merges || []).length));
check(
  "B18:D18 is still merged",
  (outWs.model.merges || []).some((m) => m === "B18:D18"),
  JSON.stringify(outWs.model.merges)
);
check("B18 carries the order form ID", outWs.getCell("B18").value === "U1020-0042", String(outWs.getCell("B18").value));
// The header cell holds rich text, so compare the rendered text rather
// than the object identity.
const headerText = (v) =>
  v == null
    ? ""
    : typeof v === "object" && v.richText
      ? v.richText.map((r) => r.text).join("")
      : String(v);
check(
  "the real header row is at 19 (not a synthetic row 1)",
  headerText(outWs.getCell("B19").value) === headerText(tplWs.getCell("B19").value) &&
    headerText(outWs.getCell("B19").value) === "Sample Type",
  headerText(outWs.getCell("B19").value)
);
check("row 1 is NOT a synthetic header", outWs.getCell("A1").value == null, JSON.stringify(outWs.getCell("A1").value));

// The data starts at row 20.
console.log("\n=== DATA ROWS (row 20+) ===");
for (let r = 20; r <= 22; r++) {
  const vals = ["B", "C", "D", "F", "G", "H", "K"].map((c) => {
    const v = outWs.getCell(`${c}${r}`).value;
    return v == null ? "" : (typeof v === "object" ? JSON.stringify(v).slice(0, 40) : String(v));
  });
  console.log(`  row ${r}:`, vals.join(" | "));
}
check("B20 has the first sample type", outWs.getCell("B20").value === built.rows[0].sampleType, String(outWs.getCell("B20").value));
check("C20 has the first sample id", outWs.getCell("C20").value === "T0131P1A4", String(outWs.getCell("C20").value));
check("F20 is the working concentration", outWs.getCell("F20").value === "40-60 ng/uL", String(outWs.getCell("F20").value));
check("B21 has the second sample type", outWs.getCell("B21").value === built.rows[1].sampleType, String(outWs.getCell("B21").value));
check("3 rows total (one per primer)", built.rows.length === 3, String(built.rows.length));
check("the third row is the second primer of W-002", outWs.getCell("C22").value === "T0131P1A5", String(outWs.getCell("C22").value));
check("D22 is the second primer", outWs.getCell("D22").value === "P1A5-R", String(outWs.getCell("D22").value));
check("the order form ID is derived from the dateId", /^Q/.test(built.orderFormId || ""), String(built.orderFormId));

// The formula columns.
console.log("\n=== FORMULAS ===");
for (const col of ["E", "I", "J", "L"]) {
  const v = outWs.getCell(`${col}20`).value;
  console.log(`  ${col}20:`, JSON.stringify(v).slice(0, 160));
}
const fE = outWs.getCell("E20").value;
const fI = outWs.getCell("I20").value;
check("E20 is a formula", fE && typeof fE === "object" && "formula" in fE, JSON.stringify(fE));
check("I20 is a formula", fI && typeof fI === "object" && "formula" in fI, JSON.stringify(fI));
check(
  "E20's formula is a CONCATENATE",
  fE && typeof fE === "object" && /CONCATENATE/i.test(fE.formula || ""),
  JSON.stringify(fE)
);
check(
  "I20's formula is a VLOOKUP",
  fI && typeof fI === "object" && /VLOOKUP/i.test(fI.formula || ""),
  JSON.stringify(fI)
);
check(
  "I20's VLOOKUP carries the absolute path + filename + sheet",
  fI && typeof fI === "object" && /\[Sequencing_validation_v6\.xlsx\]Sequencing Pending/.test(fI.formula || ""),
  JSON.stringify(fI)
);
check(
  "I20's VLOOKUP includes the output dir prefix",
  fI && typeof fI === "object" && /C:\/seq\/U1020-1/.test(fI.formula || ""),
  JSON.stringify(fI)
);

// The raw XML must actually contain the <f> elements.
const files = unzipSync(new Uint8Array(outBytes));
const sheetParts = Object.keys(files).filter((k) => /xl\/worksheets\/sheet\d+\.xml$/.test(k));
let allXml = "";
for (const p of sheetParts) allXml += strFromU8(files[p]);
console.log("\n=== RAW XML ===");
const fCount = (allXml.match(/<f>/g) || []).length;
console.log("  <f> elements in the sheet XML:", fCount);
check("the sheet XML contains the formula elements", fCount >= 8, String(fCount));
check("the sheet XML contains the VLOOKUP", /VLOOKUP/.test(allXml));

console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
console.log(`  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
