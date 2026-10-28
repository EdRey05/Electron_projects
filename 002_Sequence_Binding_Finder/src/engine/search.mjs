import { cleanSeq } from "./input.mjs";

const COMPLEMENT = { A: "T", C: "G", G: "C", T: "A", N: "N" };
export function revcomp(seq) { let result = ""; for (let i = seq.length - 1; i >= 0; i--) result += COMPLEMENT[seq[i]] || "N"; return result; }
function encode(seq) {
  const words = new Uint32Array(Math.ceil(seq.length / 16) + 1), valid = new Uint32Array(words.length);
  let count = 0;
  for (let i = 0; i < seq.length; i++) {
    const c = seq.charCodeAt(i), word = i >>> 4, shift = (i & 15) * 2;
    if (c === 78) continue;
    const base = c === 65 ? 0 : c === 67 ? 1 : c === 71 ? 2 : 3;
    words[word] |= base << shift; valid[word] |= 1 << shift; count++;
  }
  return { words, valid, length: seq.length, count };
}
function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
/** Exact 16-base packed comparisons. The optimistic masked denominator makes pruning safe. */
function windowSearch(target, pattern, onProgress) {
  let best = null;
  const maximumCompared = pattern.count, chunks = Math.ceil(pattern.length / 16);
  const noMasks = target.count === target.length && pattern.count === pattern.length;
  if (!maximumCompared) return null;
  for (let start = 0; start <= target.length - pattern.length; start++) {
    if (onProgress && (start & 1023) === 0) onProgress();
    let mismatches = 0, compared = noMasks ? pattern.length : 0, pruned = false;
    const offset = start >>> 4, shift = (start & 15) * 2;
    const cutoff = best ? Math.ceil(best.mismatches * maximumCompared / best.compared) : Infinity;
    for (let j = 0; j < chunks; j++) {
      const i = offset + j;
      const bases = shift ? (target.words[i] >>> shift) | (target.words[i + 1] << (32 - shift)) : target.words[i];
      let mask = pattern.valid[j];
      if (!noMasks) {
        const defined = shift ? (target.valid[i] >>> shift) | (target.valid[i + 1] << (32 - shift)) : target.valid[i];
        mask &= defined; compared += popcount(mask);
      }
      const xor = bases ^ pattern.words[j];
      mismatches += popcount((xor | (xor >>> 1)) & mask);
      if (mismatches >= cutoff) { pruned = true; break; }
    }
    if (!pruned && compared && (!best || mismatches * best.compared < best.mismatches * compared)) {
      best = { start, mismatches, compared };
      if (!mismatches) break;
    }
  }
  return best;
}
export function searchPair(referenceRaw, probeRaw, onProgress) {
  const reference = cleanSeq(referenceRaw), probe = cleanSeq(probeRaw);
  if (!reference || !probe) throw Error("Empty reference or probe.");
  const reverse = revcomp(probe), longerProbe = probe.length > reference.length;
  const refBytes = encode(reference), probeBytes = encode(probe), reverseBytes = encode(reverse);
  const forward = longerProbe ? windowSearch(probeBytes, refBytes, onProgress) : windowSearch(refBytes, probeBytes, onProgress);
  const backward = longerProbe ? windowSearch(reverseBytes, refBytes, onProgress) : windowSearch(refBytes, reverseBytes, onProgress);
  const useReverse = backward && (!forward || backward.mismatches * forward.compared < forward.mismatches * backward.compared);
  const best = useReverse ? backward : forward;
  if (!best) return { identity: null, orientation: null, error: "No comparable non-N bases.", coverage: 0 };
  const length = Math.min(reference.length, probe.length);
  const probeStart = longerProbe ? useReverse ? probe.length - best.start - length + 1 : best.start + 1 : 1;
  const referenceStart = longerProbe ? 1 : best.start + 1;
  const referenceSegment = reference.slice(referenceStart - 1, referenceStart - 1 + length);
  const orientedProbe = useReverse ? reverse : probe;
  const probeSegment = longerProbe ? orientedProbe.slice(best.start, best.start + length) : orientedProbe;
  return {
    identity: (best.compared - best.mismatches) / best.compared * 100,
    mismatches: best.mismatches, compared: best.compared, masked: length - best.compared,
    orientation: useReverse ? "revcomp" : "forward", referenceStart, referenceEnd: referenceStart + length - 1,
    probeStart, probeEnd: probeStart + length - 1, hitAxis: longerProbe ? "probe" : "reference",
    hitStart: longerProbe ? probeStart : referenceStart, hitEnd: longerProbe ? probeStart + length - 1 : referenceStart + length - 1,
    hitLength: length, probeLength: probe.length, coverage: length / probe.length * 100,
    referenceSegment, probeSegment,
  };
}

export function analyzeEntry(entry, pasted, mode = "database", threshold = 90, onProgress) {
  const hit = mode === "database" ? searchPair(entry.seq, pasted, onProgress) : searchPair(pasted, entry.seq, onProgress);
  return { ...entry, ...hit, status: hit.identity === null ? "error" : hit.identity >= threshold ? "match" : "no-match", mode };
}

export function sortResults(results, order = "identity") {
  return [...results].sort(order === "original" ? (a, b) => a.inputOrder - b.inputOrder : (a, b) => (b.identity ?? -1) - (a.identity ?? -1) || a.inputOrder - b.inputOrder);
}
