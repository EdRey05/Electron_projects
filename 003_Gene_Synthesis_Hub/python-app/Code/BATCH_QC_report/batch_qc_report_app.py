"""
Bio Basic Inc. - Canada
Made by: Fabien Lonjon and Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.5
Date: Nov 09, 2026
Notes: Batch QC report generator adapted to the Gene Synthesis hub.
    Simplified interface: folder browser + log area only. BBI ID /
    Plasmid No. / sequence extraction and the Excel report with
    embedded OD images. Field names and report labels follow the
    canonical job-log naming (Plasmid No., Final Vector Sequence,
    ng/uL).
    v1.3: Tesseract replaced by RapidOCR PP-OCRv6-small (in-process,
    onnxruntime; the ONNX det/rec models ship inside the wheel - the
    install stays `pip install rapidocr onnxruntime`, CPU-only, and
    works on the hub's Python 3.14). The reading pipeline feeds
    candidate crops (v1.2 table-geometry data-row strip, bench bottom
    band, per-cell repair) to one engine and one parser; wide junk
    gates protect candidate selection, and a plausibility-rule layer
    (OD260/OD280/ratio ranges; ng/uL deliberately unbounded - elution
    volumes vary) sets each record's status: AUTO, FLAGGED, PARSE-FAIL
    or NO-IMAGE. Flagged records surface in a modal review queue
    before the report is written: the dialog shows the cropped table
    image (whole-image fallback) with four entry fields, and entered
    values land directly in the final report while skipped fields stay
    PENDING placeholders. Every row's disposition was recorded in a
    Status column (Auto / Entered in review / PENDING review; dropped
    in v1.5).
    v1.4: one review dialog for all flagged records - a red section
    title lists the no-OD-table records (read-only), the second section
    is a regular table (one header row in black bold; BBI ID, the exact
    OCR crop, four centered value columns) for the measurements to
    check. Save applies each row independently; skipping leaves the
    flagged fields pending.
    v1.5: sequence extraction standardized on the QC_file_prep naming
    definitions (In-House New Names + BATCH Post Processing): the zip
    name '{Work No.} {BBI ID} in {Vector} {Date} {stripped Tube ID}' is
    parsed once and the two needed .seq files are expected under their
    exact derived names - '{Work No.} {BBI ID}.seq' (insert) and
    '{Work No.}_{Vector}.seq' (final vector; letter-suffixed Work Nos.
    included), so no name shape guessing decides the classification.
    The legacy anchors stay as fallback only, and every classification
    logs which path fired. The Status column was dropped from the
    report; the review-dialog flow and the PENDING placeholders are
    unchanged. The RapidOCR engine is built with the library's
    Global.log_level=WARNING knob so its green "[INFO]" model-load lines
    no longer flood the hub console.
"""

import io
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback
import zipfile
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import customtkinter as ctk


def require(pkg, import_as=None):
    """Import a package; if missing, try a one-time pip install (standalone runs)."""
    import importlib

    try:
        return importlib.import_module(import_as or pkg)
    except ImportError:
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", pkg, "-q"])
        except Exception:
            raise ImportError(
                f"Missing dependency '{pkg}'. Install it into the hub's Python "
                f"environment (see requirements.txt) and relaunch the app."
            )
        return importlib.import_module(import_as or pkg)


require("python-docx", "docx")
require("openpyxl")
require("Pillow", "PIL")
require("numpy")

from docx import Document
import numpy as np
import openpyxl
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from PIL import Image as PILImage, ImageOps, ImageFilter


# ─────────────────────────────────────────────────────────────────────────────
# Convert .doc → .docx using Microsoft Word
# ─────────────────────────────────────────────────────────────────────────────
def convert_doc_to_docx(doc_path: str, out_dir: str, log=print) -> str | None:
    word = None
    try:
        import win32com.client
        # DispatchEx forces a NEW Word instance: Dispatch could attach to
        # a Word window the user has open, and the Quit() below would
        # close it. DisplayAlerts=0 keeps corrupt/problem files from
        # raising hidden modal dialogs inside this invisible instance.
        word    = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        abs_in  = os.path.abspath(doc_path)
        abs_out = os.path.abspath(os.path.join(
            out_dir,
            os.path.splitext(os.path.basename(doc_path))[0] + ".docx"
        ))
        d = word.Documents.Open(abs_in)
        d.SaveAs2(abs_out, FileFormat=16)
        saved = os.path.exists(abs_out)
        d.Close(SaveChanges=0)
        return abs_out if saved else None
    except Exception as e:
        log(f"      ⚠  win32com error: {e}")
        return None
    finally:
        # Quit in a finally: without it, any failure inside Open/SaveAs/
        # Close leaves an invisible WINWORD.EXE process running forever.
        if word is not None:
            try:
                word.Quit()
            except Exception:
                pass


def open_as_docx(doc_path: str, tmp_dir: str, log=print) -> str | None:
    if doc_path.lower().endswith('.docx'):
        return doc_path
    return convert_doc_to_docx(doc_path, tmp_dir, log=log)


# ─────────────────────────────────────────────────────────────────────────────
# BBI ID from ZIP filename  →  "BATCH 2819-8"
# ─────────────────────────────────────────────────────────────────────────────
def extract_bbi_id(zip_name: str) -> str:
    stem = Path(zip_name).stem
    m = re.search(r'(BATCH\s+\d{4}-\d{1,3}|BATCH\s+\d{4})', stem, re.IGNORECASE)
    return re.sub(r'\s+', ' ', m.group(1)).strip() if m else stem


# ─────────────────────────────────────────────────────────────────────────────
# Find BATCH*.doc inside ZIP (any depth)
# ─────────────────────────────────────────────────────────────────────────────
PLASMID_NO_RE = re.compile(r'\b(26[0-9A-Z]{4,}[-\w]*)', re.IGNORECASE)

def find_doc_entry(zip_ref: zipfile.ZipFile):
    for entry in zip_ref.namelist():
        basename = Path(entry).name
        if not basename.lower().endswith(('.doc', '.docx')):
            continue
        if not re.search(r'BATCH', basename, re.IGNORECASE):
            continue
        m = PLASMID_NO_RE.search(basename)
        return entry, (m.group(1) if m else None)
    return None, None


# ─────────────────────────────────────────────────────────────────────────────
# Plasmid No. from "Plasmid No." table row inside the docx
# ─────────────────────────────────────────────────────────────────────────────
def plasmid_no_from_docx(docx_path: str, log=print) -> str | None:
    try:
        d = Document(docx_path)
        for table in d.tables:
            for row in table.rows:
                # Real cells by identity, NOT plain row.cells: row.cells
                # repeats a merged cell once per grid column, so a
                # horizontally merged "Plasmid No." label appears twice and
                # the first "non-empty" value after it is the label itself.
                # Dedupe repeats by the underlying <w:tc> element, then read
                # through the _Cell wrapper (CT_Tc.text is not populated in
                # python-docx 1.2).
                seen_tcs = set()
                cells = []
                for _c in row.cells:
                    if id(_c._tc) in seen_tcs:
                        continue
                    seen_tcs.add(id(_c._tc))
                    cells.append(_c.text.strip())
                for i, cell in enumerate(cells):
                    if re.search(r'plasmid\s*no', cell, re.IGNORECASE):
                        for val in cells[i+1:]:
                            if val:
                                return val
    except Exception as e:
        log(f"      ⚠  plasmid read error: {e}")
    return None


# ─────────────────────────────────────────────────────────────────────────────
# OD measurement image - grab the SMALLEST embedded image (the cropped OD
# table screenshot), ignoring the larger gel image.
# ─────────────────────────────────────────────────────────────────────────────
def od_image_blob_from_docx(docx_path: str, log=print) -> bytes | None:
    try:
        d = Document(docx_path)
        images = []
        for rel in d.part.rels.values():
            if "image" in rel.reltype:
                try:
                    blob = rel.target_part.blob
                    img = PILImage.open(io.BytesIO(blob))
                    images.append((img.size[0] * img.size[1], blob))
                except Exception:
                    pass
        if not images:
            return None
        images.sort(key=lambda x: x[0])  # smallest first
        return images[0][1]
    except Exception as e:
        log(f"      ⚠  image extraction error: {e}")
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Sequence files inside ZIP
#   LA17758 BATCH 2875-04.seq -> Insert sequence
#   LA17758_pMON451760.seq     -> Final Vector sequence
# ─────────────────────────────────────────────────────────────────────────────
def clean_seq_text(raw: bytes) -> str:
    """Return a clean DNA sequence from a .seq file."""
    text = raw.decode("utf-8", errors="ignore")
    lines = text.splitlines()
    if lines and lines[0].lstrip().startswith(">"):
        lines = lines[1:]
    text = "".join(lines).upper()
    return re.sub(r"[^ACGTRYSWKMBDHVN]", "", text)


