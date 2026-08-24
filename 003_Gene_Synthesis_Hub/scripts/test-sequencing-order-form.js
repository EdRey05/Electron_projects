// Smoke test for the Sequencing Order Form row builder + workbook emitter.
// Exercises the pure logic end-to-end without requiring a UI or Excel.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Read the source files and strip ESM imports/exports, then eval.
function loadExports(srcPath, exportsNeeded) {
  let src = readFileSync(srcPath, "utf8");
  // Replace ESM import of xlsx with a placeholder we can inject.
  src = src.replace(/^import \* as XLSX from .*$/gm, "const XLSX = globalThis.__XLSX;");
  src = src.replace(/^export /gm, "");
  // Build a function that returns the requested exports.
  const fn = new Function("globalThis", src + `
    return { ${exportsNeeded.join(", ")} };
  `);
  return fn(globalThis);
}

const XLSX = await import("xlsx");
globalThis.__XLSX = XLSX;

const builderSrc = resolve(ROOT, "src/subapps/SequencingOrderForm/orderFormBuilder.js");
const { buildFormRows, buildWorkbook, serializeWorkbook } = loadExports(
  builderSrc,
  ["buildFormRows", "buildWorkbook", "serializeWorkbook"]
);

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else { console.log(`✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
}

// Test 1: single sample, single primer
{
  const orderedSamples = [["JOB-001", "pUC19-A1"]];
  const primersDict = { "JOB-001": ["T7-F (* standard)"] };
  const built = buildFormRows(orderedSamples, primersDict, "2026-08-23");
  check("1 row from 1 sample + 1 primer", built.rows.length === 1);
  check("row has correct jobId", built.rows[0].jobId === "JOB-001");
  check("row has correct sampleId", built.rows[0].sequenceSampleId === "pUC19-A1");
  check("row has correct primer", built.rows[0].primer === "T7-F (* standard)");
  check("primer split on '(*' + trimmed", built.rows[0].primerShort === "T7-F");
  check("no warnings", built.warnings.length === 0);
}

// Test 2: one sample with 3 primers produces 3 rows
{
  const orderedSamples = [["JOB-002", "pUC19-A2"]];
  const primersDict = { "JOB-002": ["F1", "F2", "R1"] };
  const built = buildFormRows(orderedSamples, primersDict, "2026-08-23");
  check("1 sample + 3 primers -> 3 rows", built.rows.length === 3);
  check("row 0 is F1", built.rows[0].primer === "F1");
  check("row 2 is R1", built.rows[2].primer === "R1");
}

// Test 3: missing primers produces a warning, row skipped
{
  const orderedSamples = [["JOB-003", "vec1"], ["JOB-004", "vec2"]];
  const primersDict = { "JOB-003": ["p1"], "JOB-004": [] };
  const built = buildFormRows(orderedSamples, primersDict, "x");
  check("missing-primer sample skipped", built.rows.length === 1);
  check("only JOB-003 produced a row", built.rows[0].jobId === "JOB-003");
  check("warning generated for missing", built.warnings.length === 1);
  check("warning text mentions JOB-004", built.warnings[0].includes("JOB-004"));
}

// Test 4: warning dedup — same missing jobID twice still one warning
{
  const orderedSamples = [["JOB-005", "v1"], ["JOB-005", "v1-again"]];
  const primersDict = { "JOB-005": [] };
  const built = buildFormRows(orderedSamples, primersDict, "x");
  check("dup missing still 0 rows", built.rows.length === 0);
  check("dup missing -> 1 warning", built.warnings.length === 1);
}

// Test 5: buildWorkbook produces valid xlsx data
{
  const orderedSamples = [["JOB-006", "vector-1"]];
  const primersDict = { "JOB-006": ["M13F"] };
  const built = buildFormRows(orderedSamples, primersDict, "2026-08-23");
  const wb = buildWorkbook(built, "validation_file.xlsx");
  check("workbook has Sheet1", !!wb.Sheets["Sheet1"]);
  check("workbook has SheetNames", Array.isArray(wb.SheetNames));
  const buf = serializeWorkbook(wb);
  // xlsx returns ArrayBuffer when type="array"
  check("serialized is ArrayBuffer", buf instanceof ArrayBuffer);
  const bytes = new Uint8Array(buf);
  check("serialized bytes non-empty", bytes.length > 100);
  // First two bytes of a ZIP/XLSX file are PK (0x50 0x4B)
  check("starts with ZIP signature (PK)", bytes[0] === 0x50 && bytes[1] === 0x4b);
}

// Test 6: workbook with warnings has a Warnings sheet
{
  const orderedSamples = [["JOB-007", "v"]];
  const primersDict = {}; // empty - all missing
  const built = buildFormRows(orderedSamples, primersDict, "x");
  const wb = buildWorkbook(built, "vf.xlsx");
  check("warnings sheet exists", !!wb.Sheets["Warnings"]);
  check("warnings sheet has rows", Object.keys(wb.Sheets["Warnings"]).length > 1);
}

// Test 7: empty inputs produce a workbook with just the header row
{
  const orderedSamples = [];
  const primersDict = {};
  const built = buildFormRows(orderedSamples, primersDict, "x");
  const wb = buildWorkbook(built, "vf.xlsx");
  const buf = serializeWorkbook(wb);
  check("empty inputs still produce valid xlsx (header only)", buf.byteLength > 100);
  check("empty inputs produce no warnings", built.warnings.length === 0);
}

// Helper: read the raw sheet1.xml from a written xlsx ArrayBuffer and
// confirm whether a given cell has an `<f>...</f>` formula. This avoids
// the xlsx library's known round-trip bug where formula cells are dropped
// during XLSX.read even though they're correctly written into the XML.
function findFormulaInXml(buf, cellRef) {
  // Find the sheet1.xml local file header in the zip and read the data.
  const needle = Buffer.from("xl/worksheets/sheet1.xml");
  let headerStart = -1;
  for (let j = 0; j < buf.byteLength - needle.length - 30; j++) {
    if (
      buf[j] === 0x50 && buf[j+1] === 0x4b && buf[j+2] === 0x03 && buf[j+3] === 0x04
    ) {
      const fnameLen = buf.readUInt16LE(j + 26);
      const fname = buf.slice(j + 30, j + 30 + fnameLen).toString("ascii");
      if (fname.endsWith("sheet1.xml")) {
        headerStart = j;
        break;
      }
    }
  }
  if (headerStart < 0) return null;
  const fnameLen = buf.readUInt16LE(headerStart + 26);
  const dataStart = headerStart + 30 + fnameLen;
  const method = buf.readUInt16LE(headerStart + 8);
  const compSize = buf.readUInt32LE(headerStart + 18);
  let xml;
  if (method === 0) {
    xml = buf.slice(dataStart, dataStart + compSize).toString("utf8");
  } else {
    // Need to actually inflate; we have zlib in Node.
    const zlib = require("zlib");
    xml = zlib.inflateRawSync(buf.slice(dataStart, dataStart + compSize)).toString("utf8");
  }
  // Look for <c r="CELLREF" ...><f>...</f></c>
  const re = new RegExp(`<c r="${cellRef}"[^>]*>([\\s\\S]*?)</c>`);
  const m = xml.match(re);
  if (!m) return null;
  const inner = m[1];
  const fMatch = inner.match(/<f[^>]*>([^<]*)<\/f>/);
  return fMatch ? fMatch[1] : null;
}

function findCellValueInXml(buf, cellRef) {
  // Find sheet1.xml in zip
  const needle = Buffer.from("xl/worksheets/sheet1.xml");
  let headerStart = -1;
  for (let j = 0; j < buf.byteLength - needle.length - 30; j++) {
    if (
      buf[j] === 0x50 && buf[j+1] === 0x4b && buf[j+2] === 0x03 && buf[j+3] === 0x04
    ) {
      const fnameLen = buf.readUInt16LE(j + 26);
      const fname = buf.slice(j + 30, j + 30 + fnameLen).toString("ascii");
      if (fname.endsWith("sheet1.xml")) {
        headerStart = j;
        break;
      }
    }
  }
  if (headerStart < 0) return null;
  const fnameLen = buf.readUInt16LE(headerStart + 26);
  const dataStart = headerStart + 30 + fnameLen;
  const method = buf.readUInt16LE(headerStart + 8);
  const compSize = buf.readUInt32LE(headerStart + 18);
  let xml;
  if (method === 0) {
    xml = buf.slice(dataStart, dataStart + compSize).toString("utf8");
  } else {
    const zlib = require("zlib");
    xml = zlib.inflateRawSync(buf.slice(dataStart, dataStart + compSize)).toString("utf8");
  }
  const re = new RegExp(`<c r="${cellRef}"[^>]*?>([\\s\\S]*?)</c>`);
  const m = xml.match(re);
  if (!m) return null;
  const inner = m[1];
  const vMatch = inner.match(/<v>([^<]*)<\/v>/);
  return vMatch ? vMatch[1] : null;
}

// Test 8: round-trip — serialize, then inspect the raw XML to confirm
// data + formulas are present in the actual .xlsx file. (xlsx's read has
// a known bug where formula cells without a cached value are dropped; the
// XML itself contains the correct cells, which Excel will pick up.)
{
  const orderedSamples = [["JOB-008", "vec-A"], ["JOB-009", "vec-B"]];
  const primersDict = {
    "JOB-008": ["Primer-1 (*with note)", "Primer-2"],
    "JOB-009": ["Primer-3"],
  };
  const built = buildFormRows(orderedSamples, primersDict, "2026-08-23");
  const wb = buildWorkbook(built, "validation.xlsx");
  const buf = serializeWorkbook(wb);
  const bytes = Buffer.from(buf);

  // Data cells should be present in the XML.
  check("xml: C20 has value vec-A", findCellValueInXml(bytes, "C20") === "vec-A");
  check("xml: D20 has value Primer-1 (*with note)",
        findCellValueInXml(bytes, "D20") === "Primer-1 (*with note)");
  check("xml: K20 has value Primer-1 (trimmed)",
        findCellValueInXml(bytes, "K20") === "Primer-1");
  check("xml: G20 has value JOB-008", findCellValueInXml(bytes, "G20") === "JOB-008");
  check("xml: H20 has value 2026-08-23", findCellValueInXml(bytes, "H20") === "2026-08-23");
  check("xml: C22 has value vec-B", findCellValueInXml(bytes, "C22") === "vec-B");
  check("xml: C21 has value vec-A (row 2)", findCellValueInXml(bytes, "C21") === "vec-A");

  // Formula cells should be present with the right formula text.
  const eFormula = findFormulaInXml(bytes, "E20");
  check("xml: E20 has CONCATENATE formula",
        typeof eFormula === "string" && eFormula.startsWith("CONCATENATE"));
  check("xml: E20 references C20, G20, D20, H20",
        eFormula && eFormula.includes("C20") && eFormula.includes("G20")
        && eFormula.includes("D20") && eFormula.includes("H20"));
  const iFormula = findFormulaInXml(bytes, "I20");
  check("xml: I20 has VLOOKUP formula",
        typeof iFormula === "string" && iFormula.startsWith("VLOOKUP"));
  check("xml: I20 references 'validation.xlsx'",
        iFormula && iFormula.includes("validation.xlsx"));
  check("xml: I20 references 'Sequencing Pending' sheet",
        iFormula && iFormula.includes("Sequencing Pending"));
  const lFormula = findFormulaInXml(bytes, "L20");
  check("xml: L20 has CONCATENATE formula",
        typeof lFormula === "string" && lFormula.startsWith("CONCATENATE"));
}

// Save a sample output for human inspection.
{
  const orderedSamples = [["DEMO-001", "vec-A"], ["DEMO-002", "vec-B"]];
  const primersDict = {
    "DEMO-001": ["T7-F (* promoter)", "T7-R"],
    "DEMO-002": ["M13-F", "M13-R (* standard)"],
  };
  const built = buildFormRows(orderedSamples, primersDict, "2026-08-23");
  const wb = buildWorkbook(built, "validation.xlsx");
  const buf = serializeWorkbook(wb);
  const out = resolve(ROOT, "scripts/test-output-order-form.xlsx");
  writeFileSync(out, Buffer.from(buf));
  console.log(`\n  Sample output: ${out} (${buf.byteLength} bytes)`);
}

console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) failed"}.`);
process.exit(failed === 0 ? 0 : 1);
