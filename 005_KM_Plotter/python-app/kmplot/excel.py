"""Write the KM results workbook (one sheet per curve).

Mirrors the Streamlit app's ``save_KM_results``: each sheet carries the event
table, the survival function, the confidence bounds and the median survival
time, laid out side by side.
"""

from __future__ import annotations

import io
from typing import Any, Dict, List

import numpy as np
import pandas as pd

try:  # openpyxl is the only extra dependency, and only needed for export.
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font
    from openpyxl.utils import get_column_letter
except ImportError:  # pragma: no cover
    Workbook = None  # type: ignore


TABLE_HEADERS = [
    ("Event Table", 1, ["Removed", "Observed", "Censored", "At Risk"]),
    ("Survival Function", 7, ["Time", "Probability"]),
    ("Confidence Intervals", 10, ["Lower Bound", "Upper Bound"]),
]


def _safe_sheet_title(title: str, used: set) -> str:
    """Excel sheet names: max 31 chars, no []:*?/\\ and must be unique."""
    cleaned = "".join("_" if ch in "[]:*?/\\" else ch for ch in title)[:31]
    if not cleaned:
        cleaned = "Sheet"
    candidate = cleaned
    n = 2
    while candidate.lower() in used:
        suffix = f"_{n}"
        candidate = cleaned[: 31 - len(suffix)] + suffix
        n += 1
    used.add(candidate.lower())
    return candidate


def build_workbook(result: Dict[str, Any]) -> bytes:
    """Build the .xlsx bytes for an analysis result."""
    if Workbook is None:
        raise RuntimeError("openpyxl is required to export the Excel file.")

    wb = Workbook()
    wb.remove(wb["Sheet"])
    used: set = set()

    curves: List[Dict[str, Any]] = result.get("curves", [])
    for i, curve in enumerate(curves):
        title = curve.get("label") or f"KM_Subgroup_{i + 1}"
        if len(curves) == 1 and not result.get("variables"):
            title = "KM_Dataset"
            subtitle = "KM_Dataset: Whole dataset - No subgroups"
        else:
            subtitle = f"KM_Subgroup_{i + 1}: {curve.get('label', '')}"
        ws = wb.create_sheet(title=_safe_sheet_title(title, used))

        # Sub-header
        ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=13)
        cell = ws.cell(row=2, column=1)
        cell.value = subtitle
        cell.font = Font(bold=True, size=14)
        cell.alignment = Alignment(horizontal="center", vertical="center")

        # Event table (cols A-E)
        ws.cell(row=4, column=1, value="Event Table").font = Font(bold=True)
        for j, head in enumerate(TABLE_HEADERS[0][2]):
            ws.cell(row=5, column=1 + j, value=head)
        et = curve.get("eventTable", [])
        for r, row in enumerate(et):
            ws.cell(row=6 + r, column=1, value=row.get("time"))
            ws.cell(row=6 + r, column=2, value=row.get("removed"))
            ws.cell(row=6 + r, column=3, value=row.get("observed"))
            ws.cell(row=6 + r, column=4, value=row.get("censored"))
            ws.cell(row=6 + r, column=5, value=row.get("atRisk"))

        # Survival function (cols G-H)
        ws.cell(row=4, column=7, value="Survival Function").font = Font(bold=True)
        ws.cell(row=5, column=7, value="Time")
        ws.cell(row=5, column=8, value="Probability")
        timeline = curve.get("timeline", [])
        surv = curve.get("survival", [])
        for r, (t, s) in enumerate(zip(timeline, surv)):
            ws.cell(row=6 + r, column=7, value=t)
            ws.cell(row=6 + r, column=8, value=s)

        # Confidence intervals (cols J-K)
        ws.cell(row=4, column=10, value="Confidence Intervals").font = Font(bold=True)
        ws.cell(row=5, column=10, value="Lower Bound")
        ws.cell(row=5, column=11, value="Upper Bound")
        lower = curve.get("lower", [])
        upper = curve.get("upper", [])
        for r, (lo, hi) in enumerate(zip(lower, upper)):
            ws.cell(row=6 + r, column=10, value=lo)
            ws.cell(row=6 + r, column=11, value=hi)

        # Median survival time (col M)
        ws.cell(row=4, column=13, value="Median Survival Time").font = Font(bold=True)
        median = curve.get("median")
        ws.cell(row=5, column=13, value=("Not reached" if not np.isfinite(median) else float(median)))

        # Cosmetics
        for col in ("A", "B", "C", "D", "E"):
            ws.column_dimensions[col].width = 12
        ws.column_dimensions["G"].width = 12
        ws.column_dimensions["H"].width = 12
        ws.column_dimensions["J"].width = 13
        ws.column_dimensions["K"].width = 13
        ws.column_dimensions["M"].width = 22
        for c in ("A5", "B5", "C5", "D5", "E5", "G5", "H5", "J5", "K5"):
            ws[c].alignment = Alignment(horizontal="center")

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
