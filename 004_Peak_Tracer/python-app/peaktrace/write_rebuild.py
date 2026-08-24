"""Re-implement peaktrace_core write_ab1 using a clean rebuild strategy.

Strategy: keep the input .ab1 file's HEADER + non-data tags, but rebuild the directory
with our new data lengths. This avoids the buffer-shifting bugs that come from
in-place overwrites that change buffer size.
"""
from __future__ import annotations
import struct
from pathlib import Path
import numpy as np

from .read import CHANNELS

ABIF_MAGIC = b"ABIF"
DIR_ENTRY_SIZE = 28


def _parse_header(buf: bytes):
    """Parse the ABIF header.

    Returns (dir_offset, dir_entry_count).
    """
    if len(buf) < 30 or buf[:4] != ABIF_MAGIC:
        raise ValueError(f"not an ABIF file: {buf[:4]!r}")
    head = struct.unpack(">H4sI2H3I", buf[4:4 + 26])
    dir_offset = head[7]
    # dir_entry_count is at bytes 30-33 (right after the 26-byte header)
    # Some files have it, some don't — try to read it
    if len(buf) >= 34:
        dir_entry_count = struct.unpack(">I", buf[30:34])[0]
    else:
        dir_entry_count = None
    return dir_offset, dir_entry_count


def _read_dir_entries(buf: bytes, dir_offset: int, max_count: int | None = None):
    """Read all directory entries starting at dir_offset."""
    entries = []
    pos = dir_offset
    while pos + DIR_ENTRY_SIZE <= len(buf):
        d = struct.unpack(">4sI2H4I", buf[pos:pos + DIR_ENTRY_SIZE])
        # Stop at zero-filled entries (padding)
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
            "file_offset": pos,
        })
        pos += DIR_ENTRY_SIZE
        if max_count is not None and len(entries) >= max_count:
            break
    return entries


def _is_empty_entry(entry: dict) -> bool:
    """True if this is a zero-padding entry."""
    return entry["name"] == b"\x00\x00\x00\x00"