def normalize_ws_name(text: str) -> str:
    """Whitespace-collapsed, uppercase form of a name for exact-name matching."""
    return " ".join(str(text).split()).upper()


def parse_batch_zip_name(zip_stem: str) -> dict | None:
    """Parse the BATCH zip-name template (defined in QC_file_prep's In-House
    New Names + BATCH Post Processing workflows):

        '{Work No.} {BBI ID} in {Vector} {Date} {stripped Tube ID}'

    Only the pieces the sequence extraction needs are returned (Work No.,
    BBI ID, Vector; the Date and stripped Tube ID are unused here and the
    Gene Name lives inside the Word document, not the zip name).
    Returns None when the template does not match.
    """
    tokens = zip_stem.split()
    in_indices = [i for i, tok in enumerate(tokens) if tok.lower() == "in"]
    if not in_indices:
        return None
    in_idx = in_indices[0]
    left, right = tokens[:in_idx], tokens[in_idx + 1:]
    if len(left) < 2 or len(right) < 1:
        return None
    return {"work_no": left[0], "bbi_id": " ".join(left[1:]), "vector": right[0]}


def extract_sequence_files(zip_ref: zipfile.ZipFile, bbi_id: str, log=print, zip_stem: str | None = None) -> tuple[str | None, str | None]:
    """Read the two .seq files the report needs - EXACT derived names first.

    File naming is defined by the QC_file_prep BATCH Post Processing
    workflow: '{Work No.} {BBI ID}.seq' carries the insert sequence and
    '{Work No.}_{Vector}.seq' the final vector sequence. Both names are
    derived from the zip name itself, so letter-suffixed Work Nos.
    (LA18985G) resolve exactly like digit-only ones (LA17758). When the
    zip name does not match the template - or a zip deviates from the
    defined file names - the legacy anchors stay as fallback (BBI-ID/
    BATCH-token anchor for the insert, shape regexes for the vector,
    widened to accept the letter suffix). Every classification path is
    logged.
    """
    insert_seq = None
    final_vector_seq = None

    normalized_bbi = re.sub(r"\s+", " ", bbi_id).strip().upper()

    # Read every .seq member once, then classify: exact derived names
    # first, legacy anchors second, first match wins per slot.
    candidates = []
    for entry in zip_ref.namelist():
        basename = Path(entry).name
        if not basename.lower().endswith(".seq"):
            continue

        name_no_ext = Path(basename).stem
        upper_name = re.sub(r"\s+", " ", name_no_ext).strip().upper()

        try:
            with zip_ref.open(entry) as f:
                seq = clean_seq_text(f.read())
        except Exception as e:
            log(f"      ⚠  Could not read sequence file {basename}: {e}")
            continue

        if not seq:
            log(f"      ⚠  Empty/invalid sequence: {basename}")
            continue

        candidates.append((basename, upper_name, seq))

    parsed = parse_batch_zip_name(zip_stem) if zip_stem else None
    insert_exact = normalize_ws_name(f"{parsed['work_no']} {parsed['bbi_id']}") if parsed else None
    vector_exact = normalize_ws_name(f"{parsed['work_no']}_{parsed['vector']}") if parsed else None
    if parsed:
        log(
            f"      i  ZIP name parsed - Work No.: {parsed['work_no']}, "
            f"BBI ID: {parsed['bbi_id']}, Vector: {parsed['vector']}"
        )
        if not normalize_ws_name(parsed["bbi_id"]).startswith(normalized_bbi):
            log(
                f"      ⚠  BBI ID parsed from the zip name ({parsed['bbi_id']!r}) "
                f"does not start with the extracted one ({bbi_id!r}) - check the zip name."
            )

    for basename, upper_name, seq in candidates:
        # --- Insert sequence: exact derived name first, legacy anchor next
        how = None
        if insert_exact is not None and upper_name == insert_exact:
            how = "exact derived name"
        elif re.search(rf"\b{re.escape(normalized_bbi)}\b", upper_name, re.IGNORECASE):
            how = "BBI-ID anchor (fallback)"
        if how:
            if insert_seq is None:
                insert_seq = seq
                log(f"      ✓  Insert sequence: {basename} ({len(seq):,} bp) [{how}]")
            else:
                log(
                    f"      ⚠  Skipped extra file matching {bbi_id} "
                    f"(insert already read): {basename} ({len(seq):,} bp)"
                )
            continue

        # --- Final vector sequence: exact derived name first, shape regexes next
        how = None
        if vector_exact is not None and upper_name == vector_exact:
            how = "exact derived name"
        elif re.match(r"^LA\d+_.+\.seq$", basename, re.IGNORECASE):
            how = "shape regex (fallback)"
        elif re.match(r"^LA\d+[A-Z]*_.+\.seq$", basename, re.IGNORECASE):
            how = "shape regex, letter-suffixed Work No. (fallback)"
        if how:
            if final_vector_seq is None:
                final_vector_seq = seq
                log(f"      ✓  Final vector sequence: {basename} ({len(seq):,} bp) [{how}]")
            else:
                log(f"      ⚠  Skipped extra vector-candidate file (vector already read): {basename} [{how}]")

    return insert_seq, final_vector_seq


# ─────────────────────────────────────────────────────────────────────────────
# OD reading: RapidOCR PP-OCRv6-small (in-process, onnxruntime) + rules
# ─────────────────────────────────────────────────────────────────────────────
# The Tesseract voting stack was retired in this rework. RapidOCR v6-small
# runs fully in-process (no model server; the ONNX det/rec models are bundled
# inside the rapidocr wheel - no first-run downloads), is CPU-only and works
# on the hub's Python 3.14. Bench on the 2026-11 validated set: ~84% ->
# ~97% complete-record agreement, with every residual error caught by the
# plausibility rules below.
#
# Reading strategy per record - candidate inputs tried in order, first
# gate-passing 4-tuple wins:
#   1. the data-row strip located by the v1.2 table geometry (horizontal
#      rules, split_table_cells),
#   2. the bottom-band crop of the 2026-11 bench (last two full-width rules
#      under the table; fallback: the last 34 px),
#   3. the four individual cells (vertical rules) read one at a time -
#      the repair pass for rows whose strip read produced junk.
# One engine and one parser apply to every candidate.

# Plausibility rules (v1.1): a field outside its range FLAGS the record for
# user review; flagged values are shown in the review dialog, never
# overwritten. Ranges are physical bounds for NanoDrop-style OD tables.
#   od260 / od280 calibrated on the 2026-11 validated batch (OD260 readings
#   on real batches reach ~5.6, OD280 ~2.9).
#   OD260/OD280 ratio: Ed's domain ruling - this is DNA, so the printed
#   ratio is always 1.8-2.0.
# ng/uL is deliberately UNRANGED (concentration varies with prep type, the
# vector's expression level and the amount requested). A printed-value
# cross-check like ng/uL == 50 x OD260 was considered and REJECTED for the
# same reason - do not reintroduce it as a flag.
_OD_RULE_RANGES = {
    "od260":    (0.3, 6.5),
    "od280":    (0.4, 3.6),
    "od_ratio": (1.8, 2.0),
}
# Wide parser gates (junk protection only, not plausibility): a mis-parsed
# junk token is rejected as a READ so the next candidate input is tried,
# while in-gate-but-implausible values flow to the flag layer instead of
# being dropped.
_OD_PARSE_GATES = {
    "od260":    (0.0, 20.0),
    "od280":    (0.0, 20.0),
    "od_ratio": (0.1, 5.0),
    "ng_ul":    (0.0, 10000.0),
}

_OD_FIELDS = ("od260", "od280", "od_ratio", "ng_ul")

_OCR_ENGINE = None


def _load_ocr_engine(log=print):
    """Import and build the RapidOCR engine once per app session. Lazy like
    pytesseract was: a missing package must not block importing this module
    or launching the hub."""
    global _OCR_ENGINE
    if _OCR_ENGINE is not None:
        return _OCR_ENGINE
    require("onnxruntime")
    require("rapidocr")
    from rapidocr import RapidOCR

    # The engine's own INFO logging (green "[INFO]" model-load lines from its
    # colorlog handler) floods the hub's console; the library's Global.log_level
    # config knob silences it while warnings/errors still print.
    _OCR_ENGINE = RapidOCR(params={"Global.log_level": "WARNING"})
    return _OCR_ENGINE


