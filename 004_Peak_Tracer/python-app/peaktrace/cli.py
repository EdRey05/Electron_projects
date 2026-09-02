"""peaktrace_core CLI — entry point for the Electron main process to spawn.

Walks the input directory, processes each .ab1 file, writes to output dir.
Streams JSON-line progress events to stdout for the Electron renderer to consume.

Example:
  python peaktrace_core.py --input-dir DIR --output-dir DIR [options]
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path
import numpy as np

from .read import read_ab1, write_seq, CHANNELS
from .smooth import rescale_channels, smooth_channels, clean_baseline
from .peak import (
    drop_leading_artifact, detect_all_peaks, basecall, trim_3_end,
    extend_late_read,
)
from .write import write_ab1


# ---------- filename handling ----------

WELL_ID_RE = re.compile(r"_([A-H]\d{2})$")


def strip_well_id(name: str) -> str:
    """Drop trailing _C09 / _H12 well-ID from a basename."""
    return WELL_ID_RE.sub("", name)


def emit_event(event_type: str, **fields):
    """Emit a JSON-line event for the Electron renderer."""
    obj = {"type": event_type, **fields}
    print(json.dumps(obj), flush=True)


# ---------- per-file pipeline ----------

def process_one(src_path: Path, out_dir: Path, args) -> dict:
    """Run the full pipeline on one .ab1 file. Returns a stats dict."""
    emit_event("file_start", src=str(src_path), name=src_path.name)

    # 1. Read
    trace = read_ab1(src_path)
    emit_event("file_loaded", src=str(src_path),
               n_scans=trace.n_scans, n_bases_in=trace.n_bases)

    # Skip short reads
    if trace.n_bases < args.skip_shorter_than:
        emit_event("file_skip", src=str(src_path),
                   reason=f"shorter than {args.skip_shorter_than} bases")
        return {"src": str(src_path), "status": "skipped"}

    # 2. Drop leading artifact (uses Seq7 basecall to detect)
    drop_leading_artifact(trace)

    # 3. Rescale
    rescale_channels(trace, args.trace_rescale_factor)

    # 4. Smooth
    smooth_channels(trace, level=args.smoothing_level, order=args.smoothing_order)

    # 5. Clean baseline
    if args.clean_baseline:
        clean_baseline(trace, window=args.baseline_window, percentile=args.baseline_percentile)

    # 6. Detect peaks
    peak_dict = detect_all_peaks(trace, min_distance=10)

    # 7. Basecall
    pb, ploc, qv = basecall(trace, peak_dict,
                            mixed_threshold_pct=args.mixed_peak_threshold,
                            peak_min_factor=3.0)

    # 8. Late-read extension: continue basecalling past input's last base
    #    with a relaxed SNR threshold. This is what makes us match PeakTrace RP's
    #    late-read extension (verified Aug 24: PT extends ~409 bases on long reads).
    if args.extend_late_read and len(ploc) > 0:
        tail_start = int(ploc[-1]) + 1
        pb, ploc, qv = extend_late_read(
            trace, peak_dict, pb, ploc, qv,
            tail_start_pos=tail_start,
            min_peak_factor_tail=args.extend_min_peak_factor,
            stop_quiet_scans=args.extend_stop_quiet_scans,
            stop_min_amp=args.extend_stop_min_amp,
        )

    # 9. Apply QV-based N-threshold (Q < n_base_threshold → N)
    if args.n_base_threshold > 0:
        for i, q in enumerate(qv):
            if int(q) < args.n_base_threshold:
                pb[i] = ord("N")

    # 10. 3'-end trim (now cuts the noisy N-filled extension tail)
    if args.trim_3_only and args.q_average_trim_value > 0:
        pb, qv = trim_3_end(pb, qv, args.q_average_trim_value, args.q_average_trim_window)

    # 10. Compute P1AM (peak amplitudes for the new basecall)
    p1am = np.zeros(len(pb), dtype=np.uint16)
    for i, pos in enumerate(ploc):
        if pos >= trace.n_scans:
            continue
        amp = 0
        for ch in CHANNELS:
            if ch in trace.channels:
                amp = max(amp, int(trace.channels[ch][pos]))
        p1am[i] = amp

    # 11. Output filename
    base = src_path.stem
    if args.strip_well_id:
        base = strip_well_id(base)
    base = base + args.filename_suffix
    out_ab1 = out_dir / (base + ".ab1")
    out_seq = out_dir / (base + ".seq")

    # 12. Write .ab1 (uses our custom patch-on-template writer)
    write_ab1(out_ab1, trace, pb, qv, ploc, p1am=p1am, set_abi_limits=args.set_abi_limits)

    # 13. Write .seq (if requested)
    if args.emit_seq:
        write_seq(out_seq, pb, ploc, qv)

    emit_event("file_done", src=str(src_path), out=str(out_ab1),
               n_bases_out=len(pb), qv_mean=float(qv.mean()) if len(qv) else 0,
               extension_bases=max(0, len(pb) - trace.n_bases),
               first_5_bases="".join(chr(int(b)) for b in pb[:5]),
               last_5_bases="".join(chr(int(b)) for b in pb[-5:]))

    return {
        "src": str(src_path),
        "out": str(out_ab1),
        "status": "ok",
        "n_bases_in": trace.n_bases,
        "n_bases_out": len(pb),
        "qv_mean": float(qv.mean()) if len(qv) else 0.0,
    }


# ---------- CLI ----------

def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="peaktrace_core",
        description="In-house replacement for Nucleics Auto PeakTrace RP",
    )
    p.add_argument("--input-dir", required=True, type=Path)
    p.add_argument("--output-dir", required=True, type=Path)

    # Mode
    p.add_argument("--mode", default="rp", choices=["rp", "full", "passthrough"])

    # Trace processing
    p.add_argument("--smoothing-level", type=int, default=3)
    p.add_argument("--smoothing-order", type=int, default=2)
    p.add_argument("--baseline-window", type=int, default=400)
    p.add_argument("--baseline-percentile", type=int, default=10)
    p.add_argument("--clean-baseline", action="store_true", default=True)
    p.add_argument("--no-clean-baseline", dest="clean_baseline", action="store_false")
    p.add_argument("--apply-peak-resolution", action="store_true", default=True)
    p.add_argument("--wavelet-sharpening", action="store_true", default=False)
    p.add_argument("--skip-shorter-than", type=int, default=500)
    p.add_argument("--set-abi-limits", action="store_true", default=True)
    p.add_argument("--trace-rescale-factor", type=float, default=1.69,
                   help="Multiply each channel by this factor (default 1.69, fitted Aug 24)")
    p.add_argument("--drop-leading-base", action="store_true", default=True)
    p.add_argument("--no-drop-leading-base", dest="drop_leading_base", action="store_false")
    p.add_argument("--signal-start-peak", default="auto")

    # Basecaller
    p.add_argument("--quality-threshold", type=int, default=20)
    p.add_argument("--n-base-threshold", type=int, default=5)
    p.add_argument("--mixed-peak-threshold", type=float, default=0)
    p.add_argument("--q-average-trim-value", type=int, default=9)
    p.add_argument("--q-average-trim-window", type=int, default=40)
    p.add_argument("--good-base-improvement", type=int, default=-10)
    p.add_argument("--trim-3-only", action="store_true", default=True)
    p.add_argument("--no-trim-3-only", dest="trim_3_only", action="store_false")

    # Late-read extension (HIGHEST RISK for sister-company compatibility)
    p.add_argument("--extend-late-read", action="store_true", default=True)
    p.add_argument("--no-extend-late-read", dest="extend_late_read", action="store_false")
    p.add_argument("--extend-min-peak-factor", type=float, default=1.3,
                   help="Relaxed SNR threshold for tail region (default 1.3 vs 3.0 for main)")
    p.add_argument("--extend-stop-quiet-scans", type=int, default=80,
                   help="Stop extending if this many scans pass with no peak")
    p.add_argument("--extend-stop-min-amp", type=int, default=15,
                   help="Stop extending if max channel amplitude drops below this")

    # Output
    p.add_argument("--strip-well-id", action="store_true", default=True)
    p.add_argument("--no-strip-well-id", dest="strip_well_id", action="store_false")
    p.add_argument("--filename-suffix", default="")
    p.add_argument("--preserve-metadata", action="store_true", default=True)
    p.add_argument("--emit-seq", action="store_true", default=True)
    p.add_argument("--no-emit-seq", dest="emit_seq", action="store_false")

    # Parallelism
    p.add_argument("--max-workers", type=int, default=4)

    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    in_dir: Path = args.input_dir.resolve()
    out_dir: Path = args.output_dir.resolve()

    if not in_dir.is_dir():
        emit_event("error", message=f"input dir not found: {in_dir}")
        return 2
    out_dir.mkdir(parents=True, exist_ok=True)

    emit_event("run_start", input=str(in_dir), output=str(out_dir),
               rescale_factor=args.trace_rescale_factor,
               smoothing_level=args.smoothing_level)

    ab1_files = sorted(in_dir.glob("*.ab1"))
    emit_event("discovered", n_files=len(ab1_files))

    ok_count = 0
    skip_count = 0
    err_count = 0
    for src in ab1_files:
        try:
            r = process_one(src, out_dir, args)
            if r["status"] == "ok":
                ok_count += 1
            else:
                skip_count += 1
        except Exception as e:
            err_count += 1
            emit_event("file_error", src=str(src), error=str(e))

    emit_event("run_done", ok=ok_count, skipped=skip_count, errored=err_count)
    return 0 if err_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
