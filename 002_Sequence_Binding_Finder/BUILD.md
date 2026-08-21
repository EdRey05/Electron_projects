# Building the portable Windows app

## Prerequisites

- **Node.js 18+** and **npm**.
- A Windows host (for the `.exe`). `electron-builder` produces Windows
  artifacts on Windows; cross-compiling from Linux/macOS works for some targets
  but is not exercised here.

## First-time setup

```bash
cd 002_Sequence_Binding_Finder
npm install
```

## Dev mode

```bash
npm run dev
```

This runs the Vite dev server (port 5173) and launches Electron pointed at it.
DevTools open in detached mode.

## Production build (Windows)

```bash
npm run build           # bundles React into dist/
npm run package:win     # produces both NSIS installer and portable folder
```

Outputs (in `release/`):

| File | Description | Size |
|---|---|---|
| `Sequence Binding Finder-1.0.0-x64.exe` | Portable single-exe launcher | ~71 MB |
| `win-unpacked/Sequence Binding Finder.exe` | Portable folder launcher | ~180 MB |
| `win-unpacked/` | Self-contained portable folder | ~268 MB |
| `Sequence Binding Finder Setup 1.0.0 x64.exe` | NSIS installer (when built) | ~115 MB |

Note: the build emits to `release/` (not `dist/`) so the in-progress Electron-build
artifacts don't get recursively packaged.

### Distributing

**Recommended:** ship the entire `win-unpacked/` folder. The `.exe` depends on
sibling DLLs (`ffmpeg.dll`, `vk_swiftshader.dll`, etc.); copying only the `.exe`
fails with "missing ffmpeg.dll".

## Rebuilding from scratch

If `node_modules/`, `dist/`, or `out/` are missing, just re-run `npm install`
and `npm run build` — both are disposable artifacts (gitignored).

## Project layout

```
002_Sequence_Binding_Finder/
├── electron/
│   ├── main.js          # Electron main process + IPC handlers
│   └── preload.js       # contextBridge — exposes window.api
├── src/
│   ├── App.jsx          # The whole React component (single-file)
│   ├── main.jsx         # ReactDOM mount
│   └── styles.css       # Tailwind directives + Google Fonts import
├── index.html           # Vite entry / mount point
├── package.json         # deps + build config (electron-builder via "build" key)
├── vite.config.js       # React + base: "./" for file:// loading
├── tailwind.config.js
└── postcss.config.js
```

## Verifying the build

1. Launch `dist/win-unpacked/Sequence Binding Finder.exe`.
2. Paste a reference sequence in the "Reference sequence" textarea.
3. Drop an `.xlsx` (columns A + B = name, C = sequence) onto the upload zone.
4. Pick a threshold and click **Run analysis**.
5. Confirm a save dialog appears; results are written to the chosen path.
