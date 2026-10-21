# Building the portable Windows app

## Prerequisites

- **Node.js 18+** and **npm**.
- A Windows host (for the `.exe`). Cross-compiling from Linux/macOS works for
  some targets but `extraResources` paths assume Windows drive letters.
- **Portable CPython 3.11+** for the bundled runtime. The simplest source is
  **uv**:
  ```bash
  uv python install 3.11
  ```
  This installs `python-build-standalone` to
  `~/AppData/Roaming/uv/python/cpython-3.11.*-windows-x86_64-none/`, which
  `scripts/stage-python.js` then copies into `python-app/runtime/`.
  If you don't have uv, download any python-build-standalone `.zip` from
  <https://github.com/astral-sh/python-build-standalone/releases> and point
  `PYTHON_BUNDLE=...` at the extracted folder when running the staging script.

## First-time setup

```bash
cd 005_KM_Plotter
npm install
node scripts/stage-python.js     # ~2 minutes: copies CPython + builds the venv
```

`stage-python.js` is idempotent: re-running it with the same source refreshes
the runtime/venv. Use `--no-copy` to skip the runtime copy and only reinstall
requirements (faster after editing `python-app/requirements.txt`).

## Dev mode

```bash
npm run dev
```

This runs the Vite dev server (port 5173) and launches Electron pointed at it.
DevTools open in detached mode.

If port 5173 is busy, run the two halves separately on a different port:

```bash
npx vite --port 5199
KM_E2E_TEST=... npx electron .
```

## Production build (Windows)

```bash
npm run build               # bundles React into dist/
npm run package:portable    # produces release/win-unpacked/ + a portable .exe
npm run package:win         # NSIS installer + portable exe
```

Outputs (in `release/`):

| File                                       | Description                  | Size      |
| ------------------------------------------ | ---------------------------- | --------- |
| `KM Plotter-1.0.0-x64.exe`                 | Portable single-exe launcher | ~90 MB    |
| `win-unpacked/KM Plotter.exe`              | Portable folder launcher     | ~150 MB   |
| `win-unpacked/`                            | Self-contained folder        | ~600 MB   |

The `win-unpacked/` folder includes the full `resources/python-app/` (runtime
+ venv + the analysis core). Distribute the whole folder, not just the `.exe`
— the `.exe` depends on sibling files.

## Testing

```bash
# Fast: exercises the bundled runtime, no lifelines needed.
npm run test:python

# Full: compares against real lifelines 0.27.8. Needs a Python with
# lifelines installed (any venv, not the bundled one).
python tests/validate_against_lifelines.py
python tests/validate_pipeline.py
```

### End-to-end test inside Electron

`electron/e2e.js` drives the real IPC handlers (file picker, job protocol,
Excel export, file writing) inside a running Electron instance. The runner
script wraps it and is the easiest way to do this:

```bash
npm run test:e2e              # against release/KM Plotter-1.0.0-x64.exe
npm run test:e2e:unpacked     # against release/win-unpacked/KM Plotter.exe
```

The runner writes the evidence to `release/e2e-evidence/`
(`km_report_final.json` + the exported `.xlsx`) and exits 0 only if every
check passed.

> The packaged app is a **GUI-subsystem** binary, so its stdout never reaches
> a pipe and its exit code is meaningless. The JSON report is the signal —
> which is why the runner polls for the report file rather than trusting the
> process exit status. The `portable` target also unpacks ~15 000 files into
> `%TEMP%` before the app starts, so the first run takes several minutes.

If you drive it by hand, set the environment variables yourself:

```bash
# Windows (cmd)
set KM_E2E_TEST=1
set KM_E2E_REPORT=release\e2e-evidence\km_report_final.json
set KM_E2E_SAVE_PATH=release\e2e-evidence\km_out_final.xlsx
set KM_E2E_PICK_FILES=release\e2e-evidence\km_pick_final.json
npx electron .
```

`KM_E2E_PICK_FILES` must point at a JSON file containing an array of paths;
the picker returns them one at a time and **consumes** the queue, so
re-create the file before every run.

## Packaging notes

- `build.extraResources` copies `python-app/` (core + runtime + venv) into
  `resources/python-app/` of the packaged app.
- The main process resolves Python in this order:
  1. `resources/python-app/runtime-venv/Scripts/python.exe` (packaged)
  2. `resources/python-app/runtime/python.exe` (packaged, no venv)
  3. `python-app/runtime-venv/Scripts/python.exe` (development)
  4. `python-app/runtime/python.exe` (development)
  5. `python` on `PATH` (last resort)

  If the venv is missing at packaging time the app still runs, but it needs
  the dependencies on `PATH` — run `stage-python.js` first.
- `python-app/runtime/` and `python-app/runtime-venv/` are gitignored; they
  are build-host artefacts, not source.