def _strip_tokens_from_txts(txts) -> list:
    """Numeric tokens from a RapidOCR reading. Fragments containing letters
    (column headers, border junk like 'VUV') are dropped; single-char digit
    tokens are border misreads and are dropped ONLY when more than four
    numeric tokens remain (a value cell can legitimately read as a bare
    integer, e.g. ng/uL '173')."""
    tokens = []
    for tok in txts or ():
        tok = str(tok).strip()
        if not tok or re.search(r"[A-Za-z]", tok):
            continue
        m = re.fullmatch(r"(\d+(?:[.,]\d+)?)", tok)
        if m:
            tokens.append(float(m.group(1).replace(",", ".")))
    if len(tokens) > 4:
        trimmed = [t for t in tokens if not (t == int(t) and 0 <= t <= 9)]
        tokens = trimmed or tokens
    return tokens


def _values_from_tokens(tokens) -> "dict | None":
    """Map the printed column order OD260, OD280, OD260/OD280, ng/uL onto the
    field names, applying the wide parser gates. None = this candidate read
    failed (caller tries the next input)."""
    if len(tokens) < 4:
        return None
    vals = tokens[-4:]  # the data row is the last row in reading order
    mapped = dict(zip(_OD_FIELDS, vals))
    for field, value in mapped.items():
        lo, hi = _OD_PARSE_GATES[field]
        if not (lo < value < hi):
            return None
    return mapped


def _data_row_strip_from_table(table_img):
    """Crop the printed data row using the v1.2 table geometry (the same
    horizontal-rule detection split_table_cells uses, including the
    implicit-edge handling for cropped-away borders)."""
    arr = np.array(table_img)
    h, w = arr.shape
    row_dark_frac = (arr < 140).mean(axis=1)
    h_lines = []
    for y, f in enumerate(row_dark_frac):
        if f > 0.5 and (not h_lines or y - h_lines[-1] > 2):
            h_lines.append(y)
    h_lines = _add_implicit_edges(h_lines, h)
    if len(h_lines) < 2:
        return None
    y0, y1 = h_lines[-2], h_lines[-1]  # the data row is the last segment
    if y1 - y0 < 10:
        return None
    return table_img.crop((0, max(0, y0), w, min(h, y1)))


def _bench_bottom_band(img):
    """The 2026-11 bench band: between the last two full-width dark rules in
    the bottom 140 px; fallback band = the last 34 px (minus the margin)."""
    arr = np.array(img)
    h, w = arr.shape
    ys = [y for y in range(max(0, h - 140), h) if (arr[y] < 100).sum() > w * 0.7]
    groups = []
    for y in ys:
        if not groups or y > groups[-1][-1] + 1:
            groups.append([y])
        else:
            groups[-1].append(y)
    if len(groups) >= 2 and groups[-1][-1] >= h - 8:
        top, bottom = groups[-2][-1] + 2, groups[-1][0] - 1
    else:
        top, bottom = h - 34, h - 2
    if bottom <= top:
        return None
    return img.crop((0, top, w, bottom))


def _png_bytes(pil_img) -> "bytes | None":
    """PNG bytes of a PIL image, for the review dialog (None-safe)."""
    try:
        buf = io.BytesIO()
        pil_img.convert("RGB").save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        return None


def locate_table_top(img_gray: "PILImage.Image") -> int:
    """
    Auto-detect the y-pixel where the OD results table begins.

    The table (borders + text) spans the FULL width of the image, while the
    gel picture above it only occupies part of the width (the rest of the
    image next to the gel is blank/white). So we scan a few columns close to
    the right edge - past where the gel picture ends - from top to bottom,
    and return the first row where at least 2 of them turn dark. That's the
    top border line of the table.

    Falls back to 75% of the image height if nothing is found (e.g. the
    image is only the table, with no gel picture above it).
    """
    arr = np.array(img_gray)
    h, w = arr.shape

    sample_cols = [int(w * f) for f in (0.90, 0.95, 0.99)]
    dark_masks = [(arr[:, c] < 140) for c in sample_cols]
    votes = np.sum(dark_masks, axis=0)
    dark_rows = np.where(votes >= 2)[0]

    if len(dark_rows) > 0:
        return int(dark_rows[0])
    return int(h * 0.75)


def _add_implicit_edges(lines: list[int], length: int) -> list[int]:
    """
    Given detected border-line positions along one axis of the table image
    (already de-duplicated) and the full pixel length of that axis, decide
    whether the leading and/or trailing edge of the image should be treated
    as an extra implicit border.

    Some screenshots are cropped tightly enough that one of the table's
    outer borders (top/bottom/left/right) was never captured - e.g. the
    image simply ends a few pixels past the last row of digits, or starts
    a little inside the table's left edge, with no printed line there. If
    that's not corrected, the "data row" or "cell" boundaries silently
    shift by one, quietly pulling in the wrong text (this has been
    observed on both the bottom edge and the left edge, on different
    documents).

    A FIXED pixel threshold cannot tell a genuinely missing border (which
    needs a fresh boundary at the image edge) apart from a real border that
    simply has a few pixels of harmless margin/anti-aliasing before the
    true image edge - and that margin scales with the image's resolution.
    So instead, the leading/trailing margin is compared to the AVERAGE
    spacing between the lines that were actually detected: a margin close
    to one full "cell" worth of space means a whole border is missing
    there and must be added; a small margin relative to that spacing is
    just padding around an already-real border, and is left alone.
    """
    lines = list(lines)
    if len(lines) >= 2:
        gaps = [lines[i + 1] - lines[i] for i in range(len(lines) - 1)]
        avg_gap = sum(gaps) / len(gaps)
    else:
        avg_gap = None  # not enough lines to estimate a typical cell size

    leading = lines[0] if lines else length
    trailing = (length - 1 - lines[-1]) if lines else length

    def is_missing(margin: int) -> bool:
        if avg_gap is None:
            return margin > 5  # not enough info: fall back to a small absolute bar
        return margin >= 0.6 * avg_gap

    if not lines or is_missing(leading):
        lines = [0] + lines
    if not lines or is_missing(trailing):
        lines = lines + [length - 1]
    return lines


def split_table_cells(table_img_gray: "PILImage.Image"):
    """
    Given an image cropped to start at the top of the OD table (title row +
    header row + data row), locate the DATA row (the last row, between the
    last two horizontal border lines) and split it into its 4 value cells
    (OD260 / OD280 / OD260/OD280 / ng-uL) using the vertical border lines.
    Returns a list of 4 PIL images, or None if the table structure could
    not be reliably located (caller falls back to a whole-row OCR pass).
    """
    arr = np.array(table_img_gray)
    h, w = arr.shape

    row_dark_frac = (arr < 140).mean(axis=1)
    h_lines = []
    for y, f in enumerate(row_dark_frac):
        if f > 0.5 and (not h_lines or y - h_lines[-1] > 2):
            h_lines.append(y)
    h_lines = _add_implicit_edges(h_lines, h)

    if len(h_lines) < 2:
        return None

    y0, y1 = h_lines[-2], h_lines[-1]  # the data row is the last segment
    if y1 - y0 < 10:
        return None

    strip = arr[y0:y1, :]
    col_dark_frac = (strip < 140).mean(axis=0)
    v_lines = []
    for x, f in enumerate(col_dark_frac):
        if f > 0.6 and (not v_lines or x - v_lines[-1] > 2):
            v_lines.append(x)
    v_lines = _add_implicit_edges(v_lines, w)
    if len(v_lines) != 5:  # need exactly 4 cells -> 5 boundaries
        return None

    cells = []
    for i in range(4):
        x0, x1 = v_lines[i], v_lines[i + 1]
        cell = PILImage.fromarray(arr[y0 + 2:min(y1, h) - 2, x0 + 2:x1 - 2])
        cells.append(cell)
    return cells


