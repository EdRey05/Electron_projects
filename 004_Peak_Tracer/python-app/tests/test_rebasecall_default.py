"""The unsafe v1.7 raw-gap insertion path is disabled and cannot be enabled."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from peaktrace.cli import parse_args


class RebasecallDefaultTests(unittest.TestCase):
    def test_default_off(self):
        """The default must use the measured resolution pipeline."""
        args = parse_args(["--input-dir", "x", "--output-dir", "y"])
        self.assertFalse(args.rebasecall_data14,
                         "The disproven v1.7 gap insertion path must not run")

    def test_explicit_enable(self):
        with self.assertRaises(SystemExit):
            parse_args(["--input-dir", "x", "--output-dir", "y",
                        "--rebasecall-data14"])

    def test_explicit_disable(self):
        args = parse_args(["--input-dir", "x", "--output-dir", "y",
                           "--no-rebasecall-data14"])
        self.assertFalse(args.rebasecall_data14)

    def test_negation_overrides_default(self):
        """Conflicting switches must fail explicitly."""
        with self.assertRaises(SystemExit):
            parse_args(["--input-dir", "x", "--output-dir", "y",
                        "--rebasecall-data14", "--no-rebasecall-data14"])

    def test_no_flag_means_default(self):
        """No flag must leave the retired path disabled."""
        args = parse_args(["--input-dir", "x", "--output-dir", "y"])
        self.assertFalse(args.rebasecall_data14)


if __name__ == "__main__":
    unittest.main()
