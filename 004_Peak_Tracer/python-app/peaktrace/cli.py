"""CLI for v1.9. Naming is planned without mutating source files."""
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
from .provenance import processor_identity


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
    Seq7 .seq files have no ``>header`` line â€” line 1 is sequence data, and
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

def process_one(src_ab1: Path, out_dir: Path, args, output_name=None) -> dict:
    """Analyze and serialize once; all exports share the final result."""
    from .analysis import analyze
    from .naming import output_stem
    import hashlib
    emit_event("file_start", src=str(src_ab1), name=src_ab1.name)
    try:
        trace = read_ab1(src_ab1)
        emit_event("file_loaded", src=str(src_ab1), n_scans=trace.n_scans, n_bases_in=trace.n_bases)
        if trace.n_bases < args.skip_shorter_than:
            reason = f"shorter than {args.skip_shorter_than} bases"
            emit_event("file_skip", src=str(src_ab1), reason=reason)
            return {"src": str(src_ab1), "status": "skipped", "reason": reason}
        result = analyze(trace, args)
        name = output_name or output_stem(src_ab1, args)
        out_dir.mkdir(parents=True, exist_ok=True)
        out_ab1 = out_dir / (name + ".ab1")
        out_seq = out_dir / (name + ".seq")
        out_evidence = out_dir / (name + ".evidence.json")
        evidence = None
        if getattr(args,'write_evidence',False):
            if out_evidence.exists():raise ValueError('Evidence output already exists')
            from .evidence import measure_evidence
            evidence=measure_evidence(trace,result.channels,args)
        if out_ab1.exists() or (args.emit_seq and out_seq.exists()):
            raise ValueError("Output already exists; choose a fresh result folder")
        provenance = {**processor_identity(),
                      "source_sha256": hashlib.sha256(src_ab1.read_bytes()).hexdigest(),
                      "call_set": trace.call_set, "base_order": trace.base_order,
                      "clear_range_half_open": result.clear_range,
                      "parameters": {k:str(v) if isinstance(v,Path) else v for k,v in vars(args).items()},
                      **result.diagnostics}
        # Complete and validate in a private staging folder before promoting files.
        import tempfile
        with tempfile.TemporaryDirectory(prefix=".trace-", dir=out_dir) as temporary:
            staged = Path(temporary) / out_ab1.name
            gain = write_ab1(staged, trace, result.bases, result.qualities, result.positions,
                            channels=result.channels, clear_range=result.clear_range,
                            set_abi_limits=args.set_abi_limits, p99_target=args.p99_target,
                            provenance=provenance)
            reread = read_ab1(staged)
            if not (np.array_equal(reread.pb_in, result.bases) and
                    np.array_equal(reread.ploc_in, result.positions) and
                    np.array_equal(reread.qv_in, result.qualities)):
                raise ValueError("AB1 round-trip validation failed")
            if args.emit_seq:
                write_seq(staged.with_suffix(".seq"), result.bases, format=args.seq_format,
                          clear_range=result.clear_range if args.seq_range=="clear" else None)
            if evidence is not None:
                evidence['provenance']=provenance
                staged.with_suffix('.evidence.json').write_text(json.dumps(evidence,allow_nan=False),encoding='utf-8')
            staged.rename(out_ab1)
            if args.emit_seq: staged.with_suffix(".seq").rename(out_seq)
            if evidence is not None:staged.with_suffix('.evidence.json').rename(out_evidence)
        if args.write_sidecar_trace:
            from .sidecar import write_sidecar_trace
            write_sidecar_trace(out_dir, name, {i+1:result.channels[9+i] for i in range(4)},
                                base_order=trace.base_order, coordinate_system="analyzed")
        pb,qv=result.bases,result.qualities
        row={"src":str(src_ab1),"out":str(out_ab1),"status":"ok",
             "n_bases_in":trace.n_bases,"n_bases_out":len(pb),
             "qv_mean":float(qv.mean()) if len(qv) else 0.,
             "lowest_qv":int(qv.min()) if len(qv) else 0,
             "n_count":int(np.count_nonzero(pb==ord("N"))),
             "q20":int(np.count_nonzero(qv>=20)), "q30":int(np.count_nonzero(qv>=30)),
             "clear_start":result.clear_range[0],"clear_end":result.clear_range[1],
             "lead_dropped":result.diagnostics["lead_dropped"],
             "n_downgraded":result.diagnostics["n_downgraded"],
             "extended":False,"ext_bases_added":0,
             "revised_bases":len(result.diagnostics["revised_calls"]),
             "display_gain":gain, "analysis":result.diagnostics}
        if evidence is not None:
            row['evidence']=str(out_evidence)
            row['evidence_summary']=evidence['summary']
        emit_event("file_done",**{k:v for k,v in row.items() if k!="status"})
        return row
    except Exception as exc:
        emit_event("file_error",src=str(src_ab1),error=str(exc))
        return {"src":str(src_ab1),"status":"error","error":str(exc)}


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
        basename = Path(r["out"]).stem if r.get("out") else Path(r["src"]).stem

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

from .config import parse_args


def main(argv=None) -> int:
    from .naming import plan_batch
    args=parse_args(argv)
    started=time.time()
    in_dir=args.input_dir.resolve();out_dir=args.output_dir.resolve()
    try:
        if not in_dir.is_dir():raise ValueError(f"Input folder not found: {in_dir}")
        plan=plan_batch(in_dir,out_dir,args)
        if not plan:raise ValueError("No AB1 inputs found")
    except (ValueError,OSError) as exc:
        emit_event("error",message=str(exc))
        return 2
    out_dir.mkdir(parents=True,exist_ok=True)
    emit_event("run_start",input=str(in_dir),output=str(out_dir))
    parameters={k:str(v) if isinstance(v,Path) else v for k,v in vars(args).items()}
    emit_event("effective_parameters",parameters=parameters)
    emit_event("discovered",n_files=len(plan))
    emit_event("preprocess_planned",enabled=args.preprocess,source_preserved=True,
               names=[{"input":src.name,"output":name+".ab1"} for src,name in plan])
    results=[process_one(src,out_dir,args,name) for src,name in plan]
    manifest={**processor_identity(),"parameters":parameters,"files":results}
    (out_dir/"run_manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    counts={status:sum(r["status"]==status for r in results) for status in ("ok","skipped","error")}
    if args.write_qc_report:
        write_qc_report(out_dir,results,args)
    emit_event("run_done",ok=counts["ok"],skipped=counts["skipped"],errored=counts["error"],
               elapsed_seconds=round(time.time()-started,2))
    return int(counts["error"]>0)


if __name__ == "__main__":
    sys.exit(main())
