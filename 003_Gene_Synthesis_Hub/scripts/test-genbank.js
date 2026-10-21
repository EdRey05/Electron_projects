// Smoke test for the GenBank writer + sequence utilities.
// Runs in plain Node — no Vite, no React. Strips ESM imports/exports and
// evals the source to exercise the pure logic end-to-end.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const seqSrc = readFileSync(
  resolve(ROOT, "src/subapps/QCVectorMap/sequenceUtils.js"),
  "utf8"
);
const writerSrc = readFileSync(
  resolve(ROOT, "src/subapps/QCVectorMap/genbankWriter.js"),
  "utf8"
);

// Combine both source files into one self-contained module, stripping
// ESM-specific syntax so it can run under `new Function(...)`.
function stripEsm(src) {
  return src
    .replace(/^import .* from .*;$/gm, "")
    .replace(/^export /gm, "");
}
const combined = stripEsm(seqSrc) + "\n\n" + stripEsm(writerSrc);

const fn = new Function(combined + "\nreturn { findSubsequenceLocation, buildGenbank };");
const { buildGenbank } = fn();

let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    console.log(`✗ ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

// Test 1: small linear insert
{
  const vector = "AAAA" + "GGGGCCCC".repeat(50) + "TTTT";
  const insert = "GGGGCCCC";
  const r = buildGenbank({ jobid: "test-001", finalVector: vector, insertSeq: insert });
  check("linear insert ok", r.ok, r.error);
  check("LOCUS line correct length",
    r.ok && r.text.split("\n")[0].includes(String(vector.length)),
    r.ok ? "" : "no text");
  check("FEATURES has misc_feature",
    r.ok && r.text.includes("misc_feature"));
  check("FEATURES has single Insert",
    r.ok && !r.text.includes("wrap-around"));
  check("ORIGIN has lowercase groups",
    r.ok && /\d+\s+[a-z]+\s/.test(r.text));
  check("File ends with //",
    r.ok && r.text.trim().endsWith("//"));
}

// Test 2: wrap-around insert (insert straddles linearization point)
{
  // 16bp vector. Insert AAAG crosses from position 13 (last 3 = "AAA") +
  // position 0 ("G") -> wraps around the linearization point.
  const vector = "GGGGAAAACCCCAAAA";
  const insert = "AAAG";
  // Sanity check the wrap manually.
  const linIdx = vector.indexOf(insert);
  const dblIdx = (vector + vector).indexOf(insert);
  if (linIdx >= 0 || dblIdx < 0 || dblIdx >= vector.length) {
    console.log("  [skip] test 2 vectors don't trigger wrap-around");
  } else {
    const r = buildGenbank({ jobid: "test-002", finalVector: vector, insertSeq: insert });
    check("wrap-around insert ok", r.ok, r.error);
    // The Python (vector_map_prep_biopython.py) builds ONE feature whose
    // location is a CompoundLocation of two parts:
    //   FeatureLocation(start, len(seq)) and FeatureLocation(0, end)
    // Biopython writes that as a single "join(start+1..len,1..end)"
    // location on ONE misc_feature record.
    check("wrap-around uses a single compound location",
      r.ok && r.text.includes("misc_feature    join(14..16,1..1)"),
      r.ok ? r.text.split("FEATURES")[1]?.split("ORIGIN")[0] : "");
    check("wrap-around is ONE feature record, not two",
      r.ok && (r.text.match(/misc_feature/g) || []).length === 1,
      r.ok ? String((r.text.match(/misc_feature/g) || []).length) : "");
    check("wrap-around has the Python's note qualifier",
      r.ok && r.text.includes('/note="Insert sequence (wrap-around)"'));
    check("wrap-around has the Python's label qualifier",
      r.ok && r.text.includes('/label="Insert"'));
  }
}

// Test 2b: the in-frame insert is annotated at its REAL position inside the
// final vector — NOT hard-coded to 1..insertLen (the Python locates the
// insert inside the final vector and annotates the matched region).
{
  const vector = "ATG" + "GCTAGCTAGC".repeat(20) + "TTTT" + "GGGGCCCCAAATTTGGGCCC";
  const insert = "GGGGCCCCAAATTTGGGCCC";
  const r = buildGenbank({ jobid: "test-002b", finalVector: vector, insertSeq: insert });
  check("in-frame insert ok", r.ok, r.error);
  // The insert starts at 0-based 207 in a 227 bp vector -> "208..227".
  check("in-frame insert annotated at its real position",
    r.ok && r.text.includes("misc_feature    208..227"),
    r.ok ? r.text.split("FEATURES")[1]?.split("ORIGIN")[0] : "");
  check("in-frame insert is NOT annotated as 1..insertLen",
    r.ok && !r.text.includes("misc_feature    1..20"));
  check("in-frame insert has exactly one feature",
    r.ok && (r.text.match(/misc_feature/g) || []).length === 1);
}

// Test 3: insert not found
{
  const r = buildGenbank({ jobid: "test-003", finalVector: "ACGT", insertSeq: "TTTT" });
  check("insert not found → error", !r.ok && r.error && r.error.includes("not found"));
}

// Test 4: empty vector
{
  const r = buildGenbank({ jobid: "test-004", finalVector: "", insertSeq: "ACGT" });
  check("empty vector → error", !r.ok && r.error && r.error.includes("Empty"));
}

// Test 5: vector with whitespace (should be cleaned)
{
  const vector = "AAAA GGGG\nCCCC\tTTTT";
  const insert = "GGGGCCCC";
  const r = buildGenbank({ jobid: "test-005", finalVector: vector, insertSeq: insert });
  check("whitespace cleaned, insert found", r.ok, r.error);
  check("length reflects cleaned vector",
    r.ok && r.text.split("\n")[0].includes("16 bp"));
}

// Test 6: no insert (just vector)
{
  const vector = "ACGTACGTACGT";
  const r = buildGenbank({ jobid: "test-006", finalVector: vector });
  check("vector-only ok", r.ok, r.error);
  check("vector-only has no FEATURES block",
    r.ok && !r.text.includes("FEATURES"));
}

// Dump first test for visual inspection.
{
  const vector = "AAAA" + "GGGGCCCC".repeat(50) + "TTTT";
  const insert = "GGGGCCCC";
  const r = buildGenbank({ jobid: "test-001", finalVector: vector, insertSeq: insert });
  if (r.ok) {
    const outDir = "/tmp/qcvectormap-test";
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/test-001.gb`, r.text, "utf8");
    console.log(`\nWrote ${outDir}/test-001.gb for inspection`);
  }
}

console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) failed"}.`);
process.exit(failed === 0 ? 0 : 1);
