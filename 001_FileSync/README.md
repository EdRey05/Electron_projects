# FileSync

Self-built bidirectional file sync app. See [PLAN.md](./PLAN.md) for the full development plan.

## Status

**Week 1 of 4 — scaffold + walker + state DB.** Complete: Electron shell, walker (`@nodelib/fs.walk`), SQLite state DB (sql.js), IPC plumbing, React + Tailwind UI demo, 13 unit tests passing.

## Dev

```bash
npm install
npm run dev          # opens Electron window with HMR
npm test             # vitest unit tests (13 currently)
npm run typecheck
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
