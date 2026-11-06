"""
Bio Basic Inc. - Canada
Made by: Fabien Lonjon and Eduardo Reyes, Ph.D.
contact: ed5reyes@outlook.com

Version: 1.2
Date: Oct 30, 2026
Notes: Audit fixes. Only real order-form sheets (name = S/T/U/V + MMDD, e.g.
    S0104, U0910) are scanned - non-order sheets that happen to start with
    S/T/U/V (Summary, Sheet1, USHE198 ...) are no longer read. The primer log
    entry fails validation closed on any hand edit and re-validates debounced;
    completed validations from superseded threads are dropped (generation
    counter); the verified file path is stored, not the entry text read at
    completion. The target sequence is cleaned stepwise and every non-DNA
    character removed is counted and reported in the completion dialog and
    the status line. The analysis thread receives the target text as an
    argument instead of reading the textbox from its own thread. Skipped
    sheets (with reason) and A:B-fallback usage are reported at completion.
    Readers (openpyxl workbook in validation, ExcelFile in analysis) are
    closed after use. .xls was removed from the file dialog: the Primer Log
    is xlsx-only (openpyxl cannot validate xls). Rows-35 start and the
    name-first Oligo Name / Sequence (5' to 3') resolution are unchanged.
Migrated and adapted to Gene Synthesis hub. Standalone app discontinued.
"""

import os
import re
import threading
import traceback
from tkinter import filedialog, messagebox

import customtkinter as ctk


def get_reverse_complement(seq):
    """Returns the reverse complement of a DNA sequence."""
    complement = {'A': 'T', 'C': 'G', 'G': 'C', 'T': 'A', 'N': 'N'}
    return "".join(complement.get(base, base) for base in reversed(seq))


