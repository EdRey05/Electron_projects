# Sequence Binding Finder

Search one nucleotide sequence against a reference database, or screen many candidates against one reference. Version 1.2.0 checks both orientations and either length order using exact, ungapped best-window identity, with explicit coordinates and probe coverage. Inspect expanded alignments, stop a long search, fetch UniVec on demand, and save XLSX or CSV when needed. The portable Windows app runs locally without Node, npm or Python installation; its sage workspace uses two balanced input panels, a centered analysis strip and full-width results.

## Search modes

**Search sequence against a database** is the default. Paste one probe or load a single-record FASTA/TXT, then drop a reference workbook. Every database row is searched for the best forward or reverse-complement hit. Use this for targeted phage, vector or host-background triage.

**Screen candidates against a reference** preserves the original workflow: paste one reference and load a workbook of candidate sequences. Either sequence may be longer; the shorter one is slid across the longer one. Positions explicitly identify the reference/database or probe axis. Reverse-strand probe positions refer to the original probe coordinates.

1. Set an optional sequence name and paste ACGT/ACGU/N sequence only. FASTA headers are rejected in paste; use **Load from .fasta/.txt** for one FASTA record. U becomes T; substantial character stripping and >5% N content produce notices. Guidance is up to 100 kb, not a hard length cutoff.
2. Drop `.xlsx`/`.xls`: columns A and B form each entry's name; column C contains sequence. Header detection is automatic and can be overridden. Rows with fewer than four valid bases are reported and skipped.
3. Choose 50–100% identity with the slider or quick picks. The default is 90%.
4. Run analysis. A worker keeps the interface responsive and supports **Stop**, which discards partial results. Section 03 permanently reserves the progress bar, entry counter and status area so the controls and results heading do not move during a search. Run never saves files or opens a save dialog.
5. Inspect matches, show lower scores, change identity/original ordering, expand the alignment and copy the full sequence. Previews show 30 bases, expanding to 200. Amber marks mismatches; gray marks masked N bases.
6. Export manually with **Save .xlsx…** or **Save .csv…**. Both include all analyzed rows in the selected order; the matches-only checkbox controls visibility. Identity values match the displayed two-decimal values. File names include the date and a sanitized sequence label.

N bases in either aligned sequence are excluded from both the match count and denominator. All-N windows have no identity. Identity is reported separately from probe coverage: a short reference can give 100% identity over only a fraction of a long probe. Forward orientation and earliest positions win exact ties. The XLSX/CSV prefix remains `Name`, `Sequence`, `% Identity with reference`, followed by status, orientation, both coordinate axes, coverage, hit length and masked/compared bases.

## NCBI databases

In database mode, **Fetch UniVec** and **Fetch UniVec_Core** download the official FASTA through Electron's main process. Internet is needed for a new download; loaded workbooks and valid cached snapshots work offline. Cache files live in portable `data/univec_cache/`, expire after seven days, and support **Refresh now**. Failed refreshes explicitly report when an older snapshot is used. The summary gives actual entry count, median length, header categories and refresh age.

**Save as Excel** exports the loaded database. Excel cells are limited: sequences are truncated to 32,000 bases and labeled in column B; the in-memory analysis retains the full FASTA sequence. Result sequence cells use the same 32,000-base cap. Keep FASTA source files when full-length genomes matter. Database sizes change: the live UniVec_Core snapshot on 2026-10-28 contains 3,155 records; the separate 6,100-row benchmark is a test workload, not an NCBI release.

UniVec contains vector/adapter segments, not a comprehensive phage-genome database. This app measures ungapped sequence identity, not binding affinity, infectious contamination, sample abundance, taxonomy or BLAST-equivalent significance. It does not handle gaps, circular wrapping or batch probes in database mode.

For distinguishing candidate vectors such as pET variants, load complete reference sequences in your workbook and inspect regions that distinguish them. A shared backbone can produce equally strong hits to several vectors; a UniVec fragment label does not establish an exact vector identity. The app does not subtract expected backbone/insert sequences or calculate a sample-contamination percentage. Supply nucleotide text or workbook sequences; raw Sanger AB1 traces and NGS FASTQ files are not direct inputs.

## Shortcuts and portable use

Ctrl+R runs/stops, Ctrl+S saves XLSX, Ctrl+O opens a workbook, and Esc resets. Shortcuts are ignored while typing in input controls. Sort choices last only for the session; recent-file/state persistence is deferred. The footer identifies version and build date.

Extract the entire folder ZIP into a writable directory and double-click **Sequence Binding Finder.exe**. Preserve `data/` when updating. The optional portable EXE self-extracts the same app; neither format requires a server or runtime installation.

## Build, tests and demo

Follow [BUILD.md](BUILD.md) and the [shared build manual](../build-tools/README.md). All dependency installation and release packaging run in Windows Sandbox. `npm test` prepares the ignored XLSX fixtures from committed `test_assets/corpus.json` and validates the independent reader, exact identity ladder, masked bases, coordinate axes, deterministic output and NCBI cache behavior. No Python installation is required for this harness.

The [test corpus](test_assets/README_test_assets.md) includes original accession-linked FASTAs, deterministic query recipes and an optional Python regeneration script. Large-genome workbook rows explicitly say they are 32-kb fragments. See the [recording guide](../demo-tools/SequenceBindingFinder-recording.md) for the actual packaged-app demonstration.
