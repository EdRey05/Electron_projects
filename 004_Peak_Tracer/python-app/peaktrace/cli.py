"""peaktrace_core CLI — entry point for the Electron main process to spawn.

v1.2 TRUST-INPUT + LEAD-DROP PIPELINE (Aug 24 2026):
  - Reads post-Seq7 .ab1 + .seq files (with well-ID suffix like _C09)
  - TRUSTS input's PBAS/PCON/PLOC (no re-basecalling) — proven byte-identical to raw
  - v1.2 NEW: drops the leading base when QV < 5 (matches PT's behavior on 83% of
    long reads, eliminates the ±1 alignment shift mismatch)
  - Strips well-ID from .ab1 + .seq filenames (replaces 1-Remove-Well Position.bat)
  - Re-emits .ab1 with cosmetic channel processing (default OFF, matches raw)
  - Writes companion .seq in PeakTrace RP format
  - Generates 2-Report.xls (replaces 3-Rename And Report.bat's QC report)

Workflow replaced:
  OLD: raw → Seq7 → copy .bat files → run 1- → run 3- → make raw/ → move .ab1 →
       delete .txt → run PeakTrace → send to sister company
  NEW: raw → Seq7 → hand folder to our app → sister company gets output

What this app does NOT do (deferred to v2.0):
  - NO late-read extension (PeakTrace RP's main value-add, +400 bases)
  - NO re-basecalling of the noisy tail
  - NO peak detection (input from Seq7/KB 1.4.2.4 is used verbatim)

Sister company impact:
  - Short reads (≤1200 bases, ~21% of sample1.zip): 100% byte-identical to PT output
  - Long reads (>1500 bases PT output, ~79%): same basecalls as Seq7 (no extension)
    → sister company sees ~30% shorter reads on long samples
"""
from __future__ import annotations
import argparse
import json
import re
import sys
import time
from pathlib import Path
import numpy as np

from .read import read_ab1, write_seq, CHANNELS
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

