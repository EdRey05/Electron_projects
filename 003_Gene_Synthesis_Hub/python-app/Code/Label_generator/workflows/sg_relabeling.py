"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.4
Date: Nov 04, 2026
Notes: Sg Relabeling workflow: relabels Sg shipping lists into the
    Shipping_labels.xlsx format the label printer already has set up (Sg
    tubes arrive with unreliable or outright wrong labels; this builds
    the corrected label data).
- Select one or more Sg shipping list Excel files (.xls, ColonyPCR-style
  multi-picker); adding files parses them automatically into the SO
  - BBI ID picker (Process re-runs the same parse; the file list is
  snapshotted before the worker thread starts).
- Shipping lists are read headerless - the Sg header row labels are
  unreliable - and the column layout is anchored on the Tube ID column
  (the only column reliably matching the tube barcode pattern). Each
  mapped column is verified against a content pattern, so a changed Sg
  layout fails loudly instead of silently shuffling fields.
- Sg replicate/additional-charge lines repeat a construct with the BBI
  SO# + BBI PO constant; the Work PO (Sg's 5th visible column, LA...)
  appears only on the most informative row. Collapsing keeps that row
  (first occurrence wins ties) and drops the charge-only rows.
- Field mapping: BBI SO# -> SO, BBI PO -> BBI ID, Customer No. ->
  Gene Name, vector -> Vector, amount -> Quantity (verbatim), Sg
  barcode -> Plasmid No. Resistance and Concentration are not in Sg's
  lists and stay blank; Storage Condition defaults to -20.
- The All tab is the picker now: clicking a row's check cell (or
  'Check all' after filtering the rows with the search box) lands the
  construct on the Selected tab the moment it is checked, and
  unchecking removes it - 'Copy Selected' puts the wishlist rows on
  the clipboard as tab-separated text with no header row, for pasting
  under the Shipping_labels excel's own headers.
- The Work PO and cloning site are carried as internal '_'-prefixed
  columns for later/QC-file use, not printed on labels.
