# Portable Windows build

The authoritative workflow is the [shared build manual](../build-tools/README.md).

From the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-tools\Build-Apps.ps1 -Apps 002_Sequence_Binding_Finder
```

Add other app IDs separated by commas to build them in the same disposable Sandbox. Omit -Apps to build all registered apps. The host needs Windows Sandbox and Git; it does not need a new Node, npm, Python, or uv installation.

The runner installs locked dependencies in separate app environments, reuses download caches, validates and packages the app, exports the portable EXE and folder ZIP plus checksums/logs to Desktop/App_builds, and discards its guest. Run the shared Test-Apps.ps1 against the completed run/output directory for offline artifact checks.

End users extract the ZIP and double-click the application EXE. Keep the folder together and preserve data/ across updates. The single portable EXE is also available; Python-heavy apps start faster from an extracted folder. See the manual for exact versions, validation coverage, migration, and adding future apps.

## Verify v1.2.0

The batch validation invokes `npm test` (the reader/engine/corpus/cache harness). It generates test_assets/*.xlsx from the committed corpus when missing, with SheetJS already in the app lockfile. Python is optional for rebuilding the original accession-derived corpus, never an end-user dependency. Build writes electron/build-info.json inside the guest, then Vite emits the renderer and its worker.

Test both release artifacts offline with Test-Apps.ps1. The 002 check loads a workbook and renders a perfect match in the new default database mode, including after relocation. Run should not open a save dialog. Use both manual export buttons and compare coordinates, identity and sort order with the rows. Native dialog selection is supplied by recording automation; manual placement remains a user acceptance check.

The separate per-app recording run measures real release-worker timings for a 32-kb reference/10 queries, a 1,200-bp probe/12 references, live UniVec_Core and the clearly labeled 6,100-row stress database. It also checks cancellation, FASTA loading, manual exports and NCBI cache reuse. Evidence belongs outside the repo; only the generated demo manifest and showcase media are staged. No build artifacts or generated XLSX workbooks are committed.
