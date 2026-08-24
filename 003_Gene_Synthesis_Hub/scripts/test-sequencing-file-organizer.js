// Smoke test for the Sequencing File Organizer pure logic.
// Exercises organize.js, distribute.js, and sgCheck.js without I/O.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadExports(srcPath, exportsNeeded) {
  let src = readFileSync(srcPath, "utf8");
  src = src.replace(/^export /gm, "");
  const fn = new Function("globalThis", src + `\nreturn { ${exportsNeeded.join(", ")} };`);
  return fn(globalThis);
}

const { extractInfo, classifyFile, planOrganize, buildOrganizeIssues, buildOrganizeSummary, folderNameFor } = loadExports(
  resolve(ROOT, "src/subapps/SequencingFileOrganizer/organize.js"),
  ["extractInfo", "classifyFile", "planOrganize", "buildOrganizeIssues", "buildOrganizeSummary", "folderNameFor"]
);
const { referenceBaseName, mapReferenceFiles, findMissingReferences, findMissingFolders, buildDistributeIssues, buildDistributeSummary } = loadExports(
  resolve(ROOT, "src/subapps/SequencingFileOrganizer/distribute.js"),
  ["referenceBaseName", "mapReferenceFiles", "findMissingReferences", "findMissingFolders", "buildDistributeIssues", "buildDistributeSummary"]
);
const { generateDateCode, classifyFolderForSgCheck, planSgCheck, buildSgCheckIssues, buildSgCheckSummary, suggestSgCheckFilename } = loadExports(
  resolve(ROOT, "src/subapps/SequencingFileOrganizer/sgCheck.js"),
  ["generateDateCode", "classifyFolderForSgCheck", "planSgCheck", "buildSgCheckIssues", "buildSgCheckSummary", "suggestSgCheckFilename"]
);

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`✓ ${name}`);
  else { console.log(`✗ ${name}${detail ? " — " + detail : ""}`); failed++; }
}

// =============================================================================
// Tab 1: organize.js
// =============================================================================
{
  // extractInfo
  const r1 = extractInfo("P001_SYN-12345_Fwd.ab1");
  check("extractInfo: parses 3-part name", r1.plasmidNumber === "P001" && r1.jobId === "SYN-12345");
  const r2 = extractInfo("P999_ABC_DEF_GHI.ab1");
  // Non-greedy match: plasmid=P999, jobId=ABC, rest=DEF_GHI
  check("extractInfo: greedy middle split", r2.plasmidNumber === "P999" && r2.jobId === "ABC");
  const r3 = extractInfo("notmatching.ab1");
  check("extractInfo: returns nulls on bad format", r3.jobId === null && r3.plasmidNumber === null);
  const r4 = extractInfo("P001_JOB.123_X.ab1"); // job_id has a dot
  check("extractInfo: strips trailing dots from job_id", r4.jobId === "JOB.123");
}

{
  // folderNameFor
  check("folderNameFor: simple", folderNameFor("JOB-001", "P001") === "JOB-001.P001");
  check("folderNameFor: collapses .. ", folderNameFor("JOB", "..") === "JOB");
  check("folderNameFor: strips trailing dot", folderNameFor("JOB", ".") === "JOB");
}

{
  // classifyFile
  const c1 = classifyFile("P001_JOB-001_Fwd.ab1");
  check("classifyFile: parseable ab1", c1.type === "parseable" && c1.folderName === "JOB-001.P001");
  const c2 = classifyFile("P001_JOB-001_Fwd.fasta");
  check("classifyFile: parseable fasta", c2.type === "parseable");
  const c3 = classifyFile("garbage.txt");
  check("classifyFile: 'other' for .txt", c3.type === "other");
  const c4 = classifyFile("noise.seq");
  check("classifyFile: 'seq' for .seq", c4.type === "seq");
  const c5 = classifyFile("POScontrol.ab1");
  check("classifyFile: 'pos' for POS prefix", c5.type === "pos");
  const c6 = classifyFile("Poscontrol.ab1");
  check("classifyFile: 'pos' for Pos prefix", c6.type === "pos");
  const c7 = classifyFile("poscontrol.ab1");
  check("classifyFile: 'pos' for pos prefix", c7.type === "pos");
  const c8 = classifyFile("notgood.ab1");
  check("classifyFile: 'unparseable' if no underscores", c8.type === "unparseable");
}

{
  // planOrganize
  const filenames = [
    "P001_JOB-001_Fwd.ab1",
    "P001_JOB-001_Rev.ab1",
    "P002_JOB-002_Fwd.fasta",
    "noise.seq",
    "POS_control.ab1",
    "garbage.ab1",   // no underscores -> unparseable
    "Random_File.txt",
  ];
  const plan = planOrganize(filenames, ["JOB-001.P001"]);
  check("plan: 3 parseable files", plan.parseable.length === 3);
  check("plan: 1 unparseable file", plan.unparseable.length === 1);
  check("plan: 1 seq file counted", plan.seqCount === 1);
  check("plan: 1 POS file counted", plan.posCount === 1);
  check("plan: 2 unique folder names", plan.folderNames.length === 2);
  check("plan: 1 existing folder", plan.existingFolders.length === 1);
  check("plan: existing folder is JOB-001.P001", plan.existingFolders[0] === "JOB-001.P001");
}

