"""Trace processing: rescale, smooth, baseline-subtract.

Stage 1: rescale_channels — verified Aug 24: PeakTrace RP output is ~1/1.69
          the input amplitude (median over 58 samples × 4 channels).

Stage 2: smooth_channels — Savitzky-Golay with window = 2*level + 1.
          Level 3 → window 7, order 2 (matches PeakTrace RP "extra smoothing").

Stage 3: clean_baseline — rolling low-percentile subtraction. We use a 400-scan
          window with 10th-percentile floor. This is approximate; PeakTrace RP
          does something similar.
"""
from __future__ import annotations
import numpy as np
from scipy.signal import savgol_filter
from .read import Trace, CHANNELS


def rescale_channels(trace: Trace, factor: float) -> None:
    """Multiply each channel by `factor` in-place.

    Verified Aug 24 (58 samples): input/output max amplitude ratio ≈ 1.69
    across all 4 channels (A, C, G, T).
    """
    if factor == 1.0:
        return
    for ch in CHANNELS:
        if ch in trace.channels:
            trace.channels[ch] = (trace.channels[ch].astype(np.float64) * factor).astype(np.int32)


def smooth_channels(trace: Trace, level: int = 3, order: int = 2) -> None:
    """Apply Savitzky-Golay smoothing to each channel.

    window = 2 * level + 1   (level 0 → no smoothing; level 3 → window 7)
    """
    if level <= 0:
        return
    window = 2 * level + 1
    # scipi savgol requires odd window and window <= len
    n = trace.n_scans
    if n < window:
        return
    for ch in CHANNELS:
        if ch in trace.channels:
            arr = trace.channels[ch].astype(np.float64)
            arr = savgol_filter(arr, window_length=window, polyorder=order)
            trace.channels[ch] = np.clip(np.round(arr), 0, 65535).astype(np.int32)


def clean_baseline(trace: Trace, window: int = 400, percentile: int = 10) -> None:
    """Rolling low-percentile baseline subtraction.

    For each scan, find the `percentile`th-percentile of a window of `window`
    scans centered on it, and subtract that as the baseline.

    This is a coarse approximation of what PeakTrace RP's baseline subtraction
    does; verified to give qualitatively similar results on our sample data.
    """
    if window <= 1:
        return
    half = window // 2
    for ch in CHANNELS:
        if ch not in trace.channels:
            continue
        arr = trace.channels[ch].astype(np.float64)
        n = len(arr)
        if n < window:
            continue
        # Efficient: use scipy.ndimage.rank_filter for percentile in a window
        from scipy.ndimage import rank_filter
        baseline = rank_filter(arr, rank=percentile, size=window)
        arr = arr - baseline
        trace.channels[ch] = np.clip(np.round(arr), 0, 65535).astype(np.int32)
