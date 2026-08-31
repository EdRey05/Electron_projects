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
            "pos": pos,  # bytes offset of this entry in the file (for inline-data lookup)
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
    map_params: dict | None = None,
) -> None:
    """Rebuild .ab1 file from scratch, copying non-replaced tags from template.

    This is safer than in-place edits: any data size change doesn't shift the
    directory or corrupt neighboring tags.

    If `map_params` is provided (DATA1-4 ↔ DATA9-12 linear coordinate map),
    the chromatogram DATA9-12 is extended to fit the new PLOC grid by
    interpolating samples from the raw DATA1-4 channels (FIX #9).
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

    # Step 1: copy non-replaced template data blocks.
    #
    # Inline-data tags (data_size <= 4) have their actual data stored INSIDE
    # the directory entry at entry_pos + 20, not at the data_offset field
    # (which holds garbage). For these tags we must read the bytes from
    # the inline slot and write them at a fresh new_buf location.
    #
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

        is_inline = entry["data_size"] <= 4
        if is_inline:
            # Read the data from the inline slot (last 4 bytes of the 28-byte
            # directory entry: entry_pos + 20 .. entry_pos + 20 + data_size).
            entry_pos = entry.get("pos")
            if entry_pos is None:
                continue
            data = template_buf[entry_pos + 20:entry_pos + 20 + entry["data_size"]]
        else:
            # Normal tag: data lives at data_offset
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

    # Step 4: add DATA.9-12 from template, with PT-style per-channel rescale
    # and (FIX #9) extension to fit new PLOC grid using DATA1-4 interpolation.
    #
    # PeakTrace RP rescales so the 99th-percentile of each channel lands near 650
    # (verified across 68 sample4 files: f3 p99 mean=649, f2 p99 mean=1397,
    # mean rescale factor ~0.46). This is what makes PT chromatograms fit
    # cleanly into SnapGene/Geneious y-axes.
    #
    # .ab1 stores chromatogram data as big-endian signed int16.
    P99_TARGET = 650

    # FIX #9: extend DATA9-12 to fit max(ploc). PT does this; without it the
    # chromatogram truncates and SnapGene shows extra "ghost" peaks at the end.
    target_len = int(ploc.max()) + 6 if len(ploc) > 0 else 0  # +6 scans padding
    for entry in entries:
        if entry["name"] == b"DATA" and entry["tag_number"] in (9, 10, 11, 12):
            raw = template_buf[entry["data_offset"]:entry["data_offset"] + entry["data_size"]]
            arr = np.frombuffer(raw, dtype=">i2")

            # FIX #9: extend with values from DATA1-4 (if map available)
            if target_len > len(arr) and map_params is not None and getattr(trace, "tags", None):
                # DATA1-4 → DATA9-12 map: pos9 = (pos14 - b) / a
                # So to fill pos9 in [len(arr), target_len), we need pos14 = pos9*a + b
                a = map_params.get("slope")
                b = map_params.get("intercept")
                if a is not None and b is not None and np.isfinite(a):
                    # The channel mapping: tag 9↔1, 10↔2, 11↔3, 12↔4
                    full_ch = entry["tag_number"] - 8  # 9→1, 10→2, ...
                    full_data = trace.tags.get(f"DATA{full_ch}")
                    if full_data is not None:
                        full_arr = np.asarray(full_data, dtype=np.int32)
                        n_full = len(full_arr)
                        new_idx9 = np.arange(len(arr), target_len)
                        new_idx14 = np.clip(
                            np.round(new_idx9 * a + b).astype(np.int32),
                            0, max(n_full - 1, 0)
                        )
                        # Linear interpolation between consecutive DATA1-4 samples
                        # for sub-scan precision (DATA9-12 grid is denser than DATA1-4).
                        i0 = np.clip(new_idx14, 0, n_full - 2)
                        frac = (new_idx14 - i0).astype(np.float64)
                        v0 = full_arr[i0].astype(np.float64)
                        v1 = full_arr[i0 + 1].astype(np.float64)
                        new_samples = np.round(v0 + frac * (v1 - v0)).astype(np.int32)
                        arr = np.concatenate([arr, new_samples.astype(">i2")])
                        # Pad with one trailing zero so the array ends at baseline
                        arr = np.concatenate([arr, np.array([0], dtype=">i2")])

            if len(arr) > 0:
                p99 = float(np.percentile(arr, 99))
                if p99 > 1.0:
                    scale = P99_TARGET / p99
                    arr = np.clip(np.round(arr.astype(np.float64) * scale), -32768, 32767).astype(">i2")
                data = arr.tobytes()
            else:
                data = raw
            data_offset = len(new_buf)
            new_buf.extend(data)
            new_entries.append({
                "name": entry["name"],
                "tag_number": entry["tag_number"],
                "element_code": entry["element_code"],
                "element_size": entry["element_size"],
                "num_elements": len(arr),
                "data_size": len(data),
                "data_offset": data_offset,
            })

    # Append directory entries
    # Per ABI spec + Biopython's reader (AbiIO.py:502):
    #     if data_size <= 4:
    #         data_offset = tag_offset + 20
    # So for inline tags, the BYTES AT tag_offset+20..tag_offset+24 (the
    # inline slot, i.e. the "data_offset" field of the entry) MUST contain
    # the actual data. We handle this by writing data_offset = the position
    # of the data in new_buf, then re-writing the data into the inline slot
    # bytes of the entry below (overwriting data_offset in-place).
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
        # For inline tags, overwrite bytes 20..24 with the actual data.
        # new_buf[-8:-4] is the data_offset field (big-endian uint32).
        if e["data_size"] <= 4:
            data_at_offset = bytes(new_buf[e["data_offset"]:e["data_offset"] + e["data_size"]])
            # new_buf[-8:-8+e["data_size"]] = data_at_offset
            start = len(new_buf) - 8
            new_buf[start:start + e["data_size"]] = data_at_offset

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
