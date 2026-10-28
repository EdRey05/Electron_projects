# FileSync v1.0.0

FileSync compares and synchronizes two folders locally on Windows. Mirror in either direction or synchronize both ways, review an expandable file tree, and choose actions for individual files, whole folders or the entire plan. Copies receive independent SHA-256 verification before replacement. Live analysis counters, per-operation transfer progress, saved jobs, filters, history and recoverable local trash support recurring backups. The portable app includes its runtime; users do not install Node, npm or Python.

![FileSync v1.0.0 demo](../Images_GIFs_Videos/001_FileSync.gif)

[Watch the 70-second demo](../Images_GIFs_Videos/001_FileSync.mp4) · [Try the synthetic folders](../demo-data/001_FileSync-inputs.zip)

The demo mirrors 1,000 text files per folder through nested batches: 700 unchanged, 300 copies/updates and 200 removals. Analyze is labeled at 1/6 playback speed; Run stays at normal speed. The GIF plays twice as fast as the video. These synthetic Sandbox timings are not an HDD benchmark.

## Use the app

1. Select folders A and B. They must be separate folders; neither may contain the other.
2. Choose **Mirror →**, **Mirror ←**, or **Sync ↔**. In mirror modes, decide whether destination-only files should be deleted.
3. Click **Analyze** and review the proposed copies, deletions and conflicts.
4. Expand folders and adjust actions: Auto, Copy A → B, Copy B → A, Keep both, Keep A, Keep B, Delete on A, Delete on B, or Skip. Folder choices apply to their descendants unless overridden more specifically.
5. Click **Run** and inspect the result. Re-analyze if files changed while reviewing the plan.

Use **Only changes**, path filtering and per-side ignore patterns to focus the table. Save a job for folder pairs you use repeatedly. Optional local trash retains replaced/deleted files until its configured retention expires; disabling it makes deletions permanent.

Four summary cards separate each folder's total scanned files/data from files to copy or update and removals/conflicts. The copy card shows the changed amount against the source total; bidirectional jobs explicitly use combined A + B totals. The full-width table puts explanations in Status without a separate detail pane.

All four cards stay in one row. A successful Run followed by a clean result check turns them green with checkmarks. Remaining differences or transfer errors keep the normal color. Green confirms the filtered size/time comparison, not a checksum scan of unchanged files.

Run identifies copying/verifying, moving to trash or permanent deletion alongside the current path. Its byte total counts copy payload only, excluding removed files, verification reads and backup I/O; action counts advance as files finish. After Run, **Checking results** performs a metadata re-scan. The completion summary and previous totals remain visible until the refreshed totals and remaining differences are ready. This is not a whole-drive checksum validation.

The workspace keeps deleted and replaced versions in `.filesync-trash` for 30 days. Expired runs are cleaned during later transfers, with no background service; without another run they can remain longer. Saved jobs use their configured retention. Manual cleanup frees space but removes those recovery copies.

The workspace, jobs, results and history use a light theme with dark text, readable small labels, distinct status colors and keyboard focus outlines.

Direction buttons have their own colors and are ordered Mirror →, Sync ↔, and ← Mirror. Hover or focus a button for a short explanation; Escape dismisses it. Analyze and Run sit beneath the direction controls, and highlighted analysis cards retain the operation counts without widening the Run button.

## Analyze large drives

Analyze shows an animated activity bar, separate Folder A/B file and folder counters, discovered sizes in TB when appropriate, elapsed time, average discovery rate and the latest matching path. Counts arrive during discovery rather than only after a complete scan. A completed folder is marked separately while the other continues. Subsequent stages identify state loading, comparison and review-table preparation.

The total number of matching files is initially unknown, so the moving bar is **not a percentage**, and no speculative completion time is shown. Sizes describe files discovered through metadata, not file contents read or transferred. A periodic engine heartbeat and a stale-update notice distinguish a responsive engine from an animation alone; a drive waiting on metadata can legitimately yield no new entries for a while. Counts respect the scan's filters.

