"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.0
Date: Mar 08, 2026

Notes: Workflow for creating GenBank (.gb) files using BioPython. This workflow
    gives a standard .gb file with no additional annotations (only the insert
    is annotated). It is intended for preparing vector maps.
"""

import os
import pandas as pd
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord
from Bio import SeqIO
from Bio.SeqFeature import SeqFeature, FeatureLocation, CompoundLocation

from .helpers import get_row_for_jobid, get_field_from_row


class VectorMapPrepBioPython:
    def __init__(self, app_instance):
        self.app = app_instance
        self.log_queue = app_instance.log_queue

    def find_subsequence_location(self, seq, subseq):
        """
        Return (start, end, wrap) where start and end are 0-based positions in seq.
        If not found, return None. This search is case-insensitive.
        """
        if not subseq:
            return None
        s = seq.upper()
        sub = subseq.upper()
        idx = s.find(sub)
        if idx != -1:
            return (idx, idx + len(sub), False)
        # Check for wrap-around in a doubled sequence
        double = s + s
        idx2 = double.find(sub)
        if idx2 != -1 and idx2 < len(s):
            start = idx2
            end = idx2 + len(sub)
            return (start, end - len(s), True)
        return None

    def create_genbank_with_insert(self, jobid, seq_str, insert_seq, out_path):
        """
        Create a GenBank file, annotating the insert sequence.
        Returns (True, file_path) on success or (False, error_message) on failure.
        """
        seq_str = seq_str.strip().replace(" ", "").replace("\n", "").replace("\r", "")
        if not seq_str:
            return False, "Empty Final Vector sequence"

        seq = Seq(seq_str)
        record = SeqRecord(
            seq,
            id=str(jobid),
            name=str(jobid),
            description=f"{jobid} exported by script",
        )
        record.annotations["molecule_type"] = "DNA"
        record.annotations["topology"] = "circular"

        if insert_seq and insert_seq.strip():
            loc = self.find_subsequence_location(seq_str, insert_seq)
            if not loc:
                return False, "Insert sequence not found in Final Vector"

            start, end, is_wrap = loc
            qualifiers = {"label": "Insert", "note": "Insert sequence"}

            if is_wrap:
                qualifiers["note"] += " (wrap-around)"
                part1 = FeatureLocation(start, len(seq))
                part2 = FeatureLocation(0, end)
                feature_location = CompoundLocation([part1, part2], strand=1)
            else:
                feature_location = FeatureLocation(start, end, strand=1)

            feature = SeqFeature(
                feature_location, type="misc_feature", qualifiers=qualifiers
            )
            record.features.append(feature)

        out_file = os.path.join(out_path, f"{jobid}.gb")
        try:
            with open(out_file, "w") as fh:
                SeqIO.write(record, fh, "genbank")
            return True, out_file
        except Exception as e:
            return False, f"File write error: {e}"

    def run_processing_task(self, excel_path, output_dir, jobids):
        """The main processing logic for this workflow, run in a thread."""
        try:
            xls = pd.ExcelFile(excel_path, engine="openpyxl")
            sheet_names = xls.sheet_names
        except Exception as e:
            self.log_queue.put(
                ("ERROR", "Excel Read Error", f"Could not read Excel workbook: {e}")
            )
            return

        target_sheets = ["input addon", "Obsolete input addon(completed)"]
        sheets_to_load = [
            s for s in sheet_names if s.lower() in (ts.lower() for ts in target_sheets)
        ]

        if not sheets_to_load:
            self.log_queue.put(
                (
                    "ERROR",
                    "Sheets Missing",
                    f"Expected sheets not found: {target_sheets}",
                )
            )
            return

        dfs = {}
        for sheet in sheets_to_load:
            try:
                df = pd.read_excel(
                    excel_path, sheet_name=sheet, engine="openpyxl", dtype=object
                )
                dfs[sheet] = df
                self.log_queue.put(f"Loaded sheet: {sheet} ({len(df)} rows)")
            except Exception as e:
                self.log_queue.put(f"Warning: Failed to load sheet {sheet}: {e}")

        total = len(jobids)
        successes = 0
        failures = []
        for i, jid in enumerate(jobids, start=1):
            self.log_queue.put(f"[{i}/{total}] Processing JobID: {jid}")
            row = None
            for sheet in sheets_to_load:
                row = get_row_for_jobid(dfs.get(sheet), jid)
                if row is not None:
                    break

            if row is None:
                self.log_queue.put(f"  -> JobID {jid} not found. Skipping.")
                failures.append((jid, "Not found"))
                continue

            final_vector = get_field_from_row(
                row, ["Final Vector", "FinalVector"], fallback_index=8
            )
            insert_seq = get_field_from_row(
                row, ["Insert Seq", "InsertSeq"], fallback_index=7
            )

            if not final_vector:
                self.log_queue.put(f"  -> No 'Final Vector' for {jid}. Skipping.")
                failures.append((jid, "Final Vector missing"))
                continue

            ok, result = self.create_genbank_with_insert(
                jid, final_vector, insert_seq, output_dir
            )
            if ok:
                successes += 1
                self.log_queue.put(f"  -> Written: {result}")
            else:
                self.log_queue.put(f"  -> ERROR for {jid}: {result}")
                failures.append((jid, result))

        self.log_queue.put(
            f"\nProcessing complete. Successes: {successes}, Failures: {len(failures)}"
        )
        if failures:
            self.log_queue.put("Failure details:")
            for f_jid, reason in failures:
                self.log_queue.put(f"  - {f_jid}: {reason}")

        self.log_queue.put("DONE")
