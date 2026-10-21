/**
 * Banker's-rounding harness (LIG-12).
 *
 * The Python writes the insert volume with `round(volume, 2)`, which is
 * round-half-to-EVEN. JavaScript's `Math.round` is half-UP, so the two
 * disagree on every exact .xx5 value. The React port must match the
 * Python.
 */
import { round2 } from "../src/subapps/LigationLayout/workbookBuilder.js";

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

// The exact values from the Python (round(v, 2) semantics).
const cases = [
  [0.125, 0.12],   // Python: 0.12 (half to even), JS Math.round: 0.13
  [2.675, 2.67],   // Python: 2.67, JS Math.round: 2.68
  [0.135, 0.14],   // Python: 0.14 (0.13 is odd -> round up to even 0.14)
  [0.145, 0.14],   // Python: 0.14 (0.14 is even -> stays)
  [1.005, 1.0],    // Python: 1.0
  [0.1, 0.1],
  [12.345, 12.35], // Python: 12.35 (the double is really 12.34500000000000063948)
  [0.25, 0.25],
  [0.75, 0.75],
  [1.5, 1.5],
  [2.5, 2.5],
  [0.05, 0.05],
  [0.15, 0.15],
  [1.115, 1.11],   // Python: 1.11
  [2.225, 2.23],   // Python: 2.23
  [12.355, 12.36], // Python: 12.36 (12.35 odd -> up to even 12.36)
  [8.4, 8.4],
  [0.0, 0.0],
  [-0.125, -0.12], // Python: round(-0.125, 2) = -0.12
  [3.5, 3.5],
];

console.log("=== BANKER'S ROUNDING (LIG-12) ===");
for (const [input, expected] of cases) {
  const got = round2(input);
  check(
    `round2(${input}) === ${expected}`,
    Math.abs(got - expected) < 1e-9,
    `got ${got}`
  );
}

// A non-halfway value must still round normally.
check("round2(1.23456) === 1.23", round2(1.23456) === 1.23, String(round2(1.23456)));
check("round2(1.239) === 1.24", round2(1.239) === 1.24, String(round2(1.239)));

console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
console.log(`  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
