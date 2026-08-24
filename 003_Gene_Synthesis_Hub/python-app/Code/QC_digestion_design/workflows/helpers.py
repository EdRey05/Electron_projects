"""
Shared helper functions for parsing data from Excel files.
"""

import pandas as pd


def normalize_column_lookup(df, candidates):
    """
    Try to find a column in df whose name matches any in candidates (case-insensitive).
    Return column name if found, else None.
    """
    if df is None:
        return None
    cols = {c.lower(): c for c in df.columns}
    for candidate in candidates:
        if candidate.lower() in cols:
            return cols[candidate.lower()]
    return None


def get_row_for_jobid(df, jobid):
    """
    Find row where first column (JobID) equals jobid.
    JobID column detection: prefer column named 'JobID' case-insensitive; otherwise use first column.
    Returns the row as a pandas Series or None.
    """
    if df is None or df.shape[0] == 0:
        return None
    jobid_col = normalize_column_lookup(df, ["JobID", "Job Id", "Job_ID", "jobid"])
    if jobid_col is None:
        jobid_col = df.columns[0]
    mask = df[jobid_col].astype(str).str.strip() == str(jobid).strip()
    found = df[mask]
    if found.shape[0] == 0:
        return None
    return found.iloc[0]


def get_field_from_row(row, field_names_candidates, fallback_index=None):
    """
    Try to pull a value from row by column name candidates (case-insensitive).
    If not found and fallback_index provided, use positional index (0-based).
    Returns stripped string or empty string.
    """
    if row is None:
        return ""
    for candidate in field_names_candidates:
        for col in row.index:
            if col and str(col).strip().lower() == candidate.lower():
                val = row[col]
                return "" if pd.isna(val) else str(val).strip()
    if fallback_index is not None:
        try:
            val = row.iloc[fallback_index]
            return "" if pd.isna(val) else str(val).strip()
        except IndexError:
            return ""
    return ""
