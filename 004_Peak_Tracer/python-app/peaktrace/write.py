"""Conservative .ab1 writer: always APPEND new data at end of file, never try to
do in-place overwrites that could shift the directory.

Strategy: read template, identify which entries to replace (PBAS/PCON/PLOC/P1AM/DATA9-12),
build a NEW file from scratch with the directory rebuilt. This is what write_rebuild.py does.
"""
from __future__ import annotations
from pathlib import Path
import struct
import numpy as np

from .read import CHANNELS


def _read_dir_entries(buf: bytes):
    """Read all directory entries starting at the dir_offset in the header."""
    if len(buf) < 30 or buf[:4] != b"ABIF":
        raise ValueError(f"not an ABIF file: {buf[:4]!r}")
    head = struct.unpack(">H4sI2H3I", buf[4:4 + 26])
    dir_offset = head[7]
    entries = []
    pos = dir_offset
    while pos + 28 <= len(buf):
        d = struct.unpack(">4sI2H4I", buf[pos:pos + 28])
        if d[0] == b"\x00\x00\x00\x00":
            break
        entries.append({
            "name": d[0],
            "tag_number": d[1],
            "element_code": d[2],
            "element_size": d[3],
            "num_elements": d[4],
            "data_size": d[5],
            "data_offset": d[6],
            "data_handle": d[7],
        })
        pos += 28
    return dir_offset, entries


