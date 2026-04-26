# 001_FileSync — Development Plan

A self-built free replacement for AllwaySync / GoodSync, scoped to v1.

---

## Status

| Week | Scope                                                  | State        |
|------|--------------------------------------------------------|--------------|
| 1    | Scaffold + walker + state DB                           | ✅ **Done** |
| 2    | Differ + dry-run UI                                    | ✅ **Done** — all 5 steps. Differ (11-case truth table), dry-run pipeline, jobs.json persistence, JobList + JobBuilder + RunView UI. |
| 3    | Copier + trash + atomic writes + conflict UI           | ⏳ Next — **this is the step that makes the app actually sync files**. Until it lands, dry-run is preview-only. |
| 4    | Polish + history view + Windows installer              | Pending      |

**Tests:** 55 passing (19 differ + 9 runner + 7 walker + 6 state-db + 14 jobs-store). Typecheck clean both sides.

### Can I use the app today?

**Preview-only.** You can now create jobs through the UI, dry-run them, and see exactly what would change — but no bytes move yet. The Apply button is intentionally disabled with a "Week 3" label.

What works:
- Create / edit / delete sync jobs via the JobBuilder (folder pickers, filter editor, conflict policy, trash retention, etc.).
- Dry-run any job → live progress → tabbed plan (Copy A→B / Copy B→A / Delete / Conflicts / No-op) with sizes, reasons, and a totals row.
- Job config persisted to `userData/jobs.json` (atomic write); per-job state DB at `userData/jobs/<jobId>.sqlite`.

What doesn't work yet:
- **Apply phase** (copier + trash + atomic writes). This is Week 3.
- **History view** of past runs. Week 4.
- **Per-conflict resolution UI** under the `ask` policy is a tab listing — clicking individual rows to override doesn't decide anything yet because Apply is offline.

Soft blocker: the Electron binary download was 502'd during week 1 install, so `npm run dev` won't start until you retry the CDN or run `node node_modules/electron/install.js` manually. This doesn't affect tests.

**Earliest the app is end-user usable for actual syncing:** after Week 3.

---

## Locked scope (v1)

- **Shell:** Electron desktop app (Windows-first; code kept cross-platform).
- **Sources:** Local disks + mapped network drives only. No SFTP / cloud / WebDAV in v1.
- **Mode:** Two-way bidirectional sync.
- **Triggers:** Manual ("Run now"). No watcher / cron / drive-mount in v1.

---

## 1. Overview & goals

A local-first desktop app that keeps two folders bidirectionally in sync. Single user, personal use. The user picks two folders (any combination of internal disks, USB, or mapped SMB shares), saves the pair as a "job", and clicks Run to reconcile them. Every run is dry-run-first: the app shows what it intends to do, the user clicks Apply.

**Non-goals for v1, explicitly:**

- No multi-user, no auth, no remote control.
- No cloud backends (Google Drive / OneDrive / Dropbox / S3).
- No SFTP / FTP / WebDAV.
- No real-time watcher, scheduler, or drive-mount triggers.
- No encryption-at-rest.
- No versioned history (single-revision trash only).

**Coverage vs. AllwaySync / GoodSync:**

| Feature                          | v1 | Notes                                |
|----------------------------------|----|--------------------------------------|
| Two-way bidirectional sync       | ✅ | Three-way merge with state DB        |
| Filters (include/exclude globs)  | ✅ | gitignore-style                      |
| Conflict resolution policies     | ✅ | newer-wins / rename-both / ask       |
| Dry-run / preview                | ✅ | Default; user must click Apply       |
| Trash (recoverable deletes)      | ✅ | Single-revision per run              |
| Crash-safe / resumable runs      | ✅ | Atomic writes + state DB checkpoints |
| Local + mapped network drives    | ✅ |                                      |
| Real-time watcher                | ❌ | v2                                   |
| Scheduling                       | ❌ | v2                                   |
| SFTP / cloud                     | ❌ | v2+                                  |
| Encryption-at-rest               | ❌ | v2+                                  |

---

## 2. Doability assessment

