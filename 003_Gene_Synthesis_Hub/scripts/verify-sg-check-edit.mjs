/**
 * Verification harness for the SG Check surgical xlsx edit.
 *
 * Proves:
 *  1. The external link part survives the edit.
 *  2. The shared strings part survives.
 *  3. The VLOOKUP formulas still reference [1]Initiated!.
 *  4. The folder names land in column A from row 2.
 *  5. Every other zip entry is byte-identical to the original.
 *
 * Run:  node scripts/verify-sg-check-edit.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { unzipSync, zipSync } from "fflate";
import { setColumnA, resolveSheetPart, activeSheetName } from "../src/ui/xlsxEdit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(
  __dirname,
  "..",
  "python-app",
  "Templates",
  "Gene_Seq_Log_v2.xlsx"
);

let failures = 0;
const check = (name, cond, detail = "") => {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${detail ? " — " + detail : ""}`);
};

console.log("=== SG Check surgical edit verification ===");
console.log("template:", TEMPLATE);

const orig = new Uint8Array(fs.readFileSync(TEMPLATE));
const origFiles = unzipSync(orig);

console.log("\n--- 1. baseline template ---");
check("external link part present", Object.keys(origFiles).some((k) => k.includes("externalLink")));
check("sharedStrings part present", Object.keys(origFiles).some((k) => k.includes("sharedStrings")));

const sheetName = activeSheetName(origFiles);
const part = resolveSheetPart(origFiles, sheetName);
console.log("  active sheet:", sheetName, "->", part);

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();
const sheetXml = decoder.decode(origFiles[part]);
const origVlookup = (sheetXml.match(/VLOOKUP/g) || []).length;
console.log("  VLOOKUP formulas in original:", origVlookup);

// --- the edit ---
const names = ["W-001.P1", "W-002.P1", "W-003.P2", "W-004.P2", "W-005.P3"];
const entries = names.map((value, i) => ({ row: i + 2, value }));
const patchedXml = setColumnA(sheetXml, entries);

const files = { ...origFiles };
files[part] = encoder.encode(patchedXml);
const outBytes = zipSync(files, { level: 6 });
const outFiles = unzipSync(outBytes);

console.log("\n--- 2. after the edit ---");
const outKeys = Object.keys(outFiles);
check("external link part survives", outKeys.some((k) => k.includes("externalLink")));
check("sharedStrings part survives", outKeys.some((k) => k.includes("sharedStrings")));
check(
  "workbook.xml externalReferences survives",
  decoder.decode(outFiles["xl/workbook.xml"]).includes("<externalReferences>")
);
check(
  "externalLink relationship survives",
  decoder.decode(outFiles["xl/_rels/workbook.xml.rels"]).includes("externalLink")
);

const outSheetXml = decoder.decode(outFiles[part]);
const outVlookup = (outSheetXml.match(/VLOOKUP/g) || []).length;
check(
  "VLOOKUP formula count unchanged",
  outVlookup === origVlookup,
  `${origVlookup} -> ${outVlookup}`
);
check(
  "formulas still point at [1]Initiated!",
  outSheetXml.includes("[1]Initiated!") || outSheetXml.includes("[1]Initiated")
);

console.log("\n--- 3. folder names landed in column A ---");
for (let i = 0; i < names.length; i++) {
  const row = i + 2;
  const m = outSheetXml.match(new RegExp(`<c r="A${row}"[^>]*>.*?</c>`));
  const cell = m ? m[0] : "";
  check(`A${row} = ${names[i]}`, cell.includes(names[i]), cell.slice(0, 90));
}

console.log("\n--- 4. every other part byte-identical ---");
let changed = [];
for (const key of Object.keys(origFiles)) {
  if (key === part) continue;
  const a = Buffer.from(origFiles[key]);
  const b = Buffer.from(outFiles[key] || new Uint8Array(0));
  if (!a.equals(b)) changed.push(key);
}
check(
  "no other zip part changed",
  changed.length === 0,
  changed.length ? changed.join(", ") : "all identical"
);

console.log("\n--- 5. output opens as a valid xlsx ---");
try {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(outBytes, { type: "array" });
  check("SheetJS can read the output", wb.SheetNames.length > 0, wb.SheetNames.join(", "));
  const ws = wb.Sheets[wb.SheetNames[0]];
  const a2 = ws["A2"];
  check("SheetJS sees A2 value", a2 && a2.v === names[0], a2 ? String(a2.v) : "missing");
  const b2 = ws["B2"];
  check("B2 formula preserved", b2 && b2.f && b2.f.includes("FIND"), b2 && b2.f ? b2.f : "missing");
} catch (err) {
  check("SheetJS can read the output", false, err.message);
}

console.log("\n--- 6. write the output for manual inspection ---");
const outPath = path.join(__dirname, "..", "..", "..", "..", "..", "..", "tmp_sgcheck_out.xlsx");
try {
  fs.writeFileSync(outPath, outBytes);
  console.log("  wrote:", outPath);
} catch {
  const local = path.join(process.cwd(), "tmp_sgcheck_out.xlsx");
  fs.writeFileSync(local, outBytes);
  console.log("  wrote:", local);
}

console.log("\n=== RESULT:", failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`, "===");
process.exit(failures === 0 ? 0 : 1);
