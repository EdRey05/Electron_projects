"""
Shared helper functions for parsing data from Excel files.
"""

import pandas as pd


def normalize_column_lookup(df, candidates):
    """
    Try to find a column in df whose name matches any in candidates (case-insensitive, tolerant of surrounding whitespace).
    Return column name if found, else None.
    """
    if df is None:
        return None
    cols = {str(c).strip().lower(): c for c in df.columns}
    for candidate in candidates:
        if str(candidate).strip().lower() in cols:
            return cols[str(candidate).strip().lower()]
    return None


def get_row_for_work_no(df, work_no):
    """
    Find the row whose Work No. column equals work_no.
    Column detection: prefer a 'Work No.' column (canonical job-log name; legacy
    JobID spellings accepted), falling back to the first column if no header matches.
    Returns the row as a pandas Series or None.
    """
    if df is None or df.shape[0] == 0:
        return None
    work_no_col = normalize_column_lookup(df, ["Work No.", "JobID", "Job Id", "Job_ID", "jobid"])
    if work_no_col is None:
        work_no_col = df.columns[0]
    mask = df[work_no_col].astype(str).str.strip() == str(work_no).strip()
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
            if col and str(col).strip().lower() == str(candidate).strip().lower():
                val = row[col]
                return "" if pd.isna(val) else str(val).strip()
    if fallback_index is not None:
        try:
            val = row.iloc[fallback_index]
            return "" if pd.isna(val) else str(val).strip()
        except IndexError:
            return ""
    return ""
