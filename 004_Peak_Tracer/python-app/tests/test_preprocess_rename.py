"""Unit tests for v1.6 .bat preprocessing helpers (Task 5: rename + Task 6: cleanup)."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from peaktrace.cli import (  # noqa: E402
    extract_truth_name,
    run_preprocessing,
)


class FakeArgs:
    """Minimal argparse.Namespace stand-in for run_preprocessing."""
    def __init__(self, preprocess=True):
        self.preprocess = preprocess


class ExtractTruthNameTests(unittest.TestCase):
    def test_fa_header_with_ab1_ext(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "ORIG.fa"
            p.write_text(">REALNAME.ab1\nACGT\n", encoding="utf-8")
            self.assertEqual(extract_truth_name(p), "REALNAME")

    def test_fa_header_without_ab1_ext(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "ORIG.fa"
            p.write_text(">REALNAME\nACGT\n", encoding="utf-8")
            self.assertEqual(extract_truth_name(p), "REALNAME")

    def test_txt_single_line(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "ORIG.txt"
            p.write_text(">REALNAME_C09.ab1\n", encoding="utf-8")
            self.assertEqual(extract_truth_name(p), "REALNAME_C09")

    def test_fasta_works_like_fa(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "ORIG.fasta"
            p.write_text(">REAL.ab1\nACGT\n", encoding="utf-8")
            self.assertEqual(extract_truth_name(p), "REAL")

    def test_empty_returns_none(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "EMPTY.fa"
            p.write_text("", encoding="utf-8")
            self.assertIsNone(extract_truth_name(p))

    def test_path_separator_rejected(self):
        """Defensive: don't let a malformed rename-source rename files outside the folder."""
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "BAD.fa"
            p.write_text(">../escape.ab1\n", encoding="utf-8")
            self.assertIsNone(extract_truth_name(p))

    def test_non_rename_source_returns_none(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "OTHER.ab1"
            p.write_text("anything", encoding="utf-8")
            self.assertIsNone(extract_truth_name(p))


class RunPreprocessingIntegrationTests(unittest.TestCase):
    """End-to-end: full preprocess pass on a fake folder."""
    def test_full_preprocess_pass(self):
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)

            # 1 .seq to convert
            (tdp / "WELL01_C09.seq").write_text(
                ">WELL01_C09_H12\nACGT ACGT\nTGCA TGCA\n", encoding="utf-8",
            )
            # Fake matching .ab1 (not real ABI, but the rename just moves it)
            (tdp / "WELL01_C09.ab1").write_text("fake ab1 content", encoding="utf-8")

            # 1 .fa rename-source that points the existing .ab1 to REALNAME
            (tdp / "RENAME_SRC.fa").write_text(
                ">REALNAME.ab1\nACGT\n", encoding="utf-8",
            )
            (tdp / "RENAME_SRC.ab1").write_text("fake ab1 content", encoding="utf-8")

            args = FakeArgs(preprocess=True)
            counts = run_preprocessing(tdp, args)

            # .seq -> .fa: 1 done
            self.assertEqual(counts["seq_to_fa"], 1)
            self.assertEqual(counts["seq_failed"], 0)
            # renames: 2 — the .fa rename-source (RENAME_SRC.fa -> REALNAME.ab1)
            # AND the .seq-derived .fa (WELL01_C09.fa -> WELL01.ab1) which is
            # also picked up by the rename step.
            self.assertEqual(counts["renames_done"], 2)
            self.assertEqual(counts["renames_failed"], 0)
            # txt cleanup: 2 (the renamed .fa becomes .txt + the .txt from rename-source)
            self.assertGreaterEqual(counts["txt_removed"], 2)

            # After the pass:
            # - .seq file gone (converted to .fa, which then became .txt then deleted)
            self.assertFalse((tdp / "WELL01_C09.seq").exists())
            self.assertFalse((tdp / "WELL01_C09.fa").exists())
            # - .ab1 files renamed to match their truth names
            self.assertTrue((tdp / "WELL01.ab1").exists(), "WELL01_C09.ab1 should rename to WELL01.ab1")
            self.assertTrue((tdp / "REALNAME.ab1").exists(), "RENAME_SRC.ab1 should rename to REALNAME.ab1")
            # - All .txt files cleaned up
            self.assertEqual(list(tdp.glob("*.txt")), [], "no .txt should remain after cleanup")

    def test_preprocess_skipped_when_disabled(self):
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            (tdp / "WELL01_C09.seq").write_text(">WELL01_C09\nACGT\n", encoding="utf-8")
            (tdp / "WELL01_C09.ab1").write_text("fake", encoding="utf-8")

            args = FakeArgs(preprocess=False)
            counts = run_preprocessing(tdp, args)

            # No conversions happened
            self.assertEqual(counts["seq_to_fa"], 0)
            self.assertTrue((tdp / "WELL01_C09.seq").exists())
            self.assertTrue((tdp / "WELL01_C09.fa") is False or not (tdp / "WELL01_C09.fa").exists())


if __name__ == "__main__":
    unittest.main()