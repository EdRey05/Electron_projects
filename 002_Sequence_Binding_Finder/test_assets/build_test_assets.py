#!/usr/bin/env python3
"""
build_test_assets.py — regenerate the Sequence Binding Finder demo/test Excel files
from the real NCBI FASTA records in ./fasta_raw/.

Output (same folder as this script):
  reference_phage_database.xlsx   — curated reference DB (paste into the app's Reference box)
  test_query_assemblies.xlsx      — demo queries (drop onto the app's file dropzone)
  README_test_assets.md           — provenance + demo recipes

Regenerate after refetching FASTAs:  python build_test_assets.py
Excel cell limit forces >32kb genomes to be truncated (Excel cells max ~32,767 chars).
"""
import os, re, random

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "fasta_raw")

def read_fasta(path):
    seq = []
    with open(path, encoding="utf-8", errors="ignore") as fh:
        header = fh.readline().strip().lstrip(">")
        for line in fh:
            seq.append(line.strip())
    return header, "".join(seq).upper()

def load(name):
    p = os.path.join(RAW, name)
    if not os.path.exists(p):
        return None, None
    return read_fasta(p)

def mutate(seq, rate, seed):
    rng = random.Random(seed)
    bases = "ACGT"
    out = []
    for ch in seq:
        if ch not in bases:
            out.append(ch); continue
        if rng.random() < rate:
            out.append(rng.choice([b for b in bases if b != ch]))
        else:
            out.append(ch)
    return "".join(out)

def revcomp(s):
    return s.translate(str.maketrans("ACGTN", "TGCAN"))[::-1]

def fmt_bp(n):
    return f"{n:,} bp"

MAX_CELL = 32_000  # stay safely under Excel's 32,767 char cell limit

# ---------------------------------------------------------------- reference DB
# name, provenance, sequence
refs = []
for fn, label, acc in [
    ("NC_001604.1.fa", "Enterobacteria phage T7",            "NC_001604.1"),
    ("NC_003298.1.fa", "Enterobacteria phage T3",           "NC_003298.1"),
    ("NC_000866.4.fa", "Enterobacteria phage T4",           "NC_000866.4"),
    ("NC_074765.1.fa", "Enterobacteria phage M13",          "NC_074765.1"),
    ("NC_001422.1.fa", "Escherichia phage phiX174",         "NC_001422.1"),
    ("NC_001416.1.fa", "Enterobacteria phage lambda",       "NC_001416.1"),
    ("NC_002371.2.fa", "Salmonella phage P22",              "NC_002371.2"),
    ("NC_005856.1.fa", "Enterobacteria phage P1",           "NC_005856.1"),
    ("NC_001417.1.fa", "Enterobacterio phage MS2",          "NC_001417.1"),
    ("NC_004176.fa",   "Escherichia virus HK97",            "NC_004176"),
]:
    h, s = load(fn)
    if not s:
        continue
    note = "full genome" if len(s) <= MAX_CELL else f"truncated to {MAX_CELL:,} bp for Excel cell limit"
    refs.append((label, f"RefSeq {acc} | {note} | ref={h[:60]}", s[:MAX_CELL]))

for fn, label, acc in [
    ("J01749.1.fa", "Cloning vector pBR322", "J01749.1"),
    ("M77789.2.fa", "Cloning vector pUC19",  "M77789.2"),
]:
    h, s = load(fn)
    if s:
        refs.append((label, f"GenBank {acc} | full sequence", s[:MAX_CELL]))

h, s = load("NC_000913.3_frag.fa")
if s:
    refs.append(("E. coli K-12 MG1655 (lacZ start region)",
                 "RefSeq NC_000913.3:3653047-3654247 | host-genome fragment", s))

# ---------------------------------------------------------------- query panel
queries = []

def add(qname, prov, seq):
    queries.append((qname, prov, seq))

# positive controls — real, unmuted
m13_h, m13 = load("NC_074765.1.fa")
add("Q01-M13-contig-1200bp", "M13 1-1200, no mutations (100% expected)", m13[0:1200])

t3_h, t3 = load("NC_003298.1.fa")
add("Q02-T3-contig-900bp", "T3 8000-8900, no mutations (100% expected; cross-test vs other refs)",
    t3[7999:8899])

# mutated reads — divergence ladder
phix_h, phix = load("NC_001422.1.fa")
add("Q03-phiX174-diverged-800bp", "phiX174 2000-2800, ~2% substitutions (~98% expected)", mutate(phix[1999:2799], 0.02, 11))

t7_h, t7 = load("NC_001604.1.fa")
add("Q04-T7-diverged-800bp", "T7 4000-4800, ~5% substitutions (~95% expected)", mutate(t7[3999:4799], 0.05, 22))

lam_h, lam = load("NC_001416.1.fa")
add("Q05-lambda-RC-diverged-1000bp", "lambda 10000-11000, reverse complement, ~8% substitutions (~92% expected; tests revcomp)",
    revcomp(mutate(lam[9999:10999], 0.08, 33)))

t4_h, t4 = load("NC_000866.4.fa")
add("Q06-T4-highly-diverged-900bp", "T4 30000-30900, ~13% substitutions (~87% expected; below default 90% threshold)", mutate(t4[29999:30899], 0.13, 44))