v1.1 canonicalizes the field names to the job-log naming: the old
  'SO' column is the In-house Progress SO (BBI SO# -> SO);
  Antibiotic -> Resistance, Plasmid ID -> Plasmid No., Length ->
  Length (bp). The Shipping_labels.xlsx paste headers follow Ed's
  hand-fixed workbook (the label printer layout is being updated
  to match).
v1.2 tolerates missing/placeholder data: rows whose SO is the literal
  'N/A' (free re-rep / sequence-fix shipments carry no SO) or blank
  load as-is instead of failing the content checks; the read keeps
  cell text verbatim (keep_default_na=False) and the SO column is
  normalized to strings (numeric SOs keep exact digits, no .0 tails).
  The junk-header skip requires the row to look header-like on BOTH
  the tube and the SO cell, so a first data row with an N/A SO is no
  longer skipped.
v1.2 also rebuilds the result UI around two tabs (Ed's spec): parsing
  still auto-runs on Add and dumps every parsed construct onto the All
  tab - a scrollable, checkable table (first column, the Gene_email_
  system check pattern) with a live filter box (type a token like
  'UT605'), 'Check all' / 'Clear checks' helpers. A checked row lands
  on the Selected tab (the label wishlist) live, replacing the old
  Select-button pass; 'Copy Selected' copies exactly the Selected tab
  to the clipboard, header row excluded. The old SO - BBI ID dropdown
  is gone (no scrolling, no filtering, unusable on multi-file lists);
  checks survive re-parses and drive the wishlist, the shared log box
  hosts itself in the files row (app.get_logbox), and the Process
  button stays wired as the manual re-parse entry point for the
  QC-zip input planned next.
v1.3 hardening round (audit fixes): a file-list generation counter makes
  an in-flight parse drop its own settled result when the file list is
  mutated while reading (Add/Clear) - a Clear clicked during a slow
  parse used to be silently resurrected by the parse tail; the
  Process-button gate is now re-evaluated on EVERY parse settle and the
  early-return paths re-check it through after() (a Clear racing the
  validate step no longer strands the button disabled); the wishlist
  check key now includes the Plasmid No. (the same identity the dedupe
  uses) so two rows sharing an SO + BBI PO pair are checkable
  individually; the _auto_parse_async prelude no longer touches the
  Process button from a worker thread (the Add path disables it on the
  main thread); xlrd is imported only for .xls files.
v1.4 drops the shared Process button together with the shell's
  start_processing pass - the button only re-ran the same auto-parse that
  Add already runs, so the manual QC-zip re-parse entry it was kept for is
  not landing (a parse that loses the race against an Add/Clear now
  re-runs itself on the current list, no manual recovery pass). 'Add...'
  becomes just 'Add'. New 'Autodiscovery' button under the Add/Clear
  stack: setup_default_paths resolves the 4.6 Shipping list folder from
  the hub's default_directories.ini ('Shipping_List' key) and validates
  its existence on a worker thread at launch - the button enables only
  when the folder exists (a mapped-off drive cannot freeze the launch).
  Clicking it scans that folder for dated subfolders (names of 8 digits,
  all numbers - no date parsing; the folder is pruned to ~2 months of
  dates, so every present date folder is a candidate), newest first, and
  only keeps the ones holding excel files whose name starts with
  'shipping list for' (the sibling 'In-house items for *.xls' lists are
  ignored). It then opens the small check popup - 2 columns, 'Add?' +
  'Shipping list date', font smaller than the main window, Cancel
  (closes, does nothing) and Proceed (appends the checked folders' files
  to the field and auto-parses, exactly like the manual Add).
"""

import os
import re
import threading

import customtkinter as ctk
from tkinter import filedialog, messagebox

from tools.measurement_table import MeasurementTable
from tools.checkbox_table import CheckboxTable

# Shipping_labels.xlsx canonical columns (Ed maintains this file; these are
# the column names the label printer layout expects).
LABEL_COLUMNS = [
    "BBI ID", "Gene Name", "Vector", "Resistance", "Quantity", "Length (bp)",
    "Tube ID", "Plasmid No.", "SO", "Storage Condition (C)", "Concentration",
]

# Table columns = the 10 label-printed fields; Concentration is dropped
# (blank for Sg shipments; the cell stays empty in the excel).
TABLE_COLUMNS = [
    (col, width, "w" if col in ("Gene Name", "Vector", "Resistance", "Plasmid No.") else "center")
    for col, width in [
        ("BBI ID", 110), ("Gene Name", 150), ("Vector", 150), ("Resistance", 80),
        ("Quantity", 70), ("Length (bp)", 60), ("Tube ID", 90), ("Plasmid No.", 160),
        ("SO", 90), ("Storage Condition (C)", 110),
    ]
]

DEFAULT_STORAGE = "-20"

SEARCH_PLACEHOLDER = "Type to filter the rows, e.g. UT605"

# Autodiscovery: the 4.6 Shipping list folder is resolved from the hub's
# default_directories.ini ('Label, "subpath"' entries, drive label mapped
# by the launcher) and validated in the background at launch.
SHIPPING_LIST_INI_SECTION = "Paths"
SHIPPING_LIST_INI_KEY = "Shipping_List"
# Dated subfolders (8 characters, all numbers - no date parsing; the 4.6
# folder is pruned to ~2 months, so every present date name is a
# candidate). Files inside: excel lists whose name starts with the Sg
# shipping-list prefix (the sibling 'In-house items for *.xls' lists are
# ignored).
DATE_FOLDER_PATTERN = re.compile(r"^\d{8}$")
SHIPPING_LIST_FILE_PREFIX = "shipping list for"
EXAMINE_EXCEL_SUFFIXES = (".xls", ".xlsx", ".xlsm")

# Content patterns used to anchor/verify the Sg column layout.
TUBE_ID_PATTERN = re.compile(r"^[PU]\d{6,}$")
SO_PATTERN = re.compile(r"^\d{6,10}$")
LENGTH_PATTERN = re.compile(r"^\d{1,5}$")
QUANTITY_PATTERN = re.compile(r"^\d+(?:\.\d+)?\s*(?:ug|ng|pg|mg|µg|uL)$", re.IGNORECASE)
PLASMID_ID_PATTERN = re.compile(r"^\d{6}[A-Z]")


def _norm(v) -> str:
    """Normalizes a raw Excel cell into a clean string (float 881.0 -> '881')."""
    if v is None:
        return ""
    try:
        if v != v:  # NaN
            return ""
    except Exception:
        pass
    if isinstance(v, float) and float(v).is_integer():
        return str(int(v))
    s = str(v).strip()
    return "" if s.lower() == "nan" else s


# Placeholder values a shipping list carries for a missing field. Free
# re-rep / sequence-fix shipments ship with no SO: the cell reads the
# literal 'N/A' (or is left blank). '-' style dashes occur in other cols.
_BLANKISH_VALUES = {"", "n/a", "na", "-", "--", "nan", "none", "null"}


def _blankish(v) -> bool:
    """True when a cell is empty or an explicit placeholder (N/A, -)."""
    return _norm(v).strip().lower() in _BLANKISH_VALUES


class SgRelabeling:
    """Reads Sg shipping lists, maps them to Shipping_labels columns, and
    collapses replicate/charge rows into one row per construct."""

    def __init__(self, app_instance):
        self.app = app_instance
        self.log = self.app.log

        self.shipping_files = []
        self.all_records = []     # every parsed construct (All tab model)
        self.checked_keys = set() # construct keys checked on the All tab
        self.selected_rows = []   # rows transferred to the label table
        self._parsing = False     # guards concurrent auto-parse runs
        self._file_generation = 0 # bumped on every files-list mutation; an
                                  # in-flight parse drops itself when stale

        self._shipping_list_base = None  # 4.6 Shipping list folder (hub config)
        self.autodiscovery_button = None # built in create_ui; the launch-time
                                         # validation enables it when the 4.6
                                         # folder exists
        self._discovery_popup = None     # open check popup (Autodiscovery)

    # ------------------------------------------------------------------
    # UI
    # ------------------------------------------------------------------
    def create_ui(self, parent_frame):
        main_panel = ctk.CTkFrame(parent_frame, fg_color="transparent")
        main_panel.pack(fill="both", expand=True, padx=10, pady=6)

        # --- Shipping list files + the shared LOG BOX on one row (Ed's
        # layout): the field spans columns 1-2, the Add/Clear/Autodiscovery
        # buttons on column 3, and the log the last two; the row is ~15%
        # taller than the old field-only strip, with breathing room after it.
        files_frame = ctk.CTkFrame(main_panel, fg_color="transparent")
        files_frame.pack(fill="x", pady=(2, 12))
        for i in range(5):
            files_frame.grid_columnconfigure(i, weight=1, uniform="files_cols")
        files_frame.grid_rowconfigure(0, weight=1)

        self.files_textbox = ctk.CTkTextbox(files_frame, height=152, wrap="word")
        self.files_textbox.grid(row=0, column=0, columnspan=2, sticky="nsew",
                                padx=(0, 10))
        self.files_textbox.configure(state="disabled")

        buttons_frame = ctk.CTkFrame(files_frame, fg_color="transparent")
        buttons_frame.grid(row=0, column=2, sticky="ns")

        ctk.CTkButton(buttons_frame, text="Add", command=self._add_shipping_files, width=120).pack(pady=(0, 5))
        ctk.CTkButton(buttons_frame, text="Clear", command=self._clear_shipping_files, width=120).pack()
        # Autodiscovery stays disabled until the launch-time validation finds
        # the 4.6 Shipping list folder (mapped-off drives cannot block this).
        self.autodiscovery_button = ctk.CTkButton(
            buttons_frame, text="Autodiscovery", command=self._run_autodiscovery,
            width=120, state="disabled")
        self.autodiscovery_button.pack(pady=(5, 0))

        # The shell's log box hosts itself in this row (created lazily on
        # first call; earlier log messages flush into it in order).
        self.app.get_logbox(files_frame, row=0, column=3, columnspan=2,
                            sticky="nsew")

        # --- Results tabs: All (parsed rows, checkable) / Selected (the
        # label wishlist). Autoparse dumps every construct onto the All
        # tab; a row transfers to Selected the moment its check cell is
        # clicked (the checks ARE the wishlist) - Ed's rework removed the
        # SO - BBI ID dropdown (unusable on lists with dozens of rows) and
        # the Select pass with it. The shared Process button was removed
        # in v1.4 - the auto-parse on Add covers everything it did.
        tabview = ctk.CTkTabview(main_panel)
        tabview.pack(fill="both", expand=True, pady=(8, 0))
        # Ed: the tabs are the primary navigation - ~8pt bigger + bold
        # over the theme default (13).
        tabview._segmented_button.configure(
            font=ctk.CTkFont(size=21, weight="bold"))
        self._tabview = tabview
        self._tabview.add("All")
        self._tabview.add("Selected")

        # == All tab: live search + checkable table of everything parsed ==
        all_tab = tabview.tab("All")

        search_frame = ctk.CTkFrame(all_tab, fg_color="transparent")
        search_frame.pack(fill="x")

        ctk.CTkLabel(
            search_frame,
            text="Search:",
            font=ctk.CTkFont(size=14, weight="bold"),
        ).pack(side="left", padx=(0, 6))

        self.search_entry = ctk.CTkEntry(
            search_frame, placeholder_text=SEARCH_PLACEHOLDER, width=260,
        )
        self.search_entry.pack(side="left")
        self.search_entry.bind("<KeyRelease>", self._on_search_change, add="+")
        self.search_entry.bind("<<Paste>>", self._on_search_change, add="+")

        # Flow order left-to-right: Check all -> Clear checks.
        ctk.CTkButton(
            search_frame, text="Clear checks", command=self._clear_checks, width=100,
        ).pack(side="right", padx=(6, 0))
        ctk.CTkButton(
            search_frame, text="Check all", command=self._check_all_rows, width=110,
        ).pack(side="right", padx=(6, 0))

        self.all_table = CheckboxTable(
            all_tab, columns=TABLE_COLUMNS, height=8, font_size=11,
            on_check=self._on_check_toggle)
        self.all_table.pack(fill="both", expand=True, pady=(6, 0))

        # == Selected tab: the label wishlist ===
        sel_tab = tabview.tab("Selected")

        table_header_frame = ctk.CTkFrame(sel_tab, fg_color="transparent")
        table_header_frame.pack(fill="x")

        ctk.CTkLabel(
            table_header_frame,
            text="Label Rows (selected constructs):",
            font=ctk.CTkFont(size=14, weight="bold"),
        ).pack(side="left")

        ctk.CTkButton(
            table_header_frame,
            text="Copy Selected",
            command=self._copy_table,
            width=120,
        ).pack(side="right")

        ctk.CTkButton(
            table_header_frame,
            text="Clear table",
            command=self._clear_table,
            width=100,
        ).pack(side="right", padx=(0, 8))

        self.results_table = MeasurementTable(
            sel_tab, columns=TABLE_COLUMNS, height=8, font_size=11
        )
        self.results_table.pack(fill="both", expand=True, pady=(8, 0))

        self._update_files_display()

    # --- Files picker helpers ---
    def _update_files_display(self):
        """Updates the textbox display with the currently selected files."""
        self.files_textbox.configure(state="normal")
        self.files_textbox.delete("1.0", "end")
        if self.shipping_files:
            for f in self.shipping_files:
                self.files_textbox.insert("end", os.path.basename(f) + "\n")
        else:
            self.files_textbox.insert("end", "No files selected")
        self.files_textbox.configure(state="disabled")

    def _add_shipping_files(self):
        """Opens a file dialog to add Sg shipping list files; any newly
        added file triggers the auto-parse."""
        filenames = filedialog.askopenfilenames(
            title="Select Sg Shipping List Files",
            filetypes=[("Excel files", "*.xls *.xlsx *.xlsm"), ("All files", "*.*")],
        )
        self._add_files_and_parse(filenames)

    def _add_files_and_parse(self, filenames) -> list:
        """Appends the new files to the field (skipping what is already
        there, like the manual Add always did) and auto-parses them -
        shared by the manual Add dialog and the Autodiscovery Proceed.
        Returns the actually-added file paths."""
        added = []
        for filename in filenames:
            if filename and filename not in self.shipping_files:
                self.shipping_files.append(filename)
                added.append(filename)
        if added:
            self._file_generation += 1
            self._update_files_display()
            self._auto_parse_async()
        return added

    def _clear_shipping_files(self):
        """Clears all selected files and resets the parsed state (All tab
        checks and filter included) - the label table mirrors the checks,
        so the wishlist empties with it."""
        self.shipping_files = []
        self._file_generation += 1
        self.all_records = []
        self.checked_keys = set()
        self.all_table.set_data([])
        try:
            self.search_entry.delete(0, "end")
        except Exception:
            pass
        self._sync_selected_from_checks()
        self._update_files_display()

    # --- Auto-parse (files added => parse immediately) ---
    def _auto_parse(self, files=None, preserve_checks=None, generation=None):
        """Parses the given files (defaults to everything in the field) and
        rebuilds all_records. Pure computation; runs on a worker thread;
        widget updates are scheduled back onto the main thread after.
        preserve_checks: construct keys checked before this re-parse
        (snapshotted on the main thread) - they stay checked.
        generation: file-list generation this run belongs to; when the
        list was mutated while the parse ran, the result is dropped
        instead of overwriting the newer list state."""
        if files is None:
            files = list(self.shipping_files)
        self.log("[INFO] \t Parsing shipping list file(s)...")

        all_rows = []
        failed_files = []
        for path in list(files):
            name = os.path.basename(path)
            try:
                rows = self._read_shipping_list(path)
                if not rows:
                    failed_files.append(name)
                    self.log(f"[WARNING] \t '{name}': no data rows could be parsed.")
                    continue
                self.log(f"[OK] \t '{name}': {len(rows)} construct row(s) identified.")
                all_rows.extend(rows)
            except Exception as e:
                failed_files.append(name)
                self.log(f"[ERROR] \t Failed to read '{name}': {e}")

        new_records = []
        if all_rows:
            new_records = self._dedupe_rows(all_rows)
            self.log(
                f"[SUMMARY] \t {len(all_rows)} raw construct row(s) -> "
                f"{len(new_records)} unique row(s) after replicate/charge collapse."
            )
            if failed_files:
                self.log(f"[WARNING] \t Files with no usable data: {', '.join(failed_files)}")
        else:
            self.log("[FINISHED] \t No construct rows identified. Nothing to do.")

        if generation is not None and generation != self._file_generation:
            self.log(
                "[INFO] \t Parse result dropped - the file list changed "
                "while parsing."
            )
        else:
            self.all_records = new_records
            available = {self._construct_key(r) for r in new_records}
            self.checked_keys = set(preserve_checks or ()) & available

    def _auto_parse_async(self, files=None):
        """Runs _auto_parse on a worker thread (one at a time) and settles
        the UI (All tab) afterwards on the main thread. The file list AND
        the checked keys are snapshotted on the calling path before the
        thread starts - the widgets must not be read from the worker
        (thread-race rule)."""
        if self._parsing:
            self.log("[INFO] \t Already parsing - please wait.")
            return
        if files is None:
            files = list(self.shipping_files)
        if not files:
            self.log("[INFO] \t No files to parse.")
            return
        preserve = self._current_checked_keys()
        generation = self._file_generation
        self._parsing = True

        def worker():
            try:
                self._auto_parse(files, preserve_checks=preserve,
                                 generation=generation)
            finally:
                self._parsing = False
                try:
                    self.app.after(0, lambda: self._finalize_auto_parse(generation))
                except Exception:
                    pass

        threading.Thread(target=worker, daemon=True).start()

    def _finalize_auto_parse(self, generation=None):
        """Main-thread UI settle after the auto-parse worker finishes.
        A run that was dropped as stale (the file list changed while it
        read) re-runs itself on the current list - the old Process-button
        recovery pass is gone, so the auto-parse self-heals after the
        race instead of waiting for a manual re-run."""
        self._refresh_all_table()
        self._sync_selected_from_checks()
        if generation is not None and generation != self._file_generation:
            self.log("[INFO] \t Re-running the parse on the current list.")
            self._auto_parse_async()

    # ------------------------------------------------------------------
    # All-tab helpers (main thread only - these touch widgets)
    # ------------------------------------------------------------------
    def _refresh_all_table(self):
        """Renders the All tab from self.all_records; the checked keys
        survive every refresh (each record keeps its construct key)."""
        cells = [self._row_cells(r) for r in self.all_records]
        checked = [
            i for i, r in enumerate(self.all_records)
            if self._construct_key(r) in self.checked_keys
        ]
        self.all_table.set_data(cells, checked_indices=checked)
        self.all_table.set_filter(self.search_entry.get())

    def _current_checked_keys(self) -> set:
        """Snapshot of the checked construct keys; taken on the main thread
        before a parse worker starts so checks survive the re-parse."""
        try:
            records = self.all_records
            indices = self.all_table.get_checked_indices()
        except AttributeError:
            return set()
        return {
            self._construct_key(records[i])
            for i in indices if 0 <= i < len(records)
        }

    def _on_search_change(self, _event=None):
        """Live filter of the All table from the search entry."""
        try:
            self.all_table.set_filter(self.search_entry.get().strip())
        except Exception:
            pass  # UI not built (headless); nothing to filter

    def _check_all_rows(self):
        """Checks every row currently visible under the filter (renamed
        from 'Check matches') - the search-then-check flow; checked rows
        land on the label table live."""
        matches = self.all_table.visible_count()
        if not matches:
            self.log("[INFO] \t No rows visible under the current filter.")
            return
        self.all_table.check_visible()
        added, already = self._sync_selected_from_checks()
        self.log(f"[OK] \t Checked {matches} visible row(s) "
                 f"({added} added to the label table).")

    def _clear_checks(self):
        self.all_table.clear_checks()
        _, removed = self._sync_selected_from_checks()
        self.log(f"[INFO] \t All checks cleared "
                 f"({removed} row(s) left the label table).")

    def _on_check_toggle(self, data_idx: int, checked: bool):
        """The widget's click-toggle callback: checking a row adds it to
        the Selected tab live (no separate Select pass); unchecking
        removes it."""
        self._sync_selected_from_checks()
        row = self.all_records[data_idx]
        if checked:
            self.log(f"[OK] \t Added to label table: {row['SO']} - {row['BBI ID']}")
        else:
            self.log(f"[INFO] \t Removed from the label table: "
                     f"{row['SO']} - {row['BBI ID']}")

    def _sync_selected_from_checks(self):
        """Rebuilds the Selected (label) table from the All-tab check
        marks - the two are the same thing now: a checked construct is on
        the label table, unchecking removes it. Wishlist rows that stay
        checked keep their order; newly checked rows follow in table
        order. Returns (added, removed) counts."""
        try:
            checked_idx = self.all_table.get_checked_indices()
        except AttributeError:
            return 0, 0
        records = self.all_records
        checked_keys = set()
        for i in checked_idx:
            if 0 <= i < len(records):
                checked_keys.add(self._construct_key(records[i]))
        old = set(self._selected_keys())
        added_idx = [
            i for i in checked_idx
            if 0 <= i < len(records)
            and self._construct_key(records[i]) not in old
        ]
        self.selected_rows = (
            [dict(r) for r in self.selected_rows
             if self._construct_key(r) in checked_keys]
            + [dict(records[i]) for i in added_idx]
        )
        self._refresh_table()
        return len(added_idx), len(old - checked_keys)

    def _clear_table(self):
        """Removes every row from the results table - and, since the label
        table mirrors the All-tab checks, their check marks too."""
        self.all_table.clear_checks()
        self.selected_rows = []
        self._refresh_table()
        self.log("[INFO] \t Label table cleared.")

    def _selected_keys(self):
        return [self._construct_key(r) for r in self.selected_rows]

    @staticmethod
    def _construct_key(row) -> tuple:
        """Identity on which a row is checked/collapsed/deduped: the
        construct key plus the physical tube (Plasmid No.), so two rows
        sharing an SO + BBI PO pair (the same construct re-listed across
        files) stay individually checkable."""
        return (row["SO"], row["BBI ID"], row["Plasmid No."])

    def _refresh_table(self):
        """Re-renders the results table from self.selected_rows."""
        cells = [self._row_cells(r) for r in self.selected_rows]
        self.results_table.set_rows(cells)

    @staticmethod
    def _row_cells(row) -> tuple:
        """Converts a processed construct into the display tuple for the
        table (same field order as TABLE_COLUMNS)."""
        return (
            row["BBI ID"], row["Gene Name"], row["Vector"], row["Resistance"],
            row["Quantity"], row["Length (bp)"], row["Tube ID"], row["Plasmid No."],
            row["SO"], row["Storage Condition (C)"],
        )

    def _copy_table(self):
        """Puts the full Selected (label) table on the clipboard - rows
        only (no column header row; the Shipping_labels excel already
        carries its headers)."""
        self.results_table.copy_all_rows(include_header=False)
        n = len(self.selected_rows)
        if n:
            self.log(f"[OK] \t Copied {n} Selected row(s) to the clipboard - "
                     f"paste into the Shipping_labels excel as-is.")
        else:
            self.log("[INFO] \t Label table is empty.")

    # ------------------------------------------------------------------
    # App contract
    # ------------------------------------------------------------------
    def setup_default_paths(self):
        """Resolves the 4.6 Shipping list folder from the hub config
        (default_directories.ini 'Shipping_List' entry, drive label mapped
        by the launcher) and validates it in the background - the
        Autodiscovery button enables only when the folder exists (a
        mapped-off drive must not freeze the launch, so the check runs on
        a worker thread and flips the button state through after())."""
        self._shipping_list_base = self.app.make_path_from_config(
            SHIPPING_LIST_INI_SECTION, SHIPPING_LIST_INI_KEY
        )
        self._validate_shipping_base_async()

    def _validate_shipping_base_async(self):
        """Launch-time background existence check of the 4.6 folder
        (the isdir on a dead network drive can block for seconds - never
        the main thread). Thread-widget rule: the button state flips on
        the main thread via after()."""
        base = self._shipping_list_base

        def worker():
            exists = bool(base) and os.path.isdir(base)

            def settle():
                self._set_autodiscovery_state("normal" if exists else "disabled")
                if not base:
                    self.log(
                        "[WARNING] \t Autodiscovery disabled: the 'Shipping_List' "
                        "key is not configured (hub drive mapping missing).")
                elif exists:
                    self.log(
                        f"[OK] \t Autodiscovery: shipping list folder found - "
                        f"button enabled.")
                else:
                    self.log(
                        f"[WARNING] \t Autodiscovery disabled: the shipping list "
                        f"folder does not exist on this machine.")

            self.app.after(0, settle)

        threading.Thread(target=worker, daemon=True).start()

    def _set_autodiscovery_state(self, state):
        try:
            self.autodiscovery_button.configure(state=state)
        except Exception:
            pass  # button not built yet (pre-UI call, headless harness)

    # ------------------------------------------------------------------
    # Autodiscovery (4.6 Shipping list dated folders -> file field)
    # ------------------------------------------------------------------
    def _run_autodiscovery(self):
        """Autodiscovery button: scans the 4.6 Shipping list folder for
        dated subfolders holding Sg shipping lists and opens the check
        popup. The scan itself runs on a worker thread (a network folder
        may answer slowly); the popup opens on the main thread."""
        base = self._shipping_list_base
        if self._discovery_popup is not None and self._discovery_popup.winfo_exists():
            try:
                self._discovery_popup.focus()  # a second click just refocuses
            except Exception:
                pass
            return
        if not base:
            messagebox.showerror(
                "Autodiscovery", "The Shipping_List path is not configured.")
            self._set_autodiscovery_state("disabled")
            return
        if not os.path.isdir(base):
            messagebox.showerror(
                "Autodiscovery",
                "The shipping list folder does not exist (drive off?):\n" + base)
            self._validate_shipping_base_async()  # re-validate; disables again
            return

        self._set_autodiscovery_state("disabled")  # while scanning

        def worker():
            try:
                findings = self._scan_shipping_folders(base)
            except Exception as exc:
                self.log(f"[ERROR] \t Autodiscovery scan failed: {exc}")
                findings = None
            self.app.after(0, lambda: self._settle_autodiscovery_scan(findings))

        threading.Thread(target=worker, daemon=True).start()

    def _settle_autodiscovery_scan(self, findings: list):
        """Main-thread settle of the scan: re-enable the button, then
        either open the check popup or report that nothing matched."""
        self._set_autodiscovery_state("normal")
        if not findings:
            self.log(
                "[INFO] \t Autodiscovery: no dated folder with a 'shipping "
                "list' file found under the 4.6 Shipping list folder.")
            return
        self.log(
            f"[OK] \t Autodiscovery found {len(findings)} dated folder(s) "
            f"with shipping list file(s).")
        self._show_discovery_popup(findings)

    def _scan_shipping_folders(self, base: str) -> list:
        """Worker-safe scan of the 4.6 Shipping list folder: dated
        subfolders (8 characters, all numbers - no date parsing; the
        folder is pruned to ~2 months so every present date name is a
        candidate) sorted newest-to-oldest, keeping only the ones that
        hold excel files whose name starts with 'shipping list for' (the
        sibling 'In-house items for *.xls' lists are ignored). Returns
        [(folder name, [absolute file paths]), ...] newest first."""
        findings = []
        for name in sorted(os.listdir(base), reverse=True):
            folder_path = os.path.join(base, name)
            if not DATE_FOLDER_PATTERN.match(name) or not os.path.isdir(folder_path):
                continue  # non-date names (other folders) are ignored
            try:
                entries = sorted(os.listdir(folder_path))
            except OSError as exc:
                self.log(f"[WARNING] \t Autodiscovery: '{name}' unreadable ({exc}).")
                continue
            files = [
                os.path.join(folder_path, entry)
                for entry in entries
                if entry.lower().startswith(SHIPPING_LIST_FILE_PREFIX)
                and entry.lower().endswith(EXAMINE_EXCEL_SUFFIXES)
            ]
            if files:
                findings.append((name, files))
        return findings

    def _show_discovery_popup(self, findings: list):
        """The small check popup (Ed's spec): 2 columns, 'Add?' + 'Shipping
        list date', font smaller than the main window, Cancel (closes,
        does nothing) and Proceed (appends the checked folders' files to
        the field exactly like the manual Add)."""
        popup = ctk.CTkToplevel(self.app)
        popup.title("Autodiscovery - Sg shipping lists")
        popup.geometry("340x430")
        popup.attributes("-topmost", True)  # stays above the app while picking
        # CTkToplevel has a known first-draw race: force the geometry pass
        # before the table builds its rows.
        popup.after(10, lambda: self._build_discovery_popup(popup, findings))
        self._discovery_popup = popup

    def _build_discovery_popup(self, popup, findings: list):
        if not popup.winfo_exists():
            return  # closed already
        ctk.CTkLabel(
            popup,
            text="Date folders with shipping lists (newest first):",
            font=ctk.CTkFont(size=11, weight="bold"),
        ).pack(fill="x", padx=10, pady=(10, 4))

        table = CheckboxTable(
            popup, columns=[("Shipping list date", 190, "center")],
            height=10, font_size=9, check_header="Add?", check_width=52)
        table.pack(fill="both", expand=True, padx=10)
        table.set_data([(name,) for name, _files in findings])

        button_row = ctk.CTkFrame(popup, fg_color="transparent")
        button_row.pack(fill="x", padx=10, pady=10)
        ctk.CTkButton(
            button_row, text="Cancel", width=110, fg_color="#9E9E9E",
            hover_color="#757575", command=popup.destroy,
        ).pack(side="left", expand=True, padx=(0, 5))
        ctk.CTkButton(
            button_row, text="Proceed", width=110,
            command=lambda: self._proceed_discovery(popup, table, findings),
        ).pack(side="right", expand=True, padx=(5, 0))

    def _proceed_discovery(self, popup, table, findings: list):
        """Proceed: the checked date folders' matching files land in the
        field (deduped against what is already there) and the auto-parse
        runs - exactly the manual Add behavior, coming from the popup."""
        if not popup.winfo_exists():
            self._discovery_popup = None
            return
        checked = table.get_checked_indices()
        files = [path for i in checked for path in findings[i][1]]
        popup.destroy()
        self._discovery_popup = None
        if not files:
            self.log("[INFO] \t Autodiscovery: no folder selected - nothing added.")
            return
        added = self._add_files_and_parse(files)
        if added:
            self.log(
                f"[OK] \t Autodiscovery: added {len(added)} shipping list "
                f"file(s) from {len(checked)} folder(s).")
        else:
            self.log(
                "[INFO] \t Autodiscovery: those file(s) are already in the "
                "field - nothing added.")

    # ------------------------------------------------------------------
    # Shipping-list parsing
    # ------------------------------------------------------------------
    def _read_shipping_list(self, path: str) -> list:
        """Parses one Sg shipping list (headerless) and returns one dict per
        construct. Replicate/charge rows of a construct share the same
        (SO, BBI ID) pair; only the row with the most info is returned.

        Column layout is anchored on the Tube ID column (the only column
        reliably matching ^[PU]\\d{6,}$); neighbors are mapped relative to it
        and verified with content-pattern assertions, so a layout drift
        fails loudly instead of silently shuffling fields.
        """
        import pandas as pd

        if str(path).lower().endswith(".xls"):
            # .xls engine needed ONLY for .xls lists - a missing xlrd must
            # not fail .xlsx loads.
            try:
                import xlrd  # noqa: F401
            except ImportError as e:
                raise RuntimeError(
                    "Reading Sg .xls shipping lists needs xlrd (pip install xlrd)."
                ) from e

        # keep_default_na=False: a literal 'N/A' cell must arrive as its
        # text, not as a NaN blank; truly missing cells normalize to ''
        # downstream anyway.
        raw = pd.read_excel(path, sheet_name=0, header=None, dtype=object,
                            keep_default_na=False)
        if raw.empty:
            return []
        raw = raw.dropna(how="all", axis=0)  # blank rows only; keep col positions
        if raw.empty:
            return []

        n_rows, n_cols = raw.shape

        # --- Anchor: Tube ID column (P1188398-style values in every row) ---
        best_hits, tube_col = max(
            (sum(1 for v in raw.iloc[:, c] if TUBE_ID_PATTERN.match(_norm(v))), c)
            for c in range(n_cols)
        )
        if best_hits < max(1, int(0.9 * n_rows)):
            raise ValueError(
                "Could not locate the Tube ID column "
                f"(only {best_hits}/{n_rows} rows match); unexpected Sg layout."
            )

        def grab(off):
            idx = tube_col + off
            if idx < 0 or idx >= n_cols:
                return pd.Series([None] * n_rows, index=raw.index)
            return raw.iloc[:, idx]

        so_series = grab(-7).map(_norm)   # BBI SO# -> SO, ALWAYS as text
                                          # ('N/A' stays literal; numeric
                                          # SOs lose any .0 float tail)
        bbi_po_series = grab(-6)    # BBI PO -> BBI ID
        gene_series = grab(-5)      # Customer No. -> Gene Name
        work_po_series = grab(-4)   # Work PO (kept, not printed)
        length_series = grab(-3)    # length
        vector_series = grab(-2)    # vector
        site_series = grab(-1)      # cloning site
        tube_series = grab(0)       # tube ID (anchor)
        amount_series = grab(1)     # amount -> Quantity

        # --- Content assertions (fail loudly on layout drift) ---
        self._assert_column(so_series, SO_PATTERN, "SO / BBI SO#", 0.9)
        self._assert_column(length_series, LENGTH_PATTERN, "Length (bp)", 0.9)
        self._assert_column(amount_series, QUANTITY_PATTERN, "Quantity", 0.9)
        self._assert_column(tube_series, TUBE_ID_PATTERN, "Tube ID", 0.9)
        bbi_bad = sum(
            1 for v in bbi_po_series
            if not _blankish(v) and TUBE_ID_PATTERN.match(_norm(v))
        )
        if n_rows - bbi_bad < 0.9 * n_rows:
            raise ValueError("BBI PO column does not hold string values as expected.")

        # --- Plasmid No.: rightmost populated barcode-style column ---
        plasmid_col_idx = None
        for c in range(n_cols - 1, tube_col, -1):
            vals = [_norm(v) for v in raw.iloc[:, c]]
            if sum(1 for v in vals if PLASMID_ID_PATTERN.match(v)) >= max(1, int(0.6 * n_rows)):
                plasmid_col_idx = c
                break
        if plasmid_col_idx is None:
            raise ValueError(
                "Could not locate the Plasmid No. column (rightmost barcode-style column)."
            )
        plasmid_series = raw.iloc[:, plasmid_col_idx]

        # --- Skip the Sg junk header row if present. It fails BOTH the
        # tube and the SO content patterns; a real data row always carries
        # a tube barcode (even N/A-SO re-rep rows keep theirs), so the
        # double match never skips a legit first data row.
        start = 0
        if (not TUBE_ID_PATTERN.match(_norm(tube_series.iloc[0]))
                and not SO_PATTERN.match(so_series.iloc[0])):
            start = 1
            self.log("[INFO] \t Skipped the Sg header row.")

        n_no_so = sum(1 for i in range(start, n_rows) if _blankish(so_series.iloc[i]))
        if n_no_so:
            self.log(
                f"[INFO] \t SO 'N/A'/blank on {n_no_so} row(s) - free re-rep/"
                f"sequence-fix shipments; loaded with the SO as-is.")

        # --- Group rows by construct key; keep the row with the most info ---
        groups = {}
        order = []
        for r in range(start, n_rows):
            so = _norm(so_series.iloc[r])
            bbi_po = _norm(bbi_po_series.iloc[r])
            if not so and not bbi_po:
                continue
            key = (so, bbi_po)
            if key not in groups:
                groups[key] = []
                order.append(key)
            row = raw.iloc[r]
            score = sum(
                1 for v in (
                    _norm(row.iloc[tube_col - 5]),   # gene name
                    _norm(row.iloc[tube_col - 4]),   # Work PO
                    _norm(row.iloc[tube_col - 1]),   # cloning site
                    _norm(row.iloc[plasmid_col_idx]) if plasmid_col_idx is not None else None,
                ) if v
            )
            groups[key].append((score, r))

        rows_out = []
        for key in order:
            # max() picks the highest info score; ties resolve to the
            # earliest row (first occurrence), matching Ed's spec: the
            # first row of the group normally carries the Work PO.
            _, best_r = max(groups[key], key=lambda t: (t[0], -t[1]))

            rows_out.append({
                "BBI ID": _norm(bbi_po_series.iloc[best_r]),
                "Gene Name": _norm(gene_series.iloc[best_r]),
                "Vector": _norm(vector_series.iloc[best_r]),
                "Resistance": "",  # not provided by Sg; left blank for manual fill
                "Quantity": _norm(amount_series.iloc[best_r]),
                "Length (bp)": _norm(length_series.iloc[best_r]),
                "Tube ID": _norm(tube_series.iloc[best_r]),
                "Plasmid No.": _norm(plasmid_series.iloc[best_r]),
                "SO": _norm(so_series.iloc[best_r]),
                "Storage Condition (C)": DEFAULT_STORAGE,
                "Concentration": "",  # not provided by Sg
                "_Work PO": _norm(work_po_series.iloc[best_r]),
                "_Cloning Site": _norm(site_series.iloc[best_r]),
                "_Source File": os.path.basename(path),
            })
        return rows_out

    def _assert_column(self, series, pattern, label: str, min_frac: float):
        """Verifies a column against an expected content pattern; raises a
        clear error when the Sg layout has drifted. Placeholder/missing
        cells ('N/A', blank, dash) prove nothing either way - a real re-rep
        row carries an N/A SO - so they count toward column identity and
        only genuinely different text makes the check fail."""
        vals = [_norm(v) for v in series]
        hits = sum(1 for v in vals if v and pattern.match(v))
        blanks = sum(1 for v in vals if _blankish(v))
        n = len(vals)
        if hits + blanks < max(1, int(min_frac * n)):
            raise ValueError(
                f"Column check failed for '{label}': "
                f"only {hits}/{n} values match the expected format "
                f"({blanks} blank/'N/A' tolerated)."
            )

    # ------------------------------------------------------------------
    # Collapse + dataframe helpers
    # ------------------------------------------------------------------
    def _dedupe_rows(self, rows: list) -> list:
        """Residual exact dupes (within/across files) collapse to the row
        with the most info; keyed on the construct identity."""
        combined = {}
        for r in rows:
            key = (r["SO"], r["BBI ID"], r["Plasmid No."], r["Gene Name"])
            if key not in combined or self._row_info_count(r) > self._row_info_count(combined[key]):
                combined[key] = r
        return [combined[k] for k in combined]

    def _row_info_count(self, row: dict) -> int:
        informative_cols = [
            "Gene Name", "Vector", "Quantity", "Length (bp)",
            "Tube ID", "Plasmid No.", "SO", "_Work PO", "_Cloning Site",
        ]
        return sum(1 for c in informative_cols if row.get(c))
