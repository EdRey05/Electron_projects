/**
 * Reads the Primer Log .xlsx and returns a flat list of primer candidates.
 *
 * Mirrors the Python app's behaviour:
 *   - Sheets starting with S, T, U, or V (case-insensitive).
 *   - From each sheet, read columns A:B (Name, Sequence) starting at row 35,
 *     reading up to 70 rows.
 *   - Clean each primer: uppercase, only A/T/C/G/N, length 10-100.
 *
 * Uses the `xlsx` library already in deps (same one Sequence Binding Finder
 * uses for Excel I/O). Reads in a Web Worker-less synchronous pass — the
 * files are small (~10 sheets × ~70 rows), so the main thread stays
 * responsive enough. If we hit larger files later we can move this to a
 * worker.
 */
import * as XLSX from "xlsx";
import { isRelevantSheet, isValidPrimer } from "./sequenceUtils.js";

export function loadPrimerCandidates(filePath) {
  // In Electron, the renderer can read user-selected files directly via the
  // File object from <input type="file">. We never read raw `filePath` from
  // disk in the renderer — that's a security boundary. Instead the renderer
  // gets a File handle and passes it here.
  throw new Error(
    "loadPrimerCandidates requires a File object, not a path. Use loadPrimerCandidatesFromFile()."
  );
}

export async function loadPrimerCandidatesFromFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const relevantSheets = wb.SheetNames.filter(isRelevantSheet);
  const out = [];
  for (const sheetName of relevantSheets) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    // range: skip 34 rows (= start at row 35), read up to 70 rows.
    // XLSX uses "A1"-style ranges; ref column A..B.
    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
    const startRow = Math.max(34, range.s.r); // 0-indexed: row 34 = Excel row 35
    const endRow = Math.min(startRow + 70, range.e.r + 1);
    const subRange = { s: { r: startRow, c: 0 }, e: { r: endRow - 1, c: 1 } };
    const aoa = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      range: XLSX.utils.encode_range(subRange),
      blankrows: false,
      raw: false, // gives strings
    });
    for (const row of aoa) {
      const name = (row[0] || "").toString().trim() || "Unknown";
      const seqRaw = (row[1] || "").toString().trim().toUpperCase();
      if (!isValidPrimer(seqRaw)) continue;
      out.push({ sheet: sheetName, name, sequence: seqRaw });
    }
  }
  return { candidates: out, sheetsScanned: relevantSheets };
}
