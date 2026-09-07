"""Unit tests for v1.7 FIX #23 + FIX #26: clean_baseline and smooth_channels.

FIX #23: smooth.py:clean_baseline was passing the 0..100 percentile value
directly as scipy.ndimage.rank_filter's `rank` parameter, which expects an
order-statistic index in [0, window-1]. At the default percentile=10,
window=400 this returned rank 10 of 400 (the ~2.5th percentile), not the
10th percentile the docstring promised. The fix swaps rank_filter for
percentile_filter, which takes percentile directly.

FIX #26: smooth_channels and clean_baseline used to clip/round their output
to int32, destroying negative baseline excursions and inflating downstream
MAD noise estimates. They now keep channels as float64. The legacy writer
path (write.py) still quantizes when serializing DATA9-12.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np
from scipy.ndimage import percentile_filter, rank_filter

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from peaktrace.read import Trace, CHANNELS  # noqa: E402
from peaktrace.smooth import clean_baseline, smooth_channels  # noqa: E402


def _make_trace(arr: np.ndarray, channels=(CHANNELS[0],)) -> Trace:
    """Build a minimal Trace with one or more channels populated with `arr`."""
    t = Trace(src_path=Path("synthetic"))
    t.channels = {ch: arr.copy() for ch in channels}
    return t


class CleanBaselinePercentileTests(unittest.TestCase):
    """FIX #23: verify clean_baseline computes the requested percentile."""

    def test_baseline_matches_percentile_filter(self):
        """Output should equal arr - percentile_filter(arr, p, size=w)
        (now kept as float64 after FIX #26)."""
        rng = np.random.default_rng(42)
        n = 4000
        t = np.arange(n)
        baseline_true = 80 + 20 * np.sin(2 * np.pi * t / 800) + rng.normal(0, 5, n)
        arr = baseline_true.copy()
        for p in [300, 900, 1600, 2500, 3300]:
            arr[max(0, p - 8):p + 8] += 400.0

        tr = _make_trace(arr)
        clean_baseline(tr, window=400, percentile=10)

        expected = (arr - percentile_filter(arr, percentile=10, size=400)).astype(np.float64)
        actual = tr.channels[CHANNELS[0]].astype(np.float64)
        np.testing.assert_allclose(actual, expected, rtol=1e-9,
            err_msg="clean_baseline output does not match percentile_filter result")

    def test_regression_old_rank_filter_gave_different_value(self):
        """Sanity: confirm the OLD rank_filter call would have given a
        DIFFERENT baseline at the same percentile/window, proving the
        fix changes behavior in the right direction (baseline raises)."""
        rng = np.random.default_rng(42)
        n = 4000
        t = np.arange(n)
        baseline_true = 80 + 20 * np.sin(2 * np.pi * t / 800) + rng.normal(0, 5, n)
        arr = baseline_true.copy()
        for p in [300, 900, 1600, 2500, 3300]:
            arr[max(0, p - 8):p + 8] += 400.0

        buggy = rank_filter(arr, rank=10, size=400)
        correct = percentile_filter(arr, percentile=10, size=400)

        buggy_median = float(np.median(buggy))
        correct_median = float(np.median(correct))
        # The bug made the baseline too low, so the correct floor is HIGHER.
        self.assertGreater(
            correct_median, buggy_median,
            f"Expected percentile_filter floor ({correct_median:.2f}) > "
            f"rank_filter floor ({buggy_median:.2f}); if equal, the bug "
            "is not reproducible on this signal.",
        )
        self.assertGreater(correct_median - buggy_median, 1.0)

    def test_no_op_on_short_signal(self):
        """Signals shorter than the window should be returned unchanged."""
        n = 200  # less than default window=400
        arr = np.full(n, 100.0, dtype=np.float64) + np.arange(n, dtype=np.float64)
        tr = _make_trace(arr)
        before = tr.channels[CHANNELS[0]].copy()
        clean_baseline(tr, window=400, percentile=10)
        np.testing.assert_array_equal(
            tr.channels[CHANNELS[0]], before,
            err_msg="clean_baseline should be a no-op when n < window",
        )

    def test_no_op_on_window_one(self):
        """window <= 1 is the documented no-op guard."""
        n = 100
        arr = np.arange(n, dtype=np.float64)
        tr = _make_trace(arr)
        before = tr.channels[CHANNELS[0]].copy()
        clean_baseline(tr, window=1, percentile=10)
        np.testing.assert_array_equal(tr.channels[CHANNELS[0]], before)


class KeepFloatsThroughProcessingTests(unittest.TestCase):
    """FIX #26: processed channels must stay as float64 (no int32 clip)."""

    def test_clean_baseline_keeps_float64_dtype(self):
        arr = np.full(1000, 50.0, dtype=np.float64)
        tr = _make_trace(arr)
        clean_baseline(tr, window=400, percentile=10)
        self.assertEqual(tr.channels[CHANNELS[0]].dtype, np.float64,
            "clean_baseline should leave channels as float64 (FIX #26)")

    def test_smooth_channels_keeps_float64_dtype(self):
        arr = np.full(1000, 50.0, dtype=np.float64)
        tr = _make_trace(arr)
        smooth_channels(tr, level=3, order=2)
        self.assertEqual(tr.channels[CHANNELS[0]].dtype, np.float64,
            "smooth_channels should leave channels as float64 (FIX #26)")

    def test_clean_baseline_preserves_negative_excursions(self):
        """The original int32 cast clipped negative values to 0, hiding
        legitimate negative excursions below the baseline. After FIX #26
        a known-negative array must round-trip with its negative values
        intact (modulo the baseline subtraction itself)."""
        # Build a signal whose 10th percentile is positive, but with some
        # negative noise excursions around the baseline.
        rng = np.random.default_rng(7)
        arr = np.full(2000, 100.0, dtype=np.float64)
        arr += rng.normal(0, 8, 2000)
        # Force some negative excursions below zero
        arr[100:110] = -5.0
        arr[500:510] = -3.0
        tr = _make_trace(arr)
        clean_baseline(tr, window=400, percentile=10)
        out = tr.channels[CHANNELS[0]]
        # After baseline subtraction, we should be able to find values that
        # are negative (signal went below baseline). Pre-FIX #26 these
        # would have been clipped to 0.
        self.assertLess(out.min(), 0.0,
            "After FIX #26, negative excursions below the baseline must "
            "survive — pre-fix they were clipped to 0 by the int32 cast.")

    def test_clean_baseline_negative_input_through_detect_peaks(self):
        """R6: detect_peaks_data14 must accept a processed signal that
        contains negative values without crashing or silently truncating.
        This is the regression guard for FIX #26."""
        from peaktrace.peak import detect_peaks_data14
        rng = np.random.default_rng(11)
        # Minimal synthetic trace with DATA1-4 tags carrying a processed
        # signal that has negative excursions (the realistic post-FIX-26
        # state).
        n = 2000
        processed = np.full(n, 100.0, dtype=np.float64)
        processed += rng.normal(0, 10, n)
        processed[200:210] = -2.0  # negative excursion
        tr = Trace(src_path=Path("synthetic"))
        for ch in (1, 2, 3, 4):
            tr.tags[f"DATA{ch}"] = processed.copy()
        # Should not raise.
        peaks = detect_peaks_data14(tr, min_snr=1.3, distance=8, adaptive_fill=False)
        # Should return a dict keyed by channel.
        self.assertIsInstance(peaks, dict)


if __name__ == "__main__":
    unittest.main()
