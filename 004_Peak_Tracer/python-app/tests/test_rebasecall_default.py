"""Unit tests for v1.7 rebasecall default flip.

Before v1.7: --rebasecall-data14 defaulted to False. CLI users had to
remember to pass the flag, otherwise rebasecall was silently skipped
and ~9% of bases weren't recovered (verified on sample4).

v1.7: default ON (matches UI behavior, which has always added the
flag explicitly). New --no-rebasecall-data14 negation flag.
"""
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
    def test_default_on(self):
        """Plain `peaktrace_core.py --input-dir X --output-dir Y` must
        have args.rebasecall_data14 == True. This is the v1.7 fix."""
        args = parse_args(["--input-dir", "x", "--output-dir", "y"])
        self.assertTrue(args.rebasecall_data14,
                        "rebasecall must default ON in v1.7")

    def test_explicit_enable(self):
        args = parse_args(["--input-dir", "x", "--output-dir", "y",
                           "--rebasecall-data14"])
        self.assertTrue(args.rebasecall_data14)

    def test_explicit_disable(self):
        args = parse_args(["--input-dir", "x", "--output-dir", "y",
                           "--no-rebasecall-data14"])
        self.assertFalse(args.rebasecall_data14)

    def test_negation_overrides_default(self):
        """--no-rebasecall-data14 must win over the default-True."""
        args = parse_args(["--input-dir", "x", "--output-dir", "y",
                           "--rebasecall-data14",
                           "--no-rebasecall-data14"])
        self.assertFalse(args.rebasecall_data14)

    def test_no_flag_means_default(self):
        """No rebasecall flag in argv means default-True."""
        args = parse_args(["--input-dir", "x", "--output-dir", "y"])
        self.assertTrue(args.rebasecall_data14)


if __name__ == "__main__":
    unittest.main()
