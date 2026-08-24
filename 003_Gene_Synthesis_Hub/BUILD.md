# Building the portable Windows app

## Prerequisites

- **Node.js 18+** and **npm**.
- A Windows host (for the `.exe`). Cross-compiling from Linux/macOS works for some
  targets but `extraResources` paths assume Windows drive letters.
- **Portable CPython 3.11+** for the bundled runtime. The simplest source is **uv**:
  ```bash
  uv python install 3.11
  ```
  This installs `python-build-standalone` to `~/AppData/Roaming/uv/python/cpython-3.11.*-windows-x86_64-none/`,
  which `scripts/stage-python.js` then copies into `python-app/runtime/`.
  If you don't have uv, download any python-build-standalone `.zip` from
  <https://github.com/astral-sh/python-build-standalone/releases> and point
  `PYTHON_BUNDLE=...` at the extracted folder when running the staging script.

## First-time setup

```bash
cd 003_Gene_Synthesis_Hub
npm install
node scripts/stage-python.js     # ~3 minutes: copies CPython + builds venv with hub deps
```

`stage-python.js` is idempotent: re-running it with the same source will refresh
the runtime/venv. Use `--no-copy` to skip the runtime copy and only reinstall
requirements (faster after editing `python-app/requirements.txt`).

## Dev mode

```bash
npm run dev
```

This runs the Vite dev server (port 5173) and launches Electron pointed at it.
DevTools open in detached mode. Drive scanning and subprocess launching all work
against the bundled `python-app/`.

## Production build (Windows)

```bash
npm run build               # bundles React into dist/
npm run package:portable    # produces release/win-unpacked/ + a portable .exe
```

Outputs (in `release/`):

| File                                                          | Description                          | Size      |
| ------------------------------------------------------------- | ------------------------------------ | --------- |
| `Gene Synthesis Hub-1.0.0-x64.exe`                           | Portable single-exe launcher         | ~120 MB   |
| `win-unpacked/Gene Synthesis Hub.exe`                         | Portable folder launcher             | ~180 MB   |
| `win-unpacked/`                                               | Self-contained portable folder       | ~650 MB   |

The `win-unpacked/` folder includes the full `resources/python-app/` (runtime +
venv + subapps + templates + databases). Distribute the whole folder, not just
the `.exe` — the `.exe` depends on sibling files.

### Distributing

**Recommended:** ship the entire `win-unpacked/` folder as a `.zip`. The launcher
`.exe` depends on sibling files (`resources/app.asar`, `resources/python-app/...`).
Copying only the `.exe` fails with "missing app.asar".

## Rebuilding from scratch

If `node_modules/`, `dist/`, or `release/` is missing, just re-run:

```bash
npm install
npm run build
```

If `python-app/runtime/` or `python-app/runtime-venv/` is missing, re-run:

```bash
node scripts/stage-python.js
```

All of these are disposable (gitignored).

## Updating subapps

When `BBI_projects/App_hub/Gene_Synthesis_hub/Code/<x>/<x>_app.py` changes upstream:

```bash
node scripts/stage-subapps.js   # refreshes python-app/Code, Templates, Databases
```

When `requirements.txt` changes:

```bash
# Edit python-app/requirements.txt
node scripts/stage-python.js --no-copy
```

After either of these, rebuild the portable artifact with `npm run package:portable`.

## Verifying the build

Without a GUI on this host:

```bash
node --check electron/main.js           # main process parses
node --check electron/preload.js        # preload parses
npm run build                           # Vite bundles → dist/
ls -la dist/                            # CSS >5 KB (Tailwind ran)
grep -l "GeneSynthesisHub\|hub:scanDrives\|hub:launchApp" dist/assets/*.js

# Inspect the packaged asar
node -e "
const asar = require('@electron/asar');
const list = asar.listPackage('release/win-unpacked/resources/app.asar');
console.log(list.length, 'entries in app.asar');
list.slice(0, 40).forEach(p => console.log('  ' + p));
"

# Confirm the bundled python runtime + subapps made it
ls -la release/win-unpacked/resources/python-app/runtime/python.exe
ls -la release/win-unpacked/resources/python-app/runtime-venv/Scripts/python.exe
ls release/win-unpacked/resources/python-app/Code/

# Quick smoke test of the staged venv (no Electron required)
./release/win-unpacked/resources/python-app/runtime-venv/Scripts/python.exe -c \
  "import customtkinter, openpyxl, pandas, streamlit, docx, Bio, PIL, win32api; print('OK')"
```

