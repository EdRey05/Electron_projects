# FileSync recording recipe

Use this with `Record-FileSync.ps1`, `New-FileSyncFixture.ps1` and `Capture-Frames.ps1`. The durable session guide is `Task_0001_Electron_standardization/recording_guides/FileSync.md` on the Desktop task archive.

## Story

Record the actual v1.0.0 portable folder build in an offline Windows Sandbox. Paste the two synthetic paths, choose Mirror A → B with destination deletion, Analyze, review totals, collapse and expand folders, reveal shared notes, Run, and finish on four green checked cards.

Each folder starts with 1,000 text files. 700 are identical, 100 reports differ, A has 200 new notes, and B has 200 obsolete notes. Expect 300 copies/updates and 200 removals. Files are grouped under Projects/Shared, Projects/Reports, Fieldwork and Archive, with nested batch folders. Deterministic padded text creates real transfer work. No personal data or production drives are mapped.

The recorder drives actual controls through CDP. It adds only a short caption overlay. It does not mock the preload API, replace results, delay the engine, or fabricate progress. Paths are pasted: native Browse dialogs are not depicted. The result check compares size/time metadata; actual copies are independently checksum-verified by the app. Green cards mean the result check found no remaining differences, not that every unchanged file was rehashed.

## Inputs

The host launcher automates steps 3–6:

```powershell
.\demo-tools\Record-FileSyncDemo.ps1 -Artifact <validated-folder.zip> -Output <new-recording-run>
```

It copies an existing FFmpeg, creates the recipe/configuration, and starts the recording guest. `-PrepareOnly` writes the setup without starting it. Verify the offline test receipt for the chosen ZIP before using this launcher; the launcher checks input hashes but does not run those release tests itself.

1. Build with `build-tools/Build-Apps.ps1 -Apps 001_FileSync` in the shared disposable Sandbox. Use a new output directory/run and preserve source hashes. Do not install build dependencies on the host.
2. Run `build-tools/Test-Apps.ps1 -BuildOutput <run>/output` for fresh offline artifact checks.
3. Create a separate recording run with `runner/` and `output/`. Copy the three scripts above and an existing working FFmpeg executable into `runner/`. This session reused `C:/Windows/System32/ffmpeg.exe`; it is a recording tool, not an application dependency.
4. Put `recording-recipe.json` in `runner/`: `{ "sha256": "HASH_OF_FOLDER_ZIP" }`. Keep the exact build ZIP in a read-only input directory named `filesync-1.0.0-win-x64-folder.zip`. Update the explicit version/name checks in the script for later versions.
5. Use an offline `.wsb`: ZIP directory → `C:/DemoInput` read-only; runner → `C:/DemoRunner` read-only; output → `C:/DemoExport` writable; a separate disposable fixtures directory → `C:/DemoData` writable. Disable clipboard and networking. Logon command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/DemoRunner/Record-FileSync.ps1`.
6. Start only when Sandbox inventory is clear. Record the returned guest ID and stop only that owned guest after reviewing/exporting results. A hidden client is sufficient for renderer capture.

The fixture generator refuses an existing root. Retry in a fresh guest/output directory. Do not reuse partially mirrored folders: that would remove the initial differences from the next recording.

Windows PowerShell 5.1 needs a UTF-8 BOM for scripts containing Unicode captions; preserve the BOM in `Record-FileSync.ps1`. Assign `Invoke-RestMethod` JSON arrays to a variable before piping to `Where-Object`; direct piping can retain the array wrapper and fail to select the renderer. Validate scripts with Windows PowerShell, not only PowerShell 7. Both issues affected the first setup attempt in this session, before an accepted recording.

Sandbox display scaling can make screenshots larger than the emulated viewport. This session captured 1600×1125 at 125% scale. The encoder explicitly scales frames to 1280×900, avoiding the odd-height H.264 failure. If encoding fails after a successful workflow, keep the owned guest and its `C:/DemoFrames` until re-encoding succeeds; do not discard valid frames or rerun against already-synchronized folders.

## Expected checkpoints

| Scene | Check |
| --- | --- |
| Analyze | Four cards in one row; 1,000 files each; 300 copies/updates; 200 removals |
| Review | New files, changed report and obsolete destination files visible |
| All files | 700 unchanged files; nested groups visible |
| Run | Real operations; copy-only byte denominator |
| Result | Four green checkmarks; no remaining differences |
| Disk assertions | 1,000 destination hashes equal A; all 100 old reports and 200 removals retained in trash |

The host-mapped fixture directory adds real filesystem overhead so a 1,000-file scan is easier to see. This is a demo environment, not a local-HDD benchmark. No engine sleeps or fabricated progress are inserted. The capture worker uses a 75 ms interval (actual capture rate may be lower). DOM phase timestamps and backend progress events document how long Analyze, Run and the result check were actually visible. Capture stops after the final scene, before independent hash checks, avoiding a long idle tail.

The script writes `recording-result.json`, per-scene DOM observations, `transfer-evidence.json`, frame timings, an MP4 and a PNG poster. A failed assertion means the take is not accepted even if an MP4 exists. Small fixture transfers may finish quickly; never represent this as an HDD speed benchmark.

## Media QA and staging

Capture is continuous renderer JPEGs with measured timing; encode H.264, 1280×900, 12 fps, silent, `yuv420p`, fast-start MP4. The current 70-second presentation slows only the short Analyze interval to 1/6 speed with a visible label. All remaining footage, including the roughly 14-second Run, stays at normal speed. No engine delays are inserted. Preserve the raw 65.42-second recording alongside the edited clip. Generate a 720px GIF at 5 fps and 2× speed for the existing README preview. Inspect a contact sheet and the initial, plan and final full-size frames. Decode the entire MP4 and GIF with FFmpeg; inspect duration/resolution with FFprobe. Reject blank, truncated or error-state footage.

After success, replace only `Images_GIFs_Videos/001_FileSync.mp4`, `.gif`, `.png`; record hashes and artifact provenance in `001_FileSync.recording.json`. Update the FileSync demo text in the root README. Archive the exact scripts/receipts and build ZIP in Task 0001. Keep runtime files out of Git. Stage the requested source/docs/media; do not commit or publish without the user's instruction.

### Readable Analyze playback

This fixture still analyzed in about 0.54 seconds. Do not insert sleeps into the app. Record at normal speed first. The controller exports phase timestamps, measured frame timings and frame-clock.json. After success, use the host presentation helper:

```powershell
.\demo-tools\Edit-FileSyncDemo.ps1 -Recording <run>/output -Output <edited.mp4>
```

It uses the measured Analyze interval plus 200 ms margins, slows that interval by six, and adds "Analyze - 1/6 speed". It preserves the rest at normal speed and writes an edit receipt with the raw and edited hashes. It needs the existing FFmpeg and Windows Arial font. Keep the exact per-take timing receipt; do not reuse old cut points. For a later take whose scan already lasts long enough, keep normal-speed playback instead. The clock estimate uses frame creation timestamps minus measured request times; inspect the slowed interval visually to verify its boundaries.

The expanded fixture generator casts batch numbers to integers before D2 formatting; Windows PowerShell otherwise rejects a floating-point format specifier. The initial expanded-fixture setup hit this error before filming. Its receipt was preserved and its empty setup folders renamed before retrying; the accepted recording used the corrected generator.