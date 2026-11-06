"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.1
Date: Nov 04, 2026
Notes: Checkable table for the Sg Relabeling rework (Label_generator):
    the Label_generator MeasurementTable with a click-to-toggle check
    column as column 0, ported from the Gene_email_system EmailTable
    (the same click on the first column toggles the check glyph, checked
    rows show green). Built for shipping lists too large for a dropdown:
    the widget owns the full data rows plus a live text filter, so the
    app can search (type to filter, e.g. 'UT605'), check the visible
    matches with one click each (or 'Check all') and transfer them
    to the label table; checks survive filtering and re-parses because
    the widget keeps them per data row, not per displayed item. Checking
    a row through a click fires the on_check callback (data index,
    now-checked) - the hosting app mirrors the check marks on its own
    label table; the bulk check/clear helpers do not fire callbacks.
    Ctrl+C copies the VISIBLE rows without the check column.
    v1.1 makes the check column's header and width configurable
    (check_header / check_width, defaults '✓'/42) for the Autodiscovery
    popup, whose first column reads 'Add?' over the date folders.
"""

import csv
import io
from tkinter import ttk  # noqa: F401  (ttk widgets come via the base class)

from tools.measurement_table import MeasurementTable


class CheckboxTable(MeasurementTable):
    """MeasurementTable whose column 0 is a check cell. Data rows are
    stored WITHOUT the check cell; the widget renders them with the
    check glyph column prepended and keeps a display map back to the
    data indices (filter-safe)."""

    CHECK = "\u2713"   # the email-system check glyph

    def __init__(self, master, columns=(), height=8, font_size=11,
                 on_check=None, check_header="\u2713", check_width=42):
        check_col = [(check_header, check_width, "center")]
        super().__init__(master, columns=check_col + list(columns),
                         height=height, font_size=font_size)
        self.tree.configure(show="headings")
        self.on_check = on_check  # (data_idx, now_checked) on a user click
        # Checked rows pop (green) instead of the email app's grey-dim
        # - here the check means 'send to the label table', so the picked
        # rows must stand out on a screen full of unchecked rows.
        self.tree.tag_configure("picked", foreground="#2E7D32")
        self.tree.bind("<Button-1>", self._on_click, add="+")

        self._data = []      # cell tuples, data columns only (no check col)
        self._checks = set() # indices into _data that are checked
        self._display_map = []  # tree order -> _data index
        self._filter_text = ""

    # ------------------------------------------------------------------
    # Data / filter
    # ------------------------------------------------------------------
    def set_data(self, rows, checked_indices=()):
        """Replaces the data rows (cell tuples WITHOUT the check column)
        and restores the given checked indices."""
        self._data = [tuple(cells) for cells in rows]
        self._checks = set(checked_indices)
        self._render()

    def set_filter(self, text):
        """Live filter: whitespace-separated tokens, AND-ed, matching any
        row cell (case-insensitive). Empty = no filter."""
        self._filter_text = (text or "").strip()
        self._render()
        return self.visible_count()

    def _matches(self, cells) -> bool:
        if not self._filter_text:
            return True
        haystack = " ".join(str(c) for c in cells).lower()
        return all(tok.lower() in haystack for tok in self._filter_text.split())

    def check_visible(self):
        """Checks every row currently visible under the filter."""
        self._checks.update(self._display_map)
        self._render()

    def clear_checks(self):
        self._checks.clear()
        self._render()

    def uncheck(self, indices):
        self._checks.difference_update(indices)
        self._render()

    # ------------------------------------------------------------------
    # Reading back
    # ------------------------------------------------------------------
    def get_checked_indices(self) -> list:
        """Indices of checked rows over the FULL data set (not only the
        rows visible under the active filter)."""
        return sorted(self._checks)

    def visible_count(self) -> int:
        return len(self._display_map)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _on_click(self, event) -> str | None:
        """Click in the first (check) column toggles the row; clicks
        elsewhere keep normal Treeview behaviour (the email-app pattern)."""
        if self.tree.identify("region", event.x, event.y) != "cell":
            return None
        if self.tree.identify_column(event.x) != "#1":
            return None
        item = self.tree.identify_row(event.y)
        if not item:
            return None
        data_idx = self._display_map[self.tree.index(item)]
        if data_idx in self._checks:
            self._checks.discard(data_idx)
        else:
            self._checks.add(data_idx)
        self._render_item(item, data_idx)
        if self.on_check is not None:
            self.on_check(data_idx, data_idx in self._checks)
        return "break"

    def _render(self):
        previous = self.tree.get_children()
        if previous:
            self.tree.delete(*previous)
        self._display_map = []
        for data_idx, cells in enumerate(self._data):
            if not self._matches(cells):
                continue
            self._append_item(cells, data_idx)

    def _append_item(self, cells, data_idx):
        tags = ["even"] if len(self._display_map) % 2 == 0 else []
        if data_idx in self._checks:
            tags.append("picked")
        self.tree.insert("", "end", values=(self.CHECK if data_idx in self._checks else "",
                                            *cells), tags=tags)
        self._display_map.append(data_idx)

    def _render_item(self, item, data_idx):
        """In-place refresh of one row after a toggle (no full re-render:
        the scroll position and any text selection stay untouched)."""
        tags = ["even"] if self.tree.index(item) % 2 == 0 else []
        if data_idx in self._checks:
            tags.append("picked")
        self.tree.item(item, values=(self.CHECK if data_idx in self._checks else "",
                                     *self._data[data_idx]), tags=tags)

    # ------------------------------------------------------------------
    # Copy (check column excluded)
    # ------------------------------------------------------------------
    def copy_rows(self, event=None, include_header=True) -> str:
        """Ctrl+C: selected rows, else every VISIBLE row; header + TSV for
        Excel; the check column is never copied."""
        selected = set(self.tree.selection())
        items = [item for item in self.tree.get_children()
                 if not selected or item in selected]
        buffer = io.StringIO()
        writer = csv.writer(buffer, delimiter="\t", lineterminator="\n")
        if include_header:
            writer.writerow([column[0] for column in self.columns[1:]])
        writer.writerows(self.tree.item(item, "values")[1:] for item in items)
        self.clipboard_clear()
        self.clipboard_append(buffer.getvalue())
        return "break"