# Peak Tracer v2.0.2

> Portable builds follow the [shared build manual](../build-tools/README.md). From the repository root run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-tools\Build-Apps.ps1 -Apps 004_Peak_Tracer`. All dependency installation runs in Windows Sandbox. End users extract the folder ZIP and double-click the EXE; Node and Python are bundled. Preserve `data/` when updating.

**Process Sanger AB1 chromatograms in local batches, with per-read results and quality information.** Select input and output folders, choose preprocessing plus trace processing or processing alone, and follow each read in the run log. The app resolves overlapping measured peaks, preserves raw acquisition evidence and inherited caller quality scores, and writes processed AB1 files, sequence exports and provenance records.

Review base counts, mean and minimum quality, ambiguous calls and reported extensions in one table. Advanced settings expose peak resolution, smoothing and naming controls. Original input files remain unchanged, and the portable Windows folder includes the runtimes needed to work offline. Signal processing does not establish improved sequencing accuracy; quality scores retain the original caller's confidence, and experimental features require validation on representative reads.

Preprocessing checks output names, uses supported companion headers and removes well-ID suffixes. Advanced controls adjust resolution strength, iterations, peak width and smoothing. Sequence exports use the computed clear range by default, and processed AB1 files are reread to verify that calls, positions and quality values match the computed results.

## Demo

The [recording](../Images_GIFs_Videos/004_Peak_Tracer.mp4) processes 68 paired AB1/SEQ reads from Sample 5, plate 2, using **Preprocessing + PT** and the default parameters. It shows folder selection, the complete processing interval and scrolling through the resulting QC table. The copper-and-graphite theme separates the app from the white catalog page while keeping text and controls readable.

Inputs remain unchanged and results go into a separate folder. The real sample files are kept locally and are not included in the repository. This workflow demonstration does not establish better basecalling accuracy. A reproducible offline recorder is available at [Record-PeakTracerDemo.ps1](../demo-tools/Record-PeakTracerDemo.ps1).

See the [v1.9 plan](docs/v1.9/PLAN.md) and [v1.9 results](docs/v1.9/RESULTS.md) for adaptive peak rounding, two-plate comparisons, tuning records and known regressions. The [v1.8 validation](docs/v1.8/VALIDATION.md) remains available as the baseline. This is a trace
resolution milestone; longer high-quality basecalling comparable to PeakTrace
remains under development.

## Run the CLI

v2.0 remains open for development. TraceTuner integration was removed on
15 September 2026; the app retains v1.9 signal processing and inherited Seq7 QVs.
The [consolidated v2.0 working document](docs/v2.0/CURRENT_STATE.md) records the
current implementation, evidence, resource locations and next experiments.
Earlier plans/reports remain historical records, not current scoring instructions.

Use Python with the dependencies in `python-app/requirements.txt`:

```powershell
python python-app/peaktrace_core.py --input-dir 'POST_SEQ7_FOLDER' --output-dir 'FRESH_OUTPUT_FOLDER' --no-preprocess
```

Omit `--no-preprocess` to derive output names from paired naming headers.
Processing never modifies input files. Use a fresh output folder for each run.
Default sequence export is plain text from the computed clear range; use
`--seq-range full` for all calls or `--seq-format abi` for two filename headers.

Add `--write-evidence` for the v2.0 native diagnostic experiment. It writes one
`.evidence.json` per read with original/resolved signal features, strength
sensitivity and isolated same-base pair fits. This is CLI-only, off by default,
and adds computation and disk usage. It does not change the exported signals,
basecalls or inherited QVs. Model preferences are not calibrated probabilities.
See the [current evidence and next steps](docs/v2.0/CURRENT_STATE.md).

`--help` lists supported settings. Resolution is enabled by default; experimental
low-quality substitutions are disabled. Retired v1.7 calling options are rejected.

## Verify

```powershell
python -m unittest discover -s python-app/tests
node --check electron/main.js
node --check electron/parameters.js
```

The reproducible scripts under `python-app/experiments/` compare paired AB1 files,
audit the written outputs, and exercise synthetic peak recovery. Plot generation
additionally requires matplotlib. Dataset paths are supplied explicitly; no
sample data or network services are required by the production processor.

## Electron

The interface and main process share validated advanced defaults. See `BUILD.md`
for historical development details. The supported portable build and validation workflow is now [the shared Sandbox manual](../build-tools/README.md). This packaging release preserves the existing scientific pipeline and its documented experimental limits.
