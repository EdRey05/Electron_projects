/**
 * Verification harness for the sheet-range (!ref) data-loss fix.
 *
 * THE BUG
 * -------
 * SheetJS only writes cells that fall inside a sheet's `!ref` range. Both
 * workbook builders pinned that range:
 *   - ColonyPCRLayout: `sheet["!ref"] = "A1:M50"`
 *   - LigationLayout:  `sheet["!ref"] = "A1:Z100"`
 *
 * Anything past that range was silently dropped from the output file:
 *   - Colony PCR: with 96 samples the mix calculation table lands at row 111
 *     and vanished entirely.
 *   - Ligation: layout rows past row 100 vanished.
 *
 * THE FIX
 * -------
 * Both builders now derive !ref from the cells they actually wrote.
 *
 * Run:  node scripts/verify-sheet-range.mjs
 */
import * as XLSX from "xlsx";
import { unzipSync, strFromU8 } from "fflate";
import { buildWorkbookBytes } from "../src/subapps/ColonyPCRLayout/workbookBuilder.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLONY_TEMPLATE = join(__dirname, "..", "python-app", "Templates", "ColonyPCR_layout_v3.xlsx");

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
};

console.log("=== sheet range (!ref) data-loss verification ===");

// ---------------------------------------------------------------------------
// 1. Colony PCR: a plate with many samples must keep its mix table
// ---------------------------------------------------------------------------
console.log("\n--- 1. Colony PCR mix table past row 50 ---");

// Build a plate with 90 jobs -> 90 sample rows -> mix table at row 14+90+1 = 105.
const jobs = [];
for (let i = 0; i < 90; i++) {
  jobs.push({
    jobId: `W-${String(i + 1).padStart(3, "0")}`,
    label: `W-${String(i + 1).padStart(3, "0")} clone ${i + 1}`,
    row: i % 8,
    col: i % 12,
    primers: "P1(*A)",
  });
}
const plate = { jobs, controls: [{ label: "CK", row: 7, col: 11 }] };
const summaryData = jobs.map((j) => ({
  "Work No.": j.jobId,
  "BBI ID": `BBI-${j.jobId}`,
  Vector: "pUC19",
  Resistance: "Amp",
  Primers: "P1(*A)",
  "Length (bp)": 2686,
  Host: "TOP10",
  Temperature: "37C",
  SourceFile: "C:/x/U1001-Ligation-FL.xlsx",
}));

const bytes = await buildWorkbookBytes(
  { plates: [plate] },
  summaryData,
  new Map(),
  readFileSync(COLONY_TEMPLATE),
  new Date(2026, 9, 20)
);
const zip = unzipSync(new Uint8Array(bytes));
const sheetXml = strFromU8(zip["xl/worksheets/sheet1.xml"]);

const mixRow = 14 + 90 + 1; // 105
check("mix header is at row 105", mixRow === 105, String(mixRow));
const mixCell = sheetXml.match(new RegExp(`<c r="B${mixRow}"[^>]*>.*?</c>`));
check("mix table header present in the XML", !!mixCell, mixCell ? mixCell[0].slice(0, 80) : "MISSING");

// The ExcelJS output stores strings in the shared string table, so the
// cell's <v> is an INDEX into it. Resolve it rather than comparing the
// raw index.
const sharedStrings = (() => {
  const raw = zip["xl/sharedStrings.xml"];
  if (!raw) return [];
  const xml = strFromU8(raw);
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")
  );
})();
const cellText = (xml) => {
  if (!xml) return null;
  const v = (xml.match(/<v>([^<]*)<\/v>/) || [])[1];
  if (v === undefined) return null;
  if (/t="s"/.test(xml)) return sharedStrings[Number(v)] ?? null;
  return v;
};
const mixValue = cellText(mixCell ? mixCell[0] : null);
check("mix header value is 'Mix Calculation'", mixValue === "Mix Calculation", String(mixValue));

// The mix values row (Taq / H2O / Fwd / Rev) is 4 rows below the header.
const taqCell = sheetXml.match(new RegExp(`<c r="B${mixRow + 1}"[^>]*>.*?</c>`));
check("Taq row present", !!taqCell, taqCell ? taqCell[0].slice(0, 80) : "MISSING");

