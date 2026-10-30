# Portable Windows builds

The supported release target is Windows x64. End users extract the folder ZIP and double-click the application EXE, or run the optional self-extracting portable EXE. They do not install Node, npm, Python, uv, or Tesseract.

## Build one, several, or all apps

Enable Windows Sandbox once and restart Windows. The host needs Windows Sandbox, its `wsb` CLI, and Git. No host dependency installation is performed by these scripts.

From the repository root:

```powershell
# All registered apps, in one disposable build guest
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-tools\Build-Apps.ps1

# A subset (comma-separated works with Windows PowerShell -File)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-tools\Build-Apps.ps1 -Apps 001_FileSync,005_KM_Plotter

# Generate the recipe and Sandbox configuration without starting it
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-tools\Build-Apps.ps1 -Apps 001_FileSync -PrepareOnly
```

Default output: Desktop\App_builds. Override with `-OutputDirectory`. Existing deliverables are preserved; subsequent collisions receive the run ID prefix. Every run exports its source hashes, Git revision/dirty state, logs, result JSON, EXE, folder ZIP, and SHA256 sidecars. A failed app does not prevent later apps from building. The overall command fails if any app failed. The runner stops its owned guest after export, including after timeout; logs survive. It refuses to start while another Sandbox is open.

One Node/npm toolchain and the npm/Electron/packager/Python-download/wheel caches are shared within the batch. Each app still has independent node_modules and a separate complete Python runtime. Nothing is globally installed on the host. Caches disappear with the guest; this intentionally optimizes a batch rather than retaining host toolchains between runs.

## Release contract

Every app has package.json, a committed package-lock.json, and electron-builder.json extending the shared base. App IDs remain stable. The version in package.json is authoritative and must match the root lockfile metadata. Current versions reconcile Hub's previous package metadata with its 2.0 Git release history and graduate Peak's 2.0.0-dev label to 2.0.1.

Common commands run inside the prepared build guest:

| Command | Responsibility |
| --- | --- |
| npm run validate | Validate metadata/locks, main/preload syntax, and app-specific checks |
| npm run build | Compile the frontend/main/preload as appropriate |
| npm run package:portable | Compile and produce a self-extracting portable EXE |
| npm run package:folder | Compile and produce release/win-unpacked |
| npm run test:packaged -- -Executable PATH | Start a clean offline Sandbox smoke test |

Build-Apps orchestrates staging, validation, compilation, and packaging directly. The portable packaging pass also creates win-unpacked, which is zipped without compiling a second time. Folder ZIPs are preferred for Python-heavy apps because a self-extracting EXE can spend substantial time extracting its runtime.

The old stage-python commands and Peak build_runtime.ps1 are compatibility entry points for a complete isolated build. They no longer stage a host-local venv. Use Build-Apps.ps1 directly when building several apps together.

`toolchain.json` pins Node, npm, Electron, and electron-builder. Python and OCR downloads have separate checksum-pinned manifests. These pins preserve the tested baseline; they are not a claim that these are the newest versions. Upgrade the shared toolchain deliberately and rerun all release checks. Frontend versions may differ where app architecture requires them.

Python requirements.txt declares direct dependencies; requirements.lock.txt fixes the full application dependency set. Both are installed together and pip check must pass. Do not generate or update locks during a release build. Build environments use the complete standalone interpreter, not a relocated venv. Import/Tcl probes are repeated after moving the runtime tree with its old location absent.

## Portable data and updates

Packaged apps store Electron data in `data/` and logs in `logs/` beside the outer portable EXE, or beside the app EXE in an extracted folder. Resource files remain read-only. Hub copies its directory defaults into data only on first use, then passes the resolved paths to native tools and managed headless workers. Python is resolved exclusively from the bundled runtime; packaged apps never fall back to system Python or install packages on launch.

Extract to a writable folder. Preserve `data/` when replacing application files. To change the versioned folder name, move the complete folder or copy its data directory into the new version. Do not extract a new release over data from an unrelated app. Old FileSync AppData is not automatically imported: if needed, close FileSync and copy its existing user-data contents into the new portable data directory before first use. Keep a backup when migrating.

Hub's optional legacy .doc conversion still requires Microsoft Word; SnapGene automation requires installed SnapGene. Hub tools render natively and do not start Tk windows or Streamlit servers. Use .docx for the standalone workflow. Network-drive workflows still need their user-provided data locations. OCR includes Tesseract and English trained data. These are application capability limits, not build-machine dependencies.

## Test the actual artifacts

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-tools\Smoke-App.ps1 -App 005_KM_Plotter -Executable "$env:USERPROFILE\Desktop\App_builds\km-plotter-1.0.1-win-x64-folder.zip"
```

Tests run offline in a fresh guest without build tools. The command prints the test directory. Inspect smoke-result.json and screenshot.png, then stop that guest using its ID (`wsb list --raw`, `wsb stop --id ID`). Folder checks launch once, create a portable-data marker, stop the app, move the folder to a path containing spaces, and rerun the app-specific checks from that location. Portable EXEs have a separate smoke run. An artifact is release-validated only when a passing test record matches its SHA256.

For unattended validation of every artifact in a completed batch, use `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-tools\Test-Apps.ps1 -BuildOutput <run-directory>\output`. It runs fresh guests sequentially, stops its owned guest after each result, and writes TEST_RESULTS.json under the test root. Override `-TestRoot` to keep evidence with a particular release.

Checks include FileSync database/copy, Binding XLSX/alignment, Hub native catalog/headless label, GenBank, DOCX/ZIP and OCR processing, Peak Python/CLI plus build-time synthetic AB1 contract tests, and KM fixture analysis/Excel export. Production datasets and every Hub workflow still require user acceptance. The build report must distinguish build success from runtime and acceptance coverage.

## Add another app

1. Create its independent app folder and package.json. Use the toolchain pins and commit a synchronized npm lockfile.
2. Add electron-builder.json extending ../build-tools/electron-builder.base.cjs. Declare its appId, productName, exact compiled files and extraResources. Include build-common/runtime.cjs as in the existing apps. Keep research outputs outside packaging resources; assets/ is reserved for icons and packaging assets.
3. Add an apps.json profile: id, python, pythonImports, tesseract, checks, and source-copy exclusions. There is no fixed app-name allowlist in the batch runner. checks documents the commands included in that app's validate script.
4. Use runtime.cjs before app.whenReady to configure portable data; Python apps use runtime.python. FileSync's compiled TypeScript main implements the same path contract directly. Follow the existing context-isolated preload pattern and expose privileged commands through window.api; the generic smoke check expects that API object.
5. For Python, add direct requirements and a complete exact lock for the pinned Windows Python. Declare import probes in the profile. Bundle templates, DLLs, data, and any tools through explicit resources; do not depend on development-machine paths or runtime pip installs.
6. Add validate/build/package:portable/package:folder/test:packaged commands following an existing app. Add a representative packaged fixture check to Sandbox-Smoke.ps1; an unknown app receives generic renderer/preload checks only.
7. Build and test offline, including relocation and persistence. Update this manual if the app needs an additional capability or exception.

Do not merge all Python dependency sets or node_modules merely to reuse downloads. Separate application environments and shared download caches are intentional.