What these checks DO NOT catch: actual GUI rendering, runtime drive scanning on a
real Windows host with the configured drive labels, the Tkinter/Streamlit subapp
windows popping up. Those need a real Windows desktop session.

## Subapp migration checklist (when porting Python → React)

When porting a subapp to React:

1. Add a new folder `src/subapps/<Name>/` with the React implementation.
2. Add the component to the `REACT_SUBAPPS` map in `src/App.jsx`.
3. Replace the `[Section]` in `python-app/app_information.txt` with a stub:
   ```
   [Primer Finder]
   category = react_route
   path = subapps/PrimerFinder
   entry = PrimerFinder.jsx
   icon = 🔬
   version = 2.0
   date_released = 2026-08-23
   status = success
   message = ...
   requires =
   ```
4. Remove the matching `python-app/Code/<Name>/` folder (and its `__pycache__`).
5. Update `python-app/requirements.txt` to drop deps no longer needed (only
   safe to do once *all* subapps using a dep have been ported).

Each subapp port removes a Python file + (eventually) trims the venv. Per-port
savings are modest until several ports land and we can drop pandas/biopython/
customtkinter/streamlit wholesale.

## Primer Finder port notes (Aug 23, 2026)

First successful React port. The Python original (~547 lines, customtkinter)
became ~500 LOC across three files:

- `src/subapps/PrimerFinder/sequenceUtils.js` — pure functions for
  reverse-complement, sequence cleaning, primer validation, sheet relevance.
  No React deps, easily unit-testable.
- `src/subapps/PrimerFinder/excelReader.js` — thin wrapper around `xlsx` that
  mirrors the Python app's "S/T/U/V sheets, columns A:B, rows 35-100" filter.
- `src/subapps/PrimerFinder/PrimerFinder.jsx` — the React component itself.

Differences from the Tkinter original:

- No thread/threading complexity. The Excel read is async (`await
  file.arrayBuffer()`), the candidate scan is chunked in batches of 200 with
  `setTimeout(0)` yields between batches so the UI stays responsive.
- No `messagebox` — toast-style status text + the new IPC save dialog
  (`hub:saveResultsCsv`) replaces the auto-download-with-URL.createObjectURL
  pattern.
- The "Validate file" pre-flight check is inline (parse the file once on
  selection; mark valid if it parses).

Dependencies added to `package.json`: `xlsx@^0.18.5` (matches the version SBF
already uses for its own Excel I/O).

## QC Vector Map Prep port notes (Aug 23, 2026)

Second React port, partial: only the BioPython workflow. The original Python
subapp exposes two workflows from one Tkinter window — BioPython (writes
`.gb` GenBank files) and SnapGene (drives `pyautogui` to control an external
proprietary app). The SnapGene workflow cannot be ported (no JS equivalent
for OS-level input injection), so it's preserved as a separate
`[QC Digestion Design]` Python entry.

The new `[QC Vector Map Prep]` React subapp:

- `src/subapps/QCVectorMap/sequenceUtils.js` — pure helpers for
  reverse-complement-free subsequence location (handles wrap-around in
  circular sequences), sequence cleaning.
- `src/subapps/QCVectorMap/excelHelpers.js` — reads the Primer Log workbook,
  matches `input addon` + `Obsolete input addon(completed)` sheets (same
  predicate the Python app uses), column-name + positional lookup for
  `Final Vector` (fallback index 8 = column I) and `Insert Seq` (fallback
  index 7 = column H).
