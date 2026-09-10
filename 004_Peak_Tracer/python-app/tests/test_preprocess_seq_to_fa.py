"""Unit tests for v1.6 .bat preprocessing helpers (Task 4: .seq -> .fa)."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

# Make the peaktrace package importable
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from peaktrace.cli import convert_seq_to_fa  # noqa: E402


class ConvertSeqToFaTests(unittest.TestCase):
    def test_truth_name_from_filename_not_content(self):
        """The .bat 1- equivalent: the truth name comes from the FILENAME
        (last 8 chars stripped), NOT from the .seq file's first line.

        Most Seq7 .seq files have no `>header` line — line 1 is sequence data.
        If we used that line as the truth name, the .ab1 would be renamed to
        a 60-70 char garbage string. This test pins down the correct behavior.
        """
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            seq = tdp / "POS1-G12_G12.seq"
            seq.write_text(
                # No `>header` — first line is sequence (this is the Seq7 format)
                "TGTGAGCGGATAACAATTTCACACAGGAAACAGCTATGACCATGATTACGCCAAGCTATTTAGGTGACACTATAGAATAC\n"
                "ACGTACGTACGT\n",
                encoding="utf-8",
            )
            result = convert_seq_to_fa(seq)

            # .fa was created with the same stem, .seq deleted
            self.assertIsNotNone(result)
            self.assertEqual(result, tdp / "POS1-G12_G12.fa")
            self.assertFalse(seq.exists(), "original .seq must be deleted")

            # Header is `>POS1-G12` (filename with last 8 chars = "_G12.seq" stripped)
            # NOT the 60+ char sequence data
            fa_text = result.read_text(encoding="utf-8")
            lines = fa_text.splitlines()
            self.assertEqual(lines[0], ">POS1-G12")
            # Sequence lines preserved (no spaces to strip in this case)
            self.assertEqual(lines[1], "TGTGAGCGGATAACAATTTCACACAGGAAACAGCTATGACCATGATTACGCCAAGCTATTTAGGTGACACTATAGAATAC")
            self.assertEqual(lines[2], "ACGTACGTACGT")

    def test_handles_seq_file_with_header_line(self):
        """Some .seq files do have a `>header` line. The first line should be
        treated as a header (skipped) when it starts with '>'."""
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            seq = tdp / "SAMPLE_A01_B02.seq"
            seq.write_text(
                ">SAMPLE_A01_B02\nGCTA GCTA\n",
                encoding="utf-8",
            )
            result = convert_seq_to_fa(seq)
            self.assertIsNotNone(result)
            # Truth name = filename with last 8 chars stripped ("_B02.seq" removed)
            # SAMPLE_A01_B02.seq -> "SAMPLE_A01"  (14 - 8 = 6 chars... wait
            # let me count: S-A-M-P-L-E-_-A-0-1-_-B-0-2-.-s-e-q = 17 chars
            # 17 - 8 = 9 = "SAMPLE_A0". Actually the .bat result depends on
            # exact length. The point is: it comes from the FILENAME, not content.
            expected_name = "SAMPLE_A01_B02.seq"[:-8]
            lines = result.read_text(encoding="utf-8").splitlines()
            self.assertEqual(lines[0], f">{expected_name}")
            self.assertEqual(lines[1], "GCTAGCTA")

    def test_empty_file_returns_none(self):
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            seq = tdp / "EMPTY_C09.seq"
            seq.write_text("", encoding="utf-8")
            self.assertIsNone(convert_seq_to_fa(seq))
            # Original is NOT deleted when we fail
            self.assertTrue(seq.exists())

    def test_short_filename_skipped(self):
        """Filename shorter than 8 chars can't be stripped to 8 chars safely.
        Skip the file rather than produce a confusing empty-truth-name output."""
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            seq = tdp / "X.seq"   # 5 chars; stripping 8 = "" or error
            seq.write_text("ACGTACGT\n", encoding="utf-8")
            self.assertIsNone(convert_seq_to_fa(seq))
            self.assertTrue(seq.exists(), "short-filename file should NOT be deleted")


if __name__ == "__main__":
    unittest.main()