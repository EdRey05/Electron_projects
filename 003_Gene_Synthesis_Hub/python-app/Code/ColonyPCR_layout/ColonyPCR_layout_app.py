"""
Bio Basic Inc. - Canada
Made by: Fabien Lonjon and Eduardo Reyes.
Contact: ed5reyes@outlook

Version: 1.5
Date: Oct 13, 2026
Notes: Both workbook reads use the two-step column pass: headers matched
    by name first (legacy Job ID / BBID / Length spellings tolerated),
    historic fixed positions only as fallback, with the fired path
    logged. Field names follow the canonical job-log naming
    (Work No./BBI ID). The A1 plate header stays date-coded until the
    file is saved, when it is replaced by the saved file name.
"""

import os
import traceback
import threading
from datetime import datetime
from itertools import groupby

import openpyxl
from openpyxl.styles import Border, Side, Font
from openpyxl.utils import get_column_letter

# Lazy imports for heavy modules (imported only when needed):
# - pandas: ~0.6s startup delay, only used in processing methods
# import pandas as pd  # MOVED to fill_colony_pcr_layout()

import customtkinter as ctk
from tkinter import filedialog, messagebox


class CTkSpinBox(ctk.CTkFrame):
    """A spinbox widget with +/- buttons for numeric input."""

    def __init__(self, master, min_val=0, max_val=96, default_value=4, width=100, **kwargs):
        super().__init__(master, fg_color="transparent", width=width, **kwargs)
        
        self.min_val = min_val
        self.max_val = max_val
        self.value = default_value

        # Configure grid
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        # Minus button
        self.minus_btn = ctk.CTkButton(
            self, text="-", width=28, height=28,
            command=self.decrement,
            font=ctk.CTkFont(size=14, weight="bold")
        )
        self.minus_btn.grid(row=0, column=0, padx=(0, 2), pady=0)

        # Entry field
        self.entry = ctk.CTkEntry(self, width=40, height=28, justify="center")
        self.entry.insert(0, str(default_value))
        self.entry.grid(row=0, column=1, padx=0, pady=0)
        self.entry.bind("<Return>", self._on_entry_return)
        self.entry.bind("<FocusOut>", self._on_entry_focus_out)

        # Plus button
        self.plus_btn = ctk.CTkButton(
            self, text="+", width=28, height=28,
            command=self.increment,
            font=ctk.CTkFont(size=14, weight="bold")
        )
        self.plus_btn.grid(row=0, column=2, padx=(2, 0), pady=0)

    def increment(self):
        """Increment value by 1."""
        if self.value < self.max_val:
            self.value += 1
            self._update_entry()

    def decrement(self):
        """Decrement value by 1."""
        if self.value > self.min_val:
            self.value -= 1
            self._update_entry()

    def _update_entry(self):
        """Update entry field with current value."""
        self.entry.delete(0, "end")
        self.entry.insert(0, str(self.value))

    def _on_entry_return(self, event):
        """Handle Enter key press."""
        self._validate_and_set()

    def _on_entry_focus_out(self, event):
        """Handle focus out event."""
        self._validate_and_set()

    def _validate_and_set(self):
        """Validate and set the entry value."""
        try:
            new_val = int(self.entry.get())
            new_val = max(self.min_val, min(self.max_val, new_val))
            self.value = new_val
            self._update_entry()
        except ValueError:
            self._update_entry()  # Reset to last valid value

    def get(self):
        """Return current value as integer."""
        self._validate_and_set()
        return self.value


