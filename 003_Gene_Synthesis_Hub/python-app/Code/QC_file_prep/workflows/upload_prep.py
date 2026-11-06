"""Upload Prep — QC File Prep subapp workflow.

Prepares QC zip files for website upload: reads the Master Shipping Log sheet
of the In-House Progress workbook, groups rows by Shipment Date (newest first,
default latest), lets the user review/exclude rows in a click-check table,
then organizes the QC zips under Desktop\\QC_to_upload by upload method:

Scenario types — FOUR overall separations, each in a Tubes (T) or Plate
(P) flavor; the row's Tubes cell chooses the flavor ("plate" -> P):

  S1T / S1P — In House: QC Folder == 'In House' AND Tube ID NOT
             starting with 'P'. step 1: COPY from '3.6.5 QC files
             received' into <email>\\ ; plate rows go one level deeper
             into <email>\\Plates\\<BBI ID root>\\
  S2T / S2P — Sg Other: Tube ID starts with 'P' AND QC Folder parses
             as a date AND BBI ID has no BATCH token. COPY from
             4.6\\<YYYYMMDD>\\OTHER\\ into <email>\\ (+ the Plates layer
             for plate rows).
  S3T / S3P — BATCH-E: Tube ID starts with 'P' AND QC Folder parses
             as a date AND BBI ID contains 'BATCH-E'. COPY from
             4.6\\<YYYYMMDD>\\BATCH\\ (BATCH-E always ships via BATCH)
             into <email>\\ (+ the Plates layer for plate rows).
  S4T / S4P — BATCH: BBI ID contains 'BATCH '. ZIP source: when the
             QC Folder parses as a date, COPY from 4.6\\<YYYYMMDD>\\BATCH\\;
             when it reads 'In House', COPY from '3.6.5 QC files
             received'. Target = QC_to_upload\\<YYYYMMDD of the row's
             shipment date>\\ (a DATE code, not an email folder) with
             the Plates\\<BBI ID root>\\ layer for plate rows.

Every plate row (any type) gets a Plates folder holding the BBI ID root
folder (the BBI ID split on its first dash); non-BATCH targets root at
the customer email folder, BATCH at the date-code folder.

Match rule (every scenario): the filename must contain TWO substrings — the
row's BBI ID and the row's stripped Tube ID. Nothing else about the name
matters (' in '/Vector/date tokens are never anchors: third-party fragment
zips omit the ' in {Vector}' part and zip dates are prep dates).

The rows are checked LIVE: selecting a date fills the table (no Gene Name
column; the Scenario column carries the new type names + a Zip Status
column) and a background check resolves folder/zip per row AS the table
shows: rows refresh one by one, green = zip found, yellow = zip/folder
problem, amber = row fits no scenario; the user's unchecking stays live
(the run plan mirrors the visible checks).

Processing: the checked rows are re-screened by the same per-row resolver
the table used, and the ready plan EXECUTES IMMEDIATELY — no popup (the
table's live green/yellow already told Ed what is and isn't there);
problem rows are only logged, never touched, and the disk is left alone
for them. The progress bar tracks the EXECUTION (step 1 copies, step 2
archives); the fast screening reports none.

Move scenarios run in TWO steps: first COPY + distribute into
QC_to_upload, then the '3.6.5 QC files received' originals move to the
sibling archive '\\3.6.6 QC files uploaded\\<YYYY>\\' (YYYY = the row's
shipment-date year). Target-collision rows copy nothing and are NOT
archived (original stays in 3.6.5, logged loudly). Log messages that
are separate facts get their own line; related parts share one line.

Full spec: agent task folder Tasks/Ongoing/Upload_prep/Upload_prep_spec.md.

Changes in v1.1 (from v1.0):
  - The pre-run popup is gone: the review table's live zip check
    (green/yellow/amber) shows what is and isn't there, unchecking
    updates the run plan in place, and Process executes right away.
  - Move-class sources run in TWO steps: copy + distribute into
    QC_to_upload, then the originals archive to
    '3.6.6 QC files uploaded\\<YYYY>\\' (YYYY = shipment year).
  - Scenario types flattened to S1 In House / S2 Sg Other / S3 BATCH-E /
    S4 BATCH, each Tubes (T) or Plate (P) by the row's Tubes cell;
    every plate row routes into Plates\\<BBI ID root>\\ under its base.
  - Zip matching hardened: cells normalize before any read (NaN/blank
    rows dropped at the stage-1 filter, missing anchors reported
    instead of searched) and anchors match at name boundaries, so a
    prefix-sibling BBI can no longer claim a neighbor's file.
  - Re-scan fails closed: plan/table/Process clear while the workbook
    reloads; the progress bar tracks execution, not screening.
  - Date picker sits in the file row and appears only after validation
    + load succeed; Gene Name column replaced by Zip Status.

Version: 1.1
Date: Nov 3, 2026
"""

import os
import re
import shutil
import threading
from datetime import date, datetime, timedelta

import customtkinter as ctk
from tkinter import ttk

CHECK = "✓"

# Light-green row background for 'ready' rows in the review table.
READY_GREEN = "#DFF0D8"

# Soft yellow row background for rows whose live zip check found a problem.
ISSUE_YELLOW = "#FFF3C4"

# Valid Customer Email (ported verbatim from Gene_email_system/system/core.py)
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")

MASTER_SHEET = "Master Shipping Log"

# Canonical column spellings resolved by name first; fallback positions
# (A, B, C, D, J, K, L, M, N, O) apply only when the header row does not
# match (2-step column pattern; which path fired is logged).
CANON_COLS = {
    "Shipment Date": 0, "SO": 1, "BBI ID": 2, "Gene Name": 3,
    "Tube ID": 9, "Tubes": 11, "QC Folder": 13, "Customer Email": 14,
}
FALLBACK_ROW_CAP = 50000  # sheet dimensions are inflated; cap the read

# How many of the newest shipment dates the picker offers
# (email-system parity is 5).
MAX_DATES = 5


def _cell_text(value):
    """Excel cell -> clean text: None and NaN become '' (str(nan) bypasses
    placeholder checks — normalize EVERY field before it is read)."""
    if value is None:
        return ""
    if isinstance(value, float) and value != value:  # NaN
        return ""
    return str(value).strip()