def process_one(src_ab1: Path, out_dir: Path, args) -> dict:
    """Run the v1.1 trust-input pipeline on one .ab1 file.

    Steps:
      1. Read post-Seq7 .ab1 (PBAS/PCON/PLOC and channels)
      2. Use input's basecalls verbatim
      3. Compute P1AM (peak amplitudes) at PLOC positions
      4. Strip well ID from basename
      5. Write new .ab1
      6. Copy / reformat companion .seq file (strip well ID too)
    """
    emit_event("file_start", src=str(src_ab1), name=src_ab1.name)

    # 1. Read
    try:
        trace = read_ab1(src_ab1)
    except Exception as e:
        emit_event("file_error", src=str(src_ab1), error=f"read failed: {e}")
        return {"src": str(src_ab1), "status": "error"}

    emit_event("file_loaded", src=str(src_ab1),
               n_scans=trace.n_scans, n_bases_in=trace.n_bases)

    # Skip short reads
    if trace.n_bases < args.skip_shorter_than:
        emit_event("file_skip", src=str(src_ab1),
                   reason=f"shorter than {args.skip_shorter_than} bases")
        return {"src": str(src_ab1), "status": "skipped"}

    # 2. Use input's basecalls verbatim (trust Seq7/KB 1.4.2.4)
    pb = trace.pb_in.copy()
    qv = trace.qv_in.copy()
    ploc = trace.ploc_in.copy()

    # NOTE: v1.2 leader-base-drop logic exists but is disabled by default.
    # The current .ab1 writer has bugs that corrupt files when buffer size
    # changes (which lead-drop causes). Re-enabled in v1.3 once writer is fixed.
    lead_dropped = False
    if args.lead_drop_enabled and len(pb) > 1 and len(qv) > 0 and int(qv[0]) < args.lead_drop_qv:
        pb = pb[1:]
        qv = qv[1:]
        ploc = ploc[1:]
        lead_dropped = True

    # v1.3: Re-basecall from DATA1-4 full-resolution channels
    # Seq7 truncates DATA9-12 to ~16k scans; DATA1-4 carry ~18.7k scans of the
    # same run. Re-basecalling DATA1-4 at PT-like density (~12.3 scans/base)
    # recovers bases Seq7 dropped, merged into Seq7's spacing gaps.
    extended = False
    ext_bases_added = 0
    map_r2 = 0.0
    if args.rebasecall_data14 and len(pb) > 0:
        # Only attempt re-basecalling on reads where Seq7 already called a
        # substantial sequence (>= min_rebasecall_len). Short reads are already
        # well-trimmed by Seq7; extending them produces junk low-QV tails.
        if len(pb) < args.min_rebasecall_len:
            emit_event("file_skip_rebasecall", src=str(src_ab1),
                       reason=f"only {len(pb)} bases, below {args.min_rebasecall_len}")
        else:
            try:
                from .align import learn_coordinate_map
                from .peak import detect_peaks_data14, rebasecall_data14
                map_params = learn_coordinate_map(trace)
                map_r2 = map_params.get("r_squared", 0.0)
                if map_params.get("ok"):
                    peaks14 = detect_peaks_data14(trace, min_snr=args.extend_min_snr)
                    pb_new, ploc_new, qv_new = rebasecall_data14(
                        trace, map_params, peaks14, min_snr=args.extend_min_snr,
                        pb=pb, ploc=ploc, qv=qv)
                    # Sanity: every original call must survive in the merged output
                    # (same positions, same bases). Internal gap insertions expected.
                    orig_positions = set(int(x) for x in ploc)
                    new_positions = set(int(x) for x in ploc_new)
                    if orig_positions.issubset(new_positions) and len(pb_new) >= len(pb):
                        ok = True
                        pos_to_base = {}
                        for pos_, b_ in zip(ploc_new, pb_new):
                            pos_to_base.setdefault(int(pos_), int(b_))
                        for pos_, b_ in zip(ploc, pb):
                            if pos_to_base.get(int(pos_), -1) != int(b_):
                                ok = False
                                break
                        if ok:
                            ext_bases_added = len(pb_new) - len(pb)
                            if ext_bases_added > 0:
                                pb, ploc, qv = pb_new, ploc_new, qv_new
                                extended = True
                        else:
                            emit_event("file_warn", src=str(src_ab1),
                                       msg="rebasecall altered an original call; rejected")
                    else:
                        emit_event("file_warn", src=str(src_ab1),
                                   msg="rebasecall lost original positions; rejected")
                else:
                    emit_event("file_warn", src=str(src_ab1),
                               msg=f"coordinate map r2={map_r2:.3f} too low; trust-input")
            except Exception as e:
                emit_event("file_error", src=str(src_ab1), error=f"rebasecall failed: {e}")

    # 3. Compute P1AM (peak amplitudes) — read from input's channel data at PLOC
    p1am = np.zeros(len(pb), dtype=np.uint16)
    for i, pos in enumerate(ploc):
        if pos >= trace.n_scans:
            continue
        amp = 0
        for ch in CHANNELS:
            if ch in trace.channels:
                amp = max(amp, int(trace.channels[ch][pos]))
        p1am[i] = amp

    # 4. Output filename (drop well ID, optional suffix)
    base = src_ab1.stem
    if args.strip_well_id:
        base = strip_well_id(base)
    base = base + args.filename_suffix
    out_ab1 = out_dir / (base + ".ab1")
    out_seq = out_dir / (base + ".seq")

    # 5. Write .ab1
    try:
        write_ab1(out_ab1, trace, pb, qv, ploc, p1am=p1am, set_abi_limits=args.set_abi_limits)
    except Exception as e:
        emit_event("file_error", src=str(src_ab1), error=f"write ab1 failed: {e}")
        return {"src": str(src_ab1), "status": "error"}

    # 6. Write .seq (replaces 1-Remove-Well Position.bat's .seq renaming +
    #    provides the PT-format .seq that the sister company expects).
    # We re-emit .seq from the basecall array (PT-format), NOT copy the input .seq
    # because input's .seq has different padding than PT's.
    if args.emit_seq:
        try:
            write_seq(out_seq, pb, ploc, qv)
        except Exception as e:
            emit_event("file_error", src=str(src_ab1), error=f"write seq failed: {e}")
            return {"src": str(src_ab1), "status": "error"}

    emit_event("file_done", src=str(src_ab1), out=str(out_ab1),
                   n_bases_in=trace.n_bases, n_bases_out=len(pb),
                   qv_mean=float(qv.mean()) if len(qv) else 0,
                   first_5_bases="".join(chr(int(b)) for b in pb[:5]),
                   last_5_bases="".join(chr(int(b)) for b in pb[-5:]),
                   lead_dropped=lead_dropped, extended=extended,
                   ext_bases_added=ext_bases_added, map_r_squared=map_r2)

    return {
        "src": str(src_ab1),
        "out": str(out_ab1),
        "status": "ok",
        "n_bases_in": trace.n_bases,
        "n_bases_out": len(pb),
        "qv_mean": float(qv.mean()) if len(qv) else 0.0,
    }


