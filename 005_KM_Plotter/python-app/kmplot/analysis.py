"""The analysis pipeline: 0/1 event encoding, subgroup construction, KM fits.

This mirrors the semantics of the original Streamlit app
(``003_KM_plotter/app.py``) so results are directly comparable:

* The user maps raw values of the event column onto **0 = no event** and
  **1 = event**; rows whose value is not mapped are dropped.
* Subgroups are defined per *variable* (1–5 variables), each variable
  contributing a *group* (1–5 groups). Text variables are split by **tags**
  (a set of values per group); numeric variables are split by **ranges**
  (``[lo, hi)``). Groups of the same variable are mutually exclusive.
* Curves are the **cartesian product** of the groups of every variable, so
  2 variables × 3 groups = up to 9 curves.
* Range subgroups are half-open ``[lo, hi)`` unless ``includeHi`` is true.
  Missing and out-of-range measurements are excluded and counted explicitly.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from .dataio import PATIENT_ID, is_numeric, numeric_view, discover_options
from .kmlib import KMFit, fit_km


class AnalysisError(Exception):
    """Raised with a user-facing message when the analysis cannot proceed."""


# --------------------------------------------------------------------------
# Event encoding
# --------------------------------------------------------------------------


def encode_events(
    clinical: pd.DataFrame,
    event_column: str,
    no_event_values: Sequence[Any],
    event_values: Sequence[Any],
) -> pd.DataFrame:
    """Return a copy of ``clinical`` with the event column mapped to 0/1.

    Rows whose event value is in neither list are dropped.
    """
    if event_column not in clinical.columns:
        raise AnalysisError(f"Column not found in the dataset: {event_column}")

    df = clinical.copy()
    col = df[event_column].map(_value_key)

    no_event = {_value_key(v) for v in no_event_values}
    event = {_value_key(v) for v in event_values}
    overlap = no_event & event
    if overlap:
        raise AnalysisError(
            "A value cannot be both 'No event' and 'Event': " + ", ".join(sorted(overlap))
        )

    mapped = col.map(lambda v: "0" if v in no_event else ("1" if v in event else None))
    # Keep only the rows that were mapped. The filter has to happen *before*
    # the int conversion: unmapped rows hold None, which astype(int) rejects.
    keep = mapped.notna()
    df = df.loc[keep].copy()
    df["__KM_EVENT__"] = mapped.loc[keep].astype(int)
    return df


def to_numeric_time(df: pd.DataFrame, time_column: str) -> pd.DataFrame:
    """Coerce the time-to-event column to numbers, dropping NaN rows."""
    if time_column not in df.columns:
        raise AnalysisError(f"Column not found in the dataset: {time_column}")
    out = df.copy()
    if not is_numeric(out[time_column]):
        out[time_column] = numeric_view(out[time_column])
    out[time_column] = pd.to_numeric(out[time_column], errors="coerce")
    return out.loc[out[time_column].notna() & np.isfinite(out[time_column]) & (out[time_column] >= 0)].copy()


# --------------------------------------------------------------------------
# Subgrouping
# --------------------------------------------------------------------------


def _value_key(value: Any) -> str:
    """Stable string key for a raw dataset value (used for tag matching)."""
    if isinstance(value, float) and np.isnan(value):
        return "__NA__"
    if isinstance(value, (int, float, np.integer, np.floating)) and np.isfinite(value) and float(value).is_integer():
        return str(int(value))
    return str(value)


def resolve_subgroup_values(
    df: pd.DataFrame,
    column: str,
    mode: str,
    groups: Sequence[Dict[str, Any]],
) -> Tuple[pd.Series, List[str]]:
    """Build a series of group labels for ``column``.

    Parameters
    ----------
    mode:
        ``"tags"`` for text variables, ``"ranges"`` for numeric variables.
    groups:
        One dict per group. For ``tags``: ``{"values": [...]}``. For
        ``ranges``: ``{"lo": float, "hi": float}``.

    Returns
    -------
    (labels, group_names)
        ``labels`` holds the group name per row (``None`` where no group
        matched); ``group_names`` are the human-readable legend labels.
    """
    if mode == "tags":
        names: List[str] = []
        mapping: Dict[str, str] = {}
        for i, g in enumerate(groups):
            vals = [_value_key(v) for v in g.get("values", [])]
            if not vals:
                raise AnalysisError("Every category group needs at least one selected value.")
            name = g.get("name") or ("+".join(vals))
            if name in names:
                raise AnalysisError("Group labels must be unique within each variable.")
            names.append(name)
            for v in vals:
                if v in mapping:
                    raise AnalysisError(f"The value '{v}' is assigned to more than one group.")
                mapping[v] = name
        if not names:
            raise AnalysisError("At least one subgroup needs at least one value selected.")

        col = df[column].map(_value_key)
        labels = col.map(mapping)
        return labels, names

    if mode == "ranges":
        nums = numeric_view(df[column])
        labels = pd.Series([None] * len(df), index=df.index, dtype=object)
        names = []
        intervals = []
        for i, g in enumerate(groups):
            lo = g.get("lo")
            hi = g.get("hi")
            if lo is None or hi is None:
                raise AnalysisError("Every range group needs both boundaries.")
            lo, hi = float(lo), float(hi)
            include_hi = bool(g.get("includeHi", False))
            if not np.isfinite([lo, hi]).all() or hi < lo or (hi == lo and not include_hi):
                raise AnalysisError(
                    f"Subgroup {i + 1} has an empty range ({lo} to {hi}). "
                    "The upper bound must be greater than the lower bound."
                )
            name = g.get("name") or f"{_fmt_num(lo)} to {_fmt_num(hi)}"
            if name in names:
                raise AnalysisError("Group labels must be unique within each variable.")
            for previous_lo, previous_hi, previous_closed in intervals:
                if max(lo, previous_lo) < min(hi, previous_hi) or (hi == previous_lo and include_hi) or (previous_hi == lo and previous_closed):
                    raise AnalysisError("Subgroup ranges overlap; choose disjoint boundaries.")
            intervals.append((lo, hi, include_hi))
            names.append(name)
            # Half-open [lo, hi)
            labels = labels.mask((nums >= lo) & ((nums <= hi) if include_hi else (nums < hi)) & np.isfinite(nums), name)
        return labels, names

    raise AnalysisError(f"Unknown subgroup mode: {mode}")


def _fmt_num(v: float) -> str:
    if float(v).is_integer():
        return str(int(v))
    return f"{float(v):.2f}"


def build_subgroup_columns(
    df: pd.DataFrame,
    variables: Sequence[Dict[str, Any]],
    rna: Optional[pd.DataFrame] = None,
) -> Tuple[pd.DataFrame, List[str], List[str]]:
    """Attach one label column per variable and drop unmatched rows.

    Returns ``(dataframe, variable_names, group_names_per_variable)``.
    """
    work = df.copy()
    var_names: List[str] = []
    all_group_names: List[str] = []
    seen = set()

    for spec in variables:
        source = spec.get("source", "clinical")
        column = spec.get("column")
        mode = spec.get("mode", "tags")
        groups = spec.get("groups", [])
        if not column:
            raise AnalysisError("Every variable needs a column selected.")
        key = (source, column)
        if key in seen:
            raise AnalysisError("Select each subgroup variable only once.")
        seen.add(key)
        if not groups or len(groups) > 5:
            raise AnalysisError("Each variable needs between one and five complete groups.")
        if source not in ("clinical", "RNA"):
            raise AnalysisError("Unknown subgroup dataset.")
        value_column = column

        if source == "RNA":
            if rna is None:
                raise AnalysisError("An RNA variable was selected but no RNA file was loaded.")
            if column not in rna.columns:
                raise AnalysisError(f"RNA column not found: {column}")
            # Join the RNA values onto the clinical rows by patient id.
            value_column = f"__KM_RNA_VALUE_{len(var_names)}__"
            rna_sub = rna[[PATIENT_ID, column]].copy().rename(columns={column: value_column})
            rna_sub[value_column] = numeric_view(rna_sub[value_column])
            work = work.merge(rna_sub, on=PATIENT_ID, how="inner", validate="one_to_one")
            # Rows with no RNA measurement cannot be classified.
            work = work.loc[work[value_column].notna()].copy()
            if work.empty:
                raise AnalysisError("No matching patients with valid RNA measurements; check patient IDs and gene values.")
        else:
            if column not in discover_options(df)["subgroupOptions"]:
                raise AnalysisError("Patient IDs and survival endpoint columns cannot be subgroup variables.")
            if column not in work.columns:
                raise AnalysisError(f"Column not found in the dataset: {column}")

        labels, group_names = resolve_subgroup_values(work, value_column, mode, groups)
        label_col = f"__KM_GROUP_{len(var_names) + 1}__"
        work[label_col] = labels
        work = work.loc[work[label_col].notna()].copy()
        work[label_col] = work[label_col].astype(str)

        var_names.append(column)
        all_group_names.append(", ".join(group_names))

    return work, var_names, all_group_names


def make_cohorts(
    work: pd.DataFrame,
    var_names: Sequence[str],
    label_columns: Sequence[str],
) -> List[Tuple[str, pd.DataFrame]]:
    """Split the data into the cartesian product of the group columns.

    Each cohort is labelled ``"<var1 group> | <var2 group> | ..."`` and only
    non-empty cohorts are returned.
    """
    if not label_columns:
        return [("Whole dataset", work)]

    combos: List[Tuple[str, ...]] = [()]
    for col in label_columns:
        values = sorted(work[col].unique().tolist(), key=str)
        combos = [c + (v,) for c in combos for v in values]

    cohorts: List[Tuple[str, pd.DataFrame]] = []
    for combo in combos:
        mask = pd.Series(True, index=work.index)
        for col, value in zip(label_columns, combo):
            mask &= work[col] == value
        subset = work.loc[mask]
        if subset.empty:
            continue
        cohorts.append((" | ".join(str(c) for c in combo), subset))
    return cohorts


# --------------------------------------------------------------------------
# The top-level analysis
# --------------------------------------------------------------------------


def run_analysis(
    clinical: pd.DataFrame,
    rna: Optional[pd.DataFrame],
    time_column: str,
    event_column: str,
    no_event_values: Sequence[Any],
    event_values: Sequence[Any],
    variables: Optional[Sequence[Dict[str, Any]]] = None,
    alpha: float = 0.05,
) -> Dict[str, Any]:
    """Run the whole pipeline and return a JSON-ready result.

    ``variables`` is a list of ``{source, column, mode, groups}`` dicts; an
    empty list means "one curve for the whole dataset".
    """
    if not no_event_values or not event_values:
        raise AnalysisError(
            "Select the values to label as 'No event' and as 'Event' before generating the plot."
        )

    df = encode_events(clinical, event_column, no_event_values, event_values)
    df = to_numeric_time(df, time_column)

    n_after_event = len(df)
    if n_after_event == 0:
        raise AnalysisError(
            "No patients matched the selected event values. Check the 0/1 mapping."
        )

    variables = list(variables or [])
    if any(v.get("source", "clinical") == "clinical" and v.get("column") in (time_column, event_column) for v in variables):
        raise AnalysisError("Selected survival endpoint columns cannot be subgroup variables.")
    if len(variables) > 5:
        raise AnalysisError("Use at most five subgroup variables.")
    label_columns: List[str] = []
    var_names: List[str] = []
    group_names: List[str] = []

    if variables:
        work, var_names, group_names = build_subgroup_columns(df, variables, rna)
        label_columns = [f"__KM_GROUP_{i + 1}__" for i in range(len(var_names))]
        if work.empty:
            raise AnalysisError(
                "No patients left after applying the subgroup definitions. "
                "Check the selected values/ranges."
            )
    else:
        work = df

    cohorts = make_cohorts(work, var_names, label_columns)

    fits: List[KMFit] = []
    for label, subset in cohorts:
        if subset.empty:
            continue
        try:
            fit = fit_km(
                durations=subset[time_column].to_numpy(dtype=float),
                events=subset["__KM_EVENT__"].to_numpy(dtype=int),
                label=label,
                alpha=alpha,
            )
        except ValueError as exc:
            raise AnalysisError(f"Could not fit curve '{label}': {exc}") from exc
        fits.append(fit)

    if not fits:
        raise AnalysisError("No curve could be produced from the current selection.")

    # Axis ticks for the "at risk" table: the 0.1/0.2/... fractions of the
    # observed range, which is what the Streamlit app's matplotlib axis used.
    max_time = max((f.timeline[-1] if f.timeline else 0.0) for f in fits)
    ticks = _at_risk_ticks(max_time)

    return {
        "curves": [
            {
                **f.to_dict(),
                "atRisk": _at_risk_for(f, ticks),
            }
            for f in fits
        ],
        "ticks": ticks,
        "timeColumn": time_column,
        "eventColumn": event_column,
        "variables": var_names,
        "groupNames": group_names,
        "nPatients": int(n_after_event),
        "nInputPatients": int(len(clinical)),
        "nExcludedBeforeSubgroups": int(len(clinical) - n_after_event),
        "nExcludedBySubgroups": int(n_after_event - len(work)),
        "nPatientsAfterSubgrouping": int(len(work)),
        "nCurves": len(fits),
        "alpha": alpha,
    }


def _at_risk_ticks(max_time: float) -> List[float]:
    """Five evenly spaced ticks from 0 to ``max_time`` (inclusive)."""
    if max_time <= 0:
        return [0.0]
    step = max_time / 5.0
    return [round(step * i, 6) for i in range(6)]


def _at_risk_for(fit: KMFit, ticks: Sequence[float]) -> List[Dict[str, Any]]:
    from .kmlib import at_risk_table

    return at_risk_table(fit, ticks)
