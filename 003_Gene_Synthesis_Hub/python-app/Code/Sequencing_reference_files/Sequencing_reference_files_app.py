"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes and Fabien Lonjon, Ph.D.
contact: ed5reyes@outlook.com

Version: 1.4
Date: Nov 04, 2026
Notes: Completed-archive guard: before a reference file is written, the
    current-year and previous-year \\{YYYY}\\ folder paths are composed and
    checked directly - the reference folder is never listed (it holds
    thousands of files). A file already present in one of these folders
    is skipped entirely - the project is finished and is never remade;
    checking year-1 covers work completed late in the previous year.
    Everything else keeps the previous behavior (created new /
    overwritten in place), and every outcome is counted in the summary
    and the success popup.
"""

import os
import sys
import traceback
import threading
from datetime import date

import openpyxl

import customtkinter as ctk
from tkinter import filedialog, messagebox


class SequencingReferenceFilesApp:
    """
    Extracts reference sequences from a Primer Log Excel file and
    exports them as individual .txt files.

    Reads Work No. / Vector / Insert Sequence / Final Vector Sequence from
    the 'input addon' sheet, resolved by header name first with the
    fixed A/E/H/I indices as fallback, and creates text files for each
    sequence.
    """

    def __init__(
        self,
        master,
        primer_log_path=None,
        reference_files_path=None,
    ):
        self.master = master
        master.title("Sequencing Reference Files")
        master.geometry("600x650")

        # --- Validation flags ---
        self.primer_log_valid = False
        self.reference_files_valid = False

        # --- Validation bookkeeping ---
        # Per-field generation counters: any validation result that arrives
        # from a superseded validation run is dropped instead of applied.
        self._validation_gens = {}
        # Pending debounced re-validation after() handles, per field.
        self._revalidation_handles = {}
        # True while an export run is in flight; edits during a run must not
        # re-enable the Export button.
        self._processing_running = False

        # --- Internal storage ---
        self._primer_log_path = ""
        self._reference_files_path = ""
        self._primer_log_initial_dir = "/"

        # --- Build UI ---
        self._setup_ui()

        # --- Setup initial paths (matches other hub apps pattern) ---
        self.master.after(
            200,
            lambda: self._setup_initial_paths(primer_log_path, reference_files_path),
        )

    def _setup_ui(self):
        """Creates all UI widgets."""

        # --- Primer Log File (Autodetected) ---
        primer_log_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        primer_log_frame.pack(pady=(15, 10), padx=15, fill="x")

        ctk.CTkLabel(
            primer_log_frame,
            text="Primer Log",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(anchor="center")

        entry_frame_pl = ctk.CTkFrame(primer_log_frame, fg_color="transparent")
        entry_frame_pl.pack(fill="x", pady=(5, 0))

        self.entry_primer_log = ctk.CTkEntry(entry_frame_pl, border_width=1)
        self.entry_primer_log.pack(side="left", fill="x", expand=True, padx=(0, 10))

        self.button_primer_log = ctk.CTkButton(
            entry_frame_pl,
            text="Select",
            command=self._browse_primer_log,
            width=90,
        )
        self.button_primer_log.pack(side="right")

        self.primer_log_validation_label = ctk.CTkLabel(
            primer_log_frame,
            text="",
            font=ctk.CTkFont(size=14),
            anchor="w",
            justify="left",
        )
        self.primer_log_validation_label.pack(fill="x")

        # --- Reference Files Folder (Autodetected) ---
        reference_files_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        reference_files_frame.pack(pady=(15, 10), padx=15, fill="x")

        ctk.CTkLabel(
            reference_files_frame,
            text="Reference Files Folder",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(anchor="center")

        entry_frame_rf = ctk.CTkFrame(reference_files_frame, fg_color="transparent")
        entry_frame_rf.pack(fill="x", pady=(2, 2))

        self.entry_reference_files = ctk.CTkEntry(entry_frame_rf, border_width=1)
        self.entry_reference_files.pack(side="left", fill="x", expand=True, padx=(0, 10))

        self.button_reference_files = ctk.CTkButton(
            entry_frame_rf,
            text="Select",
            command=self._browse_reference_files,
            width=90,
        )
        self.button_reference_files.pack(side="right")

        self.reference_files_validation_label = ctk.CTkLabel(
            reference_files_frame,
            text="",
            font=ctk.CTkFont(size=14),
            anchor="w",
            justify="left",
        )
        self.reference_files_validation_label.pack(fill="x")

        # --- Export Button ---
        export_button_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        export_button_frame.pack(pady=20, padx=20, fill="x")
        export_button_frame.grid_columnconfigure((0, 2), weight=2)  # Spacers
        export_button_frame.grid_columnconfigure(1, weight=1)  # Button column

        self.button_export = ctk.CTkButton(
            export_button_frame,
            text="Export Sequences",
            command=self._start_processing,
            font=ctk.CTkFont(size=14, weight="bold"),
            height=40,
            fg_color="#3C702D",
            hover_color="#4CAF50",
        )
        self.button_export.configure(state="disabled", fg_color="gray50")
        self.button_export.grid(row=0, column=1, sticky="ew")

        # --- Log Frame ---
        log_frame = ctk.CTkFrame(self.master)
        log_frame.pack(pady=(10, 15), padx=15, fill="both", expand=True)

        ctk.CTkLabel(
            log_frame,
            text="Log",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(anchor="w", padx=10, pady=(5, 2))

        self.log_textbox = ctk.CTkTextbox(
            log_frame,
            activate_scrollbars=True,
            state="disabled",
            fg_color="white",
            text_color="black",
        )
        self.log_textbox.pack(expand=True, fill="both", padx=10, pady=(2, 10))

        # Manual entry edits invalidate the stored validation immediately and
        # schedule a debounced re-validation, so Export can never run against
        # a path the user typed since the last validation (fail-closed gate).
        self.entry_primer_log.bind(
            "<KeyRelease>", lambda _e: self._on_entry_change("primer_log_valid"), add="+"
        )
        self.entry_primer_log.bind(
            "<<Paste>>", lambda _e: self._on_entry_change("primer_log_valid"), add="+"
        )
        self.entry_reference_files.bind(
            "<KeyRelease>",
            lambda _e: self._on_entry_change("reference_files_valid"),
            add="+",
        )
        self.entry_reference_files.bind(
            "<<Paste>>", lambda _e: self._on_entry_change("reference_files_valid"), add="+"
        )

    # --- Logging methods ---
    def _log(self, message):
        """Appends a message to the log widget (main thread only)."""
        if self.log_textbox and self.log_textbox.winfo_exists():
            self.log_textbox.configure(state="normal")
            self.log_textbox.insert("end", message + "\n")
            self.log_textbox.see("end")
            self.log_textbox.configure(state="disabled")

    def _log_threaded(self, message):
        """Safely log from a worker thread."""
        if self.log_textbox:
            self.master.after(0, self._log, message)

    def _clear_log(self):
        """Clears the log widget."""
        if self.log_textbox and self.log_textbox.winfo_exists():
            self.log_textbox.configure(state="normal")
            self.log_textbox.delete("1.0", "end")
            self.log_textbox.configure(state="disabled")

    # --- Validation methods ---
    def _on_entry_change(self, validation_flag_name):
        """Manual entry edit: fail closed immediately, re-validate debounced."""
        if validation_flag_name == "primer_log_valid":
            entry_widget = self.entry_primer_log
            validation_label_widget = self.primer_log_validation_label
        else:
            entry_widget = self.entry_reference_files
            validation_label_widget = self.reference_files_validation_label

        handle = self._revalidation_handles.pop(validation_flag_name, None)
        if handle:
            self.master.after_cancel(handle)
        self._update_validation_ui(
            entry_widget, validation_label_widget, None, "", validation_flag_name
        )
        self._revalidation_handles[validation_flag_name] = self.master.after(
            500, self._revalidate_field, validation_flag_name
        )

    def _revalidate_field(self, validation_flag_name):
        """Deferred re-validation of one entry from its CURRENT text."""
        self._revalidation_handles.pop(validation_flag_name, None)
        if validation_flag_name == "primer_log_valid":
            file_path = self.entry_primer_log.get().strip()
            if not file_path:
                return
            self._start_validation_thread(
                self.entry_primer_log,
                self.primer_log_validation_label,
                file_path,
                "input addon",
                "primer_log_valid",
            )
        else:
            file_path = self.entry_reference_files.get().strip()
            if not file_path:
                return
            self._start_validation_thread(
                self.entry_reference_files,
                self.reference_files_validation_label,
                file_path,
                None,
                "reference_files_valid",
            )

    def _start_validation_thread(
        self,
        entry_widget,
        validation_label_widget,
        file_path,
        expected_sheet,
        validation_flag_name,
        next_callback=None,
    ):
        """Starts a background thread to validate a file/folder path."""
        # Bump this field's generation so any older in-flight result is dropped.
        self._validation_gens[validation_flag_name] = (
            self._validation_gens.get(validation_flag_name, 0) + 1
        )
        generation = self._validation_gens[validation_flag_name]

        # Reset UI to neutral before starting validation (also clears the
        # stored path, so a failed re-validation cannot leave a stale one).
        self._update_validation_ui(
            entry_widget, validation_label_widget, None, "", validation_flag_name
        )

        thread = threading.Thread(
            target=self._validate_path,
            args=(
                entry_widget,
                validation_label_widget,
                file_path,
                expected_sheet,
                validation_flag_name,
                next_callback,
                generation,
            ),
            daemon=True,
        )
        thread.start()

    def _validate_path(
        self,
        entry_widget,
        validation_label_widget,
        file_path,
        expected_sheet,
        validation_flag_name,
        next_callback=None,
        generation=None,
    ):
        """
        Checks if a file/folder exists and (for files) contains the expected sheet.
        This method runs in a background thread and schedules UI updates that
        carry the VALIDATED path and the generation of the validation run.
        """
        if not file_path:
            return

        # For folders, just check existence (Output folder)
        if validation_flag_name == "reference_files_valid":
            if os.path.isdir(file_path):
                message = "Folder found"
                self.master.after(
                    0,
                    self._update_validation_ui,
                    entry_widget,
                    validation_label_widget,
                    True,
                    message,
                    validation_flag_name,
                    file_path,
                    next_callback,
                    generation,
                )
            else:
                message = "Folder not found"
                self.master.after(
                    0,
                    self._update_validation_ui,
                    entry_widget,
                    validation_label_widget,
                    False,
                    message,
                    validation_flag_name,
                    file_path,
                    next_callback,
                    generation,
                )
            return

        # For files, check existence and sheet
        if not os.path.exists(file_path):
            message = "File not found."
            self.master.after(
                0,
                self._update_validation_ui,
                entry_widget,
                validation_label_widget,
                False,
                message,
                validation_flag_name,
                file_path,
                next_callback,
                generation,
            )
            return

        try:
            wb = openpyxl.load_workbook(file_path, read_only=True)
            try:
                if expected_sheet and expected_sheet not in wb.sheetnames:
                    message = f"Sheet '{expected_sheet}' not found."
                    self.master.after(
                        0,
                        self._update_validation_ui,
                        entry_widget,
                        validation_label_widget,
                        False,
                        message,
                        validation_flag_name,
                        file_path,
                        next_callback,
                        generation,
                    )
                    return

                # File is valid
                message = "Validated"
                self.master.after(
                    0,
                    self._update_validation_ui,
                    entry_widget,
                    validation_label_widget,
                    True,
                    message,
                    validation_flag_name,
                    file_path,
                    next_callback,
                    generation,
                )
            finally:
                wb.close()
        except Exception:
            message = "Not a valid Excel file."
            self.master.after(
                0,
                self._update_validation_ui,
                entry_widget,
                validation_label_widget,
                False,
                message,
                validation_flag_name,
                file_path,
                next_callback,
                generation,
            )

    def _update_validation_ui(
        self,
        entry_widget,
        validation_label_widget,
        is_valid,
        message,
        validation_flag_name,
        validated_path=None,
        next_callback=None,
        generation=None,
    ):
        """
        Updates the UI to reflect the validation status of a file/folder.
        This method is always run on the main UI thread.

        Stores the VALIDATED path (not the entry's current text) so a result
        can never attach to a path it did not check. Results from a
        superseded validation run (generation mismatch) are dropped, and a
        failed/neutral outcome clears the stored path.
        """
        if generation is not None and generation != self._validation_gens.get(
            validation_flag_name
        ):
            return  # stale result from a superseded validation

        # Update the validation status flag
        setattr(self, validation_flag_name, is_valid)

        # Keep the stored path in lockstep with the validation outcome
        if validation_flag_name == "primer_log_valid":
            self._primer_log_path = validated_path if is_valid is True else ""
        elif validation_flag_name == "reference_files_valid":
            self._reference_files_path = validated_path if is_valid is True else ""

        if is_valid is True:
            entry_widget.configure(border_color="dark green", border_width=2)
            validation_label_widget.configure(text=f"✔ {message}", text_color="green")
        elif is_valid is False:
            entry_widget.configure(border_color="#D32F2F", border_width=2)
            validation_label_widget.configure(
                text=f"✖ Invalid: {message}", text_color="#D32F2F"
            )
        else:  # is_valid is None (resetting to neutral)
            entry_widget.configure(
                border_width=1,
                border_color=ctk.ThemeManager.theme["CTkEntry"]["border_color"],
            )
            validation_label_widget.configure(
                text="", text_color=ctk.ThemeManager.theme["CTkLabel"]["text_color"]
            )

        self._check_all_validations()

        if next_callback:
            next_callback()

    def _check_all_validations(self):
        """Checks if all inputs are valid and enables/disables the Export button."""
        all_valid = self.primer_log_valid and self.reference_files_valid
        if self._processing_running:
            all_valid = False  # edits during a run must not re-enable the button
        if all_valid:
            self.button_export.configure(state="normal", fg_color="#3C702D")
        else:
            self.button_export.configure(state="disabled", fg_color="gray50")

    def _setup_initial_paths(self, primer_log_path, reference_files_path):
        """Pre-fills entry widgets with provided paths and then starts sequential validation."""
        # --- Phase 1: Autofill all paths immediately ---
        if primer_log_path:
            # Check if it's a file or directory
            if os.path.isfile(primer_log_path):
                self.entry_primer_log.delete(0, "end")
                self.entry_primer_log.insert(0, primer_log_path)
                # Manual browses should start in the prefilled file's folder
                self._primer_log_initial_dir = (
                    os.path.dirname(primer_log_path) or self._primer_log_initial_dir
                )
            elif os.path.isdir(primer_log_path):
                self._primer_log_initial_dir = primer_log_path

        if reference_files_path:
            self.entry_reference_files.delete(0, "end")
            self.entry_reference_files.insert(0, reference_files_path)

        # --- Phase 2: Start the validation chain ---
        self._start_sequential_validation()

    def _start_sequential_validation(self):
        """Starts the validation for any pre-filled paths in sequence."""
        # Get paths from the entry widgets now that they are filled
        primer_log_path = self.entry_primer_log.get()
        reference_files_path = self.entry_reference_files.get()

        # Define chained callbacks

        # 2. Reference Files Folder (Last)
        def validate_reference_files():
            if reference_files_path:
                self._start_validation_thread(
                    self.entry_reference_files,
                    self.reference_files_validation_label,
                    reference_files_path,
                    None,  # No sheet check for folders
                    "reference_files_valid",
                )

        # 1. Primer Log (First)
        if primer_log_path:
            self._start_validation_thread(
                self.entry_primer_log,
                self.primer_log_validation_label,
                primer_log_path,
                "input addon",
                "primer_log_valid",
                next_callback=validate_reference_files,
            )
        else:
            validate_reference_files()  # Skip to next if path is missing

    # --- Browse methods ---
    def _browse_primer_log(self):
        filename = filedialog.askopenfilename(
            title="Select Primer Log File",
            initialdir=self._primer_log_initial_dir,
            filetypes=[("Excel files", "*.xlsx *.xls"), ("All files", "*.*")],
        )
        if filename:
            self.entry_primer_log.delete(0, "end")
            self.entry_primer_log.insert(0, filename)
            self._start_validation_thread(
                self.entry_primer_log,
                self.primer_log_validation_label,
                filename,
                "input addon",
                "primer_log_valid",
            )

    def _browse_reference_files(self):
        folder = filedialog.askdirectory(title="Select Reference Files Folder")
        if folder:
            self.entry_reference_files.delete(0, "end")
            self.entry_reference_files.insert(0, folder)
            self._start_validation_thread(
                self.entry_reference_files,
                self.reference_files_validation_label,
                folder,
                None,
                "reference_files_valid",
            )

    # --- Processing methods ---
    def _start_processing(self):
        """Starts the processing logic in a background thread."""
        self._processing_running = True
        self.button_export.configure(state="disabled", fg_color="gray50")
        self._clear_log()
        self._log("Processing started...")

        thread = threading.Thread(target=self._processing_thread, daemon=True)
        thread.start()

    def _processing_thread(self):
        """The main processing logic that runs in a background thread."""
        import re

        try:
            self._log_threaded(f"Loading Primer Log: {os.path.basename(self._primer_log_path)}")

            # Load the input addon sheet
            wb = openpyxl.load_workbook(self._primer_log_path, read_only=True, data_only=True)

            try:
                sheet_name = "input addon"
                if sheet_name not in wb.sheetnames:
                    self._log_threaded(f"ERROR: '{sheet_name}' sheet not found in the file.")
                    self.master.after(
                        0,
                        lambda: messagebox.showerror("Error", f"Sheet '{sheet_name}' not found in the file.")
                    )
                    return

                ws = wb[sheet_name]

                # Counters
                sequences_exported = 0
                files_overwritten = 0
                files_completed = 0
                files_skipped = 0
                rows_processed = 0

                # Completed-project archive: the \{YYYY}\ year folders inside
                # the reference folder hold the references of completed
                # projects. The folder is never listed (it holds thousands of
                # files) - the current-year and previous-year paths are
                # composed directly, so work completed late in the previous
                # year is still caught after the calendar rolls over.
                year_dirs = [str(date.today().year), str(date.today().year - 1)]

                def _find_completed_in(file_name):
                    """Returns the expected year folder holding the completed copy, or None."""
                    for _yd in year_dirs:
                        if os.path.exists(
                            os.path.join(self._reference_files_path, _yd, file_name)
                        ):
                            return _yd
                    return None

                self._log_threaded(f"Reference folder: {self._reference_files_path}")
                years_txt = " and ".join(f"\\{_yd}\\" for _yd in year_dirs)
                self._log_threaded(
                    f"Completed archive check: {years_txt} "
                    "(current + previous year; a completed copy there is skipped)"
                )
                self._log_threaded("")

                # Read header row (Row 1) to determine indices
                rows_iter = ws.iter_rows(values_only=True)
                headers = next(rows_iter, None)

                if not headers:
                    self._log_threaded("ERROR: File is empty.")
                    return

                # Map normalized column names to indices (both sides stripped +
                # lowercased so surrounding whitespace never breaks a match).
                def norm_header(h):
                    return re.sub(r"\s+", " ", str(h)).strip().lower() if h is not None else ""

                header_map = {norm_header(h): i for i, h in enumerate(headers) if h}

                def resolve_column(candidates, fallback_idx):
                    """Canonical-first candidates; legacy spellings tolerated.
                    Falls back to the historic fixed index when no candidate
                    header matches. Returns (idx, matched_by_name)."""
                    for cand in candidates:
                        key = re.sub(r"\s+", " ", str(cand)).strip().lower()
                        if key in header_map:
                            return header_map[key], True
                    return fallback_idx, False

                # Fixed fallback indices: A=0, E=4, H=7, I=8.
                idx_work_no, name_work_no = resolve_column(
                    ("Work No.", "JobID", "Job ID"), 0)
                idx_vector, name_vector = resolve_column(("Vector",), 4)
                idx_insert_sequence, name_insert = resolve_column(
                    ("Insert Sequence", "Insert Seq"), 7)
                idx_final_vector_sequence, name_final = resolve_column(
                    ("Final Vector Sequence", "Final Vector"), 8)

                def col_letter(i):
                    from openpyxl.utils import get_column_letter
                    return get_column_letter(i + 1)

                col_report = ", ".join(
                    f"{label}={col_letter(idx)}"
                    f"{' (name)' if used_name else ' (fixed fallback)'}"
                    for label, idx, used_name in (
                        ("Work No.", idx_work_no, name_work_no),
                        ("Vector", idx_vector, name_vector),
                        ("Insert Sequence", idx_insert_sequence, name_insert),
                        ("Final Vector Sequence", idx_final_vector_sequence, name_final),
                    )
                )
                if name_work_no and name_vector and name_insert and name_final:
                    self._log_threaded(f"'input addon': columns resolved by name ({col_report})")
                elif not (name_work_no or name_vector or name_insert or name_final):
                    self._log_threaded(
                        f"'input addon': header row not recognized; falling back to "
                        f"fixed columns (Work No.=A, Vector=E, Insert Sequence=H, "
                        f"Final Vector Sequence=I)"
                    )
                else:
                    self._log_threaded(
                        f"'input addon': partial header match; fixed fallback used "
                        f"for missing columns ({col_report})"
                    )

                # Headerless-sheet guard: when NO candidate header matched at all,
                # decide whether the consumed row 1 was really a header row.
                HEADER_HINTS = ("work no", "jobid", "job id", "vector", "insert", "final")

                def _looks_like_sequence(value):
                    if not isinstance(value, str):
                        return False
                    compact = re.sub(r"[\s\r\n\-]+", "", value.upper())
                    return len(compact) >= 40 and set(compact) <= set("ACGTUN")

                consume_headers_as_data = False
                if not (name_work_no or name_vector or name_insert or name_final):
                    recognized_header = any(
                        hint in norm_header(h)
                        for h in headers if h
                        for hint in HEADER_HINTS
                    )
                    if not recognized_header:
                        if any(_looks_like_sequence(v) for v in headers):
                            consume_headers_as_data = True
                            self._log_threaded(
                                "  ⚠ Row 1 carries no header text but looks like data — "
                                "processing it as a data row"
                            )
                        else:
                            self._log_threaded(
                                "  ⚠ Row 1 carries no recognized header text and no "
                                "sequence — verify the sheet layout (row skipped)"
                            )

                def get_val(idx, row):
                    return str(row[idx]).strip() if idx < len(row) and row[idx] is not None else ""

                seen_work_nos = set()

                def process_data_row(row):
                    nonlocal rows_processed, sequences_exported
                    nonlocal files_overwritten, files_completed, files_skipped

                    work_no = get_val(idx_work_no, row)
                    vector = get_val(idx_vector, row)
                    insert_sequence = get_val(idx_insert_sequence, row)
                    final_vector_sequence = get_val(idx_final_vector_sequence, row)

                    # Skip empty rows
                    if not work_no:
                        return

                    rows_processed += 1

                    if work_no in seen_work_nos:
                        self._log_threaded(
                            f"  ⚠ Duplicate Work No. row: {work_no} — later rows overwrite earlier files"
                        )
                    seen_work_nos.add(work_no)

                    # File 1: {Work No.}.txt with Insert Sequence
                    if insert_sequence:
                        file_name = f"{work_no}.txt"
                        completed_in = _find_completed_in(file_name)
                        if completed_in:
                            files_completed += 1
                            self._log_threaded(
                                f"  ⏭ Skipped {file_name} - completed copy already in "
                                f"\\{completed_in}\\ (project finished, not remade)"
                            )
                        else:
                            file_path = os.path.join(self._reference_files_path, file_name)
                            existed = os.path.exists(file_path)
                            with open(file_path, 'w', encoding='utf-8') as f:
                                f.write(insert_sequence)
                            if existed:
                                files_overwritten += 1
                                self._log_threaded(f"  ⚠ Overwrote existing: {file_name}")
                            else:
                                sequences_exported += 1
                                self._log_threaded(f"  ✓ Created: {file_name}")

                    # File 2: {Work No.}+{Vector}.txt with Final Vector Sequence (if present)
                    if final_vector_sequence:
                        if not vector:
                            files_skipped += 1
                            self._log_threaded(
                                f"  ⚠ Skipped {work_no}+{vector}.txt — Vector cell is empty; "
                                f"the combined name needs a vector"
                            )
                        else:
                            file_name = f"{work_no}+{vector}.txt"
                            completed_in = _find_completed_in(file_name)
                            if completed_in:
                                files_completed += 1
                                self._log_threaded(
                                    f"  ⏭ Skipped {file_name} - completed copy already in "
                                    f"\\{completed_in}\\ (project finished, not remade)"
                                )
                            else:
                                file_path = os.path.join(self._reference_files_path, file_name)
                                existed = os.path.exists(file_path)
                                with open(file_path, 'w', encoding='utf-8') as f:
                                    f.write(final_vector_sequence)
                                if existed:
                                    files_overwritten += 1
                                    self._log_threaded(f"  ⚠ Overwrote existing: {file_name}")
                                else:
                                    sequences_exported += 1
                                    self._log_threaded(f"  ✓ Created: {file_name}")

                if consume_headers_as_data:
                    process_data_row(headers)

                # Process data rows
                for row in rows_iter:
                    process_data_row(row)

            finally:
                wb.close()

            self._log_threaded("")
            self._log_threaded(f"--- Processing Finished ---")
            self._log_threaded(f"Rows processed: {rows_processed}")
            self._log_threaded(f"Files created: {sequences_exported}")
            self._log_threaded(f"Files overwritten: {files_overwritten}")
            self._log_threaded(f"Files skipped (completed in year folder): {files_completed}")
            self._log_threaded(f"Files skipped (empty Vector): {files_skipped}")

            summary = (
                f"Created: {sequences_exported}\n"
                f"Overwritten: {files_overwritten}\n"
                f"Skipped (completed in year folder): {files_completed}\n"
                f"Skipped (empty Vector): {files_skipped}"
            )
            self.master.after(
                0,
                lambda: messagebox.showinfo("Success", summary),
            )

        except Exception as e:
            self._log_threaded(f"\nERROR: {traceback.format_exc()}")
            self.master.after(0, messagebox.showerror, "Error", str(e))
        finally:
            self._processing_running = False
            # Re-evaluate instead of unconditionally re-enabling: if the inputs
            # were invalidated during the run the button must stay disabled.
            self.master.after(0, self._check_all_validations)


def main():
    """Standalone entry point when not launched from the hub."""
    ctk.set_appearance_mode("System")
    ctk.set_default_color_theme("blue")

    # Parse arguments for standalone execution logic matching Hub's format
    kwargs = {}
    for arg in sys.argv[1:]:
        if arg.startswith("--primer_log_path="):
            kwargs["primer_log_path"] = arg.split("=", 1)[1]
        elif arg.startswith("--reference_files_path="):
            kwargs["reference_files_path"] = arg.split("=", 1)[1]

    root = ctk.CTk()
    app = SequencingReferenceFilesApp(root, **kwargs)
    root.mainloop()


if __name__ == "__main__":
    main()