# FileSync

> Portable builds follow the [shared build manual](../build-tools/README.md). From the repository root run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-tools\Build-Apps.ps1 -Apps 001_FileSync`. All dependency installation runs in Windows Sandbox. End users extract the folder ZIP and double-click the EXE; Node and Python are bundled. Preserve `data/` when updating.

Self-built bidirectional file sync app. See [PLAN.md](./PLAN.md) for the full development plan.

## Status

**AllwaySync-style sync table (v0.0.6).** The Workspace now shows a real
sync table: every file *and* folder on both sides, as an expandable tree
(Explorer-style ▶/▼), with a per-row action dropdown that decides what
happens to that item — for one file, for a whole folder, or for
everything at once.

- ✅ Week 1 — scaffold, walker, SQLite state DB (sql.js), IPC, React + Tailwind shell.
- ✅ Week 2 — differ (11-case three-way merge), dry-run pipeline, `jobs.json` persistence, JobList + JobBuilder + RunView UI.
- ✅ Week 3 — atomic copier, trash module, applier orchestrator, `engine:apply` IPC with progress events, Apply UI.
- ✅ Week 4 — History page, `electron-builder.yml` (NSIS Windows installer).
- ✅ v0.0.5 — **Workspace as the default home**: two folder pickers + direction widget (Mirror →, Mirror ←, Sync ↔) + Analyze + per-row include/exclude tree + Run. One-way mirror modes are stateless; sync mode uses the per-pair state DB. Saved jobs become a secondary screen for repeat workflows.
- ✅ v0.0.6 — **the AllwaySync sync table**. Replaces the include/exclude checkbox with a full action dropdown (Auto / Copy A→B / Copy B→A / Keep both / Keep A / Keep B / Delete on A / Delete on B / Skip). Folder rows apply their action to the whole subtree; an "Apply to all" bar applies one action to everything. New engine pieces: `keep-both` (both versions survive side by side), `deleteExtraneous` toggle (mirror without deleting destination-only files), per-side ignore lists, and Windows `\\?\` long-path support.

**135 unit tests passing**, typecheck clean both sides. See [PLAN.md](./PLAN.md) for the full status / what's deferred.

## The sync table

The screen Allway Sync was remembered for:

```
NAME              A          B          ACTION            STATUS
▼ photos/  (2)    —          —          [Auto (use diff)]  2 items
  ▼ 2024/  (1)    —          —          [Auto (use diff)]  1 item
    a.jpg         12 B       missing    [Auto (use diff)]  new on A
  ▼ 2025/  (1)    —          —          [Auto (use diff)]  1 item
    b.jpg         12 B       missing    [Auto (use diff)]  new on A
readme.md         4 B        missing    [Auto (use diff)]  new on A
```

- **Triangles** expand and collapse folders, like the left panel of Windows
  Explorer.
- **The Action dropdown** picks the sync direction *per item*. A folder's
  action covers its whole subtree; a more specific row wins over the
  folder it sits in.
- **Apply to all** sets one action for every item at once.
- **Only changes** hides rows that are already in sync (on by default).
  Folder counts always reflect the full tree, not the filtered view.
- **Click a row** for a side-by-side detail pane: size and timestamp on
  each side, the differ's reason, and the effective action that will run.

## Dev

```bash
npm install
npm run dev          # opens Electron window with HMR
npm test             # 135 unit tests
npm run typecheck
npm run package:win  # builds dist/FileSync-Setup-<version>.exe (NSIS installer)
```

## Setup notes

**Storage:** uses `sql.js` (pure WASM SQLite) instead of `better-sqlite3`. Pro: zero native deps, works on any Node/Electron without a C++ toolchain. Con: in-memory with explicit `flush()` to disk; a touch slower at write-heavy scale (irrelevant for sync use). The plan originally specified better-sqlite3 — switched after Node 24 prebuilds were unavailable and Visual Studio Build Tools were absent.

**First install on this machine** failed `npm install` because the Electron CDN returned 502 on the binary download. If that happens again, run:

```bash
npm install --ignore-scripts        # installs deps without downloading the Electron binary
# later, when you want to run `npm run dev`:
node node_modules/electron/install.js
```

## Layout

```
src/main/        Electron main process (engine, IPC, fs)
src/preload/     contextBridge — typed API surface
src/renderer/    React + Tailwind UI
src/shared/      Types shared across processes
tests/           Vitest unit tests + tree-builder fixture
```
