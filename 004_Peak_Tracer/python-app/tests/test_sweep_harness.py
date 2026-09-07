"""Unit tests for v1.7 Phase 2: sweep harness helper functions."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

# The sweep harness is a script, not a package module. Import it directly
# so the helper functions can be exercised without spinning up a sweep run.
_spec = importlib.util.spec_from_file_location(
    "sweep_baseline_smooth", HERE / "sweep_baseline_smooth.py",
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
aatttt_separation_score = _mod.aatttt_separation_score


class AattttScoreFallbackTests(unittest.TestCase):
    """Kimi R7: AATTTT separation score must have a fallback."""

    def test_returns_zero_on_flat_signal(self):
        # Flat signal — no peaks at all.
        flat = np.zeros(1000, dtype=np.float64)
        score = aatttt_separation_score(flat)
        self.assertEqual(score, 0.0,
            "Degenerate signal must return 0, not NaN")

    def test_returns_positive_on_real_peaks(self):
        x = np.arange(1000, dtype=np.float64)
        # Several Gaussian peaks
        signal = np.zeros(1000, dtype=np.float64)
        for i, p in enumerate([100, 300, 500, 700, 900]):
            signal += np.exp(-((x - p) ** 2) / (2 * 5 ** 2))
        score = aatttt_separation_score(signal)
        self.assertGreater(score, 0.0)

    def test_short_signal_no_crash(self):
        # Signal too short to have 5 peaks.
        signal = np.array([1.0, 2.0, 3.0], dtype=np.float64)
        score = aatttt_separation_score(signal)
        self.assertEqual(score, 0.0)


if __name__ == "__main__":
    unittest.main()
