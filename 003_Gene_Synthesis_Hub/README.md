# Gene Synthesis Hub

Modern Electron desktop shell for the **Gene Synthesis Hub** previously distributed as
three `.bat` files plus a Python CustomTkinter GUI. Same workflows, same config files,
same subapps — just a real UI, a real save dialog, and a portable `.exe` folder that
needs no Python install on the target machine.

## What this replaces

The legacy layout under `BBI_projects/App_hub/` had three separate `.bat` launchers:

| Old `.bat`            | Old hub                    | What it did                                   |
| --------------------- | -------------------------- | --------------------------------------------- |
| `Run_Gene_Synthesis_hub.bat`   | `Gene_Synthesis_hub/gene_synthesis_hub.py`   | Tkinter CustomTkinter hub, 8 Tkinter + 2 Streamlit subapps |
| `Run_Other_tools_hub.bat`      | `Other_tools_hub/other_tools_hub.py`          | (covered by this hub if desired later)        |
| `Run_Obsolete_tools_hub.bat`   | `Obsolete_tools_hub/obsolete_tools_hub.py`    | (covered by this hub if desired later)        |

This Electron app is the **Gene Synthesis hub** replacement. It does the same things
the old Tkinter hub did:

- Scans Windows drives for the configured labels (`B8. Gene Synthesis`, `B6. DNA Sequencing`, `Public`).
- Reads `default_directories.ini` to resolve every `[Paths]` entry to an absolute path.
- Shows missing directories in a **Needs attention** tab, present ones in a **Found** tab.
- Lets you edit any path inline, browse to a new one, or "Reveal in Explorer".
- Reverses resolves back to the portable `Label, "sub\path"` form on save.
- Lists every subapp from `app_information.txt` with version, date, status, and
  missing-requirements warnings.
- Launches each subapp with the resolved `--config`, drive mappings, and
  `pass_dir_as_kwarg` / `pass_template_as_kwarg` / `pass_db_as_kwarg` paths.

Plus a few niceties the old Tkinter UI didn't have:

- Dark theme that matches the midnight.json palette.
- App search.
- Per-app "Show wiring" panel that exposes every kwarg the hub will pass.
- Status footer showing the exact python.exe path the hub is using.
- One-click "Open bundled python-app folder" for debugging.

## User flow

1. Launch `Gene Synthesis Hub.exe` (or `npm run dev` during development).
2. The hub scans A–Z for drives with the configured labels. Mapped drives appear
   in the top strip.
3. The left panel shows every `[Paths]` entry. Red = path missing, green = present.
   Click any path to edit, or `...` to browse.
4. Hit **Update directories** to save. The hub writes back to `python-app/default_directories.ini`
   using the original `Label, "sub\path"` form when possible.
5. The right panel lists every subapp. Apps whose `requires` keys are still missing
   show a red warning and the Launch button stays disabled.
6. Click **Launch**. The hub spawns `python-app/runtime-venv/Scripts/python.exe` with
   the right CLI args, in the subapp folder. The subapp opens in its own window.

## Project layout

```
003_Gene_Synthesis_Hub/
├── electron/
│   ├── main.js              # Drive scan, INI parse, subprocess launch (IPC handlers)
│   └── preload.js           # contextBridge — exposes window.api
├── src/
│   ├── App.jsx              # The whole hub UI (React + Tailwind)
│   ├── main.jsx             # ReactDOM mount
│   └── styles.css           # Tailwind directives + Google Fonts
├── scripts/
│   ├── stage-python.js      # Copies portable CPython into python-app/runtime/ + builds venv
│   └── stage-subapps.js     # Refreshes python-app/ from BBI_projects/
├── python-app/              # Subapp source + templates + databases
│   ├── Code/                # 10 subapps (Tkinter + Streamlit)
│   ├── Templates/           # Excel templates (Colony PCR, Ligation, etc.)
│   ├── Databases/           # Vector_database.xlsx
│   ├── default_directories.ini
│   ├── app_information.txt
│   ├── requirements.txt
│   ├── runtime/             # Portable CPython (gitignored, staged)
│   └── runtime-venv/        # venv with all hub deps (gitignored, staged)
├── index.html
├── package.json             # electron-builder config in `build` key
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── .gitignore
├── BUILD.md                 # How to rebuild the portable .exe
└── README.md
```

## What ships in the portable `.exe`

`electron-builder` produces `release/win-unpacked/`, a self-contained folder:

- `Gene Synthesis Hub.exe` — Electron launcher
- `resources/app.asar` — Vite-bundled React UI + Electron main + preload
- `resources/python-app/` — full copy of the staged Python app:
  - `runtime/` (~80 MB) — portable CPython 3.11
  - `runtime-venv/` (~400–600 MB with pandas, numpy, openpyxl, biopython, customtkinter, streamlit, …)
  - `Code/`, `Templates/`, `Databases/`, `default_directories.ini`, `app_information.txt`

Total folder size after a fresh build is ~600–700 MB. The portable `.exe` launcher
(~115 MB) is a separate convenience artifact but the folder is what you actually ship.

## Relationship to the upstream BBI_projects hub

This Electron app **does not modify** anything under `BBI_projects/`. The original
Python hub is untouched. To pull in upstream subapp changes:

```bash
node scripts/stage-subapps.js   # refreshes python-app/ from BBI_projects/
```

