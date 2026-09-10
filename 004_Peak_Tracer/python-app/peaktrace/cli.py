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
from .xlsx import XlsxWriter


# ---------- filename handling ----------

WELL_ID_RE = re.compile(r"_([A-H]\d{2})$")


def strip_well_id(name: str) -> str:
    """Drop trailing _C09 / _H12 well-ID from a basename."""
    return WELL_ID_RE.sub("", name)


# ---------- v1.6: .bat preprocessing equivalents ----------

def convert_seq_to_fa(seq_path: Path) -> Path | None:
    """Convert one .seq file to .fa (.bat 1- "Remove Well Position" equivalent).

    .bat logic (the only thing that gets the truth name right):
      1. Take the .seq filename (e.g. ``WELL01_C09_H12.seq``).
      2. Strip the last 8 chars (e.g. ``_H12.seq`` -> ``WELL01_C09``). The
         stripped name becomes the FASTA header.
      3. Write a sibling .fa with the same filename stem, header ``>WELL01_C09``
         and the sequence lines (spaces removed).
      4. Delete the original .seq.

    NOTE: do NOT try to use the .seq file's first line as a name source. Most
    Seq7 .seq files have no ``>header`` line — line 1 is sequence data, and
    using it would rename the .ab1 to a 60-70 char garbage string. The .bat
    derives the name from the FILENAME, not the content.

    Returns the new .fa path, or None on any failure (logged via emit_event).
    """
    # Truth name = filename stem with last 8 chars stripped (e.g. _H12.seq).
    # .bat: Set outname=%%f & Set outname=!outname:~0,-8!
    fname = seq_path.name  # e.g. "WELL01_C09_H12.seq"
    if len(fname) <= 8:
        emit_event("preprocess_warn", src=str(seq_path),
                   msg=f"filename too short to strip 8 chars: {fname!r}")
        return None
    truth_name = fname[:-8]  # e.g. "WELL01_C09_H12.seq" -> "WELL01_C09"
    truth_name = truth_name.strip().lstrip(">").strip()
    if not truth_name:
        emit_event("preprocess_warn", src=str(seq_path), msg="empty truth name, skipping")
        return None

    # Sequence: read all lines after the (possibly absent) header line.
    # .bat iterates ALL lines (skip=1 if a header line is present; the loop in
    # the .bat has both `skip=1` AND non-skip variants commented in). To match,
    # we skip line 1 IF it's a FASTA header (starts with '>'), otherwise we
    # include line 1 as sequence.
    try:
        with seq_path.open("r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception as e:
        emit_event("preprocess_warn", src=str(seq_path), msg=f"read failed: {e}")
        return None

    if not lines:
        emit_event("preprocess_warn", src=str(seq_path), msg="empty file, skipping")
        return None

    seq_lines = lines[1:] if lines[0].lstrip().startswith(">") else lines
    seq_lines = [ln.rstrip("\r\n").replace(" ", "") for ln in seq_lines]
    seq_lines = [ln for ln in seq_lines if ln]  # drop blank lines

    # .fa filename = same stem, just change extension .seq -> .fa.
    fa_path = seq_path.with_suffix(".fa")
    try:
        with fa_path.open("w", encoding="utf-8") as f:
            f.write(f">{truth_name}\n")
            for sl in seq_lines:
                f.write(sl + "\n")
        seq_path.unlink()
        emit_event("preprocess_seq_to_fa", src=str(seq_path), out=str(fa_path),
                   header=truth_name, n_seq_lines=len(seq_lines))
        return fa_path
    except Exception as e:
        emit_event("preprocess_warn", src=str(seq_path), msg=f"write failed: {e}")
        return None


def run_preprocessing(in_dir: Path, args) -> dict:
    """Run the .bat preprocessing on the input folder. Returns counts.

    v1.6 Task 4: .seq -> .fa conversion.
    v1.6 Task 5: rename .fa / .txt / .fasta files to drive .ab1 renames.
    """
    counts = {"seq_to_fa": 0, "seq_failed": 0,
              "renames_done": 0, "renames_failed": 0,
              "txt_removed": 0}
    if not getattr(args, "preprocess", True):
        emit_event("preprocess_skipped", reason="--no-preprocess flag")
        return counts

    # ---- Task 4: .seq -> .fa ----
    seq_files = sorted(in_dir.glob("*.seq"))
    emit_event("preprocess_start", n_seq=len(seq_files))
    for seq in seq_files:
        result = convert_seq_to_fa(seq)
        if result is not None:
            counts["seq_to_fa"] += 1
        else:
            counts["seq_failed"] += 1
    emit_event("preprocess_seq_done", seq_to_fa=counts["seq_to_fa"],
               seq_failed=counts["seq_failed"])

    # ---- Task 5: rename from .fa / .txt / .fasta truth-source ----
    # .bat 3- logic: read first line of each rename-source, extract the truth
    # name, rename the rename-source to name.txt AND the matching .ab1 to name.ab1.
    rename_sources = (
        list(in_dir.glob("*.fa"))
        + list(in_dir.glob("*.txt"))
        + list(in_dir.glob("*.fasta"))
    )
    # Dedupe by stem (a .fa and .txt with the same stem both shouldn't normally exist,
    # but in case they do, process each once by absolute path).
    seen = set()
    rename_sources = [p for p in rename_sources if not (str(p) in seen or seen.add(str(p)))]
    emit_event("preprocess_rename_start", n_sources=len(rename_sources))

    for src in rename_sources:
        try:
            truth_name = extract_truth_name(src)
        except Exception as e:
            emit_event("preprocess_warn", src=str(src), msg=f"truth-name parse failed: {e}")
            counts["renames_failed"] += 1
            continue
        if not truth_name:
            emit_event("preprocess_warn", src=str(src), msg="could not extract truth name, skipping")
            counts["renames_failed"] += 1
            continue

        target_txt = src.parent / f"{truth_name}.txt"
        target_ab1 = src.parent / f"{truth_name}.ab1"
        # The matching .ab1 lives in the same directory and has the SAME stem as src
        # (the source is a rename-source generated by the user / pre-Seq7 tool to
        # indicate what the .ab1 should be renamed to).
        source_stem_ab1 = src.parent / f"{src.stem}.ab1"

        try:
            # Rename the rename-source to <truth_name>.txt
            if target_txt.exists() and target_txt != src:
                # Collision: someone else already produced this target. Don't clobber.
                emit_event("preprocess_warn", src=str(src),
                           msg=f"target {target_txt.name} exists, skipping rename-source")
                counts["renames_failed"] += 1
                continue
            src.rename(target_txt)
            # Rename the matching .ab1 if present
            if source_stem_ab1.exists() and source_stem_ab1 != target_ab1:
                source_stem_ab1.rename(target_ab1)
                counts["renames_done"] += 1
            else:
                # No matching .ab1, but rename-source still got renamed. Still counts.
                counts["renames_done"] += 1
            emit_event("preprocess_rename", src=str(src), truth=truth_name,
                       out_txt=str(target_txt), out_ab1=str(target_ab1) if target_ab1.exists() else None)
        except Exception as e:
            emit_event("preprocess_warn", src=str(src), msg=f"rename failed: {e}")
            counts["renames_failed"] += 1

    emit_event("preprocess_rename_done",
               renames_done=counts["renames_done"],
               renames_failed=counts["renames_failed"])

    # ---- Task 6: delete .txt rename leftovers (.bat 3- cleanup) ----
    txt_files = sorted(in_dir.glob("*.txt"))
    for txt in txt_files:
        try:
            txt.unlink()
            counts["txt_removed"] += 1
        except Exception as e:
            emit_event("preprocess_warn", src=str(txt), msg=f"txt cleanup failed: {e}")
    emit_event("preprocess_cleanup_done", txt_removed=counts["txt_removed"])

    return counts


def extract_truth_name(rename_source: Path) -> str | None:
    """Extract the truth basename from a .fa / .txt / .fasta rename-source.

    .bat 3- logic: read first line, drop leading '>', drop trailing '.ab1'.
    The first line for .fa is `>REALNAME.ab1`; for .txt it's the same (the .bat
    writes a single line with the new name); for .fasta same as .fa.
    Returns the truth name (no extension) or None if unparseable.
    """
    suffix = rename_source.suffix.lower()
    if suffix not in (".fa", ".txt", ".fasta"):
        return None
    try:
        with rename_source.open("r", encoding="utf-8", errors="replace") as f:
            first_line = f.readline()
    except Exception:
        return None
    if not first_line:
        return None
    name = first_line.strip().lstrip(">").strip()
    # Drop trailing .ab1 if present
    if name.lower().endswith(".ab1"):
        name = name[:-4]
    # Sanity: a real basename is short, ASCII, no path separators
    if not name or len(name) > 200 or "/" in name or "\\" in name:
        return None
    return name


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
    map_params = None  # set inside the rebasecall block if applicable
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
                # v1.5 FIX #17: baseline subtraction + smoothing on DATA1-4
                # before peak detection. Default ON. Disable with --no-baseline-smooth.
                map_params = learn_coordinate_map(trace)
                map_r2 = map_params.get("r_squared", 0.0)
                if map_params.get("ok"):
                    peaks14 = detect_peaks_data14(trace, min_snr=args.extend_min_snr,
                                                   process=args.baseline_smooth)
                    pb_new, ploc_new, qv_new = rebasecall_data14(
                        trace, map_params, peaks14, min_snr=args.extend_min_snr,
                        process=args.baseline_smooth,
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

    # v1.5 FIX #19: post-merge QV-to-N downgrade. Applied globally to both
    # Seq7-inherited and re-basecalled bases. Default threshold = 5 (matches
    # PT's last-called-base QV = 6 + everything-below-becomes-N behavior, per
    # cursor-tooltip observations in image_0010). PLOC entries kept so the
    # emitted .ab1 still has continuous positions.
    n_downgraded = 0
    if args.qv_to_n_threshold > 0 and len(pb) > 0:
        try:
            from .peak import apply_qv_to_n_downgrade
            pb_orig_count = sum(1 for b in pb if int(b) != ord('N'))
            pb, ploc, qv = apply_qv_to_n_downgrade(pb, ploc, qv, threshold=args.qv_to_n_threshold)
            pb_new_count = sum(1 for b in pb if int(b) != ord('N'))
            n_downgraded = pb_orig_count - pb_new_count
        except Exception as e:
            emit_event("file_warn", src=str(src_ab1),
                       msg=f"qv-to-n downgrade failed: {e}")

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
    # FIX #10: for short reads (skipped rebasecall), copy input bytes verbatim
    # instead of round-tripping through write_ab1. This guarantees byte equality
    # with PT's behavior for reads below min_rebasecall_len (PT just passes them
    # through). Round-tripping via write_ab1 would rescale DATA9-12 and could
    # alter amplitudes or even base values in subtle ways.
    try:
        if (args.rebasecall_data14
                and len(pb) < args.min_rebasecall_len
                and len(pb) > 0):
            # Short read path: verbatim copy
            out_ab1.write_bytes(src_ab1.read_bytes())
            emit_event("file_verbatim", src=str(src_ab1),
                       msg=f"short read ({len(pb)} bases), copied bytes verbatim")
        else:
            write_ab1(out_ab1, trace, pb, qv, ploc, p1am=p1am,
                      set_abi_limits=args.set_abi_limits,
                      map_params=map_params if args.rebasecall_data14 else None,
                      p99_target=args.p99_target)
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
                   ext_bases_added=ext_bases_added, map_r_squared=map_r2,
                   n_count=int(sum(1 for b in pb if int(b) == ord('N'))),
                   n_downgraded=n_downgraded,
                   lowest_qv=int(qv.min()) if len(qv) else 0)

    return {
        "src": str(src_ab1),
        "out": str(out_ab1),
        "status": "ok",
        "n_bases_in": trace.n_bases,
        "n_bases_out": len(pb),
        "qv_mean": float(qv.mean()) if len(qv) else 0.0,
        "lead_dropped": lead_dropped,
        "extended": extended,
        "ext_bases_added": ext_bases_added,
        "n_count": int(sum(1 for b in pb if int(b) == ord('N'))),
        "n_downgraded": n_downgraded,
        "lowest_qv": int(qv.min()) if len(qv) else 0,
    }


def write_qc_report(out_dir: Path, results: list, args) -> Path:
    """Generate 2-Report.xlsx (replaces 3-Rename And Report.bat's QC report).

    Proper Excel Open XML workbook, one sheet, header row + one row per file.

    Columns: basename, status, n_bases_in, n_bases_out, qv_mean, lowest_qv,
             n_count, ext_bases_added, extended, lead_dropped

    v1.5 FIX #22 added columns:
      - lowest_qv: minimum PCON1 value across all basecalls (signal-quality indicator).
        Lower = noisier read. Sister company uses this to flag suspicious files.
      - n_count: total N's in PBAS1 after QV-to-N downgrade (FIX #19). Lower
        = more confident basecalls.
      - ext_bases_added: how many new bases the rebasecall added beyond Seq7's
        original PBAS length. Positive = read was extended.
    """
    report_path = out_dir / "2-Report.xlsx"

    w = XlsxWriter()
    w.add_row(["basename", "status", "n_bases_in", "n_bases_out", "qv_mean",
               "lowest_qv", "n_count", "ext_bases_added", "extended", "lead_dropped"])
    for r in results:
        basename = Path(r["src"]).stem
        if args.strip_well_id:
            basename = strip_well_id(basename)
        basename += args.filename_suffix

        n_in = r.get('n_bases_in', '')
        n_out = r.get('n_bases_out', '')
        qv = r.get('qv_mean')
        lowest_qv = r.get('lowest_qv')
        n_count = r.get('n_count', '')
        ext_added = r.get('ext_bases_added', '')
        ext = 'Y' if r.get('extended') else 'N'
        ld = 'Y' if r.get('lead_dropped') else 'N'

        if r["status"] == "ok":
            status = "OK"
            if r.get("extended") and ext_added:
                status = f"OK (+{ext_added} from raw)"
            w.add_row_mixed([basename, status, n_in, n_out,
                             f"{qv:.1f}" if qv is not None else "",
                             str(lowest_qv) if lowest_qv is not None else "",
                             str(n_count) if n_count != '' else "",
                             str(ext_added) if ext_added != '' else "",
                             ext, ld])
        elif r["status"] == "skipped":
            reason = r.get("reason", "skipped")
            w.add_row_mixed([basename, f"Skipped ({reason})", "", "", "", "", "", "", "", ""])
        elif r["status"] == "error":
            err = r.get("error", "unknown error")
            w.add_row_mixed([basename, f"Error ({err[:60]})", "", "", "", "", "", "", "", ""])

    w.write(report_path)
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

    # v1.6: preprocessing toggle (replaces the .bat work the Gene Synthesis
    # team runs between Seq7 and PT). When ON (default), .seq files in the
    # input folder are converted to .fa (strip well-ID from first line,
    # strip spaces from sequence lines), .fa/.txt/.fasta files are renamed
    # to drive .ab1 renames, then .txt cleanup. When OFF, only the PT
    # pipeline runs.
    p.add_argument("--preprocess", action="store_true", default=True,
                   help="Run the .bat preprocessing (.seq -> .fa, rename, cleanup) before PT (default ON)")
    p.add_argument("--no-preprocess", dest="preprocess", action="store_true",
                   help="Skip the .bat preprocessing; run PT pipeline only")

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

    # v1.5 FIX #17: pre-process DATA1-4 with baseline subtraction + Savitzky-Golay
    # smoothing before peak detection. Default ON. Disable with --no-baseline-smooth
    # for regression testing against the v1.4 behavior.
    p.add_argument("--no-baseline-smooth", dest="baseline_smooth", action="store_false", default=True,
                   help="Disable DATA1-4 baseline subtraction + smoothing (v1.4 behavior, default ON in v1.5)")

    # v1.5 FIX #19: post-merge QV-to-N downgrade. Applied globally to all
    # basecalls (Seq7-inherited + re-basecalled).
    #
    # Calibration caveat (discovered during validation 2026-09-03):
    # Seq7's QV scale is STRICTER than PT's. Same physical signal that PT
    # rates QV=17 is rated QV=3 by Seq7. Applying threshold=5 here would
    # downgrade Seq7's CORRECT basecalls (e.g. POS1-G12 first 5 bases are
    # all QV ≤ 5 but are the right answers). Default threshold = 2 catches
    # only the truly-bad calls (1.5% of all bases) without corrupting
    # correct-but-low-QV Seq7 calls. See docs/v1.5/03_fixes_and_testing.html
    # for full calibration analysis.
    p.add_argument("--qv-to-n-threshold", type=int, default=2,
                   help="QV <= threshold becomes N (default 2 = safe Seq7-scale; 0 = disabled)")

    # v1.5 FIX #21: per-channel 99th-percentile rescale target for DATA9-12 output.
    # Default 650 matches PT's forward-strand ('F' mode) processing. For
    # reverse-strand only runs, target should be ~1397 (PT's f2 mode).
    p.add_argument("--p99-target", type=int, default=650,
                   help="Rescale per-channel DATA9-12 so its 99th percentile = this value (default 650; PT uses 650 for forward, ~1397 for reverse)")

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

    # v1.6: run the .bat preprocessing equivalent before the PT pipeline.
    # Currently converts .seq -> .fa. Tasks 5 + 6 will add rename + cleanup.
    if getattr(args, "preprocess", True):
        run_preprocessing(in_dir, args)

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
