"""
Bio Basic Inc. - Canada
Made by: Fabien Lonjon and Eduardo Reyes.
Contact: ed5reyes@outlook

Version: 3.2
Date: Oct 10, 2026
Field names follow the canonical job-log naming: Job IDs / JobID /
    BBID become Work No. / work_no / bbi_id, and the layout-row
    'enzyme' key becomes 'cloning_site' (the Job Log column name).
    Fragment sheets are read with the corrected 'Insert Length'
    header (live Summary IDT Log sheets still carry the 'Insert
    Lenght' typo - fix the workbook, see the pre-deploy list).
    Vector Database sheets are read positionally.
    Separated vector database from template. Direct value lookups replace
    external Excel formulas. Manual vector entry dialog with DB-backed combobox.
    PCR fragments priority search with concentration-based volume adjustment.
"""

import math
import os
import traceback
import threading
from datetime import date
from dateutil.relativedelta import relativedelta
from itertools import groupby

# Lazy imports for heavy modules (imported only when needed):
# - pandas: ~0.6s startup delay, only used in processing methods
# import pandas as pd  # MOVED to _extract_joblog_info() and _get_fragments_data()

import openpyxl
from openpyxl import load_workbook

import customtkinter as ctk
from tkinter import filedialog, messagebox


# =============================================================================
# BulkManualVectorDialog
# =============================================================================
class BulkManualVectorDialog(ctk.CTkToplevel):
    """Two-step dialog for entering vector information manually.

    Step 1: Shows a list of missing Work No. — the user selects which ones to
    enter. Step 2: for each selected Work No., the user picks a vector name,
    cloning site, and resistance. Vector name auto-fills the resistance via
    database mapping.
    """

    # Most common vectors shown at the top of the combobox for quick access.
    _COMMON_VECTORS = [
        "pUC57-Amp",
        "pUC57-Kan",
        "pUC19",
        "pcDNA3.1(+)",
        "pUCm-T",
        "pBluescript II KS+",
        "pBluescript II SK+",
        "pET-28a(+)",
    ]

    @staticmethod
    def _load_vector_db(vector_db_path):
        """Read vector→resistance mapping from Vector_database.xlsx.

        Returns:
            tuple: (vec_to_res dict, sorted_vector_names list)
                   If the file can't be read, returns ({}, []).
        """
        if not vector_db_path or not os.path.exists(vector_db_path):
            return {}, []

        try:
            wb = openpyxl.load_workbook(vector_db_path, read_only=True)
            if "Vector" not in wb.sheetnames:
                wb.close()
                return {}, []
            ws = wb["Vector"]
            vec_to_res = {}
            for row in ws.iter_rows(min_row=2, values_only=True):
                vec_name = row[0]   # Column A: Vector Name
                resistance = row[2]  # Column C: Resistance
                if vec_name and resistance:
                    # Strip whitespace to ensure clean keys
                    vec_name = str(vec_name).strip()
                    resistance = str(resistance).strip()
                    vec_to_res[vec_name] = resistance
            wb.close()

            # Build sorted list: common vectors first, then remaining alphabetically
            common_set = set(BulkManualVectorDialog._COMMON_VECTORS)
            remaining = sorted(
                name for name in vec_to_res if name not in common_set
            )
            sorted_names = [
                name for name in BulkManualVectorDialog._COMMON_VECTORS
                if name in vec_to_res
            ] + remaining

            return vec_to_res, sorted_names
        except Exception:
            return {}, []

    def __init__(self, parent, work_nos, vector_db_path=None):
        super().__init__(parent)
        self.title("Manual Vector Entry")
        self.geometry("700x600")
        self.results = {}
        self.work_nos = work_nos
        self.vars = {work_no: ctk.BooleanVar(value=True) for work_no in work_nos}

        # Load vector→resistance mapping from the database
        self._vec_to_res, self._vector_names = self._load_vector_db(vector_db_path)

        self._show_selection_view()
        self.transient(parent)
        self.grab_set()

    # ---- helpers ----
    def _clear_window(self):
        for widget in self.winfo_children():
            widget.destroy()

    # ---- Step 1: Selection ----
    def _show_selection_view(self):
        self._clear_window()

        ctk.CTkLabel(
            self, text="Missing Vector Information", font=("Arial", 18, "bold")
        ).pack(pady=15)

        ctk.CTkLabel(
            self,
            text="Select the jobs you want to enter info for manually:",
            wraplength=600,
        ).pack(pady=5)

        scroll = ctk.CTkScrollableFrame(self, width=600, height=350)
        scroll.pack(fill="both", expand=True, padx=20, pady=10)

        # Store row frames so we can destroy them on removal
        self._row_frames = {}

        for work_no in self.work_nos:
            row = ctk.CTkFrame(scroll, fg_color="transparent")
            row.pack(fill="x", pady=2, padx=10)
            self._row_frames[work_no] = row

            cb = ctk.CTkCheckBox(row, text=work_no, variable=self.vars[work_no])
            cb.pack(side="left", padx=(0, 10))

            remove_btn = ctk.CTkButton(
                row,
                text="−",
                width=28,
                height=28,
                fg_color="#D32F2F",
                hover_color="#B71C1C",
                text_color="white",
                font=("Arial", 14, "bold"),
                command=lambda j=work_no: self._remove_work_no_row(j),
            )
            remove_btn.pack(side="right", padx=(5, 0))

        btn_frame = ctk.CTkFrame(self, fg_color="transparent")
        btn_frame.pack(pady=20)

        ctk.CTkButton(
            btn_frame, text="Select All", width=110, command=self._select_all
        ).pack(side="left", padx=10)
        ctk.CTkButton(
            btn_frame,
            text="Next >>",
            width=110,
            command=self._show_entry_view,
            fg_color="#3C702D",
        ).pack(side="left", padx=10)
        ctk.CTkButton(
            btn_frame,
            text="Cancel",
            width=110,
            command=self.destroy,
            fg_color="gray",
        ).pack(side="left", padx=10)

    def _select_all(self):
        for var in self.vars.values():
            var.set(True)

    def _remove_work_no_row(self, work_no):
        """Remove a Work No. row from the selection view entirely."""
        # Destroy the row frame widget
        if work_no in self._row_frames:
            self._row_frames[work_no].destroy()
            del self._row_frames[work_no]
        # Clean up from data structures
        if work_no in self.vars:
            del self.vars[work_no]
        if work_no in self.work_nos:
            self.work_nos.remove(work_no)
        # Clean up from results if present from a previous iteration
        if hasattr(self, "results") and work_no in self.results:
            del self.results[work_no]

    # ---- Step 2: Entry ----
    def _show_entry_view(self):
        selected = [work_no for work_no, var in self.vars.items() if var.get()]
        if not selected:
            messagebox.showwarning("No Selection", "Please select at least one Work No.")
            return

        self._clear_window()

        ctk.CTkLabel(
            self, text="Enter Vector Details", font=("Arial", 18, "bold")
        ).pack(pady=15)

        # Column headers
        header = ctk.CTkFrame(self, fg_color="transparent")
        header.pack(fill="x", padx=25)
        ctk.CTkLabel(header, text="Work No.", width=120, font=("Arial", 12, "bold")).pack(
            side="left", padx=5
        )
        ctk.CTkLabel(header, text="Vector Name", width=180, font=("Arial", 12, "bold")).pack(
            side="left", padx=5
        )
        ctk.CTkLabel(header, text="Cloning Site", width=150, font=("Arial", 12, "bold")).pack(
            side="left", padx=5
        )
        ctk.CTkLabel(header, text="Resistance", width=120, font=("Arial", 12, "bold")).pack(
            side="left", padx=5
        )

        scroll = ctk.CTkScrollableFrame(self, width=650)
        scroll.pack(fill="both", expand=True, padx=20, pady=5)

        self.entries = {}
        for work_no in selected:
            row = ctk.CTkFrame(scroll, fg_color="transparent")
            row.pack(fill="x", pady=2)
            ctk.CTkLabel(row, text=work_no, width=120, anchor="w").pack(side="left", padx=5)

            # Resistance combo (created first so the vector callback can reference it)
            e_res = ctk.CTkComboBox(
                row,
                width=120,
                values=["Ampicillin", "Kanamycin", "Chloramphenicol"],
            )
            e_res.set("Ampicillin")  # Most common default

            # Vector entry: searchable entry with a small dropdown of common vectors
            vec_row = ctk.CTkFrame(row, fg_color="transparent")
            vec_row.pack(side="left", padx=5)

            # Search entry where user can type any vector name
            e_vec = ctk.CTkEntry(vec_row, width=130, placeholder_text="Type or pick")
            e_vec.pack(side="left", padx=(0, 3))

            # Small dropdown arrow (OptionMenu instead of ComboBox to remove the entry field)
            common_dropdown = ctk.CTkOptionMenu(
                vec_row,
                width=30,
                values=BulkManualVectorDialog._COMMON_VECTORS + ["Other..."],
            )
            common_dropdown.set("▼")
            common_dropdown.pack(side="left")

            # When dropdown selection is made, also fill the entry
            def _on_dropdown_pick(choice, entry=e_vec, res_cb=e_res, dd=common_dropdown, current_work_no=work_no):
                if choice == "Other...":
                    self._show_vector_search_dialog(current_work_no)
                else:
                    entry.delete(0, "end")
                    entry.insert(0, choice)
                    if choice in self._vec_to_res:
                        res_cb.set(self._vec_to_res[choice])
                dd.set("▼")

            common_dropdown.configure(command=_on_dropdown_pick)

            e_enz = ctk.CTkEntry(row, width=150)
            e_enz.pack(side="left", padx=5)
            e_res.pack(side="left", padx=5)

            self.entries[work_no] = (e_vec, e_enz, e_res)

        # Navigation buttons
        btn_frame = ctk.CTkFrame(self, fg_color="transparent")
        btn_frame.pack(pady=20)
        ctk.CTkButton(
            btn_frame,
            text="<< Back",
            width=110,
            command=self._show_selection_view,
            fg_color="gray",
        ).pack(side="left", padx=10)
        ctk.CTkButton(
            btn_frame,
            text="Apply Info",
            width=110,
            command=self._on_apply,
            fg_color="#3C702D",
        ).pack(side="left", padx=10)

    def _on_apply(self):
        """Collect entered data and close the dialog."""
        for work_no, (v, e, r) in self.entries.items():
            self.results[work_no] = {
                "vector": v.get(),
                "cloning_site": e.get(),
                "resistance": r.get(),
            }
        self.destroy()

    def _show_vector_search_dialog(self, work_no):
        """Shows a small Toplevel with a search bar and scrollable list of all vectors."""
        search_diag = ctk.CTkToplevel(self)
        search_diag.title("Search All Vectors")
        search_diag.geometry("400x500")
        search_diag.transient(self)
        search_diag.grab_set()

        ctk.CTkLabel(search_diag, text="Search for a vector:", font=("Arial", 14, "bold")).pack(pady=10)
        
        search_var = ctk.StringVar()
        search_entry = ctk.CTkEntry(search_diag, textvariable=search_var, placeholder_text="Type to filter...")
        search_entry.pack(fill="x", padx=20, pady=5)
        search_entry.focus_set()

        scroll = ctk.CTkScrollableFrame(search_diag)
        scroll.pack(fill="both", expand=True, padx=20, pady=10)

        buttons = []

        def _select(vec):
            e_vec, _, e_res = self.entries[work_no]
            e_vec.delete(0, "end")
            e_vec.insert(0, vec)
            if vec in self._vec_to_res:
                e_res.set(self._vec_to_res[vec])
            search_diag.destroy()

        def _update_list(*args):
            for b in buttons: b.destroy()
            buttons.clear()
            query = search_var.get().lower()
            filtered = [v for v in self._vector_names if query in v.lower()]
            for v in filtered[:50]:
                btn = ctk.CTkButton(scroll, text=v, anchor="w", fg_color="transparent", text_color=("gray10", "gray90"), command=lambda val=v: _select(val))
                btn.pack(fill="x", pady=1)
                buttons.append(btn)

        search_var.trace_add("write", _update_list)
        _update_list()  # Initial population