- `src/subapps/QCVectorMap/genbankWriter.js` — minimal GenBank emitter that
  produces a valid `.gb` file. LOCUS, DEFINITION, FEATURES (single
  `misc_feature` for linear inserts, two fragments for wrap-around), ORIGIN
  with 60-bp lines + 10-bp groups, terminator. No library needed.
- `src/subapps/QCVectorMap/QCVectorMap.jsx` — the React UI: file picker,
  output folder picker (via new `hub:chooseOutputDir` IPC), JobIDs textarea,
  progress bar, per-JobID log lines, results summary.

New IPC handlers added to support this subapp:

- `hub:chooseOutputDir(initial)` — opens the native folder picker, returns
  picked path or null.
- `hub:writeTextFile({filePath, text})` — writes text to an absolute path,
  creating intermediate directories. Used for dropping many files into one
  pre-chosen folder.

### GenBank writer smoke test

`scripts/test-genbank.js` exercises the writer end-to-end without needing
Vite/React. It strips the ESM syntax from `genbankWriter.js` + `sequenceUtils.js`,
evals them under `new Function`, and runs 14 assertions covering:
linear inserts, wrap-around inserts, insert-not-found errors, empty vector
errors, whitespace cleanup, vector-only output (no FEATURES block), LOCUS line
length, FEATURES structure, ORIGIN column alignment, `//` terminator.

Run with:

    node scripts/test-genbank.js

Last run: **all 14 tests passed** (Aug 23, 2026).

The script also writes a sample output to `/tmp/qcvectormap-test/test-001.gb`
for visual inspection. A snippet of that file:

```
LOCUS       test-001                    408 bp    DNA     circular  SYN 2026-08-23
DEFINITION  test-001 exported by QC Vector Map Prep..
...
FEATURES             Location/Qualifiers
     misc_feature    1..8
                     /label="Insert"
                     /note="Insert sequence"
ORIGIN
        1 aaaaggggcc ccggggcccc ...
//
```

This is the same shape BioPython's `SeqIO.write(..., "genbank")` would produce
for an equivalent record.

### Why only the BioPython workflow got ported

The SnapGene workflow uses:
- `pyautogui.hotkey("ctrl", "n")` etc. — synthetic keyboard input to a
  foreign window.
- `pyautogui.FailSafe` (mouse to corner = abort) — requires a real OS cursor.
- `win32gui.GetForegroundWindow()` — Windows-only native API.
- Modal CTk dialogs coordinated via `master.after()` + `threading.Event`
  for thread safety.

None of these have a browser/Electron renderer equivalent. They'd require a
Node addon that talks to the Windows input subsystem, which is an entirely
different stack. The Python version keeps working unchanged.

## Sequencing Reference Files port notes (Aug 23, 2026)

Third React port. The original Python app extracts reference sequences from
the Primer Log and writes them to a folder. Straightforward port — no domain
libraries beyond openpyxl, no threading complexity.

- `src/subapps/SequencingReferenceFiles/extractor.js` — column-resolution
  helpers + the `extractSequences(file)` function that returns rows ready
  for the React UI to iterate. Uses the `xlsx` library to read the workbook
  (same one Primer Finder / QC Vector Map Prep / SBF use).
- `src/subapps/SequencingReferenceFiles/SequencingReferenceFiles.jsx` —
  the React UI. File picker, output folder picker, column-detection preview,
  per-row log lines, results summary.

Column resolution: case-insensitive header lookup with positional fallbacks
(matches the Python app):
- JobID → A (0), falls back to A if header missing
- Vector → E (4)
- Insert Seq → H (7)
- Final Vector → I (8)

Each row produces up to two files:
- `{JobID}.txt` containing the Insert Seq (if non-empty)
- `{JobID}+{Vector}.txt` containing the Final Vector (if non-empty)

### Smoke test

`scripts/test-sequencing-reference-files.js` exercises the extractor +
planner end-to-end (no Excel I/O required). 23 assertions covering column
resolution, fallback behaviour, mixed cases, and output planning.

