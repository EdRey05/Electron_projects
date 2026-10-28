# FileSync transfer audit — development changes

Audit began October 27, 2026 on `dev-FS`, created from the current local `main`. Entries below record the successive source checks, requested builds, acceptance feedback and recordings. Statements about staged work, versions and installed products describe each milestone at that time; the release closeout is at the end.

## Scope and conclusion

Reviewed the filesystem pipeline: walking both folders, metadata-based change selection, user action overrides, apply/state updates, temporary-file replacement, trash/retention, and per-action error reporting. FileSync reads source contents and replaces destinations; it does not transform file formats or encode/decode the copied payload.

The previous temporary-file-and-rename design reduced partial overwrites, but was not sufficient evidence of byte integrity. This development update verifies every actual copied payload before replacement and strengthens failure handling. It cannot promise immunity to all hardware faults, concurrent writers, filesystem behavior or application crashes.

## Findings and changes

| Finding | Change |
| --- | --- |
| The copier accepted successful OS copying without comparing contents. | Stream SHA-256 over the source and independently over the temporary copy; require matching size/hash before commit. Hashing is bounded-memory, not whole-file buffering. |
| File contents could change while being copied. | Compare source identity, size, modification time and change time around hashing/copy/backup; reject detected changes. Check destination identity/metadata too before replacement. |
| The old destination moved to trash before its replacement was prepared. | Verify/flush the new copy first, then copy the old destination into verified trash without removing it. Replace the live destination only after that backup succeeds. |
| Cross-volume trash fallback copied and deleted without verification. | Use the same verified copier before unlinking the original. Same-volume trash moves remain renames. |
| Analyzed files could be edited before Run. | Check the analyzed existence/size/mtime of both sides before destructive actions; report stale decisions as errors requiring Analyze again. Legacy programmatic plans without those fields retain compatibility but lack this precondition. |
| Same/nested roots or concurrent jobs could interfere with source data. | Resolve root aliases, reject same/nested folders, and block overlapping active transfers within one app process. Reject lexical absolute/traversal paths in plans and same-file/hard-link copies. |
| Automatic suffix-based cleanup could remove unrelated files or another process's active temp. | Remove automatic sweeping from Apply. Clean only the copier's own failed attempt; exclude reserved temp suffixes from scans and preserve unowned matches. The legacy sweep helper is not called by the transfer path. |
| Reading fresh metadata after a copy could record later edits as the synchronized baseline. | Record the source and staged-destination metadata belonging to the verified copy result. Only successful copies advance that path's state. |

The old destination survives failures before final replacement, including copy errors, mismatching data and backup errors. Errors are surfaced through the existing per-action result/history flow; a run can be partial when some files succeeded. State and filesystem writes are not one transaction.

## Boundaries and tradeoffs

- **Analyze remains metadata-based.** Matching size/mtime can hide a pre-existing content difference, especially within the differ's timestamp tolerance. This update verifies copied files; it does not checksum every unchanged file or certify the whole destination tree.
- **No exclusive snapshot/lock.** Metadata preconditions detect ordinary edits, not every edit with restored/coarse timestamps. Another program or separate FileSync instance can still race the final check/rename or copy/unlink. Pause writers; use application-aware backups for live databases/VM images. Do not treat symlink/junction path checks as a security boundary against hostile concurrent filesystem changes.
- **Per-file atomic replacement depends on the filesystem.** A temp sibling avoids crossing filesystems during replacement and preserves the old destination until ready, but this is not an atomic batch. A requested file flush does not guarantee controller, remote server or parent-directory durability across power loss. Later corruption is not prevented.
- **Extra I/O and disk space.** Reading the source for hashing and the temporary copy for verification adds work; retaining an old destination adds a verified backup copy. Large/network transfers will be slower and need room for temporary and retained versions.
- **Content versus metadata.** Optional timestamps are preserved. Exact replication of ACLs, ownership, alternate data streams, hard-link structure, sparse/compression/encryption attributes and all other filesystem-specific metadata is not implemented or certified by these tests. User permissions, locks, remote shares and disconnected drives still apply.
- **Temporary files after termination.** A forcibly stopped copy can leave `.tmp.<pid>.<hex>` siblings. They are excluded from scans and require manual review if retained. Matching names alone no longer authorize deletion.
- **Recovery and trash.** Trash retention can intentionally remove old backups; disabling trash permits permanent deletions. Keep separate backups for important data. A later database/storage error can occur after some filesystem operations have completed; re-analyze instead of assuming rollback.

