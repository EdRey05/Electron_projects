/**
 * Surgical .xlsx editor.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Gene Seq Log template (`Templates/Gene_Seq_Log_v2.xlsx`) carries an
 * EXTERNAL LINK (`xl/externalLinks/externalLink1.xml`) and ~2500 VLOOKUP
 * formulas that reference it:
 *
 *     <f t="shared" si="8">IF(A2="","",VLOOKUP(J2,[1]Initiated!$A:$Y,...))</f>
 *
 * SheetJS (xlsx) does NOT round-trip external links. Reading the template
 * and writing it back drops `xl/externalLinks/`, `xl/sharedStrings.xml` and
 * the `calcChain`, and the surviving formulas keep their `[1]Initiated!`
 * references with no `[1]` workbook to resolve against. Excel then shows
 * `#REF!` in every one of those cells — the SG Check document comes out
 * empty even though the folder names were written correctly.
 *
 * The Python original uses openpyxl, which DOES preserve external links
 * (`load_workbook` keeps them by default). So the React port must not use
 * a whole-workbook read/write round-trip.
 *
 * WHAT THIS DOES
 * --------------
 * Rewrites the .xlsx zip entry-by-entry, copying every part byte-identical
 * except the one sheet XML that is actually edited. The external link, the
 * shared strings, the styles, the calc chain and the relationships all
 * survive untouched.
 *
 * The write is: set the value of cell A{row} on the first (or named) sheet.
 * Cells are written as INLINE strings (`t="inlineStr"`) so no sharedStrings
 * table has to be edited — a self-contained cell that every Excel version
 * reads.
 */

/**
 * Column letters for a 0-based index: 0 → "A", 25 → "Z", 26 → "AA".
 */
