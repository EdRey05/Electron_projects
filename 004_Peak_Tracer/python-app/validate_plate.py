"""
validate_plate.py — Validate peaktrace_core output against PeakTrace RP gold standard.

Usage:
  python validate_plate.py --input-dir DIR --output-dir DIR --gold-dir DIR [--name LABEL]

DIRs:
  --input-dir   Folder of post-Seq7 .ab1 files (the input to our pipeline)
  --output-dir  Folder where peaktrace_core output goes (auto-created if missing)
  --gold-dir    Folder of PeakTrace RP .ab1 files (gold standard)
  --name        Optional label for the validation report (default: derived from gold-dir)

Behavior:
  - If --output-dir doesn't contain .ab1 files, runs peaktrace_core first.
  - Compares every .ab1 in --gold-dir to the matching .ab1 in --output-dir
    (matching by basename).
  - Reports 4 metrics per file:
      1. Basecall exact match % (over shared prefix)
      2. QV exact-match %, within-±5 %, mean abs diff
      3. PLOC delta mean (where basecall matches), within ±2 scans %
      4. ABI metadata tag diffs
  - Writes JSON results to <output-dir>/validation_results.json
  - Writes markdown summary to <output-dir>/validation_summary.md
  - Also writes HTML version of summary

Quick use after a new plate arrives:
  1. Drop the new plate.zip in the task folder
  2. Extract:  unzip plate.zip -d <plate_dir>
  3. Run:    python validate_plate.py --input-dir <plate_dir>/2-X --output-dir <work>/out --gold-dir <plate_dir>/3-X --name PLATE_NAME
  4. Read:   <work>/out/validation_summary.html (or .md)
"""
from __future__ import annotations
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from datetime import datetime

import numpy as np
from Bio import SeqIO


PEAKTRACE_CORE = "C:/Users/Administrator/Desktop/Github_EdRey05/Electron_projects/004_Peak_Tracer/python-app/peaktrace_core.py"
PYTHONPATH = "C:/Users/Administrator/Desktop/Github_EdRey05/Electron_projects/004_Peak_Tracer/python-app"
PYTHON = "C:/Users/Administrator/AppData/Local/hermes/profiles/gene-synt-hermes/cache/inspect_ab1/.venv/Scripts/python.exe"


def g(rec, tag):
    return rec.annotations.get("abif_raw", {}).get(tag, None)


def asarr(x):
    if x is None or isinstance(x, str):
        return np.array([], dtype=np.uint8)
    if isinstance(x, (bytes, bytearray)):
        try:
            return np.array([ord(c) for c in x.decode("ascii")], dtype=np.uint8)
        except Exception:
            return np.array([], dtype=np.uint8)
    if isinstance(x, np.ndarray):
        return x
    if hasattr(x, "__len__"):
        try:
            return np.array(x)
        except Exception:
            return np.array([], dtype=np.uint8)
    return np.array([])


def as_int(x):
    a = asarr(x)
    if a.size == 0:
        return a
    return a.astype(np.int32)


