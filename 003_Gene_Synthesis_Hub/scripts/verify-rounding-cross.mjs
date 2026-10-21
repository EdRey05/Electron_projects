// Cross-validate round2() against Python's round(v, 2) on random values.
import { round2 } from "../src/subapps/LigationLayout/workbookBuilder.js";
import { execFileSync } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const N = 4000;
const vals = [];
for (let i = 0; i < N; i++) {
  // a mix of magnitudes, including many near .xx5 boundaries
  const style = i % 4;
  let v;
  if (style === 0) v = Math.random() * 20;
  else if (style === 1) v = Math.round(Math.random() * 2000) / 100;
  else if (style === 2) v = (Math.floor(Math.random() * 4000) + 0.5) / 100;
  else v = (Math.floor(Math.random() * 40000) + 5) / 1000;
  vals.push(v);
}

const dir = mkdtempSync(join(tmpdir(), "roundchk-"));
const inFile = join(dir, "in.txt");
const outFile = join(dir, "out.txt");
writeFileSync(inFile, vals.map((v) => v.toPrecision(17)).join("\n"));

const py = `
vals = [float(x) for x in open(r"${inFile}").read().split()]
with open(r"${outFile}", "w") as f:
    for v in vals:
        f.write(repr(round(v, 2)) + "\\n")
`;
execFileSync("python", ["-c", py], { encoding: "utf-8" });

const pyOut = (await import("fs")).readFileSync(outFile, "utf-8").trim().split("\n").map(Number);
let bad = 0;
for (let i = 0; i < vals.length; i++) {
  const got = round2(vals[i]);
  if (Math.abs(got - pyOut[i]) > 1e-9) {
    if (bad < 8) console.log(`  MISMATCH ${vals[i]} -> js ${got} vs py ${pyOut[i]}`);
    bad += 1;
  }
}
console.log(`\n=== RESULT: ${bad === 0 ? "ALL CHECKS PASSED" : bad + " MISMATCH(ES)"} ===`);
console.log(`  ${vals.length - bad}/${vals.length} values match Python round(v, 2)`);
process.exit(bad === 0 ? 0 : 1);
