"""Command-line entry point for the KM Plotter analysis core.

Electron keeps one pipe-only worker alive with ``--serve``. The standalone
job-file interface remains available:

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
import math
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
    rna = dataio.rna_metadata(rna_path) if rna_path else None

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
            "nRows": len(rna["patientIds"]),
            "nColumns": len(rna["genes"]) + 1,
            "genes": rna["genes"],
            "nSharedPatients": len(set(clinical[dataio.PATIENT_ID]) & set(rna["patientIds"])),
            "ambiguousGenes": rna["ambiguousGenes"],
            "duplicateEntries": rna["duplicateEntries"],
            "missingSymbols": rna["missingSymbols"],
        }
    else:
        payload["rna"] = None
    return payload


def input_version(job):
    return {key: [str(part) for part in dataio.file_key(job[key])]
            for key in ("clinicalPath", "rnaPath") if job.get(key)}


def cmd_analyze(job: Dict[str, Any]) -> Dict[str, Any]:
    """Run the KM analysis for the given parameters."""
    version = input_version(job)
    if job.get("expectedInputVersion") is not None and job["expectedInputVersion"] != version:
        raise ValueError("An input file changed after plotting. Update the plot before exporting.")
    clinical = dataio.load_clinical(job["clinicalPath"])
    genes = [v["column"] for v in job.get("variables", []) if v.get("source") == "RNA"]
    rna = dataio.load_rna(job["rnaPath"], genes) if genes and job.get("rnaPath") else None

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
    if input_version(job) != version:
        raise ValueError("An input file changed during analysis. Wait for the file to finish saving, then try again.")
    result["inputVersion"] = version
    return {"ok": True, "result": result}


def cmd_export(job: Dict[str, Any]) -> Dict[str, Any]:
    """Run the analysis and return the workbook as base64."""
    result = cmd_analyze(job)["result"]
    data = excel.build_workbook(result)
    return {
        "ok": True,
        "filename": job.get("filename", "KM_results.xlsx"),
        "base64": base64.b64encode(data).decode("ascii"),
    }


def cmd_column(job: Dict[str, Any]) -> Dict[str, Any]:
    """Describe one column (used to drive the UI widgets)."""
    from kmplot.profiling import profile
    return profile(job)


COMMANDS = {
    "inspect": cmd_inspect,
    "analyze": cmd_analyze,
    "export": cmd_export,
    "column": cmd_column,
}


def execute(job):
    command = job.get("command")
    if command not in COMMANDS:
        return _err(f"Unknown command: {command!r}")
    try:
        return COMMANDS[command](job)
    except (analysis.AnalysisError, ValueError, FileNotFoundError, KeyError) as exc:
        return _err(str(exc))
    except Exception as exc:
        return _err(f"{type(exc).__name__}: {exc}", traceback.format_exc())


def serve():
    # One local managed worker. Caches are bounded and keyed by file stat.
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = execute(request["job"])
            print(json.dumps(json_safe({"id": request["id"], "result": result}), allow_nan=False), flush=True)
        except Exception as exc:
            print(json.dumps({"id": request.get("id") if "request" in locals() else None,
                              "result": _err(str(exc))}), flush=True)


def json_safe(value):
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


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

    text = json.dumps(json_safe(payload), allow_nan=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        print(text)
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve"]:
        serve()
    else:
        raise SystemExit(main(sys.argv[1:]))
