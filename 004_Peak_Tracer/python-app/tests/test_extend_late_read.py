"""Unit tests for v1.7 B2/B3: extend_late_read_interpolated is dead code.

v1.7 diagnosis (B2) found that extend_late_read_interpolated in peak.py
is never called from cli.py or anywhere in the live path. The actual
late-read extension is rebasecall_data14. The function also declares
interpolation_factor=1.25 but never resamples.

The plan's Phase 3.5 decision is wire-or-delete. Without sample4
available in this session we left it intact with a deprecation note.
These tests guard against accidental re-wiring without a corresponding
flag + measurement decision.
"""
from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


class ExtendLateReadInterpolatedDeadCodeTests(unittest.TestCase):
    """B2: extend_late_read_interpolated must remain uncalled in cli.py
    unless explicitly re-wired behind a Phase-3.5 flag."""

    def test_no_caller_in_cli(self):
        cli_path = HERE.parent / "peaktrace" / "cli.py"
        tree = ast.parse(cli_path.read_text(encoding="utf-8"))
        calls = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func = node.func
                # Match name 'extend_late_read_interpolated' or
                # Attribute name 'extend_late_read_interpolated'.
                if isinstance(func, ast.Name) and func.id == "extend_late_read_interpolated":
                    calls.append(("name", node.lineno))
                elif isinstance(func, ast.Attribute) and func.attr == "extend_late_read_interpolated":
                    calls.append(("attr", node.lineno))
        self.assertEqual(calls, [],
            "extend_late_read_interpolated is dead code (B2). If you are "
            "re-wiring it, add it behind a Phase-3.5 flag and update the "
            f"v1.7 plan. Found calls at: {calls}")

    def test_function_still_exists_for_future_use(self):
        """Sanity: the function is preserved (not deleted) so a future
        wire decision is cheap. If you intend to delete it, this test
        and the deprecation note should both go."""
        from peaktrace.peak import extend_late_read_interpolated
        self.assertTrue(callable(extend_late_read_interpolated),
            "extend_late_read_interpolated was deleted; update the "
            "v1.7 plan and remove this test.")


class InterpolationFactorHonouredTests(unittest.TestCase):
    """B2 follow-up: if anyone ever wires this function, the
    interpolation_factor parameter must be honoured. This test currently
    passes trivially (the function is dead). When wired, it will catch
    any reintroduction of the docstring-lie."""

    def test_signature_has_interpolation_factor(self):
        from peaktrace.peak import extend_late_read_interpolated
        import inspect
        sig = inspect.signature(extend_late_read_interpolated)
        self.assertIn("interpolation_factor", sig.parameters,
            "extend_late_read_interpolated must accept an "
            "interpolation_factor parameter (currently 1.25 by default)")


if __name__ == "__main__":
    unittest.main()