Once both folder walks finish, the discovery bar fills completely and stops moving while the stage label explains the remaining comparison/table work.

The progress feature does not certify million-file capacity: analysis still retains full indexes/results and builds a full review tree. CPU-heavy comparison/table preparation can delay engine updates, and very large results can exhaust memory or render slowly. This needs separate scale testing and further indexing/table work; it is not solved by an activity indicator.

User acceptance included an A → B mirror with approximately 350,000 files per HDD and analysis under ten minutes. That observation does not establish a maximum capacity or guarantee the same speed on other drives. Automated saved-job filesystem tests cover both mirror directions and bidirectional edit/deletion propagation.

## Transfer integrity

Each actual copy computes a streaming SHA-256 of the source, copies into a temporary sibling file, and independently reads and hashes that temporary copy. Size and checksum must match before replacement. The app requests a file flush, checks for source/destination changes during the transfer, and renames the verified file into place. With trash enabled, the old destination is backed up **after verification**, without first removing the live file. Failed copying, verification or backup leaves that old destination in place.

Detected size/timestamp changes since Analyze prevent a destructive action and are reported in the run result. Transfers using overlapping folders are rejected within the same app process. A cross-volume trash move verifies its copy before deleting the original. FileSync cleans up its own failed-copy temporary file; it does not automatically delete arbitrary user files merely because their names resemble old temporary files. Names ending `.tmp.<pid>.<hex>` are reserved for transfer artifacts and excluded from scans; leftovers after a forced termination may need manual review.

**Limits:** this is per-file verification, not an all-or-nothing folder transaction or a live database snapshot. Analyze uses size and modification time to select changes; it does not checksum files it considers unchanged. Keep source files quiescent, especially databases, virtual disks and other actively written files. Metadata guards cannot detect every concurrent edit, and other programs or separate FileSync instances can still race a final replacement. Disk/controller failures, sudden power loss, remote-filesystem behavior and later modifications are outside a checksum's guarantee. Extra reads for verification and backups increase I/O, especially on network drives. File contents are copied; full NTFS security descriptors, alternate data streams and every filesystem-specific attribute are not promised. Normal Windows permissions and file locks apply.

In mirror mode the selected source wins when size differs or modification times differ by more than the two-second tolerance, even if the source is older. Equal size with timestamps within that tolerance is treated as unchanged without comparing contents.

See [TRANSFER_AUDIT.md](TRANSFER_AUDIT.md) for findings, coverage and remaining boundaries. The v1.0.0 showcase uses disposable synthetic folders; its reproducible recipe is in [the recording guide](../demo-tools/FileSync-recording.md).

## Portable builds and updates

Follow the [shared build manual](../build-tools/README.md). The repository runner installs dependencies and packages apps in Windows Sandbox; end users do not install Node or npm. FileSync itself does not need Python.

From the repository root, when a release build is requested:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-tools\Build-Apps.ps1 -Apps 001_FileSync
```

Extract the folder ZIP into a writable folder and run its EXE, keeping all files together. Alternatively, run the self-extracting portable EXE. Preserve `data/` across updates; logs are under `logs/`. Existing legacy AppData is not automatically migrated; back it up before any manual migration.

## Development and validation

With dependencies already available in an approved development environment:

```powershell
npm run dev
npm run typecheck
npm test
```

The engine uses sql.js for the per-pair state database, with explicit disk flushes. Main-process filesystem work is exposed through a typed, context-isolated preload API.

| Location | Purpose |
| --- | --- |
| `src/main/` | Filesystem engine, IPC and saved jobs |
| `src/preload/` | Typed API bridge |
| `src/renderer/` | React workspace, jobs, results and history |
| `src/shared/` | Types, inventory and action overrides |
| `tests/` | Unit and synthetic filesystem regression tests |

The historical [development plan](PLAN.md) records earlier milestones; current release procedures are in the shared build manual.