Run with:

    node scripts/test-sequencing-reference-files.js

Last run: **all 23 tests passed** (Aug 23, 2026).

## Sequencing Order Form port notes (Aug 23, 2026)

Fourth React port. The original Tkinter app fills an empty .xlsx order form
template from Primer Log + Sequencing Validation data, generating one row
per (sample, primer) pair starting at row 20.

- `src/subapps/SequencingOrderForm/dataExtractors.js` — `getPrimerInfo` (pulls
  primers from Primer Log columns Q onwards for each JobID), `getSequenceSampleId`
  (reads Sample IDs from Sequencing Validation rows 2-98, deduped, in order),
  `extractUniqueJobIds` (helper for the picker).
- `src/subapps/SequencingOrderForm/orderFormBuilder.js` — `buildFormRows`
  (turns samples + primers into per-row objects, dedup-missing warnings),
  `buildWorkbook` (emits a fresh .xlsx with header at A1 + data starting at
  A20 per the original layout), `serializeWorkbook` (XLSX.write wrapper).
- `src/subapps/SequencingOrderForm/SequencingOrderForm.jsx` — the React UI.
  3 file pickers, output folder picker, per-phase log, save button.

Two IPC handlers were added for this port:
- `hub:writeBinaryFile` — write an ArrayBuffer to disk (used to save the
  freshly-emitted .xlsx workbook).
- `hub:copyFile` — copy a file (used by the optional layout-template step
  that lays down `Sequencing_layout_<date>.xlsx` next to the order form).

### Differences from the Tkinter original

1. **Template round-trip**: the Python app uses openpyxl to mutate a copy
   of the Empty Order Form template, preserving any layout the user had.
   We can't reliably round-trip arbitrary templates via the `xlsx` library
   (it loses formatting, named styles, complex formulas, and silently drops
   formula cells that lack a cached value). So we generate a clean workbook
   from scratch with just the data + computed formula strings. Excel
   recalculates the formulas on open. The data + formulas round-trip
   correctly (verified by inspecting the raw sheet1.xml).
2. **Excel COM link update**: the original used `win32com.client` to update
   external links in the Sequencing Layout template (the `wb.ChangeLink`
   call). win32com has no JS equivalent. We skip this step and surface a
   notice in the log: "Open the copied layout in Excel and re-link it
   manually to the new order form."

### Smoke test

`scripts/test-sequencing-order-form.js` exercises the row builder + workbook
emitter end-to-end (no UI or Excel required). 36 assertions covering row
generation, missing-primer warnings, dedup, ZIP signature, warnings sheet,
empty inputs, and **raw XML verification** that the data + formulas are
present in the actual .xlsx file.

Run with:

    node scripts/test-sequencing-order-form.js

Last run: **all 36 tests passed** (Aug 23, 2026). The script also writes a
sample output to `scripts/test-output-order-form.xlsx` for visual inspection
in Excel.

## QC File Prep port notes (Aug 23, 2026) — deferred

QC File Prep is **not ported in v1.x**. It is technically a single Python
launcher (`QC_file_prep_app.py`, 323 LOC) that dispatches via a dropdown to
five sub-workflows:

| Sub-workflow | LOC | Notes |
|---|---|---|
| In-House New Names | 808 | DOC/DOCX + openpyxl + pandas |
| In-House Old Names | 624 | DOC/DOCX + win32com + PIL |
| Internal Renaming | 416 | DOC/DOCX + win32com |
| Resuspension Prep | 451 | DOC/DOCX + win32com |
| WGK Correction | 548 | DOC/DOCX + win32com |

**Blocker**: every sub-workflow uses `win32com.client.Dispatch('Word.Application')`
and `pythoncom.CoInitialize()` to read and write legacy `.doc` files (binary
Word format). There is no JavaScript implementation of the binary `.doc` file
format — only Microsoft Word via COM can author them reliably. This is the same
class of blocker as the QC Digestion Design (SnapGene) and Integra Worklist
(Streamlit) workflows.

