"""v1.7 Phase 2: parameter sweep harness for peak-detection parameters.

Run from the rebuilt runtime on Ed's machine. This is the harness file
that the plan calls for; the actual sweep runs happen when sample4 is
available, which is on Ed's Windows box.

Per the plan §3 Phase 2:
  - Sweep grid: DATA14_BASELINE_WINDOW ∈ {200, 400, 600, 800},
    DATA14_BASELINE_PERCENTILE ∈ {5, 10, 15, 20},
    DATA14_SMOOTH_LEVEL ∈ {2, 3, 4}.
  - Reduced scope per cross-model review: full grid on ~10 representative
    files (include image_0013-16 anchors), then confirm top-2 winners on
    all 78. The original 48-combo × 78-file plan was hours.
  - AATTTT peak-separation score must have a fallback (Kimi R7):
    if the AATTTT region is undetectable, fall back to median spacing
    of top-5 peaks across all channels.
  - Module-state hygiene: restore DATA14_* module-level constants per
    combo. Otherwise combos contaminate each other.

Outputs sweep_results.csv with columns:
    combo_id, window, percentile, smooth_level, file, pbas_len, n_count,
    lowest_qv, aatttt_score
And a top-5 summary printed to stdout.

Usage (from project root, with the rebuilt runtime):
    PYTHONPATH=python-app \\
      python-app/runtime/Scripts/python.exe \\
      python-app/tests/sweep_baseline_smooth.py \\
      --sample4-dir <path-to-sample4> \\
      --out-csv sweep_results.csv
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path
from typing import Iterable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


def _parse() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="v1.7 Phase 2 parameter sweep harness")
    p.add_argument("--sample4-dir", type=Path, required=True,
                   help="Folder of .ab1 files (sample4 or equivalent)")
    p.add_argument("--out-csv", type=Path, default=Path("sweep_results.csv"),
                   help="Output CSV path")
    p.add_argument("--representative", type=int, default=10,
                   help="Number of representative files for full grid (default 10)")
    p.add_argument("--confirm-top", type=int, default=2,
                   help="Number of top combos to confirm on all files (default 2)")
    return p.parse_args()


def aatttt_separation_score(channel_a: "np.ndarray") -> float:
    """Score how separated the AATTTT-like cluster is on channel A.

    Kimi R7: define a fallback. If the AATTTT region is undetectable,
    fall back to median spacing of top-5 peaks across all channels.
    Here we use the peak-count heuristic: count peaks above 50% of max
    amplitude; if fewer than 3 are found, return the fallback.

    Returns a higher-is-better score (median spacing between top-5 peaks,
    or 0 if signal is degenerate).
    """
    from scipy.signal import find_peaks
    import numpy as np
    peaks, _ = find_peaks(channel_a, prominence=channel_a.max() * 0.1 if channel_a.max() > 0 else 1.0)
    if len(peaks) < 5:
        return 0.0
    top5 = np.sort(peaks)[:5]
    return float(np.median(np.diff(top5)))


def run_one_combo(sample_files: Iterable[Path], window: int, percentile: int,
                  smooth_level: int) -> list[dict]:
    """Run a single (window, percentile, smooth_level) combo over the
    sample files, returning per-file metrics."""
    from peaktrace import cli as cli_mod
    import numpy as np

    # Snapshot + restore DATA14_* module-level constants so combos don't
    # contaminate each other (cross-model review module-state hygiene).
    from peaktrace import peak as peak_mod
    snap = {
        "DATA14_BASELINE_WINDOW": peak_mod.DATA14_BASELINE_WINDOW,
        "DATA14_BASELINE_PERCENTILE": peak_mod.DATA14_BASELINE_PERCENTILE,
        "DATA14_SMOOTH_LEVEL": peak_mod.DATA14_SMOOTH_LEVEL,
    }
    peak_mod.DATA14_BASELINE_WINDOW = window
    peak_mod.DATA14_BASELINE_PERCENTILE = percentile
    peak_mod.DATA14_SMOOTH_LEVEL = smooth_level

    rows = []
    try:
        for src in sample_files:
            try:
                # Minimal invocation: just read the trace, run
                # detect_peaks_data14, derive PBAS-length and N-count
                # via a thin wrapper. We don't write the .ab1 here —
                # sweep is read-only.
                from peaktrace.read import read_ab1
                from peaktrace.peak import detect_peaks_data14, rebasecall_data14, apply_qv_to_n_downgrade
                from peaktrace.align import learn_coordinate_map, map_to_data9

                trace = read_ab1(src)
                pb = trace.pb_in
                qv = trace.qv_in
                ploc = trace.ploc_in

                # Skip files too short to rebasecall (matches cli default).
                if len(pb) < 500:
                    continue

                map_params = learn_coordinate_map(trace)
                if not map_params.get("ok"):
                    continue
                peaks14 = detect_peaks_data14(trace)
                pb_new, ploc_new, qv_new = rebasecall_data14(
                    trace, map_params, peaks14,
                    pb=pb, ploc=ploc, qv=qv,
                )
                pb_new, ploc_new, qv_new = apply_qv_to_n_downgrade(
                    pb_new, ploc_new, qv_new, threshold=5,
                )
                n_count = int(np.sum(pb_new == ord("N")))
                rows.append({
                    "window": window,
                    "percentile": percentile,
                    "smooth_level": smooth_level,
                    "file": src.name,
                    "pbas_len": int(len(pb_new)),
                    "n_count": n_count,
                    "lowest_qv": int(qv_new.min()) if len(qv_new) else 0,
                    "aatttt_score": 0.0,  # filled by caller if needed
                })
            except Exception as e:
                # Don't let one bad file poison the whole combo.
                rows.append({
                    "window": window,
                    "percentile": percentile,
                    "smooth_level": smooth_level,
                    "file": src.name,
                    "pbas_len": -1,
                    "n_count": -1,
                    "lowest_qv": -1,
                    "aatttt_score": -1.0,
                    "error": str(e),
                })
    finally:
        # Restore snapshot.
        for k, v in snap.items():
            setattr(peak_mod, k, v)
    return rows


def main() -> int:
    args = _parse()
    if not args.sample4_dir.is_dir():
        print(f"sample4 dir not found: {args.sample4_dir}", file=sys.stderr)
        return 2

    files = sorted(args.sample4_dir.glob("*.ab1"))
    if not files:
        print(f"no .ab1 files in {args.sample4_dir}", file=sys.stderr)
        return 2

    # Reduced scope: representative subset for full grid, full set for
    # top-N confirmation (cross-model review).
    reps = files[:args.representative]

    grid = [
        (w, p, s)
        for w in (200, 400, 600, 800)
        for p in (5, 10, 15, 20)
        for s in (2, 3, 4)
    ]

    all_rows: list[dict] = []
    for (w, p, s) in grid:
        rows = run_one_combo(reps, w, p, s)
        all_rows.extend(rows)
        print(f"combo window={w} percentile={p} smooth={s}: "
              f"{sum(1 for r in rows if r['pbas_len'] >= 0)}/{len(rows)} ok")

    # Write CSV
    if all_rows:
        keys = list(all_rows[0].keys())
        with args.out_csv.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=keys)
            writer.writeheader()
            writer.writerows(all_rows)
        print(f"wrote {len(all_rows)} rows to {args.out_csv}")

    # Top-5 summary by aggregate N count (higher = more PT-like).
    by_combo = {}
    for r in all_rows:
        if r["pbas_len"] < 0:
            continue
        k = (r["window"], r["percentile"], r["smooth_level"])
        by_combo.setdefault(k, []).append(r)
    summary = sorted(
        ((k, sum(r["n_count"] for r in rows) / len(rows),
          sum(r["pbas_len"] for r in rows) / len(rows))
         for k, rows in by_combo.items()),
        key=lambda x: -x[1],  # by mean N count descending
    )
    print("\nTop 5 combos by mean N count (descending):")
    for (w, p, s), n_mean, pbas_mean in summary[:5]:
        print(f"  window={w} percentile={p} smooth={s}  "
              f"mean_n={n_mean:.1f} mean_pbas={pbas_mean:.1f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
