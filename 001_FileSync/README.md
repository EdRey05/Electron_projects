# FileSync

Self-built bidirectional file sync app. See [PLAN.md](./PLAN.md) for the full development plan.

## Status

**v1 feature-complete + Workspace UX (v0.0.5).** AllwaySync-style flow: pick two folders, choose a direction, Analyze, review the per-file tree, Run.

- ✅ Week 1 — scaffold, walker, SQLite state DB (sql.js), IPC, React + Tailwind shell.
- ✅ Week 2 — differ (11-case three-way merge), dry-run pipeline, `jobs.json` persistence, JobList + JobBuilder + RunView UI.
- ✅ Week 3 — atomic copier, trash module, applier orchestrator, `engine:apply` IPC with progress events, Apply UI.
- ✅ Week 4 — History page, `electron-builder.yml` (NSIS Windows installer).
- ✅ v0.0.5 — **Workspace as the default home**: two folder pickers + direction widget (Mirror →, Mirror ←, Sync ↔) + Analyze + per-row include/exclude tree + Run. One-way mirror modes are stateless; sync mode uses the per-pair state DB. Saved jobs become a secondary screen for repeat workflows.

**89 unit tests passing**, typecheck clean both sides. See [PLAN.md](./PLAN.md) for the full status / what's deferred.

## Dev

```bash
npm install
npm run dev          # opens Electron window with HMR
npm test             # 89 unit tests
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
