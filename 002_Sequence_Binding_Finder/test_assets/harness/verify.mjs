import "./prepare.mjs";
import XLSX from "xlsx";
import fs from "node:fs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { searchPair, analyzeEntry } from "../../src/engine/search.mjs";
let passed = 0, failed = 0;
const check = (label, fn) => { try { fn(); passed++; console.log(`PASSED ${label}`); } catch (error) { failed++; console.error(`FAILED ${label}: ${error.message}`); } };
// Deliberately independent reader: catches regressions in the app's reader contract.
function read(name) {
  const wb = XLSX.readFile(fileURLToPath(new URL(`../${name}`, import.meta.url)));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
  const cell = i => String(rows[0]?.[i] || "").trim().toLowerCase();
  const header = ["name","id"].includes(cell(0)) || ["name","id"].includes(cell(1)) || ["sequence","seq"].includes(cell(2));
  return rows.slice(header ? 1 : 0).map((r,i) => ({name:[r[0],r[1]].filter(Boolean).join(" - "),label:r[0],provenance:r[1],seq:String(r[2]||"").toUpperCase().replace(/U/g,"T").replace(/[^ACGTN]/g,""),inputOrder:i})).filter(r=>r.seq.length>=4);
}
const corpus = JSON.parse(fs.readFileSync(new URL("../corpus.json", import.meta.url), "utf8"));
const refs = read("reference_phage_database.xlsx"), queries = read("test_query_assemblies.xlsx");
check("workbook counts and complete names/sequences match the supplied corpus",()=>{ assert.equal(refs.length,12);assert.equal(queries.length,10);for(const [a,b] of [[refs,corpus.references],[queries,corpus.queries]])a.forEach((r,i)=>{assert.equal(r.seq,b[i][2]);assert.equal(r.name,[b[i][0],b[i][1]].filter(Boolean).join(" - "))}); });
check("identity ladder / both orientations",()=>{for(const [r,q,n,o] of [[3,0,100,"forward"],[4,2,98.375,"forward"],[0,3,95,"forward"],[5,4,92.6,"revcomp"],[2,5,86.55555555556,"forward"],[9,7,97.625,"forward"],[11,8,100,"forward"],[10,6,100,"forward"]]){const h=searchPair(refs[r].seq,queries[q].seq);assert.ok(Math.abs(h.identity-n)<1e-8);assert.equal(h.orientation,o)}});
check("threshold 86 versus 87",()=>{assert.equal(analyzeEntry(queries[5],refs[2].seq,"screen",86).status,"match");assert.equal(analyzeEntry(queries[5],refs[2].seq,"screen",87).status,"no-match")});
check("negative control stays near random identity",()=>{for(const r of refs)assert.ok(searchPair(r.seq,queries[9].seq).identity<=36)});
check("Mode B self-match, missing M13 and deterministic JSON",()=>{const run=()=>refs.map(r=>analyzeEntry(r,queries[0].seq,"database",90));const a=run();assert.equal(JSON.stringify(a),JSON.stringify(run()));const hits=a.filter(r=>r.status==="match");assert.equal(hits.length,1);assert.equal(hits[0].identity,100);assert.equal(hits[0].referenceStart,1);assert.equal(hits[0].referenceEnd,1200);assert.equal(a.filter(r=>!r.name.includes("M13")&&r.status==="match").length,0)});
const startA=performance.now();queries.forEach(q=>searchPair(refs[0].seq,q.seq));const modeA=performance.now()-startA;
const startB=performance.now();refs.forEach(r=>searchPair(r.seq,queries[0].seq));const modeB=performance.now()-startB;
console.log(JSON.stringify({benchmark:"engine; packaged app timings are separately recorded",modeA_ms:modeA,modeB_ms:modeB}));
const tests=spawnSync(process.execPath,["--test",...['core.test.mjs','cache.test.mjs'].map(n=>fileURLToPath(new URL(n,import.meta.url)))],{stdio:"inherit"});if(tests.status!==0)failed++;
console.log(`${failed ? "FAILED" : "PASSED"}: ${passed} corpus checks; ${failed} failures`);
process.exitCode=failed ? 1 : 0;
