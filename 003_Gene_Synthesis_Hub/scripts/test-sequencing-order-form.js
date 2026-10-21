// Smoke test for the Sequencing Order Form row builder + workbook emitter.
// Exercises the pure logic end-to-end without requiring a UI or Excel.
//
// The output is the Empty Order Form TEMPLATE, filled in (the Python loads
// the template with openpyxl and mutates it), so the test reads the real
// template out of python-app/Templates and inspects the emitted sheet XML.
//
// Run:  node scripts/test-sequencing-order-form.js
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import {
  buildFormRows,
  buildOrderFormBytes,
  WORKING_CONCENTRATION,
} from "../src/subapps/SequencingOrderForm/orderFormBuilder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEMPLATE = resolve(
  ROOT,
  "python-app/Templates/Sequencing_order_form_v5.xlsx"
);
const templateBytes = readFileSync(TEMPLATE);

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else { console.log(`✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
}

/** Build the filled form and return the emitted sheet XML. */
async function emitXml(built, outputDir = "C:\\runs\\U0304") {
  const bytes = await buildOrderFormBytes(built, {
    templateBytes,
    outputDir,
    seqValidationFilename: "Sequencing_validation_v6.xlsx",
  });
  const zip = unzipSync(new Uint8Array(bytes));
  const sharedStrings = [
    ...strFromU8(zip["xl/sharedStrings.xml"] || new Uint8Array()).matchAll(
      /<si>([\s\S]*?)<\/si>/g
    ),
  ].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((t) => t[1])
      .join("")
  );
  return {
    bytes,
    sharedStrings,
    xml: strFromU8(zip["xl/worksheets/sheet1.xml"]),
    workbookXml: strFromU8(zip["xl/workbook.xml"]),
  };
}

/**
 * Read a cell's literal value out of the raw sheet XML.
 * Strings live in the sharedStrings table, so a t="s" cell's <v> is an
 * INDEX into that table.
 */
function cellText(xml, sharedStrings, ref) {
  const cell = xml.match(new RegExp(`<c r="${ref}"[^>]*>([\\s\\S]*?)</c>`));
  if (!cell) return null;
  const inner = cell[1];
  const inline = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
  if (inline) return inline[1];
  const v = inner.match(/<v>([\s\S]*?)<\/v>/);
  if (!v) return "";
  if (/\bt="s"/.test(cell[0])) return sharedStrings[Number(v[1])] ?? "";
  return v[1];
}

/** Read a cell's formula out of the raw sheet XML (entity-decoded). */
function cellFormula(xml, ref) {
  const m = xml.match(
    new RegExp(`<c r="${ref}"[^>]*>([\\s\\S]*?)</c>`)
  );
  const f = m && m[1].match(/<f[^>]*>([\s\S]*?)<\/f>/);
  if (!f) return null;
  return f[1]
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Test 1: single sample, single primer
{
  const orderedSamples = [["JOB-001", "pUC19-A1"]];
  const primersDict = { "JOB-001": ["T7-F (* standard)"] };
  // A decipherable date_ID (year letter + MMDD) so the B18 derivation does
  // not add its own warning.
  const built = buildFormRows(orderedSamples, primersDict, "U0304-1");
  check("1 row from 1 sample + 1 primer", built.rows.length === 1);
  check("row has correct workNo", built.rows[0].workNo === "JOB-001");
  check("row has correct sampleId", built.rows[0].sequenceSampleId === "pUC19-A1");
  check("row has correct primer", built.rows[0].primer === "T7-F (* standard)");
  check("primer split on '(*' + trimmed", built.rows[0].primerShort === "T7-F");
  check("no warnings", built.warnings.length === 0, built.warnings.join(" | "));
  check("order form id derived", built.orderFormId === "Q202603041", built.orderFormId);
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
  const built = buildFormRows(orderedSamples, primersDict, "U0304-1");
  check("missing-primer sample skipped", built.rows.length === 1);
  check("only JOB-003 produced a row", built.rows[0].workNo === "JOB-003");
  check("warning generated for missing", built.warnings.length === 1, built.warnings.join(" | "));
  check("warning text mentions JOB-004", built.warnings[0].includes("JOB-004"));
}

// Test 4: warning dedup — same missing workNo twice still one warning
{
  const orderedSamples = [["JOB-005", "v1"], ["JOB-005", "v1-again"]];
  const primersDict = { "JOB-005": [] };
  const built = buildFormRows(orderedSamples, primersDict, "U0304-1");
  check("dup missing still 0 rows", built.rows.length === 0);
  check("dup missing -> 1 warning", built.warnings.length === 1, built.warnings.join(" | "));
}

// Test 4b: an undecipherable date_ID adds the B18 warning (the Python's
// "Template value left in place" path).
{
  const built = buildFormRows([["JOB-005", "v1"]], { "JOB-005": ["p1"] }, "nodigits");
  check("undecipherable date_ID -> no order form id", built.orderFormId === null);
  check(
    "undecipherable date_ID -> B18 warning",
    built.warnings.some((w) => w.includes("order form ID")),
    built.warnings.join(" | ")
  );
}

// Test 5: the output is a valid xlsx built FROM the template
{
  const orderedSamples = [["JOB-006", "vector-1"]];
  const primersDict = { "JOB-006": ["M13F"] };
  const built = buildFormRows(orderedSamples, primersDict, "2026-08-23");
  const { bytes, xml, workbookXml } = await emitXml(built);
  check("output is non-empty", bytes.length > 100);
  check("output starts with the ZIP signature (PK)", bytes[0] === 0x50 && bytes[1] === 0x4b);
  check(
    'sheet is named "Order form"',
    /<sheet\b[^>]*\bname="Order form"/.test(workbookXml),
    workbookXml.match(/<sheet\b[^>]*>/)?.[0] || "none"
  );
  check("12 merged regions preserved", (xml.match(/<mergeCell /g) || []).length === 12);
  check("header row 19 preserved", /<row r="19"/.test(xml));
  check("no 'Sheet1' sheet", !/name="Sheet1"/.test(workbookXml));
}

// Test 6: no-primer input produces a form with no data rows
{
  const orderedSamples = [["JOB-007", "v"]];
  const primersDict = {};
  const built = buildFormRows(orderedSamples, primersDict, "x");
  const { bytes } = await emitXml(built);
  check("no-primer input still produces a valid xlsx", bytes.byteLength > 100);
  check("no-primer input produces a warning", built.warnings.length > 0);
}

// Test 7: the written cells + formulas
{
  const orderedSamples = [["JOB-008", "vec-A"], ["JOB-009", "vec-B"]];
  const primersDict = {
    "JOB-008": ["Primer-1 (*with note)", "Primer-2"],
    "JOB-009": ["Primer-3"],
  };
  const built = buildFormRows(orderedSamples, primersDict, "2026-08-23");
  const { xml, sharedStrings } = await emitXml(built);
  const t = (ref) => cellText(xml, sharedStrings, ref);

  check("xml: C20 has value vec-A", t("C20") === "vec-A", t("C20"));
  check("xml: D20 has value Primer-1 (*with note)",
        t("D20") === "Primer-1 (*with note)", t("D20"));
  check("xml: K20 has value Primer-1 (trimmed)",
        t("K20") === "Primer-1", t("K20"));
  check("xml: G20 has value JOB-008", t("G20") === "JOB-008", t("G20"));
  check("xml: H20 has value 2026-08-23", t("H20") === "2026-08-23", t("H20"));
  check("xml: F20 has the working concentration",
        t("F20") === WORKING_CONCENTRATION, t("F20"));
  check("xml: C22 has value vec-B", t("C22") === "vec-B", t("C22"));
  check("xml: C21 has value vec-A (row 2)", t("C21") === "vec-A", t("C21"));

  const eFormula = cellFormula(xml, "E20");
  check("xml: E20 has CONCATENATE formula",
        typeof eFormula === "string" && eFormula.startsWith("CONCATENATE"));
  check("xml: E20 references C20, G20, D20, H20",
        eFormula && eFormula.includes("C20") && eFormula.includes("G20")
        && eFormula.includes("D20") && eFormula.includes("H20"));
  const iFormula = cellFormula(xml, "I20");
  check("xml: I20 has VLOOKUP formula",
        typeof iFormula === "string" && iFormula.startsWith("VLOOKUP"));
  check("xml: I20 references the output dir + validation file",
        iFormula && iFormula.includes("C:\\runs\\U0304/")
        && iFormula.includes("[Sequencing_validation_v6.xlsx]Sequencing Pending"));
  const lFormula = cellFormula(xml, "L20");
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
  const { bytes } = await emitXml(built);
  const out = resolve(ROOT, "scripts/test-output-order-form.xlsx");
  writeFileSync(out, Buffer.from(bytes));
  console.log(`\n  Sample output: ${out} (${bytes.length} bytes)`);
}

console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) failed"}.`);
process.exit(failed === 0 ? 0 : 1);
