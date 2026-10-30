"""
Bio Basic Inc. - Canada
Made by: Fabien Lonjon and Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.1
Date: Oct 10, 2026
Notes: Batch QC report generator adapted to the Gene Synthesis hub.
    Simplified interface: folder browser + log area only. The processing
    logic is preserved from the standalone QC Report Extractor: BBI ID /
    Plasmid No. / sequence extraction, OD table OCR (multi-scale voting
    with a majority-rule retry) and the Excel report with embedded OD
    images. Field names and report labels follow the canonical job-log
    naming (Plasmid No., Final Vector Sequence, ng/uL).
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
from tkinter import filedialog, messagebox

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
require("pytesseract")
require("numpy")

from docx import Document
import numpy as np
import openpyxl
import pytesseract
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from PIL import Image as PILImage, ImageOps, ImageFilter


# ─────────────────────────────────────────────────────────────────────────────
# Convert .doc → .docx using Microsoft Word
# ─────────────────────────────────────────────────────────────────────────────
def convert_doc_to_docx(doc_path: str, out_dir: str, log=print) -> str | None:
    try:
        import win32com.client
        word    = win32com.client.Dispatch("Word.Application")
        word.Visible = False
        abs_in  = os.path.abspath(doc_path)
        abs_out = os.path.abspath(os.path.join(
            out_dir,
            os.path.splitext(os.path.basename(doc_path))[0] + ".docx"
        ))
        d = word.Documents.Open(abs_in)
        d.SaveAs2(abs_out, FileFormat=16)
        d.Close()
        word.Quit()
        return abs_out if os.path.exists(abs_out) else None
    except Exception as e:
        log(f"      ⚠  win32com error: {e}")
        return None


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
                cells = [c.text.strip() for c in row.cells]
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


def extract_sequence_files(zip_ref: zipfile.ZipFile, bbi_id: str, log=print) -> tuple[str | None, str | None]:
    insert_seq = None
    final_vector_seq = None

    normalized_bbi = re.sub(r"\s+", " ", bbi_id).strip().upper()

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

        if re.search(rf"\b{re.escape(normalized_bbi)}\b", upper_name, re.IGNORECASE):
            if insert_seq is None:
                insert_seq = seq
                log(f"      ✓  Insert sequence: {basename} ({len(seq):,} bp)")
            continue

        if re.match(r"^LA\d+_.+\.seq$", basename, re.IGNORECASE):
            if final_vector_seq is None:
                final_vector_seq = seq
                log(f"      ✓  Final vector sequence: {basename} ({len(seq):,} bp)")

    return insert_seq, final_vector_seq


# ─────────────────────────────────────────────────────────────────────────────
# Read the OD measurement table from the extracted image
# ─────────────────────────────────────────────────────────────────────────────
_TESSERACT_RESOLVED = _UNSET = object()


def find_tesseract() -> "str | None":
    """
    Locate tesseract.exe without side effects on the log; returns the path
    or None. Checks PATH, the standard install locations, and the Windows
    registry entries written by the UB Mannheim installer (both
    machine-wide and per-user installs, including the 32-bit-installer
    view). The result is memoized: the search runs once per app session.
    """
    global _TESSERACT_RESOLVED
    if _TESSERACT_RESOLVED is not _UNSET:
        return _TESSERACT_RESOLVED

    candidates = [
        shutil.which("tesseract"),
        os.path.join(os.environ.get("ProgramFiles", ""), "Tesseract-OCR", "tesseract.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Tesseract-OCR", "tesseract.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Tesseract-OCR", "tesseract.exe"),
        os.path.join(os.environ.get("ProgramFiles", ""), "Tesseract OCR", "tesseract.exe"),
    ]

    # The UB Mannheim installer records its InstallLocation in the registry.
    try:
        import winreg
        uninstall_keys = [
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Tesseract-OCR",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Tesseract-OCR",
        ]
        for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            for key_path in uninstall_keys:
                try:
                    with winreg.OpenKey(root, key_path) as key:
                        install_dir, _ = winreg.QueryValueEx(key, "InstallLocation")
                        if install_dir:
                            candidates.append(
                                os.path.join(install_dir, "tesseract.exe"))
                except OSError:
                    pass
    except Exception:
        pass

    checked = [c for c in candidates if c]
    for path in checked:
        if path and os.path.exists(path):
            pytesseract.pytesseract.tesseract_cmd = path
            _TESSERACT_RESOLVED = path
            return path

    _TESSERACT_RESOLVED = None
    return None


def configure_tesseract(log=print) -> bool:
    """
    Resolve tesseract.exe (see find_tesseract) and report failure to the
    log, listing every path tried so a failed install can be diagnosed
    from the app log alone.
    """
    found = find_tesseract()
    if found:
        return True

    log("      ⚠  Tesseract not found - OD values could not be read.")
    log("      ⚠  Paths checked:")
    for path in [
        shutil.which("tesseract"),
        os.path.join(os.environ.get("ProgramFiles", ""), "Tesseract-OCR", "tesseract.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Tesseract-OCR", "tesseract.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Tesseract-OCR", "tesseract.exe"),
        os.path.join(os.environ.get("ProgramFiles", ""), "Tesseract OCR", "tesseract.exe"),
    ]:
        if path:
            log(f"           - {path}")
    return False


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


def build_cell_votes(cell_img: "PILImage.Image") -> dict[str, int]:
    """
    Run the full multi-scale/multi-psm OCR grid on a single table cell and
    return the raw vote pool (reading -> number of supporting attempts).
    The caller applies the selection rule(s) to this pool - see
    pick_cell_reading - so the expensive OCR grid runs only ONCE per cell
    even when several selection strategies are tried.
    """
    votes: dict[str, int] = {}

    for scale in (3, 4, 5, 6, 7, 8):
        big = cell_img.resize((cell_img.width * scale, cell_img.height * scale), PILImage.NEAREST)
        big = ImageOps.autocontrast(big)
        for psm in (7, 8):
            text = pytesseract.image_to_string(
                big, config=f"--psm {psm} -c tessedit_char_whitelist=0123456789."
            ).strip()
            if re.fullmatch(r"\d+(\.\d+)?", text):
                votes[text] = votes.get(text, 0) + 1

    for scale in (3, 4, 5, 6):
        big = cell_img.resize((cell_img.width * scale, cell_img.height * scale), PILImage.Resampling.LANCZOS)
        big = ImageOps.autocontrast(big)
        for psm in (6, 7, 11):
            text = pytesseract.image_to_string(
                big, config=f"--psm {psm} -c tessedit_char_whitelist=0123456789."
            ).strip()
            if re.fullmatch(r"\d+(\.\d+)?", text):
                votes[text] = votes.get(text, 0) + 1

    for scale in (2, 3, 4, 5, 6):
        big = cell_img.resize(
            (int(cell_img.width * scale), int(cell_img.height * scale)), PILImage.BILINEAR
        )
        big = ImageOps.autocontrast(big)
        for psm in (6, 7, 11):
            text = pytesseract.image_to_string(
                big, config=f"--psm {psm} -c tessedit_char_whitelist=0123456789."
            ).strip()
            if re.fullmatch(r"\d+(\.\d+)?", text):
                votes[text] = votes.get(text, 0) + 1

    return votes


def pick_cell_reading(votes: dict[str, int], prefer_longest: bool = True) -> str | None:
    """
    Apply a selection rule to a vote pool built by build_cell_votes and
    return the chosen reading (or None if the pool is empty).

    prefer_longest=True (first pass): OCR mistakes on this font are
    overwhelmingly DROPPED or SUBSTITUTED digits, not extra/hallucinated
    ones - so a reading with more digits is normally more
    complete/trustworthy. Candidates are grouped by digit count, checked
    from the longest group down, and the most frequent reading in the
    first group with at least `min_votes` (3) supporting reads is
    returned. Requiring 3 rather than just 2 matters: a single stray
    misread with an extra hallucinated digit (e.g. a lone "92.181" for
    "2.161") can otherwise pass the bar and be wrongly preferred just for
    being longer, even while the correct shorter-tier reading is supported
    by a large majority of attempts.

    prefer_longest=False (retry, only after a first-pass read failed its
    plausibility checks): majority rule - return the single most-voted
    reading when it holds at least half of all votes (and clears
    min_votes). This covers the opposite failure mode: a small
    hallucination (e.g. "1.91" captured as "1981", decimal point eaten and
    a digit doubled) that clears min_votes and wins the longest tier,
    while the correct shorter reading dominates the vote pool by a wide
    margin (e.g. 32 votes vs 5). With no dominant reading, falls through
    to the longest-tier logic above.
    """
    if not votes:
        return None

    min_votes = 3
    total_votes = sum(votes.values())
    top_text, top_count = max(votes.items(), key=lambda kv: kv[1])

    if not prefer_longest:
        # Majority rule (retry path): a dominant consensus reading - at
        # least half of all votes and above the min_votes bar - is taken
        # as-is, even if it is shorter than a rival hallucination.
        if top_count >= min_votes and top_count >= 0.5 * total_votes:
            return top_text
        # No clear majority: fall through to the longest-tier logic.

    by_len: dict[int, list[tuple[str, int]]] = {}
    for text, count in votes.items():
        digit_count = len(re.sub(r"\D", "", text))
        by_len.setdefault(digit_count, []).append((text, count))

    for digit_count in sorted(by_len.keys(), reverse=prefer_longest):
        tier = [(text, count) for text, count in by_len[digit_count] if count >= min_votes]
        if tier:
            return max(tier, key=lambda tc: tc[1])[0]

    # Nothing reached the vote threshold at any digit-length: fall back to
    # the single most frequent reading overall rather than returning nothing.
    return max(votes.items(), key=lambda kv: kv[1])[0]


def _decimal_values_from_ocr(text: str) -> list[str]:
    text = text.replace(",", ".")
    text = re.sub(r"(?<=\d)[fF](?=\s|$)", "7", text)
    text = re.sub(r"(\d+)\.\s+(\d)", r"\1.\2", text)
    # Accept plain integers too (e.g. a ng/uL reading of "97" with no
    # decimal part) - not just x.y decimals. The header labels (OD260,
    # OD280, ...) also contain bare digits and will match here, but since
    # only the LAST 4 matches are ever used (the data row always comes
    # after the header in reading order), that header noise is harmless.
    return re.findall(r"\b\d+(?:\.\d+)?\b", text)


def od_values_from_blob(blob: bytes, log=print) -> dict:
    """
    Read the four values from the OD measurement table:
      OD260 | OD280 | OD260/OD280 | ng/uL

    Primary method: locate the table, split its data row into 4 individual
    cells, and OCR each cell separately (see build_cell_votes /
    pick_cell_reading) - reading one short number at a time is much more
    reliable than reading the whole row at once, where cell borders and
    column spacing often confuse the OCR engine into dropping or altering
    a digit. The vote pool is built once per cell; if the first-pass
    selection fails the plausibility check, the retry re-picks from the
    same pool by majority rule (no extra OCR runs).

    Fallback: if the table/cell structure can't be located (unusual image
    layout), fall back to a whole-row, multi-scale/psm OCR pass.
    """
    result = {"od260": None, "od280": None, "od_ratio": None, "ng_ul": None}

    if not configure_tesseract(log=log):
        log("      ⚠  Tesseract not found - OD values could not be read.")
        return result

    try:
        img = PILImage.open(io.BytesIO(blob)).convert("L")
        w, h = img.size

        table_top = max(0, locate_table_top(img) - 2)
        table_img = img.crop((0, table_top, w, h))

        # ── Primary: per-cell OCR ───────────────────────────────────────
        cells = split_table_cells(table_img)
        if cells:
            # Run the expensive OCR grid ONCE per cell, then apply the
            # selection rule(s) to the pooled votes. The retry pass
            # re-picks from the SAME pool, so it adds no new OCR calls.
            vote_pools = [build_cell_votes(c) for c in cells]
            if all(pool for pool in vote_pools):
                first_texts = [pick_cell_reading(v) for v in vote_pools]
                if all(t is not None for t in first_texts):
                    floats = None
                    try:
                        floats = [float(t) for t in first_texts]
                    except ValueError:
                        floats = None
                    if floats and (0 < floats[0] < 20 and 0 < floats[1] < 20
                                   and 0.1 < floats[2] < 5 and 0 < floats[3] < 10000):
                        result["od260"], result["od280"], result["od_ratio"], result["ng_ul"] = floats
                        log(
                            f"      ✓  OD (per-cell): OD260={floats[0]} / OD280={floats[1]} / "
                            f"Ratio={floats[2]} / ng/uL={floats[3]}"
                        )
                        return result

                # Retry: majority rule on the same vote pool. The
                # longest-digit-tier preference above exists because OCR on
                # this font mostly DROPS digits; but a few cells read the
                # other way: a small hallucination (e.g. "1.91" captured as
                # "1981") clears the vote threshold while the correct,
                # shorter reading dominates the pool (e.g. 32 votes vs 5).
                # The first pass picked the hallucination, the 4-value
                # plausibility check rejected it, and the whole row was
                # lost. Re-picking by majority recovers it at zero extra
                # OCR cost.
                retry_texts = [pick_cell_reading(v, prefer_longest=False) for v in vote_pools]
                if all(t is not None for t in retry_texts):
                    floats = None
                    try:
                        floats = [float(t) for t in retry_texts]
                    except ValueError:
                        floats = None
                    if floats and (0 < floats[0] < 20 and 0 < floats[1] < 20
                                   and 0.1 < floats[2] < 5 and 0 < floats[3] < 10000):
                        result["od260"], result["od280"], result["od_ratio"], result["ng_ul"] = floats
                        log(
                            f"      ✓  OD (per-cell, retry): OD260={floats[0]} / OD280={floats[1]} / "
                            f"Ratio={floats[2]} / ng/uL={floats[3]}"
                        )
                        return result

        # ── Fallback: whole-row OCR ─────────────────────────────────────
        candidates = []

        for scale in (4, 5, 6, 8):
            crop = table_img.resize(
                (table_img.width * scale, table_img.height * scale),
                PILImage.Resampling.LANCZOS
            )
            crop = ImageOps.autocontrast(crop).filter(ImageFilter.SHARPEN)

            for psm in (6, 11):
                ocr_text = pytesseract.image_to_string(crop, config=f"--psm {psm}")
                nums = _decimal_values_from_ocr(ocr_text)

                if len(nums) >= 4:
                    vals = nums[-4:]
                    try:
                        floats = [float(x) for x in vals]
                    except ValueError:
                        continue

                    if not (0 < floats[0] < 20 and 0 < floats[1] < 20):
                        continue
                    if not (0.1 < floats[2] < 5):
                        continue
                    if not (0 < floats[3] < 10000):
                        continue

                    decimal_lengths = [len(x.split(".")[1]) if "." in x else 0 for x in vals]
                    score = 0
                    score += 3 if decimal_lengths[0] == 3 else 0
                    score += 3 if decimal_lengths[1] == 3 else 0
                    score += 3 if decimal_lengths[2] == 2 else 0
                    score += 3 if decimal_lengths[3] == 1 else 0
                    candidates.append((score, floats))

        if candidates:
            candidates.sort(key=lambda x: x[0], reverse=True)
            vals = candidates[0][1]
            result["od260"], result["od280"], result["od_ratio"], result["ng_ul"] = vals
            log(
                f"      ✓  OD (fallback): OD260={vals[0]} / OD280={vals[1]} / "
                f"Ratio={vals[2]} / ng/uL={vals[3]}"
            )
        else:
            log("      ⚠  Could not reliably read all four OD values "
                f"(table region detected at y={table_top}px of {h}px).")

    except Exception as e:
        log(f"      ⚠  OD OCR error: {e}")

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
    od_values       = {"od260": None, "od280": None, "od_ratio": None, "ng_ul": None}

    try:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            insert_seq, final_vector_seq = extract_sequence_files(zf, bbi_id, log=log)

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
                    log(f"      {'✓' if od_blob else '⚠ '}  OD image {'found' if od_blob else 'not found'}")
                    if od_blob:
                        od_values = od_values_from_blob(od_blob, log=log)
                else:
                    plasmid_no = plasmid_no_from_filename or "NOT FOUND"
            else:
                log(f"      ⚠  No BATCH*.doc found inside ZIP")

    except zipfile.BadZipFile:
        log(f"      ✗  Not a valid ZIP file")
    except Exception as e:
        log(f"      ✗  Error: {e}")

    return {
        "bbi_id":          bbi_id,
        "plasmid_no":      plasmid_no,
        "insert_seq":      insert_seq,
        "final_vector_seq": final_vector_seq,
        "od260":           od_values["od260"],
        "od280":           od_values["od280"],
        "od_ratio":        od_values["od_ratio"],
        "ng_ul":           od_values["ng_ul"],
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

    for rec in records:
        ws.append([
            rec["zip_name"],
            rec["bbi_id"],
            rec["plasmid_no"],
            rec["ng_ul"] if rec["ng_ul"] is not None else "NOT FOUND",
            rec["od260"] if rec["od260"] is not None else "NOT FOUND",
            rec["od280"] if rec["od280"] is not None else "NOT FOUND",
            rec["od_ratio"] if rec["od_ratio"] is not None else "NOT FOUND",
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
        shutil.rmtree(img_tmp_dir, ignore_errors=True)
        raise RuntimeError(
            f"Could not save the report: {output_path}\n"
            f"It is likely open in Excel - close it and run the report again.\n"
            f"({e})"
        ) from e
    shutil.rmtree(img_tmp_dir, ignore_errors=True)
    log(f"\n✅  Excel report saved → {output_path}")


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

        self._setup_ui()

        # Warn (non-blocking) if Tesseract is missing: without it the OD
        # values from the measurement table cannot be extracted. The user
        # can still run the app for the other report columns.
        self.master.after(200, self._check_tesseract_on_startup)

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
        self._update_validation_ui(None, "", None)

        if not folder_path:
            return

        def _validate():
            if not os.path.isdir(folder_path):
                self.master.after(0, self._update_validation_ui, False,
                                  "Folder not found.", folder_path)
                return

            zips = sorted(Path(folder_path).glob("*.zip"))
            if not zips:
                self.master.after(0, self._update_validation_ui, False,
                                  "No .zip files found in that folder.", folder_path)
                return

            msg = f"✔ Validated - {len(zips)} ZIP file(s) found"
            self.master.after(0, self._update_validation_ui, True, msg, folder_path)

        threading.Thread(target=_validate, daemon=True).start()

    def _update_validation_ui(self, is_valid, message, folder_path):
        """Update the folder validation UI (main thread only)."""
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
    def _check_tesseract_on_startup(self):
        """Warn once at startup if the Tesseract OCR engine is not found."""
        try:
            found = bool(find_tesseract())
        except Exception:
            found = False
        if found:
            return

        popup = ctk.CTkToplevel(self.master)
        popup.title("Tesseract not found")
        popup.geometry("520x300")
        popup.transient(self.master)
        popup.grab_set()

        ctk.CTkLabel(
            popup,
            text="Tesseract OCR was not found on this computer.",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(pady=(24, 8), padx=30)

        ctk.CTkLabel(
            popup,
            text=(
                "Without Tesseract, the OD values from the measurement "
                "table\nwill NOT be extracted (other report columns are "
                "unaffected).\n\n"
                "Install it from the link below, using the default "
                "installation\nfolder, then reopen this app:"
            ),
            font=ctk.CTkFont(size=13),
            justify="left",
        ).pack(padx=30)

        link = "https://digi.bib.uni-mannheim.de/tesseract/tesseract-ocr-w64-setup-5.4.0.20240606.exe"
        lbl_link = ctk.CTkLabel(
            popup,
            text=link,
            font=ctk.CTkFont(size=12, underline=True),
            text_color="#1F6FEB",
            cursor="hand2",
        )
        lbl_link.pack(pady=(10, 4))
        lbl_link.bind(
            "<Button-1>",
            lambda e: self._open_report(link),
        )

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
            command=popup.destroy,
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
        """Close the app window (Cancel on the Tesseract warning)."""
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

        zips = sorted(Path(folder).glob("*.zip"))
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
        """Worker thread: process every ZIP and write the Excel report."""
        records = []
        tmp_dir = tempfile.mkdtemp()
        output_path = None
        try:
            zips = sorted(Path(folder).glob("*.zip"))
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

            output_path = os.path.join(folder, "QC_Report.xlsx")
            write_excel_report(records, output_path, log=self._log_threadsafe)

            self.master.after(0, lambda: self._log_status(
                f"Done! Processed {len(records)} ZIP file(s).", "green"))
            self.master.after(0, lambda: messagebox.showinfo(
                "Done!",
                f"Processed {len(records)} ZIP file(s).\n\nReport saved to:\n{output_path}",
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
            shutil.rmtree(tmp_dir, ignore_errors=True)
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