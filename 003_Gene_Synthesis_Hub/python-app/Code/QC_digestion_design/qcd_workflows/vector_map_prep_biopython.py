"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.1
Date: Oct 31, 2026
Notes: Bug-fix pass on the .gb writer. Wrap-around insert features now build
    a CompoundLocation with strand on its parts (the previous strand=kwarg
    call raised TypeError and killed the run thread without ever posting
    DONE). The whole run body is wrapped in try/finally so DONE is always
    posted, per-Work-No. errors are caught and reported as failures instead
    of aborting the run, the insert sequence is cleaned like the vector
    before matching, sheet search follows a fixed 'input addon'-first
    priority, the fired column resolution (name vs positional fallback) is
    logged, and the workbook handle is closed.
"""

import os
import pandas as pd
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord
from Bio import SeqIO
from Bio.SeqFeature import SeqFeature, FeatureLocation, CompoundLocation

from .helpers import normalize_column_lookup, get_row_for_work_no, get_field_from_row


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

    def create_genbank_with_insert(self, work_no, seq_str, insert_sequence, out_path):
        """
        Create a GenBank file, annotating the insert sequence.
        Returns (True, file_path) on success or (False, error_message) on failure.
        """
        seq_str = seq_str.strip().replace(" ", "").replace("\n", "").replace("\r", "")
        if not seq_str:
            return False, "Empty Final Vector Sequence"

        seq = Seq(seq_str)
        record = SeqRecord(
            seq,
            id=str(work_no),
            name=str(work_no),
            description=f"{work_no} exported by script",
        )
        record.annotations["molecule_type"] = "DNA"
        record.annotations["topology"] = "circular"

        if insert_sequence and insert_sequence.strip():
            loc = self.find_subsequence_location(seq_str, insert_sequence)
            if not loc:
                return False, "Insert sequence not found in Final Vector Sequence"

            start, end, is_wrap = loc
            qualifiers = {"label": "Insert", "note": "Insert sequence"}

            if is_wrap:
                qualifiers["note"] += " (wrap-around)"
                part1 = FeatureLocation(start, len(seq), strand=1)
                part2 = FeatureLocation(0, end, strand=1)
                feature_location = CompoundLocation([part1, part2])
            else:
                feature_location = FeatureLocation(start, end, strand=1)

            feature = SeqFeature(
                feature_location, type="misc_feature", qualifiers=qualifiers
            )
            record.features.append(feature)

        out_file = os.path.join(out_path, f"{work_no}.gb")
        try:
            with open(out_file, "w") as fh:
                SeqIO.write(record, fh, "genbank")
            return True, out_file
        except Exception as e:
            return False, f"File write error: {e}"

    def _log_column_provenance(self, df, sheet):
        """Log which resolution path fired for every consumed column so a
        workbook column move is visible in the run log instead of silently
        switching to the positional fallback."""
        checks = [
            (["Work No.", "JobID", "Job Id", "Job_ID", "jobid"], None, "Work No."),
            (
                ["Final Vector Sequence", "Final Vector", "FinalVector"],
                8,
                "Final Vector Sequence",
            ),
            (["Insert Sequence", "Insert Seq", "InsertSeq"], 7, "Insert Sequence"),
        ]
        for candidates, fallback, label in checks:
            named = normalize_column_lookup(df, candidates)
            if named is not None:
                self.log_queue.put(
                    f"  [{sheet}] {label}: resolved by name (column '{named}')"
                )
            elif fallback is not None:
                self.log_queue.put(
                    f"  [{sheet}] {label}: header not recognized, "
                    f"using positional fallback column index {fallback}"
                )

    @staticmethod
    def _clean_sequence(seq_str):
        return str(seq_str).replace(" ", "").replace("\n", "").replace("\r", "")

    def run_processing_task(self, excel_path, output_dir, work_nos):
        """The main processing logic for this workflow, run in a thread."""
        xls = None
        try:
            try:
                xls = pd.ExcelFile(excel_path, engine="openpyxl")
                sheet_names = xls.sheet_names
            except Exception as e:
                self.log_queue.put(
                    ("ERROR", "Excel Read Error", f"Could not read Excel workbook: {e}")
                )
                return
            finally:
                if xls is not None:
                    try:
                        xls.close()
                    except Exception:
                        pass

            # Fixed precedence: the live 'input addon' sheet is always
            # searched first, the completed historical sheet after it,
            # regardless of tab order in the workbook.
            priority_sheets = ["input addon", "Obsolete input addon(completed)"]
            sheets_to_load = [
                t
                for t in priority_sheets
                if any(s.lower() == t.lower() for s in sheet_names)
            ]

            if not sheets_to_load:
                self.log_queue.put(
                    (
                        "ERROR",
                        "Sheets Missing",
                        f"Expected sheets not found: {priority_sheets}",
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
                    self._log_column_provenance(df, sheet)
                except Exception as e:
                    self.log_queue.put(f"Warning: Failed to load sheet {sheet}: {e}")

            total = len(work_nos)
            successes = 0
            failures = []
            for i, work_no in enumerate(work_nos, start=1):
                self.log_queue.put(f"[{i}/{total}] Processing Work No.: {work_no}")
                row = None
                for sheet in sheets_to_load:
                    row = get_row_for_work_no(dfs.get(sheet), work_no)
                    if row is not None:
                        break

                if row is None:
                    self.log_queue.put(f"  -> Work No. {work_no} not found. Skipping.")
                    failures.append((work_no, "Not found"))
                    continue

                final_vector_sequence = get_field_from_row(
                    row, ["Final Vector Sequence", "Final Vector", "FinalVector"], fallback_index=8
                )
                insert_sequence = get_field_from_row(
                    row, ["Insert Sequence", "Insert Seq", "InsertSeq"], fallback_index=7
                )

                if not final_vector_sequence:
                    self.log_queue.put(f"  -> No 'Final Vector Sequence' for {work_no}. Skipping.")
                    failures.append((work_no, "Final Vector Sequence missing"))
                    continue

                # Clean the insert exactly like the vector before matching so
                # whitespace inside the cell can never cause a false miss.
                if insert_sequence:
                    insert_sequence = self._clean_sequence(insert_sequence)

                try:
                    ok, result = self.create_genbank_with_insert(
                        work_no, final_vector_sequence, insert_sequence, output_dir
                    )
                except Exception as e:
                    # A per-item failure is reported and the run continues.
                    ok, result = False, f"Processing error: {e}"

                if ok:
                    successes += 1
                    self.log_queue.put(f"  -> Written: {result}")
                else:
                    self.log_queue.put(f"  -> ERROR for {work_no}: {result}")
                    failures.append((work_no, result))

            self.log_queue.put(
                f"\nProcessing complete. Successes: {successes}, Failures: {len(failures)}"
            )
            if failures:
                self.log_queue.put("Failure details:")
                for f_work_no, reason in failures:
                    self.log_queue.put(f"  - {f_work_no}: {reason}")
        finally:
            # Always posted, even when an unexpected error kills the run
            # body, so the queue pump can re-enable the Process button.
            self.log_queue.put("DONE")