**Why we don't ship a "half-port"**: a JS port without the .doc round-trip
would silently corrupt the user's QC reports. Better to leave the entire
QC File Prep workflow on Python and launch it via the existing
`tkinter_import` subprocess path.

**Future port strategy**: when JS-native `.doc` support exists (e.g. a
browser-compatible library that matches Word's binary format, or a node
addon that wraps libreoffice), the workflows can be ported one at a time.
Until then, the Electron hub launches the Python dispatcher unchanged.

## Sequencing File Organizer port notes (Aug 23, 2026)

Fifth React port. The original Tkinter app is a three-tab tool:
- Tab 1 Organize Files: regex-parse `PLASMID_JOBID_REST.{ab1,fasta}`,
  delete `.seq`, skip POS control files, move into per-JobID folders.
- Tab 2 Distribute References: find `.txt` files in the reference dir,
  match by JobID base name, copy into the folders created in Tab 1.
- Tab 3 SG Check Document: write folder names into column A of an Excel
  template starting at row 2, save as `{YYMMDD} Gene Seq Log.xlsx`.

- `src/subapps/SequencingFileOrganizer/organize.js` — pure logic for
  Tab 1: filename classification, plan generation, issue/summary builders.
- `src/subapps/SequencingFileOrganizer/distribute.js` — pure logic for
  Tab 2: reference file mapping, missing-reference / missing-folder
  detection, issue/summary builders.
- `src/subapps/SequencingFileOrganizer/sgCheck.js` — pure logic for
  Tab 3: folder classification, plan generation, output filename suggestion.
- `src/subapps/SequencingFileOrganizer/SequencingFileOrganizer.jsx` —
  the React UI with three tabs, file pickers, per-tab logs, and the
  shared dark-theme styling.

Five new IPC handlers were added for this port:
- `hub:listDirectory` — list files + subdirectories (with filter
  `files` | `dirs` | `all` and optional extension).
- `hub:moveFile` — move a file (cross-volume falls back to copy+delete).
- `hub:deleteFile` — delete a single file.
- `hub:createDirectory` — recursive mkdir.
- `hub:readBinaryFile` — load a file as an ArrayBuffer (used by Tab 3
  to read the Excel template).
- `hub:chooseFile` — native open-file dialog.

### Differences from the Tkinter original

1. **No threading**: async/await with `setTimeout(0)` yields between
   operations so the log keeps rendering per-file.
2. **Issue dialog → log**: the Python app shows a modal "Abort / Skip
   / All" dialog after each pre-scan. The React version writes the
   issues to the log instead and auto-applies the "skip" action (which
   matches the most common user choice). A future iteration could add
   a real modal with the three actions if needed.

### Smoke test

`scripts/test-sequencing-file-organizer.js` exercises all three pure-logic
modules (organize, distribute, sgCheck) end-to-end. 47 assertions covering
filename classification, plan generation, issue/summary builders, missing-
reference / missing-folder detection, and SG check folder classification.

Run with:

    node scripts/test-sequencing-file-organizer.js

Last run: **all 47 tests passed** (Aug 23, 2026).

## Colony PCR Layout port notes (Aug 23, 2026)

Sixth React port. The original Tkinter app reads one or more Ligation
Layout `.xlsx` files, joins them with Primer Log primer assignments,
asks the user for a clone count per (JobID, SourceFile), then fills the
Colony PCR Layout template with the 96-well plate layout (plus a samples
table, mix calculation table, and Label sheet). Multi-plate when the
clones don't fit on one 96-well grid.

This is the largest functional port to date because of the plate
placement algorithm. The Tkinter source has ~1,066 LOC of UI scaffolding
plus a 591-LOC `fill_colony_pcr_layout` function that does all the
placement + Excel writing. The port is split across three pure modules:

- `src/subapps/ColonyPCRLayout/extractor.js` — `readLigationLayout`,
  `readPrimerLog`, `buildSummary`, `uniqueJobDetails`.
