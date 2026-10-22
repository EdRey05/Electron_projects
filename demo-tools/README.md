# Reproducible app recordings

Record-Demos.ps1 starts a Windows Sandbox using the already validated portable folder ZIPs. It does not install developer tools on the host. The guest extracts the apps, downloads a checksum-pinned FFmpeg encoder, generates synthetic inputs, and records actual application windows while a CDP-driven test harness operates the UI.

The recording guest needs networking only to obtain FFmpeg. No private or production data is supplied. Capture-Frames.ps1 continuously captures the real renderer, waiting 200 ms between captures and retaining measured timestamps. FFmpeg encodes those frames as H.264 MP4 at 12 fps with the original timing, without audio or OS desktop capture. This works when Windows GDI capture is unavailable in Sandbox. GIF previews show the whole workflow at twice the speed. A small demo caption describes each step. File dialogs are supplied deterministic fixture paths through the Electron main-process debugger; alignment, synchronization, sequence extraction, AB1 processing, survival calculations, and file writes run through the real application code. No simulated result screens are inserted.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\demo-tools\Record-Demos.ps1
```

Default inputs: Desktop/App_build_standardization/release-validation. Override -Artifacts for another validated release. Default output: Desktop/App_build_standardization/demos. The expected filenames are currently pinned to the catalog's validated app versions; update them when recording a newer release.

Inspect results.json, per-step DOM observations, encoder logs, clips, and output files before using a recording publicly. The guest remains available for inspection; stop its owned ID with wsb stop --id ID when finished. Do not treat video creation alone as a passed functional test.

After a successful run, execute Export-Previews.ps1 inside the same guest to verify media metadata and generate GIF previews and review filmstrips. Sandbox-Record.ps1 -Reuse can retry selected -Apps inside the existing guest without downloading tools again. Per-app result receipts preserve successful recordings across retries.

Each workflow asserts an actual result: FileSync destination hashes, Binding's saved workbook and perfect match, Hub's six reference files, Peak's processed AB1 outputs, and KM's generated curve/workbook. Synthetic fixture creation is deterministic. The ZIP linked from the catalog contains the inputs plus actual example outputs.

The repository's Images_GIFs_Videos folder contains MP4 recordings, smaller GIF previews, and PNG posters. Demo-data includes no bundled runtimes or encoder binaries. Existing scientific/production acceptance limits still apply; see build-tools/VALIDATION.md.
