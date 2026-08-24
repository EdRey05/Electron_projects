/**
 * Ligation Layout — fragment matcher.
 *
 * Mirrors the fragment-matching logic in `_processing_thread` (lines ~1437-1533):
 *
 *   Priority 1: Look in the "PCR Fragments" consolidated rows. If the job
 *               has an entry there, use that (one entry per job).
 *   Priority 2: Otherwise, look in the monthly fragment rows. Take any row
 *               whose Gene Name starts with the job ID AND Purity Pass != "Fail".
 *               - Try "JOB" or "JOBA" first (Fragment A).
 *               - If A found, try "JOBB" (Fragment B).
 *               - If B found, try "JOBC" (Fragment C).
 *
 * Returns: { [jobId]: [{ name, location, length, concentration? }, ...] }
 */

export function matchFragmentsToJobs(layoutRows, fragments) {
  const out = {};

  for (const row of layoutRows) {
    const jobId = row.job_id;
    // Skip controls (CK+) and empty rows
    if (!jobId || jobId.startsWith("CK")) continue;

    // --- Priority 1: PCR Fragments ---
    const pcrMatches = fragments.filter(
      (f) => f.sheetName === "PCR Fragments" && f.geneName === jobId
    );
    if (pcrMatches.length > 0) {
      const f = pcrMatches[0];
      out[jobId] = [
        {
          name: f.geneName,
          location: f.position,
          length: f.insertLength,
          concentration: f.concentration,
        },
      ];
      continue;
    }

    // --- Priority 2: Monthly sheets ---
    const passing = fragments.filter(
      (f) =>
        f.sheetName !== "PCR Fragments" &&
        f.geneName.startsWith(jobId) &&
        f.purityPass !== "Fail"
    );

    if (passing.length === 0) continue;

    // Fragment A: exact match or with "A" suffix
    const matchA = passing.find(
      (f) => f.geneName === jobId || f.geneName === jobId + "A"
    );
    const found = [];
    if (matchA) {
      found.push({
        name: matchA.geneName,
        location: `${matchA.sheetName}-${matchA.position}`,
        length: matchA.insertLength,
      });
      // Fragment B
      const matchB = passing.find((f) => f.geneName === jobId + "B");
      if (matchB) {
        found.push({
          name: matchB.geneName,
          location: `${matchB.sheetName}-${matchB.position}`,
          length: matchB.insertLength,
        });
        // Fragment C
        const matchC = passing.find((f) => f.geneName === jobId + "C");
        if (matchC) {
          found.push({
            name: matchC.geneName,
            location: `${matchC.sheetName}-${matchC.position}`,
            length: matchC.insertLength,
          });
        }
      }
    }
    if (found.length > 0) out[jobId] = found;
  }

  return out;
}
