/**
 * Ligation Layout — workbook builder.
 *
 * Mirrors `_extract_joblog_info` (which writes the layout rows + the
 * F/G/H/U columns from lookups) and `_write_fragments_to_layout` (which
 * writes the fragment info into Insert 1/2/3 columns + the volume
 * calculation in the 3rd column of each Insert).
 *
 * We operate on a Workbook object loaded from the ligation template, then
 * return it for the caller to serialize + write to disk.
 *
 * Column layout (from the Python source):
 *   B = job_id, C = bbid, D = vector, E = enzyme, F = vector lot,
 *   G = box_position, H = vector volume (CEILING(40/conc/0.5)*0.5),
 *   T = length (bp), U = resistance, V = host, W = temperature.
 *   Insert 1/2/3 = fragment name, location, volume.
 */

import * as XLSX from "xlsx";
import { getVectorDbFallbackLength } from "./extractor.js";

const INSERT_LABEL_PREFIX = "Insert ";

/**
 * Write the layout rows to the "Layout" sheet starting at row 2.
 * Also writes the F/G/H/U computed columns (vector lot, box position,
 * vector volume, resistance).
 *
 * @param {object} wb - XLSX workbook (mutated in place)
 * @param {Array} layoutRows - rows from buildLayoutRowsWithControls()
 * @param {object} lookups - from extractVectorDbLookups() (digestion lookups)
 * @returns {object} - { wb, insertColumns: { "Insert 1": colIdx, ... } }
 */
