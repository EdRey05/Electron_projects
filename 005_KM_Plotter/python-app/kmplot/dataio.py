"""Loading and profiling of clinical / RNA datasets.

File formats mirror the Streamlit app (003_KM_plotter):

* **clinical** — tab-separated, ``#`` comment lines carry a data dictionary.
  The first non-comment line is the header. Mandatory columns are
  ``PATIENT_ID`` plus a time/event pair (``OS_MONTHS``/``OS_STATUS`` ...).
* **RNA** — tab-separated. Either genes-as-rows (``Hugo_Symbol`` column,
  one column per patient) or the already-transposed patients-as-rows layout.
  Both are normalised to *patients as rows, genes as columns* with a
  ``PATIENT_ID`` column, matching the clinical layout.
"""

from __future__ import annotations

import math
import os
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

#: Endpoint acronyms the app looks for, in the order the Streamlit app used.
METRIC_ACRONYMS = ("OS", "RFS", "PFS", "DFS", "DSS")

#: Extra columns that are useful as an *event* source (e.g. "Died of Disease").
EXTRA_EVENT_COLUMNS = ("VITAL_STATUS", "CAUSE_OF_DEATH")

PATIENT_ID = "PATIENT_ID"


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------


def _read_table(path: str, comment: Optional[str] = "#") -> pd.DataFrame:
    """Read a tab-separated table, tolerating a data-dictionary header block."""
    sep = "\t"
    df = pd.read_csv(path, sep=sep, comment=comment, encoding="utf-8", engine="python")
    df.columns = [str(c).strip() for c in df.columns]
    # Drop fully-empty columns produced by ragged rows.
    df = df.dropna(axis=1, how="all")
    return df


def load_clinical(path: str) -> pd.DataFrame:
    """Load the clinical dataset (required)."""
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Clinical file not found: {path}")
    df = _read_table(path)
    if df.empty:
        raise ValueError("The clinical file appears to be empty.")
    if PATIENT_ID not in df.columns:
        # Tolerate a missing PATIENT_ID by synthesising one.
        df.insert(0, PATIENT_ID, [f"P_{i:05d}" for i in range(1, len(df) + 1)])
    return df


def load_rna(path: str) -> pd.DataFrame:
    """Load the optional RNA dataset and normalise it to patients-as-rows."""
    if not os.path.isfile(path):
        raise FileNotFoundError(f"RNA file not found: {path}")
    df = _read_table(path, comment=None)

    if "Entrez_Gene_Id" in df.columns:
        df = df.drop(columns=["Entrez_Gene_Id"])

    if "Hugo_Symbol" in df.columns:
        # Genes-as-rows layout: transpose so each row is a patient.
        df = df.rename(columns={"Hugo_Symbol": PATIENT_ID})
        df = df.set_index(PATIENT_ID).T
        df = df.sort_index(axis=1)
        df = df.reset_index()
        df = df.rename(columns={"index": PATIENT_ID})
        df = df.sort_values(PATIENT_ID).reset_index(drop=True)
    elif PATIENT_ID in df.columns:
        # Already patients-as-rows — nothing to do.
        pass
    elif df.shape[0] > df.shape[1]:
        # Heuristic: more rows than columns means genes-as-rows.
        df = df.set_index(df.columns[0]).T
        df = df.sort_index(axis=1).reset_index()
        df = df.rename(columns={"index": PATIENT_ID})
        df = df.sort_values(PATIENT_ID).reset_index(drop=True)
    else:
        raise ValueError(
            "Could not work out the layout of the RNA file. Expected a "
            "'Hugo_Symbol' or 'PATIENT_ID' column."
        )

    df.columns = [str(c).strip() for c in df.columns]
    if PATIENT_ID not in df.columns:
        df.insert(0, PATIENT_ID, [f"P_{i:05d}" for i in range(1, len(df) + 1)])
    return df


# --------------------------------------------------------------------------
# Column discovery
# --------------------------------------------------------------------------


