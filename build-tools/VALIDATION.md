# Portable build baseline — 2026-10-22

Branch: dev-std-build, based on main 0cd354f. Final all-app build: 20261022-131357-879-batch. All five apps built in one Windows Sandbox; it was discarded after export. Cold tool setup, dependency staging, validation, and packaging took approximately 10 minutes 24 seconds.

Follow-up demonstration testing found two pre-existing Hub defects that startup checks did not cover: directory saving called the os.EOL string as a function, and six React tools retained Python filenames in their launcher registry. Both were corrected in the Hub-specific commit. Hub was rebuilt using the retained pinned environment, with a new check resolving all seven React routes. Its replacement EXE/folder artifacts both passed fresh offline tests, including directory save/read/restore and folder relocation. The original all-app results remain historical evidence; the follow-up artifact hashes identify the corrected Hub build.

| App | Version | Single portable EXE | Folder ZIP, moved and relaunched |
| --- | --- | --- | --- |
| FileSync | 0.0.7 | passed | passed |
| Sequence Binding Finder | 1.0.1 | passed | passed |
| Gene Synthesis Hub | 2.0.1 | passed | passed |
| Peak Tracer | 2.0.1 | passed | passed |
| KM Plotter | 1.0.1 | passed | passed |

Each artifact was tested in a fresh offline Windows 11 Sandbox with no system Node or Python. Tests match the exact artifact SHA256. Folder tests launch, create a portable-data marker, stop the app, move the entire folder to a path containing spaces, and rerun the checks. Screenshots of all five apps were inspected. All test guests were stopped after exporting evidence.

Build checks:

- Shared portable-data/config contract: 2 tests passed.
- FileSync: TypeScript checks and 135 tests in 13 files passed.
- Hub: all 8 existing verification scripts plus the new React registry/staging contract check passed; full Python lock comparison, pip check, imports, Tcl, relocation, and OCR staging passed.
- Peak: 18 synthetic AB1/evidence tests passed using the locked runtime.
- KM: 17 regression assertions passed against the committed 1,000-row synthetic fixture, including reference medians, subgroup results, and Excel export.
- All apps: synchronized release metadata/locks, main/preload syntax, explicit resource presence, frontend compilation, and packaging passed.

Packaged checks:

- FileSync: renderer/preload, portable user-data path, sql.js WASM database, dry run, real fixture copy, and history API.
- Binding: XLSX fixture loading, perfect-match alignment, workbook-write IPC preserving bytes. The recording harness additionally exercised workbook export with a supplied synthetic save path.
- Hub: bundled libraries/Tk, launcher/theme/templates/databases, persistent configuration path beside the outer EXE, Streamlit server health/start/stop, bundled Tesseract and numeric-image OCR.
- Peak: bundled runtime/imports/CLI and all 18 synthetic AB1/evidence tests against the packaged modules in each format.
- KM: bundled runtime, clinical fixture inspection, survival analysis, and XLSX structure/export in each format.

Host checks: PowerShell parsing, Node syntax, Git whitespace validation, and PrepareOnly recipes for a subset and compatibility entry points passed. Changes to legacy staging wrappers and documentation were checked separately from application packaging; they do not ship in the apps.

Evidence is in Desktop/App_build_standardization: release-validation/runs/20261022-131357-879-batch/output/result.json, tests/TEST_RESULTS.json, per-run logs, screenshots, source manifests, and SHA256 sidecars. This is a dated baseline, not a claim that later edits have passed.

Limits: synthetic fixtures do not certify every scientific or production-data workflow. Hub's company-drive workflows need configured data locations; legacy .doc conversion still needs Microsoft Word, while .docx does not. Existing Peak UI labels displaying literal Unicode escapes remain a cosmetic issue. FileSync's old AppData is not automatically migrated; preserve/copy data as described in the manual. Frontend major versions and scientific algorithms were retained.

## Recorded workflow follow-up

All five packaged apps completed real UI workflows with synthetic inputs. FileSync copied and hash-verified three files; Binding calculated matches and saved a workbook; Hub exported six reference files from three rows; Peak processed three synthetic chromatograms; KM plotted 80 synthetic patients and exported a workbook. MP4s, GIFs, fixture inputs and actual outputs are linked from the repository README. [Media checks and hashes](../demo-data/demo-results.json) record all five successful clips. Native chooser paths were supplied automatically; calculations were not mocked.

Corrected Hub build evidence: Desktop/App_build_standardization/demos/hub-rebuild/result.json and route-source-manifest.jsonl. Fresh offline results: tests-hub-followup/TEST_RESULTS.json. The other eight artifact results remain in tests/TEST_RESULTS.json. BUILD_RESULTS.json combines the current ten delivered artifacts. These replace the historical Hub artifacts from the original batch.
