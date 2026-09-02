# Building the portable Windows app

## Prerequisites

- **Node.js 18+** and **npm**.
- **Python 3.11+** (only needed for the local dev loop; production bundles the venv).
- A Windows host for the `.exe` (electron-builder produces Windows artifacts
  on Windows; cross-compiling from Linux/macOS works for some targets but is
  not exercised here).

## First-time setup

```bash
cd 004_Peak_Tracer
npm install
uv venv python-app/runtime-venv --python 3.11
uv pip install --python python-app/runtime-venv/Scripts/python.exe -r python-app/requirements.txt
```

(Or use the bundled `scripts/setup_python_app.sh` once it lands.)

## Dev mode

```bash
npm run dev
```

This runs the Vite dev server (port 5173) and launches Electron pointed at it.
DevTools open in detached mode.

## Production build (Windows)

```bash
npm run build              # bundles React into dist/
npm run package:portable   # produces a portable .exe in release/
```

Outputs (in `release/`):

| File | Description | Size |
|---|---|---|
| `Peak Tracer-0.0.1-x64.exe` | Portable single-exe launcher | ~TBD |
| `win-unpacked/Peak Tracer.exe` | Portable folder launcher | ~TBD |
| `win-unpacked/` | Self-contained portable folder | ~TBD |

The portable build bundles the Python venv under `resources/python-app/`, so
the target machine needs no Python install.

### Distributing

Ship the entire `win-unpacked/` folder plus the `.exe` launcher. The Python
runtime is bundled.

## Python CLI contract

The Electron main process spawns `peaktrace_core.py` with these flags:

```
python peaktrace_core.py
  --input-dir PATH                 # required: folder of .ab1 files
  --output-dir PATH                # required: where to write new .ab1
  --mode {rp,full,passthrough}     # default: rp
  --smoothing-window INT           # default: 5
  --smoothing-order INT            # default: 2
  --baseline-window INT            # default: 400
  --baseline-percentile INT        # default: 10
  --quality-threshold INT          # default: 20
  --min-peak-snr FLOAT             # default: 3.0
  --mixed-base-threshold FLOAT     # default: 0.25
  --filename-suffix STR            # default: _pt
  --max-workers INT                # default: 4
  [--wavelet-sharpening]           # flag, off by default
  [--preserve-metadata]            # flag, on by default
  [--emit-seq]                     # flag, off by default
  [--pass-through-kb-basecall]     # flag, off by default
```

Per-file progress is emitted as JSON lines on stdout (one `{"type":"..."}`
object per event). Plain non-JSON lines are treated as log messages.