def write_ab1(
    out_path: Path,
    template_path: Path,
    pb: np.ndarray,
    qv: np.ndarray,
    ploc: np.ndarray,
    p1am: np.ndarray | None = None,
    set_abi_limits: bool = True,
    clamp_max: int = 65535,
) -> None:
    """Write a new .ab1 file using a clean rebuild strategy.

    Approach:
      1. Read the template (input) .ab1 file
      2. Read its directory entries
      3. Build new data blocks for PBAS, PCON, PLOC, P1AM
      4. For each template entry, decide whether to:
         - Use original data (channels DATA1-8, metadata tags)
         - Replace with our new data (PBAS, PCON, PLOC, P1AM, channels DATA9-12)
      5. Write a new file with our directory pointing to all data blocks
    """
    template_buf = template_path.read_bytes()
    dir_offset, _ = _parse_header(template_buf)
    entries = _read_dir_entries(template_buf, dir_offset)

    # Build new data blocks
    # PBAS: char (element_code=2), 1 byte per element
    pbas_bytes = bytes(int(b) for b in pb if b > 0)
    # PCON: char (element_code=2), 1 byte per element
    pcon_bytes = bytes(int(b) for b in qv)
    # PLOC: short (element_code=4), 2 bytes per element, BIG-ENDIAN
    ploc_data = np.clip(ploc.astype(np.int32), 0, 32767).astype(">i2").tobytes()
    # P1AM: short (element_code=4), 2 bytes per element, BIG-ENDIAN
    if p1am is not None:
        p1am_data = np.clip(p1am.astype(np.int32), 0, 32767).astype(">i2").tobytes()
    else:
        p1am_data = None

    # Channel DATA9-12 (processed channels from input):
    # Read from template channels DATA9-12 (which we already did in the pipeline)
    # We need to rebuild these too — but they go through read_ab1 first
    # Actually, the input file has DATA9-12 already. Let's read them and copy.
    # The caller passes channel data via a different mechanism — for now, use template DATA9-12.
    # (If we want to apply rescale, that happens elsewhere.)

    # Plan:
    #   For each template entry:
    #     - If it's PBAS.1, PBAS.2: replace with our pbas_bytes (or .2 with copy of .1)
    #     - If it's PCON.1, PCON.2: replace with our pcon_bytes
    #     - If it's PLOC.1, PLOC.2: replace with our ploc_data
    #     - If it's P1AM.1: replace with our p1am_data (if provided)
    #     - If it's DATA.9-12: KEEP from template (no rescale applied in v1.2)
    #     - Other tags: KEEP from template

    # Step 1: Read original DATA blocks from template
    original_data_blocks = {}
    for entry in entries:
        if entry["name"] == b"DATA" and entry["tag_number"] in (9, 10, 11, 12):
            # Read the channel data from template
            offset = entry["data_offset"]
            size = entry["data_size"]
            if size > 0:
                original_data_blocks[entry["tag_number"]] = template_buf[offset:offset + size]

    # Step 2: Build new file
    # Layout:
    #   [ABIF header 26 bytes]
    #   [dir_entry_count uint32]  ← optional, but Biopython doesn't enforce
    #   [reserved 4 bytes]
    #   [padding to align]
    #   [original data blocks (DATA1-8, metadata)]
    #   [our new data blocks: PBAS, PCON, PLOC, P1AM, DATA9-12]
    #   [directory entries]

    # Start with header
    new_buf = bytearray()
    new_buf.extend(ABIF_MAGIC)
    new_buf.extend(struct.pack(">H", 101))  # version
    new_buf.extend(b"etdir")  # name
    new_buf.extend(struct.pack(">I", 1))  # tag_number
    new_buf.extend(struct.pack(">H", 1023))  # element_code
    new_buf.extend(struct.pack(">H", 28))  # element_size
    new_buf.extend(struct.pack(">I", 0))  # num_elements placeholder (we'll set this later)
    new_buf.extend(struct.pack(">I", 0))  # data_size placeholder
    new_buf.extend(struct.pack(">I", 0))  # data_offset placeholder (filled in later)
    # Optional: dir_entry_count at bytes 30-33
    new_buf.extend(struct.pack(">I", 0))  # placeholder

    # Now copy non-replaced template data blocks (DATA1-8, metadata, etc.)
    # We'll keep track of where each block starts in the new file
    new_entries = []  # list of dicts: {name, tag_number, element_code, element_size, num_elements, data, file_offset, dir_file_offset}

    # First: copy template data blocks EXCEPT DATA9-12, PBAS, PCON, PLOC, P1AM
    skip_tags = {b"DATA": {9, 10, 11, 12}, b"PBAS": {1, 2}, b"PCON": {1, 2},
                 b"PLOC": {1, 2}, b"P1AM": {1}}
    for entry in entries:
        if entry["name"] in skip_tags and entry["tag_number"] in skip_tags[entry["name"]]:
            continue
        # Copy this data block
        if entry["data_size"] > 0:
            data = template_buf[entry["data_offset"]:entry["data_offset"] + entry["data_size"]]
            data_offset_in_new = len(new_buf)
            new_buf.extend(data)
            new_entries.append({
                "name": entry["name"],
                "tag_number": entry["tag_number"],
                "element_code": entry["element_code"],
                "element_size": entry["element_size"],
                "num_elements": entry["num_elements"],
                "data": data,
                "data_offset": data_offset_in_new,
            })

    # Now add our new blocks: PBAS.1, PBAS.2, PCON.1, PCON.2, PLOC.1, PLOC.2, P1AM.1, DATA9-12
    # PBAS.1
    new_entries.append({
        "name": b"PBAS", "tag_number": 1, "element_code": 2, "element_size": 1,
        "num_elements": len(pbas_bytes), "data": pbas_bytes,
    })
    new_entries.append({
        "name": b"PBAS", "tag_number": 2, "element_code": 2, "element_size": 1,
        "num_elements": len(pbas_bytes), "data": pbas_bytes,
    })
    # PCON.1, PCON.2
    new_entries.append({
        "name": b"PCON", "tag_number": 1, "element_code": 2, "element_size": 1,
        "num_elements": len(pcon_bytes), "data": pcon_bytes,
    })
    new_entries.append({
        "name": b"PCON", "tag_number": 2, "element_code": 2, "element_size": 1,
        "num_elements": len(pcon_bytes), "data": pcon_bytes,
    })
    # PLOC.1, PLOC.2
    new_entries.append({
        "name": b"PLOC", "tag_number": 1, "element_code": 4, "element_size": 2,
        "num_elements": len(ploc), "data": ploc_data,
    })
    new_entries.append({
        "name": b"PLOC", "tag_number": 2, "element_code": 4, "element_size": 2,
        "num_elements": len(ploc), "data": ploc_data,
    })
    # P1AM.1 (only if provided)
    if p1am_data is not None:
        new_entries.append({
            "name": b"P1AM", "tag_number": 1, "element_code": 4, "element_size": 2,
            "num_elements": len(p1am), "data": p1am_data,
        })
    # DATA.9-12 (copy from template)
    for ch in (9, 10, 11, 12):
        if ch in original_data_blocks:
            data = original_data_blocks[ch]
            new_entries.append({
                "name": b"DATA", "tag_number": ch, "element_code": 4, "element_size": 2,
                "num_elements": len(data) // 2, "data": data,
            })

    # Compute data offsets for all entries
    for entry in new_entries:
        if "data_offset" not in entry:
            entry["data_offset"] = len(new_buf)
            new_buf.extend(entry["data"])

    # Now append the directory
    dir_offset_in_new = len(new_buf)
    for entry in new_entries:
        new_buf.extend(entry["name"])
        new_buf.extend(struct.pack(">I", entry["tag_number"]))
        new_buf.extend(struct.pack(">H", entry["element_code"]))
        new_buf.extend(struct.pack(">H", entry["element_size"]))
        new_buf.extend(struct.pack(">I", entry["num_elements"]))
        new_buf.extend(struct.pack(">I", len(entry["data"])))
        new_buf.extend(struct.pack(">I", entry["data_offset"]))
        new_buf.extend(b"\x00\x00\x00\x00")  # data_handle

    # Update the ABIF header with directory offset and entry count
    new_buf[26:30] = struct.pack(">I", dir_offset_in_new)
    new_buf[30:34] = struct.pack(">I", len(new_entries))

    # Write file
    out_path.write_bytes(bytes(new_buf))
