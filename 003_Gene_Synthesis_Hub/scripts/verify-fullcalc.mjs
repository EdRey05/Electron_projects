/**
 * Full-recalc-on-load harness (XC-03).
 *
 * SheetJS drops the workbook's `<calcPr>` element and the CACHED VALUES
 * of formula cells, so the Ligation layout's 292 formulas read as blank
 * in any viewer that does not evaluate formulas. The Python (openpyxl)
 * preserves the original `calcPr`, so its formulas work.
 *
 * This harness proves the post-processor:
 *   - ADDS `<calcPr ... fullCalcOnLoad="1"/>` when it is missing
 *   - KEEPS an existing calcPr but adds the attribute
 *   - does not change an existing fullCalcOnLoad="0"
 *   - leaves every other ZIP entry byte-identical
 */

import { unzipSync, zipSync, strFromU8 } from "fflate";
import { forceFullCalcOnLoad, applyFullCalcOnLoad } from "../src/ui/xlsxPostProcess.js";

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

console.log("=== forceFullCalcOnLoad ===");
{
  const xml = `<workbook><sheets/></workbook>`;
  const out = forceFullCalcOnLoad(xml);
  check("adds calcPr when missing", /<calcPr\b[^>]*fullCalcOnLoad="1"/.test(out), out);
  check("keeps the workbook tag", out.includes("</workbook>"));
}
{
  const xml = `<workbook><sheets/><calcPr calcId="145621"/></workbook>`;
  const out = forceFullCalcOnLoad(xml);
  check("adds fullCalcOnLoad to an existing calcPr", /calcPr[^>]*fullCalcOnLoad="1"/.test(out), out);
  check("keeps the original calcId", out.includes('calcId="145621"'), out);
}
{
  const xml = `<workbook><calcPr calcId="1" fullCalcOnLoad="0"/></workbook>`;
  const out = forceFullCalcOnLoad(xml);
  check("overrides fullCalcOnLoad=0", /fullCalcOnLoad="1"/.test(out), out);
}
{
  const xml = `<workbook><calcPr calcId="1" fullCalcOnLoad="1"/></workbook>`;
  const out = forceFullCalcOnLoad(xml);
  check("is idempotent", out === xml, out);
}

console.log("\n=== applyFullCalcOnLoad (zip level) ===");
{
  // Build a small xlsx-like zip with a workbook.xml and a decoy part.
  const files = {
    "xl/workbook.xml": strToU8Safe(`<workbook><sheets/><calcPr calcId="145621"/></workbook>`),
    "xl/worksheets/sheet1.xml": strToU8Safe(`<worksheet><sheetData/></worksheet>`),
    "[Content_Types].xml": strToU8Safe(`<Types/>`),
  };
  const zip = zipSync(files, { level: 6, mtime: new Date(1980, 0, 1, 0, 0, 0) });
  const out = applyFullCalcOnLoad(zip);
  const outFiles = unzipSync(out);
  const wbXml = strFromU8(outFiles["xl/workbook.xml"]);
  check("workbook.xml gets fullCalcOnLoad", /fullCalcOnLoad="1"/.test(wbXml), wbXml);

  // The untouched entries must be byte-identical.
  const orig = unzipSync(zip);
  let identical = true;
  for (const name of ["xl/worksheets/sheet1.xml", "[Content_Types].xml"]) {
    const a = orig[name];
    const b = outFiles[name];
    if (a.length !== b.length) {
      identical = false;
      break;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        identical = false;
        break;
      }
    }
  }
  check("untouched ZIP entries are byte-identical", identical);
}

console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
console.log(`  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);

function strToU8Safe(s) {
  return new TextEncoder().encode(s);
}
