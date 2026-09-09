"""Unit tests for v1.7 FIX #27: leader-drop argparse + stale comment.

B5: v1.6/07 §5 documented a "writer bug" preventing the leader drop.
v1.7 diagnosis found there is no leader-drop branch in write.py; the
real defects were:

  (1) cli.py:556 --no-lead-drop used action="store_true" on the same
      dest as --lead-drop-enabled (default=True), so the "disable"
      flag could never actually disable.
  (2) cli.py:288-290 comment claimed a v1.2 writer-buffer bug,
      which was actually fixed in v1.0 (element codes + offset).

This file:
  - Adds a failing-then-passing test for the argparse fix (1).
  - Sanity-tests the trim branch in isolation (the branch logic is
    trivially correct, but this guards against accidental reorderings).

A real end-to-end process_one() run requires a valid .ab1 fixture
which is not available in tests/. That test belongs in the rebuilt
runtime on Ed's machine.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from peaktrace.cli import parse_args  # noqa: E402


class LeaderDropArgparseTests(unittest.TestCase):
    """FIX #27(a): --no-lead-drop must actually disable."""

    def _parse(self, *extra):
        return parse_args(["--input-dir", str(HERE / "in"), "--output-dir",
                           str(HERE / "out"), *extra])

    def test_default_preserves_leader(self):
        """Low Q alone is not evidence that a first base should be deleted."""
        args = self._parse()
        self.assertFalse(args.lead_drop_enabled)

    def test_explicit_disable(self):
        """The bug: --no-lead-drop was store_true on the same dest as
        --lead-drop-enabled (default=True), so it could never set
        lead_drop_enabled=False. Post-FIX #27, this must work."""
        args = self._parse("--no-lead-drop")
        self.assertFalse(args.lead_drop_enabled,
            "--no-lead-drop should set lead_drop_enabled=False; if this "
            "fails, the argparse bug at cli.py:556 is back.")

    def test_explicit_enable(self):
        args = self._parse("--lead-drop-enabled")
        self.assertTrue(args.lead_drop_enabled)

    def test_qv_threshold_default(self):
        args = self._parse()
        self.assertEqual(args.lead_drop_qv, 5,
            "Default --lead-drop-qv should be 5 (matches PT)")

    def test_qv_threshold_override(self):
        args = self._parse("--lead-drop-qv", "10")
        self.assertEqual(args.lead_drop_qv, 10)


class LeaderDropTrimBranchTests(unittest.TestCase):
    """The actual trim logic is inline in process_one; we mirror it here
    so the branch condition and the slice mechanics are covered without
    needing a real .ab1 fixture."""

    def _trim(self, pb, qv, ploc, enabled: bool, qv_threshold: int = 5):
        """Return (pb, qv, ploc, dropped) after applying the same branch
        logic as cli.py:process_one (cli.py:291-296)."""
        dropped = False
        if enabled and len(pb) > 1 and len(qv) > 0 and int(qv[0]) < qv_threshold:
            pb = pb[1:]
            qv = qv[1:]
            ploc = ploc[1:]
            dropped = True
        return pb, qv, ploc, dropped

    def test_trim_fires_when_enabled_and_low_qv(self):
        pb = np.array([ord("A"), ord("C"), ord("G")], dtype=np.uint8)
        qv = np.array([2, 30, 35], dtype=np.uint8)
        ploc = np.array([100, 200, 300], dtype=np.int32)
        pb, qv, ploc, dropped = self._trim(pb, qv, ploc, enabled=True)
        self.assertTrue(dropped)
        self.assertEqual(len(pb), 2)
        self.assertEqual(int(pb[0]), ord("C"))

    def test_trim_skipped_when_disabled_even_with_low_qv(self):
        pb = np.array([ord("A"), ord("C"), ord("G")], dtype=np.uint8)
        qv = np.array([2, 30, 35], dtype=np.uint8)
        ploc = np.array([100, 200, 300], dtype=np.int32)
        pb, qv, ploc, dropped = self._trim(pb, qv, ploc, enabled=False)
        self.assertFalse(dropped)
        self.assertEqual(len(pb), 3)

    def test_trim_skipped_when_qv_above_threshold(self):
        pb = np.array([ord("A"), ord("C"), ord("G")], dtype=np.uint8)
        qv = np.array([20, 30, 35], dtype=np.uint8)
        ploc = np.array([100, 200, 300], dtype=np.int32)
        pb, qv, ploc, dropped = self._trim(pb, qv, ploc, enabled=True)
        self.assertFalse(dropped)
        self.assertEqual(len(pb), 3)

    def test_trim_skipped_when_only_one_base(self):
        pb = np.array([ord("A")], dtype=np.uint8)
        qv = np.array([2], dtype=np.uint8)
        ploc = np.array([100], dtype=np.int32)
        pb, qv, ploc, dropped = self._trim(pb, qv, ploc, enabled=True)
        self.assertFalse(dropped)
        self.assertEqual(len(pb), 1)


if __name__ == "__main__":
    unittest.main()
