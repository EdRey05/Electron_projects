"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.3
Date: Oct 16, 2026
Notes: v1.3 uppercases both sequences before the insert search
       (linear and circular passes; flanks are still cut from the
       original strings) -- vendor consensus files can carry
       lowercase bases a case-sensitive substring search misses.
       v1.2 renames the internal sequence variables to the
       canonical job-log naming (insert_sequence,
       final_vector_sequence). v1.1 adds the OD measurement
       table step. After In-House NewNames has
       inserted the QC gel image, this workflow locates the same image via
       the enzyme/expected-size row of the QC table, shrinks it (aspect
       ratio locked) to make room inside the height-locked gel row, and
       inserts the OD measurement table (OD260 | OD280 | OD260/OD280 |
       ug/uL) in the same cell directly below the image. The four OD
       values per zip are entered in the vector selection dialog
       alongside the vector FASTA path, with autofill from tab- or
       comma-separated OD txt files in the input folder matched by Work
       No. (BBI ID shown as fallback). Proceed stays disabled until every
       row has a validated FASTA (or Skip) and all 4 OD values. Table
       styling mirrors the delivered reports: thin borders, merged title
       row, autofit-to-contents cell widths, zero paragraph spacing, and
       the gel image resized within the row. v1.0: initial release.
       Post-processes In-House NewNames output for batch zips. Generates
       customer-shaped deliverable sequence files. Two-pass insert search
       (linear + circular `fv + fv` concat) handles plasmids where the
       insert sits at the wrap-point. Modal vector selection dialog with
       auto-discovery from the input folder, shared per-vector path
       cache, and inline descriptive validation (Wrong name, Wrong
       extension, Annotations present).
