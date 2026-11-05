"""Type-aware distributions for the same eligible population used by KM fitting."""
import math
import numpy as np
import pandas as pd
from . import dataio
from .analysis import encode_events, to_numeric_time


def eligible_clinical(job):
    df = dataio.load_clinical(job.get("clinicalPath") or job["path"])
    endpoint = job.get("role") in ("time", "event")
    if not endpoint and job.get("eventColumn") and (job.get("noEventValues") or job.get("eventValues")):
        df = encode_events(df, job["eventColumn"], job.get("noEventValues", []), job.get("eventValues", []))
    if not endpoint and job.get("timeColumn"):
        df = to_numeric_time(df, job["timeColumn"])
    return df


def profile(job):
    source = job.get("source", "clinical")
    column = job["column"]
    df = eligible_clinical(job)
    eligible = len(df)
    if source == "RNA":
        rna = dataio.load_rna(job["rnaPath"], [column])
        df = df[[dataio.PATIENT_ID]].merge(rna, on=dataio.PATIENT_ID, how="inner", validate="one_to_one")
        if df.empty:
            raise ValueError("No matching patient IDs between the eligible clinical cohort and RNA data.")
    if column not in df:
        raise ValueError(f"Column not found: {column}")
    s = df[column]
    info = dataio.describe_column(df, column)
    nums = pd.to_numeric(s, errors="coerce").replace([np.inf, -np.inf], np.nan)
    finite = nums.dropna()
    numeric = source == "RNA" or job.get("role") == "time" or dataio.is_numeric(s)
    categorical = job.get("role") == "event" or (source != "RNA" and job.get("role") != "time" and (not numeric or finite.nunique() <= 10))
    mode = "tags" if categorical else "ranges"
    info.update({"mode": mode, "kind": "categories" if categorical else "histogram", "source": source,
                 "nEligible": eligible, "nMatched": len(df), "nMissing": int(s.isna().sum()),
                 "nInvalid": int((s.notna() & nums.isna()).sum()) if numeric else 0,
                 "nFinite": int(len(finite)) if numeric else int(s.notna().sum()), "numeric": numeric, "constant": s.nunique(dropna=True) == 1})
    values = dataio.value_counts(df.loc[nums.notna()] if numeric else df, column, limit=len(df)) if categorical else []
    distribution = None
    if numeric and len(finite):
        integral = bool(np.equal(finite, np.floor(finite)).all())
        step = 1 if integral and source != "RNA" else 0.1
        info.update({"min": float(finite.min()), "max": float(finite.max()), "median": float(finite.median()),
                     "step": step, "constant": bool(finite.nunique() == 1),
                     "quantiles": [float(finite.quantile(q)) for q in (0, .25, .5, .75, 1)]})
        if categorical:
            # Canonical integer labels remain matchable even if NaNs promoted the dtype.
            for value in values:
                value["label"] = str(int(float(value["value"]))) if integral else str(value["value"])
        else:
            copy = pd.DataFrame({column: nums})
            distribution = dataio.histogram(copy, column)
    if categorical:
        distribution = {"kind": "categories", "values": values, "n": int(s.notna().sum()), "nMissing": info["nMissing"]}
    return {"ok": True, "column": info, "values": values, "distribution": distribution,
            "histogram": distribution if not categorical else None}
