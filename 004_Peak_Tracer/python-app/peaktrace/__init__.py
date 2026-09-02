"""peaktrace_core — in-house replacement for Nucleics Auto PeakTrace RP.

Reads a folder of post-Seq7 .ab1 files and produces:
  - Renamed .ab1 files (well-ID stripped, suffix configurable)
  - .seq files (re-emitted by re-basecalling the trace)
  - 2-Report.xls QC report (OK list)

Algorithm (Path 2: only mimic what PeakTrace RP adds on top of Seq7):

  1. read_ab1(path) → Trace4 (4-channel data + metadata + Seq7 basecall/PLOC/PCON)
  2. rescale_channels(trace, factor) → Trace4 (channels scaled by `factor`)
  3. smooth_channels(trace, level=3) → Trace4 (Savitzky-Golay window = 2*level+1)
  4. drop_leading_artifact(trace) → Trace4 (drops first base if anomalously high amplitude)
  5. detect_peaks(trace) → peak positions (4 arrays, one per channel)
  6. basecall(trace, peaks, quality_threshold=20) → (bases, qvs, peak_positions)
  7. trim_3_end(bases, qvs, value=9, window=40) → trimmed (bases, qvs)
  8. extend_read(...) → late-read extension via low-amplitude peak detection
  9. write_ab1(out_path, bases, qvs, peaks, channels, original_metadata) → .ab1 file
 10. write_seq(out_path, bases, peaks, qvs) → .seq file

Defaults (fitted on 58 real samples from sample1.zip, Aug 24 2026):
  - traceRescaleFactor = 1.69  (median max-amplitude ratio across 4 channels)
  - smoothingLevel = 3  → Savitzky-Golay window = 7
  - qualityThreshold = 20
  - nBaseThreshold = 5
  - mixedPeakThreshold = 0  (no mixed-base calls — matches BBI)
  - qAverageTrimValue = 9
  - qAverageTrimWindow = 40
  - dropLeadingBase = True (only if first base is anomalously high)

Usage:
  peaktrace_core --input-dir DIR --output-dir DIR [options]
"""
from .cli import main

__all__ = ["main"]
__version__ = "0.0.1"
