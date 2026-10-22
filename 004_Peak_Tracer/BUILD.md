# Portable Windows build

The authoritative workflow is the [shared build manual](../build-tools/README.md).

From the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-tools\Build-Apps.ps1 -Apps 004_Peak_Tracer
```

Add other app IDs separated by commas to build them in the same disposable Sandbox. Omit -Apps to build all registered apps. The host needs Windows Sandbox and Git; it does not need a new Node, npm, Python, or uv installation.

The runner installs locked dependencies in separate app environments, reuses download caches, validates and packages the app, exports the portable EXE and folder ZIP plus checksums/logs to Desktop/App_builds, and discards its guest. Run the shared Test-Apps.ps1 against the completed run/output directory for offline artifact checks.

End users extract the ZIP and double-click the application EXE. Keep the folder together and preserve data/ across updates. The single portable EXE is also available; Python-heavy apps start faster from an extracted folder. See the manual for exact versions, validation coverage, migration, and adding future apps.