puc_h, puc = load("M77789.2.fa")
add("Q07-pUC19-vector-contig-1000bp", "pUC19 1-1000, no mutations (vector-contamination positive control)", puc[0:1000])

pbr_h, pbr = load("J01749.1.fa")
add("Q08-pBR322-vector-diverged-800bp", "pBR322 1000-1800, ~3% substitutions (~97% expected)", mutate(pbr[999:1799], 0.03, 55))

# host read
ec_h, ec = load("NC_000913.3_frag.fa")
add("Q09-Ecoli-host-read-1200bp", "E. coli MG1655 3653047-3654247, no mutations (host-background control)", ec)

# negative control — synthetic random, no real-world homology intended
rng = random.Random(42)
neg = "".join(rng.choice("ACGT") for _ in range(700))
add("Q10-synthetic-negative-700bp", "random AC GT sequence, seed 42 (no-match control; the only synthetic row)", neg)

# ---------------------------------------------------------------- write xlsx
import json
with open(os.path.join(HERE, 'corpus.json'), 'w', encoding='utf-8') as fh:
    json.dump({'references': refs, 'queries': queries}, fh, ensure_ascii=False, indent=2)

from openpyxl import Workbook

def dump(path, header, rows):
    wb = Workbook()
    ws = wb.active
    if header:
        ws.append(header)
    for r in rows:
        ws.append([(r[0] or ""), (r[1] or ""), (r[2] or "")])
    wb.save(path)

dump(os.path.join(HERE, "reference_phage_database.xlsx"),
     ("Name", "Source / provenance", "Sequence"), refs)
dump(os.path.join(HERE, "test_query_assemblies.xlsx"),
     ("Name", "Design / provenance", "Sequence"), queries)

# ---------------------------------------------------------------- README
from datetime import date
lines = []
W = lines.append
W("# Sequence Binding Finder — demo / test assets")
W("")
W(f"Regenerated: {date.today().isoformat()} (ET). Builder: `build_test_assets.py` (rerun it to rebuild after FASTA refetch).")
W("All reference sequences are real NCBI records; one row (Q10) is an intentional synthetic negative control.")
W("")
W("## File formats (match the app's parser)")
W("- Column A = Name, column B = secondary/provenance, column C = sequence. Header row is auto-detected; safe to leave it.")
W("- `reference_phage_database.xlsx` = reference candidates (copy a row's sequence into the app's Reference box).")
W("- `test_query_assemblies.xlsx` = queries (drop onto the file dropzone).")
W("")
W("## Reference panel")
W("")
W("| Name | Source | Sequence stored |")
W("|---|---|---|")
for label, prov, s in refs:
    truncated = len(s) < (len(s) if "|" not in prov else len(s))
    note = "truncated 32,000 bp (Excel cell limit)" if len(s) >= MAX_CELL and "truncated" in prov else "full"
    W(f"| {label} | {prov.split(' | ')[0]} | {note} ({len(s):,} bp) |")
W("")
W("Raw GenBank/RefSeq FASTA kept in `fasta_raw/` (source of truth for regeneration).")
W("")
W("## Query panel (expected outcomes)")
W("")
W("| Query | What it is | Expected best behavior |")
W("|---|---|---|")
for qname, prov, seq in queries:
    W(f"| {qname} | {prov} | {len(seq):,} bp in file |")
W("")
W("Identity expectations: Q01 100%, Q02 100%, Q03 ~98%, Q04 ~95%, Q05 ~92% (reverse complement), Q06 ~87% (should be rejected at the default 90% threshold), Q07 100%, Q08 ~97%, Q09 100% (only when the E. coli row is the pasted reference), Q10 no match above threshold.")
W("")
W("## Demo recipes")
W("1. **Basic detection:** default database mode: paste Q01 (M13 1–1200) → drop reference_phage_database.xlsx → only M13 hits 100%, forward, database positions 1–1200.")
W("2. **Vector contamination story:** paste Q07 → search the reference database → pUC19 hits 100%. Treat shared vector segments as sequence matches, not taxonomic assignments.")
W("3. **Host vs phage discrimination:** paste Q09 → search the database → the host fragment hits 100%. Switch to candidate-screen mode, paste the T7 32-kb reference and upload the query workbook → Q04 hits 95%.")
W("4. **Threshold behavior:** in candidate-screen mode against the T4 32-kb row, set 86% → Q06 (86.56%) appears; at 87% it disappears. Lambda gives Q05 at 92.60%, reverse-complement.")
W("")
W("Notes: N positions are masked from matches and the identity denominator, not counted as matches. This is exact ungapped best-window identity, not BLAST. Big genomes are stored truncated only because Excel caps cells at ~32k characters; refetch from the accession in column B if you need longer windows.")
with open(os.path.join(HERE, "README_test_assets.md"), "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines) + "\n")

print(f"reference rows: {len(refs)}")
for label, prov, s in refs: print(f"  REF  {label:<42} {len(s):>7,} bp")
print(f"query rows: {len(queries)}")
for qname, prov, seq in queries: print(f"  QRY  {qname:<42} {len(seq):>7,} bp")