"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.1
Date: Oct 13, 2026
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
- 'Add to table' renders picked constructs in the label table
  (tools/measurement_table.py, Shipping_labels column order);
  'Copy data' puts header + rows on the clipboard as tab-separated
  text for direct pasting into the Shipping_labels excel.
- The Work PO and cloning site are carried as internal '_'-prefixed
  columns for later/QC-file use, not printed on labels.
v1.1 canonicalizes the field names to the job-log naming: the old
  'SO' column is the In-house Progress SO (BBI SO# -> SO);
  Antibiotic -> Resistance, Plasmid ID -> Plasmid No., Length ->
  Length (bp). The Shipping_labels.xlsx paste headers follow Ed's
  hand-fixed workbook (the label printer layout is being updated
  to match).
"""

import os
import re
import threading

import customtkinter as ctk
from tkinter import filedialog, messagebox

from tools.measurement_table import MeasurementTable

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

PICKER_PLACEHOLDER = "(process files first)"

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


class SgRelabeling:
    """Reads Sg shipping lists, maps them to Shipping_labels columns, and
    collapses replicate/charge rows into one row per construct."""

    def __init__(self, app_instance):
        self.app = app_instance
        self.log = self.app.log

        self.shipping_files = []
        self.combined_df = None   # all identified constructs
        self.selected_rows = []   # rows picked via the SO - BBI ID menu
        self._parsing = False     # guards concurrent auto-parse runs

    # ------------------------------------------------------------------
    # UI
    # ------------------------------------------------------------------
    def create_ui(self, parent_frame):
        main_panel = ctk.CTkFrame(parent_frame, fg_color="transparent")
        main_panel.pack(fill="both", expand=True, padx=10, pady=6)

        # --- Shipping list files (compact: narrow field, buttons on the
        # right; adding a file triggers the auto-parse immediately) ---
        files_frame = ctk.CTkFrame(main_panel, fg_color="transparent")
        files_frame.pack(fill="x", pady=(2, 0))

        self.files_textbox = ctk.CTkTextbox(files_frame, height=120, wrap="word")
        self.files_textbox.pack(side="left", fill="y", expand=False, padx=(0, 10))
        # About one third of the app width; buttons sit on the right.
        try:
            self.files_textbox.configure(width=320)
        except Exception:
            pass
        self.files_textbox.configure(state="disabled")

        buttons_frame = ctk.CTkFrame(files_frame, fg_color="transparent")
        buttons_frame.pack(side="right")

        ctk.CTkButton(buttons_frame, text="Add...", command=self._add_shipping_files, width=120).pack(pady=(0, 5))
        ctk.CTkButton(buttons_frame, text="Clear", command=self._clear_shipping_files, width=120).pack()

        # --- SO - BBI ID multi-picker ---
        picker_frame = ctk.CTkFrame(main_panel, fg_color="transparent")
        picker_frame.pack(fill="x", pady=(8, 0))

        ctk.CTkLabel(
            picker_frame,
            text="Add Constructs (SO - BBI ID):",
            font=ctk.CTkFont(size=14, weight="bold"),
        ).pack(side="left", padx=(0, 8))

        self.picker_dropdown = ctk.CTkOptionMenu(
            picker_frame,
            values=[PICKER_PLACEHOLDER],
            command=self._on_option_menu_pick,
            width=430,
        )
        self.picker_dropdown.pack(side="left")
        self.picker_dropdown.set(PICKER_PLACEHOLDER)

        self.add_button = ctk.CTkButton(
            picker_frame, text="Add to table", command=self._add_selected_to_table, width=110
        )
        self.add_button.pack(side="left", padx=(8, 0))

        clear_pick_button = ctk.CTkButton(
            picker_frame, text="Clear table", command=self._clear_table, width=100
        )
        clear_pick_button.pack(side="left", padx=(8, 0))

        # --- Results table ---
        table_frame = ctk.CTkFrame(main_panel, fg_color="transparent")
        table_frame.pack(fill="both", expand=True, pady=(8, 0))

        table_header_frame = ctk.CTkFrame(table_frame, fg_color="transparent")
        table_header_frame.pack(fill="x")

        ctk.CTkLabel(
            table_header_frame,
            text="Label Rows (selected constructs):",
            font=ctk.CTkFont(size=14, weight="bold"),
        ).pack(side="left")

        ctk.CTkButton(
            table_header_frame,
            text="Copy data",
            command=self._copy_table,
            width=100,
        ).pack(side="right")

        # Inner frame so the table can expand with the panel.
        table_inner = ctk.CTkFrame(table_frame, fg_color="transparent")
        table_inner.pack(fill="both", expand=True)
        table_inner.grid_rowconfigure(0, weight=1)
        table_inner.grid_columnconfigure(0, weight=1)

        self.results_table = MeasurementTable(
            table_inner, columns=TABLE_COLUMNS, height=8, font_size=11
        )
        self.results_table.grid(row=0, column=0, sticky="nsew")

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
        added = []
        for filename in filenames:
            if filename and filename not in self.shipping_files:
                self.shipping_files.append(filename)
                added.append(filename)
        if added:
            self._update_files_display()
            self._auto_parse_async()

    def _clear_shipping_files(self):
        """Clears all selected files and resets the parsed state."""
        self.shipping_files = []
        self.combined_df = None
        self.picker_dropdown.configure(values=[PICKER_PLACEHOLDER])
        self.picker_dropdown.set(PICKER_PLACEHOLDER)
        self._picked_label = ""
        self._update_files_display()
        self._refresh_process_button_state()

    def _refresh_process_button_state(self):
        """The Process button enables whenever files are in the field
        (manual re-run/refresh); auto-parse runs right after Add."""
        try:
            self.app.process_button.configure(
                state="normal" if self.shipping_files else "disabled"
            )
        except Exception:
            pass

    # --- Auto-parse (files added => parse immediately) ---
    def _auto_parse(self, files=None):
        """Parses the given files (defaults to everything in the field) and
        rebuilds combined_df. Pure computation; runs on a worker thread;
        widget updates are scheduled back onto the main thread after."""
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

        new_df = None
        if all_rows:
            collapsed = self._dedupe_rows(all_rows)
            new_df = self._to_dataframe(collapsed)
            self.log(
                f"[SUMMARY] \t {len(all_rows)} raw construct row(s) -> "
                f"{len(new_df)} unique row(s) after replicate/charge collapse."
            )
            if failed_files:
                self.log(f"[WARNING] \t Files with no usable data: {', '.join(failed_files)}")
        else:
            self.log("[FINISHED] \t No construct rows identified. Nothing to do.")

        self.combined_df = new_df

    def _auto_parse_async(self, files=None):
        """Runs _auto_parse on a worker thread (one at a time) and settles
        the UI (picker + Process button) afterwards on the main thread.
        The file list is snapshotted by the CALLER (main thread) before the
        thread starts, so a race with app.start_processing can't read an
        empty list."""
        if self._parsing:
            self.log("[INFO] \t Already parsing - please wait.")
            return
        if files is None:
            files = list(self.shipping_files)
        if not files:
            self.log("[INFO] \t No files to parse.")
            return
        self._parsing = True
        try:
            self.app.process_button.configure(state="disabled")
        except Exception:
            pass

        def worker():
            try:
                self._auto_parse(files)
            finally:
                self._parsing = False
                try:
                    self.app.after(0, self._finalize_auto_parse)
                except Exception:
                    pass

        threading.Thread(target=worker, daemon=True).start()

    def _finalize_auto_parse(self):
        """Main-thread UI settle after the auto-parse worker finishes."""
        self._update_picker_dropdown_ui()
        try:
            self.app.process_button.configure(
                state="normal" if self.shipping_files else "disabled"
            )
        except Exception:
            pass

    # --- Construct picker helpers ---
    def _on_option_menu_pick(self, choice=None):
        """Stores the currently picked construct label (kept until 'Add to
        table' is pressed, so the pick survives the dropdown refreshing)."""
        self._picked_label = self.picker_dropdown.get()

    def _update_picker_dropdown_ui(self):
        """Main-thread dropdown refresh from self.combined_df."""
        df = self.combined_df
        empty = df is None or len(df) == 0
        if empty:
            self.picker_dropdown.configure(values=[PICKER_PLACEHOLDER])
            self.picker_dropdown.set(PICKER_PLACEHOLDER)
            return
        options = [
            f"{r['SO'] or '?'} - {r['BBI ID'] or '?'}"
            for _, r in df.iterrows()
        ]
        self.picker_dropdown.configure(values=options)
        self.picker_dropdown.set(PICKER_PLACEHOLDER)

    def _add_selected_to_table(self):
        """Adds the construct picked in the dropdown to the results table.
        Multi-add: call repeatedly; each construct lands at most once."""
        label = getattr(self, "_picked_label", "")
        if not label or label.startswith("("):
            self.log("[INFO] \t Pick a construct (SO - BBI ID) first.")
            return
        so, bbi_id = self._parse_pick(label)
        row = self._find_construct(so, bbi_id)
        if row is None:
            self.log(f"[WARNING] \t Construct not found in processed data: {label}")
            return
        key = (row["SO"], row["BBI ID"])
        if key in self._selected_keys():
            self.log(f"[INFO] \t Already in the table: {label}")
            return
        self.selected_rows.append(dict(row))
        self._refresh_table()
        self.log(f"[OK] \t Added to label table: {label}")

    def _clear_table(self):
        """Removes every row from the results table."""
        self.selected_rows = []
        self._refresh_table()
        self.log("[INFO] \t Label table cleared.")

    @staticmethod
    def _parse_pick(label: str) -> tuple:
        """Splits 'SO - BBI ID' back into its two fields (BBI IDs may contain
        dashes, so only the first ' - ' separates them)."""
        so, _, bbi_id = label.partition(" - ")
        return so.strip(), bbi_id.strip()

    def _find_construct(self, so: str, bbi_id: str):
        """Locates a processed construct by (SO, BBI ID)."""
        if self.combined_df is None:
            return None
        for _, r in self.combined_df.iterrows():
            if r["SO"] == so and r["BBI ID"] == bbi_id:
                return r
        return None

    def _selected_keys(self):
        return [(r["SO"], r["BBI ID"]) for r in self.selected_rows]

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
        """Puts the full label table (header + rows) on the clipboard."""
        self.results_table.copy_all_rows()
        n = len(self.selected_rows)
        if n:
            self.log(f"[OK] \t Copied {n} label row(s) to the clipboard - "
                     f"paste into the Shipping_labels excel as-is.")
        else:
            self.log("[INFO] \t Label table is empty.")

    # ------------------------------------------------------------------
    # App contract
    # ------------------------------------------------------------------
    def validate_inputs(self) -> bool:
        if not self.shipping_files:
            messagebox.showerror("Error", "No shipping list files selected.")
            return False
        missing = [f for f in self.shipping_files if not os.path.isfile(f)]
        if missing:
            messagebox.showerror("Error", "Files not found:\n" + "\n".join(missing))
            return False
        return True

    def setup_default_paths(self):
        # No default paths yet; the multi-select files list starts empty.
        pass

    # ------------------------------------------------------------------
    # Processing
    # ------------------------------------------------------------------
    def run_processing_task(self, files=None):
        """The shared Process button re-runs the parse (e.g. after editing
        a file); the auto-parse after Add uses the same pipeline. The shell
        calls this on a worker thread, so the file list MUST be snapshotted
        here (this method runs first on the new thread) - an implicit
        self.shipping_files read can race an in-flight Clear and parse
        nothing."""
        self._auto_parse_async(files=files)

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
        import xlrd  # noqa: F401  (.xls engine; imported here so a missing
                      # dependency surfaces as a per-file log error)

        raw = pd.read_excel(path, sheet_name=0, header=None, dtype=object)
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

        so_series = grab(-7)        # BBI SO# -> SO
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
        bbi_vals = [_norm(v) for v in bbi_po_series]
        bbi_ok = sum(1 for s in bbi_vals if s and not TUBE_ID_PATTERN.match(s))
        if bbi_ok < 0.9 * n_rows:
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

        # --- Skip the Sg header row if present (non-numeric where SO should be) ---
        start = 0
        if not SO_PATTERN.match(_norm(so_series.iloc[0])):
            start = 1
            self.log("[INFO] \t Skipped the Sg header row.")

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
        clear error when the Sg layout has drifted."""
        vals = [_norm(v) for v in series]
        hits = sum(1 for v in vals if v and pattern.match(v))
        n = len(vals)
        if hits < max(1, int(min_frac * n)):
            raise ValueError(
                f"Column check failed for '{label}': "
                f"only {hits}/{n} values match the expected format."
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

    def _to_dataframe(self, rows: list):
        import pandas as pd

        record_cols = LABEL_COLUMNS + ["_Work PO", "_Cloning Site", "_Source File"]
        df = pd.DataFrame(rows, columns=record_cols)
        return df