class PrimerFinderApp:
    """
    Primer Binding Checker for Gene Synthesis workflow.

    Accepts a target DNA sequence and an Excel primer database,
    then finds primers that bind to the target (forward or reverse).
    """

    def __init__(
        self,
        master,
        primer_log_path=None,
    ):
        self.master = master
        master.title("Primer Finder")
        master.geometry("950x750")

        # --- Validation flags ---
        self.primer_log_valid = False

        # --- Internal storage ---
        self._primer_log_path = ""
        self._validation_generation = 0  # per-field counter: stale validation results are dropped
        self._primer_log_after_id = None  # debounce handle for re-validation after entry edits

        # --- Build UI ---
        self._setup_ui()

        # --- Setup initial paths (matches hub pattern) ---
        self.master.after(
            200,
            lambda: self._setup_initial_paths(primer_log_path),
        )

    def _setup_ui(self):
        """Creates all UI widgets."""

        # --- Target Sequence Input ---
        sequence_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        sequence_frame.pack(pady=(15, 10), padx=15, fill="x")

        ctk.CTkLabel(
            sequence_frame,
            text="Target DNA Sequence",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(anchor="center")

        ctk.CTkLabel(
            sequence_frame,
            text="Enter the target sequence to search for primer binding sites",
            font=ctk.CTkFont(size=12),
            text_color="gray",
        ).pack(anchor="w")

        self.text_sequence = ctk.CTkTextbox(sequence_frame, height=100, wrap="word")
        self.text_sequence.pack(fill="x", pady=(5, 0))

        # --- Primer Database File Selection ---
        self.primer_log_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        self.primer_log_frame.pack(pady=(15, 10), padx=15, fill="x")

        ctk.CTkLabel(
            self.primer_log_frame,
            text="Primer Log",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(anchor="center")

        entry_frame_pl = ctk.CTkFrame(self.primer_log_frame, fg_color="transparent")
        entry_frame_pl.pack(fill="x", pady=(2, 2))

        self.entry_primer_log = ctk.CTkEntry(entry_frame_pl, border_width=1)
        self.entry_primer_log.pack(side="left", fill="x", expand=True, padx=(0, 10))

        # Any hand edit fails the validation closed (stored path + flag dropped)
        # and schedules a debounced re-validation from the entry's current text.
        self.entry_primer_log.bind(
            "<KeyRelease>", self._on_primer_log_entry_changed, add="+"
        )
        self.entry_primer_log.bind(
            "<<Paste>>", self._on_primer_log_entry_changed, add="+"
        )

        self.button_primer_log = ctk.CTkButton(
            entry_frame_pl,
            text="Select",
            command=self._browse_primer_log,
            width=90,
        )
        self.button_primer_log.pack(side="right")

        self.primer_log_validation_label = ctk.CTkLabel(
            self.primer_log_frame,
            text="",
            font=ctk.CTkFont(size=14),
            anchor="w",
            justify="left",
        )
        self.primer_log_validation_label.pack(fill="x")

        # --- Analyze Button ---
        button_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        button_frame.pack(pady=20, padx=20, fill="x")
        button_frame.grid_columnconfigure((0, 2), weight=2)  # Spacers
        button_frame.grid_columnconfigure(1, weight=1)  # Button column

        self.button_analyze = ctk.CTkButton(
            button_frame,
            text="Find Binding Primers",
            command=self._start_analysis,
            font=ctk.CTkFont(size=14, weight="bold"),
            height=40,
            fg_color="#3C702D",
            hover_color="#4CAF50",
        )
        self.button_analyze.configure(state="disabled", fg_color="gray50")
        self.button_analyze.grid(row=0, column=1, sticky="ew")

        # --- Progress Bar ---
        self.progress = ctk.CTkProgressBar(self.master, mode="determinate")
        self.progress.pack(pady=(0, 10), padx=15, fill="x")
        self.progress.set(0)

        # --- Status Label ---
        self.lbl_status = ctk.CTkLabel(
            self.master,
            text="Ready",
            font=ctk.CTkFont(size=14),
            text_color="blue",
        )
        self.lbl_status.pack(pady=5)

        # --- Results Frame ---
        results_frame = ctk.CTkFrame(self.master)
        results_frame.pack(pady=(5, 15), padx=15, fill="both", expand=True)

        ctk.CTkLabel(
            results_frame,
            text="Matching Primers",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(anchor="w", padx=10, pady=(5, 2))

        # --- Static Header ---
        self.header_textbox = ctk.CTkTextbox(
            results_frame,
            height=40,
            activate_scrollbars=False,
            state="normal",
            fg_color="white",
            text_color="black",
            font=("Consolas", 12),
        )
        self.header_textbox.pack(fill="x", padx=10, pady=(2, 0))

        header_str = f"{'Sheet':<6} | {'Primer Name':<30} | {'Orientation':<25} |  {'Pos':<5} | {'Sequence'}"
        sep_str = "-" * 120
        self.header_textbox.insert("1.0", f"{header_str}\n{sep_str}")
        self.header_textbox.configure(state="disabled")

        # Results treeview using CTkTextbox for display
        self.results_textbox = ctk.CTkTextbox(
            results_frame,
            activate_scrollbars=True,
            state="disabled",
            fg_color="white",
            text_color="black",
            font=("Consolas", 12),
        )
        self.results_textbox.pack(expand=True, fill="both", padx=10, pady=(0, 10))

    # --- Logging methods ---
    def _log_status(self, message, color=None):
        """Updates the status label."""
        self.lbl_status.configure(text=message)
        if color:
            self.lbl_status.configure(text_color=color)

    def _clear_results(self):
        """Clears the results textbox."""
        self.results_textbox.configure(state="normal")
        self.results_textbox.delete("1.0", "end")
        self.results_textbox.configure(state="disabled")

    def _add_result(self, line):
        """Adds a line to the results textbox."""
        self.results_textbox.configure(state="normal")
        self.results_textbox.insert("end", line + "\n")
        self.results_textbox.see("end")
        self.results_textbox.configure(state="disabled")

    # --- Validation methods ---
    def _start_validation_thread(
        self,
        entry_widget,
        validation_label_widget,
        file_path,
        expected_sheet,
        validation_flag_name,
        file_display_name,
        next_callback=None,
    ):
        """Starts a background thread to validate a file path."""
        # Reset UI to neutral before starting validation
        self._update_validation_ui(
            entry_widget, validation_label_widget, None, "", validation_flag_name
        )

        # Generation counter: a completion from a superseded thread (e.g. two
        # quick re-browses, or the debounced re-validation) is dropped instead
        # of overriding the newest validation result.
        self._validation_generation += 1
        generation = self._validation_generation

        thread = threading.Thread(
            target=self._validate_file,
            args=(
                entry_widget,
                validation_label_widget,
                file_path,
                expected_sheet,
                validation_flag_name,
                file_display_name,
                next_callback,
                generation,
            ),
            daemon=True,
        )
        thread.start()

    def _validate_file(
        self,
        entry_widget,
        validation_label_widget,
        file_path,
        expected_sheet,
        validation_flag_name,
        file_display_name,
        next_callback=None,
        generation=None,
    ):
        """
        Checks if a file exists and contains the expected sheet.
        This method runs in a background thread and schedules UI updates.
        """
        # Lazy import to avoid startup delay
        import openpyxl

        if not file_path:
            return

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
                file_display_name,
                next_callback,
                file_path,
                generation,
            )
            return

        wb = None
        try:
            wb = openpyxl.load_workbook(file_path, read_only=True)
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
                    file_display_name,
                    next_callback,
                    file_path,
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
                file_display_name,
                next_callback,
                file_path,
                generation,
            )
        except Exception as e:
            message = "Not a valid Excel file."
            self.master.after(
                0,
                self._update_validation_ui,
                entry_widget,
                validation_label_widget,
                False,
                message,
                validation_flag_name,
                file_display_name,
                next_callback,
                file_path,
                generation,
            )
        finally:
            if wb is not None:
                try:
                    wb.close()
                except Exception:
                    pass

    def _update_validation_ui(
        self,
        entry_widget,
        validation_label_widget,
        is_valid,
        message,
        validation_flag_name,
        file_display_name=None,
        next_callback=None,
        validated_path=None,
        generation=None,
    ):
        """
        Updates the UI to reflect the validation status of a file.
        This method is always run on the main UI thread.
        """
        # A completion from a superseded validation thread is dropped entirely
        # (its result corresponds to a file the user moved on from).
        if generation is not None and generation != self._validation_generation:
            return

        # Update the validation status flag
        setattr(self, validation_flag_name, is_valid)

        # Store the path if valid: the VERIFIED file path from the validation
        # thread, never the entry text read at completion time (the user may
        # have edited the entry while validation was in flight).
        if is_valid is True:
            if validation_flag_name == "primer_log_valid":
                self._primer_log_path = validated_path or entry_widget.get()

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
        """Checks if all files are valid and enables/disables the Analyze button."""
        all_valid = self.primer_log_valid
        if all_valid:
            self.button_analyze.configure(state="normal", fg_color="#3C702D")
        else:
            self.button_analyze.configure(state="disabled", fg_color="gray50")

    def _setup_initial_paths(self, primer_log_path):
        """Pre-fills entry widgets with provided paths and then starts sequential validation."""
        # --- Phase 1: Autofill all paths immediately ---
        if primer_log_path:
            self.entry_primer_log.delete(0, "end")
            self.entry_primer_log.insert(0, primer_log_path)

        # --- Phase 2: Start the validation chain ---
        self._start_sequential_validation()

    def _start_sequential_validation(self):
        """Starts the validation for any pre-filled paths in sequence."""
        # Get paths from the entry widgets now that they are filled
        primer_log_path = self.entry_primer_log.get()

        # Validate Primer Log if path exists
        if primer_log_path:
            self._start_validation_thread(
                self.entry_primer_log,
                self.primer_log_validation_label,
                primer_log_path,
                None,  # No specific sheet required
                "primer_log_valid",
                "Primer Database",
            )

    # --- Browse methods ---
    def _browse_primer_log(self):
        filename = filedialog.askopenfilename(
            title="Select Primer Database File",
            filetypes=[("Excel files", "*.xlsx")],
        )
        if filename:
            self.entry_primer_log.delete(0, "end")
            self.entry_primer_log.insert(0, filename)
            self._start_validation_thread(
                self.entry_primer_log,
                self.primer_log_validation_label,
                filename,
                None,  # No specific sheet required
                "primer_log_valid",
                "Primer Database",
            )

    # --- Entry edit reaction ---
    def _on_primer_log_entry_changed(self, event=None):
        """
        Fail closed on any hand edit of the entry: drop the stored validated
        path and flag, then re-validate (debounced) from the current text.
        """
        self.primer_log_valid = None
        self._primer_log_path = ""
        self._update_validation_ui(
            self.entry_primer_log,
            self.primer_log_validation_label,
            None,
            "",
            "primer_log_valid",
        )
        self._check_all_validations()

        # Debounced re-validation so typing a new path does not validate
        # every keystroke.
        if self._primer_log_after_id is not None:
            self.master.after_cancel(self._primer_log_after_id)
        self._primer_log_after_id = self.master.after(
            500, self._run_debounced_primer_log_validation
        )

    def _run_debounced_primer_log_validation(self):
        """Validates whatever the entry holds after the edit debounce window."""
        self._primer_log_after_id = None
        path = self.entry_primer_log.get().strip()
        if not path:
            return
        self._start_validation_thread(
            self.entry_primer_log,
            self.primer_log_validation_label,
            path,
            None,  # No specific sheet required
            "primer_log_valid",
            "Primer Database",
        )

    # --- Analysis methods ---
    def _start_analysis(self):
        """Starts the analysis in a background thread."""
        self.button_analyze.configure(state="disabled", fg_color="gray50")
        self._clear_results()
        self.progress.set(0)
        self._log_status("Starting analysis...", "blue")

        # Snapshot the target text on the calling thread: the worker thread
        # must not touch tkinter widgets (tkinter is not thread-safe).
        target_text = self.text_sequence.get("1.0", "end")

        thread = threading.Thread(
            target=self._analysis_thread, args=(target_text,), daemon=True
        )
        thread.start()

    def _analysis_thread(self, target_text):
        """
        The main analysis logic that runs in a background thread.

        Receives the target text snapshotted on the calling (main) thread and
        must not touch any tkinter widget directly.
        """
        # Lazy import pandas (heavy module)
        import pandas as pd

        try:
            # --- Target cleaning, step by step so every removal is counted ---
            content = target_text.strip()

            # Basic Validation
            if not content:
                self.master.after(0, lambda: messagebox.showerror("Error", "Please enter a target DNA sequence."))
                self.master.after(0, lambda: self._log_status("Error: No sequence entered", "red"))
                self.master.after(0, lambda: self.button_analyze.configure(state="normal", fg_color="#3C702D"))
                return

            # Step 1: drop whitespace inside the paste (newlines, spaces) -
            # formatting only, never counted as a dropped character.
            cleaned = re.sub(r"\s+", "", content).upper()

            # Step 2: drop every character that is not A/T/C/G/N, e.g. letters
            # or numbers from pasted text. The count of removed characters is
            # reported when the run completes.
            target_seq = re.sub(r"[^ATCGN]", "", cleaned)
            dropped_chars = len(cleaned) - len(target_seq)

            if not target_seq:
                self.master.after(0, lambda: messagebox.showerror("Error", "No valid DNA sequence found."))
                self.master.after(0, lambda: self._log_status("Error: Invalid sequence", "red"))
                self.master.after(0, lambda: self.button_analyze.configure(state="normal", fg_color="#3C702D"))
                return

            if not self._primer_log_path or not os.path.exists(self._primer_log_path):
                self.master.after(0, lambda: messagebox.showerror("Error", "Please select a valid primer database file."))
                self.master.after(0, lambda: self._log_status("Error: Invalid primer database", "red"))
                self.master.after(0, lambda: self.button_analyze.configure(state="normal", fg_color="#3C702D"))
                return

            self.master.after(0, lambda: self._log_status("Loading primer database...", "blue"))

            # Load Excel file
            xls = pd.ExcelFile(self._primer_log_path)

            # Order-sheet contract: the sheet name is a year-letter code
            # S/T/U/V + MMDD (e.g. S0104, U0910). Anything else in the workbook
            # (Summary, Sheet1, USHE198, ...) is NOT scanned - a full-column
            # junk sheet there made every run walk a million empty rows.
            valid_sheets = [
                sheet
                for sheet in xls.sheet_names
                if re.fullmatch(r'[STUV]\d{4}', sheet.strip().upper())
            ]

            if not valid_sheets:
                self.master.after(0, lambda: messagebox.showwarning("No Sheets Found", "No order-form sheets found (S/T/U/V + MMDD, e.g. S0104 or U0910)."))
                self.master.after(0, lambda: self._log_status("No order-form sheets found", "orange"))
                self.master.after(0, lambda: self.button_analyze.configure(state="normal", fg_color="#3C702D"))
                return

            total_sheets = len(valid_sheets)
            self.master.after(0, lambda: self.progress.configure(mode="determinate"))

            matches_found = 0
            skipped_sheets = []  # (sheet name, reason) for every unread sheet
            fallback_sheets = 0  # sheets where row-34 header matching failed
            target_rc = get_reverse_complement(target_seq)

            for i, sheet_name in enumerate(valid_sheets):
                self.master.after(0, lambda s=sheet_name, n=i+1, t=total_sheets: 
                    self._log_status(f"Processing sheet: {s} ({n}/{t})", "blue"))

                # Read rows 35+ (no end cap). Column positions are resolved per sheet
                # with a name-first pass: row 34 (the formatted order form's
                # header row) carries 'Oligo Name' (possibly with an embedded
                # line break) and "Sequence (5' to 3')". A plate-order sheet
                # prepends a 'Wells' column, shifting the pair one right, so
                # the letters are NOT fixed. Falls back to A:B when the
                # header row does not match (older formatting).
                try:
                    df_cols = pd.read_excel(
                        xls, sheet_name=sheet_name, header=None,
                        skiprows=33, nrows=1,
                    )
                    name_idx = seq_idx = None  # None -> fallback to A:B
                    cells = df_cols.iloc[0].tolist() if len(df_cols) else []
                    for j, v in enumerate(cells):
                        token = re.sub(r"\s+", " ", str(v)).strip().lower()
                        if token == "oligo name" and name_idx is None:
                            name_idx = j
                        elif "sequence" in token and "(5" in token and seq_idx is None:
                            seq_idx = j
                    if name_idx is None or seq_idx is None:
                        fallback_sheets += 1
                        name_idx, seq_idx = 0, 1
                    df = pd.read_excel(
                        xls, sheet_name=sheet_name, header=None,
                        usecols=[name_idx, seq_idx], skiprows=34,
                    )
                except Exception as e:
                    skipped_sheets.append((sheet_name, str(e)[:80]))
                    continue

                # Iterate through rows (positional: pandas may drop
                # all-NaN columns from the usecols selection, so the
                # Series labels are not reliable; .to_numpy() keeps the
                # selected column order intact)
                values = df.to_numpy()
                if values.ndim < 2 or values.shape[1] < 2:
                    skipped_sheets.append((sheet_name, "no readable Name/Sequence columns"))
                    continue
                for row_vals in values:
                    # Col 0 is Name, col 1 is Sequence (resolved above)
                    primer_name = str(row_vals[0]).strip() if pd.notna(row_vals[0]) else "Unknown"
                    primer_seq_raw = str(row_vals[1]).strip() if pd.notna(row_vals[1]) else ""

                    if not primer_seq_raw:
                        continue

                    # Clean and uppercase
                    primer_seq = primer_seq_raw.upper()

                    # Basic validation
                    if len(primer_seq) < 10 or len(primer_seq) > 100:
                        continue

                    if not re.fullmatch(r'[ATCGN]+', primer_seq):
                        continue

                    # Check Binding
                    orientation = None
                    position = -1

                    # Check Forward (Primer sequence exists in Target)
                    if primer_seq in target_seq:
                        orientation = "Forward (Exact Match)"
                        position = target_seq.find(primer_seq) + 1

                    # Check Reverse (Primer sequence exists in Reverse Complement of Target)
                    # This means the primer binds to the forward strand of the target
                    elif primer_seq in target_rc:
                        orientation = "Reverse (Binds to Target)"
                        position = target_rc.find(primer_seq) + 1

                    if orientation:
                        result_line = f"{sheet_name:<6} | {primer_name:<30} | {orientation:<25} |  {str(position):<5} | {primer_seq}"
                        self.master.after(0, lambda r=result_line: self._add_result(r))
                        matches_found += 1

                # Update progress
                self.master.after(0, lambda v=(i+1)/total_sheets: self.progress.set(v))

            xls.close()

            # Run summary: sheets scanned/skipped, A:B fallback usage, and the
            # count of non-DNA characters dropped from the pasted target.
            summary = (
                f"Found {matches_found} matching primers. "
                f"Scanned {total_sheets} order sheet(s)."
            )
            notes = []
            if skipped_sheets:
                notes.append(
                    f"{len(skipped_sheets)} sheet(s) skipped: "
                    + ", ".join(name for name, _ in skipped_sheets)
                )
            if fallback_sheets:
                notes.append(
                    f"A:B fallback used on {fallback_sheets} sheet(s) "
                    "(row-34 header not recognized)"
                )
            status_msg = f"Done! {summary}"
            if dropped_chars:
                status_msg += (
                    f" ({dropped_chars} non-DNA char(s) dropped from target)"
                )
            if notes:
                status_msg += " | " + "; ".join(notes)
            status_color = "orange" if dropped_chars else "green"

            dialog_msg = f"Analysis complete.\n{summary}"
            for note in notes:
                dialog_msg += f"\n{note}"
            if dropped_chars:
                dialog_msg += (
                    f"\n\n{dropped_chars} non-DNA character(s) were dropped from the pasted "
                    "target (only A, T, C, G, N are kept - other letters, digits and symbols "
                    "are removed). Please verify the pasted text and re-run if needed."
                )

            self.master.after(0, lambda m=status_msg, c=status_color: self._log_status(m, c))
            self.master.after(0, lambda m=dialog_msg: messagebox.showinfo("Complete", m))

        except Exception as e:
            try:
                xls.close()
            except Exception:
                pass
            self.master.after(0, lambda err=str(e): self._log_status(f"Error: {err}", "red"))
            self.master.after(0, lambda err=str(e): messagebox.showerror("Error", f"An error occurred:\n{err}"))
        finally:
            self.master.after(0, lambda: self.button_analyze.configure(state="normal", fg_color="#3C702D"))


def main():
    """Standalone entry point when not launched from the hub."""
    ctk.set_appearance_mode("System")
    ctk.set_default_color_theme("blue")

    root = ctk.CTk()
    app = PrimerFinderApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()