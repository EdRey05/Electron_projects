"""Read a post-Seq7 .ab1 file and extract the 4-channel trace + Seq7 metadata.

Returns a Trace object (dataclass) with:
  - channels: dict {9: ndarray, 10: ndarray, 11: ndarray, 12: ndarray}
  - pb_in:    ndarray of Seq7 basecalls (one byte per base, ASCII code)
  - qv_in:    ndarray of Seq7 QVs
  - ploc_in:  ndarray of Seq7 peak locations
  - tags:     dict of raw ABIF tags (passed through to writer)

The channels are A=9, C=10, G=11, T=12 (ABI spec).
"""
from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
import numpy as np
from Bio import SeqIO

# Channel IDs in the ABI tag dictionary (Biopython strips the dots)
CHANNELS = (9, 10, 11, 12)  # A, C, G, T
CHANNEL_OF_BASE = {b"A": 9, b"C": 10, b"G": 11, b"T": 12}


@dataclass
class Trace:
    """One .ab1 file's data."""
    src_path: Path
    channels: dict = field(default_factory=dict)   # {9|10|11|12: ndarray(int)}
    pb_in: np.ndarray = field(default_factory=lambda: np.array([], dtype=np.uint8))
    qv_in: np.ndarray = field(default_factory=lambda: np.array([], dtype=np.uint8))
    ploc_in: np.ndarray = field(default_factory=lambda: np.array([], dtype=np.int32))
    tags: dict = field(default_factory=dict)

    @property
    def n_scans(self) -> int:
        """Number of scan points (length of channel arrays)."""
        if not self.channels:
            return 0
        return len(next(iter(self.channels.values())))

    @property
    def n_bases(self) -> int:
        return len(self.pb_in)


def _g(rec, tag):
    return rec.annotations.get("abif_raw", {}).get(tag, None)


def _asarr(x):
    """Convert a Biopython ABIF tag value to a numpy array.

    Handles the common shapes we see:
      - ndarray (numeric channels)
      - bytes (PBAS — one ASCII byte per base)
      - list / tuple (other numeric arrays)
    """
    if x is None or isinstance(x, str):
        return np.array([], dtype=np.uint8)
    if isinstance(x, (bytes, bytearray)):
        try:
            return np.array([ord(c) for c in x.decode("ascii")], dtype=np.uint8)
        except Exception:
            return np.array([], dtype=np.uint8)
    if isinstance(x, np.ndarray):
        return x
    if hasattr(x, "__len__"):
        try:
            return np.array(x)
        except Exception:
            return np.array([], dtype=np.uint8)
    return np.array([x], dtype=np.uint8)


def read_ab1(path: Path) -> Trace:
    """Read one .ab1 file from disk and return a Trace."""
    rec = SeqIO.read(path, "abi")
    t = Trace(src_path=path)

    # 4 channels
    for ch in CHANNELS:
        a = _asarr(_g(rec, f"DATA{ch}"))
        if len(a):
            t.channels[ch] = a.astype(np.int32)

    # Seq7 basecall, QV, peak locations
    t.pb_in = _asarr(_g(rec, "PBAS1"))
    t.qv_in = _asarr(_g(rec, "PCON1"))
    t.ploc_in = _asarr(_g(rec, "PLOC1"))

    # Pass through metadata header for the writer to preserve
    t.tags = dict(rec.annotations.get("abif_raw", {}))

    return t


def write_seq(path: Path, pb: np.ndarray, ploc: np.ndarray, qv: np.ndarray) -> None:
    """Write an ABI-style .seq file.

    Matches the format produced by Seq7/PeakTrace RP so downstream tools read it:
      Line 1: "QUALITY VALUES"
      Line 2: bases as one long string
      Line 3: peak locations, comma-separated
      Line 4: QVs, comma-separated

    Some tools expect a slightly different layout; this matches what Ed showed in
    the POS1-H01.seq sample.
    """
    bases = "".join(chr(int(c)) for c in pb if c > 0)
    plocs = ",".join(str(int(x)) for x in ploc)
    qvs = ",".join(str(int(x)) for x in qv)
    path.write_text(f"QUALITY VALUES\n{bases}\n{plocs}\n{qvs}\n", encoding="ascii")