// The samples table must be complete too.
const lastSampleRow = 14 + 90 - 1;
const lastSample = sheetXml.match(new RegExp(`<c r="B${lastSampleRow}"[^>]*>.*?</c>`));
check("last sample row present", !!lastSample, lastSample ? lastSample[0].slice(0, 80) : "MISSING");

// The sheet dimension must cover the whole used range.
const dim = sheetXml.match(/<dimension ref="([^"]+)"/);
check("dimension covers row 109", dim && parseInt(dim[1].split(":")[1].replace(/[A-Z]/g, ""), 10) >= 109, dim ? dim[1] : "none");

// A1 plate header.
const a1 = sheetXml.match(/<c r="A1"[^>]*>[\s\S]*?<\/c>/);
const a1Val = cellText(a1 ? a1[0] : null);
check("A1 plate header present", !!a1Val, String(a1Val));

// ---------------------------------------------------------------------------
// 2. Ligation: rows past 100 must survive
// ---------------------------------------------------------------------------
console.log("\n--- 2. Ligation rows past row 100 ---");
const { writeLayoutRows } = await import("../src/subapps/LigationLayout/workbookBuilder.js");

// Build a fake workbook with a Layout sheet whose !ref is the template's
// (A1:W97) and with the Insert headers in the right place.
const layoutSheet = {};
layoutSheet["!ref"] = "A1:W97";
const insertCols = { I: "Insert 1", L: "Insert 2", O: "Insert 3" };
for (const [col, label] of Object.entries(insertCols)) {
  layoutSheet[`${col}1`] = { t: "s", v: label };
}
layoutSheet["A1"] = { t: "s", v: "Well" };
layoutSheet["B1"] = { t: "s", v: "Work No." };
layoutSheet["T1"] = { t: "s", v: "Length (bp)" };
const ligWb = { SheetNames: ["Layout"], Sheets: { Layout: layoutSheet } };

// 120 layout rows -> row 121, well past the template's 97.
const rows = [];
for (let i = 0; i < 120; i++) {
  rows.push({
    job_id: `W-${String(i + 1).padStart(3, "0")}`,
    bbid: `BBI-${i + 1}`,
    vector: "pUC19",
    enzyme: "EcoRI",
    length: 2686,
    resistance: "Amp",
    host: "TOP10",
    temperature: "37C",
    is_manual: false,
  });
}
const lookups = { resistance: { pUC19: "Amp" }, length: { pUC19: 2686 }, digested: {} };
const { insertColumns } = writeLayoutRows(ligWb, rows, lookups);
check("Insert columns discovered", insertColumns["Insert 1"] === 9, JSON.stringify(insertColumns));

const ligBytes = XLSX.write(ligWb, { bookType: "xlsx", type: "array" });
const ligZip = unzipSync(new Uint8Array(ligBytes));
const ligXml = strFromU8(ligZip["xl/worksheets/sheet1.xml"]);

const row121 = ligXml.match(/<c r="B121"[^>]*>.*?<\/c>/);
check("row 121 present in the XML", !!row121, row121 ? row121[0].slice(0, 60) : "MISSING");
const row121Val = row121 ? (row121[0].match(/<v>([^<]*)<\/v>/) || [])[1] : null;
check("row 121 carries the last Work No.", row121Val === "W-120", String(row121Val));

const t121 = ligXml.match(/<c r="T121"[^>]*>.*?<\/c>/);
check("row 121 Length (bp) present", !!t121, t121 ? t121[0].slice(0, 60) : "MISSING");

const ligDim = ligXml.match(/<dimension ref="([^"]+)"/);
check(
  "dimension covers row 121",
  ligDim && parseInt(ligDim[1].split(":")[1].replace(/[A-Z]/g, ""), 10) >= 121,
  ligDim ? ligDim[1] : "none"
);

// ---------------------------------------------------------------------------
// 3. Length (bp) must be written as a NUMBER, not a text cell
// ---------------------------------------------------------------------------
console.log("\n--- 3. Length (bp) cell type ---");
const t121Type = t121 ? (t121[0].match(/\bt="([^"]+)"/) || [])[1] : null;
check("T121 has no t=\"s\" (i.e. it is numeric)", t121Type !== "s", `t=${t121Type}`);

console.log("\n=== RESULT:", failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`, "===");
process.exit(failures === 0 ? 0 : 1);