- `src/subapps/ColonyPCRLayout/platePlanner.js` — `planPlates`
  (sort by Vector, place clones by plate / row / col, place controls).
- `src/subapps/ColonyPCRLayout/workbookBuilder.js` — `buildWorkbook`
  (Plate 1..N sheets with clone labels, samples table, mix table, plus
  a Label sheet).
- `src/subapps/ColonyPCRLayout/ColonyPCRLayout.jsx` — React UI with
  ligation files multi-picker, Primer Log picker, template picker,
  output folder picker, Generate button, log, and a clone-count
  modal (mirrors the Tkinter `CloneCountDialog`).

No new IPC handlers were needed — all the file IO goes through the
existing `hub:readBinaryFile`, `hub:chooseFile`, `hub:chooseOutputDir`,
and `hub:writeBinaryFile` handlers.

### Differences from the Tkinter original

1. **CloneCountDialog → modal**: the Tkinter modal with per-row spinboxes
   is replaced with a modal dialog in the renderer (`CloneCountModal`
   component). Behaviour parity: default 4 clones per (job, source-file),
   +/- and direct-input controls, range 0-96.
2. **Borders / styling**: the xlsx library doesn't expose per-edge
   border styling, so the thick/thin/L-shaped borders from the Python
   version are not replicated. The generated workbook has the data +
   structure; users may need to re-apply template styling manually.
3. **Generated workbook, not mutated template**: the Python source
   mutates the Colony PCR template in place, preserving its visual
   styling. The xlsx library can't reliably round-trip template
   formatting, so the React version generates a fresh `.xlsx` with
   the data + structure. Reapplying template styling is a manual step.
4. **Algorithm parity**: the plate placement algorithm matches the
   Python source's logic (sort by Vector, group by primer, multi-plate
   when col overflow, place CK+ then CK- at the end).

### Smoke test

`scripts/test-colony-pcr-layout.js` exercises all three pure-logic
modules. 30 assertions covering header generation, plate placement
(1-plate fits, multi-plate overflow, controls, sort-by-vector,
0-clone filter), workbook structure (per-plate sheets, Label sheet,
header position, first-clone cell at B3, samples table header),
and data extraction (CK control filter, Name->JobID rename, primer join).

Run with:

    node scripts/test-colony-pcr-layout.js

Last run: **all 30 tests passed** (Aug 23, 2026).

## Ligation Layout port notes (Aug 23, 2026)

Seventh React port. The original Tkinter app reads a Job Log + Fragments
file + Vector Database + Ligation Layout template, takes a list of Job
IDs, and fills the template with the layout (vector, enzyme, resistance,
length, host, temperature) plus the matched fragments (Insert 1/2/3 with
their location and computed volume).

This is the biggest single port so far. The Tkinter source has ~2,079 LOC
of UI scaffolding plus a ~700-LOC `_processing_thread` function that
loads 4 files, joins data, prompts for manual vector entries, and writes
the layout. The port is split across four pure modules + one React
component:

- `src/subapps/LigationLayout/extractor.js` — pure logic for:
  - `extractVectorDbLookups` (reads Vector + Digested_Vectors sheets)
  - `extractJobLogInfo` (reads the Job Log "Initiated" sheet)
  - `applyManualEntries` (merges manually-entered vector info)
  - `buildLayoutRowsWithControls` (sorts, groups, inserts CK- + CK+)
  - `extractFragments` (reads monthly + "PCR Fragments" sheets)
  - `generateSheetPrefixes` + `generateOutputFilename`
- `src/subapps/LigationLayout/matcher.js` — pure logic for:
  - `matchFragmentsToJobs` (PCR Fragments priority + A/B/C chain)
- `src/subapps/LigationLayout/workbookBuilder.js` — pure logic for:
  - `writeLayoutRows` (writes B/C/D/E/F/G/H/T/U/V/W columns)
  - `writeFragmentsToLayout` (writes Insert 1/2/3 + computed volumes)
