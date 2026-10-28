import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchPair, revcomp, analyzeEntry, sortResults } from "../../src/engine/search.mjs";
import { inspectSequence, cleanSeq, parseRows, detectHeader, parseFasta } from "../../src/engine/input.mjs";
import { filename, resultRows, RESULT_COLUMNS, csvText, databaseRows } from "../../src/engine/exports.mjs";

test("reader contract and header override preserve names, U conversion, skips and order", () => {
  const rows = [["Name", "ID", "Sequence"], ["Alpha", "A1", "acgu n!"], ["Bad", "B1", "AA"], ["", "", ""], ["Beta", "B2", "GGCC"]];
  assert.equal(detectHeader(rows), true);
  const parsed = parseRows(rows); assert.deepEqual(parsed.entries.map(r => [r.name, r.seq, r.inputOrder]), [["Alpha - A1", "ACGTN", 1], ["Beta - B2", "GGCC", 4]]);
  assert.deepEqual(parsed.skipped, ["Bad - B1"]);
  assert.equal(parseRows([["name", "first data", "ACGT"]], false).entries.length, 1);
  assert.equal(parseRows([["alpha", "", "ACGT"]], true).entries.length, 0);
});
test("paste/file validation rejects FASTA merges and reports stripping and N masking", () => {
  assert.equal(inspectSequence(">one\nACGT\n>two\nTGCA").seq, "");
  assert.equal(inspectSequence(">one\nACGT", { file: true }).seq, "ACGT");
  assert.ok(inspectSequence("123ACGT??NN").notices.length === 2);
  assert.ok(inspectSequence("A".repeat(100001)).notices.some(n => n.includes("100 kb")));
  assert.equal(cleanSeq("a cgu-N?"), "ACGTN");
  assert.equal(parseFasta(">id annotation\nACGT\n>next\nGGCCTT").length, 2);
  assert.throws(() => parseFasta("ACGT"));
});
test("masked identity, zero denominator and probe-longer axes", () => {
  const masked = searchPair("ACGTNNACGT", "ACGTAAACGT");
  assert.equal(masked.identity, 100); assert.equal(masked.compared, 8); assert.equal(masked.masked, 2);
  assert.equal(searchPair("NNNN", "ACGT").identity, null);
  const long = searchPair("AACCGG", "TTTAACCGGTTT");
  assert.equal(long.identity, 100); assert.equal(long.hitAxis, "probe"); assert.equal(long.hitStart, 4); assert.equal(long.hitEnd, 9); assert.equal(long.coverage, 50);
  const reverse = searchPair("AACCGG", "TTTCCGGTTTTT");
  assert.equal(reverse.orientation, "revcomp"); assert.equal(reverse.probeStart, 4); assert.equal(reverse.probeEnd, 9);
});
test("packed search matches an independent exhaustive masked-base oracle over offsets and both lengths", () => {
  let seed = 7721; const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  const seq = n => Array.from({ length: n }, () => "ACGTN"[Math.floor(random() * 5)]).join("");
  function oracle(ref, probe) {
    let best = null;
    for (const [orientation, q] of [["forward", probe], ["revcomp", revcomp(probe)]]) {
      const target = ref.length >= q.length ? ref : q, pattern = ref.length >= q.length ? q : ref;
      for (let i = 0; i <= target.length - pattern.length; i++) {
        let compared = 0, mismatches = 0;
        for (let j = 0; j < pattern.length; j++) if (target[i+j] !== "N" && pattern[j] !== "N") { compared++; if (target[i+j] !== pattern[j]) mismatches++; }
        if (compared && (!best || mismatches * best.compared < best.mismatches * compared)) best = { compared, mismatches, orientation };
      }
    }
    return best;
  }
  for (let i = 0; i < 400; i++) {
    const ref = seq(4 + Math.floor(random() * 100)), probe = seq(4 + Math.floor(random() * 100));
    const expected = oracle(ref, probe), got = searchPair(ref, probe);
    assert.equal(got.identity, expected ? (expected.compared - expected.mismatches) / expected.compared * 100 : null, `case ${i}`);
    if (expected) { assert.equal(got.orientation, expected.orientation); assert.equal(got.compared, expected.compared); }
  }
});
test("corpus ladder and database discrimination are exact and deterministic", () => {
  const corpus = JSON.parse(readFileSync(new URL("../corpus.json", import.meta.url)));
  const pairs = [[3,0,100,"forward"],[4,2,98.375,"forward"],[0,3,95,"forward"],[5,4,92.6,"revcomp"],[2,5,86.55555555556,"forward"],[9,7,97.625,"forward"],[11,8,100,"forward"],[10,6,100,"forward"]];
  for (const [r,q,identity,orientation] of pairs) { const hit = searchPair(corpus.references[r][2], corpus.queries[q][2]); assert.ok(Math.abs(hit.identity-identity)<1e-8); assert.equal(hit.orientation, orientation); }
  const entries = parseRows(corpus.references, false).entries;
  const run = () => entries.map(e => analyzeEntry(e, corpus.queries[0][2], "database", 90));
  const results = run(); assert.equal(JSON.stringify(results), JSON.stringify(run()));
  const matches = results.filter(r => r.status === "match"); assert.equal(matches.length, 1); assert.ok(matches[0].name.includes("M13")); assert.equal(matches[0].referenceStart, 1); assert.equal(matches[0].referenceEnd, 1200);
  assert.equal(results.filter(r => !r.name.includes("M13") && r.status === "match").length, 0);
  const t4 = { seq: corpus.queries[5][2], name: "T4", inputOrder: 0 };
  assert.equal(analyzeEntry(t4, corpus.references[2][2], "screen", 86).status, "match");
  assert.equal(analyzeEntry(t4, corpus.references[2][2], "screen", 87).status, "no-match");
  assert.deepEqual(sortResults([{ inputOrder: 2, identity: 99 }, { inputOrder: 1, identity: 90 }], "original").map(r => r.inputOrder), [1,2]);
});
test("exports retain legacy prefix, use explicit coordinates and stay within Excel cell limits", () => {
  assert.deepEqual(RESULT_COLUMNS.slice(0,3), ["Name", "Sequence", "% Identity with reference"]);
  const result = { name: 'A,"quoted"', seq: "A".repeat(40000), identity: 99.5, status: "match", orientation: "revcomp", probeStart: 2, probeEnd: 8, referenceStart: 1, referenceEnd: 7, coverage: 70 };
  assert.equal(resultRows([result])[0][1].length, 32000); assert.ok(csvText([result]).includes('"A,""quoted"""'));
  assert.equal(databaseRows([result])[0][2].length, 32000); assert.ok(databaseRows([result])[0][1].includes("truncated"));
  assert.equal(filename('M13/unsafe:* name', 'xlsx', new Date(2026,9,28)), 'binding_results_2026-10-28_M13_unsafe_name.xlsx');
});