class CloneCountDialog(ctk.CTkToplevel):
    """A dialog to get the number of clones for each Work No."""

    def __init__(self, parent, job_details):
        super().__init__(parent)
        self.title("Number of Clones")
        self.geometry("700x500")
        self.transient(parent)
        self.grab_set()

        self.spinboxes = []  # Store tuples of (Work No., SourceFile, spinbox_widget)
        self.clone_counts = {}

        # Column configuration for grid layout
        self.column_widths = {
            "Work No.": 90,
            "BBI ID": 80,
            "Vector": 80,
            "Length (bp)": 75,
            "SourceFile": 180,
            "Clones": 100,
        }
        self.column_padx = 4

        main_frame = ctk.CTkFrame(self, fg_color="transparent")
        main_frame.pack(fill="both", expand=True, padx=10, pady=10)

        # Header row using grid
        header_frame = ctk.CTkFrame(main_frame, fg_color=("gray85", "gray25"))
        header_frame.pack(fill="x", pady=(0, 5))

        headers = [
            ("Work No.", "Work No."),
            ("BBI ID", "BBI ID"),
            ("Vector", "Vector"),
            ("Length (bp)", "Length (bp)"),
            ("SourceFile", "Ligation File"),
            ("Clones", "# Clones"),
        ]

        for col_idx, (col_key, header_text) in enumerate(headers):
            label = ctk.CTkLabel(
                header_frame,
                text=header_text,
                width=self.column_widths[col_key],
                anchor="center",
                font=ctk.CTkFont(weight="bold"),
            )
            label.grid(row=0, column=col_idx, padx=self.column_padx, pady=5, sticky="ew")
            header_frame.grid_columnconfigure(col_idx, weight=0)

        # Scrollable frame for job rows
        scrollable_frame = ctk.CTkScrollableFrame(main_frame)
        scrollable_frame.pack(fill="both", expand=True)

        # Configure columns in scrollable frame for alignment
        for col_idx in range(6):
            scrollable_frame.grid_columnconfigure(col_idx, weight=0)

        # Add rows for each job
        for row_idx, (_, job_info) in enumerate(job_details.iterrows()):
            # Alternate row colors for readability
            row_bg = ("gray95", "gray20") if row_idx % 2 == 0 else ("gray90", "gray15")
            row_frame = ctk.CTkFrame(scrollable_frame, fg_color=row_bg, corner_radius=0)
            row_frame.grid(row=row_idx, column=0, columnspan=6, sticky="ew", pady=1)

            # Work No.
            ctk.CTkLabel(
                row_frame,
                text=job_info["Work No."],
                width=self.column_widths["Work No."],
                anchor="center",
            ).grid(row=0, column=0, padx=self.column_padx, pady=3, sticky="ew")

            # BBI ID
            ctk.CTkLabel(
                row_frame,
                text=job_info["BBI ID"],
                width=self.column_widths["BBI ID"],
                anchor="center",
            ).grid(row=0, column=1, padx=self.column_padx, pady=3, sticky="ew")

            # Vector
            ctk.CTkLabel(
                row_frame,
                text=job_info["Vector"],
                width=self.column_widths["Vector"],
                anchor="center",
            ).grid(row=0, column=2, padx=self.column_padx, pady=3, sticky="ew")

            # Length
            ctk.CTkLabel(
                row_frame,
                text=str(job_info["Length (bp)"]),
                width=self.column_widths["Length (bp)"],
                anchor="center",
            ).grid(row=0, column=3, padx=self.column_padx, pady=3, sticky="ew")

            # Source File (just basename)
            source_file_name = os.path.basename(job_info["SourceFile"])
            # Truncate long filenames for display
            if len(source_file_name) > 25:
                source_file_name = source_file_name[:22] + "..."
            ctk.CTkLabel(
                row_frame,
                text=source_file_name,
                width=self.column_widths["SourceFile"],
                anchor="center",
            ).grid(row=0, column=4, padx=self.column_padx, pady=3, sticky="ew")

            # Spinbox for clone count
            spinbox = CTkSpinBox(
                row_frame,
                min_val=0,
                max_val=96,
                default_value=4,
                width=self.column_widths["Clones"],
            )
            spinbox.grid(row=0, column=5, padx=self.column_padx, pady=3, sticky="ew")

            self.spinboxes.append((job_info["Work No."], job_info["SourceFile"], spinbox))

        # Confirm button
        button_frame = ctk.CTkFrame(self, fg_color="transparent")
        button_frame.pack(pady=10)
        
        ctk.CTkButton(
            button_frame,
            text="Confirm",
            command=self.on_confirm,
            width=120,
            height=36,
            font=ctk.CTkFont(size=14, weight="bold"),
        ).pack()

    def on_confirm(self):
        """Collect values from all spinboxes and close dialog."""
        for work_no, source_file, spinbox in self.spinboxes:
            self.clone_counts[(work_no, source_file)] = spinbox.get()
        self.destroy()