"""

import os
import re
import sys
import shutil
import zipfile
import tempfile
from typing import List, Tuple, Optional
from datetime import datetime
from enum import Enum, auto

import customtkinter as ctk
from tkinter import filedialog, messagebox
from docx import Document
from docx.shared import Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
import pythoncom
import win32com.client as win32


class ProcessStatus(Enum):
    SUCCESS = auto()
    SKIP_NO_BATCH = auto()
    SKIP_NO_DOC = auto()
    SKIP_FIELDS_MISSING = auto()
    SKIP_INSERT_NOT_FOUND = auto()
    SKIP_INSERT_MULTIPLE = auto()
    SKIP_USER_CANCELLED = auto()
    SKIP_UNEXPECTED = auto()


class BatchPostProcessing:
    """
    Post-processes the output of InHouseNewNames for batch zips:
    - Removes Special Growth Protocol.pdf
    - Renames the Word report (strips ' Gene Synthesis Report')
    - Renames <Work No>.txt -> <Work No> <BBI ID>.seq
    - Renames <Work No>.SEQ -> <Work No> <BBI ID>.fasta (rewrites first line)
    - Deletes <Work No>+<Vector>.SEQ
    - Renames <Work No>+<Vector>.txt -> <Work No>_<Vector>.seq
    - Creates <Work No> <Gene Name> _insert.txt with 100bp flanks on both sides
      (handles circular vectors via two-pass substring search)
    - Prompts user for <Vector>.fasta
    - Shrink the QC gel image (aspect ratio locked) and insert the 3x4 OD
      measurement table below it inside the same cell
    - Re-zips the inner folder
    """

    PROCESSED_FOLDERS_DIR_NAME = "2-processed_folders"
    OUTPUT_ZIPS_DIR_NAME = "3-output_zips"
    DOC_EXTENSION = ".doc"
    DOCX_EXTENSION = ".docx"
    WIN32_DOC_FORMAT = 0
    WIN32_DOCX_FORMAT = 16
    TEMP_DOCX_SUFFIX = "_temp.docx"
    INVALID_FILE_PREFIX = "~"
    SPECIAL_PDF_WORDS = ["special", "growth", "protocol"]
    GENE_SYNTHESIS_REPORT_STRIP = " Gene Synthesis Report"
    WORD_DOC_NAME_REPORT_SUBSTRING = "gene synthesis report"
    FLANK_BP = 100

    # --- OD table step (v1.1) --------------------------------------------
    QC_TABLE_INDEX = 1  # same QC table as In-House NewNames (doc.tables[1])
    OD_TABLE_HEADERS = ["OD260", "OD280", "OD260/OD280", "µg/µL"]
    OD_TABLE_TITLE = "OD measurement results:"
    # Gel shrink target in inches (aspect ratio locked). Sized so image +
    # OD table + the mandatory trailing paragraph fit inside the 8.7 cm
    # height-locked gel row with room to spare.
    OD_GEL_TARGET_WIDTH_IN = 3.00
    OD_GEL_TARGET_HEIGHT_IN = 2.60
    OD_ROW_HEIGHT_TWIPS = 284      # ~0.5 cm rows, matches the manual sample
    OD_BORDER_SZ = "6"             # 0.75pt thin black borders
    OD_BORDER_COLOR = "auto"
    OD_GRID_COLS = [682, 682, 1399, 897]  # twips, mirrors the manual sample

    def __init__(self, app_instance):
        self.app = app_instance
        self.log = self.app.log

    def create_ui(self, parent_frame):
        main_panel = ctk.CTkFrame(parent_frame, fg_color="transparent")
        main_panel.pack(fill="both", expand=True, padx=10, pady=10)
        info_text = (
            "Post-processes batch zips that have already been run through the In-House New Names workflow.\n"
            "Generates customer-shaped deliverable sequence files (.seq, .fasta, _insert.txt)."
        )
        ctk.CTkLabel(main_panel, text=info_text, justify="center").pack(anchor="center", pady=(20, 10))

    def validate_inputs(self) -> bool:
        if sys.platform != "win32":
            messagebox.showerror("Unsupported OS", "This workflow requires Windows.")
            return False
        return True

    def setup_default_paths(self):
        default_path = self.app.make_path_from_config('Paths', 'QC_Input_Folder')
        if default_path and os.path.isdir(default_path):
            self.app.input_folder.set(default_path)
            self.log(f"[OK] \t Default input folder found and set to: {default_path}")

    def run_processing_task(self):
        self.log("[INFO] \t Starting BATCH Post-Processing workflow...")
        input_folder = os.path.normpath(self.app.input_folder.get().strip())

        if sys.platform == "win32":
            pythoncom.CoInitialize()

        try:
            all_zips = [f for f in os.listdir(input_folder) if f.lower().endswith('.zip')]
            if not all_zips:
                self.log("[WARNING] \t No zip files found in the input directory.")
                return

            batch_zips = [z for z in all_zips if 'batch' in z.lower()]
            for z in all_zips:
                if z not in batch_zips:
                    self.log(f"[SKIP] \t '{z}' does not contain 'batch' -- skipping.")

            if not batch_zips:
                self.log("[FINISHED] \t No batch zips to process.")
                return

            self.log(f"[INFO] \t Found {len(batch_zips)} batch zip(s). Running preflight...")

            # --- Preflight: extract each batch zip and pull fields from the Word doc ---
            staging_root = os.path.join(os.path.dirname(input_folder), self.PROCESSED_FOLDERS_DIR_NAME)
            preflight_results = self.preflight_extract(input_folder, batch_zips, staging_root)

            # Filter out zips that failed preflight (no doc, missing fields, etc.)
            ready = [r for r in preflight_results if r['status'] == 'ready']
            for r in preflight_results:
                if r['status'] != 'ready':
                    self.log(f"[FAIL] \t '{r['zip_name']}': {r['status']} -- {r.get('reason', '')}")

            if not ready:
                self.log("[FINISHED] \t No batch zips passed preflight. Nothing to process.")
                self.app.process_button.configure(state="normal")
                return

            # --- Show vector selection dialog (modal) ---
            vector_assignments = self._show_vector_selection_dialog(
                ready, input_folder=input_folder
            )
            if vector_assignments is None:
                # User cancelled
                self.log("[FAIL] \t User cancelled vector selection dialog.")
                self.app.process_button.configure(state="normal")
                return

            # vector_assignments maps zip_stem -> {vector_fasta_path: str|None, skipped: bool}
            skipped_count = sum(1 for v in vector_assignments.values() if v.get('skipped'))
            proceed_count = len(ready) - skipped_count
            self.log(
                f"[INFO] \t Proceeding with {proceed_count} zip(s) "
                f"(skipped {skipped_count} via the vector dialog)."
            )

            # --- Process each ready zip using the validated vector fasta ---
            stats = {'processed': 0, 'skipped': 0, 'failed': 0}
            for r in ready:
                zip_name = r['zip_name']
                assignment = vector_assignments.get(r['zip_stem'], {})
                if assignment.get('skipped'):
                    self.log(f"[SKIP] \t '{zip_name}' was skipped in the vector dialog.")
                    stats['skipped'] += 1
                    continue
                vector_fasta_path = assignment.get('vector_fasta_path')
                if not vector_fasta_path:
                    self.log(f"[FAIL] \t '{zip_name}' has no vector fasta path assigned.")
                    stats['failed'] += 1
                    continue
                result = self.process_single_zip(
                    input_folder, zip_name, r, vector_fasta_path,
                    od_values=assignment.get('od_values'),
                )
                if result == ProcessStatus.SUCCESS:
                    stats['processed'] += 1
                else:
                    stats['failed'] += 1

            self.log(
                f"[SUMMARY] \t Processed: {stats['processed']} | "
                f"Skipped (user): {stats['skipped']} | "
                f"Failed: {stats['failed']}."
            )
            self.log("[FINISHED] \t BATCH Post-Processing workflow complete!")
        except Exception as e:
            self.log(f"[FATAL] \t An unexpected error occurred in the main task: {e}")
        finally:
            self.app.process_button.configure(state="normal")
            if sys.platform == "win32":
                pythoncom.CoUninitialize()

    # ------------------------------------------------------------------
    # Preflight: extract each batch zip and pull the four fields from the
    # Word doc. Returns a list of dicts with keys: zip_name, zip_stem,
    # work_no, bbi_id, gene_name, vector, inner_folder_path, doc_path,
    # status, reason.
    # ------------------------------------------------------------------

    def preflight_extract(self, input_folder: str, zip_names: List[str], staging_root: str) -> List[dict]:
        results = []
        for zip_name in zip_names:
            zip_stem = os.path.splitext(zip_name)[0]
            entry = {
                'zip_name': zip_name,
                'zip_stem': zip_stem,
                'work_no': None,
                'bbi_id': None,
                'gene_name': None,
                'vector': None,
                'inner_folder_path': None,
                'doc_path': None,
                'status': 'ready',
                'reason': '',
            }
            zip_path = os.path.join(input_folder, zip_name)
            staging_zip_dir = os.path.join(staging_root, zip_stem)
            try:
                if os.path.exists(staging_zip_dir):
                    shutil.rmtree(staging_zip_dir)
                os.makedirs(staging_zip_dir)
                with zipfile.ZipFile(zip_path, 'r') as z:
                    z.extractall(staging_zip_dir)
            except Exception as e:
                entry['status'] = 'extract_failed'
                entry['reason'] = str(e)
                results.append(entry)
                continue

            inner_folder = os.path.join(staging_zip_dir, zip_stem)
            if not os.path.isdir(inner_folder):
                entry['status'] = 'inner_folder_missing'
                entry['reason'] = f'Expected inner folder not found: {inner_folder}'
                results.append(entry)
                continue

            entry['inner_folder_path'] = inner_folder
            doc_path = self.find_report_document(inner_folder)
            if not doc_path:
                entry['status'] = 'no_doc'
                entry['reason'] = 'No Word report found'
                results.append(entry)
                continue
            entry['doc_path'] = doc_path

            try:
                doc_obj, _, word_app, temp_docx_path = self.open_doc(doc_path)
                if doc_obj is None:
                    entry['status'] = 'doc_open_failed'
                    entry['reason'] = 'Could not open Word doc'
                    results.append(entry)
                    continue
                try:
                    fields = self.extract_fields_from_doc(doc_obj)
                finally:
                    if word_app:
                        try:
                            word_app.Quit()
                        except Exception:
                            pass
                    if temp_docx_path and os.path.exists(temp_docx_path):
                        try:
                            os.remove(temp_docx_path)
                        except OSError:
                            pass
            except Exception as e:
                entry['status'] = 'doc_extract_failed'
                entry['reason'] = str(e)
                results.append(entry)
                continue

            entry['work_no'] = fields.get('Work_No')
            entry['bbi_id'] = fields.get('BBI_ID')
            entry['gene_name'] = fields.get('Gene_Name')
            entry['vector'] = fields.get('Vector')

            missing = [k for k in ('work_no', 'bbi_id', 'gene_name', 'vector') if not entry[k]]
            if missing:
                entry['status'] = 'fields_missing'
                entry['reason'] = f"Missing fields: {', '.join(missing)}"
                results.append(entry)
                continue

            self.log(
                f"[OK] \t Preflight '{zip_name}': "
                f"WorkNo={entry['work_no']}, BBI={entry['bbi_id']}, "
                f"GeneName={entry['gene_name']}, Vector={entry['vector']}"
            )
            results.append(entry)
        return results

    # ------------------------------------------------------------------
    # Modal vector selection dialog
    # ------------------------------------------------------------------

    def _show_vector_selection_dialog(self, ready: List[dict], input_folder: str = None):
        """
        Show a modal dialog with one row per preflight-passed zip.
        Each row: BBI ID label, expected filename label, file-path entry,
        4 OD value entries (OD260 / OD280 / OD260/OD280 / ug-uL, column
        headers shown above the first row), status label (✔ validated /
        ✖ invalid), Skip button. Proceed is disabled until every row is
        either validated or skipped AND all 4 OD values are filled
        (typing re-checks the gate live).
        Returns a dict {zip_stem: {'vector_fasta_path': str|None, 'skipped':
        bool, 'od_values': [str, str, str, str]}} or None if cancelled.

        If `input_folder` is provided, the dialog first scans that folder for
        files whose basename matches any expected vector filename and
        auto-fills those rows. After any successful Browse, the picked path is
        cached in a shared dict (keyed by basename) so rows needing the same
        vector also auto-fill.
        """
        result_holder = {'assignments': None, 'cancelled': False}
        rows = []  # list of per-row state dicts

        # Shared cache of picked / discovered vector FASTA paths keyed by basename
        # so rows needing the same vector inherit the selection.
        vector_paths_by_name = {}
        if input_folder and os.path.isdir(input_folder):
            for entry in ready:
                expected = f"{entry['vector']}.fasta"
                candidate = os.path.join(input_folder, expected)
                if os.path.isfile(candidate):
                    vector_paths_by_name[expected] = candidate

        # OD autodetect: scan txt files in the input folder for lines like
        # "Work No.\tOD260\tOD280\tOD260/OD280\tug/uL" (tab-separated,
        # NanoDrop-paste style). First column = Work No., then the 4 values.
        # A header row containing 'OD260' (any separator) is skipped.
        od_values_by_workno = {}
        if input_folder and os.path.isdir(input_folder):
            for fname in os.listdir(input_folder):
                if not fname.lower().endswith('.txt'):
                    continue
                fpath = os.path.join(input_folder, fname)
                try:
                    with open(fpath, 'r', encoding='utf-8', errors='replace') as fp:
                        for line in fp:
                            line = line.strip()
                            if not line:
                                continue
                            parts = [p.strip() for p in re.split(r'[\t,]', line)]
                            if len(parts) < 5:
                                continue
                            if 'od260' in parts[0].lower() or 'work no' in parts[0].lower():
                                continue  # header row
                            workno, values = parts[0], parts[1:5]
                            if workno and all(values):
                                od_values_by_workno[workno] = values
                except OSError:
                    continue

        dialog = ctk.CTkToplevel(self.app.master)
        dialog.title("Vector FASTA Selection & OD Values")
        dialog.geometry("1380x560")
        dialog.resizable(True, True)
        dialog.transient(self.app.master)
        dialog.grab_set()

        # Header
        ctk.CTkLabel(
            dialog,
            text="Select vector FASTA for each batch zip",
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color="#1F3A5F",
        ).pack(pady=(16, 4), padx=20)

        ctk.CTkLabel(
            dialog,
            text=(
                f"{len(ready)} batch zip(s) ready. "
                "Pick a vector FASTA per row, enter the 4 OD values, or Skip to exclude."
            ),
            justify="left",
            text_color="#444444",
        ).pack(pady=(0, 12), padx=20, fill="x")

        # Scrollable area for rows
        scroll = ctk.CTkScrollableFrame(dialog, height=320)
        scroll.pack(fill="both", expand=True, padx=20, pady=(0, 8))

        # Column header row (same grid metrics as the data rows below, so
        # the labels line up with the entries).
        header_frame = ctk.CTkFrame(scroll, fg_color="transparent")
        header_frame.pack(fill="x", padx=4, pady=(0, 2))
        header_frame.grid_columnconfigure(0, minsize=130, weight=0)
        header_frame.grid_columnconfigure(1, minsize=170, weight=0)
        header_frame.grid_columnconfigure(2, weight=1)
        header_frame.grid_columnconfigure(3, minsize=90, weight=0)
        header_frame.grid_columnconfigure(4, minsize=90, weight=0)
        header_frame.grid_columnconfigure(5, minsize=110, weight=0)
        header_frame.grid_columnconfigure(6, minsize=90, weight=0)
        header_frame.grid_columnconfigure(7, minsize=200, weight=0)
        header_frame.grid_columnconfigure(8, minsize=63, weight=0)
        header_frame.grid_columnconfigure(9, minsize=55, weight=0)
        header_labels = ["Work No.", "Vector", "FASTA path", "OD260", "OD280",
                         "OD260/OD280", "µg/µL", "Status", "", ""]
        # Header cells must resolve to the SAME column widths as the data
        # rows: explicit label widths == the row grid's column minsizes
        # (90/90/110/90 for the OD columns, 200 for Status), no sticky
        # stretching, and the Browse/Skip buttons below get their widths
        # pinned to the column minsizes too -- otherwise button/text natural
        # sizes grow the data-row columns and the headers drift.
        # Widths chosen so each header CELL equals the data-row CELL below:
        # label width + padx must not exceed the column minsize unless the
        # row widget + padx is wider (cols 0/1/3/4/6). col5: 106+4=110,
        # col7: 194+6=200 -- matching the row cells driven by the minsizes.
        header_widths = {0: 130, 1: 170, 2: None, 3: 90, 4: 90, 5: 106,
                         6: 90, 7: 194, 8: None, 9: None}
        for col, text in enumerate(header_labels):
            if text:
                lbl_kwargs = {}
                padx = (0, 6)
                anchor = "w"
                if col == 0:
                    padx = (10, 6)
                elif 3 <= col <= 6:
                    padx = (0, 4)
                    anchor = "center"
                if header_widths[col]:
                    lbl_kwargs["width"] = header_widths[col]
                    lbl_kwargs["anchor"] = anchor
                ctk.CTkLabel(
                    header_frame,
                    text=text,
                    font=ctk.CTkFont(size=12, weight="bold"),
                    text_color="#5A6B7F",
                    **lbl_kwargs
                ).grid(row=0, column=col, padx=padx, sticky="w" if col < 3 else "")

        def on_proceed_check():
            # Proceed is enabled when every row is resolved: vector path
            # validated OR skipped, and (if not skipped) all 4 OD values filled.
            for r in rows:
                if r['skipped']:
                    continue
                if not r['validated']:
                    proceed_btn.configure(state="disabled", fg_color="#9E9E9E")
                    return
                if any(not v.get().strip() for v in r['od_vars']):
                    proceed_btn.configure(state="disabled", fg_color="#9E9E9E")
                    return
            proceed_btn.configure(state="normal", fg_color="#2E7D32")

        def refresh_rows():
            """For any row still unresolved, see if its expected filename
            is now present in vector_paths_by_name. If so, auto-fill and
            re-validate. Done row-by-row so the dialog does not flicker."""
            for row in rows:
                if row['validated'] or row['skipped']:
                    continue
                expected = row['expected_name']
                if expected in vector_paths_by_name:
                    row['path_var'].set(vector_paths_by_name[expected])
                    self._row_validate(row, on_proceed_check)
            on_proceed_check()

        def on_proceed():
            # Build assignments from current row states
            assignments = {}
            for row in rows:
                assignments[row['zip_stem']] = {
                    'vector_fasta_path': row['vector_fasta_path'],
                    'skipped': row['skipped'],
                    'od_values': [v.get().strip() for v in row['od_vars']],
                }
            result_holder['assignments'] = assignments
            try:
                dialog.grab_release()
            except Exception:
                pass
            dialog.destroy()

        def on_cancel():
            result_holder['cancelled'] = True
            try:
                dialog.grab_release()
            except Exception:
                pass
            dialog.destroy()

        dialog.protocol("WM_DELETE_WINDOW", on_cancel)

        # Build one row per zip
        for entry in ready:
            row_frame = ctk.CTkFrame(scroll, fg_color=("#F4F7FB", "#1B2A3F"), corner_radius=6)
            row_frame.pack(fill="x", pady=4, padx=4)

            # Layout columns:
            #   0: Work No. label (fixed; falls back to BBI ID)
            #   1: Vector name (bold, dark — important info)
            #   2: File path entry (expands)
            #   3-6: OD260 / OD280 / OD260/OD280 / ug-uL value entries
            #   7: Status label (fixed)
            #   8: Browse button (fixed)
            #   9: Skip button (fixed)
            row_frame.grid_columnconfigure(0, minsize=130, weight=0)
            row_frame.grid_columnconfigure(1, minsize=170, weight=0)
            row_frame.grid_columnconfigure(2, weight=1)
            row_frame.grid_columnconfigure(3, minsize=90, weight=0)
            row_frame.grid_columnconfigure(4, minsize=90, weight=0)
            row_frame.grid_columnconfigure(5, minsize=110, weight=0)
            row_frame.grid_columnconfigure(6, minsize=90, weight=0)
            row_frame.grid_columnconfigure(7, minsize=200, weight=0)
            row_frame.grid_columnconfigure(8, minsize=63, weight=0)
            row_frame.grid_columnconfigure(9, minsize=55, weight=0)

            # Work No. (fallback: BBI ID when the doc has no Work No.).
            # Width pinned to the column minsize so this grid's fixed
            # columns match the header row's exactly.
            ctk.CTkLabel(
                row_frame,
                text=entry.get('work_no') or entry['bbi_id'],
                width=130,
                anchor="w",
                font=ctk.CTkFont(size=13, weight="bold"),
                text_color="#0B5394",
            ).grid(row=0, column=0, padx=(10, 6), pady=8, sticky="w")

            # Vector filename — important info, not grey
            expected_name = f"{entry['vector']}.fasta"
            ctk.CTkLabel(
                row_frame,
                text=expected_name,
                width=170,
                anchor="w",
                font=ctk.CTkFont(size=13, weight="bold"),
                text_color="#1A1A1A",
            ).grid(row=0, column=1, padx=(0, 6), pady=8, sticky="w")

            # File path entry (expands)
            path_var = ctk.StringVar()
            entry_widget = ctk.CTkEntry(
                row_frame,
                textvariable=path_var,
                placeholder_text="No file selected",
                fg_color=("#FFFFFF", "#2A3B55"),
                border_color=("#A0B4CC", "#3E5876"),
                border_width=2,
            )
            entry_widget.grid(row=0, column=2, padx=(0, 6), pady=8, sticky="ew")

            # OD value entries (4 per row: OD260, OD280, OD260/OD280, ug/uL).
            # Every keystroke re-checks the Proceed gate so the button lights
            # up the moment the fasta is validated AND all 4 values are in.
            # Autodetect: pre-fill from the input folder's OD txt (by Work No.)
            # and re-run the gate so Proceed lights immediately when both the
            # fasta and all values are already available.
            od_labels = ["OD260", "OD280", "OD260/OD280", "µg/µL"]
            autodetected_od = od_values_by_workno.get(entry.get('work_no'))
            od_vars = []
            for od_i, od_label in enumerate(od_labels):
                od_var = ctk.StringVar()
                if autodetected_od:
                    od_var.set(autodetected_od[od_i])
                od_var.trace_add("write", lambda *_a: on_proceed_check())
                od_vars.append(od_var)
                ctk.CTkEntry(
                    row_frame,
                    textvariable=od_var,
                    width=90,
                    placeholder_text=od_label,
                ).grid(row=0, column=3 + od_i, padx=(0, 4), pady=8)
            if autodetected_od:
                self.log(f"[OK] \t Autodetected OD values for '{entry.get('work_no')}': {', '.join(autodetected_od)}")

            # Status label
            status_label = ctk.CTkLabel(
                row_frame, text="", anchor="w", text_color="#666666",
            )
            status_label.grid(row=0, column=7, padx=(0, 6), pady=8, sticky="w")

            row = {
                'zip_stem': entry['zip_stem'],
                'expected_name': expected_name,
                'path_var': path_var,
                'entry_widget': entry_widget,
                'od_vars': od_vars,
                'status_label': status_label,
                'browse_btn': None,
                'skip_btn': None,
                'vector_fasta_path': None,
                'skipped': False,
                'validated': False,
            }

            # Browse button (blue). Width pinned to its column minsize (80)
            # plus the Skip button to 70, so the data-row grid resolves to
            # exactly the same column boundaries as the header row above
            # (button natural widths would otherwise grow columns 8/9 and
            # push the OD entries right, misaligning them from the headers).
            browse_btn = ctk.CTkButton(
                row_frame,
                text="Browse",
                width=55,
                fg_color="#2E6FB5",
                hover_color="#1F5594",
                text_color="#FFFFFF",
                command=lambda r=row: self._row_browse(
                    r, vector_paths_by_name, refresh_rows
                ),
            )
            row['browse_btn'] = browse_btn
            browse_btn.grid(row=0, column=8, padx=(0, 6), pady=8)

            # Skip button (amber)
            skip_btn = ctk.CTkButton(
                row_frame,
                text="Skip",
                width=45,
                fg_color="#C77700",
                hover_color="#A86400",
                text_color="#FFFFFF",
                command=lambda r=row: self._row_skip(r, rows, proceed_btn, on_proceed_check),
            )
            row['skip_btn'] = skip_btn
            skip_btn.grid(row=0, column=9, padx=(0, 10), pady=8)

            rows.append(row)

        # Bottom: Cancel (red) / Proceed (green), centered with spacer cols
        button_row = ctk.CTkFrame(dialog, fg_color="transparent")
        button_row.pack(pady=(0, 16), padx=20, fill="x")
        # 5 columns: spacer | Cancel | spacer | Proceed | spacer
        button_row.grid_columnconfigure(0, weight=1)
        button_row.grid_columnconfigure(2, weight=1)
        button_row.grid_columnconfigure(4, weight=1)

        cancel_btn = ctk.CTkButton(
            button_row,
            text="Cancel",
            fg_color="#B53028",
            hover_color="#922019",
            text_color="#FFFFFF",
            width=110,
            command=on_cancel,
        )
        cancel_btn.grid(row=0, column=1, padx=6, pady=4)

        proceed_btn = ctk.CTkButton(
            button_row,
            text="Proceed",
            fg_color="#2E7D32",
            hover_color="#1F5C24",
            text_color="#FFFFFF",
            width=110,
            command=on_proceed,
        )
        proceed_btn.grid(row=0, column=3, padx=6, pady=4)
        proceed_btn.configure(state="disabled", fg_color="#9E9E9E")

        # When the user types or pastes a path directly into the entry,
        # re-validate and re-check Proceed.
        for row in rows:
            row['path_var'].trace_add(
                "write",
                lambda *_args, r=row: self._row_validate(r, on_proceed_check),
            )

        dialog.bind("<Escape>", lambda _e: on_cancel())
        dialog.bind("<Return>", lambda _e: on_proceed() if str(proceed_btn.cget("state")) == "normal" else None)

        # Auto-populate rows whose expected file already lives in input_folder.
        # This also re-checks Proceed so it lights up green the moment a row
        # is resolved by the initial scan.
        refresh_rows()

        dialog.wait_window()

        if result_holder['cancelled'] or result_holder['assignments'] is None:
            return None
        return result_holder['assignments']

    def _row_browse(self, row, vector_paths_by_name=None, refresh_rows=None):
        """Open file dialog for a row, then validate. If vector_paths_by_name
        and refresh_rows are provided, the picked path is also added to the
        shared cache so other rows needing the same vector auto-fill."""
        from tkinter import filedialog as _fd
        initial_dir = os.path.dirname(row['path_var'].get()) if row['path_var'].get() else os.getcwd()
        path = _fd.askopenfilename(
            title=f"Select {row['expected_name']}",
            initialdir=initial_dir,
            filetypes=[("FASTA files", "*.fasta *.fa *.fna"), ("All files", "*.*")],
        )
        if not path:
            return
        row['path_var'].set(path)
        self._row_validate(row)
        # Share the picked path with rows needing the same vector
        if vector_paths_by_name is not None:
            basename = os.path.basename(path)
            if basename not in vector_paths_by_name:
                vector_paths_by_name[basename] = path
        if refresh_rows is not None:
            refresh_rows()

    def _row_validate(self, row, on_proceed_check=None):
        """Validate the currently-entered path for a row. Checks, in order:
            1. File exists on disk
            2. Basename matches the expected vector filename exactly
            3. Extension is a FASTA extension (.fasta / .fa / .fna)
            4. First line is exactly ">vector_name" with no description /
               annotations after the name
            5. Second line (the sequence) starts with DNA bases
        """
        path = row['path_var'].get().strip()
        # Reset visuals to neutral
        default_border = ctk.ThemeManager.theme["CTkEntry"]["border_color"]
        def fail(message):
            row['validated'] = False
            row['vector_fasta_path'] = None
            row['status_label'].configure(text=f"✖ {message}", text_color="#D32F2F")
            row['entry_widget'].configure(border_color="#D32F2F", border_width=2)
            if on_proceed_check is not None:
                on_proceed_check()

        if not path:
            row['validated'] = False
            row['vector_fasta_path'] = None
            row['status_label'].configure(text="", text_color="#666666")
            row['entry_widget'].configure(border_width=1, border_color=default_border)
            if on_proceed_check is not None:
                on_proceed_check()
            return

        if not os.path.isfile(path):
            fail("File not found")
            return

        basename = os.path.basename(path)

        # Wrong name first (most common user mistake)
        if basename != row['expected_name']:
            fail(f"Wrong name (expected {row['expected_name']})")
            return

        # Wrong extension
        if not basename.lower().endswith(('.fasta', '.fa', '.fna')):
            fail("Wrong extension")
            return

        # Read first two lines and check for annotations / DNA on line 2
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as fp:
                first_line = fp.readline()
                second_line = fp.readline()
        except OSError:
            fail("Cannot read file")
            return

        # Strip only the newline + trailing whitespace, NOT internal spaces,
        # so we can detect "more than just the name" on line 1.
        header = first_line.rstrip()
        # Valid header: starts with ">" followed by the vector name (the file
        # basename minus extension). Anything after that is an annotation.
        expected_header = f">{os.path.splitext(basename)[0]}"
        if header != expected_header:
            fail("Annotations present")
            return

        # Second line should be the raw DNA sequence (no annotation lines,
        # no empty body).
        sequence_line = second_line.strip()
        dna_bases = set("ACGTNacgtn")
        if not sequence_line:
            fail("Annotations present")
            return
        if not all(ch in dna_bases for ch in sequence_line):
            fail("Annotations present")
            return

        # All checks passed
        row['validated'] = True
        row['vector_fasta_path'] = path
        row['skipped'] = False
        row['status_label'].configure(text="✔ Validated", text_color="#2E7D32")
        row['entry_widget'].configure(border_color="#2E7D32", border_width=2)
        if on_proceed_check is not None:
            on_proceed_check()

    def _row_skip(self, row, all_rows, proceed_btn, on_proceed_check):
        row['skipped'] = True
        row['validated'] = True  # skipped counts as resolved
        row['vector_fasta_path'] = None
        row['path_var'].set("")
        for v in row['od_vars']:
            v.set("")
        row['status_label'].configure(text="— Skipped", text_color="#888888")
        row['entry_widget'].configure(border_width=1, border_color=ctk.ThemeManager.theme["CTkEntry"]["border_color"])
        row['entry_widget'].configure(state="disabled")
        row['browse_btn'].configure(state="disabled", fg_color="#9E9E9E", hover_color="#9E9E9E")
        row['skip_btn'].configure(state="disabled", text="Skipped", fg_color="#6E6E6E", hover_color="#6E6E6E")
        on_proceed_check()

    # ------------------------------------------------------------------
    # Per-zip processing
    # ------------------------------------------------------------------

    def process_single_zip(self, input_folder: str, zip_name: str, preflight_entry: dict = None, vector_fasta_path: str = None, od_values: List[str] = None) -> ProcessStatus:
        """
        Process a single batch zip. If `preflight_entry` is provided (from
        `preflight_extract`), re-use it instead of re-extracting the zip and
        re-parsing the Word doc.
        `vector_fasta_path` is the validated path to copy as <Vector>.fasta.
        `od_values` is the [OD260, OD280, OD260/OD280, ug/uL] list for the OD
        measurement table; None/short means the table is skipped.
        """
        zip_path = os.path.join(input_folder, zip_name)
        zip_stem = os.path.splitext(zip_name)[0]

        # Use preflight entry if available, otherwise do the extract+find ourselves
        if preflight_entry is not None:
            inner_folder = preflight_entry['inner_folder_path']
            doc_path = preflight_entry['doc_path']
            work_no = preflight_entry['work_no']
            bbi_id = preflight_entry['bbi_id']
            gene_name = preflight_entry['gene_name']
            vector = preflight_entry['vector']
        else:
            # Fallback: extract on the fly
            staging_zip_dir = os.path.join(os.path.dirname(input_folder), self.PROCESSED_FOLDERS_DIR_NAME, zip_stem)
            if os.path.exists(staging_zip_dir):
                shutil.rmtree(staging_zip_dir)
            os.makedirs(staging_zip_dir)
            try:
                with zipfile.ZipFile(zip_path, 'r') as z:
                    z.extractall(staging_zip_dir)
                self.log(f"[OK] \t Extracted {zip_name}")
            except Exception as e:
                self.log(f"[ERROR] \t Failed to extract {zip_name}: {e}")
                return ProcessStatus.SKIP_UNEXPECTED

            inner_folder = os.path.join(staging_zip_dir, zip_stem)
            if not os.path.isdir(inner_folder):
                self.log(f"[ERROR] \t Expected inner folder not found: {inner_folder}")
                return ProcessStatus.SKIP_UNEXPECTED

            doc_path = self.find_report_document(inner_folder)
            if not doc_path:
                self.log(f"[ERROR] \t No Word report found in {zip_stem}")
                return ProcessStatus.SKIP_NO_DOC

            try:
                doc_obj, _, word_app, temp_docx_path = self.open_doc(doc_path)
                if doc_obj is None:
                    return ProcessStatus.SKIP_NO_DOC
                try:
                    fields = self.extract_fields_from_doc(doc_obj)
                finally:
                    if word_app:
                        try:
                            word_app.Quit()
                        except Exception:
                            pass
                    if temp_docx_path and os.path.exists(temp_docx_path):
                        try:
                            os.remove(temp_docx_path)
                        except OSError:
                            pass
            except Exception as e:
                self.log(f"[ERROR] \t Failed to extract fields from {zip_name}: {e}")
                return ProcessStatus.SKIP_UNEXPECTED

            work_no = fields.get('Work_No')
            bbi_id = fields.get('BBI_ID')
            gene_name = fields.get('Gene_Name')
            vector = fields.get('Vector')

            if not all([work_no, bbi_id, gene_name, vector]):
                self.log(
                    f"[FAIL] \t Missing fields in {zip_name}: "
                    f"Work_No={work_no!r}, BBI_ID={bbi_id!r}, "
                    f"Gene_Name={gene_name!r}, Vector={vector!r}"
                )
                return ProcessStatus.SKIP_FIELDS_MISSING

            self.log(f"[INFO] \t Extracted: WorkNo='{work_no}', BBI_ID='{bbi_id}', GeneName='{gene_name}', Vector='{vector}'")

        # --- Run steps ---
        try:
            # Step 1: Remove Special Growth Protocol.pdf
            self.remove_special_growth_pdf(inner_folder)

            # Step 2: Rename Word doc (returns the current path afterwards)
            doc_path = self.rename_word_doc(inner_folder, doc_path)

            # Step 4: Rename <Work No>.txt -> <Work No> <BBI ID>.seq
            insert_sequence = self.rename_txt_to_seq(inner_folder, work_no, bbi_id)

            # Step 5: Rename <Work No>.SEQ -> <Work No> <BBI ID>.fasta
            self.rename_seq_to_fasta(inner_folder, work_no, bbi_id)

            # Step 6: Delete <Work No>+<Vector>.SEQ
            self.delete_plus_vector_seq(inner_folder, work_no, vector)

            # Step 7: Rename <Work No>+<Vector>.txt -> <Work No>_<Vector>.seq
            final_vector_sequence = self.rename_plus_vector_txt(inner_folder, work_no, vector)

            # Step 8: Create <Work No> <Gene Name> _insert.txt (with 100bp flanks)
            self.create_insert_with_flanks(inner_folder, work_no, gene_name, insert_sequence, final_vector_sequence)

            # Step 9: Copy <Vector>.fasta from validated path
            if vector_fasta_path:
                vector_fasta_result = self.copy_vector_fasta(inner_folder, vector, vector_fasta_path)
                if vector_fasta_result == ProcessStatus.SKIP_UNEXPECTED:
                    return vector_fasta_result
            else:
                self.log(f"[WARNING] \t No vector fasta path for '{zip_name}' -- proceeding without it.")

            # Step 10: Shrink gel image + insert OD measurement table
            if od_values and len(od_values) == 4 and all(v for v in od_values):
                self.insert_od_measurement_table(doc_path, od_values)
            else:
                self.log(f"[WARNING] \t No/missing OD values for '{zip_name}' -- skipping OD table insert.")

        except _InsertNotFoundError as e:
            self.log(f"[FAIL] \t {e}")
            self._blocking_dialog(
                f"Insert not found for '{work_no}'.\n\n"
                f"{e}\n\n"
                f"The other company likely produced a bad file. "
                f"This zip will be skipped -- please check what is going on."
            )
            return ProcessStatus.SKIP_INSERT_NOT_FOUND
        except _InsertMultipleFoundError as e:
            self.log(f"[FAIL] \t {e}")
            self._blocking_dialog(
                f"Insert found multiple times for '{work_no}'.\n\n"
                f"{e}\n\n"
                f"This zip will be skipped -- please check what is going on."
            )
            return ProcessStatus.SKIP_INSERT_NOT_FOUND
        except Exception as e:
            self.log(f"[ERROR] \t Unexpected error during post-processing of {zip_name}: {e}")
            return ProcessStatus.SKIP_UNEXPECTED

        # Step 10: Re-zip
        output_zip_dir = os.path.join(os.path.dirname(input_folder), self.OUTPUT_ZIPS_DIR_NAME)
        self.zip_processed_folder(inner_folder, output_zip_dir, zip_stem)

        return ProcessStatus.SUCCESS

    # ------------------------------------------------------------------
    # Step 10: Shrink gel image + insert OD measurement table
    # ------------------------------------------------------------------

    def _find_gel_cell(self, doc: Document):
        """Locate the QC gel cell: doc.tables[1], the row whose second cell
        mentions enzyme / expected size, first cell of that row. Mirrors the
        In-House NewNames identification logic. Returns the cell or None."""
        if len(doc.tables) <= self.QC_TABLE_INDEX:
            self.log(f"[WARNING] \t Word document has fewer than {self.QC_TABLE_INDEX + 1} tables; no QC table to annotate.")
            return None
        qc_table = doc.tables[self.QC_TABLE_INDEX]
        for row in qc_table.rows:
            cells = row.cells
            if len(cells) >= 2:
                info_text = cells[1].text.lower()
                if 'enzyme' in info_text or 'expected size' in info_text:
                    return cells[0]
        self.log("[WARNING] \t No enzyme/expected-size row found in the QC table; cannot locate gel image.")
        return None

    def _shrink_gel_image(self, gel_cell):
        """Uniformly scale the first inline picture in the cell so it fits
        within (OD_GEL_TARGET_WIDTH_IN x OD_GEL_TARGET_HEIGHT_IN), preserving
        the image's aspect ratio. Rewrites wp:extent and the inner a:ext so
        both stays consistent. Returns True if an image was rescaled."""
        W = qn('w:drawing')
        drawing = None
        for para in gel_cell.paragraphs:
            found = para._p.findall('.//' + qn('w:drawing'))
            if found:
                drawing = found[0]
                break
        if drawing is None:
            self.log("[WARNING] \t No gel image (w:drawing) found in the gel cell; skipping shrink + table insert.")
            return False

        extent = drawing.find('.//' + qn('wp:extent'))
        a_ext = drawing.find('.//' + qn('a:ext'))
        if extent is None:
            self.log("[WARNING] \t Gel image has no wp:extent; cannot resize.")
            return False

        try:
            cx = int(extent.get('cx'))
            cy = int(extent.get('cy'))
        except (TypeError, ValueError):
            self.log("[WARNING] \t Gel image has unreadable wp:extent values; cannot resize.")
            return False
        if cx <= 0 or cy <= 0:
            self.log("[WARNING] \t Gel image has invalid wp:extent values; cannot resize.")
            return False

        target_w = int(self.OD_GEL_TARGET_WIDTH_IN * 914400)
        target_h = int(self.OD_GEL_TARGET_HEIGHT_IN * 914400)
        scale = min(target_w / cx, target_h / cy)
        new_cx = int(cx * scale)
        new_cy = int(cy * scale)

        extent.set('cx', str(new_cx))
        extent.set('cy', str(new_cy))
        if a_ext is not None:
            a_ext.set('cx', str(new_cx))
            a_ext.set('cy', str(new_cy))

        self.log(
            f"[OK] \t Shrunk gel image (ratio locked): "
            f"{cx / 914400:.2f}x{cy / 914400:.2f} in -> {new_cx / 914400:.2f}x{new_cy / 914400:.2f} in"
        )
        return True

    def _style_od_table(self, table):
        """Apply the customer sample's styling: centered table, thin black
        borders on every cell, fixed row heights, title row merged across
        all 4 columns, bold header + title, zero paragraph spacing,
        autofit-to-contents layout."""
        tbl_el = table._tbl

        # Table-level: center alignment + cell margins to match the sample.
        # alignment uses python-docx's schema-aware w:jc placement; the
        # margins element is inserted before tblLook to keep tblPr order
        # valid (Word ignores mis-ordered tblPr children).
        tbl_pr = tbl_el.tblPr
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        cell_mar = OxmlElement('w:tblCellMar')
        for side in ('w:left', 'w:right'):
            mar = OxmlElement(side)
            mar.set(qn('w:w'), '30')
            mar.set(qn('w:type'), 'dxa')
            cell_mar.append(mar)
        tbl_look = tbl_pr.find(qn('w:tblLook'))
        if tbl_look is not None:
            tbl_look.addprevious(cell_mar)
        else:
            tbl_pr.append(cell_mar)

        # Column widths (twips), mirrors the manual sample's tblGrid
        for grid_col, width in zip(tbl_el.findall(qn('w:tblGrid') + '/' + qn('w:gridCol')), self.OD_GRID_COLS):
            grid_col.set(qn('w:w'), str(width))

        def set_borders(tc_pr):
            borders = tc_pr.find(qn('w:tcBorders'))
            if borders is None:
                borders = OxmlElement('w:tcBorders')
                tc_pr.append(borders)
            for side in ('w:top', 'w:left', 'w:bottom', 'w:right'):
                el = borders.find(qn(side))
                if el is None:
                    el = OxmlElement(side)
                    borders.append(el)
                el.set(qn('w:val'), 'single')
                el.set(qn('w:sz'), self.OD_BORDER_SZ)
                el.set(qn('w:space'), '0')
                el.set(qn('w:color'), self.OD_BORDER_COLOR)

        def set_row_height(tr, twips):
            tr_pr = tr.find(qn('w:trPr'))
            if tr_pr is None:
                tr_pr = OxmlElement('w:trPr')
                tr.insert(0, tr_pr)
            tr_height = tr_pr.find(qn('w:trHeight'))
            if tr_height is None:
                tr_height = OxmlElement('w:trHeight')
                tr_pr.append(tr_height)
            tr_height.set(qn('w:val'), str(twips))

        def remove_para_spacing(paragraph):
            """Equivalent of Word's Line & Paragraph Spacing -> Remove Space
            After Paragraph: zero space before/after so the table hugs the
            gel image instead of floating in white space."""
            p_pr = paragraph._p.get_or_add_pPr()
            spacing = p_pr.find(qn('w:spacing'))
            if spacing is None:
                spacing = OxmlElement('w:spacing')
                p_pr.append(spacing)
            spacing.set(qn('w:before'), '0')
            spacing.set(qn('w:after'), '0')

        for row in table.rows:
            set_row_height(row._tr, self.OD_ROW_HEIGHT_TWIPS)
            for cell in row.cells:
                tc = cell._tc
                tc_pr = tc.get_or_add_tcPr()
                set_borders(tc_pr)
                # Cell width auto (w=0, type=auto) -- this is what Word
                # writes on "Autofit to Contents". Without it the fixed
                # tcW dxa from the table template wins and Word keeps the
                # columns at their template width regardless of tblLayout.
                tcw = tc_pr.find(qn('w:tcW'))
                if tcw is None:
                    tcw = OxmlElement('w:tcW')
                    tc_pr.insert(0, tcw)
                tcw.set(qn('w:w'), '0')
                tcw.set(qn('w:type'), 'auto')
                for para in cell.paragraphs:
                    remove_para_spacing(para)
                    para.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    for run in para.runs:
                        run.bold = True

        # The values row (last row) is regular weight per the manual sample.
        for cell in table.rows[-1].cells:
            for para in cell.paragraphs:
                for run in para.runs:
                    run.bold = False

        # Autofit to Contents: let Word size the columns to their text so
        # nothing wraps (OD260/OD280 stays on one line). table.autofit=True
        # writes w:tblLayout at its correct schema position; do not append
        # it manually (wrong position = Word ignores it).
        table.autofit = True

    def insert_od_measurement_table(self, doc_path: str, od_values: List[str]):
        """Open the (already renamed) report docx, shrink the gel image, and
        insert the OD measurement table directly below it in the same cell.
        Non-blocking: any miss logs a warning and leaves the doc untouched."""
        try:
            doc = Document(doc_path)
            if doc_path.lower().endswith(self.DOC_EXTENSION):
                # Should not happen (Step 2 already renamed .doc reports);
                # guard anyway since python-docx cannot save legacy .doc.
                self.log(f"[WARNING] \t Report is legacy .doc ('{os.path.basename(doc_path)}') -- skipping OD table insert.")
                return
        except Exception as e:
            self.log(f"[WARNING] \t Could not open '{os.path.basename(doc_path)}' for OD table insert: {e}")
            return

        gel_cell = self._find_gel_cell(doc)
        if gel_cell is None:
            return

        if not self._shrink_gel_image(gel_cell):
            return

        table = gel_cell.add_table(rows=3, cols=4)

        # Row 0: title merged across all 4 columns
        title_cells = table.rows[0].cells
        merged = title_cells[0].merge(title_cells[3])
        merged.text = self.OD_TABLE_TITLE
        for run in merged.paragraphs[0].runs:
            run.bold = True

        # Row 1: headers
        for cell, header in zip(table.rows[1].cells, self.OD_TABLE_HEADERS):
            cell.text = header
            for run in cell.paragraphs[0].runs:
                run.bold = True

        # Row 2: values, verbatim from the dialog (regular weight)
        for cell, value in zip(table.rows[2].cells, od_values):
            cell.text = value

        self._style_od_table(table)

        # Remove Space After Paragraph on the gel cell's own paragraphs
        # (image paragraph + the mandatory trailing one) so image and table
        # sit tight inside the height-locked row.
        for para in gel_cell.paragraphs:
            p_pr = para._p.get_or_add_pPr()
            spacing = p_pr.find(qn('w:spacing'))
            if spacing is None:
                spacing = OxmlElement('w:spacing')
                p_pr.append(spacing)
            spacing.set(qn('w:before'), '0')
            spacing.set(qn('w:after'), '0')

        try:
            doc.save(doc_path)
            self.log(f"[OK] \t Inserted OD measurement table ({', '.join(od_values)}) into '{os.path.basename(doc_path)}'")
        except PermissionError:
            self.log(f"[ERROR] \t Could not save '{os.path.basename(doc_path)}' -- file may be open in Word. OD table not inserted.")
        except Exception as e:
            self.log(f"[ERROR] \t Failed to save OD table into '{os.path.basename(doc_path)}': {e}")

    # ------------------------------------------------------------------
    # Step 1: Remove Special Growth Protocol.pdf
    # ------------------------------------------------------------------

    def remove_special_growth_pdf(self, inner_folder: str):
        for f in os.listdir(inner_folder):
            if not f.lower().endswith('.pdf'):
                continue
            normalized = re.sub(r'[^a-z0-9]', '', f.lower())
            if all(w in normalized for w in self.SPECIAL_PDF_WORDS):
                full_path = os.path.join(inner_folder, f)
                try:
                    os.remove(full_path)
                    self.log(f"[OK] \t Deleted '{f}'")
                except OSError as e:
                    self.log(f"[WARNING] \t Could not delete '{f}': {e}")

    # ------------------------------------------------------------------
    # Step 2: Strip ' Gene Synthesis Report' from Word doc name
    # ------------------------------------------------------------------

    def rename_word_doc(self, inner_folder: str, current_doc_path: str) -> str:
        current_name = os.path.basename(current_doc_path)
        if self.GENE_SYNTHESIS_REPORT_STRIP not in current_name:
            self.log(f"[INFO] \t No '{self.GENE_SYNTHESIS_REPORT_STRIP}' in '{current_name}' -- leaving as-is.")
            return current_doc_path
        new_name = current_name.replace(self.GENE_SYNTHESIS_REPORT_STRIP, '')
        new_path = os.path.join(inner_folder, new_name)
        try:
            os.rename(current_doc_path, new_path)
            self.log(f"[OK] \t Renamed Word doc to '{new_name}'")
            return new_path
        except OSError as e:
            self.log(f"[WARNING] \t Could not rename Word doc: {e}")
            return current_doc_path

    # ------------------------------------------------------------------
    # Step 4: <Work No>.txt -> <Work No> <BBI ID>.seq (content unchanged)
    # ------------------------------------------------------------------

    def rename_txt_to_seq(self, inner_folder: str, work_no: str, bbi_id: str) -> str:
        src = os.path.join(inner_folder, f"{work_no}.txt")
        if not os.path.isfile(src):
            raise FileNotFoundError(f"Step 4: {src} not found.")
        with open(src, 'r', encoding='utf-8') as f:
            content = f.read()
        new_name = f"{work_no} {bbi_id}.seq"
        dst = os.path.join(inner_folder, new_name)
        with open(dst, 'w', encoding='utf-8') as f:
            f.write(content)
        os.remove(src)
        self.log(f"[OK] \t Renamed .txt -> '{new_name}'")
        return content.strip()

    # ------------------------------------------------------------------
    # Step 5: <Work No>.SEQ -> <Work No> <BBI ID>.fasta (rewrite first line)
    # ------------------------------------------------------------------

    def rename_seq_to_fasta(self, inner_folder: str, work_no: str, bbi_id: str):
        src = os.path.join(inner_folder, f"{work_no}.SEQ")
        if not os.path.isfile(src):
            raise FileNotFoundError(f"Step 5: {src} not found.")
        with open(src, 'r', encoding='utf-8') as f:
            lines = f.read().split('\n')
        if not lines:
            raise ValueError(f"Step 5: {src} is empty.")
        lines[0] = f">{work_no} {bbi_id}"
        new_content = '\n'.join(lines)
        new_name = f"{work_no} {bbi_id}.fasta"
        dst = os.path.join(inner_folder, new_name)
        with open(dst, 'w', encoding='utf-8') as f:
            f.write(new_content)
        os.remove(src)
        self.log(f"[OK] \t Renamed .SEQ -> '{new_name}' (rewrote first line to '>{work_no} {bbi_id}')")

    # ------------------------------------------------------------------
    # Step 6: Delete <Work No>+<Vector>.SEQ
    # ------------------------------------------------------------------

    def delete_plus_vector_seq(self, inner_folder: str, work_no: str, vector: str):
        target = os.path.join(inner_folder, f"{work_no}+{vector}.SEQ")
        if not os.path.isfile(target):
            self.log(f"[INFO] \t No '{work_no}+{vector}.SEQ' to delete.")
            return
        try:
            os.remove(target)
            self.log(f"[OK] \t Deleted '{work_no}+{vector}.SEQ'")
        except OSError as e:
            self.log(f"[WARNING] \t Could not delete '{work_no}+{vector}.SEQ': {e}")

    # ------------------------------------------------------------------
    # Step 7: <Work No>+<Vector>.txt -> <Work No>_<Vector>.seq (content unchanged)
    # ------------------------------------------------------------------

    def rename_plus_vector_txt(self, inner_folder: str, work_no: str, vector: str) -> str:
        src = os.path.join(inner_folder, f"{work_no}+{vector}.txt")
        if not os.path.isfile(src):
            raise FileNotFoundError(f"Step 7: {src} not found.")
        with open(src, 'r', encoding='utf-8') as f:
            content = f.read()
        new_name = f"{work_no}_{vector}.seq"
        dst = os.path.join(inner_folder, new_name)
        with open(dst, 'w', encoding='utf-8') as f:
            f.write(content)
        os.remove(src)
        self.log(f"[OK] \t Renamed '+Vector.txt' -> '{new_name}'")
        return content.strip()

    # ------------------------------------------------------------------
    # Step 8: Create <Work No> <Gene Name> _insert.txt with 100bp flanks
    #         (two-pass: linear, then circular concat)
    # ------------------------------------------------------------------

    def create_insert_with_flanks(
        self,
        inner_folder: str,
        work_no: str,
        gene_name: str,
        insert_sequence: str,
        final_vector_sequence: str,
    ):
        # Linear pass. Case-insensitive: consensus exports can carry
        # lowercase bases (mismatch/quality markers), so normalize both
        # strings before comparing; flanks are still cut from the
        # original (un-normalized) sequences.
        ins_u = insert_sequence.upper()
        fv_u = final_vector_sequence.upper()
        linear_count = fv_u.count(ins_u)
        if linear_count > 1:
            raise _InsertMultipleFoundError(
                f"Insert sequence '{work_no}' found {linear_count} times in final vector sequence -- expected exactly 1."
            )
        if linear_count == 1:
            s = fv_u.find(ins_u)
            buffer = final_vector_sequence
            mode = "linear"
        else:
            # Circular pass: concat fv + fv
            fv_concat = final_vector_sequence + final_vector_sequence
            if ins_u not in (fv_u * 2):
                raise _InsertNotFoundError(
                    f"Insert sequence '{work_no}' (len={len(insert_sequence)}) not found as substring of final vector sequence "
                    f"(len={len(final_vector_sequence)}) -- linear or circular (case-insensitive). Other company likely produced a bad file."
                )
            s = (fv_u * 2).find(ins_u)
            buffer = fv_concat
            mode = "circular"

        e = s + len(insert_sequence)
        flank_left = max(0, s - self.FLANK_BP)
        flank_right = min(len(buffer), e + self.FLANK_BP)
        flanked = buffer[flank_left:flank_right]

        actual_left_flank = s - flank_left
        actual_right_flank = flank_right - e
        if actual_left_flank < self.FLANK_BP or actual_right_flank < self.FLANK_BP:
            self.log(
                f"[WARN] \t Flank truncated for '{work_no}': "
                f"left={actual_left_flank}/{self.FLANK_BP}, right={actual_right_flank}/{self.FLANK_BP} (mode={mode})"
            )

        if ins_u not in flanked.upper():
            raise _InsertNotFoundError(
                f"Post-write validation: insert '{work_no}' not contained in flanked body (case-insensitive). Internal error."
            )

        new_name = f"{work_no} {gene_name} _insert.txt"
        dst = os.path.join(inner_folder, new_name)
        body = f">{work_no} {gene_name} _insert\n{flanked}"
        with open(dst, 'w', encoding='utf-8') as f:
            f.write(body)
        self.log(
            f"[OK] \t Created '{new_name}' ({len(flanked)} bp, mode={mode}, "
            f"delta_from_insert={len(flanked) - len(insert_sequence)})"
        )

    # ------------------------------------------------------------------
    # Step 9: Copy <Vector>.fasta from the validated path (set in the
    # vector selection dialog before the workflow runs the file-editing
    # steps). This is the new flow: no per-zip askopenfilename prompt.
    # ------------------------------------------------------------------

    def copy_vector_fasta(self, inner_folder: str, vector: str, vector_fasta_path: str) -> ProcessStatus:
        dst = os.path.join(inner_folder, f"{vector}.fasta")
        if os.path.isfile(dst):
            self.log(f"[INFO] \t '{vector}.fasta' already exists in inner folder -- skipping copy.")
            return ProcessStatus.SUCCESS
        try:
            shutil.copy2(vector_fasta_path, dst)
            self.log(f"[OK] \t Copied vector fasta to '{vector}.fasta'")
        except OSError as e:
            self.log(f"[ERROR] \t Failed to copy vector fasta: {e}")
            return ProcessStatus.SKIP_UNEXPECTED
        return ProcessStatus.SUCCESS

    # ------------------------------------------------------------------
    # Step 10: Re-zip the inner folder
    # ------------------------------------------------------------------

    def zip_processed_folder(self, inner_folder: str, output_dir: str, zip_stem: str):
        if not os.path.exists(output_dir):
            os.makedirs(output_dir)
        outer_folder = os.path.dirname(inner_folder)
        base_path = os.path.join(output_dir, zip_stem)
        output_zip = f"{base_path}.zip"
        if os.path.exists(output_zip):
            self.log(f"[WARNING] \t '{os.path.basename(output_zip)}' already exists -- refusing to overwrite.")
            return
        try:
            shutil.make_archive(base_path, 'zip', root_dir=outer_folder, base_dir=zip_stem)
            self.log(f"[OK] \t Zipped to '{os.path.basename(output_zip)}'")
        except Exception as e:
            self.log(f"[ERROR] \t Failed to zip '{zip_stem}': {e}")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def find_report_document(self, inner_folder: str) -> Optional[str]:
        all_docs = [
            f for f in os.listdir(inner_folder)
            if (f.lower().endswith(self.DOC_EXTENSION) or f.lower().endswith(self.DOCX_EXTENSION))
            and not f.startswith(self.INVALID_FILE_PREFIX)
        ]
        if not all_docs:
            return None
        if len(all_docs) == 1:
            self.log(f"[OK] \t Found report doc: '{all_docs[0]}'")
            return os.path.join(inner_folder, all_docs[0])
        # Multiple: pick by substring
        spaceless = self.WORD_DOC_NAME_REPORT_SUBSTRING.replace(' ', '')
        candidates = [
            f for f in all_docs
            if self.WORD_DOC_NAME_REPORT_SUBSTRING in f.lower() or spaceless in f.lower()
        ]
        if len(candidates) == 1:
            self.log(f"[OK] \t Selected report by substring match: '{candidates[0]}'")
            return os.path.join(inner_folder, candidates[0])
        chosen = sorted(candidates if candidates else all_docs)[0]
        self.log(f"[WARNING] \t Multiple Word docs, no unique substring match. Picking: '{chosen}'")
        return os.path.join(inner_folder, chosen)

    def open_doc(self, doc_path: str):
        is_doc_format = doc_path.lower().endswith(self.DOC_EXTENSION)
        word_app = None
        temp_docx_path = None
        try:
            if is_doc_format:
                word_app = win32.Dispatch('Word.Application')
                word_app.Visible = False
                temp_docx_path = os.path.splitext(doc_path)[0] + self.TEMP_DOCX_SUFFIX
                doc = word_app.Documents.Open(doc_path)
                if hasattr(doc, 'SaveAs2'):
                    doc.SaveAs2(temp_docx_path, FileFormat=self.WIN32_DOCX_FORMAT)
                else:
                    doc.SaveAs(temp_docx_path, FileFormat=self.WIN32_DOCX_FORMAT)
                doc.Close(False)
                return Document(temp_docx_path), True, word_app, temp_docx_path
            else:
                return Document(doc_path), False, None, None
        except Exception as e:
            self.log(f"[ERROR] \t Failed to open Word doc '{doc_path}': {e}")
            if word_app:
                try:
                    word_app.Quit()
                except Exception:
                    pass
            if temp_docx_path and os.path.exists(temp_docx_path):
                try:
                    os.remove(temp_docx_path)
                except OSError:
                    pass
            return None, False, None, None

    def extract_fields_from_doc(self, doc: Document) -> dict:
        fields = {}
        if not doc.tables:
            return fields
        table = doc.tables[0]
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells]
            for i, cell in enumerate(cells):
                low = cell.lower()
                if 'bbi id' in low and i + 1 < len(cells):
                    fields.setdefault('BBI_ID', cells[i + 1])
                if 'work no.' in low and i + 1 < len(cells):
                    fields.setdefault('Work_No', cells[i + 1])
                if 'gene name' in low and i + 1 < len(cells):
                    fields.setdefault('Gene_Name', cells[i + 1])
                if low == 'vector' and i + 1 < len(cells):
                    fields.setdefault('Vector', cells[i + 1])
        return fields

    def _blocking_dialog(self, message: str):
        try:
            messagebox.showerror("BATCH Post-Processing -- BLOCKING ERROR", message)
        except Exception as e:
            self.log(f"[WARNING] \t Could not show blocking dialog: {e}")


# ----------------------------------------------------------------------
# Internal exception types so the main loop can pattern-match
# ----------------------------------------------------------------------

class _InsertNotFoundError(Exception):
    pass


class _InsertMultipleFoundError(Exception):
    pass
