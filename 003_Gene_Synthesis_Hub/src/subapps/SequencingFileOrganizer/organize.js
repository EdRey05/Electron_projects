/**
 * Tab 1: Organize Sequencing Files — pure logic.
 *
 * Mirrors `_start_organize` + `_organize_thread` from the Python source.
 *
 * Files come in with naming pattern `PLASMID_JOBID_REST.ab1` or
 * `.fasta` (e.g. "P001_SYN-12345_Fwd.ab1"). We split on the first two
 * underscores to recover plasmid + job ID, then move each file into a
 * folder named `<job_id>.<plasmid>` (with any trailing dot collapsed).
 *
 * Files that don't match the pattern, end with `.seq`, or start with
 * "POS"/"Pos"/"pos" are filtered out and counted separately.
 */

/**
 * Extract (job_id, plasmid_number) from a sequencing filename.
 * Returns nulls if the filename doesn't match `(.+?)_(.+?)_(.+)`.
 */
export function extractInfo(filename) {
  // Match non-greedy: first "_" separates plasmid, second "_" separates job_id
  const m = filename.match(/^(.+?)_(.+?)_(.+)$/);
  if (!m) return { jobId: null, plasmidNumber: null };
  const plasmidNumber = m[1];
  const jobId = m[2].replace(/\.+$/, ""); // strip trailing dots from job_id
  return { jobId, plasmidNumber };
}

/**
 * Compute the folder name for a (jobId, plasmidNumber) pair.
 * Mirrors `f"{job_id}.{plasmid_number}".replace("..", ".").rstrip(".")`
 * in the Python source.
 */
export function folderNameFor(jobId, plasmidNumber) {
  let name = `${jobId}.${plasmidNumber}`;
  // Collapse any ".." runs (defensive; only one can really occur).
  while (name.includes("..")) name = name.replace("..", ".");
  // Strip trailing dots so the folder name is clean.
  name = name.replace(/\.+$/, "");
  return name;
}

/**
 * Classify a single filename in the source directory into one of:
 *   { type: "parseable", jobId, plasmidNumber, folderName }
 *   { type: "unparseable" }
 *   { type: "seq" }      - counted but skipped (will be deleted on organize)
 *   { type: "pos" }      - skipped (positive control)
 *   { type: "other" }    - skipped
 */
export function classifyFile(filename) {
  if (filename.endsWith(".seq")) return { type: "seq" };
  if (
    filename.startsWith("POS") ||
    filename.startsWith("Pos") ||
    filename.startsWith("pos")
  ) {
    return { type: "pos" };
  }
  if (!(filename.endsWith(".ab1") || filename.endsWith(".fasta"))) {
    return { type: "other" };
  }
  const { jobId, plasmidNumber } = extractInfo(filename);
  if (!jobId || !plasmidNumber) return { type: "unparseable" };
  return {
    type: "parseable",
    jobId,
    plasmidNumber,
    folderName: folderNameFor(jobId, plasmidNumber),
  };
}

/**
 * Plan the organization of a source directory.
 * Returns: { parseable: [...], unparseable: [...], seqCount, posCount,
 *           folderNames: [...unique], existingFolders: [...] }
 *
 * existingFolders is the subset of folder names that already exist on disk
 * (passed in via `existingFolderNames`, which the renderer pulls from
 * hub:listDirectory).
 */
export function planOrganize(filenames, existingFolderNames = []) {
  const parseable = [];
  const unparseable = [];
  let seqCount = 0;
  let posCount = 0;

  for (const filename of filenames) {
    const cls = classifyFile(filename);
    if (cls.type === "seq") { seqCount++; continue; }
    if (cls.type === "pos") { posCount++; continue; }
    if (cls.type === "other") continue;
    if (cls.type === "unparseable") { unparseable.push(filename); continue; }
    parseable.push({
      filename,
      jobId: cls.jobId,
      plasmidNumber: cls.plasmidNumber,
      folderName: cls.folderName,
    });
  }

  const folderNames = [...new Set(parseable.map((p) => p.folderName))].sort();
  const existingFolders = folderNames.filter((n) =>
    existingFolderNames.includes(n)
  );

  return { parseable, unparseable, seqCount, posCount, folderNames, existingFolders };
}

/**
 * Build the issue report that the Python app shows in the pre-scan dialog.
 * Mirrors the issue lines the user sees before clicking Abort/Skip/All.
 */
export function buildOrganizeIssues(plan) {
  const issues = [];
  if (plan.unparseable.length) {
    issues.push(`⚠ ${plan.unparseable.length} file(s) cannot be parsed:`);
    for (const fn of plan.unparseable) issues.push(`  ✖ ${fn}`);
    issues.push("");
  }
  if (plan.existingFolders.length) {
    issues.push(`📁 ${plan.existingFolders.length} folder(s) already exist:`);
    const limit = Math.min(10, plan.existingFolders.length);
    for (const fn of plan.existingFolders.slice(0, limit)) {
      issues.push(`  📁 ${fn}`);
    }
    if (plan.existingFolders.length > 10) {
      issues.push(`  ... and ${plan.existingFolders.length - 10} more`);
    }
    issues.push("");
  }
  return issues;
}

export function buildOrganizeSummary(plan) {
  const parts = [`Scan found ${plan.parseable.length} parseable files`];
  if (plan.unparseable.length) parts.push(`${plan.unparseable.length} unparseable`);
  if (plan.existingFolders.length) parts.push(`${plan.existingFolders.length} existing folders`);
  return parts.join(", ") + ".";
}