def _engine_read_strip(strip_img, engine, log=print) -> list:
    """Upscale a data-row strip (Lanczos 4x + white padding, the bench-
    validated input class) and run RapidOCR; returns the text tokens in
    left-to-right reading order."""
    big = strip_img.resize(
        (strip_img.width * 4, strip_img.height * 4), PILImage.LANCZOS
    )
    big = ImageOps.expand(big, border=20, fill="white")
    arr = np.array(big)
    if arr.ndim == 2:
        arr = np.dstack([arr] * 3)
    try:
        out = engine(arr)
    except Exception as e:
        log(f"      ⚠  OCR engine error: {e}")
        return []
    txts = list(getattr(out, "txts", None) or ())
    boxes = getattr(out, "boxes", None)
    items = []
    for i, tok in enumerate(txts):
        xc = float(i)
        if boxes is not None and i < len(boxes) and boxes[i] is not None:
            try:
                xc = float(np.mean([p[0] for p in boxes[i]]))
            except Exception:
                pass
        items.append((xc, str(tok)))
    items.sort(key=lambda it: it[0])
    return [tok for _, tok in items]


def _read_single_cell(cell_img, engine, allowed_range=None, log=print):
    """Read one cropped value cell with the same engine; returns the float or
    None. When the cell yields several numeric tokens (border junk), a
    candidate inside that column's physical range wins; otherwise the longest
    digit run is the best repair bet (row-reading mistakes on this layout
    mostly DROP digits). The winning value still flows through the flag
    layer, so a junk repair never hides behind this helper."""
    arr = np.array(cell_img.resize(
        (cell_img.width * 4, cell_img.height * 4), PILImage.LANCZOS
    ))
    arr = ImageOps.expand(PILImage.fromarray(arr), border=20, fill="white")
    arr = np.array(arr)
    if arr.ndim == 2:
        arr = np.dstack([arr] * 3)
    try:
        out = engine(arr)
    except Exception as e:
        log(f"      ⚠  OCR engine error on cell crop: {e}")
        return None
    toks = []
    for tok in getattr(out, "txts", None) or ():
        tok = str(tok).strip()
        if not tok or re.search(r"[A-Za-z]", tok):
            continue
        m = re.fullmatch(r"(\d+(?:[.,]\d+)?)", tok)
        if m:
            toks.append(float(m.group(1).replace(",", ".")))
    if not toks:
        return None
    if allowed_range:
        lo, hi = allowed_range
        in_range = [t for t in toks if lo <= t <= hi]
        if in_range:
            return in_range[0]
    return max(toks, key=lambda t: len(re.sub(r"\D", "", str(t))))


def _read_cells_individually(cells, engine, log=print):
    """Repair pass: read each of the four split cells on its own and reapply
    the parser gates to the tuple. Returns the gate-passing dict or None."""
    read = {}
    for field, cell in zip(_OD_FIELDS, cells):
        read[field] = _read_single_cell(cell, engine,
                                        allowed_range=_OD_PARSE_GATES[field],
                                        log=log)
    if not all(read.get(f) is not None for f in _OD_FIELDS):
        return None
    mapped = {f: read[f] for f in _OD_FIELDS}
    for field, value in mapped.items():
        lo, hi = _OD_PARSE_GATES[field]
        if not (lo < value < hi):
            return None
    log("      ✓  OD (per-cell repair): "
        f"OD260={mapped['od260']} / OD280={mapped['od280']} / "
        f"Ratio={mapped['od_ratio']} / ng/uL={mapped['ng_ul']}")
    return mapped


def od_values_from_blob(blob: bytes, log=print) -> dict:
    """
    Read the four values from the OD measurement table with RapidOCR v6-small
    and determine the record's reading status:

      AUTO       values read, every OD/ratio inside its plausibility range
      FLAGGED    values read, at least one OD/ratio outside its range
      PARSE_NO   no candidate input produced a gate-passing 4-tuple

    ng/uL has no plausibility range by design (elution volume varies, so
    concentrations span several orders of magnitude across real batches).

    Returns dict: the four values (floats or None), od_status, od_flags
    (human-readable reasons for the review dialog), and od_crop (PNG bytes of
    the cropped table region - the review dialog falls back to the whole
    image when the crop could not be produced).
    """
    result = {"od260": None, "od280": None, "od_ratio": None, "ng_ul": None,
              "od_status": "PARSE_NO", "od_flags": [], "od_flag_fields": [],
              "od_crop": None}

    try:
        engine = _load_ocr_engine(log=log)
    except ImportError as e:
        log("      ⚠  OCR engine not installed (rapidocr / onnxruntime) - "
            "OD values could not be read.")
        result["od_status"] = "NO_OCR"
        result["od_flags"] = [f"OCR engine not available: {e}"]
        return result

    try:
        img = PILImage.open(io.BytesIO(blob)).convert("L")
        w, h = img.size

        table_top = max(0, locate_table_top(img) - 2)
        table_img = img.crop((0, table_top, w, h))
        result["od_crop"] = _png_bytes(table_img)

        values = None

        strip = _data_row_strip_from_table(table_img)
        if strip is not None:
            toks = _strip_tokens_from_txts(_engine_read_strip(strip, engine, log=log))
            values = _values_from_tokens(toks)
            if values:
                log("      ✓  OD (data row): "
                    f"OD260={values['od260']} / OD280={values['od280']} / "
                    f"Ratio={values['od_ratio']} / ng/uL={values['ng_ul']}")

        if values is None:
            band = _bench_bottom_band(img)
            if band is not None and band.height >= 6:
                toks = _strip_tokens_from_txts(_engine_read_strip(band, engine, log=log))
                values = _values_from_tokens(toks)
                if values:
                    log("      ✓  OD (bottom band): "
                        f"OD260={values['od260']} / OD280={values['od280']} / "
                        f"Ratio={values['od_ratio']} / ng/uL={values['ng_ul']}")

        if values is None:
            cells = split_table_cells(table_img)
            if cells:
                values = _read_cells_individually(cells, engine, log=log)

        if values is None:
            log(f"      ⚠  Could not reliably read all four OD values "
                f"(table region detected at y={table_top} px of {h} px).")
            result["od_status"] = "PARSE_NO"
            result["od_flags"] = ["The four OD values could not be read reliably."]
            return result

        flags = []
        flag_fields = []
        for field in _OD_FIELDS[:3]:
            lo, hi = _OD_RULE_RANGES[field]
            v = values[field]
            if not (lo <= v <= hi):
                label = {"od260": "OD260", "od280": "OD280",
                         "od_ratio": "OD260/OD280"}[field]
                flags.append(f"{label} = {v} - outside its expected range {lo}-{hi}")
                flag_fields.append(field)

        result.update(values)
        result["od_status"] = "FLAGGED" if flags else "AUTO"
        result["od_flags"] = flags
        result["od_flag_fields"] = flag_fields
        if flags:
            for flag in flags:
                log(f"      ⚠  {flag} - flagged for review.")

    except Exception as e:
        log(f"      ⚠  OD OCR error: {e}")
        result["od_status"] = "PARSE_NO"
        result["od_flags"] = [f"Reading error: {e}"]

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Process one ZIP → return dict with all info
# ─────────────────────────────────────────────────────────────────────────────
def process_zip(zip_path: str, tmp_dir: str, log=print) -> dict:
    bbi_id          = extract_bbi_id(Path(zip_path).name)
    plasmid_no      = "NOT FOUND"
    insert_seq      = None
    final_vector_seq = None
    od_blob         = None
    od_values = {"od260": None, "od280": None, "od_ratio": None, "ng_ul": None,
                 "od_status": "NO_IMAGE",
                 "od_flags": ["No OD measurement image could be extracted from the ZIP."],
                 "od_crop": None}

    try:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            insert_seq, final_vector_seq = extract_sequence_files(zf, bbi_id, log=log, zip_stem=Path(zip_path).stem)

            doc_entry, plasmid_no_from_filename = find_doc_entry(zf)

            if doc_entry:
                safe      = re.sub(r'[^\w.]', '_', Path(doc_entry).name)
                doc_local = os.path.join(tmp_dir, f"{bbi_id}_{safe}")
                with zf.open(doc_entry) as src, open(doc_local, 'wb') as dst:
                    dst.write(src.read())

                log(f"      ✓  Doc: {Path(doc_entry).name}")

                conv_dir   = os.path.join(tmp_dir, "conv")
                os.makedirs(conv_dir, exist_ok=True)
                docx_local = open_as_docx(doc_local, conv_dir, log=log)

                if docx_local:
                    plasmid_no_from_doc = plasmid_no_from_docx(docx_local, log=log)
                    plasmid_no   = plasmid_no_from_doc or plasmid_no_from_filename or "NOT FOUND"
                    log(f"      ✓  Plasmid No.: {plasmid_no}")

                    od_blob = od_image_blob_from_docx(docx_local, log=log)
                    if od_blob:
                        dims = ""
                        try:
                            w, h = PILImage.open(io.BytesIO(od_blob)).size
                            dims = f" ({w}x{h} px)"
                        except Exception:
                            pass
                        log(f"      ✓  OD image found{dims}")
                        od_values = od_values_from_blob(od_blob, log=log)
                    else:
                        log("      ⚠  OD image not found")
                        od_values = {"od260": None, "od280": None, "od_ratio": None, "ng_ul": None,
                                     "od_status": "NO_IMAGE",
                                     "od_flags": ["No OD measurement image found in the document."],
                                     "od_crop": None}
                else:
                    plasmid_no = plasmid_no_from_filename or "NOT FOUND"
                    od_values["od_flags"] = ["The document could not be converted/read."]
            else:
                log(f"      ⚠  No BATCH*.doc found inside ZIP")
                od_values["od_flags"] = ["No BATCH*.doc document found inside the ZIP."]

    except zipfile.BadZipFile:
        log(f"      ✗  Not a valid ZIP file")
        od_values["od_flags"] = ["Not a valid ZIP file."]
    except Exception as e:
        log(f"      ✗  Error: {e}")
        od_values["od_flags"] = [f"ZIP processing error: {e}"]

    return {
        "bbi_id":          bbi_id,
        "plasmid_no":      plasmid_no,
        "insert_seq":      insert_seq,
        "final_vector_seq": final_vector_seq,
        "od260":           od_values["od260"],
        "od280":           od_values["od280"],
        "od_ratio":        od_values["od_ratio"],
        "ng_ul":           od_values["ng_ul"],
        "od_status":       od_values["od_status"],
        "od_flags":        od_values.get("od_flags", []),
        "od_crop":         od_values.get("od_crop"),
        "od_blob":         od_blob,
        "zip_name":        Path(zip_path).stem
    }


