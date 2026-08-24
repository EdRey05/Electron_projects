// Smoke test for the Sequencing Reference Files extractor + planner.
// Tests pure logic (column resolution + plan computation) without Excel I/O.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const src = readFileSync(
  resolve(ROOT, "src/subapps/SequencingReferenceFiles/extractor.js"),
  "utf8"
);

// Strip ESM and eval.
const stripped = src
  .replace(/^import .* from .*;$/gm, "")
  .replace(/^export /gm, "");
const fn = new Function(stripped + "\nreturn { resolveColumnIndices, planOutputs };");
const { resolveColumnIndices, planOutputs } = fn();

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else { console.log(`✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
}

// Test 1: column resolution — by header name
{
  const headers = ["", "", "", "", "", "", "", "", "JobID", "Vector", "Insert Seq", "Final Vector"];
  const idx = resolveColumnIndices(headers);
  check("resolves JobID by name", idx.jobId === 8);
  check("resolves Vector by name", idx.vector === 9);
  check("resolves Insert Seq by name", idx.insertSeq === 10);
  check("resolves Final Vector by name", idx.finalVector === 11);
}

// Test 2: column resolution — fallback to positional
{
  // Headers are deliberately named to NOT match any of the candidate names
  // (JobID, Vector, Insert Seq, Final Vector) so positional fallback fires.
  const headers = ["Foo", "Bar", "Baz", "Qux", "Quux", "X", "Y", "Z", "M", "N"];
  const idx = resolveColumnIndices(headers);
  check("JobID falls back to 0", idx.jobId === 0);
  check("Vector falls back to 4", idx.vector === 4);
  check("Insert Seq falls back to 7", idx.insertSeq === 7);
  check("Final Vector falls back to 8", idx.finalVector === 8);
}

// Test 3: column resolution — mixed (some headers, some positional)
{
  const headers = ["JobID", "X", "Y", "Z", "Vector", "X", "Y", "Z", "X", "Final Vector"];
  const idx = resolveColumnIndices(headers);
  check("mixed: JobID by name", idx.jobId === 0);
  check("mixed: Vector by name", idx.vector === 4);
  check("mixed: Insert Seq positional", idx.insertSeq === 7);
  check("mixed: Final Vector by name", idx.finalVector === 9);
}

// Test 4: planOutputs — full row produces 2 files
{
  const row = {
    jobId: "JOB-001",
    vector: "pUC19",
    insertSeq: "ATGCATGC",
    finalVector: "GGGGAAAACCCC",
  };
  const out = planOutputs(row);
  check("full row -> 2 outputs", out.length === 2);
  check("output 1 = JOB-001.txt", out[0].name === "JOB-001.txt");
  check("output 1 contents = insert seq", out[0].contents === "ATGCATGC");
  check("output 2 = JOB-001+pUC19.txt", out[1].name === "JOB-001+pUC19.txt");
  check("output 2 contents = final vector", out[1].contents === "GGGGAAAACCCC");
}

// Test 5: planOutputs — only insert seq
{
  const row = { jobId: "JOB-002", vector: "", insertSeq: "ATGC", finalVector: "" };
  const out = planOutputs(row);
  check("only insert -> 1 output", out.length === 1);
  check("only insert -> JOB-002.txt", out[0].name === "JOB-002.txt");
}

// Test 6: planOutputs — only final vector
{
  const row = { jobId: "JOB-003", vector: "pBR322", insertSeq: "", finalVector: "AAAA" };
  const out = planOutputs(row);
  check("only final vector -> 1 output", out.length === 1);
  check("only final vector -> JOB-003+pBR322.txt", out[0].name === "JOB-003+pBR322.txt");
}

// Test 7: planOutputs — empty row
{
  const row = { jobId: "JOB-004", vector: "", insertSeq: "", finalVector: "" };
  const out = planOutputs(row);
  check("empty row -> 0 outputs", out.length === 0);
}

// Test 8: planOutputs — whitespace is NOT trimmed here (cleanCell upstream
// is responsible; planOutputs operates on already-cleaned values).
{
  const row = { jobId: "JOB-005", vector: "pUC19", insertSeq: "  \n  ", finalVector: "   " };
  const out = planOutputs(row);
  // planOutputs uses truthiness — "   " is truthy, so 2 outputs are produced.
  // Real flow: extractSequences runs cleanCell first, so values arrive trimmed.
  check("planOutputs treats whitespace as truthy (cleaning is upstream)", out.length === 2);
}

console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) failed"}.`);
process.exit(failed === 0 ? 0 : 1);
