"""Unit tests for v1.7 FIX #23: clean_baseline rank_filter -> percentile_filter.

Background: smooth.py:clean_baseline was passing the 0..100 percentile value
directly as scipy.ndimage.rank_filter's `rank` parameter, which expects an
order-statistic index in [0, window-1]. At the default percentile=10,
window=400 this returned rank 10 of 400 (the ~2.5th percentile), not the
10th percentile the docstring promised. The fix swaps rank_filter for
percentile_filter, which takes percentile directly.
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
from peaktrace.smooth import clean_baseline  # noqa: E402


def _make_trace(arr: np.ndarray) -> Trace:
    """Build a minimal Trace with one channel populated with `arr`."""
    t = Trace(src_path=Path("synthetic"))
    t.channels = {CHANNELS[0]: arr.copy()}
    return t


class CleanBaselinePercentileTests(unittest.TestCase):
    """Verify clean_baseline actually computes the requested percentile."""

    def test_baseline_matches_percentile_filter(self):
        """Output baseline should equal scipy.ndimage.percentile_filter
        of the input on the same window/percentile."""
        rng = np.random.default_rng(42)
        n = 4000
        # baseline with low-frequency drift + Gaussian noise + a few peaks
        t = np.arange(n)
        baseline_true = 80 + 20 * np.sin(2 * np.pi * t / 800) + rng.normal(0, 5, n)
        arr = baseline_true.copy()
        for p in [300, 900, 1600, 2500, 3300]:
            arr[max(0, p - 8):p + 8] += 400.0

        tr = _make_trace(arr)
        clean_baseline(tr, window=400, percentile=10)

        # The processed (subtracted) signal lives in trace.channels now
        # (cast to int32 with clip), but we want the BASELINE itself.
        # Recompute it from the same input for the assertion.
        expected_baseline = percentile_filter(arr, percentile=10, size=400)
        # Subtract the expected baseline from the input (no clip) to get
        # the "would-be" post-clean_baseline float signal.
        expected_post = arr - expected_baseline
        # The actual output is clipped+round+int32. Compare those.
        actual_post = tr.channels[CHANNELS[0]].astype(np.float64)
        np.testing.assert_allclose(
            actual_post, np.clip(np.round(expected_post), 0, 65535),
            atol=1.0,
            err_msg="clean_baseline output does not match percentile_filter",
        )

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
        # And the gap should be small but non-trivial (we saw ~5/60 = ~8%
        # on similar signals). Loose lower bound to avoid flakiness.
        self.assertGreater(correct_median - buggy_median, 1.0)

    def test_no_op_on_short_signal(self):
        """Signals shorter than the window should be returned unchanged
        (matching the existing early-return)."""
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


if __name__ == "__main__":
    unittest.main()
