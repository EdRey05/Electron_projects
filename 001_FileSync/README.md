# FileSync

Self-built bidirectional file sync app. See [PLAN.md](./PLAN.md) for the full development plan.

## Status

**Week 2 of 4 done. Preview-only UI is live; Apply phase is Week 3.**

- ✅ Week 1 — scaffold, walker (`@nodelib/fs.walk`), SQLite state DB (sql.js), IPC, React + Tailwind shell.
- ✅ Week 2 — differ (full 11-case three-way merge), dry-run pipeline, `userData/jobs.json` persistence, JobList + JobBuilder + RunView UI with tabbed plan view.
- ⏸ Week 3 — copier + trash + atomic writes (the Apply phase that actually moves bytes).
- ⏸ Week 4 — polish, history view, Windows installer.

**55 unit tests passing**, typecheck clean both sides. **You can now create jobs and dry-run them in the UI**, but nothing syncs yet — the Apply button is disabled until Week 3. See [PLAN.md](./PLAN.md) for details.

## Dev

```bash
npm install
npm run dev          # opens Electron window with HMR
npm test             # vitest unit tests (55 currently)
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