class ColonyPCRLayoutApp:
    """
    Automated Colony PCR Layout generator for the Gene Synthesis workflow.

    Accepts Ligation Layout files and generates a Colony PCR layout Excel file by:
    1. Extracting job info from Ligation Layout files
    2. Matching primers from the Primer Log
    3. Filling the Colony PCR Template with matched data
    """

    def __init__(
        self,
        master,
        primer_log_path=None,
        colony_pcr_template_path=None,
    ):
        self.master = master
        master.title("Colony PCR Layout")
        master.geometry("600x780")

        # --- Validation flags ---
        self.primer_log_valid = False
        self.colony_pcr_template_valid = False

        # --- Internal storage ---
        self._primer_log_path = ""
        self._colony_pcr_template_path = ""
        self._ligation_files = []  # List of selected ligation layout files

        # --- Build UI ---
        self._setup_ui()

        # --- Setup initial paths (matches Ligation_layout pattern) ---
        self.master.after(
            200,
            lambda: self._setup_initial_paths(primer_log_path, colony_pcr_template_path),
        )

    def _setup_ui(self):
        """Creates all UI widgets."""

        # --- Ligation Layout Files (Multi-select) ---
        ligation_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        ligation_frame.pack(pady=(15, 10), padx=15, fill="x")

        ctk.CTkLabel(
            ligation_frame,
            text="Ligation Layout Files (.xlsx)",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(anchor="w")

        ctk.CTkLabel(
            ligation_frame,
            text="Select one or more ligation layout files",
            font=ctk.CTkFont(size=12),
            text_color="gray",
        ).pack(anchor="w")

        # Listbox with scrollbar for multi-file selection
        listbox_frame = ctk.CTkFrame(ligation_frame, fg_color="transparent")
        listbox_frame.pack(fill="x", pady=(5, 0))

        # Use CTkTextbox as a display for selected files
        self.ligation_textbox = ctk.CTkTextbox(listbox_frame, height=80, wrap="word")
        self.ligation_textbox.pack(side="left", fill="x", expand=True, padx=(0, 10))
        self.ligation_textbox.configure(state="disabled")

        # Buttons frame
        button_frame = ctk.CTkFrame(listbox_frame, fg_color="transparent")
        button_frame.pack(side="right")

        ctk.CTkButton(
            button_frame,
            text="Add...",
            command=self._add_ligation_files,
            width=70,
        ).pack(pady=(0, 5))

        ctk.CTkButton(
            button_frame,
            text="Clear",
            command=self._clear_ligation_files,
            width=70,
        ).pack()

        # --- Primer Log (Autodetected) ---
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

        # --- Colony PCR Template (Autodetected) ---
        self.colony_pcr_template_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        self.colony_pcr_template_frame.pack(pady=(15, 10), padx=15, fill="x")

        ctk.CTkLabel(
            self.colony_pcr_template_frame,
            text="Colony PCR Layout Template",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(anchor="center")

        entry_frame_cpt = ctk.CTkFrame(self.colony_pcr_template_frame, fg_color="transparent")
        entry_frame_cpt.pack(fill="x", pady=(2, 2))

        self.entry_colony_pcr_template = ctk.CTkEntry(entry_frame_cpt, border_width=1)
        self.entry_colony_pcr_template.pack(side="left", fill="x", expand=True, padx=(0, 10))

        self.button_colony_pcr_template = ctk.CTkButton(
            entry_frame_cpt,
            text="Select",
            command=self._browse_colony_pcr_template,
            width=90,
        )
        self.button_colony_pcr_template.pack(side="right")

        self.colony_pcr_template_validation_label = ctk.CTkLabel(
            self.colony_pcr_template_frame,
            text="",
            font=ctk.CTkFont(size=14),
            anchor="w",
            justify="left",
        )
        self.colony_pcr_template_validation_label.pack(fill="x")

        # --- Generate Button ---
        generate_button_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        generate_button_frame.pack(pady=20, padx=20, fill="x")
        generate_button_frame.grid_columnconfigure((0, 2), weight=2)  # Spacers
        generate_button_frame.grid_columnconfigure(1, weight=1)  # Button column

        self.button_generate = ctk.CTkButton(
            generate_button_frame,
            text="Generate Layout",
            command=self._start_processing,
            font=ctk.CTkFont(size=14, weight="bold"),
            height=40,
            fg_color="#3C702D",
            hover_color="#4CAF50",
        )
        self.button_generate.configure(state="disabled", fg_color="gray50")
        self.button_generate.grid(row=0, column=1, sticky="ew")

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

    # --- Ligation files management ---
    def _update_ligation_display(self):
        """Updates the textbox display with current ligation files."""
        self.ligation_textbox.configure(state="normal")
        self.ligation_textbox.delete("1.0", "end")
        if self._ligation_files:
            for f in self._ligation_files:
                self.ligation_textbox.insert("end", os.path.basename(f) + "\n")
        else:
            self.ligation_textbox.insert("end", "No files selected")
        self.ligation_textbox.configure(state="disabled")

    def _add_ligation_files(self):
        """Opens file dialog to add ligation layout files."""
        filenames = filedialog.askopenfilenames(
            title="Select Ligation Layout Files",
            filetypes=[("Excel files", "*.xlsx *.xlsm"), ("All files", "*.*")],
        )
        for filename in filenames:
            if filename and filename not in self._ligation_files:
                self._ligation_files.append(filename)
        self._update_ligation_display()
        self._check_all_validations()

    def _clear_ligation_files(self):
        """Clears all selected ligation files."""
        self._ligation_files = []
        self._update_ligation_display()
        self._check_all_validations()

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
    ):
        """
        Checks if a file exists and contains the expected sheet.
        This method runs in a background thread and schedules UI updates.
        """
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
            )
            return

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
            )

    def _update_validation_ui(
        self,
        entry_widget,
        validation_label_widget,
        is_valid,
        message,
        validation_flag_name,
        file_display_name=None,
        next_callback=None,
    ):
        """
        Updates the UI to reflect the validation status of a file.
        This method is always run on the main UI thread.
        """
        # Update the validation status flag
        setattr(self, validation_flag_name, is_valid)

        # Store the path if valid
        if is_valid is True:
            if validation_flag_name == "primer_log_valid":
                self._primer_log_path = entry_widget.get()
            elif validation_flag_name == "colony_pcr_template_valid":
                self._colony_pcr_template_path = entry_widget.get()

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
        """Checks if all files are valid and enables/disables the Generate button."""
        all_valid = (
            self.primer_log_valid
            and self.colony_pcr_template_valid
            and len(self._ligation_files) > 0
        )
        if all_valid:
            self.button_generate.configure(state="normal", fg_color="#3C702D")
        else:
            self.button_generate.configure(state="disabled", fg_color="gray50")

    def _setup_initial_paths(self, primer_log_path, colony_pcr_template_path):
        """Pre-fills entry widgets with provided paths and then starts sequential validation."""
        # --- Phase 1: Autofill all paths immediately ---
        if primer_log_path:
            self.entry_primer_log.delete(0, "end")
            self.entry_primer_log.insert(0, primer_log_path)

        if colony_pcr_template_path:
            self.entry_colony_pcr_template.delete(0, "end")
            self.entry_colony_pcr_template.insert(0, colony_pcr_template_path)

        # --- Phase 2: Start the validation chain ---
        self._start_sequential_validation()

    def _start_sequential_validation(self):
        """Starts the validation for any pre-filled paths in sequence."""
        # Get paths from the entry widgets now that they are filled
        primer_log_path = self.entry_primer_log.get()
        colony_pcr_template_path = self.entry_colony_pcr_template.get()

        # Define chained callbacks

        # 2. Colony PCR Template (Last)
        def validate_template():
            if colony_pcr_template_path:
                self._start_validation_thread(
                    self.entry_colony_pcr_template,
                    self.colony_pcr_template_validation_label,
                    colony_pcr_template_path,
                    None,  # No specific sheet required
                    "colony_pcr_template_valid",
                    "Colony PCR Template",
                )

        # 1. Primer Log (First)
        if primer_log_path:
            self._start_validation_thread(
                self.entry_primer_log,
                self.primer_log_validation_label,
                primer_log_path,
                "input addon",
                "primer_log_valid",
                "Primer Log",
                next_callback=validate_template,
            )
        else:
            validate_template()  # Skip to next if path is missing

    # --- Browse methods ---
    def _browse_primer_log(self):
        filename = filedialog.askopenfilename(
            title="Select Primer Log File",
            filetypes=[("Excel files", "*.xlsx *.xlsm"), ("All files", "*.*")],
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
                "Primer Log",
            )

    def _browse_colony_pcr_template(self):
        filename = filedialog.askopenfilename(
            title="Select Colony PCR Layout Template",
            filetypes=[("Excel files", "*.xlsx *.xlsm"), ("All files", "*.*")],
        )
        if filename:
            self.entry_colony_pcr_template.delete(0, "end")
            self.entry_colony_pcr_template.insert(0, filename)
            self._start_validation_thread(
                self.entry_colony_pcr_template,
                self.colony_pcr_template_validation_label,
                filename,
                None,
                "colony_pcr_template_valid",
                "Colony PCR Template",
            )

    # --- Processing methods ---
    def _start_processing(self):
        """Starts the processing logic in a background thread."""
        self.button_generate.configure(state="disabled", fg_color="gray50")
        self._clear_log()
        self._log("Processing started...")

        thread = threading.Thread(target=self._processing_thread, daemon=True)
        thread.start()

    def _processing_thread(self):
        """The main processing logic that runs in a background thread."""
        try:
            if not self._ligation_files:
                self.master.after(
                    0, lambda: messagebox.showerror("Error", "Please select at least one Ligation Layout file.")
                )
                self._log_threaded("ERROR: No Ligation Layout files selected. Processing stopped.")
                return

            self._log_threaded(f"Found {len(self._ligation_files)} Ligation Layout file(s) to process.")

            # Call the processing function
            output_path = fill_colony_pcr_layout(
                self.master,
                self._ligation_files,
                self._colony_pcr_template_path,
                self._primer_log_path,
                logger=self._log_threaded,
            )

            if output_path:
                self._log_threaded(f"\n--- Processing Finished ---")
                self._log_threaded(f"File saved to: {output_path}")
                self.master.after(
                    0,
                    lambda: messagebox.showinfo(
                        "Success",
                        f"Colony PCR Layout created successfully:\n{output_path}",
                    ),
                )
            else:
                self._log_threaded("\nProcessing cancelled or failed.")

        except Exception as e:
            self._log_threaded(f"\nERROR: {traceback.format_exc()}")
            self.master.after(0, lambda: messagebox.showerror("Error", str(e)))
        finally:
            self.master.after(
                0, lambda: self.button_generate.configure(state="normal", fg_color="#3C702D")
            )


