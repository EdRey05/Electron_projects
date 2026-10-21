"""Kaplan-Meier estimator — a faithful re-implementation of
``lifelines.KaplanMeierFitter`` (v0.27.8, the version the original Streamlit
app pins), written in plain NumPy so the app needs no scientific Python
runtime.

Why re-implement instead of depending on ``lifelines``?

* The app ships as a single portable ``.exe``; fewer wheels means a smaller,
  more reliable build.
* The algorithm is small and completely specified, and this module is
  unit-tested against the real ``lifelines`` output (see ``tests/``).

The formulas are taken verbatim from ``lifelines`` 0.27.8:

* event table (``lifelines.utils.survival_table_from_events``)
* additive estimate + Greenwood variance (``lifelines.utils._additive_estimate``)
* exponential Greenwood confidence bounds (``KaplanMeierFitter._bounds``)
* median survival time (``lifelines.utils.qth_survival_time``)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

#: Two-sided normal quantile for 95% confidence (scipy.stats.norm.ppf(0.975)).
Z_975 = 1.959963984540054


# --------------------------------------------------------------------------
# Event table
# --------------------------------------------------------------------------


def survival_table_from_events(
    durations: np.ndarray,
    event_observed: np.ndarray,
) -> pd.DataFrame:
    """Build the life table.

    Mirrors ``lifelines.utils.survival_table_from_events`` for the
    right-censored, no-late-entry case (which is what this app uses):

    =============  ======================================================
    ``removed``    number leaving the risk set at that time
    ``observed``   number of events (deaths) at that time
    ``censored``   number censored at that time
    ``entrance``   number entering the risk set at that time (0 here)
    ``at_risk``    number at risk *just before* that time
    =============  ======================================================
    """
    df = pd.DataFrame({"event_at": np.asarray(durations, dtype=float)})
    df["removed"] = 1
    df["observed"] = np.asarray(event_observed, dtype=int)

    death_table = df.groupby("event_at").sum()
    death_table["censored"] = (death_table["removed"] - death_table["observed"]).astype(int)

    # No late entry: everybody enters at time 0.
    births_table = pd.DataFrame({"event_at": [0.0], "entrance": [len(df)]})
    event_table = death_table.join(births_table, how="outer", sort=True).fillna(0)
    event_table["at_risk"] = (
        event_table["entrance"].cumsum() - event_table["removed"].cumsum().shift(1).fillna(0)
    )
    event_table = event_table.sort_index()
    return event_table.astype(int)


# --------------------------------------------------------------------------
# Additive estimate (log-survival) and Greenwood variance
# --------------------------------------------------------------------------


def _additive_estimate(
    event_table: pd.DataFrame,
    timeline: np.ndarray,
) -> Tuple[pd.Series, pd.Series]:
    """Return (log survival estimate, cumulative Greenwood variance).

    Reproduces ``lifelines.utils._additive_estimate`` for right-censored data
    with no late entry. The population used in the hazard increment is
    ``at_risk - entrance``; with entrance == 0 this is just ``at_risk``.
    """
    deaths = event_table["observed"]
    entrances = event_table["entrance"].copy()
    entrances.iloc[0] = 0
    population = event_table["at_risk"] - entrances

    with np.errstate(invalid="ignore", divide="ignore"):
        # log((n - d) / n) — the log of the KM hazard multiplier.
        estimate = np.cumsum(np.log(population - deaths) - np.log(population))
        # Greenwood variance increment d / (n * (n - d)).
        var_increment = (deaths / (population * (population - deaths))).replace([np.inf], 0)
    var_ = np.cumsum(var_increment)

    timeline = np.sort(timeline)
    estimate = estimate.reindex(timeline, method="pad").ffill()
    var_ = var_.reindex(timeline, method="pad").ffill()
    estimate.index.name = "timeline"
    var_.index.name = "timeline"
    return estimate, var_


def _bounds(
    survival: pd.DataFrame,
    cumulative_sq: pd.Series,
    alpha: float,
) -> pd.DataFrame:
    """Exponential-Greenwood (log-log) confidence bounds.

    Mirrors ``KaplanMeierFitter._bounds`` in lifelines 0.27.8.
    """
    z = Z_975 if abs(alpha - 0.05) < 1e-12 else _norm_ppf(1 - alpha / 2)
    df = pd.DataFrame(index=survival.index)
    v = np.log(survival.values)
    # lifelines uses cumulative_sq_.values[:, None] so the variance broadcasts
    # against the (n, 1) survival matrix.
    #
    # When S == 1 (no event yet) the log-log transform divides by zero; that
    # yields NaN, which lifelines turns into 1.0 via fillna(1.0) below. The
    # same happens when the risk set empties out. We suppress the warnings
    # rather than letting them spam the console.
    with np.errstate(invalid="ignore", divide="ignore"):
        se = np.sqrt(cumulative_sq.values[:, None]) / v

        df["lower"] = np.exp(-np.exp(np.log(-v) - z * se))
        df["upper"] = np.exp(-np.exp(np.log(-v) + z * se))
    # lifelines fills NaNs (S == 1) with 1.0
    return df.fillna(1.0)


def _norm_ppf(p: float) -> float:
    """Inverse standard normal CDF (Acklam's rational approximation).

    Used only when the user picks a confidence level other than 95%, so the
    common path stays exact.
    """
    if not 0.0 < p < 1.0:
        raise ValueError("p must be in (0, 1)")
    a = [-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02,
         1.383577518672690e02, -3.066479806614716e01, 2.506628277459239e00]
    b = [-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02,
         6.680131188771972e01, -1.328068155288572e01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00,
         -2.549732539343734e00, 4.374664141464968e00, 2.938163982698783e00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00,
         3.754408661907416e00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = np.sqrt(-2 * np.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > phigh:
        q = np.sqrt(-2 * np.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (
        ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


# --------------------------------------------------------------------------
# Median survival time
# --------------------------------------------------------------------------


def qth_survival_time(q: float, survival: pd.Series) -> float:
    """Time at which the survival function first drops to ``q``.

    Mirrors ``lifelines.utils.qth_survival_time`` for a Series: if the curve
    never reaches ``q`` the result is ``inf``.
    """
    if survival.iloc[-1] > q:
        return float("inf")
    return float(survival.index[(-survival).searchsorted([-q])[0]])


# --------------------------------------------------------------------------
# The fitter
# --------------------------------------------------------------------------


@dataclass
class KMFit:
    """Result of fitting the Kaplan-Meier estimator to one cohort."""

    label: str
    n: int
    n_events: int
    n_censored: int
    timeline: List[float]
    survival: List[float]
    lower: List[float]
    upper: List[float]
    median: float
    event_table: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "label": self.label,
            "n": self.n,
            "nEvents": self.n_events,
            "nCensored": self.n_censored,
            "timeline": self.timeline,
            "survival": self.survival,
            "lower": self.lower,
            "upper": self.upper,
            "median": self.median,
            "eventTable": self.event_table,
        }


def fit_km(
    durations: Sequence[float],
    events: Sequence[int],
    label: str = "KM_estimate",
    alpha: float = 0.05,
) -> KMFit:
    """Fit the Kaplan-Meier estimator.

    Parameters
    ----------
    durations:
        Observed follow-up time per subject (must be numeric, non-NaN).
    events:
        1 = event observed, 0 = right-censored. Must be the same length.
    label:
        Name for the resulting curve.
    alpha:
        Significance level for the confidence band (0.05 → 95% CI).
    """
    d = np.asarray(durations, dtype=float)
    e = np.asarray(events, dtype=int)

    if len(d) != len(e):
        raise ValueError("durations and events must have the same length")
    if len(d) == 0:
        raise ValueError("No rows left to fit — every patient was filtered out.")
    if not np.all(np.isfinite(d)):
        raise ValueError("Time-to-event values contain NaN or infinite values.")

    event_table = survival_table_from_events(d, e)
    timeline = event_table.index.values.astype(float)

    log_estimate, cumulative_sq = _additive_estimate(event_table, timeline)

    survival = pd.DataFrame(np.exp(log_estimate.values), index=timeline, columns=[label])
    ci = _bounds(survival, cumulative_sq, alpha)

    median = qth_survival_time(0.5, survival[label])

    et_rows = []
    for t, row in event_table.iterrows():
        et_rows.append(
            {
                "time": float(t),
                "removed": int(row["removed"]),
                "observed": int(row["observed"]),
                "censored": int(row["censored"]),
                "atRisk": int(row["at_risk"]),
            }
        )

    return KMFit(
        label=label,
        n=int(len(d)),
        n_events=int(e.sum()),
        n_censored=int(len(e) - e.sum()),
        timeline=[float(t) for t in timeline],
        survival=[float(v) for v in survival[label].values],
        lower=[float(v) for v in ci["lower"].values],
        upper=[float(v) for v in ci["upper"].values],
        median=float(median),
        event_table=et_rows,
    )


# --------------------------------------------------------------------------
# Numbers at risk (for the "at risk" table under the plot)
# --------------------------------------------------------------------------


def at_risk_table(
    fit: KMFit,
    ticks: Sequence[float],
) -> List[Dict[str, Any]]:
    """Number at risk / censored / events at each of ``ticks``.

    Mirrors ``lifelines.plotting.add_at_risk_counts``: the at-risk count is
    taken at the *end* of the period (i.e. ``at_risk - removed``), and the
    censored/events counts are cumulative up to the tick.
    """
    rows: List[Dict[str, Any]] = []
    for tick in ticks:
        at_risk = 0
        censored = 0
        events = 0
        seen = False
        for row in fit.event_table:
            if row["time"] <= tick + 1e-9:
                at_risk = row["atRisk"] - row["removed"]
                censored += row["censored"]
                events += row["observed"]
                seen = True
        rows.append({"t": float(tick), "atRisk": int(at_risk), "censored": int(censored), "events": int(events)})
    return rows
