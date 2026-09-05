"""peaktrace_core CLI — entry point for the Electron main process to spawn.

v1 TRUST-INPUT PIPELINE (Aug 24 2026):
  - Reads post-Seq7 .ab1 files
  - TRUSTS input's PBAS/PCON/PLOC (no re-basecalling) — proven byte-identical to raw
  - Re-scales + smooths + cleans channel data (cosmetic; matches PT appearance)
  - Writes new .ab1 with Seq7 metadata + our cosmetic channel data
  - Writes companion .seq in PT format (matches what sister company expects)

Rationale (verified Aug 24):
  - Seq7/KB 1.4.2.4 in the 3730xl instrument does spectral deconvolution, baseline,
    mobility shift, spacing, light smoothing, peak detection, KB basecall, QVs, and
    trim recommendations. Channel data, basecall, QVs, and peak positions are
    BYTE-IDENTICAL to the raw .ab1 from the 3730xl (KB just stamps metadata).
  - PeakTrace RP then re-basecalls the noisy tail and adds ~409 extension bases.
    For v1 we skip the extension (re-build it as v1.1 when more plate data arrives).
  - The "rescale factor 1.69" was fitted from max-amplitude ratio and may be wrong
    direction (PT may compress rather than rescale). Default to 1.0 (no rescale)
    since sister company doesn't read channel data for short-read QC.

Output is functionally equivalent to PT output minus the late-read extension:
  - Same basecalls as Seq7 (and PT's first 1198 bases)
  - Same QVs
  - Same peak locations
  - Different channel amplitudes (cosmetic; sister company doesn't depend on these)
  - .seq file format matches PT exactly (verified Aug 24)
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
    """Run the v1 trust-input pipeline on one .ab1 file. Returns a stats dict."""
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

    # 2. Cosmetic channel processing (does NOT change basecalls)
    #    These operations don't affect PBAS/PCON/PLOC — they only rewrite DATA.9-12.
    #    Disabled by default for v1 to minimize diff vs raw .ab1 (sister company
    #    may not even see channel data for QC, and rescale factor 1.69 was wrong direction).
    if args.rescale_factor != 1.0:
        rescale_channels(trace, args.rescale_factor)
    if args.smoothing_level > 0:
        smooth_channels(trace, level=args.smoothing_level, order=args.smoothing_order)
    if args.clean_baseline:
        clean_baseline(trace, window=args.baseline_window, percentile=args.baseline_percentile)

    # 3. Use input's basecalls VERBATIM (proven byte-identical to raw)
    pb = trace.pb_in.copy()
    qv = trace.qv_in.copy()
    ploc = trace.ploc_in.copy()

    # 4. Optional N-base substitution (Q < n_base_threshold → N)
    #    Default OFF (n_base_threshold=0) because Seq7/KB already handles low-QV bases
    #    appropriately. Enable only if you want stricter N-flagging than KB provides.
    if args.n_base_threshold > 0:
        for i, q in enumerate(qv):
            if int(q) < args.n_base_threshold:
                pb[i] = ord("N")

    # 5. Optional 3'-end trim
    #    NOTE: input's basecalls are already trimmed by KB at the 3' end (KB uses
    #    Q-trim too), so this is usually a no-op. Enable only if you want a stricter trim.
    if args.trim_3_only and args.q_average_trim_value > 0:
        from .peak import trim_3_end
        pb, qv = trim_3_end(pb, qv, args.q_average_trim_value, args.q_average_trim_window)
        ploc = ploc[:len(pb)]

    # 6. Compute P1AM (peak amplitudes) — read from current channel data at PLOC
    p1am = np.zeros(len(pb), dtype=np.uint16)
    for i, pos in enumerate(ploc):
        if pos >= trace.n_scans:
            continue
        amp = 0
        for ch in CHANNELS:
            if ch in trace.channels:
                amp = max(amp, int(trace.channels[ch][pos]))
        p1am[i] = amp

    # 7. Output filename (drop well ID by default)
    base = src_path.stem
    if args.strip_well_id:
        base = strip_well_id(base)
    base = base + args.filename_suffix
    out_ab1 = out_dir / (base + ".ab1")
    out_seq = out_dir / (base + ".seq")

    # 8. Write .ab1 (uses our custom patch-on-template writer)
    write_ab1(out_ab1, trace, pb, qv, ploc, p1am=p1am, set_abi_limits=args.set_abi_limits)

    # 9. Write .seq (if requested — default ON to match PT)
    if args.emit_seq:
        write_seq(out_seq, pb, ploc, qv)

    emit_event("file_done", src=str(src_path), out=str(out_ab1),
               n_bases_out=len(pb), qv_mean=float(qv.mean()) if len(qv) else 0,
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
        description="In-house replacement for Nucleics Auto PeakTrace RP (v1 trust-input)",
    )
    p.add_argument("--input-dir", required=True, type=Path)
    p.add_argument("--output-dir", required=True, type=Path)

    # Trace processing (cosmetic — default OFF for v1 to match raw exactly)
    p.add_argument("--rescale-factor", type=float, default=1.0,
                   help="Multiply each channel by this factor (default 1.0 = no rescale; "
                        "1.69 was originally fitted from max-amplitude but may be wrong direction)")
    p.add_argument("--smoothing-level", type=int, default=0,
                   help="Savitzky-Golay smoothing level (default 0 = no smoothing)")
    p.add_argument("--smoothing-order", type=int, default=2)
    p.add_argument("--baseline-window", type=int, default=400)
    p.add_argument("--baseline-percentile", type=int, default=10)
    p.add_argument("--clean-baseline", action="store_true", default=False)
    p.add_argument("--no-clean-baseline", dest="clean_baseline", action="store_true")
    p.add_argument("--skip-shorter-than", type=int, default=500)
    p.add_argument("--set-abi-limits", action="store_true", default=True)

    # Trimming (KB already trims at 3' end)
    # N-base substitution is disabled by default (KB already handles low-QV bases)
    p.add_argument("--n-base-threshold", type=int, default=0,
                   help="Convert bases with Q < this to N. Default 0 (off, KB already handles).")
    p.add_argument("--q-average-trim-value", type=int, default=0,
                   help="QV threshold for additional 3' trim (0 = no extra trim, "
                        "since KB already trimmed). Default 0.")
    p.add_argument("--q-average-trim-window", type=int, default=40)
    p.add_argument("--trim-3-only", action="store_true", default=False)
    p.add_argument("--no-trim-3-only", dest="trim_3_only", action="store_true")

    # Output
    p.add_argument("--strip-well-id", action="store_true", default=True)
    p.add_argument("--no-strip-well-id", dest="strip_well_id", action="store_true")
    p.add_argument("--filename-suffix", default="")
    p.add_argument("--emit-seq", action="store_true", default=True)
    p.add_argument("--no-emit-seq", dest="emit_seq", action="store_true")
    p.add_argument("--preserve-metadata", action="store_true", default=True)

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
               rescale_factor=args.rescale_factor,
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