_LIGATION_WANTED = [
    ("Well", ["well"]),
    ("Work No.", ["work no.", "job id", "jobid", "job_id"]),
    ("BBI ID", ["bbi id", "bbid"]),
    ("Vector", ["vector"]),
    ("Length (bp)", ["length (bp)", "length"]),
    ("Resistance", ["resistance", "antibiotic"]),
    ("Host", ["host"]),
    ("Temperature", ["temperature"]),
]


def _norm_header(h):
    """Normalize a header cell for name matching: collapse all whitespace
    (line breaks / tabs / double spaces) and lowercase."""
    import re
    return re.sub(r"\s+", " ", str(h)).strip().lower()


def _read_ligation_layout(path, logger=print):
    """Read one Ligation Layout 'Layout' sheet with the 2-step column pass.

    Resolves Well / Work No. / BBI ID / Vector / Length (bp) / Resistance /
    Host / Temperature by row-1 header name first (legacy Job ID / BBID /
    Length spellings tolerated); falls back to the historic fixed columns
    A,B,C,D,T,U,V,W when the header row does not match. Logs which path
    fired. Raises on unreadable sheets (per-file warning upstream).
    """
    import pandas as pd

    fallback_names = ["Well", "Work No.", "BBI ID", "Vector",
                      "Length (bp)", "Resistance", "Host", "Temperature"]
    fallback_cols = "A,B,C,D,T,U,V,W"

    try:
        probe = pd.read_excel(path, sheet_name="Layout", engine="openpyxl",
                              header=None, nrows=1)
        idx = {}
        if len(probe):
            for i, h in enumerate(probe.iloc[0]):
                idx.setdefault(_norm_header(h), i)
        resolved = []
        for _canonical, candidates in _LIGATION_WANTED:
            found = next((idx[c] for c in candidates if c in idx), None)
            resolved.append(found)
        if all(i is not None for i in resolved):
            df = pd.read_excel(path, sheet_name="Layout", engine="openpyxl",
                               header=None, skiprows=1)
            df = df.iloc[:, resolved]
            df.columns = fallback_names
            detail = ", ".join(
                f"{name}={get_column_letter(i + 1)}"
                for name, i in zip(fallback_names, resolved)
            )
            logger(f"  > {os.path.basename(path)}: columns resolved by name ({detail})")
            return df
        logger(f"  > {os.path.basename(path)}: header row not recognized, "
               f"falling back to fixed columns ({fallback_cols})")
    except Exception as e:
        logger(f"  > {os.path.basename(path)}: name-first probe failed ({e}), "
               f"falling back to fixed columns ({fallback_cols})")

    df = pd.read_excel(path, sheet_name="Layout", engine="openpyxl",
                       header=None, skiprows=1, usecols=fallback_cols)
    df.columns = fallback_names
    return df


def _build_primer_mapping(df_primer, logger=print):
    """Build the Work No. -> primers mapping from the Primer Log 'input
    addon' sheet with the 2-step column pass.

    Resolves the Work No. (historic col 0) and Colony PCR primers
    (historic col 10) columns by header name first (legacy JobID
    spellings tolerated); falls back to the historic positions when the
    header row does not match. Returns (mapping, name_path_used).
    """
    import pandas as pd

    cols = {_norm_header(c): i for i, c in enumerate(df_primer.columns)}
    wi = next((cols[c] for c in ("work no.", "jobid", "job id", "job_id") if c in cols), None)
    pi = next((cols[c] for c in ("colony pcr primers",) if c in cols), None)
    if wi is not None and pi is not None and wi != pi:
        mapping = pd.Series(df_primer.iloc[:, pi].values,
                            index=df_primer.iloc[:, wi].values).to_dict()
        logger("  > Primer Log: columns resolved by name "
               f"({get_column_letter(wi + 1)}=Work No., "
               f"{get_column_letter(pi + 1)}=primers)")
        return mapping, True
    logger("  > Primer Log: header row not recognized, "
           "falling back to fixed columns (A / K)")
    mapping = pd.Series(df_primer.iloc[:, 10].values,
                        index=df_primer.iloc[:, 0].values).to_dict()
    return mapping, False