## Verification performed without a portable rebuild

- `npm run typecheck`: passed for main/preload/shared/test and renderer TypeScript.
- `npm test`: **157 passed across 14 test files**, including **22 new transfer-integrity/failure regressions**. Existing tests for successful copying, timestamps, trash, diffing, state and UI action logic still pass.
- New cases cover multi-chunk binary data, zero-byte files, same-length corruption, partial writes/disk-full, backup failure, rename failure, retryable errors, source edits, destination edits, same-file/hard-link aliases, corrupt cross-volume trash copies, stale copy/delete plans, root overlap, path traversal, failed-copy state and concurrent transfer guard release.
- Reviewed six source-renderer states in a hidden Electron preview: empty workspace, analyzed table, saved jobs, job editor, history and run view. Synthetic API fixtures served visual review only; actual engine behavior is covered by the filesystem tests. No renderer console errors were captured. Small labels use at least the standard 12px utility size, with dark foregrounds on light surfaces and distinct focus outlines.
- Follow-up source preview checked the three distinct direction colors/order, centered action controls, fixed Run label, 16px hover explanations, keyboard focus/Escape dismissal, and the 900px layout without horizontal page overflow. Analysis cards now share a tinted fill, colored border and stronger values in both workspace and saved-job results. No release artifacts were rebuilt.
- Initial source validation used existing host dependencies and Node 24.22.1/npm 11.19.1; no dependencies were installed. The pinned release environment was subsequently exercised by the folder-only test build below.

The root showcase summary was expanded to balance its adjacent video. The app README now describes current usage, verification and limits without references to other sync products. Version metadata remains `0.0.7` until the user finalizes the next release.

## Requested folder-only test build

Built the staged working tree in a disposable Sandbox using the pinned toolchain. Full validation, including all 157 tests, passed. A temporary copy of the standard runner packaged `--win dir` and exported the unpacked app directly; no delivery ZIP or self-extracting EXE was created, and shared repository build scripts were not changed.

The resulting folder passed a separate fresh offline Sandbox test without system Node/Python: first launch, persistent-data marker, relocation to a path with spaces, renderer/preload, portable data path, sql.js database, real fixture copy and history API. Package and source manifests were verified. All owned guests were stopped.

Replaced `Desktop/FS` with the verified app, preserving and hash-checking 39 existing data/log files. All 74 packaged files were verified after deployment. The previous app is retained under `Desktop/FS_build_work/runs/20261027-180235-608-batch/previous-FS`; that run also holds build logs, source/package manifests, offline receipts/screenshots and `DEPLOYMENT_RESULT.json`. Version remains 0.0.7; this is an uncommitted development test build awaiting user acceptance, not a published release.

## Subsequent live Analyze progress

The user reported multi-minute silent analysis on two approximately 4 TB HDDs with potentially millions of files. The old walker reported nothing until its full callback result arrived. Switched discovery to streamed entries, capped directory-work concurrency at 16, and added throttled per-folder counts/sizes/path updates, per-folder completion, phase reporting and one-second backend heartbeats. Failure stops the sibling stream and clears the heartbeat. The UI subscribes before starting a scan, correlates updates by unique request ID and unsubscribes on completion/error/unmount. Both the workspace and saved-job run view use the same progress widget. Animation respects reduced-motion preference.

The activity bar intentionally has no percentage or invented ETA. Counters distinguish metadata sizes discovered from actual transfer bytes. Elapsed time remains visible independently of backend updates; stale engine updates and long waits for matching entries are identified rather than interpreting animation as proof of progress. Sizes support TB and elapsed time supports hours.

Source type checks and **167 tests across 15 files** passed, including ten progress/heartbeat/failure/format regressions. A hidden source preview using synthetic million-file/TB/hour data verified changing counters, request-ID filtering and subscription cleanup without renderer console errors. This was not a real multi-million-file HDD stress test. Full indexes, synchronous comparison/inventory construction, serialization and the full renderer tree remain scale limits requiring separate work. The initial source-only follow-up left the existing Desktop app unchanged; the subsequently requested build is recorded below.

## Live-progress folder build and replacement

Built the staged runtime/UI source again using the pinned disposable Sandbox toolchain; all 167 tests, type checks and compilation passed. The unpacked folder passed fresh offline checks including actual preload/IPC Analyze progress events, scanning/comparing/inventory/completion phases, matching final counts, real fixture copying, state/history, persistence and relocation. This checks the packaged progress channel on a small fixture, not million-file capacity or new per-file Run progress.