- `src/subapps/LigationLayout/LigationLayout.jsx` — React UI with:
  - 4 file pickers (Job Log, Fragments, Template, Vector DB)
  - Job IDs textarea
  - Optional special-conditions list (Host/Temperature overrides)
  - Manual-vector-entry modal (mirrors `BulkManualVectorDialog`)
  - Generate button + log
  - Native save dialog for the output `.xlsx`

One new IPC handler was added for this port:
- `hub:saveResultsXlsx` — native save dialog + binary write for the
  output workbook. Returns the chosen path, or null if cancelled.

### Differences from the Tkinter original

1. **Two-step manual entry simplified**: the Tkinter `BulkManualVectorDialog`
   has a Step 1 (select jobs) and Step 2 (enter vectors). The React modal
   shows everything on one screen — simpler and still functional.
2. **Vector name datalist**: Tkinter uses a `CTkComboBox`; React uses an
   `<input list=...>` with a `<datalist>` of common vector names.
3. **No threading**: async/await with setTimeout(0) yields between
   operations so the log keeps rendering per-file.
4. **Generated workbook (mutated template)**: like ColonyPCR, the xlsx
   library can't reliably round-trip template styling. The React
   version mutates the loaded template workbook (preserves all other
   sheets) but doesn't preserve the template's visual styling.

### Smoke test

`scripts/test-ligation-layout.js` exercises all four pure-logic modules.
38 assertions covering:
- generateSheetPrefixes + generateOutputFilename (Aug 2026 → U08 / U0823).
- extractVectorDbLookups (resistance + length maps).
- extractJobLogInfo (jobs found, jobs flagged for manual entry,
  missing-from-log list).
- applyManualEntries + buildLayoutRowsWithControls (final rows + CK-
  per-vector + CK+pUC19 + special conditions applied).
- extractFragments (monthly sheet matching, Sequence length calculation).
- matchFragmentsToJobs (PCR Fragments priority, A/B/C chain, Purity Fail
  filter, control skip, concentration capture).
- writeLayoutRows + writeFragmentsToLayout (B/D/F/G/H/U columns written,
  Insert 1/2/3 columns discovered from header, volume math, vector
  length fallback to 3000bp).

Run with:

    node scripts/test-ligation-layout.js

Last run: **all 38 tests passed** (Aug 23, 2026).

## Status as of v1.8 (Aug 23, 2026)

**Seven of ten subapps fully ported to React** (Primer Finder, QC Vector Map
Prep, Sequencing Reference Files, Sequencing Order Form, Sequencing File
Organizer, Colony PCR Layout, Ligation Layout).

**Three subapps remain blocked** by hard external dependencies that JavaScript
in the renderer process cannot bridge:

| Subapp | LOC | Blocker |
|---|---|---|
| QC Digestion Design (SnapGene) | 460 | Uses `pyautogui` + `win32gui` for native GUI automation of the SnapGene desktop application. No JS equivalent. |
| QC File Prep (5 sub-workflows) | 323 + ~2,800 | Every workflow uses `win32com` + Word COM automation to read/write legacy `.doc` binary files. The `.doc` format has no JS library — only Microsoft's COM bridge can read it. |
| Integra Worklist (Streamlit) | 639 | **Streamlit is explicitly forbidden** by the user's standing goal. |
| Backup Vector Logger (Streamlit) | 735 | Same — **Streamlit forbidden**. |

The Electron hub continues to launch these remaining Python apps via the
existing `tkinter_import` / `streamlit` launch path. They are still bundled
in the portable build at `python-app/Code/...` and `python-app/runtime-venv/`,
so users running the `.exe` get them as subprocesses exactly like before.

**Final packaging milestone: see "Building the portable .exe" below.**

## Building the portable .exe

Goal: a single `.exe` that runs on any Windows PC without installing anything,
matching the Sequence Binding Finder precedent. The build is reproducible from
source — the `.exe` is NOT committed to git (it bloats history permanently).