def fill_colony_pcr_layout(parent_window, ligation_layout_paths, colony_pcr_template_path, primer_log_path, logger=print):
    """
    Reads ligation and primer log files, extracts relevant data,
    and fills an existing empty colony PCR layout Excel file.
    """
    # Lazy import pandas (heavy module)
    import pandas as pd

    try:
        # --- 1a. Read all Ligation Layout files and combine them ---
        all_ligation_dfs = []
        for path in ligation_layout_paths:
            try:
                df_single_ligation = _read_ligation_layout(path, logger=logger)
                df_single_ligation["SourceFile"] = path
                all_ligation_dfs.append(df_single_ligation)
                logger(f"  > Loaded: {os.path.basename(path)}")
            except Exception as e:
                logger(f"WARNING: Could not process file {os.path.basename(path)}: {e}")

        if not all_ligation_dfs:
            logger("ERROR: No valid Ligation Layout files could be processed.")
            parent_window.after(
                0, lambda: messagebox.showerror("Error", "No valid Ligation Layout files could be processed.")
            )
            return None

        df_ligation = pd.concat(all_ligation_dfs, ignore_index=True)
        logger(f"  > Combined {len(df_ligation)} rows from all files.")

        # --- 1b. Read the Primer Log to create a Work No. -> Primer mapping ---
        df_primer = pd.read_excel(primer_log_path, sheet_name="input addon", engine="openpyxl")
        primer_mapping, _primer_name_path = _build_primer_mapping(df_primer, logger=logger)
        logger("  > Primer Log loaded.")

        # Filter out rows where the 'Work No.' column is empty
        df_ligation = df_ligation.dropna(subset=["Work No."])

        # Filter out rows where 'Work No.' starts with "CK" (controls)
        df_ligation = df_ligation[~df_ligation["Work No."].astype(str).str.startswith("CK")]

        # --- 2. Create summary data ---
        summary_data = df_ligation[[
            "Work No.", "BBI ID", "Vector", "Resistance", "Length (bp)", "Host", "Temperature", "SourceFile"
        ]].copy()

        summary_data["Primers"] = summary_data["Work No."].map(primer_mapping).fillna("")
        summary_data["SourceFile"] = summary_data["SourceFile"].apply(os.path.basename)

        summary_data = summary_data[[
            "Work No.", "BBI ID", "Vector", "Resistance", "Primers", "Length (bp)", "Host", "Temperature", "SourceFile"
        ]]

        # --- 3. Load the Colony PCR template ---
        wb = openpyxl.load_workbook(colony_pcr_template_path)
        ws = wb.active
        ws.title = "Plate 1"

        logger("  > Template loaded.")

        # --- Helper function to generate plate header ---
        def set_plate_header(sheet, p_num):
            now = datetime.now()
            year_char = chr(now.year - 1941)
            date_str = now.strftime("%m%d")
            header_text = f"{year_char}{date_str}ColonyPCR-P{p_num}"
            cell = sheet["A1"]
            cell.value = header_text
            cell.font = Font(bold=True)

        set_plate_header(ws, 1)

        # --- Helper function to apply borders to a rectangular range ---
        def apply_range_borders(sheet, start_row, start_col, end_row, end_col, border_style="thin"):
            """Apply borders to an entire rectangular range as a whole.
            
            Args:
                sheet: The worksheet
                start_row: First row of range (1-indexed)
                start_col: First column of range (1-indexed)
                end_row: Last row of range (1-indexed)
                end_col: Last column of range (1-indexed)
                border_style: "thin" or "thick"
            """
            side = Side(style=border_style)
            
            # Apply inner borders (thin lines inside)
            inner_side = Side(style="thin") if border_style == "thick" else side
            
            for r in range(start_row, end_row + 1):
                for c in range(start_col, end_col + 1):
                    cell = sheet.cell(row=r, column=c)
                    existing = cell.border
                    
                    # Determine which borders this cell needs
                    is_top = (r == start_row)
                    is_bottom = (r == end_row)
                    is_left = (c == start_col)
                    is_right = (c == end_col)
                    
                    # Build border: use outer style for edges, inner style for interior
                    cell.border = Border(
                        left=side if is_left else inner_side,
                        right=side if is_right else inner_side,
                        top=side if is_top else inner_side,
                        bottom=side if is_bottom else inner_side
                    )

        # --- Helper function to write main samples table (all columns in one table) ---
        def write_samples_table(sheet, data_df, start_row=13):
            """Writes the main samples table with all columns including Primers."""
            # Create samples dataframe with unique jobs
            samples_df = data_df[["Work No.", "BBI ID", "Vector", "Resistance", "Primers", "Length (bp)", "Host", "Temperature"]].drop_duplicates(subset=["Work No."])
            
            # Clear previous content (columns B-I for 8 columns)
            for r in range(start_row, sheet.max_row + 1):
                for c in range(2, 10):  # B through I (8 columns)
                    sheet.cell(row=r, column=c).value = None
            
            # Write headers
            headers = ["Work No.", "BBI ID", "Vector", "Resistance", "Primers", "Length (bp)", "Host", "Temperature"]
            for c_idx, header in enumerate(headers, 1):
                cell = sheet.cell(row=start_row, column=c_idx + 1, value=header)
                cell.font = Font(bold=True)
            
            # Write data rows
            for r_idx, (_, row) in enumerate(samples_df.iterrows(), start_row + 1):
                for c_idx, col in enumerate(headers, 1):
                    sheet.cell(row=r_idx, column=c_idx + 1, value=row[col])
            
            # Apply borders to the entire table (header + data rows)
            if len(samples_df) > 0:
                end_row = start_row + len(samples_df)
                apply_range_borders(sheet, start_row, 2, end_row, 9, border_style="thin")
            
            return start_row + len(samples_df) + 1  # Return next available row (after empty row)

        # --- Helper function to write summary to sheet (samples table + mix calculation below) ---
        def write_summary_to_sheet(sheet, data_df):
            """Writes samples table followed by mix calculation table below."""
            samples_end_row = write_samples_table(sheet, data_df, start_row=13)
            # Return the row after the samples table (with empty row separator)
            return samples_end_row

        # --- Helper function to write mix calculation table ---
        def write_mix_calculation_table(sheet, plate_jobs, all_summary_data, all_clone_counts, start_row=13):
            """Writes the mix calculation table below the samples table."""
            plate_summary = all_summary_data[all_summary_data["Work No."].isin(plate_jobs)]
            unique_primers_on_plate = plate_summary["Primers"].unique()

            # Write "Mix Calculation" header
            sheet.cell(row=start_row, column=2, value="Mix Calculation").font = Font(bold=True)
            
            # Write row labels (Taq, H2O, Fwd, Rev)
            sheet.cell(row=start_row + 1, column=2, value="Taq")
            sheet.cell(row=start_row + 2, column=2, value="H2O")
            sheet.cell(row=start_row + 3, column=2, value="Fwd")
            sheet.cell(row=start_row + 4, column=2, value="Rev")

            current_mix_col = 3  # Start from column C (after the row labels)

            for primer_pair in unique_primers_on_plate:
                if not primer_pair:
                    continue

                jobs_with_this_primer = plate_summary[plate_summary["Primers"] == primer_pair]["Work No."]
                num_clones_for_primer = sum(
                    count for (job, _), count in all_clone_counts.items()
                    if job in jobs_with_this_primer.values
                )

                if num_clones_for_primer > 0:
                    # Header cell (primer pair name)
                    header_cell = sheet.cell(row=start_row, column=current_mix_col, value=primer_pair)
                    header_cell.font = Font(bold=True)

                    # Calculation cells
                    sheet.cell(row=start_row + 1, column=current_mix_col, value=10 * (num_clones_for_primer + 1))
                    sheet.cell(row=start_row + 2, column=current_mix_col, value=8.4 * (num_clones_for_primer + 1))
                    sheet.cell(row=start_row + 3, column=current_mix_col, value=0.8 * (num_clones_for_primer + 1))
                    sheet.cell(row=start_row + 4, column=current_mix_col, value=0.8 * (num_clones_for_primer + 1))
                    current_mix_col += 1
            
            # Apply borders to the entire mix calculation table
            if current_mix_col > 3:  # If we have at least one primer column
                end_col = current_mix_col - 1  # Last column with data
                end_row = start_row + 4  # Header + 4 data rows
                apply_range_borders(sheet, start_row, 2, end_row, end_col, border_style="thin")

        # --- Helper function to create new plate ---
        def create_new_plate(workbook, template_sheet, p_num):
            logger(f"  > Creating Plate {p_num}...")
            messagebox.showinfo("New Plate Created", f"Plate {p_num - 1} is full. Creating Plate {p_num}.")
            new_ws = workbook.copy_worksheet(template_sheet)
            new_ws.title = f"Plate {p_num}"
            set_plate_header(new_ws, p_num)

            thin_border = Border(
                left=Side(style="thin"),
                right=Side(style="thin"),
                top=Side(style="thin"),
                bottom=Side(style="thin")
            )
            for r in range(3, 11):
                for c in range(2, 14):
                    cell_to_clear = new_ws.cell(row=r, column=c)
                    cell_to_clear.value = None
                    cell_to_clear.border = thin_border
                    cell_to_clear.font = Font()
            return new_ws

        # --- Helper function to generate labels sheet ---
        def generate_labels_sheet(workbook, summary_df, clone_counts):
            if "Label" in workbook.sheetnames:
                del workbook["Label"]

            label_ws = workbook.create_sheet("Label")
            headers = ["Date", "PRINTED", "ITEM #", "SIZE", "QTY", "LOT#1", "PERSON", "REASSAY DATE", "LOT#2"]
            label_ws.append(headers)

            now = datetime.now()
            date_str_mdy_today = now.strftime("%m-%d-%Y")
            current_year_char = chr(now.year - 1941)
            current_date_code = now.strftime("%m%d")
            colopcr_date_code = f"{current_year_char}{current_date_code}"

            for _, job_row in summary_df.iterrows():
                work_no = job_row["Work No."]
                ligation_filename = job_row["SourceFile"]

                if clone_counts.get((work_no, os.path.basename(ligation_filename)), 0) == 0:
                    continue

                ligation_date_code = colopcr_date_code
                item_num = f"{work_no}-ColoPCR"
                lot1 = f"{ligation_date_code}-{item_num}-FL"

                ligation_basename = os.path.splitext(os.path.basename(ligation_filename))[0]
                if ligation_basename.upper().endswith("-FL"):
                    ligation_basename = ligation_basename[:-3]

                lot2 = f"{ligation_basename}._.{colopcr_date_code}-ColoPCR._.{work_no}"

                row_data = [
                    date_str_mdy_today,
                    None,
                    item_num,
                    "2x1",
                    1,
                    lot1,
                    None,
                    None,
                    lot2
                ]
                label_ws.append(row_data)

            for col in label_ws.columns:
                max_length = 0
                for cell in col:
                    max_length = max(max_length, len(str(cell.value)))
                label_ws.column_dimensions[col[0].column_letter].width = max_length + 2

        # --- Keep a template copy ---
        template_plate = wb["Plate 1"]

        # --- Ask user for clone counts ---
        job_details_for_dialog = summary_data.drop_duplicates(subset=["Work No.", "SourceFile"])

        dialog = CloneCountDialog(parent_window, job_details_for_dialog)
        parent_window.wait_window(dialog)
        clone_counts = dialog.clone_counts

        # Filter summary_data based on user selection
        summary_data = summary_data[summary_data.apply(
            lambda row: clone_counts.get((row["Work No."], row["SourceFile"]), 0) > 0,
            axis=1
        )].copy()

        if summary_data.empty:
            logger("No clones selected. Process cancelled.")
            return None

        # --- 4c. Fill the 96-well plate grid ---
        current_row = 0  # 0-indexed row within plate (0-7)
        current_col = 0  # 0-indexed column within plate (0-11)
        primers_in_current_col = None
        plate_number = 1
        plate_work_nos = set()

        thin_side = Side(style="thin")
        thin_border = Border(left=thin_side, right=thin_side, top=thin_side, bottom=thin_side)

        # Clear initial plate
        for r in range(3, 11):
            for c in range(2, 14):
                cell_to_clear = ws.cell(row=r, column=c)
                cell_to_clear.value = None
                cell_to_clear.border = thin_border

        # --- Helper function to apply thick border around a range in the plate grid ---
        def apply_thick_border_to_range(sheet, start_row_idx, start_col_idx, end_row_idx, end_col_idx, clone_count=None):
            """Apply thick border around the edges of clone cells in the plate grid.
            
            For even clone counts (4, 8, 16, etc.), draws a rectangular border.
            For uneven clone counts (9-15, etc.), draws an L-shaped border that traces
            around the actual filled cells rather than the bounding rectangle.
            
            Args:
                sheet: The worksheet
                start_row_idx: 0-indexed starting row (0-7)
                start_col_idx: 0-indexed starting column (0-11)
                end_row_idx: 0-indexed ending row (inclusive)
                end_col_idx: 0-indexed ending column (inclusive)
                clone_count: Number of clones (optional, needed for L-shaped borders)
            """
            thick_side = Side(style="thick")
            thin_side_inner = Side(style="thin")
            
            # Convert to Excel coordinates (1-indexed, with offset for plate grid)
            # Plate grid starts at row 3, column 2 in Excel
            excel_start_row = start_row_idx + 3
            excel_end_row = end_row_idx + 3
            excel_start_col = start_col_idx + 2
            excel_end_col = end_col_idx + 2
            
            # Determine if we need L-shaped border logic
            num_columns = end_col_idx - start_col_idx + 1
            use_l_shaped = False
            filled_cells = set()
            
            if clone_count is not None and num_columns > 1:
                # Calculate which cells are actually filled
                current_row = start_row_idx
                current_col = start_col_idx
                for i in range(clone_count):
                    filled_cells.add((current_row, current_col))
                    current_row += 1
                    if current_row >= 8:
                        current_row = 0
                        current_col += 1
                
                # Check if last column is partial (needs L-shaped border)
                # A full column has 8 rows, so partial column has < 8 cells
                # Calculate rows in last column
                cells_in_first_cols = (num_columns - 1) * 8
                remaining_in_last_col = clone_count - cells_in_first_cols
                
                # Adjust for starting row offset
                available_in_first_col = 8 - start_row_idx
                if clone_count > available_in_first_col:
                    remaining_after_first = clone_count - available_in_first_col
                    remaining_in_last_col = remaining_after_first % 8
                
                if remaining_in_last_col > 0 and remaining_in_last_col < 8:
                    use_l_shaped = True
            
            # Apply borders to each cell in the range
            for r in range(excel_start_row, excel_end_row + 1):
                for c in range(excel_start_col, excel_end_col + 1):
                    cell = sheet.cell(row=r, column=c)
                    
                    # Convert to 0-indexed plate coordinates for filled_cells lookup
                    plate_row = r - 3
                    plate_col = c - 2
                    
                    if use_l_shaped:
                        # L-shaped border logic: trace around actual filled cells
                        if (plate_row, plate_col) not in filled_cells:
                            # Empty cell - just apply thin borders
                            cell.border = Border(
                                top=thin_side_inner,
                                bottom=thin_side_inner,
                                left=thin_side_inner,
                                right=thin_side_inner
                            )
                            continue
                        
                        # Check each edge: thick if neighbor is not filled or out of bounds
                        has_filled_above = (plate_row - 1, plate_col) in filled_cells
                        has_filled_below = (plate_row + 1, plate_col) in filled_cells
                        has_filled_left = (plate_col - 1 >= start_col_idx) and ((plate_row, plate_col - 1) in filled_cells)
                        has_filled_right = (plate_row, plate_col + 1) in filled_cells
                        
                        cell.border = Border(
                            top=thick_side if not has_filled_above else thin_side_inner,
                            bottom=thick_side if not has_filled_below else thin_side_inner,
                            left=thick_side if not has_filled_left else thin_side_inner,
                            right=thick_side if not has_filled_right else thin_side_inner
                        )
                    else:
                        # Original rectangular border logic
                        is_top = (r == excel_start_row)
                        is_bottom = (r == excel_end_row)
                        is_left = (c == excel_start_col)
                        is_right = (c == excel_end_col)
                        
                        cell.border = Border(
                            top=thick_side if is_top else thin_side_inner,
                            bottom=thick_side if is_bottom else thin_side_inner,
                            left=thick_side if is_left else thin_side_inner,
                            right=thick_side if is_right else thin_side_inner
                        )

        # Process jobs
        for _, job_row in summary_data.sort_values(by="Vector").iterrows():
            work_no = job_row["Work No."]
            primers = job_row["Primers"]
            num_clones = clone_counts.get((work_no, job_row["SourceFile"]), 0)
            if num_clones == 0:
                continue

            # Check for plate overflow
            starts_in_new_col = (
                (current_row > 0 and primers_in_current_col is not None and primers != primers_in_current_col)
                or (current_row + num_clones > 8 and current_row > 0)
            )

            if (current_col + (1 if starts_in_new_col else 0)) >= 12:
                plate_number += 1
                current_col, current_row = 0, 0
                plate_summary_df = summary_data[summary_data["Work No."].isin(plate_work_nos)]
                samples_end_row = write_summary_to_sheet(ws, plate_summary_df)
                # Leave empty row before mix calculation table
                write_mix_calculation_table(ws, plate_work_nos, summary_data, clone_counts, start_row=samples_end_row + 1)
                ws = create_new_plate(wb, template_plate, plate_number)
                plate_work_nos = set()

            # Column transition
            new_col_needed = (
                (current_row > 0 and primers_in_current_col is not None and primers != primers_in_current_col)
                or (current_row + num_clones > 8 and current_row > 0)
            )

            if new_col_needed:
                current_col += 1
                current_row = 0
                primers_in_current_col = None

            # Record start position for this job's clone group
            group_start_row = current_row
            group_start_col = current_col
            group_end_col = current_col  # Track if clones span multiple columns
            
            # Place clones
            for i in range(1, num_clones + 1):
                if current_row >= 8:
                    current_col += 1
                    current_row = 0
                    primers_in_current_col = None
                    group_end_col = current_col  # Update end column when wrapping

                if current_col >= 12:
                    plate_number += 1
                    current_col = 0
                    plate_summary_df = summary_data[summary_data["Work No."].isin(plate_work_nos)]
                    samples_end_row = write_summary_to_sheet(ws, plate_summary_df)
                    # Leave empty row before mix calculation table
                    write_mix_calculation_table(ws, plate_work_nos, summary_data, clone_counts, start_row=samples_end_row + 1)
                    ws = create_new_plate(wb, template_plate, plate_number)
                    plate_work_nos = set()

                if current_row == 0 and primers_in_current_col is None:
                    primers_in_current_col = primers

                excel_row = current_row + 3
                excel_col = current_col + 2
                ws.cell(row=excel_row, column=excel_col, value=f"{work_no}-Clone{i}")
                plate_work_nos.add(work_no)

                current_row += 1

            # Apply thick border around the entire clone group range
            # The group spans from group_start_row to current_row-1 (last placed row)
            # and from group_start_col to group_end_col
            # Pass clone_count for L-shaped border logic
            apply_thick_border_to_range(
                ws, 
                group_start_row, 
                group_start_col, 
                current_row - 1,  # Last row where a clone was placed
                group_end_col,
                clone_count=num_clones
            )

        # Place controls
        control_start_row = current_row
        control_start_col = current_col
        
        for control in ["CK+", "CK-"]:
            if current_row >= 8:
                current_col += 1
                current_row = 0

            if current_col >= 12:
                plate_number += 1
                current_col = 0
                plate_summary_df = summary_data[summary_data["Work No."].isin(plate_work_nos)]
                samples_end_row = write_summary_to_sheet(ws, plate_summary_df)
                # Leave empty row before mix calculation table
                write_mix_calculation_table(ws, plate_work_nos, summary_data, clone_counts, start_row=samples_end_row + 1)
                ws = create_new_plate(wb, template_plate, plate_number)
                plate_work_nos = set()

            excel_row = current_row + 3
            excel_col = current_col + 2
            ws.cell(row=excel_row, column=excel_col, value=control)
            current_row += 1
        
        # Apply thick border around controls (single column range)
        if current_row > control_start_row:
            apply_thick_border_to_range(
                ws,
                control_start_row,
                control_start_col,
                current_row - 1,
                control_start_col  # Single column for controls
            )

        # Final updates
        final_plate_summary_df = summary_data[summary_data["Work No."].isin(plate_work_nos)]
        final_samples_end_row = write_summary_to_sheet(ws, final_plate_summary_df)
        # Leave empty row before mix calculation table
        write_mix_calculation_table(ws, plate_work_nos, summary_data, clone_counts, start_row=final_samples_end_row + 1)

        # Apply final formatting to all plate sheets: set column widths
        for sheet in wb.worksheets:
            if sheet.title.startswith("Plate"):
                for col_idx in range(2, 14):  # B (2) to M (13)
                    sheet.column_dimensions[get_column_letter(col_idx)].width = 25

        generate_labels_sheet(wb, summary_data, clone_counts)

        # --- Ask user for save location ---
        now = datetime.now()
        year_char = chr(now.year - 1941)
        date_code = now.strftime("%m%d")
        suggested_filename = f"{year_char}{date_code}-ColonyPCR-FL.xlsx"
        original_dir = os.path.dirname(ligation_layout_paths[0])

        def do_save():
            nonlocal wb
            save_path = filedialog.asksaveasfilename(
                title="Save Colony PCR Layout As",
                initialdir=original_dir,
                initialfile=suggested_filename,
                defaultextension=".xlsx",
                filetypes=[("Excel files", "*.xlsx"), ("All files", "*.*")],
            )
            if save_path:
                # A1 must mirror the saved file name on every plate sheet
                # (plate numbers stay visible in the sheet tab names).
                file_stem = os.path.splitext(os.path.basename(save_path))[0]
                for sheet in wb.worksheets:
                    if sheet.title.startswith("Plate"):
                        sheet["A1"].value = file_stem
                        sheet["A1"].font = Font(bold=True)
                try:
                    wb.save(save_path)
                    logger(f"File successfully saved to: {save_path}")
                    messagebox.showinfo(
                        "Success",
                        f"Colony PCR Layout created successfully:\n{save_path}",
                    )
                except Exception as e:
                    logger(f"ERROR saving file: {e}")
                    messagebox.showerror("Error", f"Failed to save file:\n{e}")
            else:
                logger("Save operation cancelled by user. No file was saved.")

        parent_window.after(0, do_save)
        return suggested_filename  # Return path for logging purposes

    except FileNotFoundError as e:
        logger(f"ERROR: File not found: {e}")
        parent_window.after(0, lambda: messagebox.showerror("Error", f"File not found:\n{e}"))
        return None
    except KeyError as e:
        logger(f"ERROR: Missing required column: {e}")
        parent_window.after(0, lambda: messagebox.showerror("Error", f"Missing required column:\n{e}"))
        return None
    except Exception as e:
        logger(f"ERROR: {traceback.format_exc()}")
        parent_window.after(0, lambda: messagebox.showerror("Error", f"An unexpected error occurred:\n{e}"))
        return None


def main():
    """Standalone entry point when not launched from the hub."""
    ctk.set_appearance_mode("System")
    ctk.set_default_color_theme("blue")

    root = ctk.CTk()
    app = ColonyPCRLayoutApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()