def run_pipeline(input_dir: Path, output_dir: Path) -> int:
    """Run peaktrace_core to generate output_dir from input_dir."""
    output_dir.mkdir(parents=True, exist_ok=True)
    # Don't re-run if output_dir already has .ab1 files
    existing = list(output_dir.glob("*.ab1"))
    if existing:
        print(f"  [skip] peaktrace_core output already exists in {output_dir} ({len(existing)} files)")
        return 0

    env_setup = f"PYTHONPATH={PYTHONPATH}"
    cmd = f'"{PYTHON}" "{PEAKTRACE_CORE}" --input-dir "{input_dir}" --output-dir "{output_dir}" --max-workers 1'
    print(f"  [run]  {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        print("  [error] peaktrace_core failed:")
        print(result.stderr[-2000:])
        return result.returncode
    return 0


def compare_one(pt_path: Path, us_path: Path) -> dict | None:
    """Compare one file pair across all 4 metrics."""
    try:
        r_pt = SeqIO.read(pt_path, "abi")
        r_us = SeqIO.read(us_path, "abi")
    except Exception as e:
        print(f"  [skip] {us_path.name}: {e}")
        return None

    pb_pt = asarr(g(r_pt, "PBAS1"))
    pb_us = asarr(g(r_us, "PBAS1"))
    qv_pt = as_int(g(r_pt, "PCON1"))
    qv_us = as_int(g(r_us, "PCON1"))
    pl_pt = as_int(g(r_pt, "PLOC1"))
    pl_us = as_int(g(r_us, "PLOC1"))

    m = min(len(pb_pt), len(pb_us))
    if m == 0:
        return None

    # 1. Basecall identity
    matches = int(np.sum(pb_pt[:m] == pb_us[:m]))
    matches_pct = 100 * matches / m

    # 2. QV
    qv_exact = int(np.sum(qv_pt[:m] == qv_us[:m]))
    qv_within_5 = int(np.sum(np.abs(qv_pt[:m] - qv_us[:m]) <= 5))
    qv_abs_diff_mean = float(np.mean(np.abs(qv_pt[:m] - qv_us[:m])))

    # 3. PLOC delta (where basecall matches)
    ploc_deltas = []
    for i in range(m):
        if pb_pt[i] == pb_us[i]:
            ploc_deltas.append(int(abs(int(pl_pt[i]) - int(pl_us[i]))))
    if ploc_deltas:
        ploc_delta_mean = float(np.mean(ploc_deltas))
        ploc_delta_median = float(np.median(ploc_deltas))
        ploc_within_2_pct = 100 * sum(1 for d in ploc_deltas if d <= 2) / len(ploc_deltas)
    else:
        ploc_delta_mean = ploc_delta_median = 0.0
        ploc_within_2_pct = 0.0

    # 4. Metadata diffs (skip binary data + long arrays)
    tags_pt = r_pt.annotations.get("abif_raw", {})
    tags_us = r_us.annotations.get("abif_raw", {})
    common_tags = set(tags_pt.keys()) & set(tags_us.keys())
    n_metadata_diffs = 0
    for t in common_tags:
        v_pt = tags_pt[t]; v_us = tags_us[t]
        if isinstance(v_pt, (bytes, bytearray)) or isinstance(v_us, (bytes, bytearray)):
            continue
        if hasattr(v_pt, "__len__") and hasattr(v_us, "__len__") and not isinstance(v_pt, str) and not isinstance(v_us, str):
            if len(v_pt) > 10 or len(v_us) > 10:
                continue
        if v_pt != v_us:
            n_metadata_diffs += 1

    return {
        "name": us_path.stem,
        "len_pt": len(pb_pt),
        "len_us": len(pb_us),
        "len_diff": len(pb_us) - len(pb_pt),
        "basecall_match_pct": matches_pct,
        "qv_exact_pct": 100 * qv_exact / m,
        "qv_within_5_pct": 100 * qv_within_5 / m,
        "qv_abs_diff_mean": qv_abs_diff_mean,
        "ploc_delta_mean": ploc_delta_mean,
        "ploc_delta_median": ploc_delta_median,
        "ploc_within_2_pct": ploc_within_2_pct,
        "n_metadata_diffs": n_metadata_diffs,
    }


def summarize(results: list[dict]) -> dict:
    """Compute population-level summary statistics."""
    if not results:
        return {}
    keys = ["basecall_match_pct", "qv_exact_pct", "qv_within_5_pct", "qv_abs_diff_mean",
            "ploc_delta_mean", "ploc_within_2_pct", "n_metadata_diffs",
            "len_pt", "len_us", "len_diff"]
    summary = {"n": len(results)}
    for k in keys:
        arr = np.array([r[k] for r in results])
        summary[k] = {
            "mean": float(arr.mean()),
            "median": float(np.median(arr)),
            "min": float(arr.min()),
            "max": float(arr.max()),
            "p25": float(np.percentile(arr, 25)),
            "p75": float(np.percentile(arr, 75)),
        }
    return summary


def write_markdown_summary(name: str, results: list[dict], summary: dict, out_dir: Path, gold_dir: Path, input_dir: Path) -> Path:
    """Write a markdown summary report."""
    md_path = out_dir / "validation_summary.md"
    s = summary
    lines = [
        f"# Validation Summary — {name}",
        f"",
        f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"**Input dir:** `{input_dir}`",
        f"**Gold dir:** `{gold_dir}`",
        f"**Output dir:** `{out_dir}`",
        f"**Files compared:** {s.get('n', 0)}",
        f"",
        f"## Population-level metrics",
        f"",
        f"| Metric | Mean | Median | Min | Max | p25 | p75 |",
        f"|---|---|---|---|---|---|---|",
    ]
    metric_labels = [
        ("basecall_match_pct", "Basecall exact match %"),
        ("qv_exact_pct", "QV exact-equal %"),
        ("qv_within_5_pct", "QV within ±5 %"),
        ("qv_abs_diff_mean", "QV mean abs diff"),
        ("ploc_delta_mean", "PLOC delta mean (scans)"),
        ("ploc_within_2_pct", "PLOC within ±2 scans %"),
        ("n_metadata_diffs", "Metadata tag diffs / file"),
        ("len_pt", "PT length (bases)"),
        ("len_us", "Our length (bases)"),
        ("len_diff", "Length diff (ours - PT)"),
    ]
    for k, label in metric_labels:
        if k not in s:
            continue
        v = s[k]
        lines.append(f"| {label} | {v['mean']:.2f} | {v['median']:.2f} | {v['min']:.2f} | {v['max']:.2f} | {v['p25']:.2f} | {v['p75']:.2f} |")

    lines.extend([
        f"",
        f"## Top 5 by basecall identity",
        f"",
        f"| File | PT len | Our len | Diff | Basecall match % | QV exact % | QV ±5 % | PLOC delta mean |",
        f"|---|---|---|---|---|---|---|---|",
    ])
    for r in sorted(results, key=lambda r: -r["basecall_match_pct"])[:5]:
        lines.append(f"| {r['name'][:50]} | {r['len_pt']} | {r['len_us']} | {r['len_diff']:+d} | {r['basecall_match_pct']:.1f} | {r['qv_exact_pct']:.1f} | {r['qv_within_5_pct']:.1f} | {r['ploc_delta_mean']:.1f} |")

    lines.extend([
        f"",
        f"## Worst 5 by basecall identity",
        f"",
        f"| File | PT len | Our len | Diff | Basecall match % | QV exact % | QV ±5 % | PLOC delta mean |",
        f"|---|---|---|---|---|---|---|---|",
    ])
    for r in sorted(results, key=lambda r: r["basecall_match_pct"])[:5]:
        lines.append(f"| {r['name'][:50]} | {r['len_pt']} | {r['len_us']} | {r['len_diff']:+d} | {r['basecall_match_pct']:.1f} | {r['qv_exact_pct']:.1f} | {r['qv_within_5_pct']:.1f} | {r['ploc_delta_mean']:.1f} |")

    lines.extend([
        f"",
        f"## Interpretation",
        f"",
        f"- **Basecall match %** above 95% means sister company won't notice. Below 80% means missing late-read extension.",
        f"- **QV exact %** high means sister company's QC report will look the same. Below 50% may cause different trim results.",
        f"- **PLOC delta** above 100 scans means our peak positions are very different. May matter for visualization.",
        f"- **Metadata diffs** of 0 means ABI header preserved correctly.",
    ])

    md_path.write_text("\n".join(lines), encoding="utf-8")
    return md_path


def write_html_summary(md_path: Path) -> Path:
    """Render the markdown summary as HTML."""
    import markdown as mdlib
    html_path = md_path.with_suffix(".html")
    text = md_path.read_text(encoding="utf-8")
    md = mdlib.Markdown(extensions=["tables", "fenced_code"])
    body = md.convert(text)
    # Reuse the template from render_html.py (inline for simplicity)
    html = f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>{md_path.stem}</title>
<style>
  body {{ margin: 0; padding: 32px; background: #FAF6EE; color: #14181B; font-family: 'IBM Plex Sans', sans-serif; font-size: 15px; line-height: 1.55; }}
  .container {{ max-width: 1100px; margin: 0 auto; background: white; padding: 48px 56px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }}
  h1 {{ font-family: 'Space Grotesk', sans-serif; font-size: 28px; font-weight: 700; border-bottom: 2px solid #4FB3A9; padding-bottom: 12px; }}
  h2 {{ font-family: 'Space Grotesk', sans-serif; font-size: 20px; font-weight: 600; margin-top: 28px; border-bottom: 1px solid #E5DFD3; padding-bottom: 6px; }}
  table {{ border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }}
  th, td {{ border: 1px solid #E5DFD3; padding: 8px 12px; text-align: left; vertical-align: top; }}
  th {{ background: #F0EBE0; font-weight: 600; }}
  tr:nth-child(even) td {{ background: #FBFAF6; }}
  code {{ font-family: 'IBM Plex Mono', monospace; background: #F0EBE0; padding: 2px 5px; border-radius: 3px; font-size: 13px; }}
  pre {{ background: #14181B; color: #E5DFD3; padding: 14px 16px; border-radius: 6px; overflow-x: auto; font-size: 13px; }}
  blockquote {{ border-left: 3px solid #4FB3A9; margin-left: 0; padding-left: 16px; color: #8FA39D; }}
  a {{ color: #4FB3A9; }}
  strong {{ color: #14181B; }}
  em {{ color: #8FA39D; }}
</style></head>
<body><div class="container">
{body}
</div></body></html>
"""
    html_path.write_text(html, encoding="utf-8")
    return html_path


def main():
    p = argparse.ArgumentParser(description="Validate peaktrace_core output against PeakTrace RP gold standard.")
    p.add_argument("--input-dir", type=Path, required=True, help="Post-Seq7 .ab1 folder (input to our pipeline)")
    p.add_argument("--output-dir", type=Path, required=True, help="Where our pipeline should write output (and the validation report)")
    p.add_argument("--gold-dir", type=Path, required=True, help="PeakTrace RP .ab1 folder (gold standard)")
    p.add_argument("--name", default=None, help="Label for the report (default: derived from gold-dir name)")
    p.add_argument("--skip-pipeline", action="store_true", help="Don't run peaktrace_core; assume output-dir already populated")
    args = p.parse_args()

    name = args.name or args.gold_dir.name

    print(f"\n=== Validation: {name} ===")
    print(f"  input:  {args.input_dir}")
    print(f"  gold:   {args.gold_dir}")
    print(f"  output: {args.output_dir}")

    # Step 1: Run pipeline if needed
    if not args.skip_pipeline:
        rc = run_pipeline(args.input_dir, args.output_dir)
        if rc != 0:
            print(f"  [error] pipeline failed (rc={rc})")
            return rc

    # Step 2: Compare
    print(f"  [compare] walking gold-dir...")
    gold_files = {p.stem: p for p in args.gold_dir.glob("*.ab1")}
    our_files = {p.stem: p for p in args.output_dir.glob("*.ab1")}
    common = sorted(set(gold_files) & set(our_files))
    print(f"  gold files: {len(gold_files)}, our files: {len(our_files)}, common: {len(common)}")

    results = []
    for s in common:
        r = compare_one(gold_files[s], our_files[s])
        if r:
            results.append(r)

    summary = summarize(results)
    print(f"  compared: {len(results)}")

    # Step 3: Write reports
    json_path = args.output_dir / "validation_results.json"
    json_path.write_text(json.dumps({"name": name, "summary": summary, "results": results}, indent=2))
    print(f"  [write] {json_path}")

    md_path = write_markdown_summary(name, results, summary, args.output_dir, args.gold_dir, args.input_dir)
    print(f"  [write] {md_path}")

    html_path = write_html_summary(md_path)
    print(f"  [write] {html_path}")

    # Step 4: Print short summary
    if summary:
        s = summary
        print(f"\n=== Summary ({len(results)} files) ===")
        print(f"  Basecall match:  mean={s['basecall_match_pct']['mean']:.1f}%  median={s['basecall_match_pct']['median']:.1f}%")
        print(f"  QV exact:        mean={s['qv_exact_pct']['mean']:.1f}%  median={s['qv_exact_pct']['median']:.1f}%")
        print(f"  QV within ±5:    mean={s['qv_within_5_pct']['mean']:.1f}%  median={s['qv_within_5_pct']['median']:.1f}%")
        print(f"  QV mean abs diff:  {s['qv_abs_diff_mean']['mean']:.2f}")
        print(f"  PLOC delta mean:   {s['ploc_delta_mean']['mean']:.1f} scans")
        print(f"  Length diff (ours - PT): mean={s['len_diff']['mean']:+.0f} bases")
        print(f"  Metadata diffs/file: {s['n_metadata_diffs']['mean']:.2f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
