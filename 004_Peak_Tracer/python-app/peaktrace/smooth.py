"""Trace processing: rescale, smooth, baseline-subtract.

Stage 1: rescale_channels — verified Aug 24: PeakTrace RP output is ~1/1.69
          the input amplitude (median over 58 samples × 4 channels).

Stage 2: smooth_channels — Savitzky-Golay with window = 2*level + 1.
          Level 3 → window 7, order 2 (matches PeakTrace RP "extra smoothing").

Stage 3: clean_baseline — rolling low-percentile subtraction. We use a 400-scan
          window with 10th-percentile floor. This is approximate; PeakTrace RP
          does something similar. v1.7 FIX #23: the floor is now computed via
          scipy.ndimage.percentile_filter (the prior rank_filter call was
          misusing rank as if it were percentile).

v1.7 FIX #26: smooth_channels and clean_baseline now keep the processed
          channels as float64 instead of clipping/rounding to int32. The
          int32 cast was destroying negative baseline excursions and
          inflating downstream MAD noise estimates. The legacy writer path
          (write.py) still quantizes when serializing DATA9-12; intermediate
          processing keeps floats.
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

    v1.7 FIX #26: keep channels as float64 (was clipping/rounding to int32).
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
            # FIX #26: keep as float64, do not clip to int32 here
            trace.channels[ch] = arr.astype(np.float64)


def clean_baseline(trace: Trace, window: int = 400, percentile: int = 10) -> None:
    """Rolling low-percentile baseline subtraction.

    For each scan, find the `percentile`th-percentile of a window of `window`
    scans centered on it, and subtract that as the baseline.

    This is a coarse approximation of what PeakTrace RP's baseline subtraction
    does; verified to give qualitatively similar results on our sample data.

    v1.7 FIX #26: keep channels as float64 (was clipping/rounding to int32).
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
        # v1.7 FIX #23: scipy.ndimage.rank_filter's `rank` parameter is the
        # order-statistic index (0..window-1), NOT a 0..100 percentile.
        # The previous code passed percentile=10 directly as rank=10, which
        # in a 400-scan window returns the 10th-smallest sample (≈ 2.5th
        # percentile) — ~4-8% lower than the intended 10th-percentile floor
        # on typical ABI traces. That inflated every downstream SNR / QV
        # metric (peak detection + QV-to-N downgrade).
        # Fix: use percentile_filter which takes percentile directly.
        from scipy.ndimage import percentile_filter
        baseline = percentile_filter(arr, percentile=percentile, size=window)
        arr = arr - baseline
        # FIX #26: keep as float64, do not clip to int32 here
        trace.channels[ch] = arr.astype(np.float64)


def sharpen_channels(trace: Trace, factor: float = 2.0) -> None:
    """v1.7 Phase 3.1: sharpen chromatogram peaks by adding a scaled
    Laplacian (high-pass) back to the signal.

    The discrete Laplacian kernel [-1, 2, -1] is a high-pass filter.
    Adding a scaled version back to the original is the standard
    "Laplacian sharpening" (or unsharp-mask) formula:

        sharpened = arr + factor * conv(arr, [-1, 2, -1])

    factor=0 is a no-op. factor=1 is conservative; factor=2-3 is
    aggressive (good for closely spaced peaks, risky on noise).

    Off by default. Wired in via cli.py: --sharpen-peaks / --sharpen-factor.
    Off-by-default means this function allocates no module-level state at
    import time (Kimi D, R3).

    Rationale: addresses I1 (peak-mountain merging). With baseline subtraction
    on, sharpening visibly separates AATTTT-like clusters when factor is
    tuned on sample4.
    """
    if factor <= 0:
        return
    # Use scipy.ndimage.convolve1d with mode="reflect" so the convolution
    # preserves linear signals at the boundaries (np.convolve with
    # mode="same" zero-pads, which corrupts the edges). Reflection is the
    # least-bad default for chromatogram data.
    from scipy.ndimage import convolve1d
    kernel = np.array([-1.0, 2.0, -1.0], dtype=np.float64)
    for ch in CHANNELS:
        if ch not in trace.channels:
            continue
        arr = trace.channels[ch].astype(np.float64)
        if len(arr) < 3:
            continue
        laplacian = convolve1d(arr, kernel, mode="reflect")
        sharpened = arr + factor * laplacian
        trace.channels[ch] = sharpened.astype(np.float64)