**Yes — comfortably.** Bidirectional sync against local paths is a solved problem. The engine is roughly 600–1000 lines of TypeScript, plus another ~1500 lines for the Electron shell and React UI. Estimate: **3–4 weeks of focused part-time work** to a functional, installable v1.

What's actually hard (and where the testing budget goes):

- **Bidirectional delete detection** — distinguishing "user deleted on side A" from "side A wasn't walked yet" requires a persisted state DB. Wrong here = silent data loss.
- **Conflict resolution** — both sides edited the same file since the last sync. Default (newer-wins) covers 95% of cases; the other 5% deserve explicit UI.
- **Atomic writes under interruption** — kill the app mid-copy, the destination must either be the old file or the new file, never half. Achieved via `<dest>.tmp.<rand>` + rename.
- **Windows long-path / locked-file handling** — `\\?\` prefix and EBUSY backoff.
- **Large trees (>500k files)** — must stream walks into the differ; can't hold full lists in RAM.

What is **not** hard (despite intuition): hashing speed. SHA-256 in Node's `crypto` streams at 400–600 MB/s on commodity hardware, well above HDD/SSD read rates. Disk I/O dominates.

---

## 3. Architecture

Electron with three execution contexts:

- **Main process** — owns the sync engine, SQLite state DB, file I/O, IPC handlers, app lifecycle. Has full Node.js + OS access.
- **Renderer process** — React + Tailwind UI. Pure presentation. No `fs` access. `nodeIntegration: false`, `contextIsolation: true`.
- **Worker pool** (via `piscina`, inside main) — parallel hashing and stat fan-out. CPU-bound work off the main thread.

**IPC:** typed `ipcMain.handle` / `ipcRenderer.invoke` channels exposed through a `contextBridge` preload script. Renderer never sees raw Node APIs.

```
┌──────────────────┐       ┌──────────────────┐       ┌─────────────────┐
│ Renderer (React) │ ◄───► │ Preload (bridge) │ ◄───► │ Main (Node)     │
│  Tailwind UI     │  IPC  │  typed channels  │  IPC  │  Engine + DB    │
└──────────────────┘       └──────────────────┘       └─────────┬───────┘
                                                                │
                                              ┌─────────────────┼─────────────┐
                                              ▼                 ▼             ▼
                                      ┌──────────────┐  ┌──────────────┐  ┌────────┐
                                      │ piscina pool │  │ better-sqlite│  │  fs    │
                                      │  hash workers│  │   state DB   │  │ (OS)   │
                                      └──────────────┘  └──────────────┘  └────────┘
```

---

## 4. Why no Python sidecar

The user offered Python "if needed for processing efficiency." It isn't, and the cost outweighs the benefit:

- **The bottleneck is disk I/O, not CPU.** SHA-256 in Node's `crypto` streams at ~400–600 MB/s. Consumer SSDs read at ~500–3500 MB/s; mapped SMB shares are slower. Spawning Python won't make the disk faster.
- **Costs of a sidecar:** child process lifecycle management, IPC framing/serialization, packaging two runtimes into the installer (electron-builder + PyInstaller), slower cold start, harder to debug.
- **Reversible decision.** If a real bottleneck appears, the hash function can swap to `hash-wasm` (BLAKE3 via WASM, ~1.5 GB/s, single binary, zero native deps) without rewriting anything else.

---

## 5. Tech stack

Versions pinned at scaffold time; this table records intent, not exact semvers.

| Layer            | Choice                                           | Why                                                          |
|------------------|--------------------------------------------------|--------------------------------------------------------------|
| Shell            | Electron                                         | OS file access, native dialogs, future system tray           |
| Build / dev loop | electron-vite + electron-builder                 | Fast HMR; produces Windows NSIS installer                    |
| Language         | TypeScript                                       | Type safety across IPC boundary                              |
| UI               | React 18                                         | Mature; matches user's prior pattern                         |
| Styling          | Tailwind CSS v4 + shadcn/ui                      | Matches user's prior preference                              |
| UI state         | Zustand                                          | Minimal boilerplate                                          |
| FS walking       | `@nodelib/fs.walk`                               | The engine under fast-glob; async, filterable, streamable    |
| Hashing          | `node:crypto` SHA-256 inside `piscina` workers   | Zero native deps, parallel                                   |
| State DB         | `sql.js` (pure WASM SQLite) — *was better-sqlite3* | **Swapped in week 1.** Node 24 had no better-sqlite3 prebuild and the dev machine has no Visual Studio C++ toolchain. sql.js is in-memory with explicit `flush()` to disk; reversible later if write throughput ever matters. |
| Atomic writes    | `<dest>.tmp.<rand>` + fsync + rename             | Crash-safe                                                   |
| Logging          | `pino` → rotating files in `userData/logs/`      | JSON in prod, pretty in dev                                  |
| Unit tests       | Vitest                                           | Fast, ESM-native                                             |
| E2E tests        | Playwright (Electron mode)                       | Drives the built app                                         |

---

## 6. Data model

One SQLite database **per sync job**, stored at `userData/jobs/<jobId>.sqlite`.

```sql
CREATE TABLE state (
  path           TEXT PRIMARY KEY,   -- relative POSIX path
  side_a_size    INTEGER,
  side_a_mtime   INTEGER,            -- ms since epoch
  side_a_hash    TEXT,               -- nullable; computed lazily on conflict
  side_b_size    INTEGER,
  side_b_mtime   INTEGER,
  side_b_hash    TEXT,
  last_synced_at INTEGER
);