def write_qc_report(out_dir: Path, results: list, args) -> Path:
    """Generate 2-Report.xls (replaces 3-Rename And Report.bat's QC report).

    Format: tab-separated values saved as .xls (matches what the .bat produced).
    Each row: <sample_basename><TAB>"<status>"

    Status values (matches 3-Rename And Report.bat):
      "OK" — file processed successfully
      "Skipped" — too short
      "Error" — read/write failure

    For v1.1 we only produce "OK" / "Skipped" / "Error" — subfolder QC
    (High Background / Superimposed / Fail / Fail addon) is deferred to v2.0.
    """
    report_path = out_dir / "2-Report.xls"
    lines = []
    for r in results:
        if r["status"] == "ok":
            basenamestem = Path(r["src"]).stem
            if args.strip_well_id:
                basenamestem = strip_well_id(basenamestem)
            basenamestem += args.filename_suffix
            lines.append(f"{basenamestem}\tOK")
        elif r["status"] == "skipped":
            basenamestem = Path(r["src"]).stem
            if args.strip_well_id:
                basenamestem = strip_well_id(basenamestem)
            basenamestem += args.filename_suffix
            reason = r.get("reason", "skipped")
            lines.append(f"{basenamestem}\tSkipped ({reason})")
        elif r["status"] == "error":
            basenamestem = Path(r["src"]).stem
            if args.strip_well_id:
                basenamestem = strip_well_id(basenamestem)
            basenamestem += args.filename_suffix
            err = r.get("error", "unknown error")
            lines.append(f"{basenamestem}\tError ({err[:40]})")
    report_path.write_bytes(("\r\n".join(lines) + "\r\n").encode("ascii"))
    return report_path


# ---------- CLI ----------

def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="peaktrace_core",
        description="In-house replacement for .bat files + Nucleics Auto PeakTrace RP (v1.1 trust-input, no extension)",
    )
    p.add_argument("--input-dir", required=True, type=Path,
                   help="Post-Seq7 folder (contains .ab1 + .seq with _C09 well-ID suffix)")
    p.add_argument("--output-dir", required=True, type=Path,
                   help="Where to write renamed .ab1 + .seq + 2-Report.xls")

    # v1.1: no trace processing knobs (cosmetic channel ops removed entirely)
    p.add_argument("--skip-shorter-than", type=int, default=500)
    p.add_argument("--set-abi-limits", action="store_true", default=True)

    # Output
    p.add_argument("--strip-well-id", action="store_true", default=True,
                   help="Drop _C09 / _H12 from filenames (matches PT, replaces .bat 1-)")
    p.add_argument("--no-strip-well-id", dest="strip_well_id", action="store_true")
    p.add_argument("--filename-suffix", default="")
    p.add_argument("--emit-seq", action="store_true", default=True,
                   help="Emit companion .seq file in PT format (default ON)")
    p.add_argument("--no-emit-seq", dest="emit_seq", action="store_true")
    p.add_argument("--write-qc-report", action="store_true", default=True,
                   help="Generate 2-Report.xls (replaces .bat 3-, default ON)")
    p.add_argument("--no-write-qc-report", dest="write_qc_report", action="store_true")

    # v1.2: Leading-base drop (matches PT's behavior on 83% of long reads)
    p.add_argument("--lead-drop-enabled", action="store_true", default=True,
                   help="Drop leading base when QV < --lead-drop-qv (matches PT, default ON)")
    p.add_argument("--no-lead-drop", dest="lead_drop_enabled", action="store_true")
    p.add_argument("--lead-drop-qv", type=int, default=5,
                   help="QV threshold for leading-base drop (default 5; PT drops when QV < ~5)")

    # v1.3: Re-basecall from DATA1-4 raw channels (recovers late reads)
    p.add_argument("--rebasecall-data14", action="store_true", default=False,
                   help="Re-basecall from DATA1-4 full-resolution channels, merged into Seq7 gaps")
    p.add_argument("--extend-min-snr", type=float, default=1.3,
                   help="Minimum SNR for re-basecalled peaks (default 1.3)")
    p.add_argument("--extend-stop-quiet", type=int, default=40,
                   help="Reserved for future tail-stop logic (default 40)")
    p.add_argument("--min-rebasecall-len", type=int, default=1000,
                   help="Only re-basecall reads with >= this many bases (default 1000; "
                        "shorter reads are already well-trimmed and extending them adds junk)")

    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    t_start = time.time()

    in_dir: Path = args.input_dir.resolve()
    out_dir: Path = args.output_dir.resolve()

    if not in_dir.is_dir():
        emit_event("error", message=f"input dir not found: {in_dir}")
        return 2
    out_dir.mkdir(parents=True, exist_ok=True)

    emit_event("run_start", input=str(in_dir), output=str(out_dir))

    ab1_files = sorted(in_dir.glob("*.ab1"))
    emit_event("discovered", n_files=len(ab1_files))

    ok_count = 0
    skip_count = 0
    err_count = 0
    results = []
    for src in ab1_files:
        r = process_one(src, out_dir, args)
        results.append(r)
        if r["status"] == "ok":
            ok_count += 1
        elif r["status"] == "skipped":
            skip_count += 1
        else:
            err_count += 1

    # Generate 2-Report.xls (replaces .bat 3-)
    if args.write_qc_report and ok_count + skip_count > 0:
        report_path = write_qc_report(out_dir, results, args)
        emit_event("report_written", path=str(report_path), ok=ok_count, skipped=skip_count)

    elapsed = time.time() - t_start
    emit_event("run_done", ok=ok_count, skipped=skip_count, errored=err_count,
               elapsed_seconds=round(elapsed, 2))
    return 0 if err_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
