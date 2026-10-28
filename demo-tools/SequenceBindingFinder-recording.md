# Sequence Binding Finder v1.2.0 recording

Record the actual validated folder ZIP in a disposable Windows Sandbox. The host needs existing Windows Sandbox and FFmpeg/FFprobe; do not install app dependencies or a new runtime on the host. Use the shared build runner first, then Test-Apps.ps1 for the ZIP and portable EXE offline. Retain artifact hashes with evidence.

## Inputs

`002_Sequence_Binding_Finder/test_assets/` contains the supplied accession-linked FASTAs and deterministic corpus. `npm test` in the build guest prepares the two ignored Excel workbooks. For a host recording recipe, they may also be regenerated with the existing bundled Python/openpyxl runtime and `build_test_assets.py`; no Python installation is required for the portable app. Avoid private sequences.

The 12-reference workbook honestly labels 32-kb genome fragments. The 10-query workbook contains known M13, T3, phiX174, T7, lambda, T4, pUC19, pBR322 and E. coli material, with seeded substitutions and one random negative control. UniVec_Core is downloaded live in the recording guest. A separately labeled 6,100-row database repeats the live records solely for a size/performance test; it is not represented as an NCBI release.

## Run

From the repo root, choose a new output directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\demo-tools\Record-Demos.ps1 -App 002_Sequence_Binding_Finder -Artifact "C:\path\sequence-binding-finder-1.2.0-win-x64-folder.zip" -Output "C:\path\SBF-demo"
```

The entry point dispatches to `Record-SequenceBindingFinderDemo.ps1`, copies the validated ZIP, fixtures and existing FFmpeg into a mapped runner, and launches the network-enabled guest. `Record-SequenceBindingFinder.ps1` controls the release UI through CDP and captures genuine renderer frames with `Capture-Frames.ps1`. Only native file chooser paths are supplied automatically; the actual preload, file reads/writes, worker, engine and cache execute normally. Worker listeners observe real messages without replacing the calculation.

## Visible scenes

1. Introduce the sage two-panel setup and centered analysis strip and default database mode.
2. Paste Q01 (1,200-bp M13 read), load all 12 references, Run: one exact forward hit at database positions 1–1200. Run again to verify no save prompts or exports.
3. Expand the actual alignment. Save XLSX and CSV manually.
4. Search Q07 against the database: pUC19 vector control at 100%.
5. Search Q09: E. coli host-fragment control at 100%.
6. Switch to candidate screening, paste T7's 32-kb fragment and load all 10 queries: Q04 at 95%.
7. Paste lambda's fragment: Q05 at 92.60%, reverse complement; expand alignment.
8. Paste T4's fragment, set 86%: Q06 at 86.56%. Raise to 87% and it disappears.
9. Return to database mode. Fetch current UniVec_Core, showing its actual record count and summary. Search a 300-bp probe taken from a downloaded entry.

Allow several seconds per result for reading. MP4 preserves measured capture timing; GIF previews run at twice the speed. Do not slow a fast calculation artificially or insert simulated progress/results.

## Acceptance after capture

The release run asserts equal input panels, tab semantics and the persistent results/progress placeholders. Every completed Run samples real animation-frame geometry and verifies that the analysis controls and results heading do not shift. The same release process verifies cache reuse; three deterministic live database entries in both orientations; a 300-bp probe against the labeled 6,100-row workbook; Stop discarding partial results; absence of an M13 false positive when its row is removed; native single-record FASTA loading; multi-FASTA paste rejection; and header override. Timings are worker computation in the actual packaged Electron build. Workbook parsing, file dialogs and capture setup are excluded from those engine timings.

Read `recording-result.json`, per-scenario JSON, actual XLSX/CSV exports and recording/encoder logs. Verify the export values against the on-screen M13 result and each other. Check the full MP4 decode, poster and contact sheet before publishing media. A failed acceptance receipt must not replace the repo showcase files.

## Generate repository media

After a passing receipt:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\demo-tools\Publish-SequenceBindingFinderDemo.ps1 -Output "C:\path\SBF-demo\output"
```

This validates duration/codec/decode, generates GIF/contact sheet, replaces only the three 002 showcase assets and regenerates only the 002 entry of `demo-data/demo-results.json` from observed evidence. Other app records remain unchanged. Stage the media, source, guide and manifest; do not commit until requested.

Stop the recording guest by its owned ID (`wsb list --raw`, `wsb stop --id ID`). Evidence and generated test workbooks remain outside the repo. Preserve portable `data/` when deploying an updated test build to Desktop/SBF.

## Scientific scope

This demonstrates targeted ungapped identity checks, not infectious phage diagnosis, contamination abundance, taxonomy, gapped alignment or BLAST significance. UniVec contains vector/adapter segments. The domain reference document was consulted for the host/vector/phage narrative and retained unchanged.