To pull in upstream dependency changes:

1. Edit `python-app/requirements.txt`.
2. `node scripts/stage-python.js --no-copy` (rebuilds venv only).

## Why Electron, not "X"

Ed asked us to choose a framework that:
- Is not Tkinter.
- Is not Streamlit.
- Produces a portable `.exe` that runs on any Windows PC with no install.
- Replicates the existing hub workflows.

Electron was the obvious fit because of the **Sequence Binding Finder** precedent —
same `vite + react + electron-builder` stack, same portable `win-unpacked/` folder
distribution model. The alternative paths considered:

| Stack                              | Why not                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| Tauri (Rust + WebView)             | Smaller binaries but custom Rust backend for the hub's main process IPC; more setup work for subapp spawning |
| PyInstaller / cx_Freeze (Python)   | Skips the Electron layer entirely; produces a single .exe but CustomTkinter + Streamlit packaging is fragile and the resulting UI quality is worse |
| Node-only (no Electron)            | No native window chrome; needs a browser wrapper, which is just worse Electron |

## Subapp porting roadmap

This repo only ships the **hub shell**. All 10 subapps still run as Python
subprocesses, exactly as before. The roadmap is to port each subapp to React
one at a time and remove its Python entry from `app_information.txt`. See
`BUILD.md` for the per-subapp migration checklist.

### Ported subapps

| Subapp | Status | Replaces |
|---|---|---|
| **Primer Finder** | ✅ Ported v2.0 [Aug 23, 2026] | `python-app/Code/Primer_finder/primer_finder_app.py` |
| **QC Vector Map Prep** | ✅ Ported v2.0 [Aug 23, 2026] (BioPython workflow only) | `python-app/Code/QC_digestion_design/workflows/vector_map_prep_biopython.py` |
| **Sequencing Reference Files** | ✅ Ported v2.0 [Aug 23, 2026] | `python-app/Code/Sequencing_reference_files/Sequencing_reference_files_app.py` |
| **Sequencing Order Form** | ✅ Ported v5.0 [Aug 23, 2026] | `python-app/Code/Sequencing_order_form/sequencing_order_form_app.py` |
| **Sequencing File Organizer** | ✅ Ported v5.0 [Aug 23, 2026] | `python-app/Code/Sequencing_file_organizer/sequencing_file_organizer_app.py` |
| **Colony PCR Layout** | ✅ Ported v5.0 [Aug 23, 2026] | `python-app/Code/ColonyPCR_layout/ColonyPCR_layout_app.py` |
| **Ligation Layout** | ✅ Ported v5.0 [Aug 23, 2026] | `python-app/Code/Ligation_layout/ligation_layout_app.py` |

### Blocked (launched as Python subprocess from the .exe)

| Subapp | Reason | Run via |
|---|---|---|
| **QC Digestion Design (SnapGene)** | Native GUI automation (`pyautogui` + `win32gui`) | Subprocess |
| **QC File Prep (5 sub-workflows)** | Legacy `.doc` COM automation (`win32com`) | Subprocess |
| **Integra Worklist** | Streamlit forbidden | Subprocess |
| **Backup Vector Logger** | Streamlit forbidden | Subprocess |

## Building the portable .exe

```bash
npm install                  # 30-60s
node scripts/stage-python.js # stages Python runtime + venv (~5-10 min)
node scripts/stage-subapps.js
npm run build                # Vite bundle (~10s)
npm run package:portable     # electron-builder → release/ (~5-10 min)
```

Output:
- `release/Gene Synthesis Hub-1.0.0-x64.exe` — single-file portable launcher (~150 MB)
- `release/win-unpacked/` — full portable folder (~691 MB) the `.exe` depends on

Ship the entire `win-unpacked/` folder (NOT just the `.exe`). See `BUILD.md`
for details and verification steps.

The React component lives at `src/subapps/<Name>/` and is registered in
`src/App.jsx` under `REACT_SUBAPPS`. When `app_information.txt` lists a section
with `category = react_route` and `entry = <Name>.jsx`, the hub mounts the
component in-process instead of spawning `python.exe`.

This is the pattern for all future ports: drop a folder under `src/subapps/`,
add it to `REACT_SUBAPPS`, flip the section in `app_information.txt` to
`category = react_route`, delete the matching `python-app/Code/<x>/` folder.

### Why the SnapGene QC Digestion workflow stays Python

The `[QC Digestion Design]` Python app exposes two workflows via dropdown:
**Vector Map Prep (BioPython)** (now ported as `[QC Vector Map Prep]`) and
**Vector Map Prep (SnapGene)** (remains Python). The SnapGene workflow drives
`pyautogui` to control the proprietary SnapGene desktop app via keyboard/mouse
automation, with `win32gui.GetForegroundWindow()` for focus detection and
`pyautogui.FailSafe` as the abort mechanism. There is no JavaScript equivalent
for OS-level input event injection — that's a native runtime concern, not a
browser one. So `[QC Digestion Design]` (the SnapGene-only legacy entry)
continues to spawn Python.

If you don't use SnapGene automation, you can ignore the `[QC Digestion Design]`
card entirely and use the React `[QC Vector Map Prep]` subapp.

## Build

See [`BUILD.md`](./BUILD.md) for the full reproducible build pipeline.
