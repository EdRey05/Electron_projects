# Peak Tracer v0

In-house replacement for Nucleics Auto PeakTrace RP. Processes Sanger `.ab1`
chromatograms (spectral deconvolution → baseline → smoothing → re-basecall →
new `.ab1` output) using a fully open-source Python pipeline (Biopython +
NumPy + SciPy + PyWavelets), wrapped in an Electron UI.

## Status

**v0 scaffold only — no Python core yet.** Electron UI is wired to spawn
`python-app/Code/peaktrace_core.py` with all settings as CLI flags, but the
Python script itself doesn't exist yet. The Electron app will show "script
not found" errors until `python-app/` is populated.

## User flow (target)

1. Pick the input folder (the `raw/` subfolder containing post-Seq7 `.ab1`
   files). The app enumerates the `.ab1` files in it.
2. Output folder auto-fills to the parent (matches PeakTrace RP convention).
3. Pick a processing mode (Raw Proportional, Full PeakTrace, or Pass-through).
4. (Optional) Show Advanced and tune smoothing / baseline / basecaller knobs.
5. Click **Run Peak Tracer**. Per-file progress streams live; each result row
   can be expanded to see QC stats.
6. The new `.ab1` files land in the output folder, ready to send to the
   sister company.

## UI integration decision (open)

Three possible delivery paths (tracked in agent folder's SPECS.md §9):
- **A. Standalone Electron app** (this v0)
- **B. Subapp inside `003_Gene_Synthesis_Hub/`** (Electron hub)
- **C. Module inside `BBI_projects/App_hub/`** (legacy Tkinter hub)

The Python core is identical in all three; only the wrapper UI changes.
Ed hasn't decided yet.

## Build

See BUILD.md. Dev loop:

```bash
cd 004_Peak_Tracer
npm install
npm run dev
```

## Python side (TODO)

The following need to land in `python-app/`:

- `python-app/runtime-venv/` — bundled Python venv (created from `requirements.txt` by `scripts/setup_python_app.sh`)
- `python-app/Code/peaktrace_core.py` — CLI entry point (consumes all the CLI flags the Electron main process passes)
- `python-app/Code/peaktrace/` — the Python package implementing the pipeline
- `python-app/requirements.txt` — pinned: biopython, numpy, scipy, pywavelets, abifpy or rohankan/ab1-file-writer

This is the next major chunk of work, separate from the UI scaffold.

## Conventions

Follows the Electron_projects repo conventions (see
`../electron-projects-repo-conventions` skill):
- Folder name `004_Peak_Tracer/` (next sequential slot)
- Single clean commit per version
- Source only — no built artifacts committed
- Per-app `.gitignore` matching `001_FileSync/`
