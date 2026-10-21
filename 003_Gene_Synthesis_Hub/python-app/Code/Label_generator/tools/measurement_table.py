"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.0
Date: Sep 29, 2026
Notes: Reusable copyable table widget (ttk.Treeview in a CTkFrame), per
    the Ctk_table_spec.txt: zebra rows, bold headings, selection
    highlight, vertical/horizontal scrollbars, Ctrl+C copies selected
    rows (or all rows) as tab-separated text with a header row for
    direct pasting into Excel. Data-agnostic: callers own all
    formatting; the widget only renders.
"""

import csv
import io
from tkinter import ttk

import customtkinter as ctk


DEFAULT_COLUMNS = ()


class MeasurementTable(ctk.CTkFrame):
    def __init__(self, master, columns=DEFAULT_COLUMNS, height=5, font_size=11):
        super().__init__(master, fg_color="#ffffff", corner_radius=0, width=1, height=1)
        self.grid_propagate(False)
        self.grid_rowconfigure(0, weight=1)
        self.grid_columnconfigure(0, weight=1)
        self.columns = columns
        table_style = f"Downpacking{font_size}.Treeview"
        style = ttk.Style(self)
        style.configure(table_style, background="#ffffff", foreground="#172b3a",
                        fieldbackground="#ffffff", rowheight=font_size + 21,
                        font=("Segoe UI", font_size))
        style.configure(f"{table_style}.Heading", font=("Segoe UI", font_size, "bold"),
                        padding=(8, 8))
        style.map(table_style, background=[("selected", "#d5eaf7")],
                  foreground=[("selected", "#102e44")])
        self.tree = ttk.Treeview(self, columns=[c[0] for c in columns], show="headings",
                                 style=table_style, height=height, selectmode="extended")
        for title, width, anchor in columns:
            self.tree.heading(title, text=title, anchor=anchor)
            self.tree.column(title, width=width, minwidth=60, anchor=anchor, stretch=True)
        self.tree.tag_configure("even", background="#f0f5f9")
        self.tree.tag_configure("missing", foreground="#976217")
        vertical = ttk.Scrollbar(self, orient="vertical", command=self.tree.yview)
        horizontal = ttk.Scrollbar(self, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        vertical.grid(row=0, column=1, sticky="ns")
        horizontal.grid(row=1, column=0, sticky="ew")
        self.tree.bind("<Control-c>", self.copy_rows)

    def set_rows(self, rows, missing_indices=()):
        previous = self.tree.get_children()
        if previous:
            self.tree.delete(*previous)
        for index, cells in enumerate(rows):
            tags = ["even"] if index % 2 == 0 else []
            if index in missing_indices:
                tags.append("missing")
            self.tree.insert("", "end", values=cells, tags=tags)

    def copy_rows(self, event=None):
        """Copy selected rows (or all rows) with headings for pasting into Excel."""
        selected = set(self.tree.selection())
        items = [item for item in self.tree.get_children() if not selected or item in selected]
        buffer = io.StringIO()
        writer = csv.writer(buffer, delimiter="\t", lineterminator="\n")
        writer.writerow([column[0] for column in self.columns])
        writer.writerows(self.tree.item(item, "values") for item in items)
        self.clipboard_clear()
        self.clipboard_append(buffer.getvalue())
        return "break"

    def copy_all_rows(self, event=None):
        """Copy every row (ignoring selection) with headings; used by the
        app's 'Copy data' button."""
        previous_selection = self.tree.selection()
        if previous_selection:
            self.tree.selection_remove(*previous_selection)
        return self.copy_rows(event)