"""Write a new .ab1 file with the processed trace + basecall + QVs.

Strategy:
  1. Read the original .ab1 file as bytes
  2. Parse its ABIF tag directory
  3. Replace the channel data (DATA.9-12), basecall (PBAS.1/2), QVs (PCON.1/2),
     peak locations (PLOC.1/2), and base amplitudes (P1AM.1/2, P2AM.1/2) with
     our processed values
  4. If `set_abi_limits` is True, clamp channel values to uint16 max
  5. Write back to disk

This avoids a full ABI file-format reimplementation while still letting us
write a different channel-data + basecall into a Seq7-stamped file (so
instrument metadata is preserved).

For v0 we use Biopython + manual binary patching. If abifpy is installed we
prefer it (cleaner API). Falls back to a minimal manual writer.
"""
from __future__ import annotations
from pathlib import Path
import struct
import numpy as np

from .read import Trace, CHANNELS, _asarr, _g
from Bio import SeqIO

# ABI tag IDs we need to overwrite
TAG_PBAS = b"PBAS"
TAG_PCON = b"PCON"
TAG_PLOC = b"PLOC"
TAG_DATA = b"DATA"
TAG_P1AM = b"P1AM"  # base amplitudes (primary basecall, indexed by base)
TAG_P2AM = b"P2AM"  # base amplitudes (secondary basecall — we leave at Seq7 default)


def _ab1_entry_byte_for(tag: bytes) -> int:
    """Convert a 4-char ABIF tag to its 1-byte representation."""
    if len(tag) != 4:
        return 0
    return (tag[0] << 24) | (tag[1] << 16) | (tag[2] << 8) | tag[3]


def write_ab1(out_path: Path,
              trace: Trace,
              pb: np.ndarray,
              qv: np.ndarray,
              ploc: np.ndarray,
              p1am: np.ndarray = None,
              set_abi_limits: bool = True,
              clamp_max: int = 65535) -> None:
    """Write a new .ab1 file based on `trace` (template) with our new data.

    The simplest robust strategy: read the original file as bytes, find the
    data offsets for each tag, and replace the tag entries with our new data.
    This avoids re-implementing the ABI directory layout from scratch.

    For v0 (real-data validation only): we re-emit using Biopython's writer
    capability if available. If not, we write a minimal header pointing to
    our data and let downstream tools (sister company) sort it out.
    """
    # For now: copy the template file and patch specific tags.
    raw = Path(trace.src_path).read_bytes()

    # 1. Patch channel DATA tags (9, 10, 11, 12)
    for ch in CHANNELS:
        if ch not in trace.channels:
            continue
        arr = trace.channels[ch]
        if set_abi_limits:
            arr = np.minimum(arr, clamp_max)
        raw = _patch_data_tag(raw, ch, arr.astype(np.uint16))

    # 2. Patch PBAS.1, PCON.1, PLOC.1 with our new arrays
    raw = _patch_bytes_tag(raw, "PBAS", 1, bytes(int(b) for b in pb if b > 0))
    raw = _patch_int_array_tag(raw, "PCON", 1, qv.astype(np.uint8))
    raw = _patch_int_array_tag(raw, "PLOC", 1, ploc.astype(np.int32))
    if p1am is not None:
        raw = _patch_int_array_tag(raw, "P1AM", 1, p1am.astype(np.uint16))

    out_path.write_bytes(raw)


def _patch_data_tag(buf: bytes, channel: int, data: np.ndarray) -> bytes:
    """Find and replace the DATA.{channel} tag entry with our new uint16 array."""
    return _patch_int_array_tag(buf, "DATA", channel, data)


def _patch_bytes_tag(buf: bytes, tag_name: str, tag_num: int, data: bytes) -> bytes:
    """Find and replace a byte-string tag entry."""
    return _patch_array_tag(buf, tag_name, tag_num, data, element_code=18)  # 18 = byte


def _patch_int_array_tag(buf: bytes, tag_name: str, tag_num: int, data: np.ndarray) -> bytes:
    """Find and replace an integer-array tag entry (short uint16 / long int32).

    Encodes as little-endian. ABI uses element code 4 (ushort) for QVs/PLOC.
    """
    if data.dtype == np.uint8 or data.dtype == np.int32 or data.dtype == np.int64:
        # Use 32-bit signed integers (element code 5)
        elem_code = 5
        arr_bytes = np.ascontiguousarray(data.astype(np.int32)).tobytes()
    else:
        # Use 16-bit unsigned (element code 4)
        elem_code = 4
        arr_bytes = np.ascontiguousarray(data.astype(np.uint16)).tobytes()
    return _patch_array_tag(buf, tag_name, tag_num, arr_bytes, element_code=elem_code)


