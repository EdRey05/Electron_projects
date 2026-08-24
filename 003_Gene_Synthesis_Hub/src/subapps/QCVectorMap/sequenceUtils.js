/**
 * Pure sequence utilities used by the QC Vector Map (BioPython) subapp.
 *
 * Mirrors `workflows/vector_map_prep_biopython.py::find_subsequence_location`.
 * Kept as plain functions so the same logic could be reused by other subapps
 * later (e.g. Sequence Binding Finder).
 */

/**
 * Locate a subsequence inside a larger sequence.
 *
 * Returns { start, end, wrap } on hit:
 *   - start, end: 0-based positions in `seq`
 *   - wrap: true if the match straddles the linearization point of a
 *     circular sequence (i.e. the subsequence was found in `seq+seq`
 *     starting before `seq.length`)
 * Returns null on miss.
 *
 * The search is case-insensitive and tolerates no whitespace inside `subseq`.
 */
export function findSubsequenceLocation(seq, subseq) {
  if (!subseq) return null;
  const s = (seq || "").toUpperCase().replace(/\s+/g, "");
  const sub = subseq.toUpperCase().replace(/\s+/g, "");
  if (!sub) return null;

  let idx = s.indexOf(sub);
  if (idx !== -1) {
    return { start: idx, end: idx + sub.length, wrap: false };
  }
  // Wrap-around: search in a doubled sequence.
  const doubled = s + s;
  const idx2 = doubled.indexOf(sub);
  if (idx2 !== -1 && idx2 < s.length) {
    return {
      start: idx2,
      end: idx2 + sub.length - s.length,
      wrap: true,
    };
  }
  return null;
}

/**
 * Clean a vector or insert sequence: strip whitespace + newlines.
 * Matches the Python helper that calls .strip().replace(" ", "").replace("\n", "").replace("\r", "").
 */
export function cleanSequence(s) {
  return (s || "").replace(/\s+/g, "");
}
