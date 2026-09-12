# Peak Tracer v1.8 development

Sanger chromatogram processing for post-Seq7 AB1 files, with an Electron interface
and a Python CLI. The current pipeline resolves measured overlapping peaks,
preserves raw acquisition data and inherited KB confidence, and writes coherent
AB1, sequence and provenance outputs.

See [v1.8 validation results](docs/v1.8/VALIDATION.md) for the two-plate comparison,
four diagnostic plots, known limits and next development steps. This is a trace
resolution milestone; longer high-quality basecalling comparable to PeakTrace
remains under development.

## Run the CLI

Use Python with the dependencies in `python-app/requirements.txt`:

```powershell
python python-app/peaktrace_core.py --input-dir 'POST_SEQ7_FOLDER' --output-dir 'FRESH_OUTPUT_FOLDER' --no-preprocess
```

Omit `--no-preprocess` to derive output names from paired naming headers.
Processing never modifies input files. Use a fresh output folder for each run.
Default sequence export is plain text from the computed clear range; use
`--seq-range full` for all calls or `--seq-format abi` for two filename headers.

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
for the existing build workflow. v1.8 has not yet been built or packaged; the
current development milestone is CLI processing and validation.