# =============================================================================
# LigationLayoutApp
# =============================================================================
class LigationLayoutApp:
    """
    Automated Ligation Layout generator for the Gene Synthesis workflow.

    Accepts Work No. and generates a ligation layout Excel file by:
    1. Extracting each Work No. info from the Job Log
    2. Finding fragment data from the Fragments Log
    3. Filling the Ligation Template with matched data
    4. Using an external Vector Database for vector lookups

    v3.1 additions:
    - BulkManualVectorDialog for entering missing vector info
    - PCR Fragments priority search with concentration-adjusted volumes
    - Manual entry when Work No. are not in the Job Log
    """

    def __init__(
        self,
        master,
        job_log_path=None,
        fragments_log_path=None,
        ligation_template_path=None,
        vector_db_path=None,
    ):
        self.master = master
        master.title("Ligation Layout")
        master.geometry("850x820")

        # --- Validation flags ---
        self.job_log_valid = False
        self.fragments_log_valid = False
        self.ligation_template_valid = False
        self.vector_db_valid = False

        # --- Internal path storage ---
        self._job_log_path = ""
        self._fragments_path = ""
        self._ligation_layout_path = ""
        self._vector_db_path = ""

        # --- Build UI ---
        self._setup_ui()

        # --- Setup initial paths directly (matches Sequencing_order_form pattern) ---
        # Paths are filled and validations start immediately; no delay needed
        # Use after() to allow the UI to render before starting heavy validation threads
        self.master.after(
            200,
            lambda: self._setup_initial_paths(
                job_log_path, fragments_log_path, ligation_template_path, vector_db_path
            ),
        )

    def _setup_ui(self):
        """Creates all UI widgets."""

        # --- Top Area: Two-column layout (Work No. + Conditions) ---
        top_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        top_frame.pack(pady=(15, 10), padx=15, fill="x")

        # Configure columns: 35% for Work No., 65% for Conditions
        top_frame.grid_columnconfigure(0, weight=35)
        top_frame.grid_columnconfigure(1, weight=65)
        top_frame.grid_rowconfigure(0, weight=1)

        # --- Left Column: Work No. Entry (35%) ---
        work_nos_frame = ctk.CTkFrame(top_frame, fg_color="transparent")
        work_nos_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 10))

        # Label row with "Work No." and checkbox inline
        label_row = ctk.CTkFrame(work_nos_frame, fg_color="transparent")
        label_row.pack(fill="x")

        ctk.CTkLabel(
            label_row,
            text="Work No.",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(side="left")

        # Standard conditions checkbox moved to label row (green when checked, red when unchecked)
        self.standard_conditions_var = ctk.BooleanVar(value=True)
        self.standard_checkbox = ctk.CTkCheckBox(
            label_row,
            text="Standard conditions",
            variable=self.standard_conditions_var,
            command=self._on_standard_conditions_toggle,
            font=ctk.CTkFont(size=12),
            fg_color="#4CAF50",  # Green when checked
            border_color="#D32F2F",  # Red border (visible when unchecked)
            hover_color="#45a049",
        )
        self.standard_checkbox.pack(side="right", padx=(15, 0))

        self.text_work_nos = ctk.CTkTextbox(work_nos_frame, height=150, wrap="word")
        self.text_work_nos.pack(fill="x", pady=(5, 0))

        # --- Right Column: Conditions Panel (65%) - reduced height ---
        conditions_frame = ctk.CTkFrame(top_frame, height=160)
        conditions_frame.grid(row=0, column=1, sticky="nsew")
        conditions_frame.pack_propagate(False)  # Use pack_propagate because internal widgets use pack()

        # Container for special conditions UI (shown when checkbox is unchecked)
        self.special_conditions_container = ctk.CTkFrame(conditions_frame, fg_color="transparent")
        # Don't pack yet - only show when standard conditions is unchecked

        # --- All 3 dropdowns in same row with fixed widths and spacing ---
        dropdowns_row = ctk.CTkFrame(self.special_conditions_container, fg_color="transparent")
        dropdowns_row.pack(fill="x", padx=5, pady=2)

        # Work No. dropdown (wider for longer Work No.)
        ctk.CTkLabel(
            dropdowns_row,
            text="Work No.:",
            font=ctk.CTkFont(size=12),
        ).pack(side="left", padx=(0, 2))

        self.work_no_dropdown = ctk.CTkOptionMenu(
            dropdowns_row,
            values=[""],
            width=140,
        )
        self.work_no_dropdown.pack(side="left", padx=(0, 12))  # Increased spacing

        # Host dropdown (smaller, default to Stbl)
        ctk.CTkLabel(
            dropdowns_row,
            text="Host:",
            font=ctk.CTkFont(size=12),
        ).pack(side="left", padx=(0, 2))

        self.host_dropdown = ctk.CTkOptionMenu(
            dropdowns_row,
            values=["TOP10", "Stbl", "DH5a"],
            width=60,
        )
        self.host_dropdown.set("Stbl")
        self.host_dropdown.pack(side="left", padx=(0, 12))  # Increased spacing

        # Temperature dropdown (smaller, default to 30C)
        ctk.CTkLabel(
            dropdowns_row,
            text="Temp:",
            font=ctk.CTkFont(size=12),
        ).pack(side="left", padx=(0, 2))

        self.temp_dropdown = ctk.CTkOptionMenu(
            dropdowns_row,
            values=["37C", "30C", "25C", "22C", "20C", "18C", "16C"],
            width=55,
        )
        self.temp_dropdown.set("30C")
        self.temp_dropdown.pack(side="left")

        # --- Add button centered in row below dropdowns ---
        add_button_row = ctk.CTkFrame(self.special_conditions_container, fg_color="transparent")
        add_button_row.pack(fill="x", padx=5, pady=2)

        self.add_condition_button = ctk.CTkButton(
            add_button_row,
            text="Add",
            width=80,
            height=24,
            command=self._add_special_condition,
            fg_color="#4CAF50",  # Green background
            hover_color="#45a049",
        )
        self.add_condition_button.pack(anchor="center")

        # --- Grey separator line ---
        separator_line = ctk.CTkFrame(
            self.special_conditions_container,
            height=2,
            fg_color="gray70",
        )
        separator_line.pack(fill="x", padx=5, pady=2)

        # --- Added Conditions List with scrolling ---
        self.conditions_list_frame = ctk.CTkScrollableFrame(
            self.special_conditions_container,
            fg_color="transparent",
        )
        self.conditions_list_frame.pack(fill="both", expand=True, padx=5, pady=2)

        # Store special conditions: list of dicts with work_no, host, temp
        self.special_conditions = []

        # Bind text changes to update work_no dropdown
        self.text_work_nos.bind("<KeyRelease>", self._on_work_nos_change)
        self.text_work_nos.bind("<FocusOut>", self._on_work_nos_change)

        # --- File Selection Section: Two-Column Grid Layout ---
        files_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        files_frame.pack(pady=(15, 10), padx=15, fill="x")

        # Configure grid: 2 equal columns
        files_frame.grid_columnconfigure(0, weight=1)
        files_frame.grid_columnconfigure(1, weight=1)
        files_frame.grid_rowconfigure(0, weight=0)  # Row 1: Job Log | Fragments Log
        files_frame.grid_rowconfigure(1, weight=0)  # Row 2: Template | Database

        # --- Row 1, Column 0: Job Log ---
        self.job_log_frame = ctk.CTkFrame(files_frame, fg_color="transparent")
        self.job_log_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 20), pady=(0, 20))

        ctk.CTkLabel(
            self.job_log_frame,
            text="Job Log",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(anchor="center")

        entry_frame_jl = ctk.CTkFrame(self.job_log_frame, fg_color="transparent")
        entry_frame_jl.pack(fill="x", pady=(2, 2))

        self.entry_job_log = ctk.CTkEntry(entry_frame_jl, border_width=1)
        self.entry_job_log.pack(side="left", fill="x", expand=True, padx=(0, 5))

        self.button_job_log = ctk.CTkButton(
            entry_frame_jl,
            text="Select",
            command=self._browse_job_log,
            width=70,
        )
        self.button_job_log.pack(side="right")

        self.job_log_validation_label = ctk.CTkLabel(
            self.job_log_frame,
            text="",
            font=ctk.CTkFont(size=12),
            anchor="w",
            justify="left",
        )
        self.job_log_validation_label.pack(fill="x")

        # --- Row 1, Column 1: Fragments Log ---
        self.fragments_frame = ctk.CTkFrame(files_frame, fg_color="transparent")
        self.fragments_frame.grid(row=0, column=1, sticky="nsew", padx=(20, 0), pady=(0, 20))

        ctk.CTkLabel(
            self.fragments_frame,
            text="Fragments Log",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(anchor="center")

        entry_frame_fl = ctk.CTkFrame(self.fragments_frame, fg_color="transparent")
        entry_frame_fl.pack(fill="x", pady=(2, 2))

        self.entry_fragments = ctk.CTkEntry(entry_frame_fl, border_width=1)
        self.entry_fragments.pack(side="left", fill="x", expand=True, padx=(0, 5))

        self.button_fragments = ctk.CTkButton(
            entry_frame_fl,
            text="Select",
            command=self._browse_fragments,
            width=70,
        )
        self.button_fragments.pack(side="right")

        self.fragments_validation_label = ctk.CTkLabel(
            self.fragments_frame,
            text="",
            font=ctk.CTkFont(size=12),
            anchor="w",
            justify="left",
        )
        self.fragments_validation_label.pack(fill="x")

        # --- Row 2, Column 0: Ligation Template ---
        self.ligation_template_frame = ctk.CTkFrame(files_frame, fg_color="transparent")
        self.ligation_template_frame.grid(row=1, column=0, sticky="nsew", padx=(0, 20), pady=(0, 10))

        ctk.CTkLabel(
            self.ligation_template_frame,
            text="Ligation Layout Template",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(anchor="center")

        entry_frame_lt = ctk.CTkFrame(self.ligation_template_frame, fg_color="transparent")
        entry_frame_lt.pack(fill="x", pady=(2, 2))

        self.entry_ligation_template = ctk.CTkEntry(entry_frame_lt, border_width=1)
        self.entry_ligation_template.pack(side="left", fill="x", expand=True, padx=(0, 5))

        self.button_ligation_template = ctk.CTkButton(
            entry_frame_lt,
            text="Select",
            command=self._browse_ligation_template,
            width=70,
        )
        self.button_ligation_template.pack(side="right")

        self.ligation_template_validation_label = ctk.CTkLabel(
            self.ligation_template_frame,
            text="",
            font=ctk.CTkFont(size=12),
            anchor="w",
            justify="left",
        )
        self.ligation_template_validation_label.pack(fill="x")

        # --- Row 2, Column 1: Vector Database ---
        self.vector_db_frame = ctk.CTkFrame(files_frame, fg_color="transparent")
        self.vector_db_frame.grid(row=1, column=1, sticky="nsew", padx=(20, 0), pady=(0, 10))

        ctk.CTkLabel(
            self.vector_db_frame,
            text="Vector Database",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(anchor="center")

        entry_frame_vdb = ctk.CTkFrame(self.vector_db_frame, fg_color="transparent")
        entry_frame_vdb.pack(fill="x", pady=(2, 2))

        self.entry_vector_db = ctk.CTkEntry(entry_frame_vdb, border_width=1)
        self.entry_vector_db.pack(side="left", fill="x", expand=True, padx=(0, 5))

        self.button_vector_db = ctk.CTkButton(
            entry_frame_vdb,
            text="Select",
            command=self._browse_vector_db,
            width=70,
        )
        self.button_vector_db.pack(side="right")

        self.vector_db_validation_label = ctk.CTkLabel(
            self.vector_db_frame,
            text="",
            font=ctk.CTkFont(size=12),
            anchor="w",
            justify="left",
        )
        self.vector_db_validation_label.pack(fill="x")

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
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(anchor="w", padx=10, pady=(5, 2))

        self.log_textbox = ctk.CTkTextbox(
            log_frame,
            activate_scrollbars=True,
            state="disabled",
            fg_color="white",
            text_color="black",
        )
        self.log_textbox.pack(expand=True, fill="both", padx=10, pady=(2, 10))

    # =========================================================================
    # Logging methods
    # =========================================================================
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

    # =========================================================================
    # Thread-safe dialog helpers (from new_feature.py)
    # =========================================================================
    def _get_bulk_manual_vector_input(self, work_nos):
        """Thread-safe way to prompt user for bulk manual vector entry.

        Opens a BulkManualVectorDialog on the main thread and blocks the
        worker thread until the user closes the dialog.
        Returns a dict of {work_no: {vector, cloning_site, resistance}}.
        """
        results = {}
        evt = threading.Event()

        def _open_dialog():
            diag = BulkManualVectorDialog(self.master, work_nos, vector_db_path=self._vector_db_path)
            self.master.wait_window(diag)
            if diag.results:
                results.update(diag.results)
            evt.set()

        self.master.after(0, _open_dialog)
        evt.wait()  # Processing thread waits for user interaction
        return results

    # =========================================================================
    # Conditions Panel methods
    # =========================================================================
    def _on_work_nos_change(self, event=None):
        """Updates the Work No. dropdown when the Work No. text changes."""
        work_nos_text = self.text_work_nos.get("1.0", "end").strip()
        work_nos = [work_no.strip() for work_no in work_nos_text.splitlines() if work_no.strip()]
        self._update_work_no_dropdown(work_nos)

    def _on_standard_conditions_toggle(self):
        """Toggles visibility of special conditions UI and updates checkbox colors."""
        if self.standard_conditions_var.get():
            # Standard conditions checked - hide special conditions UI
            self.special_conditions_container.pack_forget()
            # Update checkbox colors to green (checked state)
            self.standard_checkbox.configure(
                fg_color="#4CAF50",
                border_color="#4CAF50",
            )
        else:
            # Standard conditions unchecked - show special conditions UI
            self.special_conditions_container.pack(fill="both", expand=True, padx=5, pady=(5, 5))
            # Update checkbox colors to red (unchecked state)
            self.standard_checkbox.configure(
                fg_color="#D32F2F",
                border_color="#D32F2F",
            )
            # Refresh work_no dropdown
            work_nos_text = self.text_work_nos.get("1.0", "end").strip()
            work_nos = [work_no.strip() for work_no in work_nos_text.splitlines() if work_no.strip()]
            self._update_work_no_dropdown(work_nos)

    def _update_work_no_dropdown(self, work_nos):
        """Updates the Work No. dropdown with available Work No.."""
        current_value = self.work_no_dropdown.get()
        self.work_no_dropdown.configure(values=work_nos if work_nos else [""])
        # Set to first value if current is not in list or empty
        if work_nos:
            if current_value not in work_nos:
                self.work_no_dropdown.set(work_nos[0])
        else:
            self.work_no_dropdown.set("")

    def _add_special_condition(self):
        """Adds a special condition to the list."""
        work_no = self.work_no_dropdown.get()
        host = self.host_dropdown.get()
        temp = self.temp_dropdown.get()

        if not work_no or work_no == "":
            return  # Don't add empty conditions

        # Check if this Work No. already has a special condition
        for cond in self.special_conditions:
            if cond["work_no"] == work_no:
                # Update existing condition
                cond["host"] = host
                cond["temp"] = temp
                self._refresh_conditions_list()
                return

        # Add new condition
        self.special_conditions.append({
            "work_no": work_no,
            "host": host,
            "temp": temp,
        })
        self._refresh_conditions_list()

    def _remove_special_condition(self, index):
        """Removes a special condition from the list by index."""
        if 0 <= index < len(self.special_conditions):
            self.special_conditions.pop(index)
            self._refresh_conditions_list()

    def _refresh_conditions_list(self):
        """Refreshes the visual list of added special conditions."""
        # Clear existing widgets in the list frame
        for widget in self.conditions_list_frame.winfo_children():
            widget.destroy()

        # Create a row for each special condition
        for idx, cond in enumerate(self.special_conditions):
            row_frame = ctk.CTkFrame(self.conditions_list_frame, fg_color="transparent")
            row_frame.pack(fill="x", pady=0)

            # Condition description
            cond_text = f"{cond['work_no']} - Host: {cond['host']}, Temp: {cond['temp']}"
            ctk.CTkLabel(
                row_frame,
                text=cond_text,
                font=ctk.CTkFont(size=11),
                anchor="w",
            ).pack(side="left", fill="x", expand=True)

            # Remove button (red background)
            remove_btn = ctk.CTkButton(
                row_frame,
                text="-",
                width=20,
                height=20,
                fg_color="#D32F2F",  # Red background
                hover_color="#B71C1C",
                command=lambda i=idx: self._remove_special_condition(i),
            )
            remove_btn.pack(side="right", padx=2)

    def get_conditions(self):
        """Returns a dictionary mapping Work No. to their selected conditions.

        Returns:
            dict: Mapping of work_no -> {"host": str, "temperature": str}
                  If standard_conditions is True, returns empty dict (all Work No. use standard conditions).
        """
        if self.standard_conditions_var.get():
            return {}  # Standard conditions - no special conditions needed

        conditions = {}
        for cond in self.special_conditions:
            conditions[cond["work_no"]] = {
                "host": cond["host"],
                "temperature": cond["temp"],
            }
        return conditions

    # =========================================================================
    # Validation methods
    # =========================================================================
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
            if validation_flag_name == "job_log_valid":
                self._job_log_path = entry_widget.get()
            elif validation_flag_name == "fragments_log_valid":
                self._fragments_path = entry_widget.get()
            elif validation_flag_name == "ligation_template_valid":
                self._ligation_layout_path = entry_widget.get()
            elif validation_flag_name == "vector_db_valid":
                self._vector_db_path = entry_widget.get()

            entry_widget.configure(border_color="dark green", border_width=2)
            validation_label_widget.configure(text=f"✔ {message}", text_color="green")
            # Note: No logging during validation (matches Sequencing_order_form pattern)
        elif is_valid is False:
            entry_widget.configure(border_color="#D32F2F", border_width=2)
            validation_label_widget.configure(
                text=f"✖ Invalid: {message}", text_color="#D32F2F"
            )
            # Note: No logging during validation (matches Sequencing_order_form pattern)
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
            self.job_log_valid
            and self.fragments_log_valid
            and self.ligation_template_valid
            and self.vector_db_valid
        )
        if all_valid:
            self.button_generate.configure(state="normal", fg_color="#3C702D")
        else:
            self.button_generate.configure(state="disabled", fg_color="gray50")

    def _setup_initial_paths(
        self, job_log_path, fragments_log_path, ligation_template_path, vector_db_path
    ):
        """Pre-fills entry widgets with provided paths and then starts sequential validation."""
        # --- Phase 1: Autofill all paths immediately ---
        if job_log_path:
            self.entry_job_log.delete(0, "end")
            self.entry_job_log.insert(0, job_log_path)

        if fragments_log_path:
            self.entry_fragments.delete(0, "end")
            self.entry_fragments.insert(0, fragments_log_path)

        if ligation_template_path:
            self.entry_ligation_template.delete(0, "end")
            self.entry_ligation_template.insert(0, ligation_template_path)

        if vector_db_path:
            self.entry_vector_db.delete(0, "end")
            self.entry_vector_db.insert(0, vector_db_path)

        # --- Phase 2: Start the validation chain ---
        self._start_sequential_validation()

    def _start_sequential_validation(self):
        """Starts the validation for any pre-filled paths in sequence."""
        # Get paths from the entry widgets now that they are filled
        job_log_path = self.entry_job_log.get()
        fragments_log_path = self.entry_fragments.get()
        ligation_template_path = self.entry_ligation_template.get()
        vector_db_path = self.entry_vector_db.get()

        # Define chained callbacks (LIFO definition)

        # 4. Vector Database (Last)
        def validate_vector_db():
            if vector_db_path:
                self._start_validation_thread(
                    self.entry_vector_db,
                    self.vector_db_validation_label,
                    vector_db_path,
                    "Digested_Vectors",
                    "vector_db_valid",
                    "Vector Database",
                )

        # 3. Ligation Template
        def validate_template():
            if ligation_template_path:
                self._start_validation_thread(
                    self.entry_ligation_template,
                    self.ligation_template_validation_label,
                    ligation_template_path,
                    "Layout",
                    "ligation_template_valid",
                    "Ligation Template",
                    next_callback=validate_vector_db,
                )
            else:
                validate_vector_db()

        # 2. Fragments Log
        def validate_fragments():
            if fragments_log_path:
                self._start_validation_thread(
                    self.entry_fragments,
                    self.fragments_validation_label,
                    fragments_log_path,
                    None,  # No specific sheet required for fragments
                    "fragments_log_valid",
                    "Fragments Log",
                    next_callback=validate_template,
                )
            else:
                validate_template()  # Skip to next if path is missing

        # 1. Job Log (First)
        if job_log_path:
            self._start_validation_thread(
                self.entry_job_log,
                self.job_log_validation_label,
                job_log_path,
                "Initiated",
                "job_log_valid",
                "Job Log",
                next_callback=validate_fragments,
            )
        else:
            validate_fragments()  # Skip to next if path is missing

    # =========================================================================
    # Browse methods
    # =========================================================================
    def _browse_job_log(self):
        filename = filedialog.askopenfilename(
            title="Select Job Log File",
            filetypes=[("Excel files", "*.xlsx *.xlsm"), ("All files", "*.*")],
        )
        if filename:
            self.entry_job_log.delete(0, "end")
            self.entry_job_log.insert(0, filename)
            self._start_validation_thread(
                self.entry_job_log,
                self.job_log_validation_label,
                filename,
                "Initiated",
                "job_log_valid",
                "Job Log",
            )

    def _browse_fragments(self):
        filename = filedialog.askopenfilename(
            title="Select Fragments File",
            filetypes=[("Excel files", "*.xlsx *.xlsm"), ("All files", "*.*")],
        )
        if filename:
            self.entry_fragments.delete(0, "end")
            self.entry_fragments.insert(0, filename)
            self._start_validation_thread(
                self.entry_fragments,
                self.fragments_validation_label,
                filename,
                None,
                "fragments_log_valid",
                "Fragments Log",
            )

    def _browse_ligation_template(self):
        filename = filedialog.askopenfilename(
            title="Select Ligation Layout Template",
            filetypes=[("Excel files", "*.xlsx *.xlsm"), ("All files", "*.*")],
        )
        if filename:
            self.entry_ligation_template.delete(0, "end")
            self.entry_ligation_template.insert(0, filename)
            self._start_validation_thread(
                self.entry_ligation_template,
                self.ligation_template_validation_label,
                filename,
                "Layout",
                "ligation_template_valid",
                "Ligation Template",
            )

    def _browse_vector_db(self):
        filename = filedialog.askopenfilename(
            title="Select Vector Database",
            filetypes=[("Excel files", "*.xlsx *.xlsm"), ("All files", "*.*")],
        )
        if filename:
            self.entry_vector_db.delete(0, "end")
            self.entry_vector_db.insert(0, filename)
            self._start_validation_thread(
                self.entry_vector_db,
                self.vector_db_validation_label,
                filename,
                "Digested_Vectors",
                "vector_db_valid",
                "Vector Database",
            )

    # =========================================================================
    # Processing methods
    # =========================================================================
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
            work_nos_text = self.text_work_nos.get("1.0", "end").strip()
            work_nos = [work_no.strip() for work_no in work_nos_text.splitlines() if work_no.strip()]

            if not work_nos:
                self.master.after(
                    0, lambda: messagebox.showerror("Error", "Please paste Work No.")
                )
                self._log_threaded("ERROR: No Work No. provided. Processing stopped.")
                return

            self._log_threaded(f"Found {len(work_nos)} Work No. to process.")

            # Step 0: Load vector database lookups (needed before Step 1)
            # Store as instance attributes so _write_fragments_to_layout can access them
            self._vector_length_map = {}
            self._digested_vectors_lookup = {}  # (vector_name, cloning_site) -> {lot, box_position, concentration}
            self._vector_resistance_lookup = {}  # vector_name -> resistance
            try:
                self._log_threaded(
                    f"  > Loading vector database from: {self._vector_db_path}"
                )
                vector_db_wb = openpyxl.load_workbook(self._vector_db_path, read_only=True)
                try:
                    # --- Build lookups from Vector Database ---
                    
                    # 1. Build self._vector_resistance_lookup and initial self._vector_length_map from 'Vector' sheet
                    # This covers standard sizes for known vectors regardless of stock.
                    try:
                        vector_ws = vector_db_wb["Vector"]
                        self._log_threaded(
                            "  > Building resistance and standard length lookup from 'Vector' sheet..."
                        )
                        for r_idx, row in enumerate(
                            vector_ws.iter_rows(min_row=2, values_only=True), start=2
                        ):
                            # Columns: A=Vector Name, B=Size, C=Resistance, D=Sequence
                            raw_vname = row[0]
                            vname = raw_vname.strip() if isinstance(raw_vname, str) else None

                            if not vname:
                                continue

                            # Resistance lookup
                            raw_resist = row[2]  # Column C
                            resistance = raw_resist.strip() if isinstance(raw_resist, str) else (str(raw_resist) if raw_resist is not None else "")
                            self._vector_resistance_lookup[vname] = resistance
                            
                            # Base Length map (Column B)
                            raw_size = row[1]
                            try:
                                if raw_size is not None:
                                    self._vector_length_map[vname] = float(raw_size)
                            except (ValueError, TypeError):
                                pass

                        self._log_threaded(
                            f"  > Resistance lookup: {len(self._vector_resistance_lookup)} entries. "
                            f"Base length map: {len(self._vector_length_map)} entries."
                        )
                    except KeyError:
                        self._log_threaded(
                            "  > WARNING: 'Vector' sheet not found in database. "
                            "Antibiotic resistance and standard sizes will be missing."
                        )

                    # 2. Build self._digested_vectors_lookup and update lengths from 'Digested_Vectors' sheet
                    # This covers specific stock info (lot, concentration, actual length used in batch)
                    try:
                        vector_log_ws = vector_db_wb["Digested_Vectors"]
                        self._log_threaded(
                            "  > Building digested vectors lookup (and updating lengths) "
                            "from 'Digested_Vectors' sheet..."
                        )
                        for r_idx, row in enumerate(
                            vector_log_ws.iter_rows(min_row=2, values_only=True), start=2
                        ):
                            # Columns: A=Box Position, B=Vector, C=Digestion (v3.2 template headers),
                            #          D=Lot, E=Concentration, F=Vector length, G/H=misc
                            raw_name = row[1]  # Column B
                            vector_name = raw_name.strip() if isinstance(raw_name, str) else None

                            if not vector_name:
                                continue  # skip blank rows

                            # Vector length map (column F)
                            vector_length_raw = row[5]
                            try:
                                if vector_length_raw is not None:
                                    # Overwrite with lot-specific length if available
                                    self._vector_length_map[vector_name] = float(vector_length_raw)
                            except (ValueError, TypeError):
                                pass

                            # Digested vectors lookup (keyed by vector_name + cloning_site)
                            raw_enzyme = row[2]  # Column C
                            cloning_site = raw_enzyme.strip() if isinstance(raw_enzyme, str) else (str(raw_enzyme) if raw_enzyme is not None else "")

                            raw_box = row[0]  # Column A
                            box_position = raw_box.strip() if isinstance(raw_box, str) else (str(raw_box) if raw_box is not None else "")

                            raw_lot = row[3]  # Column D
                            lot = raw_lot.strip() if isinstance(raw_lot, str) else (str(raw_lot) if raw_lot is not None else "")

                            raw_conc = row[4]  # Column E
                            concentration = None
                            try:
                                if raw_conc is not None:
                                    concentration = float(raw_conc)
                            except (ValueError, TypeError):
                                concentration = None

                            self._digested_vectors_lookup[(vector_name, cloning_site)] = {
                                "lot": lot,
                                "box_position": box_position,
                                "concentration": concentration,
                            }

                        self._log_threaded(
                            f"  > Vector length map: {len(self._vector_length_map)} entries. "
                            f"Digested vectors lookup: {len(self._digested_vectors_lookup)} entries."
                        )
                    except KeyError:
                        self._log_threaded(
                            "  > WARNING: 'Digested_Vectors' sheet not found in database. "
                            "Cannot calculate insert volumes or vector lot/volume info."
                        )

                    # --- Build self._vector_resistance_lookup from Vector sheet ---
                    try:
                        vector_ws = vector_db_wb["Vector"]
                        self._log_threaded(
                            "  > Building resistance lookup from 'Vector' sheet..."
                        )
                        for r_idx, row in enumerate(
                            vector_ws.iter_rows(min_row=2, values_only=True), start=2
                        ):
                            # Columns: A=Vector Name, B=Size, C=Resistance, D=Sequence
                            raw_vname = row[0]
                            vname = raw_vname.strip() if isinstance(raw_vname, str) else None

                            if not vname:
                                continue

                            raw_resist = row[2]  # Column C
                            resistance = raw_resist.strip() if isinstance(raw_resist, str) else (str(raw_resist) if raw_resist is not None else "")

                            self._vector_resistance_lookup[vname] = resistance

                        self._log_threaded(
                            f"  > Vector resistance lookup: {len(self._vector_resistance_lookup)} entries."
                        )
                    except KeyError:
                        self._log_threaded(
                            "  > WARNING: 'Vector' sheet not found in database. "
                            "Cannot fill antibiotic resistance column."
                        )

                finally:
                    vector_db_wb.close()
            except Exception as e:
                self._log_threaded(
                    f"  > ERROR: Could not load vector database: {e}."
                )

            # Step 1: Extract Work No. information from the Job Log
            self._log_threaded(
                "\nStep 1: Extracting Work No. information from Job Log..."
            )
            wb, final_layout_rows = self._extract_joblog_info(
                work_nos, self._digested_vectors_lookup, self._vector_resistance_lookup
            )
            self._log_threaded("Step 1 complete. Initial layout data prepared.")

            # Step 2: Get fragments tables from the current and previous month
            self._log_threaded("\nStep 2: Searching for fragment data...")
            fragments_df = self._get_fragments_data()
            if fragments_df.empty:
                warning_msg = "Could not find any fragment sheets for the current or previous month."
                self._log_threaded(f"WARNING: {warning_msg}")
                self.master.after(
                    0,
                    lambda: messagebox.showwarning(
                        "No Data Found",
                        f"{warning_msg}\n\nProcess will continue, but fragment info will be missing.",
                    ),
                )
            else:
                self._log_threaded("Step 2 complete. Fragment data consolidated.")

            # Step 3: Match and fill fragments information
            self._log_threaded(
                "\nStep 3: Matching and filling fragments information..."
            )
            fragments_to_write = {}
            if not fragments_df.empty:
                for item in final_layout_rows:
                    work_no = str(item.get("work_no", ""))

                    # Process only actual jobs, skipping controls (CK-) and empty rows
                    if work_no and not work_no.startswith("CK"):
                        self._log_threaded(f"  -> Processing Work No.: {work_no}")

                        # --- Priority 1: Check "PCR Fragments" sheet ---
                        pcr_matches = fragments_df[
                            (fragments_df["Gene Name"] == work_no)
                            & (fragments_df["Sheet Name"] == "PCR Fragments")
                        ]

                        found_fragments = []
                        if not pcr_matches.empty:
                            row_pcr = pcr_matches.iloc[0]
                            found_fragments.append(
                                {
                                    "name": row_pcr["Gene Name"],
                                    "location": row_pcr["Position"],
                                    "length": row_pcr["Insert Length"],
                                    "concentration": row_pcr.get("Concentration"),
                                }
                            )
                        else:
                            # --- Priority 2: Standard search (Fragments A, B, C) ---
                            potential_matches = fragments_df[
                                fragments_df["Gene Name"].str.startswith(work_no, na=False)
                            ]

                            # Filter out rows that failed Purity Pass (Yield fail can still be used)
                            passing_fragments = potential_matches[
                                (potential_matches["Purity Pass"] != "Fail")
                            ]

                            if not passing_fragments.empty:
                                # Search for Fragment A (exact match or with 'A' suffix)
                                match_A = passing_fragments[
                                    passing_fragments["Gene Name"].isin(
                                        [work_no, work_no + "A"]
                                    )
                                ]
                                if not match_A.empty:
                                    row_A = match_A.iloc[0]
                                    found_fragments.append(
                                        {
                                            "name": row_A["Gene Name"],
                                            "location": f"{row_A['Sheet Name']}-{row_A['Position']}",
                                            "length": row_A["Insert Length"],
                                        }
                                    )

                                    # If A was found, search for B
                                    match_B = passing_fragments[
                                        passing_fragments["Gene Name"] == work_no + "B"
                                    ]
                                    if not match_B.empty:
                                        row_B = match_B.iloc[0]
                                        found_fragments.append(
                                            {
                                                "name": row_B["Gene Name"],
                                                "location": f"{row_B['Sheet Name']}-{row_B['Position']}",
                                                "length": row_B["Insert Length"],
                                            }
                                        )

                                        # If B was found, search for C
                                        match_C = passing_fragments[
                                            passing_fragments["Gene Name"] == work_no + "C"
                                        ]
                                        if not match_C.empty:
                                            row_C = match_C.iloc[0]
                                            found_fragments.append(
                                                {
                                                    "name": row_C["Gene Name"],
                                                    "location": f"{row_C['Sheet Name']}-{row_C['Position']}",
                                                    "length": row_C["Insert Length"],
                                                }
                                            )

                        if found_fragments:
                            self._log_threaded(
                                f"    > Found {len(found_fragments)} passing fragments:"
                            )
                            for frag in found_fragments:
                                self._log_threaded(
                                    f"      - Name: {frag['name']}, Location: {frag['location']}"
                                )
                        else:
                            self._log_threaded(
                                f"    > No passing fragments found for {work_no}."
                            )

                        if found_fragments:
                            fragments_to_write[work_no] = found_fragments

                self._log_threaded("Step 3 processing complete.")
            else:
                self._log_threaded(
                    "  > Skipping fragment matching as no fragment data was found."
                )

            # Final step: Write the found fragment info to the Excel file
            if fragments_to_write:
                self._log_threaded(
                    "\nFinal Step: Writing fragment data to layout file..."
                )
                # Identify manually entered jobs for length recalculation
                manual_work_nos = {
                    row["work_no"]
                    for row in final_layout_rows
                    if row.get("is_manual")
                }
                self._write_fragments_to_layout(wb, fragments_to_write, manual_work_nos)
                self._log_threaded("Fragment data successfully written.")

            # Ask user for save location and save the final workbook
            self._log_threaded("\nPrompting for save location...")

            # Generate suggested filename: [YearChar][MMDD]-Ligation-FL
            today = date.today()
            base_year = 2025
            base_char_code = ord("T")
            year_char = chr(base_char_code + (today.year - base_year))
            date_str = today.strftime("%m%d")
            suggested_filename = f"{year_char}{date_str}-Ligation-FL.xlsx"

            # Use master.after for the file dialog
            def do_save():
                save_path = filedialog.asksaveasfilename(
                    title="Save Ligation Layout As",
                    initialfile=suggested_filename,
                    defaultextension=".xlsx",
                    filetypes=[("Excel files", "*.xlsx"), ("All files", "*.*")],
                )
                if save_path:
                    try:
                        wb.save(save_path)
                        self._log_threaded(f"File successfully saved to: {save_path}")
                        messagebox.showinfo(
                            "Success",
                            f"Ligation Layout created successfully:\n{save_path}",
                        )
                    except Exception as e:
                        self._log_threaded(f"ERROR saving file: {e}")
                        messagebox.showerror("Error", f"Failed to save file:\n{e}")
                else:
                    self._log_threaded(
                        "Save operation cancelled by user. No file was saved."
                    )
                self.button_generate.configure(state="normal", fg_color="#3C702D")

            self.master.after(0, do_save)

            self._log_threaded("\n--- Processing Finished ---")

        except Exception as e:
            self._log_threaded(f"\nERROR: {traceback.format_exc()}")
            self.master.after(0, lambda: messagebox.showerror("Error", str(e)))
            self.master.after(
                0,
                lambda: self.button_generate.configure(
                    state="normal", fg_color="#3C702D"
                ),
            )

    def _extract_joblog_info(self, work_nos, digested_vectors_lookup=None, vector_resistance_lookup=None):
        """Extracts Work No. information from the Job Log and prepares the layout.

        In v3.1 this method also handles:
        - Work No. not found in the Job Log (prompts for manual entry)
        - Work No. with vector == "DNA Fragment - No Vector" (manual entry)
        - Tracking manually-entered Work No. via the 'is_manual' flag
        """
        # Lazy import pandas (heavy module, ~0.6s startup)
        import pandas as pd

        # Load Job Log (tab "Initiated")
        job_log = pd.read_excel(self._job_log_path, sheet_name="Initiated")

        # Define column names
        COL_WORK_NO = "Work No."
        COL_BBI_ID = "BBI ID"
        COL_VECTOR = "Vector"
        COL_CLONING_SITE = "Cloning Site"
        COL_RESISTANCE = "Resistance"
        COL_LENGTH = "Length (bp)"

        # Default values for Host and Temperature
        DEFAULT_HOST = "TOP10"
        DEFAULT_TEMP = "37C"

        # Get special conditions from UI (if any)
        special_conditions = self.get_conditions()

        # Pre-collection of data and identification of jobs needing manual input
        ligation_rows_map = {}
        jobs_to_prompt = []
        missing_from_log = []
        found_work_nos = set()

        for work_no in work_nos:
            job_row_df = job_log[job_log[COL_WORK_NO] == work_no]

            if job_row_df.empty:
                # Work No. not found in the Job Log at all
                missing_from_log.append(work_no)
                continue

            job_row = job_row_df.iloc[0]
            data = {
                "work_no": work_no,
                "bbi_id": job_row[COL_BBI_ID],
                "vector": job_row[COL_VECTOR],
                "cloning_site": job_row[COL_CLONING_SITE],
                "length": job_row[COL_LENGTH],
                "resistance": job_row[COL_RESISTANCE],
            }

            if str(data["vector"]).strip() == "DNA Fragment - No Vector":
                # Job exists in log but vector info is placeholder — needs manual entry
                jobs_to_prompt.append(work_no)
                ligation_rows_map[work_no] = data
            else:
                ligation_rows_map[work_no] = data
                found_work_nos.add(work_no)

        # IDs missing from the log always go to manual entry prompt (no confirmation needed)
        if missing_from_log:
            self._log_threaded(
                f"  > WARNING: The following Work No. were not found in the Job Log: "
                f"{sorted(missing_from_log)}"
            )
            jobs_to_prompt.extend(missing_from_log)

        # Bulk prompt for all problematic Work No. at once
        if jobs_to_prompt:
            self._log_threaded(
                f"  > Opening manual vector entry dialog for {len(jobs_to_prompt)} Work No. ..."
            )
            manual_results = self._get_bulk_manual_vector_input(jobs_to_prompt)
            for work_no, m_data in manual_results.items():
                existing = ligation_rows_map.get(work_no, {})
                ligation_rows_map[work_no] = {
                    "work_no": work_no,
                    "bbi_id": existing.get("bbi_id", ""),
                    "vector": m_data["vector"],
                    "cloning_site": m_data["cloning_site"],
                    "length": existing.get("length", ""),
                    "resistance": m_data["resistance"],
                    "is_manual": True,
                }
                found_work_nos.add(work_no)

        # Build the final list from the map (only include found / manually entered)
        ligation_rows = [v for k, v in ligation_rows_map.items() if k in found_work_nos]

        # Log any Work No. that were provided but not found AND not manually entered
        not_found_ids = set(work_nos) - found_work_nos
        if not_found_ids:
            self._log_threaded(
                f"  > WARNING: The following Work No. were not found in the Job Log "
                f"and will be skipped: {sorted(list(not_found_ids))}"
            )

        # Sort ligations by Vector, then Cloning Site, then Work No.
        sort_key = lambda x: (str(x["vector"]), str(x["cloning_site"]), str(x["work_no"]))
        ligation_rows.sort(key=sort_key)

        # Build final ordered rows grouped by (vector, cloning_site)
        final_rows = []
        grouping_key = lambda x: (x["vector"], x["cloning_site"])

        for key, group in groupby(ligation_rows, key=grouping_key):
            group_list = list(group)
            final_rows.extend(group_list)

            # Add negative control after each group
            final_rows.append(
                {
                    "work_no": f"CK-{key[0]}-{key[1]}",
                    "bbi_id": "",
                    "vector": key[0],
                    "cloning_site": key[1],
                    "length": "",
                    "resistance": group_list[0]["resistance"],
                }
            )

        # Add positive control always last
        final_rows.append(
            {
                "work_no": "CK+pUC19",
                "bbi_id": "",
                "vector": "pUC19",
                "cloning_site": "",
                "length": "",
                "resistance": "Amp",
            }
        )

        # Open ligation layout workbook and write data
        wb = load_workbook(self._ligation_layout_path)
        try:
            ws = wb["Layout"]
        except KeyError:
            raise KeyError(
                "'Layout' sheet not found in the layout template. Cannot proceed."
            )

        # Column mapping (including Host and Temperature)
        column_mapping = {
            "work_no": "B",
            "bbi_id": "C",
            "vector": "D",
            "cloning_site": "E",
            "length": "T",
            "host": "V",
            "temperature": "W",
        }

        row = 2
        for item in final_rows:
            # Determine host and temperature for each row
            work_no = item.get("work_no", "")

            # Controls (CK-*) always use standard conditions
            if work_no.startswith("CK-"):
                host = DEFAULT_HOST
                temperature = DEFAULT_TEMP
            # Check if this work_no has special conditions
            elif work_no in special_conditions:
                host = special_conditions[work_no]["host"]
                temperature = special_conditions[work_no]["temperature"]
            # Default: use standard conditions
            else:
                host = DEFAULT_HOST
                temperature = DEFAULT_TEMP

            # Add host and temperature to item
            item["host"] = host
            item["temperature"] = temperature

            # Write all columns
            for key, col_letter in column_mapping.items():
                ws[f"{col_letter}{row}"] = item.get(key, "")

            # =================================================================
            # Direct value lookups (replaces external Excel formulas)
            # =================================================================
            # Previously, columns F, G, H, U were written as Excel formulas
            # referencing Vector_database.xlsx. Those formulas broke (#REF/#VALUE)
            # when the database file was not also open. Now we compute the
            # values programmatically and write them directly.
            # =================================================================

            vector_name = item.get("vector", "")
            cloning_site = item.get("cloning_site", "")
            if isinstance(vector_name, str):
                vector_name = vector_name.strip()
            if isinstance(cloning_site, str):
                cloning_site = cloning_site.strip()

            if not item.get("work_no"):
                # B column is empty — write blanks
                ws[f"F{row}"] = ""
                ws[f"G{row}"] = ""
                ws[f"H{row}"] = ""
                ws[f"U{row}"] = ""
            else:
                # Lookup in digested_vectors_lookup by (vector_name, cloning_site)
                dv_key = (vector_name, cloning_site)
                dv_entry = None
                if digested_vectors_lookup:
                    dv_entry = digested_vectors_lookup.get(dv_key)

                if dv_entry:
                    # F: Vector Lot
                    ws[f"F{row}"] = dv_entry["lot"]
                    # G: Preparation Date / Box Position
                    ws[f"G{row}"] = dv_entry["box_position"]
                    # H: Vector Volume — CEILING(40 / concentration, 0.5)
                    conc = dv_entry["concentration"]
                    if conc and conc > 0:
                        ws[f"H{row}"] = math.ceil(40 / conc / 0.5) * 0.5
                    else:
                        ws[f"H{row}"] = ""
                else:
                    ws[f"F{row}"] = ""
                    ws[f"G{row}"] = ""
                    ws[f"H{row}"] = ""

                # U: Antibiotic Resistance (VLOOKUP on Vector sheet)
                resistance = None
                if vector_resistance_lookup:
                    resistance = vector_resistance_lookup.get(vector_name)
                ws[f"U{row}"] = resistance if resistance else ""

            row += 1

        return wb, final_rows

    def _generate_sheet_prefixes(self):
        """Generates sheet name prefixes for current and previous month."""
        today = date.today()

        def get_prefix(d: date) -> str:
            base_year = 2025
            base_char_code = ord("T")
            year_char = chr(base_char_code + (d.year - base_year))
            month_str = f"{d.month:02d}"
            return f"{year_char}{month_str}"

        current_month_prefix = get_prefix(today)
        previous_month_date = today - relativedelta(months=1)
        previous_month_prefix = get_prefix(previous_month_date)

        return current_month_prefix, previous_month_prefix

    def _get_fragments_data(self):
        """Reads fragments file and consolidates data from current/previous month sheets.

        In v3.1 this also checks the special "PCR Fragments" sheet first, which
        takes priority over the monthly fragment sheets for matching.
        """
        # Lazy import pandas (heavy module, ~0.6s startup)
        import pandas as pd

        prefixes_to_check = self._generate_sheet_prefixes()
        self._log_threaded(
            f"  > Searching for sheets with prefixes: {prefixes_to_check}"
        )

        xls = pd.ExcelFile(self._fragments_path)
        all_sheet_names = xls.sheet_names

        relevant_sheets = [
            sheet
            for sheet in all_sheet_names
            if sheet.startswith(prefixes_to_check[0])
            or sheet.startswith(prefixes_to_check[1])
        ]

        relevant_sheets.sort(reverse=True)

        if not relevant_sheets:
            self._log_threaded("  > No matching sheets found.")

        all_fragments_list = []

        # --- Priority: Check "PCR Fragments" sheet first ---
        pcr_sheet = "PCR Fragments"
        if pcr_sheet in all_sheet_names:
            self._log_threaded(f"    - Checking special sheet '{pcr_sheet}'...")
            df_pcr = pd.read_excel(xls, sheet_name=pcr_sheet)
            df_pcr_filtered = df_pcr.dropna(subset=["Gene Name"]).copy()
            if not df_pcr_filtered.empty:
                df_pcr_filtered["Sheet Name"] = pcr_sheet
                # Extract concentration from column G (index 6) if available
                if len(df_pcr_filtered.columns) > 6:
                    df_pcr_filtered["Concentration"] = df_pcr_filtered.iloc[:, 6]
                all_fragments_list.append(df_pcr_filtered)
            self._log_threaded(
                f"      > Found {len(df_pcr_filtered)} PCR fragments."
            )

        # --- Monthly sheets ---
        if relevant_sheets:
            self._log_threaded(
                f"  > Found {len(relevant_sheets)} matching monthly sheets "
                f"(sorted newest to oldest): {relevant_sheets}"
            )

        for sheet_name in relevant_sheets:
            self._log_threaded(f"    - Processing sheet '{sheet_name}'...")
            df = pd.read_excel(xls, sheet_name=sheet_name)
            self._log_threaded(f"      > Original rows: {len(df)}")
            # Use .copy() to avoid SettingWithCopyWarning
            df_filtered = df.dropna(subset=["Gene Name"]).copy()
            self._log_threaded(f"      > Rows with Gene Name: {len(df_filtered)}")
            if not df_filtered.empty:
                df_filtered["Sheet Name"] = sheet_name
                all_fragments_list.append(df_filtered)

        if not all_fragments_list:
            self._log_threaded(
                "  > No data with Gene Names found in any of the matched sheets."
            )
            return pd.DataFrame()

        master_fragments_df = pd.concat(all_fragments_list, ignore_index=True)
        self._log_threaded(
            f"  > Consolidated fragments DataFrame shape: {master_fragments_df.shape}"
        )

        # Calculate insert length from 'Sequence' column
        if "Sequence" in master_fragments_df.columns:
            self._log_threaded(
                "  > Calculating insert length from 'Sequence' column..."
            )
            master_fragments_df["Insert Length"] = (
                master_fragments_df["Sequence"].fillna("").astype(str).str.len()
            )
            master_fragments_df.drop(columns=["Sequence"], inplace=True)
            self._log_threaded("  > 'Sequence' column has been dropped to save memory.")
        else:
            self._log_threaded(
                "  > WARNING: 'Sequence' column not found. 'Insert Length' will be set to 0."
            )
            master_fragments_df["Insert Length"] = 0

        COLS_TO_KEEP = [
            "Position",
            "Gene Name",
            "Purity Pass",
            "Yield Pass",
            "Sheet Name",
            "Insert Length",
            "Concentration",
        ]

        final_cols = [col for col in COLS_TO_KEEP if col in master_fragments_df.columns]
        return master_fragments_df[final_cols]

    def _write_fragments_to_layout(self, wb, fragments_to_write, manual_work_nos=None):
        """Writes fragment information to the layout file.

        In v3.1 this also:
        - Recalculates total length (column T) for manually entered jobs
        - Applies concentration-based volume adjustment for PCR fragments
        - Reads vector lengths from the external Vector_database.xlsx
        """
        # Lazy import pandas for isna check (used by PCR concentration logic)
        import pandas as pd

        try:
            ws = wb["Layout"]
        except KeyError:
            self._log_threaded(
                "  > FATAL ERROR: 'Layout' sheet not found. Cannot write fragment data."
            )
            return

        # Vector lookups built in _processing_thread (Step 0), stored as instance attributes

        # Find columns for "Insert 1", "Insert 2", "Insert 3"
        header_row = ws[1]
        insert_col_map = {}
        for cell in header_row:
            if cell.value in ["Insert 1", "Insert 2", "Insert 3"]:
                insert_col_map[cell.value] = cell.column

        if not insert_col_map:
            self._log_threaded(
                "  > WARNING: Could not find 'Insert 1/2/3' columns. Skipping fragment writing."
            )
            return

        # Iterate through data rows
        for r in range(2, ws.max_row + 1):
            work_no_in_sheet = ws.cell(row=r, column=2).value  # Column B is Work No.
            if work_no_in_sheet in fragments_to_write:
                vector_name_in_sheet = ws.cell(
                    row=r, column=4
                ).value  # Column D is Vector
                if isinstance(vector_name_in_sheet, str):
                    vector_name_in_sheet = vector_name_in_sheet.strip()

                self._log_threaded(
                    f"    - Attempting lookup for vector: '{vector_name_in_sheet}'"
                )
                vector_length = self._vector_length_map.get(vector_name_in_sheet)

                if not vector_length:
                    # Proceed regardless as requested by using a standard fallback for unknown vectors
                    vector_length = 3000
                    if vector_name_in_sheet:
                        self._log_threaded(
                            f"    > WARNING: Vector '{vector_name_in_sheet}' not in database. "
                            f"Proceeding with fragment calculations using default length of 3000bp."
                        )
                    else:
                        self._log_threaded(f"    > WARNING: Vector name missing for {work_no_in_sheet}. Using 3000bp default.")

                fragments = fragments_to_write[work_no_in_sheet]

                # For manually entered jobs, recalculate total length from fragment data
                if manual_work_nos and work_no_in_sheet in manual_work_nos:
                    total_len = sum(
                        float(frag.get("length", 0)) for frag in fragments
                    )
                    ws.cell(row=r, column=20).value = total_len  # Column T

                for i, frag in enumerate(fragments):
                    insert_key = f"Insert {i + 1}"
                    if insert_key in insert_col_map:
                        col_idx = insert_col_map[insert_key]

                        ws.cell(row=r, column=col_idx).value = frag["name"]
                        ws.cell(row=r, column=col_idx + 1).value = frag["location"]

                        if vector_length and vector_length > 0:
                            try:
                                insert_length = float(frag["length"])
                                volume = (insert_length / vector_length) * 12

                                # PCR Fragments: adjust volume by concentration
                                # Volume / (Concentration / 10)
                                conc = frag.get("concentration")
                                if (
                                    conc is not None
                                    and not pd.isna(conc)
                                    and float(conc) > 0
                                ):
                                    volume = volume / (float(conc) / 10)
                                    self._log_threaded(
                                        f"    > PCR volume adjustment applied for "
                                        f"{frag['name']} (Conc: {conc})"
                                    )

                                ws.cell(row=r, column=col_idx + 2).value = round(
                                    volume, 2
                                )
                            except (ValueError, TypeError):
                                self._log_threaded(
                                    f"    > WARNING: Invalid insert length "
                                    f"'{frag['length']}' for fragment '{frag['name']}'."
                                )


def main():
    """Standalone entry point when not launched from the hub."""
    ctk.set_appearance_mode("System")
    ctk.set_default_color_theme("blue")

    root = ctk.CTk()
    app = LigationLayoutApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()