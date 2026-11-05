"""Adaptation contracts: types, eligible cohorts, signed ranges, joins and wire data."""
import io
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python-app"))
import km_core
from kmplot import analysis, dataio
from kmplot.profiling import profile


class Contracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.df = pd.DataFrame({"PATIENT_ID": [f"P{i:02}" for i in range(24)], "OS_MONTHS": np.arange(24),
            "OS_STATUS": ["Alive", "Dead"] * 12, "text": ["A", "B", None] * 8,
            "ten": list(range(10)) * 2 + [None] * 4, "int_many": list(range(23)) + [None],
            "float_many": np.arange(24) / 3, "small_float": [.2, .4, None] * 8,
            "constant": [4] * 24, "empty": [None] * 24})
        self.path = self.root / "clinical.tsv"
        self.df.to_csv(self.path, sep="\t", index=False)

    def tearDown(self):
        self.temp.cleanup()

    def context(self, **kwargs):
        return {"clinicalPath": str(self.path), "timeColumn": "OS_MONTHS", "eventColumn": "OS_STATUS",
                "noEventValues": ["Alive"], "eventValues": ["Dead"], **kwargs}

    def test_clinical_type_matrix(self):
        for col, mode, step in [("text", "tags", None), ("ten", "tags", 1), ("int_many", "ranges", 1),
                                ("float_many", "ranges", .1), ("small_float", "tags", .1), ("constant", "tags", 1)]:
            with self.subTest(column=col):
                result = profile(self.context(column=col))
                self.assertEqual(result["column"]["mode"], mode)
                if step: self.assertEqual(result["column"]["step"], step)
                self.assertEqual(result["column"]["nMissing"], int(self.df[col].isna().sum()))
                if mode == "tags": self.assertGreater(len(result["values"]), 0)
        self.assertEqual(profile(self.context(column="empty"))["column"]["nFinite"], 0)

    def test_endpoint_discovery_excludes_status_and_time(self):
        options = km_core.cmd_inspect(self.context())["options"]
        self.assertNotIn("OS_MONTHS", options["subgroupOptions"])
        self.assertNotIn("OS_STATUS", options["subgroupOptions"])
        self.assertNotIn("PATIENT_ID", options["subgroupOptions"])

    def test_time_profile_is_histogram_even_for_few_values(self):
        self.assertEqual(profile(self.context(column="ten", role="time"))["distribution"]["kind"], "histogram")

    def test_numeric_category_keys_survive_float_nan_promotion(self):
        result = km_core.cmd_analyze(self.context(variables=[{"source": "clinical", "column": "ten", "mode": "tags", "groups": [{"values": ["0", "1"], "name": "Selected"}]}]))
        self.assertEqual(result["result"]["nPatientsAfterSubgrouping"], 4)

    def test_profile_uses_event_eligible_population(self):
        result = profile(self.context(column="int_many", eventValues=[]))
        self.assertEqual(result["column"]["nEligible"], 12)

    def test_signed_rna_and_final_boundary(self):
        rna = pd.DataFrame({"PATIENT_ID": self.df.PATIENT_ID, "GENE": np.linspace(-4, 4, 24)})
        rna_path = self.root / "rna.tsv"; rna.to_csv(rna_path, sep="\t", index=False)
        p = profile(self.context(source="RNA", column="GENE", rnaPath=str(rna_path)))
        self.assertEqual(p["column"]["min"], -4)
        self.assertEqual(p["column"]["mode"], "ranges")
        groups = [{"name": "Low", "lo": -4, "hi": 0}, {"name": "High", "lo": 0, "hi": 4, "includeHi": True}]
        result = km_core.cmd_analyze(self.context(rnaPath=str(rna_path), variables=[{"source": "RNA", "column": "GENE", "mode": "ranges", "groups": groups}]))["result"]
        self.assertEqual(result["nPatientsAfterSubgrouping"], 24)
        self.assertEqual(sorted(c["n"] for c in result["curves"]), [12, 12])

    def test_genes_as_rows_negative_values(self):
        rna_path = self.root / "rna-rows.tsv"
        rna_path.write_text("Hugo_Symbol\tEntrez_Gene_Id\tP00\tP01\nGENE\t1\t-2.5\t3\nOTHER\t2\t0\t1\n")
        meta = dataio.rna_metadata(str(rna_path))
        self.assertEqual(meta["genes"], ["GENE", "OTHER"])
        loaded = dataio.load_rna(str(rna_path), ["GENE"])
        self.assertEqual(loaded.loc[0, "GENE"], -2.5)
        self.assertNotIn("OTHER", loaded)

    def test_no_shared_rna_ids_is_explicit_error(self):
        rna_path = self.root / "rna.tsv"
        pd.DataFrame({"PATIENT_ID": ["OTHER"], "GENE": [-1]}).to_csv(rna_path, sep="\t", index=False)
        with self.assertRaisesRegex(ValueError, "No matching patient IDs"):
            profile(self.context(source="RNA", column="GENE", rnaPath=str(rna_path)))

    def test_missing_duplicate_and_leading_zero_ids(self):
        for bad in [self.df.drop(columns="PATIENT_ID"), self.df.assign(PATIENT_ID="same"), self.df.assign(PATIENT_ID=None)]:
            path = self.root / f"bad-{len(list(self.root.iterdir()))}.tsv"; bad.to_csv(path, sep="\t", index=False)
            with self.assertRaises(ValueError): dataio.load_clinical(str(path))
        path = self.root / "zeros.tsv"; path.write_text("PATIENT_ID\tVALUE\n001\t2\n002\t3\n")
        self.assertEqual(dataio.load_clinical(str(path)).PATIENT_ID.tolist(), ["001", "002"])

    def test_duplicate_gene_symbols_rejected(self):
        path = self.root / "rna.tsv"; path.write_text("Hugo_Symbol\tP00\nGENE\t-1\nGENE\t2\n")
        self.assertEqual(dataio.rna_metadata(str(path))["ambiguousGenes"], ["GENE"])
        with self.assertRaisesRegex(ValueError, "Ambiguous"): dataio.load_rna(str(path), ["GENE"])

    def test_ambiguous_membership_is_rejected(self):
        cases = [("tags", [{"values": ["A"]}, {"values": ["A"]}]),
                 ("ranges", [{"lo": 0, "hi": 12}, {"lo": 10, "hi": 23}]),
                 ("ranges", [{"lo": 0, "hi": 12, "includeHi": True}, {"lo": 12, "hi": 23}]),
                 ("ranges", [{"lo": float("nan"), "hi": 12}])]
        for mode, groups in cases:
            with self.subTest(mode=mode, groups=groups):
                with self.assertRaises(analysis.AnalysisError): analysis.resolve_subgroup_values(self.df, "int_many", mode, groups)

    def test_duplicate_variable_and_endpoint_subgroup_rejected(self):
        variable = {"source": "clinical", "column": "text", "mode": "tags", "groups": [{"values": ["A"]}]}
        with self.assertRaises(analysis.AnalysisError): km_core.cmd_analyze(self.context(variables=[variable, variable]))
        variable["column"] = "OS_STATUS"
        with self.assertRaisesRegex(analysis.AnalysisError, "endpoint"): km_core.cmd_analyze(self.context(variables=[variable]))

    def test_invalid_durations_excluded_and_counted(self):
        bad = self.df.copy(); bad["OS_MONTHS"] = bad["OS_MONTHS"].astype(float)
        bad.loc[0, "OS_MONTHS"] = -1; bad.loc[1, "OS_MONTHS"] = float("inf"); bad.loc[2, "OS_MONTHS"] = float("nan")
        bad.to_csv(self.path, sep="\t", index=False)
        result = km_core.cmd_analyze(self.context())["result"]
        self.assertEqual(result["nExcludedBeforeSubgroups"], 3)
        self.assertEqual(result["nPatients"], 21)

    def test_constant_signed_rna_closed_range(self):
        labels, _ = analysis.resolve_subgroup_values(pd.DataFrame({"x": [-2, -2, None]}), "x", "ranges", [{"lo": -2, "hi": -2, "includeHi": True}])
        self.assertEqual(labels.notna().sum(), 2)

    def test_strict_json_not_reached_median(self):
        result = {"median": float("inf"), "empty": float("nan")}
        self.assertEqual(json.loads(json.dumps(km_core.json_safe(result), allow_nan=False)), {"median": None, "empty": None})

    def test_synthetic_baseline_numerical_regression(self):
        fixture = Path(__file__).parent / "fixtures/clinical_synthetic.tsv"
        result = km_core.cmd_analyze({**self.context(), "clinicalPath": str(fixture)})["result"]
        curve = result["curves"][0]
        self.assertEqual(curve["n"], 1000); self.assertEqual(curve["nEvents"], 429)
        self.assertAlmostEqual(curve["median"], 40.68605213188546)
        self.assertTrue(all(a >= b for a, b in zip(curve["survival"], curve["survival"][1:])))

    def test_custom_endpoint_cannot_be_used_for_groups(self):
        variable = {"source": "clinical", "column": "int_many", "mode": "ranges", "groups": [{"lo": 0, "hi": 24}]}
        with self.assertRaisesRegex(analysis.AnalysisError, "endpoint"):
            km_core.cmd_analyze(self.context(timeColumn="int_many", variables=[variable]))

    def test_duplicate_rna_headers_rejected(self):
        path = self.root / "bad-rna.tsv"
        path.write_text("Hugo_Symbol\tP00\tP00\nGENE\t1\t2\n")
        with self.assertRaisesRegex(ValueError, "unique"): dataio.rna_metadata(str(path))

    def test_export_rejects_file_changed_after_plot(self):
        result = km_core.cmd_analyze(self.context())["result"]
        self.df.iloc[:5].to_csv(self.path, sep="\t", index=False)
        with self.assertRaisesRegex(ValueError, "changed after plotting"):
            km_core.cmd_export(self.context(expectedInputVersion=result["inputVersion"]))

    def test_export_event_table_headers_match_data_columns(self):
        import base64
        import openpyxl
        response = km_core.cmd_export(self.context())
        sheet = openpyxl.load_workbook(io.BytesIO(base64.b64decode(response["base64"]))).active
        self.assertEqual([sheet.cell(5, c).value for c in range(1, 6)], ["Time", "Removed", "Observed", "Censored", "At Risk"])
        result = km_core.cmd_analyze(self.context())["result"]["curves"][0]
        row = result["eventTable"][0]
        self.assertEqual([sheet.cell(6, c).value for c in range(1, 6)], [row[k] for k in ("time", "removed", "observed", "censored", "atRisk")])

    def test_full_combination_names_are_retained_in_workbook(self):
        import base64
        import openpyxl
        self.df["measureB"] = np.arange(24) % 4
        self.df.to_csv(self.path, sep="\t", index=False)
        variables = [
            {"source": "clinical", "column": "int_many", "mode": "ranges", "groups": [{"lo": 0, "hi": 12, "name": "int_many: 0 to 12"}, {"lo": 12, "hi": 24, "name": "int_many: 12 to 24"}]},
            {"source": "clinical", "column": "measureB", "mode": "ranges", "groups": [{"lo": 0, "hi": 2, "name": "measureB: 0 to 2"}, {"lo": 2, "hi": 4, "name": "measureB: 2 to 4"}]}]
        job = self.context(variables=variables)
        result = km_core.cmd_analyze(job)["result"]
        self.assertEqual(result["nCurves"], 4)
        self.assertEqual(len({c["label"] for c in result["curves"]}), 4)
        workbook = openpyxl.load_workbook(io.BytesIO(base64.b64decode(km_core.cmd_export(job)["base64"])))
        for curve, sheet in zip(result["curves"], workbook.worksheets):
            self.assertIn("int_many:", curve["label"])
            self.assertIn(" | measureB:", curve["label"])
            self.assertIn(curve["label"], sheet["A2"].value)

    def test_cache_invalidates_when_file_changes(self):
        self.assertEqual(len(dataio.load_clinical(str(self.path))), 24)
        self.df.iloc[:5].to_csv(self.path, sep="\t", index=False)
        self.assertEqual(len(dataio.load_clinical(str(self.path))), 5)


if __name__ == "__main__": unittest.main()