CREATE TABLE run_log (
  id                 INTEGER PRIMARY KEY,
  started_at         INTEGER,
  ended_at           INTEGER,
  files_copied       INTEGER,
  files_deleted      INTEGER,
  conflicts          INTEGER,
  bytes_transferred  INTEGER,
  status             TEXT,           -- 'ok' | 'partial' | 'error'
  error              TEXT
);

CREATE TABLE run_action (
  run_id   INTEGER REFERENCES run_log(id),
  path     TEXT,
  action   TEXT,                     -- 'copy_a_to_b' | 'copy_b_to_a' | 'delete_a' | 'delete_b' | 'conflict'
  bytes    INTEGER,
  ok       INTEGER,
  message  TEXT
);
```

Job catalog lives in `userData/jobs.json` (human-readable, small):

```ts
type Job = {
  id: string;                 // uuid
  name: string;
  sideA: string;              // absolute path
  sideB: string;              // absolute path
  filters: {
    include: string[];        // gitignore-style globs; empty = include all
    exclude: string[];
  };
  onConflict: "newer-wins" | "rename-both" | "ask";
  trash: { enabled: boolean; retainDays: number };
  followSymlinks: boolean;
  preserveTimestamps: boolean;
};
```

---

## 7. Bidirectional sync algorithm

Classic three-way merge — the same model GoodSync uses. For every path in `walk(A) ∪ walk(B) ∪ keys(state)`:

```
a = current state on A     (size, mtime, [hash])
b = current state on B
s = last-known state from DB   (may be absent)

case (a, b, s) of
  (present,   present,   absent)    → first sync: copy newer to other side
  (present,   absent,    absent)    → new on A: copy A → B
  (absent,    present,   absent)    → new on B: copy B → A
  (changed,   unchanged, present)   → propagate A → B
  (unchanged, changed,   present)   → propagate B → A
  (changed,   changed,   present)   → CONFLICT (apply onConflict policy)
  (absent,    unchanged, present)   → deleted on A: delete on B (to trash)
  (unchanged, absent,    present)   → deleted on B: delete on A (to trash)
  (absent,    absent,    present)   → both deleted: drop from state
  (absent,    changed,   present)   → CONFLICT (delete vs edit)
  (changed,   absent,    present)   → CONFLICT (edit vs delete)
