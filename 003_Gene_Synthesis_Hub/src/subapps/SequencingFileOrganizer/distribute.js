/**
 * Tab 2: Distribute Reference Files — pure logic.
 *
 * Mirrors `_start_distribute` + `_distribute_thread` from the Python source.
 *
 * For each .txt file in the reference directory, extract its base name
 * (split on "+", then on ".", take [0]). If that base name matches a
 * Job ID that was organized in Tab 1, mark it for distribution into the
 * matching destination folder.
 */

/**
 * Compute the base name of a reference file.
 * "JOB-001+pUC19.txt" -> "JOB-001"
 * "JOB-001.txt"       -> "JOB-001"
 */
export function referenceBaseName(filename) {
  const noExt = filename.endsWith(".txt") ? filename.slice(0, -4) : filename;
  const noPlus = noExt.split("+")[0];
  const noDot = noPlus.split(".")[0];
  return noDot;
}

/**
 * Build a {jobId -> [filename, ...]} map of reference files matching
 * the given organized Job IDs.
 */
export function mapReferenceFiles(referenceFilenames, organizedJobIds) {
  const jobIdSet = new Set(organizedJobIds);
  const fileMap = {};
  for (const fn of referenceFilenames) {
    if (!fn.endsWith(".txt")) continue;
    const base = referenceBaseName(fn);
    if (jobIdSet.has(base)) {
      if (!fileMap[base]) fileMap[base] = [];
      fileMap[base].push(fn);
    }
  }
  return fileMap;
}

/**
 * Compute which Job IDs are missing reference files and which are
 * missing destination folders. Used by the pre-scan issues dialog.
 */
export function findMissingReferences(referenceFilenames, organizedJobIds) {
  const fileMap = mapReferenceFiles(referenceFilenames, organizedJobIds);
  const missingRefs = organizedJobIds.filter((jid) => !fileMap[jid]).sort();
  return { fileMap, missingRefs };
}

/**
 * Find which organized Job IDs don't have a corresponding destination folder.
 * `existingFolderNames` should be the list of folders in the destination dir.
 *
 * The Python version compares folder.split(".")[0] == jid.
 */
export function findMissingFolders(existingFolderNames, organizedJobIds) {
  const baseNames = new Set(existingFolderNames.map((f) => f.split(".")[0]));
  return organizedJobIds.filter((jid) => !baseNames.has(jid));
}

/**
 * Build the issue list for the distribute pre-scan dialog.
 */
export function buildDistributeIssues({ missingRefs, missingFolders }) {
  const issues = [];
  if (missingRefs.length) {
    issues.push(`⚠ ${missingRefs.length} Job ID(s) missing reference .txt files:`);
    for (const jid of missingRefs) issues.push(`  ✖ ${jid}`);
    issues.push("");
  }
  if (missingFolders.length) {
    issues.push(`⚠ ${missingFolders.length} Job ID(s) have no destination folder:`);
    for (const jid of [...new Set(missingFolders)].sort()) {
      issues.push(`  ✖ ${jid}`);
    }
    issues.push("");
  }
  return issues;
}

export function buildDistributeSummary({ fileMap, missingRefs, missingFolders, organizedJobIds }) {
  const parts = [`Scan found .txt files for ${Object.keys(fileMap).length} of ${organizedJobIds.length} Job IDs`];
  if (missingRefs.length) parts.push(`${missingRefs.length} missing references`);
  if (missingFolders.length) parts.push(`${missingFolders.length} missing folders`);
  return parts.join(", ") + ".";
}
