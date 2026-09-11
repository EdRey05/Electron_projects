"""v1.7 Phase 3.4: sidecar trace artifact writer.

Writes a JSON file with the sharpened + processed channels into
<output_dir>/sidecar/<basename>.sidecar.json. Per Kimi R8: sidecars
in a subfolder, not the main output folder, to avoid SnapGene
file-type confusion.

Off by default. Wired in via cli.py: --write-sidecar-trace.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np


def write_sidecar_trace(out_dir: Path, src_basename: str,
                        full_channels: dict[int, np.ndarray]) -> Path:
    """Write the processed DATA1-4 channels as JSON.

    full_channels: dict mapping {1,2,3,4} -> ndarray (A, C, G, T).
    Output: <out_dir>/sidecar/<basename>.sidecar.json with one array
    per channel plus a small header describing the data.

    Returns the path to the written file.
    """
    sidecar_dir = out_dir / "sidecar"
    sidecar_dir.mkdir(parents=True, exist_ok=True)
    out_path = sidecar_dir / f"{src_basename}.sidecar.json"
    payload = {
        "format_version": 1,
        "channels": {
            "A": [float(x) for x in full_channels.get(1, np.array([]))],
            "C": [float(x) for x in full_channels.get(2, np.array([]))],
            "G": [float(x) for x in full_channels.get(3, np.array([]))],
            "T": [float(x) for x in full_channels.get(4, np.array([]))],
        },
    }
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f)
    return out_path
