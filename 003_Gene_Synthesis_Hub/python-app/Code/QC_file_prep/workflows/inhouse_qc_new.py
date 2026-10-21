"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.2
Date: Oct 13, 2026
Notes: New workflow: builds QC zip packages from scratch for in-house genes.
    - Paste multiple Work No. (one per line), batch style (like QC Digestion Design).
    - Pulls fields from the Job Log ("Initiated" sheet) per Work No.
    - Pulls reference .txt/.SEQ files and .ab1 files from the Sorted_Sequencing_Files dir
      (folder "{Work No.}.{Plasmid No.}", resolved via default_directories.ini).
    - Generates the report docx from Templates/QC_zip_template/Gene Synthesis Report.docx.
    - Copies INSTRUCTIONS-V4.pdf (all); Special Growth Protocol.pdf (skip for fragments).
    - Asks for the user-provided alignment PDF + SQD (DNAStar output) per Work No.
    - Names the zip/inner folder: "{Work No.} {BBI ID} in {Vector} {PrepDate} {TubeID stripped}".
    - Internal Job Log column names are the canonical ones ('Quantity',
      'Temperature'); INITIATED_COLMAP + SHIPPING_LOG_COLMAP remap legacy
      'Plasmid Qty.'/'Amount'/'Growth Condition' headers onto them on load.
