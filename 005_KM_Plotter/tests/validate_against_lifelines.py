"""Validate the re-implemented KM estimator against real lifelines 0.27.8.

Run with the *reference* interpreter (the one that has lifelines installed):
    ./kmold/Scripts/python.exe validate_against_lifelines.py

It imports our implementation, fits both on the same data, and compares the
survival function, the confidence bounds, the median and the event table.
"""
import os
import sys

import numpy as np
import pandas as pd

from lifelines import KaplanMeierFitter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python-app"))

from kmplot.kmlib import fit_km  # noqa: E402

BASE = r"C:\Users\Administrator\Desktop\Github_EdRey05\Streamlit_projects\Test_units\Project 003"

FAILURES = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    if not cond:
        FAILURES.append(f"{name}: {detail}")
    print(f"  [{status}] {name} {detail}")


def compare(label, durations, events):
    print(f"\n=== {label} (n={len(durations)}) ===")
    kmf = KaplanMeierFitter()
    kmf.fit(durations=durations, event_observed=events)

    ours = fit_km(durations, events, label=label)

    # --- survival function ---
    ref_sf = kmf.survival_function_.iloc[:, 0]
    ref_t = np.asarray(ref_sf.index, dtype=float)
    ref_v = ref_sf.to_numpy(dtype=float)
    our_t = np.asarray(ours.timeline, dtype=float)
    our_v = np.asarray(ours.survival, dtype=float)

    check("timeline length", len(ref_t) == len(our_t), f"ref={len(ref_t)} ours={len(our_t)}")
    if len(ref_t) == len(our_t):
        check("timeline values", np.allclose(ref_t, our_t, rtol=0, atol=1e-12),
              f"max diff={np.max(np.abs(ref_t - our_t)) if len(ref_t) else 0}")
        max_sf = np.max(np.abs(ref_v - our_v)) if len(ref_v) else 0.0
        check("survival values", max_sf < 1e-12, f"max diff={max_sf:.3e}")

    # --- confidence intervals ---
    ref_ci = kmf.confidence_interval_
    ref_lo = ref_ci.iloc[:, 0].to_numpy(dtype=float)
    ref_hi = ref_ci.iloc[:, 1].to_numpy(dtype=float)
    our_lo = np.asarray(ours.lower, dtype=float)
    our_hi = np.asarray(ours.upper, dtype=float)
    if len(ref_lo) == len(our_lo):
        max_lo = np.max(np.abs(ref_lo - our_lo))
        max_hi = np.max(np.abs(ref_hi - our_hi))
        check("CI lower", max_lo < 1e-10, f"max diff={max_lo:.3e}")
        check("CI upper", max_hi < 1e-10, f"max diff={max_hi:.3e}")
    else:
        check("CI length", False, f"ref={len(ref_lo)} ours={len(our_lo)}")

    # --- median ---
    ref_med = kmf.median_survival_time_
    check("median", (ref_med == ours.median) or abs(ref_med - ours.median) < 1e-9,
          f"ref={ref_med} ours={ours.median}")

    # --- event table ---
    ref_et = kmf.event_table
    check("event table rows", len(ref_et) == len(ours.event_table),
          f"ref={len(ref_et)} ours={len(ours.event_table)}")
    if len(ref_et) == len(ours.event_table):
        ok = True
        for k, (t, row) in enumerate(ref_et.iterrows()):
            o = ours.event_table[k]
            if (
                abs(float(t) - o["time"]) > 1e-12
                or int(row["removed"]) != o["removed"]
                or int(row["observed"]) != o["observed"]
                or int(row["censored"]) != o["censored"]
                or int(row["at_risk"]) != o["atRisk"]
            ):
                ok = False
                print(f"      row {k} differs: ref={dict(row)} ours={o}")
                break
        check("event table values", ok)


def main():
    print("=" * 70)
    print("Validating kmplot.kmlib.fit_km against lifelines", __import__("lifelines").__version__)
    print("=" * 70)

    # 1. Synthetic dataset, no subgroups
    syn = pd.read_csv(os.path.join(BASE, "clinical_synthetic.txt"), sep="\t", comment="#")
    d = syn["OS_MONTHS"].to_numpy(dtype=float)
    e = (syn["OS_STATUS"].astype(str) == "Dead").astype(int).to_numpy()
    compare("synthetic_nosub", d, e)

    # 2. Subgroup by tag
    m = syn["S1"] == "Treatment_B"
    compare("synthetic_sub_S1_B", syn.loc[m, "OS_MONTHS"].to_numpy(dtype=float),
            (syn.loc[m, "OS_STATUS"].astype(str) == "Dead").astype(int).to_numpy())

    # 3. Subgroup by numeric range
    m = (syn["S2"] >= 100) & (syn["S2"] < 500)
    compare("synthetic_sub_S2_range", syn.loc[m, "OS_MONTHS"].to_numpy(dtype=float),
            (syn.loc[m, "OS_STATUS"].astype(str) == "Dead").astype(int).to_numpy())

    # 4. METABRIC
    met = pd.read_csv(os.path.join(BASE, "clinical_METABRIC.txt"), sep="\t", comment="#")
    met = met.loc[met["OS_STATUS"].notna()]
    e = met["OS_STATUS"].astype(str).map({"0:LIVING": 0, "1:DECEASED": 1}).astype(int).to_numpy()
    compare("metabric_nosub", met["OS_MONTHS"].to_numpy(dtype=float), e)

    # 5. SIDRA-LUMC
    sid = pd.read_csv(os.path.join(BASE, "clinical_SIDRA-LUMC.txt"), sep="\t", comment="#")
    e = sid["OS_STATUS"].astype(str).map({"0:LIVING": 0, "1:DECEASED": 1}).astype(int).to_numpy()
    keep = ~pd.isna(e)
    compare("sidra_nosub", sid.loc[keep, "OS_MONTHS"].to_numpy(dtype=float), e[keep])

    # 6. Edge cases
    print("\n=== edge cases ===")
    # all censored
    compare("all_censored", np.array([1.0, 2.0, 3.0]), np.array([0, 0, 0]))
    # all events
    compare("all_events", np.array([1.0, 2.0, 3.0]), np.array([1, 1, 1]))
    # single subject
    compare("single", np.array([5.0]), np.array([1]))
    # ties
    compare("ties", np.array([1.0, 1.0, 1.0, 2.0]), np.array([1, 0, 1, 1]))
    # zero time
    compare("zero_time", np.array([0.0, 1.0, 2.0]), np.array([1, 0, 1]))

    print("\n" + "=" * 70)
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}):")
        for f in FAILURES:
            print("  -", f)
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
