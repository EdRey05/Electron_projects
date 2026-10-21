/**
 * XLSX post-processing: force a full recalculation when the file is opened.
 *
 * WHY
 * ---
 * The Ligation layout is built by reading the template with SheetJS and
 * writing it back. SheetJS does not round-trip:
 *
 *   - the workbook's `<calcPr>` element (the template has
 *     `<calcPr calcId="145621"/>`, the output has none), and
 *   - the CACHED VALUES of formula cells — a formula cell is emitted as
 *     `<c r="R2" t="str"><f>IF(B2="","",10-SUM(N2,K2,Q2)-H2)</f><v></v></c>`,
 *     i.e. an EMPTY cached value.
 *
 * The template's 292 formulas (191 shared on the Layout sheet + 96 on the
 * Fragments sheet) therefore read as blank in any viewer that does not
 * evaluate formulas — Google Sheets' preview, LibreOffice's quick view,
 * a thumbnailer, or anything reading the cell values programmatically.
 *
 * The Python does not have this problem: openpyxl preserves the original
 * `calcPr` and the shared-formula structure.
 *
 * THE FIX
 * -------
 * Excel recalculates every formula when the workbook says
 * `fullCalcOnLoad="1"` (or when `calcId` is lower than the reader's own
 * calc engine version). Injecting that attribute into the output's
 * `xl/workbook.xml` makes the formulas compute on open, in Excel and in
 * LibreOffice alike.
 *
 * This is a surgical ZIP edit: every entry except `xl/workbook.xml` is
 * copied byte-identical.
 */

import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";

/**
 * Add `fullCalcOnLoad="1"` to the workbook's `<calcPr>` element, adding
 * the element if it is missing.
 *
 * @param {string} workbookXml the raw `xl/workbook.xml` content
 * @returns {string} the patched XML
 */
export function forceFullCalcOnLoad(workbookXml) {
  if (!workbookXml) return workbookXml;

  const calcPrRe = /<calcPr\b[^>]*\/>/;

  if (calcPrRe.test(workbookXml)) {
    // The element exists — make sure it carries fullCalcOnLoad.
    return workbookXml.replace(calcPrRe, (tag) => {
      if (/fullCalcOnLoad=/.test(tag)) {
        return tag.replace(/fullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"');
      }
      return tag.replace(/\/>$/, ' fullCalcOnLoad="1"/>');
    });
  }

  // No calcPr — add one right before `</workbook>`.
  // calcId="0" is the lowest possible value, so every reader knows the
  // file was written by something other than its own engine and must
  // recalculate.
  return workbookXml.replace(
    "</workbook>",
    '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>'
  );
}

/**
 * Force a full recalc on load for a .xlsx byte buffer.
 *
 * @param {ArrayBuffer|Uint8Array} bytes the workbook bytes
 * @returns {Uint8Array} the patched bytes
 */
export function applyFullCalcOnLoad(bytes) {
  const files = unzipSync(bytes);
  const workbookXml = files["xl/workbook.xml"];
  if (!workbookXml) return bytes;

  files["xl/workbook.xml"] = strToU8(
    forceFullCalcOnLoad(strFromU8(workbookXml))
  );

  // fflate's default mtime is "now", which changes the ZIP's timestamps on
  // every run. Pin it to the ZIP epoch so the output is byte-stable.
  // fflate reads the date with LOCAL-time getters, so this must be a local
  // date — a UTC 1980-01-01 would land on 1979 in a negative-offset zone
  // and fflate would reject it ("date not in range 1980-2099").
  return zipSync(files, {
    level: 6,
    mtime: new Date(1980, 0, 1, 0, 0, 0),
  });
}
