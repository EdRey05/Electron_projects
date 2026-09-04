# Building the portable Windows app

## Prerequisites

- **Node.js 18+** and **npm**.
- **uv** (manages Python — install from https://docs.astral.sh/uv/ if you don't have it).
- **Python 3.11** installed via uv (`uv python install 3.11`). The build
  script pulls a real CPython distribution from uv's local cache to populate
  `python-app/runtime/`.

## First-time setup

```bash
cd 004_Peak_Tracer
npm install
```

`npm install` populates `node_modules/`. The first run may print
`npm warn install-scripts electron@... postinstall blocked` — that's the
allowlist blocking Electron's binary download. Fix it:

```bash
node node_modules/electron/install.js
```

Then build the Python runtime (this is the v1.6 fix — without it the `.exe`
silently fails on a clean Windows box because no Python is bundled):

```bash
# Linux/macOS: python-app/scripts/build_runtime.sh
# Windows (PowerShell from repo root):
python-app\scripts\build_runtime.ps1
```

The script:
1. Locates the real CPython 3.11 distribution under
   `%APPDATA%\Roaming\uv\python\cpython-3.11-windows-x86_64-none\`.
2. Wipes `python-app/runtime/` if it exists.
3. Copies `DLLs/`, `include/`, `Lib/`, `libs/` from the CPython dist into
   `python-app/runtime/`.
4. Copies `python.exe`, `python3.dll`, `python311.dll`, `pythonw.exe`,
   `vcruntime140.dll`, `vcruntime140_1.dll` into `python-app/runtime/Scripts/`.
5. OVERWRITES `Lib/site-packages/` with the contents of any working venv
   that has biopython, numpy, scipy installed (the bare CPython has only
   stdlib). Add `_virtualenv.pth` and `_virtualenv.py` from the same venv.
6. ** Deletes any `.pyx` and `.pxd` files** (Cython sources — not needed
   at runtime, but they trigger Windows file-lock failures during
   electron-builder packaging if left in place).
7. ** Deletes any `pyvenv.cfg`** (uv embeds a build-host path here that
   breaks on target machines).

Verify the runtime works before packaging:

```bash
PY="python-app/runtime/Scripts/python.exe"
"$PY" --version
# Expect: Python 3.11.16

"$PY" -c "import sys; print(sys.prefix)"
# Expect: ends with \python-app\runtime  (NOT C:\Users\... or C:\Windows\...)

"$PY" -c "from Bio import SeqIO; import scipy; print('OK')"
# Expect: OK
```

If `sys.prefix` resolves to some unrelated path (a temp directory, the
parent of the runtime, etc.), Python found a stray `Lib/os.py` higher up
the directory tree. Search for strays:

```bash
find . -name "os.py" -path "*/Lib/*" -print
```

## Dev mode

```bash
npm run dev
```

This runs the Vite dev server (port 5173) and launches Electron pointed at
it. DevTools open in detached mode. Hot reload of the renderer; restart
Electron for main process changes.

## Production build (Windows)

```bash
npm run build              # bundles React into dist/
npm run package:portable   # produces a portable .exe in release/
```

`npm run package:portable` takes 3-5 minutes the first time (the runtime
is ~700 MB and electron-builder compresses it). Subsequent runs are faster
because Electron itself is cached.

**If packaging fails with "The process cannot access the file because it
is being used by another process":** orphaned `node` processes from a
previous interrupted run can hold file locks. Kill them and retry:

```bash
tasklist | findstr node.exe
taskkill /PID <pid> /F
rm -rf release
npm run package:portable
```

**The final stage ("building target=portable") can take 10-15 minutes**
while it compresses the entire `win-unpacked/` into the single `.exe`. If
you only need to test the app, the **portable folder** at
`release/win-unpacked/` is already usable — launch
`release/win-unpacked/Peak Tracer.exe` directly.

## Outputs (in `release/`)

| File | Description |
|---|---|
| `Peak Tracer-0.0.1-x64.exe` | Self-extracting portable launcher (~700 MB compressed) |
| `win-unpacked/Peak Tracer.exe` | Portable folder launcher (run this for testing) |
| `win-unpacked/` | Self-contained portable folder (~1.1 GB extracted) |

The portable build bundles the Python venv under
`resources/python-app/runtime/`, so the target machine needs no Python
install.

## Distributing

**Ship the entire `win-unpacked/` folder** for distribution, OR use the
single `.exe` (slower to launch because it self-extracts every time).
Copying only `Peak Tracer.exe` from either fails — Electron binaries
depend on sibling DLLs.

## Verifying the build is correct (sanity check)

After packaging, verify the runtime is fully bundled:

```bash
ls release/win-unpacked/resources/python-app/runtime/Scripts/python.exe
ls release/win-unpacked/resources/python-app/runtime/Lib/os.py
ls release/win-unpacked/resources/python-app/runtime/Lib/site-packages/biopython-*.dist-info
```

All three MUST exist. If `runtime/Lib/os.py` is missing, you're in
"Scenario B" (electron-builder only shipped site-packages/, not the full
stdlib) — re-run `build_runtime.ps1` to fix.

Verify the packaged python runs end-to-end:

```bash
release/win-unpacked/resources/python-app/runtime/Scripts/python.exe \
  -c "import sys; from Bio import SeqIO; print(f'{sys.prefix} OK')"
```

## CLI contract (for ad-hoc invocation outside the GUI)

```bash
release/win-unpacked/resources/python-app/runtime/Scripts/python.exe \
  python-app/peaktrace_core.py \
  --input-dir <folder> \
  --output-dir <folder> \
  [--preprocess | --no-preprocess]   # default: --preprocess
```

Per-file progress is emitted as JSON lines on stdout (one
`{"type":"..."}` object per event). Plain non-JSON lines are treated as
log messages.

## Why no longer a `package:win` target?

The `nsis` installer target builds an `.msi`-style installer that requires
admin privileges to install. The sister team and other internal teams
don't need that — they want a portable app. `package:portable` produces
the portable `.exe` that just runs.

If a future requirement needs an installer, the `package.json` `build.win`
config can re-add the `nsis` target.