def _cell_raw(value):
    """Cell kept for value-based logic (QC Folder dates / 'In House'):
    None and NaN become None; anything else passes through."""
    if value is None or (isinstance(value, float) and value != value):
        return None
    return value


def _norm_qc_date(value):
    """QC Folder cell -> datetime.date, or None.

    Handles datetime/date cells, 'YYYY-MM-DD' / 'YYYY/MM/DD' strings, and
    Excel serial numbers (proposed default: 20000-60000 = 1954..2064).
    """
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)):
        if 20000 <= value <= 60000:
            try:
                return date(1899, 12, 30) + timedelta(days=int(value))
            except (ValueError, OverflowError):
                return None
        return None
    if isinstance(value, str):
        text = value.strip()
        for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
            try:
                return datetime.strptime(text, fmt).date()
            except ValueError:
                pass
    return None


def _is_in_house(value):
    """QC Folder 'In House' (proposed default: case/space/hyphen-insensitive —
    the live sheet also carries 'In-house' rows)."""
    return (isinstance(value, str)
            and value.strip().lower().replace(" ", "").replace("-", "") == "inhouse")


def _stripped_tube(tube_id):
    """Tube ID minus the leading letter ('U100709'/'P1203438' -> '100709')."""
    return tube_id[1:] if tube_id else ""


def _plate_base(bbi_id):
    """Plates subfolder name: BBI ID stripped on the FIRST dash from the left
    ('BATCH 2882-170' -> 'BATCH 2882'; a plain 'BATCH 2853' stays verbatim)."""
    return bbi_id.split("-", 1)[0]


def _plate_flag(rec):
    """Is a row a PLATE row (its Tubes cell reads 'plate')? The T/P flavor
    suffix rides every scenario id (S1T/S1P ... S4T/S4P)."""
    return (rec.get("tubes") or "").strip().lower() == "plate"


SCENARIO_NAMES = {"S1": "In House", "S2": "Sg Other", "S3": "BATCH-E",
                  "S4": "BATCH"}


def name_for_entry(sid):
    """'S1T' -> 'S1T - In House' — the short display type for entries/logs."""
    if sid[:2] in SCENARIO_NAMES:
        return f"{sid} - {SCENARIO_NAMES[sid[:2]]}"
    return sid


def _list_sheet_names(path):
    """Workbook sheet catalog (cheap read; the VALIDATION step of the
    rescan = the file exists + the Master Shipping Log sheet is found)."""
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True)
    names = list(wb.sheetnames)
    wb.close()
    return names


def _qcf_display(value):
    """QC Folder cell as shown in the table (dates normalized, else verbatim)."""
    d = _norm_qc_date(value)
    if d is not None:
        return d.isoformat()
    return "" if value is None else str(value).strip()


def _row_tag(rec):
    """Row identity prefix for problem/log lines (BBI ID + Tube ID)."""
    tube = (rec.get("tube") or "").strip()
    return f"{rec['bbi']} (Tube {tube if tube else '—'})"


def _config_tree_style(style, style_name, font_size=9):
    """ONE treeview look for every Upload Prep table (main review table +
    review table): 9pt text, 24px rows, 6/4-padded
    headers — the tables read the same everywhere."""
    style.configure(style_name, background="#FDFDFB",
                    foreground="#33403A", fieldbackground="#FDFDFB",
                    rowheight=24, font=("Segoe UI", font_size))
    style.configure(f"{style_name}.Heading",
                    font=("Segoe UI", font_size, "bold"),
                    padding=(6, 4), background="#D3CFE0",
                    foreground="#2E2A44")
    style.map(f"{style_name}.Heading", background=[("active", "#C9C4D8")])
    style.map(style_name, background=[("selected", "#C9C4D8")],
              foreground=[("selected", "#2E2A44")])


