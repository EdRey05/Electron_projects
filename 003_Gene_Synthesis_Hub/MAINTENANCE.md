# Maintaining the Electron adaptation

## Source boundaries

- `python-app/Code`, `Templates`, `Databases`: mirrors of the Gene Synthesis reference hub. `upstream-manifest.json` records SHA256 snapshots (CRLF normalized for source text).
- `src/subapps`: native React tools. Ligation, Colony PCR, Primer Finder, sequencing tools and Integra execute their JavaScript engines locally.
- `python-app/processors` and `worker.py`: headless adapters for labels, BATCH report/OCR, QC map and QC File Prep processing. The original processing functions are reused; Tk widgets and Streamlit are never started.
- `electron/python-jobs.cjs`: managed bundled-Python jobs, logs, native prompt protocol and Stop/close cleanup. No system-Python or runtime-pip fallback.
- `scripts/react-registry.cjs`: maps the eleven canonical upstream entries onto native routes and retains QC reference-path defaults after refresh.

## Update one tool

1. Compare the upstream change and its input/output contract. Read that tool's adapter/native engine and tests before refreshing.
2. Inside the development Sandbox, preview the update:

   `node scripts/stage-subapps.js --app "QC File Prep" --source C:/Reference/Gene_Synthesis_hub`

3. Inspect the plan. Add `--apply` to copy that tool's Code folder. Add `--shared` only when bundled templates/databases also changed. `--all` selects all eleven tools. Directory defaults are retained unless `--defaults` is supplied.
4. The command refuses to replace Code/template files changed since the snapshot. Review local changes before explicitly using `--allow-local-changes`; do not bypass this check blindly. Native UIs, adapters and installed runtime are never copy targets.
5. For headless tools, adjust only their adapter if the upstream contract changed. For JavaScript ports, port the corresponding processing change and extend an input/output parity test. Preserve canonical Work Nos, column meanings and filenames.
6. Run `npm run validate`, `npm run build` and `npm run smoke` in the prepared guest. Use `scripts/rework-check.cjs` for the full development fixture workflow; it needs its documented C:/Control and C:/Export development mappings and copied AB1 fixture. `npm run smoke` uses the real catalog/main/preload and checks all eleven routes without lab data.
7. Build with `build-tools/Build-Apps.ps1`, then run `Test-Apps.ps1` on the completed output. These checks use clean offline guests, actual bundled workers, a relocated folder with spaces, persistent configuration and no installed Node/Python.
8. Record which real network, Word, SnapGene, printer/instrument and production-format checks remain for the user. Commit one reviewable tool change. Release/squash only after user acceptance.

`--source` lets a Sandbox use a read-only mapped reference tree. `--destination` is intended for isolated sync-tool fixtures; normal updates omit it. `--snapshot` records an intentionally reviewed staged source baseline. Neither command installs dependencies.

## Intentional adapter differences

- Native shared INI parsing preserves semicolon-separated kwargs and unmapped labels remain unresolved.
- Workbook value patches retain untouched template XML parts, formulas and external relationships. The ligation-to-colony dimension fix preserves IDs.
- File Organizer uses exclusive, hash-verified copy/move behavior instead of silently overwriting a conflicting destination.
- Integra corrects numeric reaction sorting and retains separate validation rows for blank clone IDs; reference parity is tested for normal combinations.
- QC GenBank supports BioPython 1.86's circular compound feature API, rejects invalid filename/DNA input and protects existing outputs by default.
- QC File Prep works on private copies and exports unique run folders; native dialogs replace Tk state. Native DOCX header adjustment preserves geometry rather than requiring Word.
- BATCH source's dependency-install guard is replaced while loading the worker module, and OCR resolves only the bundled executable. Raw upstream source remains unchanged.

Do not turn missing optional packages into runtime downloads, start a background web server, or detach untracked Python GUI processes as a shortcut.
