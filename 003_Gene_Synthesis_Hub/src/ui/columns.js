/**
 * Two-step column resolution — the Oct 2026 naming-standardization contract.
 *
 * Every workbook read in this hub resolves a column the same way the Python
 * originals do (see `Sequencing_reference_files_app.py::resolve_column`):
 *
 *   1. Try the CANONICAL header names first (e.g. "Work No.", "Insert
 *      Sequence", "Final Vector Sequence").
 *   2. Tolerate the legacy spellings (e.g. "JobID", "Job ID", "Insert Seq",
 *      "Final Vector") so older workbook copies still load.
 *   3. Only if NO candidate header matches, fall back to the historic
 *      positional index.
 *
 * Both sides are normalized the same way — whitespace collapsed, lowercased —
 * because the live Primer Log carries embedded line breaks in some headers
 * ("Oligo \r\nName"), and a key-side-only normalization silently half-matches.
 *
 * The caller MUST log which path fired so a header drift is visible in the
 * run log instead of silently shuffling fields.
 */

/** Collapse internal whitespace and lowercase. `null`/`undefined` → "". */
export function normHeader(h) {
  if (h === null || h === undefined) return "";
  return String(h).replace(/\s+/g, " ").trim().toLowerCase();
}

/** Build a normalized-header → column-index map. */
export function buildHeaderMap(headers) {
  const map = {};
  (headers || []).forEach((h, i) => {
    if (h === null || h === undefined || h === "") return;
    const key = normHeader(h);
    if (key && !(key in map)) map[key] = i;
  });
  return map;
}

/**
 * Resolve one column.
 *
 * @param {object} headerMap  from buildHeaderMap()
 * @param {string[]} candidates  canonical names first, legacy names after
 * @param {number} fallbackIdx  historic positional index
 * @returns {{idx:number, byName:boolean, matched:string|null}}
 */
export function resolveColumn(headerMap, candidates, fallbackIdx) {
  for (const cand of candidates || []) {
    const key = normHeader(cand);
    if (key && key in headerMap) {
      return { idx: headerMap[key], byName: true, matched: String(cand) };
    }
  }
  return { idx: fallbackIdx, byName: false, matched: null };
}

/**
 * Resolve a set of named columns at once and produce the provenance report
 * the Python apps log.
 *
 * @param {string[]} headers   raw header row
 * @param {Array<{key:string,label:string,candidates:string[],fallback:number}>} specs
 * @returns {{indices:object, byName:object, report:string, mode:string}}
 *   `report` — the "Work No.=A (name), Vector=E (fixed fallback)" string
 *   `mode`   — "all-name" | "partial" | "none"
 */
export function resolveColumns(headers, specs) {
  const headerMap = buildHeaderMap(headers);
  const indices = {};
  const byName = {};
  const parts = [];
  let nameHits = 0;

  for (const spec of specs) {
    const r = resolveColumn(headerMap, spec.candidates, spec.fallback);
    indices[spec.key] = r.idx;
    byName[spec.key] = r.byName;
    if (r.byName) nameHits++;
    parts.push(
      `${spec.label}=${columnLetter(r.idx)}${r.byName ? " (name)" : " (fixed fallback)"}`
    );
  }

  const mode = nameHits === specs.length ? "all-name" : nameHits === 0 ? "none" : "partial";
  return { indices, byName, report: parts.join(", "), mode };
}

/** 0-based column index → spreadsheet letter (0 → "A", 26 → "AA"). */
export function columnLetter(i) {
  let n = i;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Build the log line the Python apps emit for a resolved column set.
 * `sheetName` is the sheet that was read (e.g. "input addon").
 */
export function columnResolutionLog(sheetName, result) {
  if (result.mode === "all-name") {
    return `'${sheetName}': columns resolved by name (${result.report})`;
  }
  if (result.mode === "none") {
    return (
      `'${sheetName}': header row not recognized; falling back to fixed columns ` +
      `(${result.report.replace(/\s\(fixed fallback\)/g, "")})`
    );
  }
  return (
    `'${sheetName}': partial header match; fixed fallback used for missing ` +
    `columns (${result.report})`
  );
}

/**
 * The canonical column specs used across the hub's workbook reads.
 * Canonical name first, legacy spellings after, historic positional index
 * as the last resort.
 */
export const COLUMN_SPECS = {
  workNo: {
    key: "workNo",
    label: "Work No.",
    candidates: ["Work No.", "JobID", "Job ID", "Job_ID", "jobid"],
    fallback: 0,
  },
  vector: {
    key: "vector",
    label: "Vector",
    candidates: ["Vector", "Vector_number", "Vector Number"],
    fallback: 4,
  },
  insertSequence: {
    key: "insertSequence",
    label: "Insert Sequence",
    candidates: ["Insert Sequence", "Insert Seq", "InsertSeq", "insert seq"],
    fallback: 7,
  },
  finalVectorSequence: {
    key: "finalVectorSequence",
    label: "Final Vector Sequence",
    candidates: ["Final Vector Sequence", "Final Vector", "FinalVector", "final vector"],
    fallback: 8,
  },
  bbiId: {
    key: "bbiId",
    label: "BBI ID",
    candidates: ["BBI ID", "BBID", "Bbi Id"],
    fallback: 1,
  },
  plasmidNo: {
    key: "plasmidNo",
    label: "Plasmid No.",
    candidates: ["Plasmid No.", "Plasmid ID", "PlasmidNo"],
    fallback: null,
  },
  length: {
    key: "length",
    label: "Length (bp)",
    candidates: ["Length (bp)", "Length", "Insert Length"],
    fallback: null,
  },
  cloningSite: {
    key: "cloningSite",
    label: "Cloning Site",
    candidates: ["Cloning Site", "CloningSite", "enzyme", "Enzymes"],
    fallback: null,
  },
  resistance: {
    key: "resistance",
    label: "Resistance",
    candidates: ["Resistance", "Antibiotic"],
    fallback: null,
  },
  quantity: {
    key: "quantity",
    label: "Quantity",
    candidates: ["Quantity", "Plasmid Qty.", "Amount"],
    fallback: null,
  },
  geneName: {
    key: "geneName",
    label: "Gene Name",
    candidates: ["Gene Name", "GeneName"],
    fallback: null,
  },
  prep: {
    key: "prep",
    label: "Prep",
    candidates: ["Prep"],
    fallback: null,
  },
  temperature: {
    key: "temperature",
    label: "Temperature",
    candidates: ["Temperature", "Growth Condition/Temperature"],
    fallback: null,
  },
};

/** Resolve a named subset of COLUMN_SPECS in a fixed order. */
export function resolveSpecSet(headers, keys) {
  const specs = keys.map((k) => COLUMN_SPECS[k]).filter(Boolean);
  return { ...resolveColumns(headers, specs), specs };
}
