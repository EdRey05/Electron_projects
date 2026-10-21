"""Command-line entry point for the KM Plotter analysis core.

Electron spawns this as a short-lived subprocess:

    python km_core.py <job.json>

The job file is a JSON object; the result is written to the path given by
``--out`` (or printed to stdout when omitted). Every result is a JSON object
with an ``ok`` flag so the renderer never has to parse a traceback.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import traceback
from typing import Any, Dict

# Allow running as a script from the python-app directory.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pandas as pd  # noqa: E402

from kmplot import analysis, dataio, excel  # noqa: E402


def _err(message: str, detail: str = "") -> Dict[str, Any]:
    return {"ok": False, "error": message, "detail": detail}


def cmd_inspect(job: Dict[str, Any]) -> Dict[str, Any]:
    """Load the clinical (and optional RNA) file and describe it."""
    clinical_path = job.get("clinicalPath")
    rna_path = job.get("rnaPath")

    clinical = dataio.load_clinical(clinical_path)
    rna = dataio.load_rna(rna_path) if rna_path else None

    options = dataio.discover_options(clinical)

    payload: Dict[str, Any] = {
        "ok": True,
        "clinical": {
            "path": clinical_path,
            "nRows": int(len(clinical)),
            "nColumns": int(len(clinical.columns)),
            "columns": list(clinical.columns),
            "patientIdColumn": dataio.PATIENT_ID,
        },
        "options": options,
    }
    if rna is not None:
        payload["rna"] = {
            "path": rna_path,
            "nRows": int(len(rna)),
            "nColumns": int(len(rna.columns)),
            "genes": [c for c in rna.columns if c != dataio.PATIENT_ID][:20000],
        }
    else:
        payload["rna"] = None
    return payload


def cmd_analyze(job: Dict[str, Any]) -> Dict[str, Any]:
    """Run the KM analysis for the given parameters."""
    clinical = dataio.load_clinical(job["clinicalPath"])
    rna = dataio.load_rna(job["rnaPath"]) if job.get("rnaPath") else None

    result = analysis.run_analysis(
        clinical=clinical,
        rna=rna,
        time_column=job["timeColumn"],
        event_column=job["eventColumn"],
        no_event_values=job.get("noEventValues", []),
        event_values=job.get("eventValues", []),
        variables=job.get("variables", []),
        alpha=float(job.get("alpha", 0.05)),
    )
    return {"ok": True, "result": result}


def cmd_export(job: Dict[str, Any]) -> Dict[str, Any]:
    """Run the analysis and return the workbook as base64."""
    clinical = dataio.load_clinical(job["clinicalPath"])
    rna = dataio.load_rna(job["rnaPath"]) if job.get("rnaPath") else None

    result = analysis.run_analysis(
        clinical=clinical,
        rna=rna,
        time_column=job["timeColumn"],
        event_column=job["eventColumn"],
        no_event_values=job.get("noEventValues", []),
        event_values=job.get("eventValues", []),
        variables=job.get("variables", []),
        alpha=float(job.get("alpha", 0.05)),
    )
    data = excel.build_workbook(result)
    return {
        "ok": True,
        "filename": job.get("filename", "KM_results.xlsx"),
        "base64": base64.b64encode(data).decode("ascii"),
    }


def cmd_column(job: Dict[str, Any]) -> Dict[str, Any]:
    """Describe one column (used to drive the UI widgets)."""
    df = pd.read_csv(job["path"], sep="\t", comment="#", encoding="utf-8", engine="python")
    df.columns = [str(c).strip() for c in df.columns]
    column = job["column"]

    info = dataio.describe_column(df, column)
    payload: Dict[str, Any] = {"ok": True, "column": info}

    if info["numeric"]:
        payload["histogram"] = dataio.histogram(df, column)
    else:
        payload["values"] = dataio.value_counts(df, column)
    return payload


COMMANDS = {
    "inspect": cmd_inspect,
    "analyze": cmd_analyze,
    "export": cmd_export,
    "column": cmd_column,
}


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description="KM Plotter analysis core")
    parser.add_argument("job", help="Path to the JSON job file, or '-' for stdin")
    parser.add_argument("--command", choices=sorted(COMMANDS), default=None,
                        help="Command to run (default: read it from the job file)")
    parser.add_argument("--out", default=None, help="Where to write the JSON result")
    args = parser.parse_args(argv)

    try:
        if args.job == "-":
            job = json.loads(sys.stdin.read())
        else:
            with open(args.job, "r", encoding="utf-8") as f:
                job = json.load(f)
    except Exception as exc:
        payload = _err(f"Could not read the job file: {exc}", traceback.format_exc())
        print(json.dumps(payload))
        return 1

    command = args.command or job.get("command")
    if command not in COMMANDS:
        payload = _err(f"Unknown command: {command!r}")
        print(json.dumps(payload))
        return 1

    try:
        payload = COMMANDS[command](job)
    except analysis.AnalysisError as exc:
        payload = _err(str(exc))
    except FileNotFoundError as exc:
        payload = _err(str(exc))
    except Exception as exc:  # noqa: BLE001
        payload = _err(f"{type(exc).__name__}: {exc}", traceback.format_exc())

    text = json.dumps(payload)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        print(text)
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