Replaced `Desktop/FS` with this live-progress build and verified all 74 package files plus 39 preserved data/log files. Version remains 0.0.7 and no commit or ZIP was created. Build/test/deployment evidence is under `Desktop/FS_build_work/runs/20261027-201151-015-batch`; `previous-FS` there retains the immediately preceding Desktop app. All owned Sandboxes were stopped. This closeout documentation was updated after packaging; runtime/UI source is unchanged from the verified build inputs.

## HDD acceptance feedback and subsequent source changes

The user subsequently reported approximately 350,000 files per HDD, analysis under ten minutes, correct proposed listings and successful A-to-B mirror copying/deletion. These are user observations, not an automated large-drive benchmark. Reported changed-file counts and executed action counts describe different UI quantities and were not reconstructed from the actual run logs.

Removed the redundant selected-row detail pane and widened Status to show full reasons. Replaced eight compact cards with four descriptive cards: total scanned files/data for each folder, copy/update amount relative to source totals, and removals/conflicts/duration. Sync explicitly labels combined A+B totals. Preserve the completed run summary and pre-run cards during the automatic metadata result check, then show refreshed totals and remaining differences. Disable folder/direction edits during work and invalidate a reviewed plan when those settings change.

Fixed an actual progress accounting defect: the Run byte denominator summed deletion sizes as well as copy payload, while the analysis copy estimate excluded deletions. This plausibly explains a roughly 1.3 GB estimate versus 2.53 GB during Run; the precise original split was not verified. Both views now use the same logical copy-payload calculation, excluding deletion sizes, checksum reads and backup I/O. Progress reports the current action before work starts and labels copying/verifying, moving to trash, permanent deletion and retention cleanup. Counts still advance per completed action, not within each large file.

The automatic post-run scan is now explicitly labeled Checking results. It compares size/time metadata and does not rehash the entire drive. Once both walks complete, the discovery bar reaches full width and stops animating while comparison/inventory stages remain visible. Clarified that mirror source wins for different sizes or modification-time differences beyond two seconds, including an older source; equal-size files within timestamp tolerance are not content-compared. Trash behavior remains unchanged: workspace retention is 30 days, expired entries are swept during later transfers, and no background cleanup runs. Replacements also retain old versions. Without another transfer, retained files may remain longer; manual deletion forfeits recovery copies.

Added real temporary-filesystem workflows for both mirror directions with persisted/reloaded jobs, older-source replacement, destination-only removal, retained trash, exact copy-byte accounting and clean re-analysis. A persisted bidirectional job is tested through initial copying and subsequent edit/deletion propagation. Shared cards, operation labels and completed-discovery UI have source rendering checks. These tests do not certify other modes on 350,000-file drives or constitute full packaged UI acceptance for every job workflow.

Final source validation: type checks and **173 tests across 16 files**. A hidden Electron source preview checked eleven synthetic UI states, including copying, deletion, result checking, completed walks, retained summary/totals and plan invalidation, with no renderer errors. Preview fixtures do not exercise actual disk transfers; filesystem tests above do. Existing host dependencies were reused without installation. These follow-up changes are staged only: no commit, version bump or rebuild. `Desktop/FS` still contains the preceding `20261027-201151-015-batch` build and needs an explicitly requested rebuild to include them.

## Requested HDD-feedback folder build

The user subsequently requested rebuilding Desktop FS. Run `Desktop/FS_build_work/runs/20261027-213214-114-batch` built the staged working tree in the pinned disposable Sandbox. Validation, all 173 tests and compilation passed. Exported the unpacked folder only, without a ZIP or self-extracting delivery EXE.

A fresh network-disabled Sandbox without system Node/Python passed portable-data persistence, relocation to a path with spaces, renderer/preload, database/history, actual copying, destination-only deletion, Analyze progress, current copy/delete action events and copy-only Run byte totals. Its receipt matches folder-manifest SHA256 `7A4B8362D21F4920577B7B924FDF2BE98B5AAA6BBBAE5AD7390385653FDB970E`. This small-fixture smoke test does not certify large-drive acceptance.

Replaced `Desktop/FS`, hash-verifying all 74 packaged files and 41 preserved data/log files. The immediately preceding app is retained in this run's `previous-FS`; logs, manifests, offline receipts and `DEPLOYMENT_RESULT.json` are alongside it. All owned Sandboxes were stopped. Version remains 0.0.7; no commit was made. This documentation entry was added after packaging and does not change the tested runtime source.