```

**"Changed" detection.** `size != s.size || mtime > s.mtime + tolerance(2s)`. On suspicious matches (size and mtime equal but hash unknown), hash both sides and compare.

**Conflict policies.**

- `newer-wins` (default) — keep file with greater mtime; loser goes to trash with suffix `.conflict-<isoTime>`.
- `rename-both` — keep both as `<name>.A.<isoTime><ext>` and `<name>.B.<isoTime><ext>`; originals untouched.
- `ask` — pause the run, surface in UI, user resolves per-row.

**Trash.** Every destructive op moves the target to `<sideRoot>/.filesync-trash/<jobId>/<runTimestamp>/<originalRelPath>`. A retention sweep (`retainDays`) runs at the start of each run.

**Atomicity.** Copies write to `<dest>.tmp.<rand>`, fsync, rename. At run start, any leftover `.tmp.*` files (from a previous interrupted run) are deleted.

**Resumability.** The state DB is updated only after a path successfully reconciles. An interrupted run resumes correctly on retry — already-reconciled paths are no-ops.

---

## 8. Project structure

```
001_FileSync/
├── PLAN.md                         ← this document
├── README.md
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.mjs
├── electron-builder.yml
├── src/
│   ├── main/                       Electron main process
│   │   ├── index.ts                BrowserWindow, app lifecycle, tray
│   │   ├── ipc.ts                  Typed IPC channel registry
│   │   ├── jobs/                   Job CRUD + jobs.json persistence
│   │   ├── engine/
│   │   │   ├── walker.ts           @nodelib/fs.walk wrapper + filters
│   │   │   ├── differ.ts           Three-way merge logic (algorithm above)
│   │   │   ├── hasher.ts           Streaming SHA-256, called from workers
│   │   │   ├── copier.ts           Atomic copy w/ progress events
│   │   │   ├── trash.ts            Move-to-trash + retention sweep
│   │   │   ├── state-db.ts         better-sqlite3 wrapper, migrations
│   │   │   └── runner.ts           Orchestrates a run, emits progress
│   │   └── workers/
│   │       └── hash.worker.ts      piscina worker entry
│   ├── preload/
│   │   └── index.ts                contextBridge, exposes typed API
│   ├── shared/
│   │   └── types.ts                Job, RunProgress, ConflictDecision, etc.
│   └── renderer/                   React + Tailwind UI
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── pages/
│       │   ├── JobList.tsx
│       │   ├── JobBuilder.tsx
│       │   ├── RunView.tsx
│       │   └── History.tsx
│       ├── components/             shadcn/ui re-exports + custom
│       ├── stores/                 Zustand stores
│       └── styles/
└── tests/
    ├── unit/                       differ, trash, state-db (Vitest)
    ├── fixtures/                   sample tree generators
    └── e2e/                        Playwright against built Electron app
