"""Coordinate mapping between DATA1-4 (full-resolution) and DATA9-12 (Seq7-truncated).

DATA1-4 are the processed color-separated channels at ~18.7k scans.
DATA9-12 are the final channels Seq7 writes at ~16k scans (truncated).
The mapping between them is approximately linear per file: data14_pos ≈ a * data9_pos + b

We learn (a, b) per file by aligning Seq7's PLOC positions (in DATA9-12 coords)
to the nearest strong peak in DATA1-4. If the fit is poor (r² < 0.99), the file
is not a linear rescale and we fall back to trust-input.
"""
from __future__ import annotations
import numpy as np
from .read import Trace


def learn_coordinate_map(trace: Trace, n_anchor: int = 200) -> dict:
    """Learn DATA9-12 → DATA1-4 coordinate mapping from Seq7's PLOC anchors.

    For each of the first `n_anchor` Seq7 peak locations, find the nearest
    strong peak in the combined DATA1-4 signal and regress.

    Returns dict with keys: slope, intercept, n_matched, r_squared, ok
    `ok=False` means the mapping failed — caller should fall back to trust-input.
    """
    from scipy.signal import find_peaks

    out = {"slope": np.nan, "intercept": np.nan, "n_matched": 0, "r_squared": 0.0, "ok": False}

    # Need DATA1-4 and Seq7 PLOCs
    full = {}
    for ch in (1, 2, 3, 4):
        tag = f"DATA{ch}"
        if tag in trace.tags:
            arr = np.asarray(trace.tags[tag], dtype=np.float64)
            if len(arr) > 100:
                full[ch] = arr
    if not full or len(trace.ploc_in) < 20:
        return out

    # Combined max signal across DATA1-4 for anchor-finding
    n_full = len(next(iter(full.values())))
    combined = np.zeros(n_full, dtype=np.float64)
    for arr in full.values():
        combined = np.maximum(combined, arr)

    noise = max(1.0, float(np.percentile(combined, 5)))
    full_peaks, _ = find_peaks(combined, prominence=noise * 2.0, distance=5)
    if len(full_peaks) < 20:
        return out

    # Anchors: first n_anchor PLOCs, mapped to initial guess positions
    plocs9 = trace.ploc_in[:n_anchor].astype(np.float64)
    ratio_init = n_full / trace.n_scans
    plocs_full_init = plocs9 * ratio_init

    matched_9 = []
    matched_full = []
    half_window = max(5, int(10 * ratio_init))
    for p9, pf in zip(plocs9, plocs_full_init):
        lo = max(0, int(pf) - half_window)
        hi = min(n_full, int(pf) + half_window + 1)
        in_window = full_peaks[(full_peaks >= lo) & (full_peaks <= hi)]
        if len(in_window) == 0:
            continue
        # nearest peak to the initial guess
        nearest = int(in_window[np.argmin(np.abs(in_window - pf))])
        matched_9.append(p9)
        matched_full.append(float(nearest))

    if len(matched_9) < 15:
        return out

    x = np.array(matched_9)
    y = np.array(matched_full)
    # Least-squares fit y = a*x + b
    a, b = np.polyfit(x, y, 1)
    y_pred = a * x + b
    ss_res = float(np.sum((y - y_pred) ** 2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0

    out.update({
        "slope": float(a),
        "intercept": float(b),
        "n_matched": len(x),
        "r_squared": r2,
        "ok": r2 >= 0.99 and 0.9 <= a <= 1.6,
    })
    return out


def map_to_data9(pos14: np.ndarray, map_params: dict) -> np.ndarray:
    """Map DATA1-4 positions back to DATA9-12 coords."""
    a = map_params["slope"]
    b = map_params["intercept"]
    if not np.isfinite(a) or a == 0:
        return pos14.astype(np.int32)
    return np.round((pos14 - b) / a).astype(np.int32)


def map_to_data14(pos9: np.ndarray, map_params: dict) -> np.ndarray:
    """Map DATA9-12 positions to DATA1-4 coords."""
    a = map_params["slope"]
    b = map_params["intercept"]
    if not np.isfinite(a):
        return pos9.astype(np.int32)
    return np.round(pos9 * a + b).astype(np.int32)
