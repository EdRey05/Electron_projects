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
    def test_strips_well_id_and_spaces(self):
        """The .bat 1- equivalent: strip last 8 chars of first line (well-ID),
        write `>name` header, strip spaces from sequence lines, delete .seq."""
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            seq = tdp / "WELL01_C09.seq"
            seq.write_text(
                ">WELL01_C09_H12\n"
                "ACGT ACGT ACGT\n"
                "TGCA TGCA\n",
                encoding="utf-8",
            )
            result = convert_seq_to_fa(seq)

            # .fa was created and .seq was deleted
            self.assertIsNotNone(result)
            self.assertEqual(result, tdp / "WELL01_C09.fa")
            self.assertFalse(seq.exists(), "original .seq must be deleted")

            # Content: header has well-ID stripped, sequence has spaces stripped
            fa_text = result.read_text(encoding="utf-8")
            lines = fa_text.splitlines()
            self.assertEqual(lines[0], ">WELL01")
            self.assertEqual(lines[1], "ACGTACGTACGT")
            self.assertEqual(lines[2], "TGCATGCA")

    def test_handles_header_without_gt_lt(self):
        """The .bat uses `set /p` which reads raw first line. Some .seq files
        don't start with `>` — strip it anyway if present."""
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            seq = tdp / "SAMPLE_A01.seq"
            seq.write_text(
                ">SAMPLE_A01_B02\nGCTA GCTA\n",
                encoding="utf-8",
            )
            result = convert_seq_to_fa(seq)
            self.assertIsNotNone(result)
            self.assertEqual(result.read_text(encoding="utf-8").splitlines()[0], ">SAMPLE")

    def test_empty_file_returns_none(self):
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            seq = tdp / "EMPTY_C09.seq"
            seq.write_text("", encoding="utf-8")
            self.assertIsNone(convert_seq_to_fa(seq))
            # Original is NOT deleted when we fail
            self.assertTrue(seq.exists())

    def test_short_header_kept_verbatim(self):
        """If the first line is shorter than 8 chars (no well-ID present),
        keep the line as-is. Mirrors the .bat's `set outname=!outname:~0,-8!`
        which on Windows returns the empty string when length < 8 — but in
        our Python impl, slicing `s[:-8]` on a short string returns '' which
        is wrong. We keep the whole line as the header in that case."""
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            seq = tdp / "SHORT.seq"
            seq.write_text(">SHORT\nACGT\n", encoding="utf-8")
            result = convert_seq_to_fa(seq)
            self.assertIsNotNone(result)
            self.assertEqual(result.read_text(encoding="utf-8").splitlines()[0], ">SHORT")


if __name__ == "__main__":
    unittest.main()