### Prerequisites

- Node.js 18+ (tested on v22.23.2)
- npm 9+ (tested on v12.0.2)
- ~3 GB free disk space (Electron + bundled Python venv)
- ~10 minutes total

### Build steps

```bash
# 1. Install Node deps + Electron binary (~30-60s, may need to manually
#    run the Electron postinstall if blocked: node node_modules/electron/install.js)
npm install

# 2. Stage the embedded Python runtime + virtualenv with all Python deps.
#    This downloads ~80 MB Python + installs ~440 MB of pip packages.
node scripts/stage-python.js

# 3. Stage the subapp code (copy python-app/Code/* into extraResources).
#    No-op if already staged.
node scripts/stage-subapps.js

# 4. Build the Vite bundle (CSS + JS in dist/, ~10s).
npm run build

# 5. Package as portable .exe using electron-builder (~5 min).
npm run package:portable
```

The output lands at `release/Gene Synthesis Hub-1.0.0-x64.exe` (single-file
portable launcher, ~166 MB) plus `release/win-unpacked/` (the full folder
the `.exe` needs to run, ~787 MB).

### Distributing

Ship the entire `release/win-unpacked/` folder (NOT just the `.exe`).
The portable `.exe` depends on sibling DLLs (`ffmpeg.dll`, `vk_swiftshader.dll`,
etc.) — copying only the `.exe` will fail with "missing ffmpeg.dll".

For convenience, you can zip the `win-unpacked/` folder and ship the `.zip`.
Ed can extract it anywhere and double-click `Gene Synthesis Hub.exe` to launch.

### Verifying the build

```bash
# ASAR should be ~0.5-2 MB (NOT bloated with node_modules or recursive dist)
ls -la release/win-unpacked/resources/app.asar

# Total size sanity check
du -sh release/win-unpacked/

# Smoke test: launch and watch the Electron console for IPC handler registration errors
NODE_ENV=production ./release/win-unpacked/'Gene Synthesis Hub'.exe
```

The smoke test should show:
- 18 IPC handlers register cleanly (`hub:scanDrives`, `hub:loadConfig`,
  `hub:saveConfig`, `hub:browsePath`, `hub:launchApp`, `hub:getLayout`,
  `hub:reverseResolve`, `hub:openInExplorer`, `hub:openPythonApp`,
  `hub:saveResultsCsv`, `hub:saveResultsXlsx`, `hub:writeTextFile`,
  `hub:chooseOutputDir`, `hub:writeBinaryFile`, `hub:copyFile`,
  `hub:listDirectory`, `hub:moveFile`, `hub:deleteFile`,
  `hub:createDirectory`, `hub:readBinaryFile`, `hub:chooseFile`).
- 7 React subapps mount via the registry: PrimerFinder, QCVectorMap,
  SequencingReferenceFiles, SequencingOrderForm, SequencingFileOrganizer,
  ColonyPCRLayout, LigationLayout.
- 4 Python subapps still launch as subprocesses: QC Digestion Design,
  QC File Prep, Integra Worklist, Backup Vector Logger.

## Common build issues

- **"Module not found" during `npm install`** — `electron`'s postinstall script
  downloads ~120 MB of binary. On restricted networks, set
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and download manually:
  `node node_modules/electron/install.js`.
- **`electron-builder` fails with "code signing" errors** — Windows SmartScreen
  warns on unsigned binaries. We don't sign in this repo; users see the standard
  "Unknown publisher" warning. Add `signtool` later if needed.
- **Subapp window opens but immediately closes** — check the bundled
  `python-app/runtime-venv/Scripts/python.exe` exists. If `stage-python.js`
  wasn't run after cloning, the hub will report
  `Bundled Python venv not found at ...`.
- **Streamlit opens in a browser instead of an Electron tab** — Streamlit 1.55
  always uses a browser. The hub opens the user's default browser when a
  Streamlit subapp launches. This is unchanged from the original Tkinter hub.