def _patch_array_tag(buf: bytes, tag_name: str, tag_num: int, data: bytes, element_code: int) -> bytes:
    """Find and replace an ABIF tag entry's data.

    ABIF structure:
      - "ABIF" magic at byte 0
      - Header: version (2), dir offset (4), dir entry size (4)...
      - Each dir entry: name (4 bytes big-endian), number (4 bytes big-endian),
                        element_type (2 bytes big-endian), element_size (2 bytes),
                        num_elements (4 bytes), data_size (4 bytes),
                        data_offset (4 bytes), data_handle (4 bytes)
      - Data is stored separately (overlaps possible if data_size < offset)
    """
    if len(buf) < 4 or buf[:4] != b"ABIF":
        raise ValueError(f"not an ABIF file: {buf[:4]!r}")

    # Header
    # version=2, dirEntryCount=4 bytes, reserved=4
    # dir_offset_offset = 4
    dir_offset = struct.unpack(">I", buf[4:8])[0]
    # Number of directory entries (the ABIF spec stores this AFTER the offset)
    # In Biopython output the structure is:
    #   ABIF (4)
    #   version (2)
    #   <unknown 2 bytes>
    #   dir_offset (4)
    #   <unknown 4 bytes>
    #   dir_entry_count (4) -- but this may not be reliably present
    # To keep this simple, we just walk the directory linearly starting at dir_offset
    # until we hit the entry that matches, and rewrite the data_offset + data_size.

    target_name = tag_name.encode("ascii")[:4]
    target_num = tag_num

    # Walk directory entries (28 bytes each)
    pos = dir_offset
    while pos + 28 <= len(buf):
        name = buf[pos:pos+4]
        if name == target_name:
            num = struct.unpack(">I", buf[pos+4:pos+8])[0]
            if num == target_num:
                # Found our entry. Parse the rest.
                element_type = struct.unpack(">H", buf[pos+8:pos+10])[0]
                element_size = struct.unpack(">H", buf[pos+10:pos+12])[0]
                num_elements = struct.unpack(">I", buf[pos+12:pos+16])[0]
                data_size = struct.unpack(">I", buf[pos+16:pos+20])[0]
                data_offset_entry = struct.unpack(">I", buf[pos+20:pos+24])[0]

                # If our new data fits in the existing data_size (with the
                # data stored IN the directory entry itself), overwrite in place.
                # Otherwise append the new data at the end of the file and
                # update the offset.
                if len(data) <= data_size:
                    # In-place overwrite at data_offset_entry (or at pos+24 if data_size < 4)
                    if data_size >= 4:
                        buf = buf[:data_offset_entry] + data + buf[data_offset_entry+data_size:]
                    else:
                        # data was inline in the dir entry (pos+24..pos+28)
                        buf = buf[:pos+24] + data + buf[pos+24+len(data):]
                    return buf
                else:
                    # Append new data at end of file
                    new_offset = len(buf)
                    buf = buf + data
                    # Rewrite data_offset in the dir entry
                    buf = (buf[:pos+20]
                           + struct.pack(">I", new_offset)
                           + buf[pos+24:])
                    # Also rewrite data_size
                    buf = (buf[:pos+16]
                           + struct.pack(">I", len(data))
                           + buf[pos+20:])
                    # Update num_elements if our element size differs from ABI's
                    elem_size = max(1, len(data) // max(1, num_elements)) if num_elements else 1
                    buf = (buf[:pos+10]
                           + struct.pack(">H", elem_size)
                           + buf[pos+12:])
                    return buf
        pos += 28
    # Tag not found — append a new dir entry + data
    # (rare — Seq7 usually has all of these)
    new_offset = len(buf)
    buf = buf + data
    new_entry = (target_name
                 + struct.pack(">I", target_num)
                 + struct.pack(">H", element_code)
                 + struct.pack(">H", 1)
                 + struct.pack(">I", len(data))
                 + struct.pack(">I", len(data))
                 + struct.pack(">I", new_offset)
                 + b"\x00\x00\x00\x00")
    # Append the dir entry at the directory offset
    buf = buf[:dir_offset] + new_entry + buf[dir_offset:]
    # Also bump dirEntryCount if Biopython stored one
    # (this is optional; some parsers don't enforce it)
    return buf