"""

import os
import shutil
import zipfile
from datetime import date
from typing import Tuple

import customtkinter as ctk
from docx import Document
from tkinter import messagebox, filedialog

WORKFLOW_DIR = os.path.dirname(os.path.abspath(__file__))
CODE_DIR = os.path.dirname(WORKFLOW_DIR)
GENE_SYNTHESIS_HUB_DIR = os.path.dirname(CODE_DIR)
TEMPLATE_DIR = os.path.join(
    os.path.dirname(GENE_SYNTHESIS_HUB_DIR), "Templates", "QC_zip_template"
)

FRAGMENT_VECTOR = "DNA Fragment - No Vector"


class InHouseQcNew:
    """Builds QC zip packages from scratch for in-house genes.

    Per Work No.: Job Log row -> names + docx fields;
    Sorted_Sequencing_Files -> reference txt/SEQ + ab1 files;
    user -> alignment PDF/SQD; templates -> INSTRUCTIONS + Special Growth Protocol.
    """

    # This workflow reads Work No. from its own text field; the app's
    # "Folder with Zips" widget is not needed and is hidden when selected.
    NEEDS_INPUT_FOLDER = False

    def __init__(self, app_instance):
        self.app = app_instance
        self.log = self.app.log
        self.job_log_df = None
        self.shipping_log_df = None
        self.job_log_path = None
        self.sorted_dir = None
        self._alignment_picks = {}  # work_no -> (pdf_path, sqd_path)

    # ------------------------------------------------------------------ UI --
    def create_ui(self, parent_frame):
        main_panel = ctk.CTkFrame(parent_frame, fg_color="transparent")
        main_panel.pack(fill="both", expand=True, padx=10, pady=10)

        ctk.CTkLabel(
            main_panel,
            text="Paste Work No. (one per line)",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(anchor="w")

        self.txt_ids = ctk.CTkTextbox(
            main_panel, border_width=1, fg_color="white", text_color="black", height=110
        )
        self.txt_ids.pack(fill="both", expand=True, pady=(4, 0))

        ctk.CTkLabel(
            main_panel,
            text=(
                "Builds QC zips from scratch: Job Log fields + Sorted_Sequencing_Files "
                "references/ab1s + templates. Output: QC files received folder."
            ),
            font=ctk.CTkFont(size=11),
            text_color="gray",
            justify="left",
        ).pack(anchor="w", pady=(6, 0))

        # Alignment autodiscovery folder (optional): after picking a folder,
        # PDF/SQD files named for the pasted Work No. are auto-matched.
        self.alignment_folder = ctk.StringVar()
        folder_row = ctk.CTkFrame(main_panel, fg_color="transparent")
        folder_row.pack(fill="x", pady=(8, 0))
        ctk.CTkLabel(
            folder_row,
            text="Alignment files folder (optional, autodiscovers PDF + SQD):",
            font=ctk.CTkFont(size=12, weight="bold"),
        ).pack(anchor="w")
        fr2 = ctk.CTkFrame(folder_row, fg_color="transparent")
        fr2.pack(fill="x", pady=(2, 0))
        ctk.CTkEntry(fr2, textvariable=self.alignment_folder, width=400).pack(side="left", padx=(0, 6))
        ctk.CTkButton(fr2, text="Select Folder", command=self._pick_alignment_folder).pack(side="left")
        self.alignment_folder.trace_add("write", self._autodiscover_alignments)

        # Enable the shared Process button as soon as there is at least one
        # non-empty line in the text field (this workflow has no input folder,
        # so the app's folder trace alone would keep the button disabled).
        self.txt_ids.bind("<KeyRelease>", self._on_ids_changed)
        self.txt_ids.bind("<<Paste>>", self._on_ids_changed, add="+")

    def _pick_alignment_folder(self):
        path = filedialog.askdirectory(title="Folder with alignment PDF/SQD files")
        if path:
            self.alignment_folder.set(path)

    def _autodiscover_alignments(self, *_args):
        """Scan the selected folder for Alignment files matching the pasted
        Work No.s and pre-fill the picks. The modal dialog still opens so
        the user can review/fix any row."""
        folder = self.alignment_folder.get().strip()
        if not folder or not os.path.isdir(folder):
            return
        self._alignment_picks = {}
        try:
            lines = self.txt_ids.get("1.0", "end").splitlines()
        except Exception:
            return
        work_nos = [ln.strip().upper() for ln in lines if ln.strip()]
        for wn in work_nos:
            pdf = os.path.join(folder, f"Alignment for {wn}.pdf")
            sqd = os.path.join(folder, f"Alignment for {wn}.sqd")
            if os.path.isfile(pdf) and os.path.isfile(sqd):
                self._alignment_picks[wn] = (pdf, sqd)
        if work_nos:
            found = len(self._alignment_picks)
            self.log(
                f"[INFO] \t Alignment autodiscovery: {found}/{len(work_nos)} Work No. "
                f"have both PDF + SQD in the selected folder."
            )

    def _on_ids_changed(self, _event=None):
        try:
            has_ids = bool(self.txt_ids.get("1.0", "end").strip())
            self.app.process_button.configure(
                state="normal" if has_ids else "disabled"
            )
            # Re-run autodiscovery when the Work No. list changes and a folder
            # is already selected.
            if self.alignment_folder.get().strip():
                self._autodiscover_alignments()
        except Exception:
            pass

    # ------------------------------------------------------------- helpers --
    # Column names differ between the 'Initiated' Job Log sheet and the
    # 'IH Shipping Log ' fallback sheet; map both to the canonical names the
    # workflow uses internally.
    SHIPPING_LOG_COLMAP = {
        "JOB ID": "Work No.",
        "BBID": "BBI ID",
        "Gene ID": "Gene Name",
        "Length": "Length (bp)",
        "Amount": "Quantity",
        "Restriction site": "Cloning Site",
        "Antibiotic": "Resistance",
        "Date Initiated": "Order Date",
        "SEQ CHECK": "Insert Sequence",
        # Unnamed positional columns (no header row text):
        "Notes on ORDER/SHIPMENT": "Plasmid No.",
        "duration b/w initiation and shipping (days)": "Tube ID",
        "Unnamed: 22": "Host",
        "Other": "Temperature",
        "Unnamed: 24": "Competent Cells",
    }
    # Column renames applied to the 'Initiated' sheet (column drift across
    # workbook versions; headers are stripped before this map is applied).
    # Legacy headers on older workbook copies remap onto the canonical
    # names; the live v12 headers need no entry (the shipping fallback's
    # temperature column is 'Other').
    INITIATED_COLMAP = {
        "Plasmid Qty.": "Quantity",
        "Growth Condition/\nTemperature": "Temperature",
    }
    # Permanent fallback sheet: same workbook, different column names.
    FALLBACK_SHEET = "IH Shipping Log "

    def _load_job_log(self) -> bool:
        if self.job_log_df is not None:
            return True
        job_log_path = self.app.hub_paths.get("Job_Log") or self.app.make_path_from_config(
            "Paths", "Job_Log"
        )
        if not job_log_path or not os.path.isfile(job_log_path):
            self.log(f"[ERROR] \t Job Log not found: {job_log_path}")
            return False
        try:
            import pandas as pd

            self.job_log_path = job_log_path
            self.job_log_df = pd.read_excel(job_log_path, sheet_name="Initiated")
            self.job_log_df.columns = [str(c).strip() for c in self.job_log_df.columns]
            self.job_log_df = self.job_log_df.rename(columns=self.INITIATED_COLMAP)
            self.log(f"[OK] \t Loaded Job Log: {os.path.basename(job_log_path)}")

            # Fallback sheet: same workbook, renamed columns.
            try:
                self.shipping_log_df = pd.read_excel(
                    job_log_path, sheet_name=self.FALLBACK_SHEET
                )
                self.shipping_log_df = self.shipping_log_df.rename(
                    columns=self.SHIPPING_LOG_COLMAP
                )
                self.shipping_log_df.columns = [
                    str(c).strip() for c in self.shipping_log_df.columns
                ]
            except Exception as e:
                self.shipping_log_df = None
                self.log(f"[WARNING] \t Could not load '{self.FALLBACK_SHEET}' fallback: {e}")
            return True
        except Exception as e:
            self.log(f"[ERROR] \t Failed to load Job Log: {e}")
            return False

    def _resolve_sorted_dir(self) -> bool:
        if self.sorted_dir:
            return True
        self.sorted_dir = self.app.make_path_from_config("Paths", "Sorted_Sequencing_Files")
        if not self.sorted_dir or not os.path.isdir(self.sorted_dir):
            self.log(f"[ERROR] \t Sorted_Sequencing_Files dir not found: {self.sorted_dir}")
            return False
        return True

    @staticmethod
    def _clean_bbi_id(value) -> str:
        """Strip suffixes like ' [Mutant]', ' (Not shipped)' from BBI ID."""
        text = str(value).strip()
        for token in (" [Mutant]", " (Not shipped)"):
            text = text.replace(token, "")
        return text.strip()

    @staticmethod
    def _strip_year_prefix(tube_id: str) -> str:
        """Remove the leading year letter from the Tube ID (e.g. U051105 -> 051105)."""
        tube_id = str(tube_id).strip()
        return tube_id[1:] if len(tube_id) > 1 else tube_id

    def _find_row(self, work_no: str):
        """Return the Job Log row for work_no; prefers non-fragment rows on duplicates.

        Falls back to the 'IH Shipping Log ' sheet when the Work No. is not
        in 'Initiated' (that sheet stays permanently).
        """
        import pandas as pd

        df = self.job_log_df
        hits = df[df["Work No."].astype(str).str.strip().str.upper() == work_no]
        if len(hits) > 0:
            if len(hits) > 1:
                non_frag = hits[
                    hits["Vector"].astype(str).str.strip() != FRAGMENT_VECTOR
                ]
                hits = non_frag if len(non_frag) >= 1 else hits
            return hits.iloc[0]

        # Fallback: IH Shipping Log sheet (temporary while testing)
        if self.shipping_log_df is not None:
            sh = self.shipping_log_df
            if "Work No." in sh.columns:
                sh_hits = sh[
                    sh["Work No."].astype(str).str.strip().str.upper() == work_no
                ]
                if len(sh_hits) > 0:
                    self.log(
                        f"[INFO] \t {work_no}: not in 'Initiated'; using '{self.FALLBACK_SHEET}' row."
                    )
                    return sh_hits.iloc[0]
        return None

    # ---------------------------------------------------- sorted folder IO --
    def _sorted_folder(self, work_no: str, plasmid_no: str, is_fragment: bool = False):
        """Locate the sorted sequencing folder for a Job.

        The folder name is exactly '{Work No}.{Plasmid No}' — both pieces
        joined by a dot. No prefix/fuzzy matching on the Work No. alone:
        a Work No. can legitimately have several folders (different Plasmid
        No.s), so anything less than the full name is ambiguous.

        DNA fragment orders get one extra retry: when the plasmid no. ends
        with 'PCR' (fragment cloned in pUC57, sequenced, then PCR-amplified),
        the sorted folder may exist under the bare plasmid no. without the
        'PCR' ending. A plasmid no. containing 'Fr' instead means no PCR was
        done, so there is nothing to strip.

        The returned path is ONLY used to collect the ab1/reference files;
        the plasmid no. written to the QC word doc and the zip/folder names
        stays exactly as taken from the Job Log (with 'PCR' when present).
        """
        expected = f"{work_no}.{plasmid_no}"
        path = os.path.join(self.sorted_dir, expected)
        if os.path.isdir(path):
            return path
        # Same exact-name check inside the current year's subfolder
        # (e.g. ...\3.6.2 Sorted sequencing\2026).
        year_dir = os.path.join(self.sorted_dir, str(date.today().year))
        if os.path.isdir(year_dir):
            path = os.path.join(year_dir, expected)
            if os.path.isdir(path):
                return path

        # DNA fragment + 'PCR' ending: retry both places without the suffix.
        if is_fragment and str(plasmid_no).upper().endswith("PCR"):
            bare = str(plasmid_no)[:-3]
            path = os.path.join(self.sorted_dir, f"{work_no}.{bare}")
            if os.path.isdir(path):
                self.log(
                    f"[INFO] \t {work_no}: sorted folder found under bare plasmid no. '{bare}' (PCR amplified)."
                )
                return path
            year_dir = os.path.join(self.sorted_dir, str(date.today().year))
            if os.path.isdir(year_dir):
                path = os.path.join(year_dir, bare)
                if os.path.isdir(path):
                    self.log(
                        f"[INFO] \t {work_no}: found in {date.today().year} subfolder under bare plasmid no. '{bare}'."
                    )
                    return path

        self.log(f"[ERROR] \t No sorted folder '{expected}' for {work_no}")
        return None

    @staticmethod
    def _seq_for_txt(txt_path: str) -> str:
        """Content of the .seq file for a given .txt: original content minus BOM."""
        with open(txt_path, "r", encoding="utf-8", errors="replace") as fp:
            return fp.read().lstrip("﻿")

    def _collect_reference_files(self, sorted_folder: str, inner_folder: str):
        """Copy reference .txt files into inner_folder and generate the .seq files.

        Sorted_Sequencing folders normally contain only ab1 + txt files. The
        'Translated TextFiles' subfolder only appears when someone opened the
        folder in DNAStar (the software creates it while loading the txt
        references) — it is never the source of the shipped .seq files. We
        always generate the .seq ourselves: same name as the txt, content
        prefixed with '^^' + CRLF, then the txt content (minus BOM).
        """
        copied = {"txt": 0, "seq": 0, "generated_seq": 0}

        txt_files = [f for f in os.listdir(sorted_folder) if f.lower().endswith(".txt")]
        for txt_name in txt_files:
            src = os.path.join(sorted_folder, txt_name)
            shutil.copy(src, os.path.join(inner_folder, txt_name))
            copied["txt"] += 1

            # Generate: same name as txt, content prefixed with ^^ + CRLF
            with open(src, "r", encoding="utf-8", errors="replace") as fp:
                content = fp.read().lstrip("﻿")
            gen_name = os.path.splitext(txt_name)[0] + ".seq"
            with open(os.path.join(inner_folder, gen_name), "w", encoding="utf-8", newline="") as fp:
                fp.write("^^\r\n" + content)
            copied["generated_seq"] += 1
        return copied

    # ------------------------------------------------------------ docx gen --
    def _generate_report_docx(self, row, inner_folder: str, prep_date) -> str:
        import pandas as pd

        template = os.path.join(TEMPLATE_DIR, "Gene Synthesis Report.docx")
        docx_name = f"{self._clean_bbi_id(row['BBI ID'])} {str(row['Plasmid No.']).strip()} Gene Synthesis Report.docx"
        out_path = os.path.join(inner_folder, docx_name)
        shutil.copy(template, out_path)

        doc = Document(out_path)
        if not doc.tables:
            return out_path
        table = doc.tables[0]

        is_fragment = str(row["Vector"]).strip().lower() == FRAGMENT_VECTOR.lower()
        delivery = self._date_fmt(prep_date)

        def s(col):
            v = row.get(col)
            return "" if pd.isna(v) else str(v).strip()

        mapping = {
            "bbi id": self._clean_bbi_id(row["BBI ID"]),
            "work no.": str(row["Work No."]).strip(),
            "gene name": s("Gene Name"),
            "length (bp)": "" if pd.isna(row.get("Length (bp)")) else str(int(row["Length (bp)"])),
            "order date": self._date_fmt(row.get("Order Date")),
            "vector": str(row["Vector"]).strip(),
            "delivery date": delivery,
            "plasmid no.": str(row["Plasmid No."]).strip(),
            "storage": "-20°C",
            # Amount cell: third-party packages show the Plasmid Qty. string here
            # for fragments (200-400ng); for cloned genes the template has no
            # Amount label, so this entry simply never matches.
            "amount": s("Quantity") if is_fragment else "",
            "cloning site": "" if is_fragment else s("Cloning Site"),
            "host": "" if is_fragment else s("Host"),
            "resistance": "" if is_fragment else s("Resistance"),
            "plasmid qty.": s("Quantity"),
            "growth condition": "" if is_fragment else self._growth_fmt(row.get("Temperature")),
            "competent cells": "" if is_fragment else s("Competent Cells"),
        }

        for table_row in table.rows:
            # Only real <w:tc> elements: row.cells duplicates merged cells and
            # shifts indices. Exact label matching (not substring) so values that
            # contain a label word (e.g. vector value contains 'vector') don't
            # cascade into later cells.
            from docx.table import _Cell
            from docx.enum.table import WD_ALIGN_VERTICAL
            from docx.enum.text import WD_ALIGN_PARAGRAPH
            from docx.shared import Pt

            tc_list = table_row._tr.tc_lst
            for i, tc in enumerate(tc_list):
                if i + 1 >= len(tc_list):
                    continue
                label = self._label_key(_Cell(tc, table_row).text)
                value_cell = _Cell(tc_list[i + 1], table_row)
                for field_label, field_value in mapping.items():
                    if label == field_label:
                        value_cell.text = ""
                        run = value_cell.paragraphs[0].add_run(str(field_value))
                        run.font.name = "Calibri"
                        # Ed: values vertically centered in their cell; the
                        # BBI ID additionally Pt 14 + horizontally centered.
                        value_cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
                        if label == "bbi id":
                            for para in value_cell.paragraphs:
                                para.alignment = WD_ALIGN_PARAGRAPH.CENTER
                                for r in para.runs:
                                    r.font.size = Pt(14)
                        break
        doc.save(out_path)
        return out_path

    @staticmethod
    def _date_fmt(value) -> str:
        try:
            import pandas as pd

            return pd.to_datetime(value).strftime("%Y/%m/%d")
        except Exception:
            return ""

    @staticmethod
    def _label_key(label: str) -> str:
        """Normalized label for exact-match docx table filling."""
        label = " ".join(label.strip().lower().replace("\n", " ").replace("\r", "").split())
        return label.split("/")[0].strip()

    @staticmethod
    def _growth_fmt(value) -> str:
        """Format growth condition: '37C'/'30C' -> '37°C'/'30°C'; blank stays blank."""
        if value is None or str(value).strip() in ("", "nan"):
            return ""
        text = str(value).strip()
        import re as _re

        m = _re.fullmatch(r"(\d{2})\s*[Cc]", text)
        if m:
            return f"{m.group(1)}°C"
        return text

    # ----------------------------------------------------------- zip build --
    def _build_one(self, work_no: str) -> Tuple[bool, str]:
        import pandas as pd

        prep_date = date.today().strftime("%Y-%m-%d")

        row = self._find_row(work_no)
        if row is None:
            return False, f"Work No. '{work_no}' not found in Job Log."
        for col in ("BBI ID", "Vector", "Plasmid No.", "Tube ID"):
            if pd.isna(row.get(col)) or not str(row.get(col)).strip():
                return False, f"'{col}' missing in Job Log for {work_no}."

        bbi_id = self._clean_bbi_id(row["BBI ID"])
        vector = str(row["Vector"]).strip()
        plasmid_no = str(row["Plasmid No."]).strip()
        tube_serial = self._strip_year_prefix(row["Tube ID"])
        is_fragment = vector.strip().lower() == FRAGMENT_VECTOR.lower()

        # Sorted folder
        if not self._resolve_sorted_dir():
            return False, "Sorted_Sequencing_Files dir unavailable."
        sorted_folder = self._sorted_folder(work_no, plasmid_no, is_fragment=is_fragment)
        if not sorted_folder:
            return False, f"No sorted folder for {work_no} ({plasmid_no})."

        # Alignment files are collected in the batch dialog (see run_processing_task);
        # this method receives them via self._alignment_picks.
        pick = self._alignment_picks.get(work_no)
        if not pick:
            return False, f"Alignment PDF/SQD not provided for {work_no}."
        pdf_src, sqd_src = pick

        folder_name = (
            f"{work_no} {bbi_id} in {vector} {prep_date} {tube_serial}"
        )
        # Prefer the hub-passed path (drive letter resolved by the hub at launch);
        # fall back to resolving QC_Output_Folder from default_directories.ini.
        output_dir = self.app.hub_paths.get("QC_Output_Folder")
        if not output_dir or not os.path.isdir(output_dir):
            output_dir = self.app.make_path_from_config("Paths", "QC_Output_Folder")
        if not output_dir or not os.path.isdir(output_dir):
            return False, "QC output folder unavailable."
        # Staging: single temp folder whose name equals the zip name; files live
        # directly inside it (zip entries = "{folder_name}/...", one folder level).
        import tempfile

        staging_root = tempfile.mkdtemp(prefix="ihqc_")
        inner_folder = os.path.join(staging_root, folder_name)
        seq_results = os.path.join(inner_folder, "OriginalSequencingResults")
        os.makedirs(seq_results, exist_ok=True)

        try:
            # Templates. Special Growth Protocol is only for cloned genes in
            # vectors — fragment orders ship without it (Ed, Sep 28).
            shutil.copy(
                os.path.join(TEMPLATE_DIR, "INSTRUCTIONS-V4.pdf"),
                os.path.join(inner_folder, "INSTRUCTIONS-V4.pdf"),
            )
            if not is_fragment:
                shutil.copy(
                    os.path.join(TEMPLATE_DIR, "Special Growth Protocol.pdf"),
                    os.path.join(inner_folder, "Special Growth Protocol.pdf"),
                )

            # Alignment files
            shutil.copy(pdf_src, os.path.join(inner_folder, f"Alignment for {work_no}.pdf"))
            shutil.copy(sqd_src, os.path.join(seq_results, f"Alignment for {work_no}.sqd"))

            # References + ab1s from sorted folder
            stats = self._collect_reference_files(sorted_folder, inner_folder)
            for f in os.listdir(sorted_folder):
                if f.lower().endswith(".ab1"):
                    shutil.copy(os.path.join(sorted_folder, f), os.path.join(seq_results, f))

            # Report docx + QC digestion handling (same rule as In-House New Names)
            docx_path = self._generate_report_docx(row, inner_folder, prep_date)
            self._handle_digestion_block(docx_path, work_no, row, plasmid_no)

            # Zip: entries = "{folder_name}/..." (single folder level, like the samples)
            zip_path = os.path.join(output_dir, folder_name + ".zip")
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for root, _dirs, files in os.walk(inner_folder):
                    for f in files:
                        full = os.path.join(root, f)
                        zf.write(full, os.path.relpath(full, staging_root))

            self.log(
                f"[OK] \t {work_no}: zip created with {stats['txt']} txt, "
                f"{stats['seq']} seq (copied) + {stats['generated_seq']} seq (generated)"
            )
        except Exception as e:
            return False, f"{work_no}: {e}"
        finally:
            # Clean the staging folder; only the zip is the deliverable
            shutil.rmtree(staging_root, ignore_errors=True)

        return True, zip_path

    # ------------------------------------------------------------- process --
    def validate_inputs(self) -> bool:
        ids_text = self.txt_ids.get("1.0", "end").strip()
        if not ids_text:
            messagebox.showerror("Error", "Paste at least one Work No.")
            return False
        return True

    # ----------------------------------------------------- alignment dialog --
    def _show_alignment_dialog(self, ready: list):
        """Modal dialog (like BATCH Post-Processing): one row per Work No.
        with a PDF entry + browse pair and an SQD entry + browse pair
        (Skip button at the far right). Rows are pre-filled from the
        autodiscovery folder when available. Every picked/typed path is
        remembered by its folder: after any selection, ALL rows are
        re-scanned in that folder for their expected 'Alignment for
        {Work No}.pdf/.sqd' names, so one pick can fill the rest — while
        already-filled rows are never overwritten with wrong-name files.

        Validation: a row only shows 'ready' when each entry points to an
        existing file whose basename matches the expected name exactly.

        Returns {work_no: {'pdf': str|None, 'sqd': str|None,
        'skipped': bool}} or None when cancelled.
        """
        result_holder = {'assignments': None, 'cancelled': False}
        rows = []
        # Set of folder paths the user has picked from (starts empty). On
        # every update, every row re-scans those folders for its expected
        # file names — but only fills EMPTY fields, never overwrites.
        search_dirs = set()

        def expected_pdf_name(wn):
            return f"Alignment for {wn}.pdf"

        def expected_sqd_name(wn):
            return f"Alignment for {wn}.sqd"

        dialog = ctk.CTkToplevel(self.app.master)
        dialog.title("Alignment PDF & SQD Selection")
        dialog.geometry("1180x520")
        dialog.resizable(True, True)
        dialog.transient(self.app.master)
        dialog.grab_set()

        ctk.CTkLabel(
            dialog,
            text="Provide the alignment files for each Work No.",
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color="#1F3A5F",
        ).pack(pady=(16, 4), padx=20)

        ctk.CTkLabel(
            dialog,
            text=(
                f"{len(ready)} Work No. ready. After one selection, the chosen folder is "
                "scanned for the other rows' expected files "
                "('Alignment for {Work No}.pdf / .sqd'). Skip excludes a row."
            ),
            justify="left",
            text_color="#444444",
        ).pack(pady=(0, 12), padx=20, fill="x")

        scroll = ctk.CTkScrollableFrame(dialog, height=300)
        scroll.pack(fill="both", expand=True, padx=20, pady=(0, 8))

        header_frame = ctk.CTkFrame(scroll, fg_color="transparent")
        header_frame.pack(fill="x", padx=4, pady=(0, 2))
        header_frame.grid_columnconfigure(0, minsize=120, weight=0)
        header_frame.grid_columnconfigure(1, minsize=130, weight=0)
        header_frame.grid_columnconfigure(2, weight=1)
        header_frame.grid_columnconfigure(3, minsize=45, weight=0)
        header_frame.grid_columnconfigure(4, weight=1)
        header_frame.grid_columnconfigure(5, minsize=45, weight=0)
        header_frame.grid_columnconfigure(6, minsize=170, weight=0)
        header_frame.grid_columnconfigure(7, minsize=48, weight=0)
        # Same trick as the BATCH Post-Processing header: each header label
        # resolves to exactly the same cell the data-row widget below it
        # occupies (width == the row widget's width, same padx, centered
        # anchor over the button columns), so both grids resolve to
        # identical column boundaries and nothing drifts.
        header_specs = {
            0: ("Work No.", 120, "w", (10, 6)),
            1: ("Plasmid No.", 130, "w", (0, 6)),
            2: ("Alignment PDF", None, "w", (0, 6)),
            3: ("PDF", 45, "center", (0, 6)),
            4: ("Alignment SQD", None, "w", (0, 6)),
            5: ("SQD", 45, "center", (0, 6)),
            6: ("Status", 170, "w", (0, 6)),
        }
        for col, (text, width, anchor, padx) in header_specs.items():
            kwargs = {"anchor": anchor}
            if width:
                kwargs["width"] = width
            ctk.CTkLabel(
                header_frame,
                text=text,
                font=ctk.CTkFont(size=12, weight="bold"),
                text_color="#5A6B7F",
                **kwargs
            ).grid(row=0, column=col, padx=padx, sticky="w")

        def autodiscover():
            """Re-scan every folder in search_dirs and fill EMPTY row fields
            with the expected files (exact name match). Never overwrites a
            field the user already set."""
            if not search_dirs:
                return
            for r in rows:
                if r['skipped']:
                    continue
                if not r['pdf_var'].get().strip():
                    for d in search_dirs:
                        cand = os.path.join(d, expected_pdf_name(r['work_no']))
                        if os.path.isfile(cand):
                            r['pdf_var'].set(cand)
                            break
                if not r['sqd_var'].get().strip():
                    for d in search_dirs:
                        cand = os.path.join(d, expected_sqd_name(r['work_no']))
                        if os.path.isfile(cand):
                            r['sqd_var'].set(cand)
                            break

        def on_proceed_check():
            # Proceed is enabled when every non-skipped row has both paths,
            # each pointing to an existing file with the EXACT expected name.
            for r in rows:
                if r['skipped']:
                    continue
                pdf = r['pdf_var'].get().strip()
                sqd = r['sqd_var'].get().strip()
                if (not pdf or os.path.basename(pdf) != expected_pdf_name(r['work_no'])
                        or not os.path.isfile(pdf)):
                    proceed_btn.configure(state="disabled", fg_color="#9E9E9E")
                    return
                if (not sqd or os.path.basename(sqd) != expected_sqd_name(r['work_no'])
                        or not os.path.isfile(sqd)):
                    proceed_btn.configure(state="disabled", fg_color="#9E9E9E")
                    return
            proceed_btn.configure(state="normal", fg_color="#2E7D32")

        def on_proceed():
            assignments = {}
            for r in rows:
                assignments[r['work_no']] = {
                    'pdf': r['pdf_var'].get().strip() or None,
                    'sqd': r['sqd_var'].get().strip() or None,
                    'skipped': r['skipped'],
                }
            result_holder['assignments'] = assignments
            try:
                dialog.grab_release()
            except Exception:
                pass
            dialog.destroy()

        def on_cancel():
            result_holder['assignments'] = None
            try:
                dialog.grab_release()
            except Exception:
                pass
            dialog.destroy()

        dialog.protocol("WM_DELETE_WINDOW", on_cancel)

        for entry in ready:
            work_no = entry['work_no']
            row_frame = ctk.CTkFrame(scroll, fg_color=("#F4F7FB", "#1B2A3F"), corner_radius=6)
            row_frame.pack(fill="x", pady=4, padx=4)
            row_frame.grid_columnconfigure(0, minsize=120, weight=0)
            row_frame.grid_columnconfigure(1, minsize=130, weight=0)
            row_frame.grid_columnconfigure(2, weight=1)
            row_frame.grid_columnconfigure(3, minsize=45, weight=0)
            row_frame.grid_columnconfigure(4, weight=1)
            row_frame.grid_columnconfigure(5, minsize=45, weight=0)
            row_frame.grid_columnconfigure(6, minsize=170, weight=0)
            row_frame.grid_columnconfigure(7, minsize=48, weight=0)

            ctk.CTkLabel(
                row_frame,
                text=work_no,
                width=120,
                anchor="w",
                font=ctk.CTkFont(size=13, weight="bold"),
                text_color="#0B5394",
            ).grid(row=0, column=0, padx=(10, 6), pady=8, sticky="w")

            ctk.CTkLabel(
                row_frame,
                text=entry['plasmid_no'],
                width=130,
                anchor="w",
                font=ctk.CTkFont(size=12),
                text_color="#1A1A1A",
            ).grid(row=0, column=1, padx=(0, 6), pady=8, sticky="w")

            pref_pdf, pref_sqd = self._alignment_picks.get(work_no, (None, None))
            pdf_var = ctk.StringVar(value=pref_pdf or "")
            sqd_var = ctk.StringVar(value=pref_sqd or "")

            ctk.CTkEntry(
                row_frame,
                textvariable=pdf_var,
                placeholder_text="No PDF selected",
                fg_color=("#FFFFFF", "#2A3B55"),
                border_color=("#A0B4CC", "#3E5876"),
                border_width=2,
            ).grid(row=0, column=2, padx=(0, 6), pady=8, sticky="ew")

            ctk.CTkEntry(
                row_frame,
                textvariable=sqd_var,
                placeholder_text="No SQD selected",
                fg_color=("#FFFFFF", "#2A3B55"),
                border_color=("#A0B4CC", "#3E5876"),
                border_width=2,
            ).grid(row=0, column=4, padx=(0, 6), pady=8, sticky="ew")

            status_label = ctk.CTkLabel(row_frame, text="", anchor="w", text_color="#666666")
            status_label.grid(row=0, column=6, padx=(0, 6), pady=8, sticky="w")

            row = {'work_no': work_no, 'pdf_var': pdf_var, 'sqd_var': sqd_var,
                   'status_label': status_label, 'skipped': False}

            def _refresh_status(r=row):
                pdf = r['pdf_var'].get().strip()
                sqd = r['sqd_var'].get().strip()
                if r['skipped']:
                    r['status_label'].configure(text="SKIPPED", text_color="#C77700")
                    return
                pdf_bad = bool(pdf) and (
                    not os.path.isfile(pdf)
                    or os.path.basename(pdf) != expected_pdf_name(r['work_no'])
                )
                sqd_bad = bool(sqd) and (
                    not os.path.isfile(sqd)
                    or os.path.basename(sqd) != expected_sqd_name(r['work_no'])
                )
                if pdf_bad or sqd_bad:
                    r['status_label'].configure(
                        text="✖ wrong/invalid file",
                        text_color="#D32F2F",
                    )
                elif pdf and sqd:
                    r['status_label'].configure(text="✔ ready", text_color="#2E7D32")
                elif pdf or sqd:
                    r['status_label'].configure(text="✖ missing file(s)", text_color="#D32F2F")
                else:
                    r['status_label'].configure(text="", text_color="#666666")

            def pick(_kind=None, r=row):
                path = filedialog.askopenfilename(
                    title=f"Alignment file for {r['work_no']}",
                    filetypes=[
                        ("Alignment PDF", "*.pdf"),
                        ("SnapGene files", "*.sqd *.dna"),
                        ("All files", "*.*"),
                    ],
                )
                if not path:
                    return
                # Wrong-name picks are rejected outright: the entry stays as
                # it was and the row keeps/gets its invalid status.
                base = os.path.basename(path)
                if base == expected_pdf_name(r['work_no']):
                    r['pdf_var'].set(path)
                elif base == expected_sqd_name(r['work_no']):
                    r['sqd_var'].set(path)
                else:
                    self.log(
                        f"[INFO] \t {r['work_no']}: rejected '{base}' - expected "
                        f"'{expected_pdf_name(r['work_no'])}' or '{expected_sqd_name(r['work_no'])}'."
                    )
                # Remember the folder for autodiscovery of the other rows —
                # even when THIS pick was rejected, the folder may hold the
                # right files.
                search_dirs.add(os.path.dirname(path))
                _refresh_status(r)
                on_proceed_check()
                # After any selection, scan the picked folder for the other
                # rows' expected files (empty fields only).
                autodiscover()
                for rr in rows:
                    _refresh_status(rr)
                on_proceed_check()

            # Field + button pairs: PDF entry -> PDF button, SQD entry -> SQD
            # button; Skip button at the far right.
            ctk.CTkButton(
                row_frame, text="PDF", width=45,
                fg_color="#2E6FB5", hover_color="#1F5594", text_color="#FFFFFF",
                command=lambda: pick("pdf"),
            ).grid(row=0, column=3, padx=(0, 6), pady=8)

            ctk.CTkButton(
                row_frame, text="SQD", width=45,
                fg_color="#2E6FB5", hover_color="#1F5594", text_color="#FFFFFF",
                command=lambda: pick("sqd"),
            ).grid(row=0, column=5, padx=(0, 6), pady=8)

            def on_skip(r=row):
                r['skipped'] = not r['skipped']
                _refresh_status(r)
                on_proceed_check()

            ctk.CTkButton(
                row_frame, text="Skip", width=48,
                fg_color="#C77700", hover_color="#A86400", text_color="#FFFFFF",
                command=on_skip,
            ).grid(row=0, column=7, padx=(0, 10), pady=8)

            # Live gate re-check on any edit (typed or pre-filled).
            pdf_var.trace_add("write", lambda *_a: (_refresh_status(), on_proceed_check()))
            sqd_var.trace_add("write", lambda *_a: (_refresh_status(), on_proceed_check()))

            _refresh_status()
            rows.append(row)

        button_row = ctk.CTkFrame(dialog, fg_color="transparent")
        button_row.pack(pady=(0, 16), padx=20, fill="x")
        button_row.grid_columnconfigure(0, weight=1)
        button_row.grid_columnconfigure(2, weight=1)
        button_row.grid_columnconfigure(4, weight=1)

        cancel_btn = ctk.CTkButton(
            button_row, text="Cancel",
            fg_color="#B53028", hover_color="#922019", text_color="#FFFFFF",
            width=110, command=on_cancel,
        )
        cancel_btn.grid(row=0, column=1, padx=6, pady=4)

        proceed_btn = ctk.CTkButton(
            button_row, text="Proceed",
            fg_color="#2E7D32", hover_color="#1F5C24", text_color="#FFFFFF",
            width=110, command=on_proceed,
        )
        proceed_btn.grid(row=0, column=3, padx=6, pady=4)
        proceed_btn.configure(state="disabled", fg_color="#9E9E9E")
        on_proceed_check()

        # Block until the dialog closes; then return the assignments.
        dialog.wait_window()
        return result_holder['assignments']

    def run_processing_task(self):
        self.log("[INFO] \t Starting In-House QC New (from scratch) workflow...")
        try:
            if not self._load_job_log():
                self._release_button()
                return
            if not self._resolve_sorted_dir():
                self._release_button()
                return

            raw_lines = self.txt_ids.get("1.0", "end").splitlines()
            work_nos = [ln.strip().upper() for ln in raw_lines if ln.strip()]
            self.log(f"[INFO] \t Processing {len(work_nos)} Work No. ...")

            # --- Preflight: resolve each Work No. (row + sorted folder) ---
            ready, failed_pre = [], []
            for work_no in work_nos:
                import pandas as pd

                row = self._find_row(work_no)
                if row is None:
                    failed_pre.append((work_no, "not found in Job Log"))
                    continue
                missing = [
                    col
                    for col in ("BBI ID", "Vector", "Plasmid No.", "Tube ID")
                    if pd.isna(row.get(col)) or not str(row.get(col)).strip()
                ]
                if missing:
                    failed_pre.append((work_no, f"missing: {', '.join(missing)}"))
                    continue
                if not self._sorted_folder(work_no, str(row["Plasmid No."]).strip(),
                                           is_fragment=str(row["Vector"]).strip().lower() == FRAGMENT_VECTOR.lower()):
                    failed_pre.append(
                        (work_no, f"no sorted folder for {work_no} ({row['Plasmid No.']})")
                    )
                    continue
                ready.append({'work_no': work_no, 'row': row,
                              'vector': str(row["Vector"]).strip(),
                              'plasmid_no': str(row["Plasmid No."]).strip()})
            for wn, reason in failed_pre:
                self.log(f"[ERROR] \t {wn}: {reason}")
            if not ready:
                self.log("[FINISHED] \t Nothing ready to process.")
                return

            # --- Modal dialog: alignment PDF + SQD per Work No. ---
            assignments = self._show_alignment_dialog(ready)
            if not assignments:
                self.log("[FAIL] \t User cancelled the alignment dialog.")
                return

            self._alignment_picks = {}
            for r in ready:
                a = assignments.get(r['work_no'], {})
                if a.get('skipped'):
                    self.log(f"[SKIP] \t {r['work_no']} excluded (skipped in dialog).")
                    continue
                if not a.get('pdf') or not a.get('sqd'):
                    self.log(f"[ERROR] \t {r['work_no']}: alignment files incomplete; skipped.")
                    continue
                self._alignment_picks[r['work_no']] = (a['pdf'], a['sqd'])

            to_build = [r['work_no'] for r in ready if r['work_no'] in self._alignment_picks]
            self.log(f"[INFO] \t Building {len(to_build)} QC zip(s) ...")

            ok, failed = 0, 0
            for work_no in to_build:
                success, result = self._build_one(work_no)
                if success:
                    ok += 1
                    self.log(f"[OK] \t Created: {os.path.basename(result)}")
                else:
                    failed += 1
                    self.log(f"[ERROR] \t {result}")

            self.log(f"[FINISHED] \t Done: {ok} created, {failed} failed.")
        finally:
            self._release_button()

    def _release_button(self):
        try:
            self.app.process_button.configure(state="normal")
        except Exception:
            pass

    # ------------------------------------------------- QC digestion block --
    # Constants mirroring InHouseNewNames
    QC_TABLE_PARAGRAPH_TEXT = "restriction enzyme digestion analysis"
    QC_TABLE_INDEX = 1
    GEL_PREFIX = "Z"
    DEFAULT_MAX_IMG_WIDTH = "2.3"
    DEFAULT_MAX_IMG_HEIGHT = "2.8"
    BBI_BLUE_COLOR = None  # imported lazily in write_ref_paragraph

    def _wants_gel(self, work_no: str, row) -> bool:
        """Double check: Z-prefix AND 'gel' substring in the Prep column."""
        if not str(work_no).upper().startswith(self.GEL_PREFIX):
            return False
        prep = str(row.get("Prep", "") or "").lower()
        return "gel" in prep

    def _handle_digestion_block(self, docx_path: str, work_no: str, row, plasmid_no: str):
        """Digestion block rule (same as In-House New Names):
        - X-prefix and Prep does NOT contain 'gel'  -> drop paragraph + QC table
        - Z-prefix AND Prep contains 'gel'          -> insert gel image + enzyme/size info
        """
        import pandas as pd

        prep = str(row.get("Prep", "") or "").lower()
        doc = Document(docx_path)
        base_name = os.path.basename(docx_path)

        if str(work_no).upper().startswith("X") and "gel" not in prep:
            # Remove QC table + preceding paragraph (same logic as InHouseNewNames.remove_qc_elements)
            removed = False
            if len(doc.tables) > self.QC_TABLE_INDEX:
                tbl = doc.tables[self.QC_TABLE_INDEX]
                tbl._element.getparent().remove(tbl._element)
                removed = True
            para_to_delete = next(
                (p for p in doc.paragraphs if self.QC_TABLE_PARAGRAPH_TEXT in p.text.lower()),
                None,
            )
            if para_to_delete:
                para_to_delete._element.getparent().remove(para_to_delete._element)
                removed = True
            if removed:
                self.log(f"[OK] \t {work_no}: removed digestion table (X, Prep has no gel)")
            doc.save(docx_path)
            return

        if self._wants_gel(work_no, row):
            ok = self._find_and_insert_gel(work_no, plasmid_no, doc)
            if not ok:
                self.log(f"[ERROR] \t {work_no}: gel image not found; digestion block left as template.")
            doc.save(docx_path)
            return

        # Any other combination: leave the template block untouched
        doc.save(docx_path)

    # --- gel search/insert (copied from InHouseNewNames) ---
    def _get_year_letter(self, year: int):
        base_year, base_ord = 2024, ord("S")
        if year < base_year:
            return None
        return chr(base_ord + (year - base_year))

    def _recent_folder_info(self, months_to_check: int = 6):
        from datetime import date as _date

        today = _date.today()
        prefixes, years = set(), set()
        y, m = today.year, today.month
        for _ in range(months_to_check):
            letter = self._get_year_letter(y)
            if letter:
                prefixes.add(f"{letter}{m:02d}")
                years.add(str(y))
            m -= 1
            if m == 0:
                m = 12
                y -= 1
        return prefixes, years

    def _find_and_insert_gel(self, work_no: str, plasmid_no: str, doc: Document) -> bool:
        from docx.shared import Inches, RGBColor, Cm
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.enum.table import WD_ROW_HEIGHT_RULE
        from PIL import Image

        gel_images_folder = self.app.make_path_from_config("Paths", "QC_Gel_Images")
        if not gel_images_folder or not os.path.isdir(gel_images_folder):
            self.log(f"[ERROR] \t Gel images folder not found: {gel_images_folder}")
            return False

        try:
            recent_prefixes, recent_years = self._recent_folder_info()
            all_year_folders = [
                f
                for f in os.listdir(gel_images_folder)
                if os.path.isdir(os.path.join(gel_images_folder, f))
            ]
            year_folders_to_search = sorted(
                [f for f in all_year_folders if f in recent_years], reverse=True
            )
        except FileNotFoundError:
            self.log(f"[ERROR] \t Gel images folder does not exist: {gel_images_folder}")
            return False

        for year_folder in year_folders_to_search:
            year_path = os.path.join(gel_images_folder, year_folder)
            # Filter subfolders to only include those matching the recent prefixes.
            subfolders = sorted(
                [
                    f
                    for f in os.listdir(year_path)
                    if os.path.isdir(os.path.join(year_path, f))
                    and len(f) >= 5
                    and f[:3] in recent_prefixes
                ],
                reverse=True,
            )
            for subfolder in subfolders:
                subfolder_path = os.path.join(year_path, subfolder)
                for fname in os.listdir(subfolder_path):
                    if not fname.lower().endswith((".jpg", ".jpeg", ".png")):
                        continue
                    img_name_no_ext = os.path.splitext(fname)[0]
                    parts = img_name_no_ext.split(".", 3)
                    if len(parts) != 4:
                        continue
                    work_no_from_img, plasmid_no_from_img, enzymes, expected_size = parts
                    if work_no_from_img == work_no and plasmid_no_from_img == plasmid_no:
                        self.log(f"[OK] \t Found gel image: {fname}")
                        self.log(f"[OK] \t Enzyme: {enzymes} | Expected Size: {expected_size}")
                        image_path = os.path.join(subfolder_path, fname)
                        self._insert_gel_into_doc(doc, image_path, enzymes, expected_size)
                        return True

        self.log(
            f"[ERROR] \t No gel image for Work No. '{work_no}' & Plasmid No. '{plasmid_no}' (searched last 6 months)."
        )
        return False

    def _insert_gel_into_doc(self, doc: Document, image_path: str, enzymes: str, expected_size: str):
        from docx.shared import Inches, Cm
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.enum.table import WD_ROW_HEIGHT_RULE
        from PIL import Image

        if len(doc.tables) <= self.QC_TABLE_INDEX:
            self.log("[ERROR] \t Document has fewer than 2 tables. Cannot insert image.")
            return
        table = doc.tables[self.QC_TABLE_INDEX]
        table.allow_autofit = False

        target_row_idx = next(
            (
                idx
                for idx, row in enumerate(table.rows)
                if len(row.cells) >= 2
                and ("enzyme" in row.cells[1].text.lower() or "expected size" in row.cells[1].text.lower())
            ),
            len(table.rows) - 1,
        )
        row = table.rows[target_row_idx]
        row.height = Cm(8.7)
        row.height_rule = WD_ROW_HEIGHT_RULE.EXACTLY

        gel_cell = row.cells[0]
        gel_cell.text = ""
        gel_paragraph = gel_cell.paragraphs[0]
        gel_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER

        try:
            max_w_in = float(self.app.config.get("DEFAULT", "Max_Img_Width_Inches", fallback=self.DEFAULT_MAX_IMG_WIDTH))
            max_h_in = float(self.app.config.get("DEFAULT", "Max_Img_Height_Inches", fallback=self.DEFAULT_MAX_IMG_HEIGHT))
        except Exception:
            max_w_in, max_h_in = float(self.DEFAULT_MAX_IMG_WIDTH), float(self.DEFAULT_MAX_IMG_HEIGHT)

        with Image.open(image_path) as im:
            width, height = im.size
        aspect = width / height
        width_in, height_in = (
            (Inches(max_w_in), None) if (max_w_in / aspect) <= max_h_in else (None, Inches(max_h_in))
        )

        run = gel_paragraph.add_run()
        run.add_picture(image_path, width=width_in, height=height_in)

        # Reference paragraph (Enzyme / Expected Size / Marker Ladder)
        info_cell = row.cells[1]
        info_cell.text = ""
        p = info_cell.paragraphs[0]

        from docx.shared import RGBColor as _RGB

        blue = _RGB(0x00, 0x70, 0xC0)

        def add_formatted_line(label, value):
            run_label = p.add_run(label)
            run_label.bold = True
            run_label.font.color.rgb = blue
            p.add_run().add_break()
            p.add_run(value)
            p.add_run().add_break()

        add_formatted_line("Enzyme:", enzymes)
        add_formatted_line("Expected Size:", expected_size)

        ladder_label = p.add_run("Marker Ladder:")
        ladder_label.bold = True
        ladder_label.font.color.rgb = blue
        p.add_run().add_break()

        marker_img_path = self.app.hub_paths.get("Gel_Ladder") or self.app.make_path_from_config(
            "Paths", "QC_Gel_Ladder"
        )
        if marker_img_path and os.path.isfile(marker_img_path):
            try:
                p.add_run().add_picture(marker_img_path, height=Inches(2.4))
                self.log("[OK] \t Marker ladder image inserted.")
            except Exception as e:
                self.log(f"[WARNING] \t Could not insert marker ladder: {e}")
        else:
            self.log("[WARNING] \t Marker ladder image not found; left as text only.")
        self._fix_drawing_ids(doc)
        self.log("[OK] \t Inserted gel image and info into document.")

    # ---------------------------------------------------------- drawing IDs --
    @staticmethod
    def _drawing_id_max(doc: Document) -> int:
        """Largest drawing object id used anywhere in the document
        (body, headers, footers, endnotes, footnotes). Word requires the
        ids to be unique across the whole document; python-docx starts its
        own counter at 1, which collides with the template's header/footer
        drawings and makes Word report the file as damaged."""
        from docx.oxml.ns import qn

        parts = [doc.part.element]
        for rel in doc.part.rels.values():
            try:
                target = rel.target_part
            except AttributeError:
                continue
            if getattr(target, "element", None) is not None:
                parts.append(target.element)
        max_id = 0
        for el in parts:
            for tag in ("wp:docPr", "pic:cNvPr"):
                for node in el.iter(qn(tag)):
                    try:
                        max_id = max(max_id, int(node.get("id", "0")))
                    except (TypeError, ValueError):
                        pass
        return max_id

    def _fix_drawing_ids(self, doc: Document):
        """Re-number the drawings we just inserted so their docPr/cNvPr ids
        are unique document-wide, above every id already used in headers,
        footers and end/footnotes."""
        from docx.oxml.ns import qn

        next_id = self._drawing_id_max(doc) + 1
        for node in doc.part.element.iter(qn("wp:docPr")):
            name = node.get("name", "Picture")
            if name in ("Picture 1", "Picture 2"):
                node.set("id", str(next_id))
                node.set("name", f"Picture {next_id}")
                next_id += 1
        for node in doc.part.element.iter(qn("pic:cNvPr")):
            if node.get("id") == "0":
                node.set("id", str(next_id))
                node.set("name", node.get("name") or f"Picture {next_id}")
                next_id += 1

    def setup_default_paths(self):
        self.log("[OK] \t In-House QC New workflow ready.")