class UploadPrepTable(ctk.CTkFrame):
    """ttk.Treeview review table in a CTk frame — ported from the Gene Email
    System's EmailTable (shipment_tracking.py): click col #1 toggles the
    include check, zebra rows, dim/skip row tags, Ctrl+C copies as TSV."""

    TAG_COLORS = {"skip": "#976217", "dim": "#9AA69C"}

    def __init__(self, master, columns, height=8, font_size=9,
                 on_toggle=None):
        super().__init__(master, fg_color="#ffffff", corner_radius=0,
                         width=1, height=1)
        self.columns = columns
        self.on_toggle = on_toggle
        table_style = f"UPP{font_size}.Treeview"

        style = ttk.Style(self)
        _config_tree_style(style, table_style, font_size=font_size)

        self.grid_rowconfigure(0, weight=1)
        self.grid_columnconfigure(0, weight=1)
        self.grid_propagate(False)

        self.tree = ttk.Treeview(self, columns=[c[0] for c in columns],
                                 show="headings", style=table_style,
                                 height=height, selectmode="extended")
        for title, width, anchor in columns:
            self.tree.heading(title, text=title, anchor=anchor)
            self.tree.column(title, width=width, minwidth=40, anchor=anchor,
                             stretch=True)

        for tag, color in self.TAG_COLORS.items():
            self.tree.tag_configure(tag, foreground=color)
        self.tree.tag_configure("zipok", background=READY_GREEN)
        self.tree.tag_configure("zipbad", background=ISSUE_YELLOW)

        vbar = ttk.Scrollbar(self, orient="vertical", command=self.tree.yview)
        hbar = ttk.Scrollbar(self, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=vbar.set, xscrollcommand=hbar.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        vbar.grid(row=0, column=1, sticky="ns")
        hbar.grid(row=1, column=0, sticky="ew")

        self.tree.bind("<Control-c>", self.copy_rows)
        self.tree.bind("<Button-1>", self._on_click)

    def _on_click(self, event):
        """Click in the first column toggles the include state; skipped rows
        are fixed; clicks elsewhere keep normal Treeview behaviour."""
        if self.tree.identify("region", event.x, event.y) != "cell":
            return None
        if self.tree.identify_column(event.x) != "#1":
            return None
        item = self.tree.identify_row(event.y)
        if not item:
            return None
        if "skip" in self.tree.item(item, "tags"):
            return None
        self.toggle_check(item)
        return "break"

    def toggle_check(self, item):
        values = list(self.tree.item(item, "values"))
        values[0] = "" if values[0] == CHECK else CHECK
        self.tree.item(item, values=values)
        if self.on_toggle:
            self.on_toggle(self.tree.index(item), values[0] == CHECK)

    def set_rows(self, rows, skip_indices=()):
        """rows: tuples whose FIRST cell is CHECK or '' and whose LAST cell
        is the scenario/status text."""
        self.tree.delete(*self.tree.get_children())
        skip_set = set(skip_indices)
        for i, cells in enumerate(rows):
            tags = []
            if i in skip_set:
                tags.append("skip")
            elif cells[0] != CHECK:
                tags.append("dim")
            # rows start WHITE: the live check colors them (green/yellow)
            # almost immediately — no zebra stripe to fight the fill.
            self.tree.insert("", "end", values=tuple(cells), tags=tags)

    def set_zip_state(self, index, text, found):
        """Live zip-check update for one row: rewrites the Zip Status cell
        and colors the row green (found) / yellow (problem). The color tag
        goes FIRST — the first tag in an item's tag list wins the
        background, so the fill always applies over any other tag."""
        children = self.tree.get_children()
        if not 0 <= index < len(children):
            return
        item = children[index]
        values = list(self.tree.item(item, "values"))
        values[-1] = text
        tags = [t for t in (self.tree.item(item, "tags") or [])
                if t not in ("zipok", "zipbad")]
        tags.insert(0, "zipok" if found else "zipbad")
        self.tree.item(item, values=tuple(values), tags=tags)

    def copy_rows(self, event=None):
        import csv
        from io import StringIO
        titles = [c[0] for c in self.columns]
        selected = self.tree.selection()
        items = selected or self.tree.get_children()
        buf = StringIO()
        writer = csv.writer(buf, delimiter="\t", lineterminator="\n")
        writer.writerow(titles)
        for item in items:
            writer.writerow(self.tree.item(item, "values"))
        self.clipboard_clear()
        self.clipboard_append(buf.getvalue())
        return "break"


class UploadPrep:
    """Workflow class: 'Upload Prep'."""

    # No 'Folder with Zips' input: the workbook path + date dropdown drive
    # everything; the app hides the folder widget for this workflow.
    NEEDS_INPUT_FOLDER = False

    # The review table needs more room than the shell's default 180px
    # workflow strip: the shell (v2.6) sizes its workflow container + window
    # from this attribute on workflow switch (QC_file_prep_app.py).
    PANEL_HEIGHT = 380

    # Shared logbox pinned small for this workflow so the review table keeps
    # most of the available area (the shell keeps the log's scrollbar; the
    # full run history still scrolls inside 140px).
    LOG_HEIGHT = 140

    TABLE_COLUMNS = [
        ("Include", 54, "center"),
        ("BBI ID", 130, "w"),
        ("Tube ID", 90, "w"),
        ("Tubes", 52, "center"),
        ("QC Folder", 100, "w"),
        ("Customer Email", 190, "w"),
        ("Scenario", 150, "w"),
        ("Zip Status", 110, "w"),
    ]

    def __init__(self, app_instance):
        self.app = app_instance
        self.log = self.app.log
        self._rows_by_date = {}   # date str -> [row-dict, ...] (parse output)
        self._dates = []          # newest-first, MAX_DATES kept
        # Plain-dict snapshot the worker thread reads (never a widget):
        # {"date": str|None, "checked": set[int], "rows": [row-dict,...]}
        self._current_plan = {"date": None, "checked": set(), "rows": []}
        self._parsing = False

    # ------------------------------------------------------------------ UI --
    def create_ui(self, parent_frame):
        main_panel = ctk.CTkFrame(parent_frame, fg_color="transparent")
        main_panel.pack(fill="both", expand=True, padx=10, pady=(10, 4))

        # ONE input row: workbook path (title above, entry elastic) on the
        # left; on the RIGHT the far-right spot swaps: the validation label
        # while nothing is parsed, then (once the sheet loading + dataframe
        # prep finished) the 'Shipment Date:' title + dropdown take it.
        file_row = ctk.CTkFrame(main_panel, fg_color="transparent")
        file_row.pack(fill="x", pady=(2, 0))
        file_row.columnconfigure(0, weight=1)

        wb_title = ctk.CTkLabel(
            file_row,
            text="In House Progress excel - Master Shipping Log worksheet",
            font=ctk.CTkFont(size=13, weight="bold"))
        wb_title.grid(row=0, column=0, sticky="w")
        wb_box = ctk.CTkFrame(file_row, fg_color="transparent")
        wb_box.grid(row=1, column=0, sticky="ew")
        self.file_entry = ctk.CTkEntry(wb_box, width=330,
                                       placeholder_text="path to the workbook")
        self.file_entry.pack(side="left", padx=(0, 6))
        self.browse_btn = ctk.CTkButton(wb_box, text="Browse", width=90,
                                        command=self._browse)
        self.browse_btn.pack(side="left")
        self.rescan_btn = ctk.CTkButton(wb_box, text="Re-scan", width=90,
                                        command=self._rescan)
        self.rescan_btn.pack(side="left", padx=(6, 0))

        self.date_title = ctk.CTkLabel(
            file_row, text="Shipment Date:",
            font=ctk.CTkFont(size=13, weight="bold"))
        self.date_title.grid(row=0, column=1, sticky="e", padx=(10, 0))
        right_box = ctk.CTkFrame(file_row, fg_color="transparent")
        right_box.grid(row=1, column=1, sticky="e", padx=(10, 0))
        self.file_validation = ctk.CTkLabel(right_box, text="", anchor="e",
                                            text_color="gray")
        self.file_validation.pack(fill="x")
        self.date_box = ctk.CTkFrame(right_box, fg_color="transparent")
        self.date_menu = ctk.CTkOptionMenu(
            self.date_box, width=170, values=["—"], state="disabled",
            command=lambda _v: self.on_date_change(), dynamic_resizing=False)
        self.date_menu.pack(side="left")
        self._set_date_picker_visible(False)

        self.table = UploadPrepTable(main_panel, self.TABLE_COLUMNS, height=6,
                                     on_toggle=self._on_row_toggle)
        self.table.pack(fill="both", expand=True, pady=(6, 2))

        # Execution progress bar (tracks the accepted plan's real copy +
        # archive work; _release_button resets): at the bottom, at the
        # Process-button end. Idle it reads as a hairline.
        self.progress = ctk.CTkProgressBar(main_panel, height=8)
        self.progress.pack(fill="x", pady=(4, 0))
        self.progress.set(0)

        self._refresh_table([])

    def _set_date_picker_visible(self, visible):
        """Right-side swap: while the date picker is up, the validation
        label is removed and the 'Shipment Date:' title + dropdown own the
        far-right spot; hiding restores the validation label (its text is
        whatever the last validation left)."""
        if visible:
            self.file_validation.pack_forget()
            self.date_title.grid()
            self.date_box.pack()
        else:
            self.date_title.grid_remove()
            self.date_box.pack_forget()
            self.file_validation.pack(fill="x")

    # ---------------------------------------------------------- validation --
    def _set_validation(self, ok, message):
        """Entry border + result text, Ligation-layout style: dark-green 2px
        border + '✔ Validated' when the checks pass, red 2px border + '✖
        <specific reason>' when not, neutral + empty when idle. Nothing
        transient is ever said (no 'checking ...' / 'loading ...' texts)."""
        self.file_validation.pack(fill="x")
        if ok is True:
            self.file_entry.configure(border_color="dark green",
                                      border_width=2)
            self.file_validation.configure(text=f"✔ {message}",
                                           text_color="green")
        elif ok is False:
            self.file_entry.configure(border_color="#D32F2F", border_width=2)
            self.file_validation.configure(text=f"✖ {message}",
                                           text_color="#D32F2F")
        else:
            self.file_entry.configure(
                border_width=1,
                border_color=ctk.ThemeManager.theme["CTkEntry"]["border_color"])
            self.file_validation.configure(text=message, text_color="gray")

    def _browse(self):
        from tkinter import filedialog
        initial = os.path.dirname(self.file_entry.get().strip()) \
            if self.file_entry.get().strip() else os.path.expanduser("~")
        path = filedialog.askopenfilename(
            title="Select the In-House Progress workbook",
            filetypes=[("Excel workbook", "*.xlsx *.xlsm")],
            initialdir=initial)
        if path:
            self.file_entry.delete(0, "end")
            self.file_entry.insert(0, path)
            self._rescan()

    # ------------------------------------------------------------ parsing --
    def _resolve_columns(self, df):
        """2-step column pattern: canonical header spellings first, historic
        positions as fallback. Returns {canon: 0-based value index}; logs
        which path fired."""
        named = {}
        cols = list(df.columns)
        for canon in CANON_COLS:
            for col_label in cols:
                if isinstance(col_label, str) and col_label.strip() == canon:
                    named[canon] = cols.index(col_label)
                    break
        if len(named) == len(CANON_COLS):
            self.log("[OK] \t Columns resolved by name (Shipment Date, SO, "
                     "BBI ID, Gene Name, Tube ID, Tubes, QC Folder, "
                     "Customer Email).")
            return named
        missing = [c for c in CANON_COLS if c not in named]
        self.log("[WARNING] \t Header row not recognized (missing: "
                 + ", ".join(missing) + ") — falling back to fixed positions "
                 "(A, B, C, D, J, K, L, N, O).")
        return dict(CANON_COLS)

    def _parse_log(self, path):
        """Read the Master Shipping Log sheet -> {date-str: [row-dict, ...]}.

        Stage-1 filter (email-system parity): rows whose Shipment Date, SO,
        BBI ID and Gene Name are all filled; everything else is a
        placeholder/formula-tail row and is dropped.
        """
        import pandas as pd

        df = pd.read_excel(path, sheet_name=MASTER_SHEET, dtype=object,
                           engine="openpyxl", nrows=FALLBACK_ROW_CAP)
        idx = self._resolve_columns(df)
        rows_by_date = {}
        for values in df.itertuples(index=False, name=None):
            rec = {canon: values[pos] if pos < len(values) else None
                   for canon, pos in idx.items()}
            # NaN/blank cells normalize to '' — the plain str(nan) read
            # would otherwise slip placeholder rows through stage-1.
            texts = {canon: _cell_text(v) for canon, v in rec.items()}
            if not all(texts[c] for c in ("Shipment Date", "SO",
                                          "BBI ID", "Gene Name")):
                continue
            d = _norm_qc_date(_cell_raw(rec["Shipment Date"]))
            if d is None:
                continue
            rows_by_date.setdefault(d.isoformat(), []).append({
                "date": d.isoformat(),
                "bbi": texts["BBI ID"],
                "gene": texts["Gene Name"],
                "tube": texts["Tube ID"],
                "tubes": texts["Tubes"],
                "qcf": _cell_raw(rec["QC Folder"]),
                "email": texts["Customer Email"],
            })
        return rows_by_date

    def _rescan(self):
        """Two-stage read, on one worker thread: (1) VALIDATION = the file
        exists and the 'Master Shipping Log' sheet is found -> '✔
        Validated'; (2) the sheet loading + dataframe prep — nothing is
        said during it, and on success the validated label is REPLACED by
        the date picker (the far-right spot). Fail-closed: the previous
        date's plan/table/Process gate are cleared the moment a re-scan
        starts — no run can race a reload with stale rows."""
        if self._parsing:
            return
        self._current_plan = {"date": None, "checked": set(), "rows": []}
        self._live_gen = getattr(self, "_live_gen", 0) + 1
        self.table.set_rows([])
        self.app.process_button.configure(state="disabled")
        path = self.file_entry.get().strip()
        if not path or not os.path.isfile(path):
            self.log("[ERROR] \t Workbook not found: " + (path or "(none set)"))
            self._set_validation(False,
                                 "File not found: " + (path or "(none set)"))
            return
        self._parsing = True
        self._set_validation(None, "")
        self._set_date_picker_visible(False)
        self.log("")
        self.log(f"[INFO] \t Reading {path} ...")

        def worker():
            try:
                sheets = _list_sheet_names(path)
                if MASTER_SHEET not in sheets:
                    err = (f"no '{MASTER_SHEET}' sheet in this workbook "
                           f"(sheets: {', '.join(sheets[:6])}"
                           + (", ..." if len(sheets) > 6 else "") + ")")
                    self.app.after(0, self._validation_failed, err)
                    return
                self.app.after(0, self._sheet_found)
                rows_by_date = self._parse_log(path)
                self.app.after(0, self._parse_done, rows_by_date)
            except Exception as exc:
                err = f"{exc.__class__.__name__}: {exc}"
                self.app.after(0, self._parse_failed, err)

        threading.Thread(target=worker, daemon=True).start()

    def _sheet_found(self):
        """Validation passed (file + sheet): '✔ Validated' + green border,
        Ligation-layout exact; the mark stays until the parse finishes and
        the date picker takes the far-right spot."""
        self._set_validation(True, "Validated")

    def _validation_failed(self, err):
        self._parsing = False
        self.log(f"[ERROR] \t {err}")
        self._set_date_picker_visible(False)
        self._set_validation(False, err)
        self._current_plan = {"date": None, "checked": set(), "rows": []}
        self.table.set_rows([])
        self.app.process_button.configure(state="disabled")

    def _parse_done(self, rows_by_date):
        self._parsing = False
        self._rows_by_date = rows_by_date
        self._dates = sorted(rows_by_date, reverse=True)[:MAX_DATES]
        total = sum(len(v) for v in rows_by_date.values())
        if not self._dates:
            self._set_date_picker_visible(False)
            self._set_validation(False, "no dated shipment rows in the sheet")
            self.date_menu.configure(values=["—"], state="disabled")
            self.date_menu.set("—")
            self._current_plan = {"date": None, "checked": set(), "rows": []}
            self.table.set_rows([])
            self.app.process_button.configure(state="disabled")
            return
        # Dataframe prep finished -> the date picker takes the far-right
        # spot (the validated label is swapped out by the reveal; the entry
        # border keeps its validated green).
        self._set_date_picker_visible(True)
        self.log(f"[OK] \t {total} shipment rows · {len(rows_by_date)} dates "
                 f"found (showing {len(self._dates)} newest): "
                 f"{', '.join(self._dates)}")
        self.date_menu.configure(values=self._dates, state="normal")
        self.date_menu.set(self._dates[0])
        self.on_date_change()

    def _parse_failed(self, err):
        self._parsing = False
        self._set_date_picker_visible(False)
        self._set_validation(False, f"Sheet load failed — {err[:70]}")
        self.log("[ERROR] \t " + err)
        self._current_plan = {"date": None, "checked": set(), "rows": []}
        self.table.set_rows([])
        self.app.process_button.configure(state="disabled")

    # ------------------------------------------------------ classification --
    def _classify(self, rec):
        """row dict -> (scenario id, source-kind, display name).

        Scenario ids: S1T/S1P In House, S2T/S2P Sg Other, S3T/S3P BATCH-E,
        S4T/S4P BATCH; the T/P suffix (the row's Tubes cell reading
        'plate') is ORTHOGONAL to the type. source-kind:
        'received' | ('ship', 'OTHER'|'BATCH') | None. Checks cascade in
        this order: BATCH (BBI, overrides everything) > P-tube + date
        (BATCH-E, else Sg Other) > In House (U-tube) > unmatched.
        """
        suffix = "P" if _plate_flag(rec) else "T"
        bbi, tube, qcf = rec["bbi"], rec["tube"], rec["qcf"]
        if "BATCH " in bbi:
            if _norm_qc_date(qcf) is not None:
                return (f"S4{suffix}", ("ship", "BATCH"), f"S4{suffix} - BATCH")
            if _is_in_house(qcf):
                return (f"S4{suffix}", "received", f"S4{suffix} - BATCH")
            return (None, None, f"unmatched: S4 - BATCH: BBI '{bbi}' + QC "
                    f"Folder '{_qcf_display(qcf)}' is neither a 4.6 date "
                    "nor 'In House' — no source rule for it")
        if tube.startswith("P") and _norm_qc_date(qcf) is not None:
            if "BATCH-E" in bbi:
                return (f"S3{suffix}", ("ship", "BATCH"), f"S3{suffix} - BATCH-E")
            return (f"S2{suffix}", ("ship", "OTHER"), f"S2{suffix} - Sg Other")
        if _is_in_house(qcf) and not tube.startswith("P"):
            return (f"S1{suffix}", "received", f"S1{suffix} - In House")
        return (None, None, "unmatched: Tube '" + (tube[:1] or "?") + "' + "
                f"QC Folder '{_qcf_display(qcf)}' fits no type — S1 needs "
                "'In House' + U-Tube, S2/S3 need P-Tube + a 4.6 date")

    def _target_dir(self, rec, scenario):
        """QC_to_upload target folder for a row (spec §4): S4 roots at the
        row's shipment-date code, S1/S2/S3 at the customer email folder;
        every plate row adds the Plates\\<BBI ID root>\\ layer."""
        root = self._output_root()
        if scenario.startswith("S4"):
            base = os.path.join(root, rec["date"].replace("-", ""))
        else:
            base = os.path.join(root, rec["email"].strip())
        if _plate_flag(rec):
            return os.path.join(base, "Plates", _plate_base(rec["bbi"]))
        return base

    def _output_root(self):
        return os.path.join(os.path.expanduser("~"), "Desktop", "QC_to_upload")

    def _source_dir(self, rec, source_kind, ship_root, qc_dir):
        if source_kind == "received":
            return qc_dir
        if not ship_root:
            return ""
        folder = _norm_qc_date(rec["qcf"]).strftime("%Y%m%d")
        return os.path.join(ship_root, folder, source_kind[1])

    # ------------------------------------------------------- table refresh --
    def on_date_change(self):
        rows = self._rows_by_date.get(self.date_menu.get(), [])
        self._refresh_table(rows)

    def _refresh_table(self, rows):
        """Feed the table for the selected date: eligible rows start checked,
        unmatched rows start blank + amber. Snapshots the plan the worker
        thread will read (main thread only) and STARTS the live zip check
        for the shown rows (green/yellow updates arrive one by one)."""
        display = []
        skip = []
        checked = set()
        for i, rec in enumerate(rows):
            _sid, _src, name = self._classify(rec)
            if _sid is None:
                display.append(("", rec["bbi"], rec["tube"],
                                rec["tubes"], _qcf_display(rec["qcf"]),
                                rec["email"], name, ""))
                skip.append(i)
                continue
            checked.add(i)
            status = name
            if not _sid.startswith("S4") and not EMAIL_RE.match(rec["email"]):
                status += " (no Customer Email)"
            display.append((CHECK, rec["bbi"], rec["tube"],
                            rec["tubes"], _qcf_display(rec["qcf"]),
                            rec["email"], status, ""))
        self.table.set_rows(display, skip_indices=skip)
        date_str = None
        if hasattr(self, "date_menu"):
            date_str = self.date_menu.get() or None
        self._current_plan = {"date": date_str, "checked": checked,
                              "rows": list(rows)}
        self.app.process_button.configure(
            state="normal" if (rows and checked) else "disabled")
        if rows:
            self._start_live_check(rows)

    # --------------------------------------------------- live zip check --
    def _start_live_check(self, rows):
        """Background folder/zip resolution for the shown rows — each row's
        Zip Status fills in as it resolves (green = found, yellow =
        problem). A generation counter drops completions of a superseded
        check (new date, re-scan) so an old check never writes into the
        new table."""
        self._live_gen = getattr(self, "_live_gen", 0) + 1
        gen = self._live_gen
        threading.Thread(target=self._live_zip_check, args=(rows, gen),
                         daemon=True).start()

    def _live_zip_check(self, rows, gen):
        """Worker body: resolve the sources once, then per row resolve
        classify + source + zip and schedule the row's update."""
        qc_dir, ship_root, setup_problems = self._resolve_sources()
        if setup_problems:
            self.app.after(0, self._log_setup_problems, setup_problems)
        for i, rec in enumerate(rows):
            state = self._check_row(rec, qc_dir, ship_root)
            self.app.after(0, self._apply_row_state, gen, i, state)

    def _log_setup_problems(self, setup_problems):
        """The run-level source problems, logged once per check (main
        thread) — every matched row also points at them individually."""
        for text in setup_problems:
            self.log(f"[ERROR] \t {text}")

    def _apply_row_state(self, gen, index, state):
        """Lands one row's live-check result on the table (main thread)."""
        if gen != getattr(self, "_live_gen", None):
            return  # a newer date/re-scan superseded this completion
        ready = state["kind"] == "ready"
        self.table.set_zip_state(index, state["short"], ready)

    def _on_row_toggle(self, row_index, now_checked):
        """Table include/exclude callback (main thread): keeps the run plan
        the worker reads in sync with the visible checks (the old plan was
        snapshotted only at refresh, so unchecked rows still ran), and
        re-evaluates the Process gate."""
        plan = self._current_plan
        checked = set(plan["checked"])
        if now_checked:
            checked.add(row_index)
        else:
            checked.discard(row_index)
        plan["checked"] = checked
        self.app.process_button.configure(
            state="normal" if (plan["rows"] and checked) else "disabled")

    # ------------------------------------------------------------ defaults --
    def setup_default_paths(self):
        wb = self.app.hub_paths.get("Job_Log")
        if not wb or not os.path.isfile(wb):
            wb = self.app.make_path_from_config("Paths", "Job_Log")
        if wb and os.path.isfile(wb):
            self.file_entry.delete(0, "end")
            self.file_entry.insert(0, wb)
            self.log(f"[OK] \t Workbook (hub): {wb}")
            self._rescan()
        else:
            self.log("[INFO] \t No hub workbook path resolved — Browse for the "
                     "In-House Progress workbook.")
        self.log("[INFO] \t Upload Prep v1.1 (dev) — sources: 3.6.5 QC files "
                 "received (copies archived to 3.6.6 after) + 4.6 Shipping "
                 "list (COPY); output Desktop\\QC_to_upload.")

    # ---------------------------------------------------------- validation --
    def validate_inputs(self):
        """App gate (start_processing): parsed data + a date with rows must
        exist; else log the error and keep the Process button disabled."""
        if not self._rows_by_date:
            self.log("[ERROR] \t Parse the Master Shipping Log workbook first "
                     "(Browse / Re-scan).")
            self.app.process_button.configure(state="disabled")
            return False
        date_str = self.date_menu.get()
        if date_str in ("", "—") or not self._rows_by_date.get(date_str):
            self.log("[ERROR] \t Pick a Shipment Date with rows first.")
            self.app.process_button.configure(state="disabled")
            return False
        if not self._current_plan.get("checked"):
            self.log("[ERROR] \t No included rows for the selected date.")
            self.app.process_button.configure(state="disabled")
            return False
        return True

    # ------------------------------------------------------ preflight/plan --
    def _resolve_sources(self):
        """QC files received + Shipping list root: hub-passed first, ini
        fallback. Returns (qc_dir, ship_root, setup_problems) — when a
        folder is unusable, setup_problems records exactly which hub/ini
        values were tried."""
        setup_problems = []
        qc_dir = self._resolve_one("QC_Output_Folder",
                                   "3.6.5 QC files received", setup_problems)
        ship_root = self._resolve_one("Shipping_List", "4.6 Shipping list",
                                      setup_problems)
        return qc_dir, ship_root, setup_problems

    def _resolve_one(self, hub_key, label, setup_problems):
        """One source folder: hub kwarg first (must be an existing folder),
        ini [Paths] fallback (same check); when neither works, record the
        exact values tried for the screening report."""
        hub_value = self.app.hub_paths.get(hub_key)
        if hub_value and os.path.isdir(hub_value):
            return hub_value
        ini_value = self.app.make_path_from_config("Paths", hub_key)
        if ini_value and os.path.isdir(ini_value):
            return ini_value
        setup_problems.append(
            f"Source folder '{label}' not found\n"
            f"\t\thub passed {hub_value!r} (hub kwarg {hub_key})\n"
            f"\t\tini [Paths] {hub_key} resolved {ini_value!r}\n"
            "\t\tCheck the launch drive args (Label=Drive) against "
            "default_directories.ini.")
        return ini_value or hub_value or ""

    def _check_row(self, rec, qc_dir, ship_root):
        """ONE row's full resolution chain — the single per-row resolver the
        live table check and the process-time preflight share (no widget
        access, so a worker thread can call it).

        Returns {kind, short, text, sid?, source_kind?, src_dir?, name?,
        target?} where kind is 'ready' | 'problem' | 'unmatched'; when
        ready, the entry fields ride along."""
        sid, source_kind, name = self._classify(rec)
        tag = _row_tag(rec)
        if sid is None:
            return {"kind": "unmatched", "short": "", "text": name,
                    "sid": None, "source_kind": None, "src_dir": "",
                    "name": "", "target": ""}
        if not sid.startswith("S4") and not EMAIL_RE.match(rec["email"]):
            shown_email = rec["email"] if rec["email"] else "(EMPTY)"
            return {"kind": "problem", "short": "no Customer Email",
                    "text": (f"{tag}: Customer Email '{shown_email}' is "
                             "not a valid address\n"
                             f"\t\t{name} collects the zip in "
                             "QC_to_upload\\<customer email>\\\n"
                             "\t\tso the workbook cell must hold a real "
                             "email"),
                    "sid": None, "source_kind": None, "src_dir": "",
                    "name": "", "target": ""}
        src_dir = self._source_dir(rec, source_kind, ship_root, qc_dir)
        if not src_dir:
            return {"kind": "problem", "short": "folder not resolved",
                    "text": (f"{tag}: source folder unresolved for {name}"
                             "\n\t\tsee the setup problem(s) in the log"),
                    "sid": None, "source_kind": None, "src_dir": "",
                    "name": "", "target": ""}
        if not os.path.isdir(src_dir):
            return {"kind": "problem", "short": "folder not found",
                    "text": (f"{tag}: source folder does not exist\n"
                             f"\t\t'{src_dir}'"),
                    "sid": None, "source_kind": None, "src_dir": "",
                    "name": "", "target": ""}
        bbi, tn = rec["bbi"], _stripped_tube(rec["tube"])
        if not bbi or not tn:
            missing = "BBI ID" if not bbi else "Tube ID"
            return {"kind": "problem", "short": f"no {missing} in the row",
                    "text": (f"{tag}: the row has no {missing}\n"
                             "\t\tthe zip search needs BOTH anchors "
                             "(the BBI ID and the tube number) — the row "
                             "cannot be resolved until the workbook cell "
                             "is filled"),
                    "sid": None, "source_kind": None, "src_dir": "",
                    "name": "", "target": ""}
        try:
            names = os.listdir(src_dir)
        except OSError as exc:
            return {"kind": "problem", "short": "folder not listable",
                    "text": (f"{tag}: source folder could not be listed\n"
                             f"\t\t'{src_dir}'\n"
                             f"\t\t{exc.__class__.__name__}: {exc}"),
                    "sid": None, "source_kind": None, "src_dir": "",
                    "name": "", "target": ""}
        # Boundary-aware double-anchor match: a prefix-sibling BBI or tube
        # must never claim a neighbor's file ('BATCH 2882-1' won't match
        # 'BATCH 2882-19 ...'; '70001' won't match '700019').
        pattern = re.compile(
            r"(?=.*\b" + re.escape(bbi) + r"\b)"
            r"(?=.*\b" + re.escape(tn) + r"\b)")
        hits = [z for z in names if pattern.search(z)]
        if not hits:
            if names:
                detail = (f"\t\tthe folder holds {len(names)} file(s), none "
                          f"carrying both anchors; first ones there: "
                          f"{'; '.join(names[:2])}")
            else:
                detail = "\t\tthe folder is EMPTY"
            return {"kind": "problem", "short": "zip not found",
                    "text": (f"{tag}: no file in '{src_dir}' contains both\n"
                             f"\t\tBBI ID '{bbi}' AND tube number '{tn}' "
                             f"({rec['tube']} without its leading letter)\n"
                             + detail),
                    "sid": None, "source_kind": None, "src_dir": "",
                    "name": "", "target": ""}
        if len(hits) > 1:
            shown = "; ".join(hits[:4])
            more = f" (and {len(hits) - 4} more)" if len(hits) > 4 else ""
            return {"kind": "problem", "short": f"conflict ({len(hits)})",
                    "text": (f"{tag}: conflict — {len(hits)} file(s) in "
                             f"'{src_dir}' match both anchors '{bbi}' + "
                             f"'{tn}':\n\t\t{shown}{more}"),
                    "sid": None, "source_kind": None, "src_dir": "",
                    "name": "", "target": ""}
        return {"kind": "ready", "short": "found",
                "text": f"{tag}: zip found",
                "sid": sid, "source_kind": source_kind, "src_dir": src_dir,
                "name": hits[0], "target": self._target_dir(rec, sid)}

    def _preflight(self, rows, checked):
        """Plan the checked rows.

        Returns (entries, problems, setup_problems): entries carry
        {row, scenario, action, archive, ship_year, src_dir, name, dst_dir,
        status, bbi, tube, gene, tubes}; problems is {row-index: reason}
        from the same per-row resolver the live table check uses; every
        reason names the row (BBI ID + Tube ID) plus the exact
        folder/anchors involved; setup_problems carry the global
        source-folder failures. No folder or file is touched here."""
        qc_dir, ship_root, setup_problems = self._resolve_sources()
        entries, problems = [], {}
        for i in sorted(checked):
            rec = rows[i]
            state = self._check_row(rec, qc_dir, ship_root)
            if state["kind"] == "unmatched":
                problems[i] = f"{_row_tag(rec)}: {state['text']}"
                continue
            if state["kind"] == "problem":
                problems[i] = state["text"]
                continue
            entries.append({"row": i, "scenario": state["sid"],
                            "action": "COPY",
                            "archive": state["source_kind"] == "received",
                            "ship_year": rec["date"][:4],
                            "src_dir": state["src_dir"],
                            "name": state["name"],
                            "dst_dir": state["target"],
                            "bbi": rec["bbi"], "tube": rec["tube"],
                            "gene": rec["gene"], "tubes": rec["tubes"],
                            "status": name_for_entry(state["sid"])})
        return entries, problems, setup_problems

    # ----------------------------------------------------------- processing --
    def run_processing_task(self):
        """Worker entry (app.start_processing's thread): screen the checked
        rows and execute the ready plan straight away (no popup)."""
        snapshot = self._current_plan
        rows = snapshot["rows"]
        checked = set(snapshot["checked"])
        date_str = snapshot["date"]
        if not rows or not checked:
            self.log("[ERROR] \t No included rows for the selected date — "
                     "nothing to process.")
            self.app.after(0, self._release_button)
            return
        self.log("")
        self.log(f"[INFO] \t Screening {len(checked)} included row(s) of "
                 f"{date_str} ...")
        try:
            entries, problems, setup_problems = self._preflight(rows, checked)
        except Exception as exc:
            self.log("[ERROR] \t Pre-flight failed: "
                     f"{exc.__class__.__name__}: {exc}")
            self.app.after(0, self._release_button)
            return
        n_arch = sum(1 for e in entries if e.get("archive"))
        for text in setup_problems:
            self.log(f"[ERROR] \t {text}")
        self.log(f"[INFO] \t Screening done: {len(entries)} file(s) ready to "
                 f"COPY into QC_to_upload ({n_arch} originals will then "
                 f"archive to '3.6.6 QC files uploaded'), "
                 f"{len(problems)} row(s) with problems.")
        for key, status in sorted(problems.items(), key=lambda kv: kv[0]):
            self.log(f"[WARNING] \t {status}")

        # No popup: the table already told the user what was found and what
        # was not (green/yellow/amber) — Process = execute the ready plan
        # now; problem rows are only logged, never touched.
        self._execute(entries)
        self.app.after(0, self._release_button)

    def _progress_set(self, fraction):
        """Execution progress (the accepted plan's copy + archive work —
        NOT the fast screening); main thread via app.after from the
        processing worker; _release_button resets it to 0."""
        self.progress.set(fraction)

    def _release_button(self):
        """Restores the Process gate + resets the execution progress bar;
        all its callers schedule it with app.after (main thread)."""
        self.progress.set(0)
        has_rows = bool(self._current_plan["rows"]
                        and self._current_plan["checked"])
        self.app.process_button.configure(
            state="normal" if has_rows else "disabled")

    # -------------------------------------------------------------- execute --
    def _execute(self, entries):
        """Run, in two steps:
        step 1 — COPY every ready zip into its QC_to_upload target (a
                 same-name file already in the target is a collision ->
                 skipped, never overwritten, and NOT archived);
        step 2 — for received-source rows, move the '3.6.5 QC files
                 received' original into the sibling archive
                 '\\3.6.6 QC files uploaded\\<YYYY>\\' (YYYY = shipment year).
        Only rows whose copy succeeded get archived."""
        self.log("")
        self.log("[INFO] \t Step 1 — copying into QC_to_upload ...")
        copied = archived = skipped = errors = not_archived = 0
        pending_archive = []
        root = self._output_root()
        for n, e in enumerate(entries, 1):
            # Progress bar = the REAL execution work (copies are the long
            # part): step 1 spans 0–85%, the archive step 85–100%.
            self.app.after(0, self._progress_set,
                           0.85 * n / max(len(entries), 1))
            src = os.path.join(e["src_dir"], e["name"])
            try:
                os.makedirs(e["dst_dir"], exist_ok=True)
                dst = os.path.join(e["dst_dir"], e["name"])
                if os.path.exists(dst):
                    skipped += 1
                    self.log(f"[WARNING] \t Target already exists — copy "
                             f"skipped, original stays in the source "
                             f"folder: {dst}")
                    continue
                shutil.copy2(src, dst)
                copied += 1
                self.log(f"[OK] \t Copied: {e['name']} -> "
                         f"{os.path.relpath(e['dst_dir'], root)}")
                if e.get("archive"):
                    pending_archive.append(e)
            except Exception as exc:
                errors += 1
                self.log(f"[ERROR] \t {e['bbi']} ({e['name']}): "
                         f"{exc.__class__.__name__}: {exc}")
        if pending_archive:
            self.log("")
            self.log("[INFO] \t Step 2 — archiving the copied '3.6.5' "
                     "originals to '3.6.6 QC files uploaded\\<YYYY>' ...")
            self.app.after(0, self._progress_set, 0.85)
            for m, e in enumerate(pending_archive, 1):
                self.app.after(0, self._progress_set,
                               0.85 + 0.15 * m / len(pending_archive))
                arch_dir = os.path.join(os.path.dirname(e["src_dir"]),
                                        "3.6.6 QC files uploaded",
                                        e["ship_year"])
                try:
                    os.makedirs(arch_dir, exist_ok=True)
                    adst = os.path.join(arch_dir, e["name"])
                    if os.path.exists(adst):
                        skipped += 1
                        not_archived += 1
                        self.log(f"[WARNING] \t Not archived: '{e['name']}' "
                                 f"already exists in {arch_dir} — the "
                                 "original stays in '3.6.5 QC files "
                                 "received'.")
                        continue
                    shutil.move(os.path.join(e["src_dir"], e["name"]), adst)
                    archived += 1
                    self.log(f"[OK] \t Archived: {e['name']} -> "
                             f"3.6.6 QC files uploaded\\{e['ship_year']}")
                except Exception as exc:
                    errors += 1
                    not_archived += 1
                    self.log(f"[ERROR] \t Archive {e['bbi']} ({e['name']}): "
                             f"{exc.__class__.__name__}: {exc}")
        self.app.after(0, self._progress_set, 1.0)
        self.log("[OK] \t Done: "
                 f"{copied} copied, {archived} archived to 3.6.6, "
                 f"{skipped} skipped (target existed), {errors} error(s). "
                 f"Output: {root}")
        if not_archived:
            self.log(f"[WARNING] \t {not_archived} copied original(s) could "
                     "NOT be archived (see the warnings above) — they stay "
                     "in '3.6.5 QC files received'; re-run the date later "
                     "or move them manually.")