{
  // buildOrganizeIssues / Summary (with both unparseable + existing folder)
  const plan = planOrganize(
    ["P001_JOB-001_Fwd.ab1", "bad.ab1"],
    ["JOB-001.P001"]
  );
  const issues = buildOrganizeIssues(plan);
  check("issues: mentions unparseable", issues.some((l) => l.includes("cannot be parsed")));
  check("issues: mentions existing folder", issues.some((l) => l.includes("already exist")));
  const summary = buildOrganizeSummary(plan);
  check("summary: includes parseable count", summary.includes("1 parseable"));
  check("summary: includes unparseable count", summary.includes("1 unparseable"));
  check("summary: includes existing folder count", summary.includes("1 existing folders"));
}

// =============================================================================
// Tab 2: distribute.js
// =============================================================================
{
  // referenceBaseName
  check("ref base: plain", referenceBaseName("JOB-001.txt") === "JOB-001");
  check("ref base: with vector suffix", referenceBaseName("JOB-001+pUC19.txt") === "JOB-001");
  check("ref base: dotted", referenceBaseName("JOB.001.txt") === "JOB");
  check("ref base: combo", referenceBaseName("JOB.001+pUC19.txt") === "JOB");
  check("ref base: no .txt", referenceBaseName("JOB-001") === "JOB-001");
}

{
  // mapReferenceFiles
  const refs = ["JOB-001.txt", "JOB-001+pUC19.txt", "JOB-002.txt", "irrelevant.txt"];
  const map = mapReferenceFiles(refs, ["JOB-001", "JOB-002", "JOB-003"]);
  check("map: JOB-001 has 2 files", map["JOB-001"]?.length === 2);
  check("map: JOB-002 has 1 file", map["JOB-002"]?.length === 1);
  check("map: JOB-003 absent", map["JOB-003"] === undefined);
  check("map: irrelevant ignored", !("irrelevant" in map));
}

{
  // findMissingReferences
  const refs = ["JOB-001.txt"];
  const { fileMap, missingRefs } = findMissingReferences(refs, ["JOB-001", "JOB-002"]);
  check("missingRefs: JOB-002 missing", missingRefs.length === 1 && missingRefs[0] === "JOB-002");
  check("fileMap: JOB-001 mapped", fileMap["JOB-001"]?.length === 1);
}

{
  // findMissingFolders
  const existing = ["JOB-001.P001", "JOB-002.P002", "other_folder"];
  const missing = findMissingFolders(existing, ["JOB-001", "JOB-002", "JOB-003"]);
  check("missingFolders: JOB-003 missing", missing.length === 1 && missing[0] === "JOB-003");
  check("missingFolders: other_folder irrelevant", !missing.includes("other_folder"));
}

{
  // buildDistributeIssues / Summary
  const issues = buildDistributeIssues({ missingRefs: ["X"], missingFolders: ["Y"] });
  check("issues: missing references section", issues.some((l) => l.includes("missing reference")));
  check("issues: missing folders section", issues.some((l) => l.includes("no destination folder")));
  const sum = buildDistributeSummary({
    fileMap: { "JOB-001": ["a.txt"] },
    missingRefs: ["X"],
    missingFolders: ["Y"],
    organizedJobIds: ["JOB-001", "X"],
  });
  check("summary: includes both counts", sum.includes("1 of 2") && sum.includes("1 missing references"));
}

// =============================================================================
// Tab 3: sgCheck.js
// =============================================================================
{
  // generateDateCode
  const d = new Date("2026-08-23T12:00:00Z");
  check("generateDateCode: yymmdd", generateDateCode(d) === "260823");
  const d2 = new Date("2026-01-05T12:00:00Z");
  check("generateDateCode: zero-pads", generateDateCode(d2) === "260105");
}

{
  // classifyFolderForSgCheck
  check("classify: valid folder", classifyFolderForSgCheck("f", ["a.ab1", "b.txt"]).valid === true);
  check("classify: missing ab1", classifyFolderForSgCheck("f", ["b.txt"]).valid === false);
  check("classify: missing txt", classifyFolderForSgCheck("f", ["a.ab1"]).valid === false);
  check("classify: missing both", classifyFolderForSgCheck("f", ["x.zip"]).valid === false);
  check("classify: fasta counts as ab1", classifyFolderForSgCheck("f", ["a.fasta", "b.txt"]).valid === true);
  check("classify: not array", classifyFolderForSgCheck("f", undefined).reason === "folder not found");
}

{
  // planSgCheck
  const plan = planSgCheck(
    ["good", "no_ab1", "no_txt", "no_both"],
    {
      good: ["a.ab1", "b.txt"],
      no_ab1: ["b.txt"],
      no_txt: ["a.ab1"],
      no_both: ["x.zip"],
    }
  );
  check("planSgCheck: 1 valid", plan.valid.length === 1 && plan.valid[0] === "good");
  check("planSgCheck: 3 invalid", plan.invalid.length === 3);
}

{
  // suggestSgCheckFilename
  check("suggestSgCheckFilename: shape", suggestSgCheckFilename(new Date("2026-08-23T12:00:00Z")) === "260823 Gene Seq Log.xlsx");
}

console.log(`\n${failed === 0 ? "All tests passed" : failed + " test(s) failed"}.`);
process.exit(failed === 0 ? 0 : 1);