# ─────────────────────────────────────────────────────────────────────────────
# Write Excel report
# ─────────────────────────────────────────────────────────────────────────────
ROW_HEIGHT_PX   = 20
MAX_IMG_WIDTH   = 350

def write_excel_report(records: list[dict], output_path: str, log=print):
    img_tmp_dir = tempfile.mkdtemp()

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "QC Report"

    headers = ["ZIP", "BBI ID", "Plasmid No.", "ng/uL", "OD260", "OD280", "OD260/OD280", "Insert sequence", "Final Vector Sequence"]
    ws.append(headers)

    header_fill = PatternFill(start_color="1F4E79", end_color="1F4E79", fill_type="solid")
    header_font = Font(bold=True, color="FFFFFF")
    for col_idx in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center")

    pending_placeholders = {"ng_ul": "PENDING", "od260": "PENDING", "od280": "PENDING", "od_ratio": "PENDING"}

    for rec in records:
        pending = rec.get("od_status") == "PENDING"
        # A skipped review record keeps placeholders ONLY in the fields the
        # user was asked about (flagged/out-of-range or unreadable); values
        # that were read inside every gate stay in the table.
        pending_fields = rec.get("od_pending_fields")
        if pending and pending_fields is None:
            pending_fields = set(pending_placeholders)
        od_cells = {}
        for field in pending_placeholders:
            value = rec[field]
            if pending and field in pending_fields:
                value = None
            od_cells[field] = value
        ws.append([
            rec["zip_name"],
            rec["bbi_id"],
            rec["plasmid_no"],
            od_cells["ng_ul"] if od_cells["ng_ul"] is not None else "PENDING" if pending else "NOT FOUND",
            od_cells["od260"] if od_cells["od260"] is not None else "PENDING" if pending else "NOT FOUND",
            od_cells["od280"] if od_cells["od280"] is not None else "PENDING" if pending else "NOT FOUND",
            od_cells["od_ratio"] if od_cells["od_ratio"] is not None else "PENDING" if pending else "NOT FOUND",
            rec["insert_seq"] or "NOT FOUND",
            rec["final_vector_seq"] or "NOT FOUND",
        ])

    for col_idx, header in enumerate(headers, start=1):
        max_len = len(header)
        for row in ws.iter_rows(
            min_col=col_idx, max_col=col_idx,
            min_row=2, max_row=len(records) + 1
        ):
            for cell in row:
                if cell.value is not None:
                    sample_len = min(len(str(cell.value)), 60)
                    max_len = max(max_len, sample_len)

        if col_idx in (8, 9):
            ws.column_dimensions[get_column_letter(col_idx)].width = 45
        elif col_idx in (4, 5, 6, 7):
            ws.column_dimensions[get_column_letter(col_idx)].width = 14
        else:
            ws.column_dimensions[get_column_letter(col_idx)].width = min(max_len + 4, 40)

    ws.freeze_panes = "A2"

    current_row = len(records) + 3

    label_font = Font(bold=True, color="1F4E79", size=12)

    for rec in records:
        ws.cell(row=current_row, column=1,
                 value=f"{rec['zip_name']}  —  OD Measurement "
                       f"(BBI ID: {rec['bbi_id']} / Plasmid No.: {rec['plasmid_no']})").font = label_font
        current_row += 1

        if rec["od_blob"]:
            try:
                pil_img = PILImage.open(io.BytesIO(rec["od_blob"])).convert("RGB")
                w, h = pil_img.size
                if w > MAX_IMG_WIDTH:
                    scale = MAX_IMG_WIDTH / w
                    disp_w, disp_h = int(w * scale), int(h * scale)
                else:
                    disp_w, disp_h = w, h

                safe_name = re.sub(r'[^\w]', '_', rec['zip_name'])[:60]
                img_path = os.path.join(img_tmp_dir, f"{safe_name}_{current_row}.png")
                pil_img.save(img_path, format="PNG")

                xl_img = XLImage(img_path)
                xl_img.width  = disp_w
                xl_img.height = disp_h
                anchor = f"A{current_row}"
                ws.add_image(xl_img, anchor)

                rows_needed = math.ceil(disp_h / ROW_HEIGHT_PX) + 1
                current_row += rows_needed
            except Exception as e:
                ws.cell(row=current_row, column=1, value=f"⚠ Could not embed image: {e}")
                current_row += 1
        else:
            ws.cell(row=current_row, column=1, value="⚠  OD image not found in document.")
            current_row += 1

        current_row += 2

    try:
        wb.save(output_path)
    except PermissionError as e:
        raise RuntimeError(
            f"Could not save the report: {output_path}\n"
            f"It is likely open in Excel - close it and run the report again.\n"
            f"({e})"
        ) from e
    finally:
        shutil.rmtree(img_tmp_dir, ignore_errors=True)
    log(f"\n✅  Excel report saved → {output_path}")


def _short_od_reason(rec: dict) -> str:
    """One short phrase per no-OD-table record: 'No Word document found' or
    'No OD table image found', for the summary list dialog."""
    joined = " | ".join(rec.get("od_flags") or [])
    if "doc" in joined.lower() and ("BATCH" in joined or "inside the ZIP" in joined):
        return "No Word document found"
    if "image" in joined.lower():
        return "No OD table image found"
    return joined[:60] or "No OD table"


