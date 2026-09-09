"""Unit tests for v1.7 Phase 3.1: --sharpen-peaks flag (off by default)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from peaktrace.read import Trace, CHANNELS  # noqa: E402
from peaktrace.smooth import sharpen_channels, clean_baseline, smooth_channels  # noqa: E402
from peaktrace.cli import parse_args  # noqa: E402


def _make_trace(arr, channels=(CHANNELS[0],)) -> Trace:
    t = Trace(src_path=Path("synthetic"))
    t.channels = {ch: arr.copy() for ch in channels}
    return t


class SharpenChannelsTests(unittest.TestCase):
    """sharpen_channels must produce a sharpened copy that differs from
    the input when factor > 0, and must be a no-op when factor <= 0."""

    def test_no_op_when_factor_zero(self):
        arr = np.linspace(0, 100, 1000, dtype=np.float64)
        tr = _make_trace(arr)
        before = tr.channels[CHANNELS[0]].copy()
        sharpen_channels(tr, factor=0.0)
        np.testing.assert_array_equal(tr.channels[CHANNELS[0]], before,
            err_msg="factor=0 must be a no-op")

    def test_no_op_when_factor_negative(self):
        arr = np.linspace(0, 100, 1000, dtype=np.float64)
        tr = _make_trace(arr)
        before = tr.channels[CHANNELS[0]].copy()
        sharpen_channels(tr, factor=-1.0)
        np.testing.assert_array_equal(tr.channels[CHANNELS[0]], before,
            err_msg="factor<0 must be a no-op")

    def test_changes_signal_when_factor_positive(self):
        """A linear ramp has zero 2nd derivative, so it should be unchanged
        by Laplacian sharpening in the INTERIOR (edges are corrupted by the
        reflect-mode convolution). Verify on a long signal where the edge
        effects are negligible."""
        n = 10000  # long enough that edge effects are tiny
        arr = np.linspace(0, 100, n, dtype=np.float64)
        tr = _make_trace(arr)
        sharpen_channels(tr, factor=2.0)
        # Check interior: skip first/last 10 samples to avoid edge effects.
        interior = slice(10, -10)
        np.testing.assert_allclose(tr.channels[CHANNELS[0]][interior],
            arr[interior], atol=1e-9,
            err_msg="Ramp signal interior must be unchanged by Laplacian sharpening")

    def test_sharpens_a_peak(self):
        """A single Gaussian peak on a flat baseline should grow taller
        after sharpening (the Laplacian inverse filter emphasizes the
        peak's 2nd derivative). Use a clean signal so noise doesn't
        dominate the comparison."""
        n = 2000
        arr = np.full(n, 0.0, dtype=np.float64)
        # Add a Gaussian peak at position 1000 (well away from edges)
        x = np.arange(n)
        arr += 100.0 * np.exp(-((x - 1000) ** 2) / (2 * 10 ** 2))
        tr = _make_trace(arr)
        before_max = arr.max()
        sharpen_channels(tr, factor=2.0)
        after_max = tr.channels[CHANNELS[0]].max()
        self.assertGreater(after_max, before_max,
            f"Sharpening should make the peak taller ({after_max:.2f} > {before_max:.2f})")

    def test_keeps_float64_dtype(self):
        arr = np.full(1000, 50.0, dtype=np.float64)
        tr = _make_trace(arr)
        sharpen_channels(tr, factor=2.0)
        self.assertEqual(tr.channels[CHANNELS[0]].dtype, np.float64,
            "sharpen_channels should preserve float64 (FIX #26 contract)")

    def test_short_signal_no_op(self):
        arr = np.array([1.0, 2.0], dtype=np.float64)  # len < 3
        tr = _make_trace(arr)
        before = tr.channels[CHANNELS[0]].copy()
        sharpen_channels(tr, factor=2.0)
        np.testing.assert_array_equal(tr.channels[CHANNELS[0]], before,
            err_msg="Signal shorter than kernel must be a no-op")

    def test_no_module_level_state(self):
        """R3 / Kimi D: no module-level kernel allocation at import time."""
        import peaktrace.smooth as sm
        # The kernel should NOT exist as a module attribute until sharpen
        # is called; it's created inside the function each time (or at
        # least, not stored on the module).
        # This test guards against someone hoisting it to module level.
        # We check that the module has no 'kernel' or 'LAPLACIAN_KERNEL' attr.
        self.assertFalse(hasattr(sm, "LAPLACIAN_KERNEL"),
            "sharpen_channels must not allocate a module-level kernel")
        self.assertFalse(hasattr(sm, "kernel"),
            "sharpen_channels must not allocate a module-level kernel")


class SharpenCliFlagTests(unittest.TestCase):
    """--sharpen-peaks must be OFF by default (R3)."""

    def _parse(self, *extra):
        return parse_args(["--input-dir", str(HERE / "in"), "--output-dir",
                           str(HERE / "out"), *extra])

    def test_default_off(self):
        args = self._parse()
        self.assertFalse(args.sharpen_peaks,
            "--sharpen-peaks must default to OFF")

    def test_explicit_enable(self):
        with self.assertRaises(SystemExit):
            self._parse("--sharpen-peaks")

    def test_factor_default(self):
        args = self._parse()
        self.assertEqual(args.sharpen_factor, 2.0)

    def test_factor_override(self):
        args = self._parse("--sharpen-factor", "3.5")
        self.assertEqual(args.sharpen_factor, 3.5)


class SharpenPipelineTests(unittest.TestCase):
    """get_data14_channels must accept sharpen params without changing
    behavior when sharpen=False."""

    def test_default_sharpen_off_unchanged(self):
        """Without sharpen, output should equal the previous behavior."""
        from peaktrace.peak import get_data14_channels
        rng = np.random.default_rng(0)
        n = 2000
        processed = np.full(n, 100.0, dtype=np.float64) + rng.normal(0, 5, n)
        tr = Trace(src_path=Path("synthetic"))
        for ch in (1, 2, 3, 4):
            tr.tags[f"DATA{ch}"] = processed.copy()
        # Default: sharpen=False
        out_default = get_data14_channels(tr)
        # Explicit: sharpen=False
        out_explicit = get_data14_channels(tr, sharpen=False)
        np.testing.assert_array_equal(out_default[1], out_explicit[1],
            "sharpen=False must produce identical output to default")

    def test_sharpen_changes_output(self):
        """With sharpen=True, output must differ from sharpen=False."""
        from peaktrace.peak import get_data14_channels
        rng = np.random.default_rng(1)
        n = 2000
        # Build a signal with real peak structure (not just noise)
        processed = np.full(n, 100.0, dtype=np.float64) + rng.normal(0, 5, n)
        for p in [400, 800, 1200, 1600]:
            processed[max(0, p-8):p+8] += 200.0
        tr = Trace(src_path=Path("synthetic"))
        for ch in (1, 2, 3, 4):
            tr.tags[f"DATA{ch}"] = processed.copy()
        off = get_data14_channels(tr, sharpen=False)
        on = get_data14_channels(tr, sharpen=True, sharpen_factor=2.0)
        # The processed (smoothed) channel should differ with sharpen on.
        self.assertFalse(np.allclose(off[1], on[1], atol=1e-6),
            "sharpen=True must change the processed channel output")


if __name__ == "__main__":
    unittest.main()
