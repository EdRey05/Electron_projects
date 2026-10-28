# Sequence Binding Finder — demo / test assets

Regenerated: 2026-10-28 (ET). Builder: `build_test_assets.py` (rerun it to rebuild after FASTA refetch).
All reference sequences are real NCBI records; one row (Q10) is an intentional synthetic negative control.

## File formats (match the app's parser)
- Column A = Name, column B = secondary/provenance, column C = sequence. Header row is auto-detected; safe to leave it.
- `reference_phage_database.xlsx` = reference candidates (copy a row's sequence into the app's Reference box).
- `test_query_assemblies.xlsx` = queries (drop onto the file dropzone).

## Reference panel

| Name | Source | Sequence stored |
|---|---|---|
| Enterobacteria phage T7 | RefSeq NC_001604.1 | truncated 32,000 bp (Excel cell limit) (32,000 bp) |
| Enterobacteria phage T3 | RefSeq NC_003298.1 | truncated 32,000 bp (Excel cell limit) (32,000 bp) |
| Enterobacteria phage T4 | RefSeq NC_000866.4 | truncated 32,000 bp (Excel cell limit) (32,000 bp) |
| Enterobacteria phage M13 | RefSeq NC_074765.1 | full (6,407 bp) |
| Escherichia phage phiX174 | RefSeq NC_001422.1 | full (5,386 bp) |
| Enterobacteria phage lambda | RefSeq NC_001416.1 | truncated 32,000 bp (Excel cell limit) (32,000 bp) |
| Salmonella phage P22 | RefSeq NC_002371.2 | truncated 32,000 bp (Excel cell limit) (32,000 bp) |
| Enterobacteria phage P1 | RefSeq NC_005856.1 | truncated 32,000 bp (Excel cell limit) (32,000 bp) |
| Enterobacterio phage MS2 | RefSeq NC_001417.1 | full (3,569 bp) |
| Cloning vector pBR322 | GenBank J01749.1 | full (4,361 bp) |
| Cloning vector pUC19 | GenBank M77789.2 | full (2,686 bp) |
| E. coli K-12 MG1655 (lacZ start region) | RefSeq NC_000913.3:3653047-3654247 | full (1,201 bp) |

Raw GenBank/RefSeq FASTA kept in `fasta_raw/` (source of truth for regeneration).

## Query panel (expected outcomes)

| Query | What it is | Expected best behavior |
|---|---|---|
| Q01-M13-contig-1200bp | M13 1-1200, no mutations (100% expected) | 1,200 bp in file |
| Q02-T3-contig-900bp | T3 8000-8900, no mutations (100% expected; cross-test vs other refs) | 900 bp in file |
| Q03-phiX174-diverged-800bp | phiX174 2000-2800, ~2% substitutions (~98% expected) | 800 bp in file |
| Q04-T7-diverged-800bp | T7 4000-4800, ~5% substitutions (~95% expected) | 800 bp in file |
| Q05-lambda-RC-diverged-1000bp | lambda 10000-11000, reverse complement, ~8% substitutions (~92% expected; tests revcomp) | 1,000 bp in file |
| Q06-T4-highly-diverged-900bp | T4 30000-30900, ~13% substitutions (~87% expected; below default 90% threshold) | 900 bp in file |
| Q07-pUC19-vector-contig-1000bp | pUC19 1-1000, no mutations (vector-contamination positive control) | 1,000 bp in file |
| Q08-pBR322-vector-diverged-800bp | pBR322 1000-1800, ~3% substitutions (~97% expected) | 800 bp in file |
| Q09-Ecoli-host-read-1200bp | E. coli MG1655 3653047-3654247, no mutations (host-background control) | 1,201 bp in file |
| Q10-synthetic-negative-700bp | random AC GT sequence, seed 42 (no-match control; the only synthetic row) | 700 bp in file |

Identity expectations: Q01 100%, Q02 100%, Q03 ~98%, Q04 ~95%, Q05 ~92% (reverse complement), Q06 ~87% (should be rejected at the default 90% threshold), Q07 100%, Q08 ~97%, Q09 100% (only when the E. coli row is the pasted reference), Q10 no match above threshold.

## Demo recipes
1. **Basic detection:** default database mode: paste Q01 (M13 1–1200) → drop reference_phage_database.xlsx → only M13 hits 100%, forward, database positions 1–1200.
2. **Vector contamination story:** paste Q07 → search the reference database → pUC19 hits 100%. Treat shared vector segments as sequence matches, not taxonomic assignments.
3. **Host vs phage discrimination:** paste Q09 → search the database → the host fragment hits 100%. Switch to candidate-screen mode, paste the T7 32-kb reference and upload the query workbook → Q04 hits 95%.
4. **Threshold behavior:** in candidate-screen mode against the T4 32-kb row, set 86% → Q06 (86.56%) appears; at 87% it disappears. Lambda gives Q05 at 92.60%, reverse-complement.

Notes: N positions are masked from matches and the identity denominator, not counted as matches. This is exact ungapped best-window identity, not BLAST. Big genomes are stored truncated only because Excel caps cells at ~32k characters; refetch from the accession in column B if you need longer windows.
