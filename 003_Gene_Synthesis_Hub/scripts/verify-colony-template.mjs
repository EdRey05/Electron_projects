/**
 * Colony PCR template-output harness.
 *
 * Proves the React port now produces what the Python produces:
 *   - the plate frame survives (row letters A-H in column A, column
 *     numbers 1-12 in row 2)
 *   - the grid cells carry a border
 *   - the clone labels land in the right wells
 *   - the clone group is outlined with a THICK border
 *   - the samples table uses the canonical headers and numeric Length (bp)
 *   - the mix table sits below the samples table with the right volumes
 *   - the Label sheet has one row per job
 *   - a second plate is a clone of the template sheet (same frame)
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import ExcelJS from "exceljs";
import { planPlates } from "../src/subapps/ColonyPCRLayout/platePlanner.js";
import { buildWorkbookBytes } from "../src/subapps/ColonyPCRLayout/workbookBuilder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const TEMPLATE = join(ROOT, "python-app", "Templates", "ColonyPCR_layout_v3.xlsx");

let failures = 0;
let checks = 0;
function check(name, cond, detail = "") {
  checks += 1;
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`);
  }
}

const summaryData = [
  {
    "Work No.": "W1",
    "BBI ID": "BBI-1",
    Vector: "pUC19",
    Resistance: "Amp",
    Primers: "F1-R1",
    "Length (bp)": 2686,
    Host: "TOP10",
    Temperature: "37C",
    SourceFile: "C:/seq/lig1.xlsx",
  },
  {
    "Work No.": "W2",
    "BBI ID": "BBI-2",
    Vector: "pUC19",
    Resistance: "Amp",
    Primers: "F2-R2",
    "Length (bp)": 3000,
    Host: "TOP10",
    Temperature: "37C",
    SourceFile: "C:/seq/lig1.xlsx",
  },
];

const counts = new Map([
  ["W1\0C:/seq/lig1.xlsx", 4],
  ["W2\0C:/seq/lig1.xlsx", 3],
]);

const plan = planPlates(summaryData, counts);

const templateBytes = readFileSync(TEMPLATE);
const bytes = await buildWorkbookBytes(plan, summaryData, counts, templateBytes, new Date(2026, 9, 20));

const wb = new ExcelJS.Workbook();
await wb.xlsx.load(bytes);
const ws = wb.getWorksheet("Plate 1");

console.log("\n=== PLATE FRAME ===");
check("Plate 1 sheet exists", !!ws);
check("row letters A-H in column A", ["A", "B", "C", "D", "E", "F", "G", "H"].every(
  (l, i) => ws.getCell(`A${3 + i}`).value === l
), JSON.stringify(["A3", "A4", "A10"].map((r) => ws.getCell(r).value)));
check("column numbers 1-12 in row 2", Array.from({ length: 12 }, (_, i) => i + 1).every(
  (n, i) => ws.getRow(2).getCell(2 + i).value === n
));

console.log("\n=== GRID CONTENT + BORDERS ===");
check("W1-Clone1 at B3", ws.getCell("B3").value === "W1-Clone1", String(ws.getCell("B3").value));
check("W1-Clone4 at B6", ws.getCell("B6").value === "W1-Clone4", String(ws.getCell("B6").value));
// W2 has different primers -> it starts a NEW COLUMN (C), same as the Python.
check("W2-Clone1 at C3 (new column for new primers)", ws.getCell("C3").value === "W2-Clone1", String(ws.getCell("C3").value));
check("W2-Clone3 at C5", ws.getCell("C5").value === "W2-Clone3", String(ws.getCell("C5").value));
check("grid cell B3 has a border", !!ws.getCell("B3").border?.left, JSON.stringify(ws.getCell("B3").border));
check(
  "clone group W1 has a THICK top border",
  ws.getCell("B3").border?.top?.style === "thick",
  JSON.stringify(ws.getCell("B3").border?.top)
);
check(
  "clone group W1 has a THICK left border",
  ws.getCell("B3").border?.left?.style === "thick",
  JSON.stringify(ws.getCell("B3").border?.left)
);
check(
  "interior cell of the group has a THIN border",
  ws.getCell("B4").border?.top?.style === "thin",
  JSON.stringify(ws.getCell("B4").border?.top)
);
check("controls placed (CK+/CK- present somewhere in the grid)", (() => {
  for (let r = 3; r <= 10; r++) {
    for (let c = 2; c <= 13; c++) {
      const v = ws.getRow(r).getCell(c).value;
      if (v === "CK+" || v === "CK-") return true;
    }
  }
  return false;
})());

console.log("\n=== SAMPLES TABLE ===");
check("B13 header is 'Work No.'", ws.getCell("B13").value === "Work No.", String(ws.getCell("B13").value));
check("C13 header is 'BBI ID'", ws.getCell("C13").value === "BBI ID", String(ws.getCell("C13").value));
check("G13 header is 'Length (bp)'", ws.getCell("G13").value === "Length (bp)", String(ws.getCell("G13").value));
check("B14 has the first job", ws.getCell("B14").value === "W1", String(ws.getCell("B14").value));
check(
  "G14 Length (bp) is a NUMBER",
  typeof ws.getCell("G14").value === "number" && ws.getCell("G14").value === 2686,
  JSON.stringify(ws.getCell("G14").value)
);
check("samples table cells have a border", !!ws.getCell("B13").border?.bottom, JSON.stringify(ws.getCell("B13").border));

console.log("\n=== MIX TABLE ===");
// samples: 2 data rows -> rows 14,15 -> samples_end_row = 16 -> mix at 17
const mixRow = 17;
check(`B${mixRow} is 'Mix Calculation'`, ws.getCell(`B${mixRow}`).value === "Mix Calculation", String(ws.getCell(`B${mixRow}`).value));
check(`B${mixRow + 1} is 'Taq'`, ws.getCell(`B${mixRow + 1}`).value === "Taq");
check(`B${mixRow + 2} is 'H2O'`, ws.getCell(`B${mixRow + 2}`).value === "H2O");
check(`C${mixRow} is the first primer pair`, ws.getCell(`C${mixRow}`).value === "F1-R1", String(ws.getCell(`C${mixRow}`).value));
// 4 clones -> Taq = 10*(4+1) = 50
check(`C${mixRow + 1} Taq = 50 (4 clones)`, ws.getCell(`C${mixRow + 1}`).value === 50, String(ws.getCell(`C${mixRow + 1}`).value));
// 3 clones -> Taq = 10*(3+1) = 40
check(`D${mixRow + 1} Taq = 40 (3 clones)`, ws.getCell(`D${mixRow + 1}`).value === 40, String(ws.getCell(`D${mixRow + 1}`).value));
check(`C${mixRow + 2} H2O = 42 (4 clones)`, Math.abs(ws.getCell(`C${mixRow + 2}`).value - 42) < 1e-9, String(ws.getCell(`C${mixRow + 2}`).value));

console.log("\n=== LABEL SHEET ===");
const label = wb.getWorksheet("Label");
check("Label sheet exists", !!label);
check("Label A1 is 'Date'", label.getCell("A1").value === "Date", String(label.getCell("A1").value));
check("Label C1 is 'ITEM #'", label.getCell("C1").value === "ITEM #", String(label.getCell("C1").value));
check("Label has 2 data rows", label.rowCount === 3, `rowCount=${label.rowCount}`);
check("Label C2 is 'W1-ColoPCR'", label.getCell("C2").value === "W1-ColoPCR", String(label.getCell("C2").value));
check("Label E2 QTY is 1", label.getCell("E2").value === 1, String(label.getCell("E2").value));
check("Label column widths applied", !!label.getColumn(3).width, String(label.getColumn(3).width));

console.log("\n=== PLATE HEADER ===");
check("A1 has a plate header", /^U\d{4}ColonyPCR-P1$/.test(String(ws.getCell("A1").value)), String(ws.getCell("A1").value));
check("A1 is bold", !!ws.getCell("A1").font?.bold, JSON.stringify(ws.getCell("A1").font));

console.log("\n=== MULTI-PLATE CLONE ===");
// Force a second plate: 120 clones of one job cannot fit on 96 wells.
const bigCounts = new Map([["W1\0C:/seq/lig1.xlsx", 120]]);
const bigPlan = planPlates(summaryData, bigCounts);
check("planner produced 2 plates for 120 clones", bigPlan.plates.length === 2, `plates=${bigPlan.plates.length}`);
const bigBytes = await buildWorkbookBytes(bigPlan, summaryData, bigCounts, templateBytes, new Date(2026, 9, 20));
const bigWb = new ExcelJS.Workbook();
await bigWb.xlsx.load(bigBytes);
const p2 = bigWb.getWorksheet("Plate 2");
check("Plate 2 exists", !!p2);
check("Plate 2 has the row letters", p2.getCell("A3").value === "A", String(p2.getCell("A3").value));
check("Plate 2 has the column numbers", p2.getRow(2).getCell(2).value === 1);
check("Plate 2 grid cells have a border", !!p2.getCell("B3").border?.left);
check("Plate 2 header says P2", /^U\d{4}ColonyPCR-P2$/.test(String(p2.getCell("A1").value)), String(p2.getCell("A1").value));

console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
console.log(`  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