function colLetter(index) {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Escape a string for XML text content. */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the `<c>` element for an inline string, keeping the style index of
 * the cell that is being replaced (so the row keeps its formatting).
 */
function inlineStringCell(ref, styleAttr, value) {
  const attrs = [`r="${ref}"`];
  if (styleAttr) attrs.push(styleAttr);
  attrs.push('t="inlineStr"');
  return `<c ${attrs.join(" ")}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

/**
 * Set (or clear) the value of a cell in a sheet's XML.
 *
 * @param {string} sheetXml  the raw `xl/worksheets/sheetN.xml` content
 * @param {string} ref        e.g. "A2"
 * @param {string|null} value the new value; null/"" clears the cell
 * @returns {string} the patched sheet XML
 */
export function setCellValue(sheetXml, ref, value) {
  const rowNum = parseInt(ref.replace(/^[A-Z]+/, ""), 10);
  if (!rowNum) return sheetXml;

  // Locate the row element.
  const rowRe = new RegExp(`(<row\\b[^>]*\\br="${rowNum}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const rowMatch = sheetXml.match(rowRe);
  if (!rowMatch) {
    // No such row — nothing to write. (The template always has the rows
    // we need; creating rows would mean re-deriving spans + styles.)
    return sheetXml;
  }

  const rowOpen = rowMatch[1];
  let rowBody = rowMatch[2];

  // Locate the cell element for this ref.
  const cellRe = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*\\/>|<c\\b[^>]*\\br="${ref}"[^>]*>[\\s\\S]*?</c>`);
  const cellMatch = rowBody.match(cellRe);

  if (value === null || value === undefined || value === "") {
    // Clear the value but keep the cell (and its style) so the template's
    // formulas that reference it still resolve.
    if (!cellMatch) return sheetXml;
    const styleAttr = (cellMatch[0].match(/\bs="(\d+)"/) || [])[0];
    const cleared = `<c r="${ref}"${styleAttr ? " " + styleAttr : ""}/>`;
    rowBody = rowBody.replace(cellRe, cleared);
  } else {
    if (cellMatch) {
      const styleAttr = (cellMatch[0].match(/\bs="(\d+)"/) || [])[0];
      rowBody = rowBody.replace(cellRe, inlineStringCell(ref, styleAttr, value));
    } else {
      // Cell absent — insert it in column order at the start of the row.
      const newCell = inlineStringCell(ref, null, value);
      const cells = [...rowBody.matchAll(/<c\b[^>]*\br="([A-Z]+)(\d+)"[^>]*\/?>/g)];
      let insertAt = 0;
      for (const m of cells) {
        const colIdx = colIndex(m[1]);
        const targetIdx = colIndex(ref.replace(/[0-9]/g, ""));
        if (colIdx < targetIdx) insertAt = m.index + m[0].length;
        else break;
      }
      rowBody = rowBody.slice(0, insertAt) + newCell + rowBody.slice(insertAt);
    }
  }

  return sheetXml.replace(rowRe, `${rowOpen}${rowBody}</row>`);
}

/**
 * Keep the template's `<conditionalFormatting>` blocks in a sheet that was
 * re-emitted by a writer that cannot render them.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Empty Order Form template carries one conditional-formatting rule
 * ("highlight duplicate values" across H20:H115). ExcelJS PARSES that rule
 * (it lands in `ws.conditionalFormattings`) but its writer has no renderer
 * for the `duplicateValues` type, so it emits an EMPTY element:
 *
 *     <conditionalFormatting sqref="H20:H115"/>
 *
 * `cfRule` is REQUIRED by the OOXML schema (CT_ConditionalFormatting has
 * minOccurs=1), so an empty element makes Excel offer to "repair" the
 * workbook the first time it is opened — a broken order form.
 *
 * The fix: take the block verbatim from the ORIGINAL template XML and put
 * it back, immediately before `<pageMargins>` (which is where the OOXML
 * schema's element order puts conditionalFormatting).
 *
 * @param {string} sheetXml         the re-emitted sheet XML
 * @param {string} templateSheetXml the original template's sheet XML
 * @returns {string} the patched sheet XML
 */
export function restoreConditionalFormatting(sheetXml, templateSheetXml) {
  let out = String(sheetXml || "");
  // Drop every conditionalFormatting element the writer produced — both the
  // empty (self-closing) and the populated variants.
  out = out.replace(/<conditionalFormatting\b[^>]*\/>/g, "");
  out = out.replace(/<conditionalFormatting\b[^>]*>[\s\S]*?<\/conditionalFormatting>/g, "");

  const blocks =
    (String(templateSheetXml || "").match(
      /<conditionalFormatting\b[\s\S]*?<\/conditionalFormatting>/g
    ) || []);
  if (!blocks.length) return out;

  const block = blocks.join("");
  if (/<pageMargins\b/.test(out)) {
    return out.replace(/<pageMargins\b/, `${block}<pageMargins`);
  }
  return out.replace(/<\/worksheet>\s*$/, `${block}</worksheet>`);
}

/** 0-based column index from a letter string: "A" → 0, "AA" → 26. */
function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Write a list of { row, value } entries into column A of a sheet.
 *
 * @param {string} sheetXml
 * @param {Array<{row:number, value:string}>} entries
 * @returns {string}
 */
export function setColumnA(sheetXml, entries) {
  let out = sheetXml;
  for (const e of entries) {
    out = setCellValue(out, `A${e.row}`, e.value);
  }
  return out;
}

/**
 * Which sheet XML part corresponds to a sheet name?
 *
 * @param {Object<string, Uint8Array>} files  the unzipped xlsx parts
 * @param {string} sheetName  the sheet to target (or "" for the first)
 * @returns {string} the part name, e.g. "xl/worksheets/sheet1.xml"
 * @throws when the sheet cannot be found
 */
export function resolveSheetPart(files, sheetName) {
  const workbookXml = decodeText(files["xl/workbook.xml"]);
  if (!workbookXml) throw new Error("Not a valid .xlsx: xl/workbook.xml is missing");

  const rels = decodeText(files["xl/_rels/workbook.xml.rels"]) || "";
  // rId → target
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) {
    relMap[m[1]] = m[2];
  }
  for (const m of rels.matchAll(/<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*\bId="([^"]+)"/g)) {
    relMap[m[2]] = m[1];
  }

  const sheets = [...workbookXml.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => m[0]);
  for (const s of sheets) {
    const name = (s.match(/\bname="([^"]*)"/) || [])[1];
    const rid = (s.match(/\br:id="([^"]+)"/) || [])[1];
    if (rid && relMap[rid]) {
      if (!sheetName || name === sheetName) {
        let target = relMap[rid].replace(/^\/?xl\//, "").replace(/^\//, "");
        if (!target.startsWith("xl/")) target = "xl/" + target;
        if (files[target]) return target;
      }
    }
  }
  if (!sheetName && sheets.length) {
    // Fall back to the first worksheet part present in the archive.
    const cand = Object.keys(files)
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort();
    if (cand.length) return cand[0];
  }
  throw new Error(`Sheet "${sheetName}" not found in workbook`);
}

/** First sheet name in the workbook (matches openpyxl's `wb.active` when the
 *  template has a single sheet; the SG Check template has exactly one). */
export function firstSheetName(files) {
  const workbookXml = decodeText(files["xl/workbook.xml"]) || "";
  const m = workbookXml.match(/<sheet\b[^>]*\bname="([^"]*)"/);
  return m ? m[1] : "";
}

/** Active sheet name, honouring `activeTab` in the bookViews. */
export function activeSheetName(files) {
  const workbookXml = decodeText(files["xl/workbook.xml"]) || "";
  const activeIdx = (workbookXml.match(/\bactiveTab="(\d+)"/) || [])[1];
  const names = [...workbookXml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => m[1]);
  if (activeIdx !== undefined && names[Number(activeIdx)]) return names[Number(activeIdx)];
  return names[0] || "";
}

function decodeText(bytes) {
  if (!bytes) return "";
  return new TextDecoder("utf-8").decode(bytes);
}
