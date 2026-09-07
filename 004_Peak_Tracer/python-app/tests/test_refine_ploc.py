"""Unit tests for v1.7 Phase 3.3: --refine-ploc flag (off by default).

Snap PLOC positions to the local maximum within ±window scans on a
given channel. Off by default; the live pipeline is unchanged when the
flag is off.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from peaktrace.peak import refine_ploc_to_local_max, REFINE_PLOC_ENABLED  # noqa: E402
from peaktrace.cli import parse_args  # noqa: E402


class RefinePlocTests(unittest.TestCase):

    def test_no_op_when_already_at_max(self):
        """If the input PLOC is already at the local max, output is unchanged."""
        n = 100
        x = np.arange(n, dtype=np.float64)
        channel = np.exp(-((x - 50) ** 2) / (2 * 5 ** 2))
        ploc_in = np.array([50], dtype=np.int32)
        ploc_out = refine_ploc_to_local_max(ploc_in, channel, window=2)
        self.assertEqual(int(ploc_out[0]), 50)

    def test_snaps_to_local_max(self):
        """A peak at scan 50 with a higher local max at scan 52 should snap."""
        n = 100
        x = np.arange(n, dtype=np.float64)
        channel = np.zeros(n, dtype=np.float64)
        # Bump at 50, but bigger bump at 52
        channel[50] = 5.0
        channel[52] = 10.0
        ploc_in = np.array([50], dtype=np.int32)
        ploc_out = refine_ploc_to_local_max(ploc_in, channel, window=2)
        self.assertEqual(int(ploc_out[0]), 52,
            f"Should snap to local max at 52, got {int(ploc_out[0])}")

    def test_window_zero_no_op(self):
        """window=0 must return a copy with no modification."""
        n = 100
        channel = np.arange(n, dtype=np.float64)
        ploc_in = np.array([10, 50, 90], dtype=np.int32)
        ploc_out = refine_ploc_to_local_max(ploc_in, channel, window=0)
        np.testing.assert_array_equal(ploc_out, ploc_in)
        # Verify it returned a copy (not the same object) so callers
        # can safely mutate the input afterwards.
        self.assertIsNot(ploc_out, ploc_in)

    def test_window_negative_no_op(self):
        """Negative window must be a no-op."""
        n = 100
        channel = np.arange(n, dtype=np.float64)
        ploc_in = np.array([10], dtype=np.int32)
        ploc_out = refine_ploc_to_local_max(ploc_in, channel, window=-1)
        np.testing.assert_array_equal(ploc_out, ploc_in)

    def test_edge_handling_low(self):
        """Position 0 must not crash; window is clipped to signal bounds."""
        n = 100
        channel = np.arange(n, dtype=np.float64)
        ploc_in = np.array([0], dtype=np.int32)
        ploc_out = refine_ploc_to_local_max(ploc_in, channel, window=2)
        # Window becomes [0:3]; max is at index 2 (value 2)
        self.assertEqual(int(ploc_out[0]), 2)

    def test_edge_handling_high(self):
        """Position n-1 must not crash."""
        n = 100
        channel = np.arange(n, dtype=np.float64)
        ploc_in = np.array([n - 1], dtype=np.int32)
        ploc_out = refine_ploc_to_local_max(ploc_in, channel, window=2)
        # Window becomes [n-3:n]; max is at index n-1 (value n-1)
        self.assertEqual(int(ploc_out[0]), n - 1)

    def test_empty_ploc(self):
        channel = np.zeros(100, dtype=np.float64)
        ploc_in = np.array([], dtype=np.int32)
        ploc_out = refine_ploc_to_local_max(ploc_in, channel, window=2)
        self.assertEqual(len(ploc_out), 0)

    def test_dtype_preserved(self):
        """Output dtype must be int32 (matches the rest of the pipeline)."""
        n = 100
        channel = np.zeros(n, dtype=np.float64)
        ploc_in = np.array([50], dtype=np.int32)
        ploc_out = refine_ploc_to_local_max(ploc_in, channel, window=2)
        self.assertEqual(ploc_out.dtype, np.int32)


class RefinePlocCliFlagTests(unittest.TestCase):

    def _parse(self, *extra):
        return parse_args(["--input-dir", str(HERE / "in"), "--output-dir",
                           str(HERE / "out"), *extra])

    def test_default_off(self):
        """--refine-ploc must default to OFF (R3)."""
        args = self._parse()
        self.assertFalse(args.refine_ploc)

    def test_explicit_enable(self):
        args = self._parse("--refine-ploc")
        self.assertTrue(args.refine_ploc)


class RefinePlocModuleFlagTests(unittest.TestCase):

    def test_module_flag_default_off(self):
        self.assertFalse(REFINE_PLOC_ENABLED)


if __name__ == "__main__":
    unittest.main()
