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

The Electron main process spawns `peaktrace_core.py` with these flags. **Defaults match BBI's actual PeakTrace RP 6.961 configuration (captured Aug 24 2026):**

```
python peaktrace_core.py
  --input-dir PATH                   # required: folder of .ab1 files
  --output-dir PATH                  # required: where to write new .ab1

  # Mode
  --mode {rp,full,passthrough}       # default: rp

  # Trace processing (matches PeakTrace RP defaults)
  --smoothing-level INT              # default: 3  (PeakTrace RP "extra smoothing" level)
  --smoothing-order INT              # default: 2
  --baseline-window INT              # default: 400
  --baseline-percentile INT          # default: 10
  [--clean-baseline | --no-clean-baseline]   # default: --clean-baseline (PeakTrace RP default: ON)
  [--apply-peak-resolution]          # default: ON (RP does light peak resolution despite the name)
  [--wavelet-sharpening]             # default: OFF (only for full PeakTrace emulation)
  --skip-shorter-than INT            # default: 500  (PeakTrace RP "skip short/pcr base")
  [--set-abi-limits]                 # default: ON (clamp output values to ABI-spec uint16 range)
  --signal-start-peak {auto,start}   # default: auto

  # Basecaller (matches PeakTrace RP defaults)
  --quality-threshold INT            # default: 20  (PeakTrace RP "good quality threshold")
  --n-base-threshold INT             # default: 5   (PeakTrace RP "n base threshold")
  --mixed-peak-threshold INT         # default: 0   (BBI uses 0% = NO mixed-base calls)
  --q-average-trim-value INT         # default: 9   (PeakTrace RP "q average trim value")
  --q-average-trim-window INT        # default: 40  (PeakTrace RP "q average trim window")
  --good-base-improvement INT        # default: -10 (PeakTrace RP "good base improvement")
  [--trim-3-only | --no-trim-3-only] # default: --trim-3-only (PeakTrace RP "trim 3' end only")

  # Output
  --filename-suffix STR              # default: _pt
  [--preserve-metadata]              # default: ON
  [--emit-seq]                       # default: OFF (PeakTrace emits .seq; BBI deletes them)

  # Parallelism
  --max-workers INT                  # default: 4
```

Per-file progress is emitted as JSON lines on stdout (one `{"type":"..."}`
object per event). Plain non-JSON lines are treated as log messages.
