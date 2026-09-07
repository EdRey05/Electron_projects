"""Unit tests for v1.7 Phase 3.4: --write-sidecar-trace flag (off by default)."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from peaktrace.sidecar import write_sidecar_trace  # noqa: E402
from peaktrace.cli import parse_args  # noqa: E402


class WriteSidecarTraceTests(unittest.TestCase):

    def test_writes_to_sidecar_subfolder(self):
        """Sidecars go in <output>/sidecar/, not the main output folder."""
        channels = {1: np.array([1.0, 2.0, 3.0]),
                    2: np.array([4.0, 5.0, 6.0]),
                    3: np.array([7.0, 8.0, 9.0]),
                    4: np.array([10.0, 11.0, 12.0])}
        with tempfile.TemporaryDirectory() as td:
            out_dir = Path(td)
            out_path = write_sidecar_trace(out_dir, "test", channels)
            self.assertEqual(out_path.parent, out_dir / "sidecar",
                "Sidecar must live in <output>/sidecar/")
            self.assertTrue(out_path.exists())

    def test_json_loadable(self):
        """Output must be valid JSON."""
        channels = {1: np.array([1.0, 2.0]),
                    2: np.array([3.0, 4.0]),
                    3: np.array([5.0, 6.0]),
                    4: np.array([7.0, 8.0])}
        with tempfile.TemporaryDirectory() as td:
            out_dir = Path(td)
            out_path = write_sidecar_trace(out_dir, "sample", channels)
            data = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertIn("channels", data)
            self.assertEqual(set(data["channels"].keys()), {"A", "C", "G", "T"})
            self.assertEqual(data["channels"]["A"], [1.0, 2.0])
            self.assertEqual(data["channels"]["T"], [7.0, 8.0])

    def test_creates_sidecar_subfolder_if_missing(self):
        """The function must create the sidecar/ subfolder if it does not exist."""
        channels = {1: np.array([1.0]), 2: np.array([1.0]),
                    3: np.array([1.0]), 4: np.array([1.0])}
        with tempfile.TemporaryDirectory() as td:
            out_dir = Path(td)
            self.assertFalse((out_dir / "sidecar").exists())
            write_sidecar_trace(out_dir, "x", channels)
            self.assertTrue((out_dir / "sidecar").exists())

    def test_missing_channel_yields_empty_array(self):
        """If a channel is absent from the dict, its JSON entry is empty."""
        channels = {1: np.array([1.0, 2.0])}  # only A
        with tempfile.TemporaryDirectory() as td:
            out_dir = Path(td)
            out_path = write_sidecar_trace(out_dir, "x", channels)
            data = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(data["channels"]["A"], [1.0, 2.0])
            self.assertEqual(data["channels"]["C"], [])
            self.assertEqual(data["channels"]["G"], [])
            self.assertEqual(data["channels"]["T"], [])

    def test_basename_used(self):
        channels = {1: np.array([1.0]), 2: np.array([1.0]),
                    3: np.array([1.0]), 4: np.array([1.0])}
        with tempfile.TemporaryDirectory() as td:
            out_dir = Path(td)
            out_path = write_sidecar_trace(out_dir, "WELL01_C09", channels)
            self.assertEqual(out_path.name, "WELL01_C09.sidecar.json")


class WriteSidecarCliFlagTests(unittest.TestCase):

    def _parse(self, *extra):
        return parse_args(["--input-dir", str(HERE / "in"), "--output-dir",
                           str(HERE / "out"), *extra])

    def test_default_off(self):
        args = self._parse()
        self.assertFalse(args.write_sidecar_trace)

    def test_explicit_enable(self):
        args = self._parse("--write-sidecar-trace")
        self.assertTrue(args.write_sidecar_trace)


if __name__ == "__main__":
    unittest.main()