class OdReviewDialog(ctk.CTkToplevel):
    """
    One dialog for ALL readable flagged records (suspicious values or read
    failures): a ROW per record, BBI ID + short reason on the left, the exact
    table image the OCR read in the middle, and the four labeled entry
    columns to the right. More flagged records just add rows (the rows area
    scrolls).

    On save, each row is applied independently: all four numbers typed ->
    the record is MANUAL; rows left (partially) empty stay PENDING with the
    typed values kept in place and only the blank flagged fields listed as
    pending. Non-numeric text in a row is rejected with the record named.
    "Leave all pending" closes without writing anything.

    self.result = True when rows were applied (the record dicts are updated
    in place); None when skipped entirely.
    """

    _IMG_W, _IMG_H = 330, 62

    def __init__(self, master, no_input: list, readable: list):
        super().__init__(master)
        self.recs = readable
        self.no_input = no_input
        self.result = None
        self._rows = []  # (rec, [(label, field, entry), ...])

        total = len(no_input) + len(readable)
        self.title(f"OD value review - {total} record(s)")
        scr_h = max(master.winfo_screenheight(), 600)
        body_h = (70 + len(readable) * 96
                  + (60 + min(len(no_input), 12) * 26 if no_input else 0))
        # Ed: ~20% taller than the bare rows need, so the rows breathe.
        win_h = min(int(scr_h * 0.8), int(max(body_h, 320) * 1.2))
        self.geometry(f"1130x{win_h}")
        self.transient(master)
        try:
            self.grab_set()
        except Exception:
            pass
        self.protocol("WM_DELETE_WINDOW", self._skip_all)

        # Buttons pinned at the bottom: packed BEFORE the rows area.
        btn_frame = ctk.CTkFrame(self, fg_color="transparent")
        btn_frame.pack(side="bottom", pady=(4, 10), fill="x")
        ctk.CTkButton(
            btn_frame,
            text="Save & close",
            command=self._save,
            fg_color="#3C702D",
            hover_color="#4CAF50",
            width=170,
            height=34,
        ).pack(side="left", padx=10)
        ctk.CTkButton(
            btn_frame,
            text="Leave all pending",
            command=self._skip_all,
            fg_color="gray40",
            hover_color="gray30",
            width=180,
            height=34,
        ).pack(side="left", padx=10)

        if no_input:
            ctk.CTkLabel(
                self,
                text=f"These {len(no_input)} record(s) have no OD table - "
                     f"nothing to check or type:",
                font=ctk.CTkFont(size=16, weight="bold"),
                text_color="#D32F2F",
            ).pack(padx=22, pady=(8, 4), anchor="w")
            tree_frame = ctk.CTkFrame(self, fg_color="transparent")
            tree_frame.pack(fill="x", padx=16)
            tree = ttk.Treeview(tree_frame, columns=("zip", "reason"),
                                show="headings", height=min(len(no_input), 8))
            tree.heading("zip", text="ZIP")
            tree.heading("reason", text="Reason")
            tree.column("zip", width=470, anchor="w")
            tree.column("reason", width=240, anchor="w")
            for rec in no_input:
                tree.insert("", "end",
                            values=(rec["zip_name"], _short_od_reason(rec)))
            tree.pack(fill="x")
            sb = ttk.Scrollbar(tree_frame, orient="vertical", command=tree.yview)
            tree.configure(yscrollcommand=sb.set)
            sb.pack(side="right", fill="y")

        if readable:
            ctk.CTkLabel(
                self,
                text=f"Check these {len(readable)} measurements and enter "
                     f"the values:",
                font=ctk.CTkFont(size=16, weight="bold"),
                text_color="#D32F2F",
            ).pack(padx=22, pady=(10, 4), anchor="w")

        # Shared column geometry: the header frame and every data row use
        # the SAME minsizes/weights, regular-table style - ONE header row on
        # top, no labels repeated per row, cells vertically centered.
        def _grid_columns(grid):
            grid.grid_columnconfigure(0, weight=0, minsize=160)
            grid.grid_columnconfigure(1, weight=0, minsize=350)
            for col in range(2, 6):
                grid.grid_columnconfigure(col, weight=1, minsize=128, uniform="val")

        header = ctk.CTkFrame(self, fg_color="transparent")
        header.pack(fill="x", padx=22, pady=(6, 0))
        _grid_columns(header)
        hdr_labels = ["BBI ID", "Table image", "OD260", "OD280",
                      "OD260/OD280", "ng/uL"]
        for col, text in enumerate(hdr_labels):
            ctk.CTkLabel(header, text=text,
                         font=ctk.CTkFont(size=13, weight="bold"),
                         text_color="black").grid(row=0, column=col,
                                                  sticky="nsew")

        rows_area = ctk.CTkScrollableFrame(self)
        rows_area.pack(fill="both", expand=True, padx=16, pady=(4, 0))

        labeled = [("OD260", "od260"), ("OD280", "od280"),
                   ("OD260/OD280", "od_ratio"), ("ng/uL", "ng_ul")]

        for rec in self.recs:
            row = ctk.CTkFrame(rows_area, fg_color="transparent")
            row.pack(fill="x", padx=4, pady=(4, 4))
            _grid_columns(row)
            row.grid_rowconfigure(0, weight=1, minsize=76)

            # col 0: BBI ID (vertical center)
            ctk.CTkLabel(row, text=rec["bbi_id"],
                         font=ctk.CTkFont(size=14, weight="bold")).grid(
                row=0, column=0, padx=(2, 6), sticky="nsew")

            # col 1: the table image exactly as fed to the OCR
            try:
                pil_img = PILImage.open(
                    io.BytesIO(rec.get("od_crop") or rec.get("od_blob"))
                ).convert("RGB")
                scale = min(self._IMG_W / max(pil_img.width, 1),
                            self._IMG_H / max(pil_img.height, 1), 1.0)
                disp = (max(1, int(pil_img.width * scale)),
                        max(1, int(pil_img.height * scale)))
                tk_img = ctk.CTkImage(light_image=pil_img, size=disp)
                ctk.CTkLabel(row, image=tk_img, text="").grid(
                    row=0, column=1, padx=(0, 6), sticky="nsew")
                self.__dict__.setdefault("_imgs", []).append(tk_img)
            except Exception:
                ctk.CTkLabel(row, text="No image",
                             font=ctk.CTkFont(size=11, slant="italic")).grid(
                    row=0, column=1, padx=(0, 6), sticky="nsew")

            # cols 2-5: value entries, vertically centered, no per-row labels
            entries = []
            for col, (label, field) in enumerate(labeled, start=2):
                entry = ctk.CTkEntry(row, width=140, justify="center")
                if rec.get(field) is not None:
                    entry.insert(0, str(rec[field]))
                entry.grid(row=0, column=col, padx=4, sticky="ew")
                entries.append((label, field, entry))
            self._rows.append((rec, entries))

    def _save(self):
        for rec, entries in self._rows:
            values = {}
            for label, field, entry in entries:
                text = entry.get().strip().replace(",", ".")
                if text == "":
                    values[field] = None
                    continue
                try:
                    values[field] = float(text)
                except ValueError:
                    messagebox.showerror(
                        "Invalid number",
                        f"{rec['bbi_id']}: '{entry.get().strip()}' is not a "
                        f"number ({label}).",
                        parent=self,
                    )
                    return  # dialog stays open; the row is named above
        # all rows valid: apply each row independently
        for rec, entries in self._rows:
            values = {}
            for label, field, entry in entries:
                text = entry.get().strip().replace(",", ".")
                values[field] = float(text) if text else None
            blank = [f for f, v in values.items() if v is None]
            for field, value in values.items():
                if value is not None:
                    rec[field] = value
            flagged_fields = set(rec.get("od_flag_fields") or _OD_FIELDS)
            if blank:
                rec["od_status"] = "PENDING"
                rec["od_pending_fields"] = (flagged_fields | set(blank))
            else:
                rec["od_status"] = "MANUAL"
                rec["od_pending_fields"] = set()
        self.result = True
        self._close()

    def _skip_all(self):
        # Nothing is written: every record in the dialog stays pending in its
        # current state (the queue marks the flagged fields pending).
        self.result = None
        self._close()

    def _close(self):
        try:
            self.grab_release()
        except Exception:
            pass
        self.destroy()


