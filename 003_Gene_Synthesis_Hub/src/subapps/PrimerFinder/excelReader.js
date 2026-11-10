/**
 * Reads the Primer Log .xlsx and returns a flat list of primer candidates.
 *
 * Mirrors the Python app's behaviour:
 *   - Sheets starting with S, T, U, or V (case-insensitive).
 *   - Per sheet, the Name + Sequence columns are resolved with a
 *     NAME-FIRST pass on Excel row 34 (the formatted order form's header
 *     row): a token equal to "oligo name" gives the name column, a token
 *     containing BOTH "sequence" and "(5" gives the sequence column.
 *     A plate-order sheet prepends a "Wells" column, which shifts the
 *     pair one column right, so the letters are NOT fixed. Columns A:B
 *     are used only when EITHER column is unresolved (older formatting).
 *   - The data block is Excel row 35 onward, as in the current reference:
 *     uppercase, only A/T/C/G/N, length 10-100.
 *
 * The resolution path that fired is reported per sheet so the app can log
 * it, the way the rest of this app family reports column provenance.
 *
 * Uses the `xlsx` library already in deps (same one Sequence Binding Finder
 * uses for Excel I/O). Reads in a Web Worker-less synchronous pass — the
 * files are small (~10 sheets × ~70 rows), so the main thread stays
 * responsive enough. If we hit larger files later we can move this to a
 * worker.
 */
import * as XLSX from "xlsx";
import {validateWorkbookSheets} from '../../ui/workbookValidation.js';
import { isRelevantSheet, isValidPrimer } from "./sequenceUtils.js";
import { normHeader, columnLetter } from "../../ui/columns.js";

/** Historic positional fallback (the Python's `name_idx, seq_idx = 0, 1`). */
const FALLBACK_NAME_IDX = 0;
const FALLBACK_SEQ_IDX = 1;

/** Excel row 34 (0-indexed 33) holds the formatted order form's header. */
const HEADER_ROW = 33;
/** Excel row 35 (0-indexed 34) is the first data row. */
const DATA_START_ROW = 34;

export function loadPrimerCandidates(filePath) {
  // In Electron, the renderer can read user-selected files directly via the
  // File object from <input type="file">. We never read raw `filePath` from
  // disk in the renderer — that's a security boundary. Instead the renderer
  // gets a File handle and passes it here.
  throw new Error(
    "loadPrimerCandidates requires a File object, not a path. Use loadPrimerCandidatesFromFile()."
  );
}

/**
 * Resolve the Name + Sequence columns of one order sheet.
 *
 * Mirrors the Python (`primer_finder_app.py:488-506`): read Excel row 34,
 * normalize every token (whitespace collapsed, trimmed, lowercased), take
 * the FIRST "oligo name" token as the name column and the FIRST token
 * containing both "sequence" and "(5" as the sequence column. When either
 * is unresolved, fall back to A:B.
 *
 * @returns {{nameIdx:number, seqIdx:number, byName:boolean, log:string}}
 */
export function resolveSheetColumns(sheet, sheetName) {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const maxCol = Math.max(range.e.c, 1);

  let nameIdx = null;
  let seqIdx = null;

  if (range.e.r >= HEADER_ROW) {
    const headerRange = {
      s: { r: HEADER_ROW, c: 0 },
      e: { r: HEADER_ROW, c: maxCol },
    };
    const headerRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      range: XLSX.utils.encode_range(headerRange),
      blankrows: false,
      raw: false,
    });
    const cells = headerRows[0] || [];
    for (let j = 0; j < cells.length; j++) {
      const token = normHeader(cells[j]);
      if (nameIdx === null && token === "oligo name") {
        nameIdx = j;
      } else if (seqIdx === null && token.includes("sequence") && token.includes("(5")) {
        seqIdx = j;
      }
    }
  }

  // The Python falls back to A:B when EITHER column is unresolved.
  const byName = nameIdx !== null && seqIdx !== null;
  const finalNameIdx = byName ? nameIdx : FALLBACK_NAME_IDX;
  const finalSeqIdx = byName ? seqIdx : FALLBACK_SEQ_IDX;

  const log = byName
    ? `'${sheetName}': columns resolved by name ` +
      `(name=${columnLetter(finalNameIdx)}, sequence=${columnLetter(finalSeqIdx)})`
    : `'${sheetName}': header row not recognized; falling back to fixed columns (A, B)`;

  return { nameIdx: finalNameIdx, seqIdx: finalSeqIdx, byName, log };
}

/**
 * Read the data block of one sheet (Excel row 35 onward) using the resolved
 * column indices. Returns the primer candidates found on that sheet.
 */
// The Python renders cell values through str(): integral floats keep a
// trailing ".0" and booleans print True/False.
function pyStr(v) {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    const s = String(v);
    return s.includes(".") || s.includes("e") || s.includes("E") ? s : s + ".0";
  }
  return String(v).replace(/\r\n?/g, "\n");
}

function readSheetCandidates(sheet, sheetName, nameIdx, seqIdx) {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const maxCol = Math.max(range.e.c, 1);
  const startRow = Math.max(DATA_START_ROW, range.s.r);
  const endRow = range.e.r + 1;
  if (endRow <= startRow) return [];

  const dataRange = {
    s: { r: startRow, c: 0 },
    e: { r: endRow - 1, c: maxCol },
  };
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    range: XLSX.utils.encode_range(dataRange),
    blankrows: false,
    raw: true,
  });

  const out = [];
  for (const row of aoa) {
    const nameCell = row[nameIdx];
    const seqCell = row[seqIdx];
    const nameText = nameCell == null || nameCell === "" ? "" : pyStr(nameCell).trim();
    const name = nameText || "Unknown";
    const seqRaw = seqCell == null ? "" : pyStr(seqCell).trim().toUpperCase();
    if (!isValidPrimer(seqRaw)) continue;
    out.push({ sheet: sheetName, name, sequence: seqRaw });
  }
  return out;
}

export async function loadPrimerCandidatesFromFile(file) {
  const buf = await file.arrayBuffer();
  validateWorkbookSheets(buf);
  const wb = XLSX.read(buf, { type: "array" });
  const relevantSheets = wb.SheetNames.filter(isRelevantSheet);
  const out = [];
  const resolutions = [];
  const skipped = [];
  for (const sheetName of relevantSheets) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    // The Tk app skips a sheet whose data block has no readable Name +
    // Sequence pair (fewer than two columns) and reports it in the summary.
    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
    if (range.e.c < 1) {
      skipped.push(sheetName);
      continue;
    }
    const { nameIdx, seqIdx, byName, log } = resolveSheetColumns(sheet, sheetName);
    resolutions.push({ sheet: sheetName, nameIdx, seqIdx, byName, log });
    for (const cand of readSheetCandidates(sheet, sheetName, nameIdx, seqIdx)) {
      out.push(cand);
    }
  }
  return {
    candidates: out,
    sheetsScanned: relevantSheets,
    sheetsSkipped: skipped,
    // Per-sheet provenance: which columns were used and whether the
    // name-first pass fired. The caller logs these lines.
    resolutions,
    logs: [
      ...resolutions.map((r) => r.log),
      ...(skipped.length
        ? [`${skipped.length} sheet(s) skipped: ${skipped.join(", ")}`]
        : []),
    ],
  };
}
