/**
 * Pure sequence utilities used by the Primer Finder subapp.
 *
 * Mirrors `primer_finder_app.py::get_reverse_complement`. Kept as plain
 * functions (no React) so they can be unit-tested or reused by other
 * subapps later (e.g. Sequence Binding Finder).
 */

const COMPLEMENT = { A: "T", T: "A", C: "G", G: "C", N: "N" };

export function reverseComplement(seq) {
  let out = "";
  for (let i = seq.length - 1; i >= 0; i--) {
    out += COMPLEMENT[seq[i]] ?? seq[i];
  }
  return out;
}

/**
 * Clean a free-form target sequence:
 *   - uppercase
 *   - strip everything outside A/T/C/G/N
 * Returns "" if nothing valid remains.
 */
export function cleanSequence(raw) {
  return (raw || "").toUpperCase().replace(/[^ATCGN]/g, "");
}

/**
 * Search for `primer` inside `target` (already cleaned & uppercased).
 * Returns 1-based position on hit, or -1.
 */
export function findBinding(primer, target, targetRc) {
  const pos = target.indexOf(primer);
  if (pos >= 0) return { orientation: "Forward (Exact Match)", position: pos + 1 };
  const posRc = targetRc.indexOf(primer);
  if (posRc >= 0) return { orientation: "Reverse (Binds to Target)", position: posRc + 1 };
  return null;
}

/**
 * Sheet names starting with S, T, U, or V (case-insensitive).
 * Same predicate the Python app uses.
 */
export function isRelevantSheet(name) {
  const c = (name || "").toUpperCase().charAt(0);
  return c === "S" || c === "T" || c === "U" || c === "V";
}

/**
 * Validate a candidate primer: length 10-100, only A/T/C/G/N.
 */
export function isValidPrimer(seq) {
  if (!seq) return false;
  if (seq.length < 10 || seq.length > 100) return false;
  return /^[ATCGN]+$/.test(seq);
}
