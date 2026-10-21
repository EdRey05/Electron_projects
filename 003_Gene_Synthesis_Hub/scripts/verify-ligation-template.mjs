/**
 * Ligation template round-trip harness (XC-03).
 *
 * Proves the Ligation output:
 *   - keeps the template's formulas (SheetJS turns the 191 shared formulas
 *     into per-cell formulas, but they must all still be there)
 *   - carries `fullCalcOnLoad="1"` so the formulas actually compute on open
 *   - keeps the written rows that fall past the template's original !ref
 *   - does not lose the template's second sheet ("Labels")
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import * as XLSX from "xlsx";
import { unzipSync, strFromU8 } from "fflate";
import { applyFullCalcOnLoad } from "../src/ui/xlsxPostProcess.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TPL = join(__dirname, "..", "python-app", "Templates", "Ligation_Template_v6.xlsx");

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

const tpl = readFileSync(TPL);
const tplFiles = unzipSync(tpl);
const tplWorkbookXml = strFromU8(tplFiles["xl/workbook.xml"]);
const tplSheetParts = Object.keys(tplFiles).filter((k) => /xl\/worksheets\/sheet\d+\.xml$/.test(k));
let tplFormulaCount = 0;
for (const p of tplSheetParts) {
  tplFormulaCount += (strFromU8(tplFiles[p]).match(/<f[ >]/g) || []).length;
}
console.log("TEMPLATE:");
console.log("  sheets in package:", tplSheetParts.length);
console.log("  formula cells:", tplFormulaCount);
console.log("  calcPr:", /<calcPr[^>]*\/>/.exec(tplWorkbookXml)?.[0] ?? "NONE");

// --- the SheetJS round-trip, as the app does it ---
const wb = XLSX.read(tpl, { type: "buffer" });
const layoutSheet = wb.Sheets["Layout"];
check("Layout sheet present", !!layoutSheet);
check("Labels sheet present", !!wb.Sheets["Labels"]);

// Write a row well past the template's original A1:W97 range.
for (let r = 120; r <= 145; r++) {
  layoutSheet[`B${r}`] = { t: "s", v: `row${r}` };
}
layoutSheet["!ref"] = "A1:W150";

const bytes = applyFullCalcOnLoad(XLSX.write(wb, { bookType: "xlsx", type: "buffer" }));
const outFiles = unzipSync(bytes);
const outWorkbookXml = strFromU8(outFiles["xl/workbook.xml"]);
const outSheetParts = Object.keys(outFiles).filter((k) => /xl\/worksheets\/sheet\d+\.xml$/.test(k));
let outFormulaCount = 0;
let allSheetsXml = "";
for (const p of outSheetParts) {
  const xml = strFromU8(outFiles[p]);
  allSheetsXml += xml;
  outFormulaCount += (xml.match(/<f[ >]/g) || []).length;
}

console.log("\nOUTPUT:");
console.log("  sheets in package:", outSheetParts.length);
console.log("  formula cells:", outFormulaCount);
console.log("  calcPr:", /<calcPr[^>]*\/>/.exec(outWorkbookXml)?.[0] ?? "NONE");

console.log("\n=== CHECKS ===");
check("all template formulas survive", outFormulaCount === tplFormulaCount, `${outFormulaCount} vs ${tplFormulaCount}`);
check("calcPr is present", /<calcPr[^>]*\/>/.test(outWorkbookXml), outWorkbookXml.slice(0, 200));
check(
  "calcPr has fullCalcOnLoad=1",
  /<calcPr[^>]*fullCalcOnLoad="1"/.test(outWorkbookXml),
  /<calcPr[^>]*\/>/.exec(outWorkbookXml)?.[0] ?? "none"
);
check("rows past the template's !ref survive", allSheetsXml.includes("row145"), "row145 missing");
check("the Labels sheet survives", outSheetParts.length === tplSheetParts.length, `${outSheetParts.length} vs ${tplSheetParts.length}`);
check(
  "the dimension covers the written rows",
  /<dimension ref="A1:W150"/.test(allSheetsXml) || /<dimension ref="A1:W1\d\d"/.test(allSheetsXml),
  /<dimension ref="([^"]+)"/.exec(allSheetsXml)?.[1] ?? "none"
);

console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
console.log(`  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