def discover_options(clinical: pd.DataFrame) -> Dict[str, List[str]]:
    """Find the time-to-event and event-observation columns.

    Mirrors the Streamlit app: a metric is offered when both ``<METRIC>_MONTHS``
    and ``<METRIC>_STATUS`` exist. ``VITAL_STATUS`` / ``CAUSE_OF_DEATH`` are
    offered as alternative event sources.
    """
    cols = set(clinical.columns)

    time_options: List[str] = []
    event_options: List[str] = []
    for metric in METRIC_ACRONYMS:
        tcol, ecol = f"{metric}_MONTHS", f"{metric}_STATUS"
        if tcol in cols and ecol in cols:
            time_options.append(tcol)
            event_options.append(ecol)
    for extra in EXTRA_EVENT_COLUMNS:
        if extra in cols:
            event_options.append(extra)
    return {"timeToEventOptions": time_options, "eventObservationOptions": event_options}


def is_numeric(series: pd.Series) -> bool:
    """True when the column can be treated as a number (NaNs allowed)."""
    if pd.api.types.is_numeric_dtype(series):
        return True
    if pd.api.types.is_bool_dtype(series):
        return True
    if pd.api.types.is_object_dtype(series):
        non_null = series.dropna()
        if non_null.empty:
            return False
        coerced = pd.to_numeric(non_null, errors="coerce")
        # Require *every* non-null value to convert, otherwise it is text.
        return bool(coerced.notna().all())
    return False


def numeric_view(series: pd.Series) -> pd.Series:
    """Return the column coerced to numbers (non-numeric becomes NaN)."""
    if pd.api.types.is_numeric_dtype(series):
        return series
    return pd.to_numeric(series, errors="coerce")


def describe_column(df: pd.DataFrame, column: str) -> Dict[str, Any]:
    """Metadata about a column, used to drive the UI widgets."""
    if column not in df.columns:
        raise KeyError(f"Column not found: {column}")
    s = df[column]
    n_missing = int(s.isna().sum())
    numeric = is_numeric(s)
    out: Dict[str, Any] = {
        "name": column,
        "nRows": int(len(df)),
        "nMissing": n_missing,
        "nUnique": int(s.nunique(dropna=True)),
        "numeric": numeric,
        "dtype": str(s.dtype),
    }
    if numeric:
        nums = numeric_view(s).dropna()
        if len(nums):
            out.update(
                {
                    "min": float(nums.min()),
                    "max": float(nums.max()),
                    "mean": float(nums.mean()),
                    "median": float(nums.median()),
                }
            )
    return out


def value_counts(df: pd.DataFrame, column: str, limit: int = 200) -> List[Dict[str, Any]]:
    """Unique values of a (text) column with their counts, most frequent first.

    Values keep their original Python type so the UI can send them back
    unchanged for the 0/1 event mapping.
    """
    s = df[column]
    counts = s.value_counts(dropna=True)
    out: List[Dict[str, Any]] = []
    for i, (value, count) in enumerate(counts.items()):
        if i >= limit:
            break
        out.append({"id": f"v{i}", "value": _jsonify(value), "label": str(value), "count": int(count)})
    return out


def _jsonify(value: Any) -> Any:
    """Convert numpy scalars to plain Python types for JSON transport."""
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        f = float(value)
        return None if math.isnan(f) else f
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if value is pd.NA or (isinstance(value, float) and math.isnan(value)):
        return None
    return value


def histogram(df: pd.DataFrame, column: str, n_bins: Optional[int] = None) -> Dict[str, Any]:
    """Binned distribution of a numeric column."""
    nums = numeric_view(df[column]).dropna().to_numpy(dtype=float)
    if nums.size == 0:
        return {"kind": "histogram", "column": column, "bins": [], "n": 0, "nMissing": int(df[column].isna().sum())}

    lo, hi = float(nums.min()), float(nums.max())
    if hi <= lo:
        hi = lo + 1.0
    if n_bins is None:
        n_bins = int(min(30, max(5, round(math.sqrt(nums.size)))))
    counts, edges = np.histogram(nums, bins=n_bins, range=(lo, hi))

    bins = [
        {"x0": float(edges[i]), "x1": float(edges[i + 1]), "count": int(counts[i])}
        for i in range(len(counts))
    ]
    return {
        "kind": "histogram",
        "column": column,
        "bins": bins,
        "n": int(nums.size),
        "nMissing": int(df[column].isna().sum()),
        "min": lo,
        "max": hi,
        "mean": float(nums.mean()),
    }
