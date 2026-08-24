/**
 * Colony PCR Layout — 96-well plate placement algorithm.
 *
 * Mirrors the loop in `fill_colony_pcr_layout` (Python source lines ~1206-1319):
 *
 *   for each (jobId, primers, numClones) in summary_data sorted by Vector:
 *     place clones sequentially in the 96-well grid (rows 0-7, cols 0-11)
 *     - same primers -> same column (don't break)
 *     - different primers OR overflow -> start new column
 *     - column overflow (12+) -> create a new plate
 *   then place CK+ and CK- controls at the end of the last plate
 *
 * Returns a "plates" array describing the placement:
 *   [{ jobs: [{ jobId, primers, clones: [{ row, col, label }] }], controls: [...] }, ...]
 *
 * Pure function: input is summaryData + cloneCounts, output is the placement.
 * The actual Excel-writing happens in workbookBuilder.js.
 */

const PLATE_ROWS = 8; // 96-well plate is 8 rows (A-H)
const PLATE_COLS = 12; // 12 columns (1-12)

/**
 * Sort the summary data by Vector (alphabetically), then plan the placement.
 * Mirrors `summary_data.sort_values(by="Vector")` from the Python source.
 *
 * cloneCounts is a Map<(jobId, sourceFile), number>.
 * Returns { plates, warnings }.
 */
export function planPlates(summaryData, cloneCounts) {
  // Filter to jobs with clones > 0, sort by Vector then JobID.
  const sorted = [...summaryData]
    .filter((row) => (cloneCounts.get(rowKey(row)) ?? 0) > 0)
    .sort((a, b) => {
      const v = (a.Vector || "").localeCompare(b.Vector || "");
      if (v !== 0) return v;
      return (a.JobID || "").localeCompare(b.JobID || "");
    });

  const plates = [];
  let current = newPlate();
  let currentRow = 0;
  let currentCol = 0;
  let primersInCurrentCol = null;
  const warnings = [];

  for (const job of sorted) {
    const numClones = cloneCounts.get(rowKey(job)) ?? 0;
    const primers = job.Primers || "";

    // Decide if we need to start a new column within this plate
    const needsNewCol =
      (currentRow > 0 &&
        primersInCurrentCol !== null &&
        primers !== primersInCurrentCol) ||
      (currentRow + numClones > PLATE_ROWS && currentRow > 0);

    // If starting a new column would overflow the plate, start a new plate.
    if (currentCol + (needsNewCol ? 1 : 0) >= PLATE_COLS) {
      plates.push(current);
      current = newPlate();
      currentRow = 0;
      currentCol = 0;
      primersInCurrentCol = null;
    }

    // Now actually start a new column if needed
    const newColNeeded =
      (currentRow > 0 &&
        primersInCurrentCol !== null &&
        primers !== primersInCurrentCol) ||
      (currentRow + numClones > PLATE_ROWS && currentRow > 0);

    if (newColNeeded) {
      currentCol += 1;
      currentRow = 0;
      primersInCurrentCol = null;
    }

    // Track this job's clone group span (for border drawing).
    const groupStartRow = currentRow;
    const groupStartCol = currentCol;
    let groupEndCol = currentCol;
    const placements = [];

    // Place each clone, wrapping within the plate
    for (let i = 1; i <= numClones; i++) {
      if (currentRow >= PLATE_ROWS) {
        // Wrap to next column within this plate
        currentCol += 1;
        currentRow = 0;
        primersInCurrentCol = null;
        groupEndCol = currentCol;
      }
      if (currentCol >= PLATE_COLS) {
        // Plate full - start a new plate
        plates.push(current);
        current = newPlate();
        currentRow = 0;
        currentCol = 0;
        primersInCurrentCol = null;
        groupStartCol; // keep groupStartCol from outer scope for border
      }
      if (currentRow === 0 && primersInCurrentCol === null) {
        primersInCurrentCol = primers;
      }
      const label = `${job.JobID}-Clone${i}`;
      placements.push({ row: currentRow, col: currentCol, label });
      current.jobs.push({
        jobId: job.JobID,
        primers,
        row: currentRow,
        col: currentCol,
        cloneIdx: i,
        label,
        groupStartRow,
        groupStartCol,
        groupEndCol,
        cloneCount: numClones,
      });
      currentRow += 1;
    }
  }

  // Place controls in the final plate
  let controlStartRow = currentRow;
  let controlStartCol = currentCol;
  for (const ctrl of ["CK+", "CK-"]) {
    if (currentRow >= PLATE_ROWS) {
      currentCol += 1;
      currentRow = 0;
    }
    if (currentCol >= PLATE_COLS) {
      plates.push(current);
      current = newPlate();
      currentRow = 0;
      currentCol = 0;
      controlStartRow = 0;
      controlStartCol = 0;
    }
    current.controls.push({
      label: ctrl,
      row: currentRow,
      col: currentCol,
      groupStartRow: controlStartRow,
      groupStartCol: controlStartCol,
      groupEndCol: controlStartCol,
      cloneCount: 1,
    });
    currentRow += 1;
  }
  plates.push(current);

  return { plates, warnings };
}

function rowKey(row) {
  return `${row.JobID}\0${row.SourceFile}`;
}

function newPlate() {
  return { jobs: [], controls: [] };
}