export function writeLayoutRows(wb, layoutRows, lookups) {
  const sheetName = "Layout";
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet '${sheetName}' not found in ligation template`);
  wb.Sheets[sheetName] = sheet;
  if (!sheet["!ref"]) sheet["!ref"] = "A1:Z100";

  const columnMapping = {
    job_id: "B",
    bbid: "C",
    vector: "D",
    enzyme: "E",
    length: "T",
    host: "V",
    temperature: "W",
  };

  let rowIdx = 2;
  for (const item of layoutRows) {
    const row = rowIdx;

    // Write B/C/D/E/T/V/W from the layout row.
    for (const [key, colLetter] of Object.entries(columnMapping)) {
      sheet[`${colLetter}${row}`] = { t: typeof item[key] === "number" ? "n" : "s", v: item[key] ?? "" };
    }

    // Compute F/G/H/U from the digested_vectors_lookup + resistance lookup.
    if (!item.job_id) {
      sheet[`F${row}`] = { t: "s", v: "" };
      sheet[`G${row}`] = { t: "s", v: "" };
      sheet[`H${row}`] = { t: "s", v: "" };
      sheet[`U${row}`] = { t: "s", v: "" };
    } else {
      const vectorName = String(item.vector || "").trim();
      const enzyme = String(item.enzyme || "").trim();
      const dvEntry = lookups?.digested?.[`${vectorName}\0${enzyme}`];
      if (dvEntry) {
        sheet[`F${row}`] = { t: "s", v: dvEntry.lot || "" };
        sheet[`G${row}`] = { t: "s", v: dvEntry.box_position || "" };
        if (dvEntry.concentration && dvEntry.concentration > 0) {
          // CEILING(40 / conc / 0.5) * 0.5
          const volume = Math.ceil(40 / dvEntry.concentration / 0.5) * 0.5;
          sheet[`H${row}`] = { t: "n", v: volume };
        } else {
          sheet[`H${row}`] = { t: "s", v: "" };
        }
      } else {
        sheet[`F${row}`] = { t: "s", v: "" };
        sheet[`G${row}`] = { t: "s", v: "" };
        sheet[`H${row}`] = { t: "s", v: "" };
      }
      const resistance = lookups?.resistance?.[vectorName];
      sheet[`U${row}`] = { t: "s", v: resistance || "" };
    }
    rowIdx += 1;
  }

  // Discover Insert 1/2/3 column positions from the header row.
  const headerRow = sheet["1"] || sheet["A1:Z1"];
  const insertColumns = {};
  // Walk the header row using the sheet's !ref range.
  const refRange = XLSX.utils.decode_range(sheet["!ref"]);
  for (let c = refRange.s.c; c <= refRange.e.c; c++) {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c });
    const cell = sheet[cellRef];
    if (!cell) continue;
    const v = String(cell.v || "").trim();
    if (v === "Insert 1" || v === "Insert 2" || v === "Insert 3") {
      // Excel column index (1-based)
      insertColumns[v] = c + 1;
    }
  }

  return { wb, insertColumns };
}

/**
 * Write fragment info to the layout sheet.
 *
 * For each row whose Job ID is in `fragments_to_write`:
 *   - For each fragment, write:
 *     col insertColumns["Insert N"]     = fragment.name
 *     col insertColumns["Insert N"] + 1 = fragment.location
 *     col insertColumns["Insert N"] + 2 = volume (insert_length / vector_length * 12)
 *                                         with PCR concentration adjustment
 *   - If `manual_job_ids` includes this job, recalculate column T (length)
 *     as the sum of fragment lengths.
 *
 * @param {object} wb - XLSX workbook (mutated in place)
 * @param {object} insertColumns - from writeLayoutRows() return value
 * @param {object} fragmentsToWrite - from matchFragmentsToJobs()
 * @param {Set<string>} manualJobIds - jobs that had manual vector entries
 * @param {object} vectorLengthMap - from extractVectorDbLookups() length field
 * @returns {object} - { wb, writtenCount, missingInserts }
 */
export function writeFragmentsToLayout(
  wb,
  insertColumns,
  fragmentsToWrite,
  manualJobIds,
  vectorLengthMap
) {
  const sheet = wb.Sheets["Layout"];
  if (!sheet) throw new Error("Sheet 'Layout' not found");
  const written = [];
  const missingInserts = [];

  // Build jobId -> row index map from column B
  const refRange = XLSX.utils.decode_range(sheet["!ref"]);
  const jobIdToRow = {};
  for (let r = 1; r <= refRange.e.r; r++) {
    const bCell = sheet[XLSX.utils.encode_cell({ r, c: 1 })]; // col B (index 1)
    if (!bCell || bCell.v == null) continue;
    const jid = String(bCell.v).trim();
    if (jid) jobIdToRow[jid] = r + 1; // r is 0-indexed, Excel is 1-indexed
  }

  for (const jobId of Object.keys(fragmentsToWrite)) {
    const rowIdx = jobIdToRow[jobId];
    if (!rowIdx) continue;
    const fragments = fragmentsToWrite[jobId];

    // Determine vector length (with fallback).
    const vectorCell = sheet[XLSX.utils.encode_cell({ r: rowIdx - 1, c: 3 })]; // col D
    const vectorName = vectorCell?.v ? String(vectorCell.v).trim() : "";
    let vectorLength = vectorLengthMap?.[vectorName];
    if (!vectorLength) vectorLength = getVectorDbFallbackLength();

    // For manually-entered jobs, recompute total length from fragments.
    if (manualJobIds && manualJobIds.has(jobId)) {
      const totalLen = fragments.reduce(
        (sum, f) => sum + (Number(f.length) || 0),
        0
      );
      sheet[`T${rowIdx}`] = { t: "n", v: totalLen };
    }

    // Write fragments into Insert 1/2/3
    for (let i = 0; i < fragments.length && i < 3; i++) {
      const frag = fragments[i];
      const insertKey = `${INSERT_LABEL_PREFIX}${i + 1}`;
      const col = insertColumns[insertKey];
      if (!col) {
        missingInserts.push(insertKey);
        continue;
      }
      sheet[`${colLetter(col)}${rowIdx}`] = { t: "s", v: frag.name };
      sheet[`${colLetter(col + 1)}${rowIdx}`] = { t: "s", v: frag.location };
      if (vectorLength > 0) {
        try {
          const insertLength = Number(frag.length) || 0;
          let volume = (insertLength / vectorLength) * 12;
          const conc = frag.concentration;
          if (conc != null && Number(conc) > 0) {
            volume = volume / (Number(conc) / 10);
          }
          sheet[`${colLetter(col + 2)}${rowIdx}`] = { t: "n", v: Math.round(volume * 100) / 100 };
        } catch {
          // Skip on invalid length.
        }
      }
      written.push(`${jobId} -> ${insertKey} = ${frag.name}`);
    }
  }

  return { wb, written, missingInserts };
}

export function serializeWorkbook(wb) {
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

function colLetter(idx) {
  let s = "";
  while (idx > 0) {
    const rem = (idx - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}
