/**
 * Tab 3: SG Check Document — pure logic.
 *
 * Mirrors `_start_generate_sg_check` + `_generate_sg_check_thread` from
 * the Python source. The output is a copy of the Excel template with
 * folder names written into column A starting at row 2, saved as
 * `{YYMMDD} Gene Seq Log.xlsx` in the output dir.
 */

/**
 * Build the date string used as the output filename prefix.
 * Mirrors `datetime.now().strftime("%y%m%d")` -> "260823".
 */
export function generateDateCode(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Validate a folder for SG check inclusion. Returns:
 *   { valid: true } | { valid: false, reason }
 */
export function classifyFolderForSgCheck(folderName, folderContents) {
  if (!Array.isArray(folderContents)) {
    return { valid: false, reason: "folder not found" };
  }
  const hasAb1 = folderContents.some(
    (fn) => fn.endsWith(".ab1") || fn.endsWith(".fasta")
  );
  const hasTxt = folderContents.some((fn) => fn.endsWith(".txt"));
  const missing = [];
  if (!hasAb1) missing.push("no .ab1/.fasta");
  if (!hasTxt) missing.push("no .txt");
  if (missing.length) {
    return { valid: false, reason: missing.join(", ") };
  }
  return { valid: true };
}

/**
 * Plan the SG check generation: classify each folder and split into
 * valid + invalid buckets.
 *
 * @param {string[]} folderNames      - folders to scan
 * @param {Object<string,string[]>} folderContents - {folderName -> [files...]}
 *                                            (renderer pulls this from
 *                                            hub:listDirectory per folder)
 */
export function planSgCheck(folderNames, folderContents) {
  const valid = [];
  const invalid = [];
  for (const name of folderNames) {
    const cls = classifyFolderForSgCheck(name, folderContents[name]);
    if (cls.valid) valid.push(name);
    else invalid.push({ name, reason: cls.reason });
  }
  return { valid, invalid };
}

/**
 * Compute the suggested output filename (no path).
 * "{YYMMDD} Gene Seq Log.xlsx" -> "260823 Gene Seq Log.xlsx"
 */
export function suggestSgCheckFilename(date = new Date()) {
  return `${generateDateCode(date)} Gene Seq Log.xlsx`;
}

export function buildSgCheckIssues(invalid) {
  const issues = [];
  if (invalid.length) {
    issues.push(`⚠ ${invalid.length} folder(s) have missing files:`);
    for (const { name, reason } of invalid) {
      issues.push(`  ✖ ${name}: ${reason}`);
    }
    issues.push("");
  }
  return issues;
}

export function buildSgCheckSummary({ valid, invalid }) {
  return `Scan found ${valid.length} valid, ${invalid.length} incomplete folder(s).\n` +
    `'Skip' = exclude incomplete folders from the Excel\n` +
    `'Process All' = include all folders (remove extras manually later)`;
}
