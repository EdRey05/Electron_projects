# Building the portable Windows app

## Prerequisites

- **Node.js 18+** and **npm**.
- **uv** (manages Python — install from https://docs.astral.sh/uv/ if you don't have it).
- **Python 3.11** installed via uv (`uv python install 3.11`). The build
  script pulls a real CPython distribution from uv's local cache to populate
  `python-app/runtime/`.

## Version + output naming

`package.json` version becomes the artifact suffix:

| Version in `package.json` | Portable launcher name        | Folder name           |
|---------------------------|-------------------------------|-----------------------|
| `1.6.0`                   | `Peak Tracer-1.6.0-x64.exe`   | `win-unpacked/`       |

**Update the version in `package.json` before running `package:portable`.**
The version number is how the recipient distinguishes builds.

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
# Windows (PowerShell from repo root):
python-app\scripts\build_runtime.ps1
```

The script:

1. Locates the real CPython 3.11 distribution under
   `%APPDATA%\Roaming\uv\python\cpython-3.11-windows-x86_64-none\`.
2. Creates a **dedicated** slim venv in `%TEMP%\peak-tracer-build-venv-xxxx\`.
   Do NOT point this at an existing venv (e.g. `hermes-agent/venv`) — that
   one has 200+ unrelated packages (googleapiclient, onnxruntime, etc.) and
   bloats the runtime from ~155 MB to ~787 MB.
3. Installs ONLY what peak-tracer needs: `biopython`, `numpy`, `scipy`
   (from `python-app/requirements.txt`) plus `openpyxl` (used by `xlsx.py`).
4. Wipes `python-app/runtime/` and copies the slim venv into it.
5. Strips `*.pyx` / `*.pxd` Cython sources (cause Windows file-lock failures
   during electron-builder packaging).
6. Strips `__pycache__` directories.
7. Rewrites `pyvenv.cfg` so `sys.prefix` resolves to the runtime itself
   (not the temp build venv).

**Expected runtime size: ~190 MB.** If yours is significantly larger, you
copied from a polluted source venv (one with hundreds of unrelated packages)
or you skipped the stdlib merge — the runtime would then fail with
`ModuleNotFoundError: No module named 'encodings'`. Rebuild with the
script and check that `runtime/Lib/os.py` exists.

Verify the runtime works before packaging:

```bash
PY="python-app/runtime/Scripts/python.exe"
"$PY" --version
# Expect: Python 3.11.16

"$PY" -c "import sys; print(sys.prefix)"
# Expect: ends with \python-app\runtime  (NOT C:\Users\... or C:\Windows\...)

"$PY" -c "from Bio import SeqIO; import scipy, numpy, openpyxl; print('OK')"
# Expect: OK
```

If `sys.prefix` resolves to some unrelated path (a temp directory, the
parent of the runtime, etc.), the `pyvenv.cfg` rewrite didn't take effect
or a stray `Lib/os.py` exists higher up. Search for strays:

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

`npm run package:portable` takes 2-4 minutes with a 155 MB runtime
(recently shrunk from ~787 MB — see "Why so small now" below). The final
"building target=portable" stage compresses the entire `win-unpacked/`
folder into the single-file `.exe` and can take 5-10 minutes depending on
disk speed.

**If packaging fails with "The process cannot access the file because it
is being used by another process":** orphaned `node` processes from a
previous interrupted run can hold file locks. Kill them and retry:

```bash
tasklist | findstr node.exe
taskkill /PID <pid> /F
rm -rf release
npm run package:portable
```

**If you only need to test the app**, the **portable folder** at
`release/win-unpacked/` is already usable once `npm run build` and the
electron-builder source-archive stage finishes — launch
`release/win-unpacked/Peak Tracer.exe` directly. The final self-extracting
compression stage is optional.

## Outputs (in `release/`)

| File                                       | Description                                  |
|--------------------------------------------|----------------------------------------------|
| `Peak Tracer-1.6.0-x64.exe`                | Self-extracting portable launcher (~80 MB compressed) |
| `win-unpacked/Peak Tracer.exe`             | Portable folder launcher (run this for testing)        |
| `win-unpacked/`                            | Self-contained portable folder (~155 MB extracted)    |

`win-unpacked/resources/python-app/runtime/` is the bundled Python — the
target machine needs no Python install.

## Distributing

**Ship the entire `win-unpacked/` folder** for distribution (recommended —
faster launch, no self-extraction), OR use the single `.exe`
(slower to launch because it self-extracts every time). Copying only
`Peak Tracer.exe` from either fails — Electron binaries depend on sibling
DLLs.

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

## Why so small now (vs v1.5's 787 MB runtime)

The v1.5 build accidentally populated `python-app/runtime/Lib/site-packages/`
from the author's local `hermes-agent/venv`, which had 308 packages
including googleapiclient (93 MB), onnxruntime (39 MB), ctranslate2 (60 MB),
av.libs (62 MB), nemo_relay, botocore, PIL, etc. Peak Tracer only needs
4: `biopython`, `numpy`, `scipy`, `openpyxl`.

The `build_runtime.ps1` script now creates a **dedicated** slim venv with
only those 4 packages, giving a ~5x smaller runtime (155 MB vs 787 MB).

If your runtime is > 250 MB, you copied from a polluted source. Re-run
the script — it does the right thing by default.

## Locked-version workflow (the reproducible recipe)

To ship a new version:

1. Make your code changes on `dev-peak-tracer`, commit each task.
3. Bump `version` in `package.json` (e.g. `1.6.0` → `1.7.0`).
4. Run `python-app\scripts\build_runtime.ps1` to refresh the runtime (only
   needed if `python-app/requirements.txt` changed; otherwise the existing
   runtime is fine).
5. Commit: `git add package.json && git commit -m "Peak Tracer app v1.7.0 [Sep X, 2026]"`.
6. Run `npm run build` to bundle React.
7. Run `npm run package:portable`. If it hangs on the final stage, kill it
   and ship the `win-unpacked/` folder instead.
8. Update `docs/v1.7/` if it was a user-visible change.
9. Zip `release/win-unpacked/` and ship.

To verify a packaged build without running the app, run the
"Verifying the build is correct" checks above.

## Troubleshooting

| Symptom                                              | Cause / Fix                                |
|------------------------------------------------------|--------------------------------------------|
| App launches but says "spawn python ENOENT"          | `python-app/runtime/` not bundled. Re-run `build_runtime.ps1`. |
| App launches but says "ModuleNotFoundError: Bio"     | Wrong runtime was bundled (no site-packages). Same fix. |
| `sys.prefix` resolves to a temp dir                  | `pyvenv.cfg` rewrite didn't happen. Rebuild with `build_runtime.ps1`. |
| Packaging hangs on "building target=portable"        | The 5-10 min compression stage. Wait, or kill and ship `win-unpacked/`. |
| `Peak Tracer-0.0.1-x64.exe` shows up                 | Version in `package.json` is `0.0.1`. Bump it. |
| `runtime/` is > 250 MB                                | Source venv had extra packages. Re-run `build_runtime.ps1`. |