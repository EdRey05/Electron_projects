"""Unit tests for v1.7 Phase 3.2: --enhanced-qv zone-aware QV downgrade.

Off by default. When on, uses zone-aware thresholds (head/middle/tail)
instead of a single global threshold. PCON values are NOT modified
(R11); only the base character changes at low-QV positions.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from peaktrace.peak import (  # noqa: E402
    apply_qv_to_n_downgrade,
    apply_qv_to_n_downgrade_zone_aware,
    ENHANCED_QV_ENABLED,
)
from peaktrace.cli import parse_args  # noqa: E402


class ZoneAwareDowngradeTests(unittest.TestCase):

    def test_default_zone_thresholds(self):
        """Defaults: head=5, middle=5, tail=2.
        With QV=4 everywhere:
          head:    QV=4 <= 5 -> N (indices 0..9)
          middle:  QV=4 <= 5 -> N (indices 10..69)
          tail:    QV=4 > 2 -> stays A (indices 70..99)
        The asymmetry (head/middle more aggressive than tail at QV=4) is
        a deliberate consequence of the default tail_threshold=2 being
        numerically lower; this test pins the default behavior.
        """
        n = 100
        ploc = np.linspace(100, 10000, n, dtype=np.int32)
        qv = np.full(n, 4, dtype=np.uint8)
        pb = np.full(n, ord("A"), dtype=np.uint8)
        pb_new, _, _ = apply_qv_to_n_downgrade_zone_aware(
            pb, ploc, qv,
            head_threshold=5, middle_threshold=5, tail_threshold=2,
            head_frac=0.1, tail_frac=0.3,
        )
        # Head: indices 0..9
        self.assertTrue(np.all(pb_new[0:10] == ord("N")),
            f"Head zone QV=4 should be N at threshold=5; got {pb_new[0:10]}")
        # Middle: indices 10..69
        self.assertTrue(np.all(pb_new[10:70] == ord("N")),
            f"Middle zone QV=4 should be N at threshold=5; got {pb_new[10:70]}")
        # Tail: indices 70..99
        self.assertTrue(np.all(pb_new[70:] == ord("A")),
            f"Tail zone QV=4 should stay A at threshold=2; got {pb_new[70:]}")

    def test_tail_more_aggressive_when_tail_threshold_lower(self):
        """At QV=4, head/middle thresholds of 4 mean QV=4 is N.
        With head=4, middle=4, tail=3, tail stays A (4 > 3).
        With head=4, middle=4, tail=4, everything is N.
        Use QV=5 with thresholds (head=10, middle=10, tail=3) — at this
        threshold middle is lenient (5 > 10 false, 5 <= 10 true -> N), so
        this doesn't differentiate. Need thresholds where the spread matters.
        """
        # Use QV=5 and thresholds head=10, middle=10, tail=4.
        # middle (5 <= 10) -> N; tail (5 > 4) -> stays A.
        # That makes tail LESS aggressive, which is wrong.
        # The right test: thresholds head=3, middle=3, tail=10.
        # middle (5 > 3) -> stays A; tail (5 <= 10) -> N.
        # Tail IS more aggressive here.
        n = 100
        ploc = np.linspace(100, 10000, n, dtype=np.int32)
        qv = np.full(n, 5, dtype=np.uint8)
        pb = np.full(n, ord("A"), dtype=np.uint8)
        pb_new, _, _ = apply_qv_to_n_downgrade_zone_aware(
            pb, ploc, qv,
            head_threshold=3, middle_threshold=3, tail_threshold=10,
            head_frac=0.1, tail_frac=0.3,
        )
        # Head (10): QV=5 > 3 -> stays A
        self.assertTrue(np.all(pb_new[0:10] == ord("A")),
            f"Head QV=5 at threshold=3 should stay A; got {pb_new[0:10]}")
        # Middle (60): QV=5 > 3 -> stays A
        self.assertTrue(np.all(pb_new[10:70] == ord("A")),
            f"Middle QV=5 at threshold=3 should stay A; got {pb_new[10:70]}")
        # Tail (30): QV=5 <= 10 -> N
        self.assertTrue(np.all(pb_new[70:] == ord("N")),
            f"Tail QV=5 at threshold=10 should be N; got {pb_new[70:]}")

    def test_preserves_existing_Ns(self):
        """Bases already marked N must remain N."""
        n = 50
        ploc = np.linspace(100, 5000, n, dtype=np.int32)
        qv = np.full(n, 30, dtype=np.uint8)  # high QV everywhere
        pb = np.full(n, ord("A"), dtype=np.uint8)
        pb[5] = ord("N")  # one N at index 5
        pb_new, _, _ = apply_qv_to_n_downgrade_zone_aware(pb, ploc, qv)
        self.assertEqual(int(pb_new[5]), ord("N"), "Existing N must be preserved")
        self.assertTrue(np.sum(pb_new == ord("N")) == 1, "No new Ns should be added")

    def test_pcon_unchanged(self):
        """R11: PCON (QV array) must NOT be modified."""
        n = 50
        ploc = np.linspace(100, 5000, n, dtype=np.int32)
        qv = np.full(n, 4, dtype=np.uint8)  # low QV everywhere
        pb = np.full(n, ord("A"), dtype=np.uint8)
        _, _, qv_out = apply_qv_to_n_downgrade_zone_aware(pb, ploc, qv)
        np.testing.assert_array_equal(qv_out, qv,
            "QV (PCON) values must not change under zone-aware downgrade")

    def test_empty_input(self):
        pb = np.array([], dtype=np.uint8)
        ploc = np.array([], dtype=np.int32)
        qv = np.array([], dtype=np.uint8)
        pb_new, ploc_out, qv_out = apply_qv_to_n_downgrade_zone_aware(pb, ploc, qv)
        self.assertEqual(len(pb_new), 0)

    def test_all_same_ploc_position(self):
        """Degenerate case: all PLOCs are the same. Should not crash."""
        n = 10
        ploc = np.full(n, 5000, dtype=np.int32)
        qv = np.full(n, 3, dtype=np.uint8)
        pb = np.full(n, ord("A"), dtype=np.uint8)
        pb_new, _, _ = apply_qv_to_n_downgrade_zone_aware(pb, ploc, qv)
        # All positions are "middle" (in the degenerate case, head_frac=0.1
        # means head_cutoff = 5000 + 0.1 * 0 = 5000, tail_cutoff = 5000).
        # Every position is exactly at the boundary; falls to "middle" branch.
        # With middle_threshold=5, QV=3 <= 5 -> all N.
        self.assertTrue(np.all(pb_new == ord("N")))


class EnhancedQvCliFlagTests(unittest.TestCase):

    def _parse(self, *extra):
        return parse_args(["--input-dir", str(HERE / "in"), "--output-dir",
                           str(HERE / "out"), *extra])

    def test_default_off(self):
        """--enhanced-qv must default to OFF (R3)."""
        args = self._parse()
        self.assertFalse(args.enhanced_qv)

    def test_explicit_enable(self):
        args = self._parse("--enhanced-qv")
        self.assertTrue(args.enhanced_qv)


class EnhancedQvModuleFlagTests(unittest.TestCase):

    def test_module_flag_default_off(self):
        """ENHANCED_QV_ENABLED must default to False."""
        self.assertFalse(ENHANCED_QV_ENABLED)


if __name__ == "__main__":
    unittest.main()