class BatchQCReportApp:
    """
    Batch QC report generator for the Gene Synthesis hub.

    Simplified interface: a folder browser and a log area. The user picks
    the folder containing the BATCH QC .zip files; the app processes every
    ZIP in it (extract BBI ID / Plasmid No. / sequences / OD values from the
    embedded document) and writes the QC_Report.xlsx into the same folder.
    Processing logic is identical to the standalone QC Report Extractor.
    """

    def __init__(self, master):
        self.master = master
        master.title("BATCH QC Report")
        master.geometry("950x650")

        self._folder_valid = False
        self._folder_path = ""
        self._processing = False
        self._validation_gen = 0

        self._setup_ui()

        # Warn (non-blocking) if the OD reading engine cannot be built: the
        # OD values from the measurement table cannot be extracted, but the
        # user can still run the app for the other report columns.
        self.master.after(200, self._check_ocr_on_startup)

    # ─────────────────────────────────────────────────────────────────────
    # UI
    # ─────────────────────────────────────────────────────────────────────
    def _setup_ui(self):
        # --- Folder selection ---
        folder_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        folder_frame.pack(pady=(15, 10), padx=15, fill="x")

        ctk.CTkLabel(
            folder_frame,
            text="BATCH QC ZIP Folder",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(anchor="center")

        ctk.CTkLabel(
            folder_frame,
            text="Select the folder containing the BATCH QC .zip files",
            font=ctk.CTkFont(size=12),
            text_color="gray",
        ).pack(anchor="w")

        entry_frame = ctk.CTkFrame(folder_frame, fg_color="transparent")
        entry_frame.pack(fill="x", pady=(2, 2))

        self.entry_folder = ctk.CTkEntry(entry_frame, border_width=1)
        self.entry_folder.pack(side="left", fill="x", expand=True, padx=(0, 10))

        self.button_folder = ctk.CTkButton(
            entry_frame,
            text="Select",
            command=self._browse_folder,
            width=90,
        )
        self.button_folder.pack(side="right")

        self.folder_validation_label = ctk.CTkLabel(
            folder_frame,
            text="",
            font=ctk.CTkFont(size=14),
            anchor="w",
            justify="left",
        )
        self.folder_validation_label.pack(fill="x")

        # --- Generate Button ---
        button_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        button_frame.pack(pady=10, padx=20, fill="x")
        button_frame.grid_columnconfigure((0, 2), weight=2)  # Spacers
        button_frame.grid_columnconfigure(1, weight=1)  # Button column

        self.button_generate = ctk.CTkButton(
            button_frame,
            text="Generate QC Report",
            command=self._start_processing,
            font=ctk.CTkFont(size=14, weight="bold"),
            height=40,
            fg_color="#3C702D",
            hover_color="#4CAF50",
        )
        self.button_generate.configure(state="disabled", fg_color="gray50")
        self.button_generate.grid(row=0, column=1, sticky="ew")

        # --- Progress Bar ---
        self.progress = ctk.CTkProgressBar(self.master, mode="determinate")
        self.progress.pack(pady=(0, 10), padx=15, fill="x")
        self.progress.set(0)

        # --- Status Label ---
        self.lbl_status = ctk.CTkLabel(
            self.master,
            text="Ready",
            font=ctk.CTkFont(size=14),
            text_color="blue",
        )
        self.lbl_status.pack(pady=5)

        # --- Log Frame ---
        log_frame = ctk.CTkFrame(self.master)
        log_frame.pack(pady=(5, 15), padx=15, fill="both", expand=True)

        ctk.CTkLabel(
            log_frame,
            text="Process Log",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(anchor="w", padx=10, pady=(5, 2))

        self.log_textbox = ctk.CTkTextbox(
            log_frame,
            activate_scrollbars=True,
            state="disabled",
            fg_color="white",
            text_color="black",
            font=("Consolas", 12),
        )
        self.log_textbox.pack(expand=True, fill="both", padx=10, pady=(0, 10))

    # ─────────────────────────────────────────────────────────────────────
    # Logging helpers
    # ─────────────────────────────────────────────────────────────────────
    def _log(self, message):
        """Append a line to the log box (main thread only)."""
        self.log_textbox.configure(state="normal")
        self.log_textbox.insert("end", message + "\n")
        self.log_textbox.see("end")
        self.log_textbox.configure(state="disabled")

    def _log_threadsafe(self, message):
        """Append a line to the log box from the worker thread."""
        self.master.after(0, lambda: self._log(message))

    def _log_status(self, message, color=None):
        """Update the status label (main thread only)."""
        self.lbl_status.configure(text=message)
        if color:
            self.lbl_status.configure(text_color=color)

    # ─────────────────────────────────────────────────────────────────────
    # Validation
    # ─────────────────────────────────────────────────────────────────────
    def _validate_folder(self, folder_path):
        """Validate the selected folder in a background thread."""
        # A generation counter stamps every validation: a stale result
        # from a slow older validation (the user picked another folder in
        # the meantime) must not overwrite the newer one.
        self._validation_gen += 1
        gen = self._validation_gen
        self._update_validation_ui(None, "", None)

        if not folder_path:
            return

        def _validate():
            if not os.path.isdir(folder_path):
                self.master.after(0, self._update_validation_ui, False,
                                  "Folder not found.", folder_path, gen)
                return

            zips = sorted(z for z in Path(folder_path).glob("*.zip") if z.is_file())
            if not zips:
                self.master.after(0, self._update_validation_ui, False,
                                  "No .zip files found in that folder.", folder_path, gen)
                return

            msg = f"✔ Validated - {len(zips)} ZIP file(s) found"
            self.master.after(0, self._update_validation_ui, True, msg, folder_path, gen)

        threading.Thread(target=_validate, daemon=True).start()

    def _update_validation_ui(self, is_valid, message, folder_path, gen=None):
        """Update the folder validation UI (main thread only)."""
        if gen is not None and gen != self._validation_gen:
            return  # stale result from a superseded validation
        self._folder_valid = bool(is_valid)

        if is_valid is True:
            self._folder_path = folder_path
            self.entry_folder.configure(border_color="dark green", border_width=2)
            self.folder_validation_label.configure(text=message, text_color="green")
        elif is_valid is False:
            self._folder_path = ""
            self.entry_folder.configure(border_color="#D32F2F", border_width=2)
            self.folder_validation_label.configure(
                text=f"✖ Invalid: {message}", text_color="#D32F2F"
            )
        else:  # None - reset to neutral
            self._folder_path = ""
            self.entry_folder.configure(
                border_width=1,
                border_color=ctk.ThemeManager.theme["CTkEntry"]["border_color"],
            )
            self.folder_validation_label.configure(
                text="", text_color=ctk.ThemeManager.theme["CTkLabel"]["text_color"]
            )

        self._check_all_validations()

    def _check_all_validations(self):
        """Enable the Generate button only when a valid folder is selected."""
        if self._folder_valid and not self._processing:
            self.button_generate.configure(state="normal", fg_color="#3C702D")
        else:
            self.button_generate.configure(state="disabled", fg_color="gray50")

    # ─────────────────────────────────────────────────────────────────────
    # Browse
    def _check_ocr_on_startup(self):
        """
        Warn once at startup if the OD reading engine (rapidocr +
        onnxruntime) is not importable. The check is import-only (no engine
        construction): the engine builds lazily on first use and the ONNX
        models ship inside the rapidocr wheel, so no download or model
        loading happens at launch.
        """
        missing = []
        for pkg in ("onnxruntime", "rapidocr"):
            try:
                __import__(pkg)
            except ImportError:
                missing.append(pkg)
        if not missing:
            return

        popup = ctk.CTkToplevel(self.master)
        popup.title("OD OCR engine not found")
        popup.geometry("560x320")
        popup.transient(self.master)
        try:
            popup.grab_set()
        except Exception:
            pass  # toplevel not yet viewable for a modal grab - harmless

        ctk.CTkLabel(
            popup,
            text=f"Missing Python package(s): {', '.join(missing)}.",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(pady=(24, 8), padx=30)

        ctk.CTkLabel(
            popup,
            text=(
                "Without the RapidOCR engine, the OD values from the\n"
                "measurement table will NOT be extracted (other report\n"
                "columns are unaffected).\n\n"
                "Install it into the hub's Python environment:"
            ),
            font=ctk.CTkFont(size=13),
            justify="left",
        ).pack(padx=30)

        cmd_box = ctk.CTkTextbox(popup, height=30, font=("Consolas", 13))
        cmd_box.pack(fill="x", padx=30, pady=(10, 4))
        cmd_box.insert("1.0", "pip install rapidocr onnxruntime")
        cmd_box.configure(state="disabled")

        btn_frame = ctk.CTkFrame(popup, fg_color="transparent")
        btn_frame.pack(pady=(18, 20), side="bottom")

        def _run_anyways():
            popup.grab_release()
            popup.destroy()

        def _cancel():
            self.master.after(50, self._close_app)
            popup.grab_release()
            popup.destroy()

        ctk.CTkButton(
            btn_frame,
            text="Run anyways",
            command=_run_anyways,
            fg_color="#3C702D",
            hover_color="#4CAF50",
            width=130,
        ).pack(side="left", padx=10)
        ctk.CTkButton(
            btn_frame,
            text="Cancel",
            command=_cancel,
            fg_color="#B03A2E",
            hover_color="#D32F2F",
            width=130,
        ).pack(side="left", padx=10)

    def _close_app(self):
        """Close the app window (Cancel on the OCR-engine warning)."""
        self.master.destroy()

    # ─────────────────────────────────────────────────────────────────────
    def _browse_folder(self):
        folder = filedialog.askdirectory(
            title="Select the folder containing your ZIP files",
            parent=self.master,
        )
        if folder:
            self.entry_folder.delete(0, "end")
            self.entry_folder.insert(0, folder)
            self._validate_folder(folder)

    # ─────────────────────────────────────────────────────────────────────
    # Processing
    # ─────────────────────────────────────────────────────────────────────
    def _start_processing(self):
        folder = self._folder_path
        if not folder or not os.path.isdir(folder):
            messagebox.showerror("Error", "Please select a valid folder.")
            return

        zips = sorted(z for z in Path(folder).glob("*.zip") if z.is_file())
        if not zips:
            messagebox.showerror("Error", "No .zip files found in that folder.")
            return

        self._processing = True
        self._folder_valid = True
        self._check_all_validations()

        self.log_textbox.configure(state="normal")
        self.log_textbox.delete("1.0", "end")
        self.log_textbox.configure(state="disabled")
        self._log(f"Found {len(zips)} ZIP file(s). Processing...")

        self.progress.set(0)
        self._log_status("Processing ZIP files...", "blue")

        thread = threading.Thread(target=self._processing_thread, args=(folder,), daemon=True)
        thread.start()

    def _processing_thread(self, folder):
        """Worker thread: process every ZIP, then hand off to the review
        queue (flagged records) on the main thread."""
        records = []
        tmp_dir = tempfile.mkdtemp()
        review_handoff = False
        try:
            zips = sorted(z for z in Path(folder).glob("*.zip") if z.is_file())
            for i, zp in enumerate(zips, start=1):
                if i > 1:
                    self._log_threadsafe("─" * 80)
                self._log_threadsafe(f"  → {zp.name}  ({i}/{len(zips)})")
                rec = process_zip(str(zp), tmp_dir, log=self._log_threadsafe)
                records.append(rec)
                self.master.after(
                    0,
                    lambda v=i / len(zips): self.progress.set(v),
                )
                self._log_threadsafe(f"     ► BBI ID     : {rec['bbi_id']}")
                self._log_threadsafe(f"     ► Plasmid No. : {rec['plasmid_no']}")
                self._log_threadsafe(f"     ► OD image   : {'✓' if rec['od_blob'] else '✗'}")
                if rec["od260"] is not None:
                    self._log_threadsafe(
                        f"     ► OD values  : {rec['od260']} / {rec['od280']} / "
                        f"{rec['od_ratio']} / {rec['ng_ul']} ng/uL"
                    )

            # The pass is done: flagged records go to the review queue BEFORE
            # the report is written, so the user's values land directly in
            # the final file. This worker thread ends here; the review queue
            # runs on the main thread (tkinter widgets), and the report write
            # resumes on its own thread afterwards.
            review_handoff = True
            no_input = [rec for rec in records
                        if not (rec.get("od_crop") or rec.get("od_blob"))]
            readable = [rec for rec in records
                        if rec.get("od_status") not in ("AUTO",)
                        and (rec.get("od_crop") or rec.get("od_blob"))]
            self.master.after(0, self._run_review_queue, records,
                              os.path.join(folder, "QC_Report.xlsx"),
                              no_input, readable)

        except Exception as e:
            self._log_threadsafe(f"\n✗  Error: {e}")
            self._log_threadsafe(traceback.format_exc())
            self.master.after(0, lambda err=str(e): self._log_status(f"Error: {err}", "red"))
            self.master.after(0, lambda err=str(e): messagebox.showerror(
                "Error", f"An error occurred:\n{err}", parent=self.master))
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            if not review_handoff:
                # An error ended the pass: the review/writer handoff never
                # happened, so nothing else will re-enable the UI.
                self.master.after(0, self._finish_processing)

    def _run_review_queue(self, records, output_path, no_input, readable):
        """
        Main thread: first ONE summary list dialog for all flagged records
        without an OD table (nothing editable there), then the per-record
        review dialogs for the readable flagged records. A skipped record
        keeps its placeholder (PENDING) in the flagged fields only; values
        that were read inside every gate stay in the table untouched.
        """
        if not (no_input or readable):
            self._log("\nNo flagged rows - writing the report...")
            self._start_report_write(records, output_path)
            return

        self._log(f"\n{len(no_input) + len(readable)} record(s) flagged for OD "
                  f"review ({len(no_input)} with no OD table, "
                  f"{len(readable)} to check):")
        for rec in no_input:
            self._log(f"  • {rec['zip_name']} - {rec['bbi_id']}: "
                      f"{_short_od_reason(rec)}")
        for rec in readable:
            reasons = "; ".join(rec.get("od_flags") or [])
            self._log(f"  • {rec['zip_name']} - {rec['bbi_id']}: {reasons}")
        self._log_status(f"{len(no_input) + len(readable)} record(s) flagged "
                         f"({len(no_input)} no OD table)", "orange")

        # ONE dialog carries both sections (no-OD-table list + review rows).
        dialog = None
        try:
            dialog = OdReviewDialog(self.master, no_input, readable)
            self.master.wait_window(dialog)
        except Exception as e:
            if dialog is not None:
                try:
                    dialog.grab_release()
                    dialog.destroy()
                except Exception:
                    pass
            self._log(f"  ⚠ Review dialog failed "
                      f"({e.__class__.__name__}: {e}) - flagged records "
                      f"left pending.")
            self._log_threadsafe(traceback.format_exc())
        # no-OD-table records are always simply pending (nothing to type).
        for rec in no_input:
            rec["od_status"] = "PENDING"
            rec["od_pending_fields"] = set(
                rec.get("od_flag_fields") or _OD_FIELDS)
        if no_input:
            self._log(f"  ⏸ {len(no_input)} record(s) without an OD table left "
                      f"pending.")
        if readable:
            if dialog is not None and dialog.result is True:
                for rec in readable:
                    if rec["od_status"] == "MANUAL":
                        self._log(f"  ✔ {rec['zip_name']} ({rec['bbi_id']}): "
                                  f"entered values {rec['od260']} / "
                                  f"{rec['od280']} / {rec['od_ratio']} / "
                                  f"{rec['ng_ul']} ng/uL")
                    else:
                        self._log(f"  ⏸ {rec['zip_name']} ({rec['bbi_id']}): "
                                  f"left pending fields "
                                  f"{sorted(rec['od_pending_fields']) or 'none'}")
            else:
                # skip / close / failure: nothing applied
                for rec in readable:
                    rec["od_status"] = "PENDING"
                    rec["od_pending_fields"] = set(
                        rec.get("od_flag_fields") or _OD_FIELDS)
                self._log(f"  ⏸ {len(readable)} record(s) left pending "
                          f"(dialog closed).")

        self._log("\nReview finished - writing the report...")
        self._start_report_write(records, output_path)

    def _start_report_write(self, records, output_path):
        """Spawn the report writer on its own thread (embedding the images is
        I/O-heavy; the UI stays responsive)."""
        self._log_status("Writing QC_Report.xlsx...", "blue")
        self.progress.set(0)
        threading.Thread(target=self._write_report_thread,
                         args=(records, output_path), daemon=True).start()

    def _write_report_thread(self, records, output_path):
        """Worker thread: write the Excel report, then report the summary and
        re-enable the UI."""
        try:
            write_excel_report(records, output_path, log=self._log_threadsafe)

            manual = sum(1 for rec in records if rec.get("od_status") == "MANUAL")
            pending = sum(1 for rec in records if rec.get("od_status") == "PENDING")
            auto = len(records) - manual - pending
            summary = (f"Processed {len(records)} ZIP file(s): {auto} auto, "
                       f"{manual} entered in review, {pending} pending review.")
            self.master.after(0, lambda: self._log_status(
                f"Done! {summary}", "green" if not pending else "orange"))
            self.master.after(0, lambda: messagebox.showinfo(
                "Done!",
                f"{summary}\n\nReport saved to:\n{output_path}",
                parent=self.master,
            ))
            self.master.after(0, self._open_report, output_path)

        except Exception as e:
            self._log_threadsafe(f"\n✗  Error: {e}")
            self._log_threadsafe(traceback.format_exc())
            self.master.after(0, lambda err=str(e): self._log_status(f"Error: {err}", "red"))
            self.master.after(0, lambda err=str(e): messagebox.showerror(
                "Error", f"An error occurred:\n{err}", parent=self.master))
        finally:
            self.master.after(0, self._finish_processing)

    def _finish_processing(self):
        """Re-enable the button after processing completes (main thread)."""
        self._processing = False
        self.progress.set(0)
        self._check_all_validations()

    def _open_report(self, output_path):
        """Open the generated report with the OS default handler."""
        try:
            if sys.platform == "win32":
                os.startfile(output_path)
            elif sys.platform == "darwin":
                subprocess.call(["open", output_path])
            else:
                subprocess.call(["xdg-open", output_path])
        except Exception as e:
            self._log(f"⚠  Could not open report automatically: {e}")


def main():
    """Standalone entry point when not launched from the hub."""
    ctk.set_appearance_mode("System")
    ctk.set_default_color_theme("blue")

    root = ctk.CTk()
    app = BatchQCReportApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()