## v1.0.0 layout, success state and release build

At the user's request, bumped package and lockfile metadata to 1.0.0. The four summary cards now remain in one row without a responsive two-by-two breakpoint. Shortened labels and progress explanations. Green checkmarks require a completed post-run scan, an OK transfer result and no remaining raw-plan actions beyond noops/state drops; skipped differences and errors must not receive a clean-state badge. Source checks passed: TypeScript and 174 tests across 16 files.

The shared Sandbox runner built both standard delivery formats in `Desktop/FS_build_work/runs/20261027-215822-097-batch`. All 174 tests passed with the pinned toolchain. Both artifacts passed fresh offline checks; the folder ZIP also passed persistence and relocation. ZIP SHA256: `C609A895C81CAC059F77287DD8A57CDE7B8688A2F82EFA1F28A9EBBAD9B4FADA`. Alternative portable EXE SHA256: `3BB16AA8DEB5B35BDAD2D9E910D8F3A2FACEDF94FDAC65D86C4A3D77476F91F4`.

The user had deleted Desktop FS, so the verified ZIP was extracted into a new `Desktop/FS` with 75 packaged files and no previous data/log directories to restore. The same ZIP and its SHA256 sidecar are in `Task_0001_Electron_standardization/artifacts`. This remains staged work on dev-FS without a commit. Subsequent documentation and recording scripts do not modify the packaged runtime.

The v1.0.0 packaged app was recorded in a separate offline Sandbox using ten synthetic files per folder, seven identical. Real UI actions produced three copies/updates, two removals, matching destination hashes, retained original report/removal hashes in trash and four green checked cards after the metadata result check. The accepted take is `Desktop/FS_build_work/recordings/20261027-FileSync-1.0.0-take2`; runtime source/package hashes still match the build manifest. Replaced the FileSync MP4/GIF/poster and added the recording receipt plus reusable initial fixture ZIP. The 35.83-second H.264 MP4 is 1280×900 at 12 fps, silent, with original timing; the GIF is 2× speed. Full media decoding and contact-sheet/full-size visual review passed. Script compatibility and DPI-encoding fixes are documented in `demo-tools/FileSync-recording.md`; the recording does not simulate engine results or certify HDD speed. The desktop task's `recording_guides` folder holds the durable guide and scripts. No commit or publication was performed.

## Expanded recording requested after review

Replaced that short showcase with a 70-second nested-folder demo using the same verified v1.0.0 build. No app source or delivery artifact changed. The new fixture has 1,000 text files per side: 700 identical, 100 changed reports, 200 new source notes and 200 obsolete destination notes, grouped under Projects/Shared, Projects/Reports, Fieldwork and Archive. Sandbox-mapped disposable folders add real filesystem overhead. UI automation expands/collapses batches and shows the real Run progress. All 1,000 destination hashes and all 300 old-version/removal recovery hashes passed; 500 actions completed with copy-only byte accounting and a clean checked result.

Accepted recording: `Desktop/FS_build_work/recordings/20261027-FileSync-1.0.0-take3-tree`. DOM phase measurements show Analyze about 0.54 seconds and Run about 14.04 seconds. Preserve the 65.42-second real-time raw recording; the 70-second presentation slows only Analyze to visibly labeled 1/6 speed. No fake engine results, engine delays or omitted workflow steps. GIF is 2× the edited MP4. Initial expanded-fixture setup failed on floating-point batch formatting before capture; the corrected integer formatting and receipt are preserved. Full decoding, contact-sheet review and full-size Analyze/tree/Run/final frame checks passed. Updated the fixture ZIP, recording receipt, showcase text and durable recording guides. This remains staged without a commit or rebuild; timings are not a local-HDD benchmark.

## v1.0.0 release closeout

The user approved one release commit containing all accumulated source, tests, documentation, fixtures and replacement media. Both READMEs now describe verified copying, live discovery and transfer progress, metadata result checking, retention, portable use and the expanded demo. Runtime/configuration hashes match the already tested v1.0.0 build; final changes affect documentation and recording provenance only. Validation evidence remains the pinned build's 174 passing tests, both fresh offline artifact checks, and the accepted 1,000-file recording with independent output/recovery hashes. This closeout does not assert an additional rebuild, push, merge or publication.
