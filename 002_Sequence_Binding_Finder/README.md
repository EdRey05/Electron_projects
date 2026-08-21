# Sequence Binding Finder

Local forward / reverse-complement alignment of sequences against a reference.
Drop in an `.xlsx` of candidate sequences, pick an identity threshold, get back
a `.xlsx` of matches with positions, strand, and per-base alignment track.

## User flow
1. Paste a reference nucleotide sequence (ACGT / ACGU) into the "Reference sequence" box.
2. Drop an Excel file onto the upload zone.
   - Column A = name (optional), Column B = name (optional), Column C = sequence.
   - The first row may be a header (`Name`, `Sequence`, …); the app auto-detects it.
3. Pick an identity threshold (80%, 85%, 90%, 95%, 100%).
4. Click **Run analysis**. The app walks every entry and reports forward or
   reverse-complement matches.
5. When the analysis finishes, choose where to save `binding_results.xlsx`.

## Why this exists

Originally a Claude Code web JSX prototype. Wrapped into a portable Windows
Electron app so the lab can use it on any workstation without installing Node,
npm, or any browser tooling. See `BUILD.md` for how to reproduce the portable
`.exe` from this source.
