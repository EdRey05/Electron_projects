"""Peak detection + basecaller + 3'-end trim.

Stage 1: drop_leading_artifact — drops the first base if its PLOC amplitude
          is anomalously high (> 3× the median amplitude of the first 50
          non-leading peaks). Verified Aug 24: 32.8% of samples trigger this.

Stage 2: detect_peaks — find local maxima in each of the 4 channels.

Stage 3: basecall — at each peak position, find the channel with the
          maximum amplitude and emit that base (or N if max amp < noise).
          Mixed-base detection disabled by default (mixedPeakThreshold = 0).

Stage 4: calibrate_qvs — assign a quality value to each base based on the
          SNR at its peak position. Q20 = "good".

Stage 5: trim_3_end — scan from the right, find the first window of size W
          where the average QV is < threshold, and trim there.
          Verified: uses rolling mean of QV over W=40 bases, trims when
          rolling mean drops below 9.
"""
from __future__ import annotations
import numpy as np
from .read import Trace, CHANNELS, CHANNEL_OF_BASE
from .smooth import clean_baseline

BASE_OF_CHANNEL = {9: "A", 10: "C", 11: "G", 12: "T"}


def drop_leading_artifact(trace: Trace) -> None:
    """If the first Seq7 base has anomalously high amplitude, drop it.

    Verified on 58 samples: 19/58 (32.8%) trigger this. The leading-edge
    artifact is a primer injection peak that doesn't represent a real base.
    """
    if len(trace.ploc_in) == 0 or len(trace.qv_in) == 0:
        return
    first_pos = int(trace.ploc_in[0])
    if first_pos >= trace.n_scans:
        return
    first_amps = [trace.channels[ch][first_pos] for ch in CHANNELS if ch in trace.channels]
    if not first_amps:
        return
    first_amp = max(first_amps)

    # Reference: median amplitude of the next 50 peaks (if available)
    later_pos = trace.ploc_in[1:51].astype(int)
    later_pos = later_pos[later_pos < trace.n_scans]
    if len(later_pos) == 0:
        return
    later_amps = []
    for pos in later_pos:
        for ch in CHANNELS:
            if ch in trace.channels:
                later_amps.append(trace.channels[ch][int(pos)])
    if not later_amps:
        return
    median_amp = float(np.median(later_amps))

    if first_amp > 3.0 * median_amp:
        # Drop the first base
        trace.pb_in = trace.pb_in[1:]
        trace.qv_in = trace.qv_in[1:]
        trace.ploc_in = trace.ploc_in[1:]


def detect_peaks_in_channel(channel: np.ndarray, min_distance: int = 5) -> np.ndarray:
    """Return indices of local maxima in a 1-D channel.

    A local max is a point whose value is greater than its `min_distance`
    neighbors on each side. Crude but matches the kind of peaks a 3730xl
    produces after smoothing.
    """
    n = len(channel)
    if n < 2 * min_distance + 1:
        return np.array([], dtype=np.int32)
    # Pad with -inf to simplify edge handling
    padded = np.concatenate(([-np.inf], channel.astype(np.float64), [-np.inf]))
    peaks = []
    for i in range(1, n + 1):
        lo = max(1, i - min_distance)
        hi = min(n + 1, i + min_distance + 1)
        if padded[i] >= padded[lo:hi].max():
            if padded[i] > padded[lo:hi].max() or (padded[i] == padded[lo:hi].max() and i == padded[lo:hi].argmax() + lo):
                # tiebreak: take first occurrence in the window
                peaks.append(i - 1)
    return np.array(peaks, dtype=np.int32)


def detect_all_peaks(trace: Trace, min_distance: int = 5) -> dict:
    """Detect peaks in all 4 channels."""
    return {ch: detect_peaks_in_channel(trace.channels[ch], min_distance) for ch in CHANNELS if ch in trace.channels}