```

---

## 9. UI screens

1. **Job list** — table of jobs with name, side A, side B, last run, last status. Buttons: New, Edit, Delete, Run.
2. **Job builder** — two-column form:
   - Side A folder picker + Side B folder picker (native dialog via IPC).
   - Filter editor: include / exclude glob lists (monospace textarea, gitignore semantics).
   - Conflict policy radio (`newer-wins` / `rename-both` / `ask`).
   - Trash toggle + retention days.
   - Preserve-timestamps toggle, follow-symlinks toggle.
   - Save → persists to `jobs.json`. A→B-inside-each-other detection refuses to save.
3. **Run view** — three panes:
   - **Top:** phase indicator (Walking → Diffing → Reconciling), elapsed time, throughput (files/s, MB/s).
   - **Middle:** tabs for `To copy A→B` / `To copy B→A` / `To delete` / `Conflicts`. Each row: relative path, size, reason. Conflict rows have inline radio for per-row resolution overriding the job default.
   - **Bottom:** live log tail.
   - **Dry-run by default** — the run computes the plan and stops. The user clicks **Apply** to execute. This is the single most important safety feature; both AllwaySync and GoodSync got this right and we copy it.
4. **History** — `run_log` table per job; click a row to expand into per-file `run_action` detail for that run.

---

## 10. Milestones

| Week | Deliverable                                            | Definition of done                                                                                            |
|------|--------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| 1 ✅ | Scaffold + walker + state DB                           | **Done.** `npm test` passing, `npm run typecheck` clean, UI demo wired through preload IPC. Electron `dev` blocked only on the CDN-502 binary download (see Risks). |
| 2 ✅ | Differ + dry-run UI                                    | **Done.** All 5 steps. Differ (11-case truth table, 19 tests). Dry-run pipeline (9 integration tests). Jobs persistence in `userData/jobs.json` (14 tests). JobList + JobBuilder + RunView UI with native folder pickers, filter editor, conflict policy radio, tabbed plan view (A→B / B→A / Delete / Conflicts / No-op). 55 unit tests passing total; typecheck clean. |
| 3    | Copier + trash + atomic writes + conflict UI           | Apply phase reconciles two trees end-to-end on local disk; interrupt-and-resume test passes. **First week the app actually syncs.** |
| 4    | Polish, history view, electron-builder Windows installer, README | Installable `.exe`, runs on a fresh Win11 VM; manual smoke list (§12) all green. |

---

## 11. Risks & mitigations

| Risk                                                          | Mitigation                                                                                                    |
|---------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| Bidirectional delete vs edit conflicts (footgun #1)           | Always go through trash, never `unlink` directly; default policy errs on the side of keeping data.            |
| Windows path length > 260                                     | Use `\\?\` prefixed paths in copier; explicit fixture test.                                                    |
| Locked / in-use files                                         | `fs.copyFile` EBUSY → retry with exponential backoff, then mark in `run_log` and continue.                    |
| mtime drift on FAT32 / SMB (2-second resolution)              | Tolerance window of 2s in differ; fall back to hash comparison on ties.                                       |
| State DB corruption                                           | WAL mode, `synchronous=NORMAL`; pre-run `integrity_check`; on failure, rebuild from a fresh full diff (treat next run as first-sync). |
| Large trees (>1M files)                                       | Stream walker output into the differ; never hold full lists in RAM; SQLite for the merge state. Bench at 100k / 500k / 1M file fixtures in week 2. |
| User picks A inside B (or vice versa)                         | Detect at job creation, refuse to save.                                                                       |
| Electron native module rebuild                                | **Mitigated by switching state DB to `sql.js`** (pure WASM, no native build). If `piscina` is added later for hashing and triggers the same problem, fall back to `worker_threads` directly (no native deps).             |
| Electron binary download blocked by CDN 502 at install time   | Hit during week 1. Workaround: `npm install --ignore-scripts`, then `node node_modules/electron/install.js` once the CDN recovers. Documented in README.                                                                  |

---

## 12. Verification

**Unit tests (Vitest).**
- Differ truth table — all 11 cases in §7, each with a constructed `(a, b, s)` triple.
- Trash retention sweep — files older than `retainDays` are removed; newer files retained.
- Atomic copy interruption — kill the writer mid-copy, assert dest is unchanged and `.tmp.*` is the only artifact.
- State DB migrations forward and back.

**Property test.**
- Generate random tree pairs, run sync twice. Second run **must** be a no-op (idempotency invariant).

**E2E (Playwright on built Electron).**
- Create job → dry-run → Apply → assert tree equality on disk.
- Modify both sides → re-run → assert conflict detected and resolved per policy.
- Delete on one side → re-run → assert mirrored to other side and trashed.

**Manual smoke list.**
- Sync 1k small files between two local folders.
- Sync one 5 GB file with mid-run process kill; verify resume.
- Sync to mapped SMB share.
- Conflict resolution UI: pick `newer-wins`, `rename-both`, and `ask` outcomes.
- Restore a file from `.filesync-trash/`.

---

## 13. Future scope (v2+)

Explicitly **not** in v1; listed so we don't paint ourselves into a corner.

- Real-time watcher (`chokidar`) with debounced runs.
- Scheduler (cron expressions); Electron stays in tray.
- Drive-mount triggers (Windows: `WM_DEVICECHANGE`).
- SFTP backend (`ssh2-sftp-client`).
- Cloud backends (Google Drive / OneDrive / Dropbox / S3) — added one provider at a time.
- WebDAV (Nextcloud, etc.).
- Encryption-at-rest for backup destinations.
- Versioned trash (keep N revisions per file).
- Multi-job profiles, import/export job config.
- macOS / Linux installers (code is already cross-platform; just add electron-builder targets).