def write_ab1(
    out_path: Path,
    trace,
    pb: np.ndarray,
    qv: np.ndarray,
    ploc: np.ndarray,
    p1am: np.ndarray | None = None,
    set_abi_limits: bool = True,
    clamp_max: int = 65535,
) -> None:
    """Rebuild .ab1 file from scratch, copying non-replaced tags from template.

    This is safer than in-place edits: any data size change doesn't shift the
    directory or corrupt neighboring tags.
    """
    template_path = Path(trace.src_path)
    template_buf = template_path.read_bytes()
    _, entries = _read_dir_entries(template_buf)

    # Encode our new data
    pbas_bytes = bytes(int(b) for b in pb)
    pcon_bytes = bytes(int(b) for b in qv)
    # PLOC: ABI standard is element code 5 (unsigned long), 4 bytes each, big-endian.
    # Earlier code packed as int16 which broke Geneious BioJava ("Index -1 out of bounds").
    ploc_data = np.clip(ploc.astype(np.int64), 0, 0xFFFFFFFF).astype(">u4").tobytes()
    if p1am is not None:
        p1am_data = np.clip(p1am.astype(np.int64), 0, 0xFFFF).astype(">u2").tobytes()  # 16-bit unsigned (P1AM stays int16 per ABI convention)
    else:
        p1am_data = None

    # Tags we're replacing
    replacement_tags = {
        b"PBAS": {1, 2},
        b"PCON": {1, 2},
        b"PLOC": {1, 2},
    }
    if p1am_data is not None:
        replacement_tags[b"P1AM"] = {1}

    # For DATA.9-12 we keep the template data (no rescale in v1.2)
    # We'll write DATA.9-12 in our new file using template values

    # Build new file structure
    new_buf = bytearray()
    # Reserve 34 bytes for header
    new_buf.extend(b"\x00" * 34)

    new_entries = []

    # Step 1: copy non-replaced template data blocks
    # Filter out entries whose tag names contain non-ASCII bytes (Biopython can't decode them).
    for entry in entries:
        key = (entry["name"], entry["tag_number"])
        if entry["name"] in replacement_tags and entry["tag_number"] in replacement_tags[entry["name"]]:
            continue
        # DATA9-12 we'll add separately below
        if entry["name"] == b"DATA" and entry["tag_number"] in (9, 10, 11, 12):
            continue
        # Skip empty entries
        if entry["data_size"] == 0:
            continue
        # Skip entries with non-ASCII tag names — Biopython can't decode them
        # Use strict ASCII check (each byte must be 0x20-0x7e)
        if not all(0x20 <= b <= 0x7e for b in entry["name"]):
            continue
        # Skip entries with invalid offsets (offset + size past EOF — likely garbage)
        if entry["data_offset"] + entry["data_size"] > len(template_buf):
            continue
        data = template_buf[entry["data_offset"]:entry["data_offset"] + entry["data_size"]]
        data_offset = len(new_buf)
        new_buf.extend(data)
        new_entries.append({
            "name": entry["name"],
            "tag_number": entry["tag_number"],
            "element_code": entry["element_code"],
            "element_size": entry["element_size"],
            "num_elements": entry["num_elements"],
            "data_size": entry["data_size"],
            "data_offset": data_offset,
        })

    # Step 2: add our new PBAS/PCON/PLOC
    # PLOC element format: code=5 (unsigned long), size=4. Was wrongly written as code=4, size=2
    # which broke Geneious (BioJava "Index -1 out of bounds" — it read PLOC2 with wrong format
    # and got an invalid offset). PBAS/PCON stay at code=2 size=1 (char).
    for tag_name, data, num, ec, es in [
        (b"PBAS", pbas_bytes, len(pbas_bytes), 2, 1),
        (b"PCON", pcon_bytes, len(pcon_bytes), 2, 1),
        (b"PLOC", ploc_data, len(ploc), 5, 4),
    ]:
        for tag_num in replacement_tags[tag_name]:
            data_offset = len(new_buf)
            new_buf.extend(data)
            new_entries.append({
                "name": tag_name,
                "tag_number": tag_num,
                "element_code": ec,
                "element_size": es,
                "num_elements": num,
                "data_size": len(data),
                "data_offset": data_offset,
            })

    # Step 3: add P1AM.1 if provided
    if p1am_data is not None:
        data_offset = len(new_buf)
        new_buf.extend(p1am_data)
        new_entries.append({
            "name": b"P1AM",
            "tag_number": 1,
            "element_code": 4,
            "element_size": 2,
            "num_elements": len(p1am),
            "data_size": len(p1am_data),
            "data_offset": data_offset,
        })

    # Step 4: add DATA.9-12 from template (preserve original channel data)
    for entry in entries:
        if entry["name"] == b"DATA" and entry["tag_number"] in (9, 10, 11, 12):
            data = template_buf[entry["data_offset"]:entry["data_offset"] + entry["data_size"]]
            data_offset = len(new_buf)
            new_buf.extend(data)
            new_entries.append({
                "name": entry["name"],
                "tag_number": entry["tag_number"],
                "element_code": entry["element_code"],
                "element_size": entry["element_size"],
                "num_elements": entry["num_elements"],
                "data_size": entry["data_size"],
                "data_offset": data_offset,
            })

    # Append directory entries
    dir_offset = len(new_buf)
    for e in new_entries:
        new_buf.extend(e["name"])
        new_buf.extend(struct.pack(">I", e["tag_number"]))
        new_buf.extend(struct.pack(">H", e["element_code"]))
        new_buf.extend(struct.pack(">H", e["element_size"]))
        new_buf.extend(struct.pack(">I", e["num_elements"]))
        new_buf.extend(struct.pack(">I", e["data_size"]))
        new_buf.extend(struct.pack(">I", e["data_offset"]))
        new_buf.extend(b"\x00\x00\x00\x00")

    # Write header
    new_buf[0:4] = b"ABIF"
    new_buf[4:6] = struct.pack(">H", 101)
    new_buf[6:10] = b"tdir"
    new_buf[10:14] = struct.pack(">I", 1)
    new_buf[14:16] = struct.pack(">H", 1023)
    new_buf[16:18] = struct.pack(">H", 28)
    new_buf[18:22] = struct.pack(">I", len(new_entries))
    new_buf[22:26] = struct.pack(">I", len(new_entries) * 28)
    new_buf[26:30] = struct.pack(">I", dir_offset)
    new_buf[30:34] = struct.pack(">I", len(new_entries))

    # DEBUG: log every new_entries entry (remove after fix)
    import logging
    for i, e in enumerate(new_entries):
        name_ascii = all(0x20 <= b <= 0x7e for b in e["name"])
        logging.debug(
            "entry %d: tag=%r tag_num=%d hex=%s ascii_safe=%s offset=%d size=%d",
            i, e["name"], e["tag_number"], e["name"].hex(), name_ascii, e["data_offset"], e["data_size"],
        )

    out_path.write_bytes(bytes(new_buf))


# Keep old API names for compatibility
def _patch_data_tag(buf: bytes, channel: int, data: np.ndarray) -> bytes:
    """Not used in v1.2's rebuild approach."""
    return buf


def _patch_bytes_tag(buf: bytes, tag_name: str, tag_num: int, data: bytes) -> bytes:
    return buf


def _patch_int_array_tag(buf: bytes, tag_name: str, tag_num: int, data: np.ndarray) -> bytes:
    return buf


def _patch_array_tag(buf: bytes, tag_name: str, tag_num: int, data, element_code: int) -> bytes:
    return buf