def basecall(trace: Trace,
             peak_dict: dict,
             mixed_threshold_pct: float = 0.0,
             noise_floor_pct: float = 5.0,
             peak_min_factor: float = 2.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Greedy basecaller.

    For each peak (scan position), find the channel with the highest amplitude
    and emit that base. The base passes the noise check if its peak amplitude
    is `peak_min_factor` × the local noise floor.

    Noise floor estimation: per-channel, the median of all non-peak amplitudes
    is a robust estimate of the noise. Anything > peak_min_factor × that
    counts as a real peak.

    `mixed_threshold_pct` (0..200): if a secondary peak is >= this % of primary,
    emit a mixed (IUPAC) base. Default 0 = never emit mixed bases (BBI mode).

    Returns: (bases, peak_locations, qvs)
      - bases: ndarray of uint8 (ASCII codes for A/C/G/T/N)
      - peak_locations: ndarray of int32 (scan indices where bases were called)
      - qvs: ndarray of uint8 (quality values 1..62)
    """
    n = trace.n_scans
    if n == 0:
        return np.array([], dtype=np.uint8), np.array([], dtype=np.int32), np.array([], dtype=np.uint8)

    # Per-channel noise floor = percentile of all amplitudes (5th percentile
    # is robust to outliers from real peaks).
    channel_noise = {}
    for ch in CHANNELS:
        if ch in trace.channels:
            arr = trace.channels[ch].astype(np.float64)
            channel_noise[ch] = max(1.0, float(np.percentile(arr, noise_floor_pct)))

    # Build peak map: scan_index -> {channel: amplitude}
    all_peaks = []
    for ch, peaks in peak_dict.items():
        for p in peaks:
            if p >= trace.n_scans:
                continue
            amp = int(trace.channels[ch][p])
            if amp < channel_noise[ch] * peak_min_factor:
                continue  # too quiet — not a real peak
            all_peaks.append((int(p), ch, amp))
    all_peaks.sort()  # by scan position

    # De-duplicate: if two channels have a peak at the same scan, merge them
    merged = {}  # scan -> {channel: amplitude}
    for pos, ch, amp in all_peaks:
        merged.setdefault(pos, {})[ch] = max(merged.get(pos, {}).get(ch, 0), amp)

    bases = []
    plocs = []
    qvs = []

    for pos in sorted(merged.keys()):
        amps = merged[pos]
        if not amps:
            continue
        # Sort by amplitude desc
        sorted_amps = sorted(amps.items(), key=lambda kv: -kv[1])
        primary_ch, primary_amp = sorted_amps[0]
        # Floor for this call: the local noise of the primary channel
        floor = channel_noise[primary_ch]
        if primary_amp < floor * peak_min_factor:
            continue

        base_char = BASE_OF_CHANNEL[primary_ch]

        # Mixed-base check (disabled if mixed_threshold_pct == 0)
        if mixed_threshold_pct > 0 and len(sorted_amps) > 1:
            secondary_ch, secondary_amp = sorted_amps[1]
            if secondary_amp >= (mixed_threshold_pct / 100.0) * primary_amp:
                # Emit IUPAC mixed base
                base_char = _iupac(BASE_OF_CHANNEL[primary_ch], BASE_OF_CHANNEL[secondary_ch])

        bases.append(ord(base_char))
        plocs.append(pos)

        # QV calibration: SNR-based
        snr = primary_amp / floor
        # QV ~ 10 * log10(snr * 10) clamped to [1, 62]
        if snr < 1.0:
            qv = 1
        else:
            qv = max(1, min(62, int(round(10 * np.log10(snr * 10)))))
        qvs.append(qv)

    return (np.array(bases, dtype=np.uint8),
            np.array(plocs, dtype=np.int32),
            np.array(qvs, dtype=np.uint8))


def _iupac(b1: str, b2: str) -> str:
    """IUPAC mixed-base code (only used if mixed-peak-threshold > 0)."""
    pair = frozenset([b1, b2])
    return {
        frozenset(["A", "C"]): "M",
        frozenset(["A", "G"]): "R",
        frozenset(["A", "T"]): "W",
        frozenset(["C", "G"]): "S",
        frozenset(["C", "T"]): "Y",
        frozenset(["G", "T"]): "K",
    }.get(pair, "N")


def trim_3_end(bases: np.ndarray, qvs: np.ndarray, value: int = 9, window: int = 40) -> tuple[np.ndarray, np.ndarray]:
    """3'-end trim: walk from right, find first window of size `window` whose
    mean QV drops below `value`, and trim there.

    Matches PeakTrace RP's "q average trim" (9 / 40).
    Returns trimmed (bases, qvs).
    """
    if value <= 0 or window <= 0 or len(bases) < window:
        return bases, qvs
    qv = qvs.astype(np.float64)
    # Cumulative sum trick for O(n) rolling mean
    cs = np.concatenate(([0.0], np.cumsum(qv)))
    # Walk from the right
    n = len(qv)
    trim_pos = n  # default: keep all
    # We trim at position i if mean(qv[i:i+window]) < value
    # = (cs[i+window] - cs[i]) / window < value
    for i in range(n - window, -1, -1):
        mean = (cs[i + window] - cs[i]) / window
        if mean >= value:
            # Keep bases up to and including i+window-1; trim after that
            trim_pos = i + window
            break
    return bases[:trim_pos], qvs[:trim_pos]


def extend_late_read(trace: Trace,
                     peak_dict: dict,
                     pb: np.ndarray,
                     ploc: np.ndarray,
                     qv: np.ndarray,
                     tail_start_pos: int,
                     min_peak_factor_tail: float = 1.3,
                     stop_quiet_scans: int = 80,
                     stop_min_amp: int = 15) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Late-read extension.

    Aug 24 finding (verified): PeakTrace RP extends the basecall by ~409 bases on
    long reads (vs ~1198 input → ~1607 PT). The extension is mostly re-basecalling
    low-quality regions within input's existing trace data, then emitting N's +
    low QVs into the noisy tail.

    Strategy:
      1. Starting at `tail_start_pos` (input's last PLOC), continue detecting peaks
         with a RELAXED SNR threshold (min_peak_factor_tail).
      2. Emit bases as long as peaks are detected.
      3. When `stop_quiet_scans` consecutive scans pass without a qualifying peak,
         stop and fill the remainder with N's (each N gets a low QV).
      4. Stop early if max channel amplitude drops below `stop_min_amp`.

    Returns extended (bases, ploc, qvs) appended to the existing arrays.
    """
    if tail_start_pos >= trace.n_scans:
        return pb, ploc, qv

    # Re-detect peaks with relaxed threshold in the tail region
    # We use a smaller min_distance (6 scans) for the tail — at the very end, peaks
    # may be more compressed as the run dies.
    tail_peak_dict = {}
    for ch in CHANNELS:
        if ch not in trace.channels:
            continue
        # Find peaks in the tail region only
        full_peaks = detect_peaks_in_channel(trace.channels[ch], min_distance=6)
        tail_peaks = full_peaks[(full_peaks >= tail_start_pos) & (full_peaks < trace.n_scans)]
        tail_peak_dict[ch] = tail_peaks

    # Compute per-channel noise floor (more permissive than main basecaller)
    ext_noise = {}
    for ch in CHANNELS:
        if ch in trace.channels:
            arr = trace.channels[ch].astype(np.float64)
            # Use 50th percentile (median) for the tail — more permissive
            ext_noise[ch] = max(1.0, float(np.percentile(arr, 50)))

    # Collect candidate peaks above relaxed threshold
    candidates = []
    for ch, peaks in tail_peak_dict.items():
        for p in peaks:
            amp = int(trace.channels[ch][p])
            if amp < ext_noise[ch] * min_peak_factor_tail:
                continue
            candidates.append((int(p), ch, amp))
    candidates.sort(key=lambda x: x[0])

    # De-dup at same scan position (take max amplitude per channel)
    merged = {}
    for pos, ch, amp in candidates:
        merged.setdefault(pos, {})[ch] = max(merged.get(pos, {}).get(ch, 0), amp)

    # Walk scans and emit bases / N's
    ext_bases = []
    ext_plocs = []
    ext_qvs = []
    last_emitted_pos = tail_start_pos
    quiet_scans = 0
    max_scan_seen = max(ploc[-1], tail_start_pos) if len(ploc) else tail_start_pos

    sorted_positions = sorted(merged.keys())
    pos_idx = 0
    cur_scan = tail_start_pos

    # Stop conditions
    max_ext_bases = 1000  # hard limit

    while len(ext_bases) < max_ext_bases and cur_scan < trace.n_scans:
        # Check stop: amplitude below absolute minimum?
        cur_max_amp = 0
        for ch in CHANNELS:
            if ch in trace.channels and cur_scan < trace.n_scans:
                cur_max_amp = max(cur_max_amp, int(trace.channels[ch][cur_scan]))
        if cur_max_amp < stop_min_amp:
            # Signal has died — stop entirely
            break

        # Do we have a peak at cur_scan?
        if pos_idx < len(sorted_positions) and sorted_positions[pos_idx] <= cur_scan + 5:
            pos = sorted_positions[pos_idx]
            # Move pos_idx past any duplicate scan positions within ±5
            while pos_idx < len(sorted_positions) and sorted_positions[pos_idx] <= pos + 5:
                pos_idx += 1
            # Find primary channel at this position
            amps = merged[pos]
            if not amps:
                cur_scan = pos + 6
                quiet_scans = 0
                continue
            sorted_amps = sorted(amps.items(), key=lambda kv: -kv[1])
            primary_ch, primary_amp = sorted_amps[0]
            base_char = BASE_OF_CHANNEL[primary_ch]
            # QV: based on SNR with relaxed formula
            snr = primary_amp / max(ext_noise[primary_ch], 1)
            if snr < 1.0:
                qv_val = 1
            else:
                qv_val = max(1, min(40, int(round(8 * np.log10(snr * 10)))))
            ext_bases.append(ord(base_char))
            ext_plocs.append(pos)
            ext_qvs.append(qv_val)
            cur_scan = pos + 6
            quiet_scans = 0
            last_emitted_pos = pos
        else:
            # No peak at cur_scan — emit N with low QV
            ext_bases.append(ord("N"))
            ext_plocs.append(cur_scan)
            ext_qvs.append(2)  # very low QV
            cur_scan += 12  # typical spacing
            quiet_scans += 12

        if quiet_scans >= stop_quiet_scans:
            break

    if not ext_bases:
        return pb, ploc, qv

    return (np.concatenate([pb, np.array(ext_bases, dtype=np.uint8)]),
            np.concatenate([ploc, np.array(ext_plocs, dtype=np.int32)]),
            np.concatenate([qv, np.array(ext_qvs, dtype=np.uint8)]))
