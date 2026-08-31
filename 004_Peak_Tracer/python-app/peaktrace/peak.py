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

Stage 6: extend_late_read_interpolated — re-basecall via trace interpolation.
          Interpolates 4 channels to ~1.25x resolution, detects peaks with
          adaptive prominence, keeps existing Seq7 calls where they match,
          adds new calls in low-SNR regions, stops when quality collapses.
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


def get_data14_channels(trace: Trace) -> dict:
    """Extract DATA1-4 (full-resolution processed channels) from trace.tags.

    Returns dict {1: ndarray, 2: ndarray, 3: ndarray, 4: ndarray} (A, C, G, T).
    Empty dict if DATA1-4 are absent.
    """
    full = {}
    for ch in (1, 2, 3, 4):
        tag = f"DATA{ch}"
        if tag in trace.tags:
            arr = np.asarray(trace.tags[tag], dtype=np.float64)
            if len(arr) > 100:
                full[ch] = arr
    return full


def detect_peaks_data14(trace: Trace,
                        min_snr: float = 1.3,
                        distance: int = 8,
                        adaptive_fill: bool = True) -> dict:
    """Detect peaks in DATA1-4 at PT-like density (~12.3 scans/base).

    Strategy:
      1. Per channel, find_peaks with prominence = noise * min_snr
      2. Adaptive fill pass: where adjacent peaks in the COMBINED signal are
         > 1.5x the median spacing, re-run find_peaks on that gap region with
         prominence * 0.8 to pick up marginal peaks Seq7-style detectors miss
      3. Returns dict {ch: peak_positions} in DATA1-4 coordinates

    Sanity: total peaks across channels should be ~ len(DATA1) / 12.3.
    """
    from scipy.signal import find_peaks

    full = get_data14_channels(trace)
    if not full:
        return {}

    n = len(next(iter(full.values())))
    peaks = {}
    noise = {}
    for ch, arr in full.items():
        noise[ch] = max(1.0, float(np.percentile(arr, 5)))
        pk, _ = find_peaks(arr, prominence=noise[ch] * min_snr, distance=distance)
        peaks[ch] = pk.astype(np.int32)

    if not adaptive_fill:
        return peaks

    # Adaptive fill: find gaps in the combined peak train and re-scan them
    combined_peaks = np.sort(np.concatenate([peaks[ch] for ch in peaks]))
    if len(combined_peaks) < 20:
        return peaks
    spacings = np.diff(combined_peaks)
    median_spacing = float(np.median(spacings))
    if median_spacing <= 0:
        return peaks

    gap_threshold = median_spacing * 1.5
    gap_idx = np.where(spacings > gap_threshold)[0]

    for gi in gap_idx:
        lo = int(combined_peaks[gi])
        hi = int(combined_peaks[gi + 1])
        if hi - lo < distance * 2:
            continue
        for ch, arr in full.items():
            sub = arr[lo:hi]
            # Re-scan with lower prominence
            pk, _ = find_peaks(sub, prominence=noise[ch] * min_snr * 0.8, distance=distance)
            if len(pk):
                new_peaks = pk + lo
                peaks[ch] = np.sort(np.concatenate([peaks[ch], new_peaks])).astype(np.int32)

    return peaks


def extend_late_read_interpolated(
    trace: Trace,
    interpolation_factor: float = 1.25,
    min_snr: float = 1.3,
    stop_quiet_bases: int = 40,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Re-basecall using DATA1-4 (processed, pre-truncation) instead of DATA9-12.

    Seq7 truncates DATA9-12 to ~16k scans but leaves DATA1-4 intact at ~18.7k.
    PeakTrace RP uses DATA1-4 to recover ~400 bases beyond Seq7's 3' end.

    Strategy:
      1. Read DATA1-4 from the trace tags (not DATA9-12 which Seq7 truncated)
      2. Detect peaks on the full DATA1-4 signal
      3. Align peaks to existing Seq7 calls in the overlap region (sanity check)
      4. Add new calls beyond Seq7's last base
      5. Stop when QV drops too low for too long

    Returns extended (pb, ploc, qv).
    """
    from scipy.signal import find_peaks

    # Get DATA1-4 from trace tags (Biopython stores them there)
    # DATA1=A, DATA2=C, DATA3=G, DATA4=T (same as DATA9-12 but pre-truncation)
    full_channels = {}
    for ch_num in [1, 2, 3, 4]:
        tag = f"DATA{ch_num}"
        if tag in trace.tags:
            arr = np.array(trace.tags[tag], dtype=np.int32)
            full_channels[ch_num] = arr

    if not full_channels:
        # Fallback: use DATA9-12 if DATA1-4 are not available
        full_channels = {ch: trace.channels[ch] for ch in CHANNELS if ch in trace.channels}
        n_full = trace.n_scans
    else:
        n_full = len(next(iter(full_channels.values())))

    # Compute channel noise from DATA1-4 (not DATA9-12)
    channel_noise = {}
    for ch, arr in full_channels.items():
        channel_noise[ch] = max(1.0, float(np.percentile(arr.astype(np.float64), 5)))

    # Detect peaks on the full-resolution channels
    all_peaks = []
    for ch, arr in full_channels.items():
        signal = arr.astype(np.float64)
        noise = channel_noise[ch]
        prominence = noise * min_snr
        peaks, _ = find_peaks(signal, prominence=prominence, distance=6)
        for p in peaks:
            all_peaks.append((int(p), ch, int(arr[p])))
    all_peaks.sort(key=lambda x: x[0])

    # Merge multi-channel peaks at same position
    merged = {}
    for pos, ch, amp in all_peaks:
        merged.setdefault(pos, {})[ch] = max(merged.get(pos, {}).get(ch, 0), amp)

    # Find the position corresponding to Seq7's last called base
    # Seq7's PLOC is in DATA9-12 coordinates (16k scans)
    # DATA1-4 have ~1.17x more scans, so scale: ploc_full = ploc * ratio
    if len(trace.ploc_in) == 0:
        return trace.pb_in, trace.ploc_in, trace.qv_in

    ratio = n_full / trace.n_scans
    last_seq7_pos = int(trace.ploc_in[-1] * ratio)

    # Only add bases AFTER Seq7's last call
    ext_bases = []
    ext_plocs = []
    ext_qvs = []
    quiet_count = 0

    # Map channel IDs: DATA1→A, DATA2→C, DATA3→G, DATA4→T
    BASE_OF_FULL_CHANNEL = {1: "A", 2: "C", 3: "G", 4: "T"}

    for pos in sorted(merged.keys()):
        if pos < last_seq7_pos + 5:
            continue

        amps = merged[pos]
        if not amps:
            continue
        sorted_amps = sorted(amps.items(), key=lambda kv: -kv[1])
        primary_ch, primary_amp = sorted_amps[0]
        base_char = BASE_OF_FULL_CHANNEL[primary_ch]

        # Map back to Seq7's scan coordinates (DATA9-12)
        # ploc_out = pos / ratio
        ploc_out = int(round(pos / ratio))

        # QV: SNR-based
        floor = channel_noise[primary_ch]
        snr = primary_amp / floor
        if snr < 1.0:
            qv = 1
        else:
            qv = max(1, min(62, int(round(10 * np.log10(snr * 10)))))

        ext_bases.append(ord(base_char))
        ext_plocs.append(ploc_out)
        ext_qvs.append(qv)

        if qv < 10:
            quiet_count += 1
            if quiet_count >= stop_quiet_bases:
                break
        else:
            quiet_count = 0

    if not ext_bases:
        return trace.pb_in, trace.ploc_in, trace.qv_in

    # Merge: original calls + new calls
    combined = list(zip(trace.ploc_in, trace.pb_in, trace.qv_in))
    combined += list(zip(ext_plocs, ext_bases, ext_qvs))
    combined.sort(key=lambda x: x[0])

    final_ploc = np.array([c[0] for c in combined], dtype=np.int32)
    final_pb = np.array([c[1] for c in combined], dtype=np.uint8)
    final_qv = np.array([c[2] for c in combined], dtype=np.uint8)

    return final_pb, final_ploc, final_qv


def rebasecall_data14(trace: Trace,
                      map_params: dict,
                      peaks14: dict,
                      min_snr: float = 1.3,
                      min_snr_for_keep: float = 3.0,
                      secondary_max_pct: float = 25.0,
                      qv_floor: int = 10,
                      stop_quiet_bases: int = 40,
                      pb=None, ploc=None, qv=None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Re-basecall on DATA1-4 peak positions, merge with Seq7's existing calls.

    Merge rule:
      - Keep Seq7's call where a re-basecall is within +/-2 DATA9-12 scans
        (same base or not - trust input in the overlap region)
      - Add re-basecalls only where no Seq7 call exists within +/-6 scans
      - Every added base comes from a real detected peak with computed QV

    Acceptance gate for newly-added extension bases (PT-style):
      - Primary SNR >= min_snr_for_keep (default 3.0), OR
      - Secondary peak amplitude / primary amplitude <= secondary_max_pct% (default 25%)
        (catches "weak but unambiguous" peaks)
      - QV >= qv_floor (default 10); otherwise downgrade base to 'N'
      - Stop extension after `stop_quiet_bases` consecutive bases with QV < qv_floor

    Returns (pb, ploc, qv) in DATA9-12 coordinates, sorted by PLOC.
    """
    from .align import map_to_data9

    if pb is None: pb = trace.pb_in.copy()
    if ploc is None: ploc = trace.ploc_in.copy()
    if qv is None: qv = trace.qv_in.copy()
    full = get_data14_channels(trace)
    if not full or not peaks14 or not map_params.get("ok"):
        return pb, ploc, qv

    # Channel noise from DATA1-4
    # Use robust estimator: median absolute deviation (MAD) × 1.4826 ≈ std dev
    # of normal distribution. This is what PT likely uses — robust to peak contamination.
    noise = {}
    for ch, arr in full.items():
        a = arr.astype(np.float64)
        med = float(np.median(a))
        mad = float(np.median(np.abs(a - med)))
        sigma = mad * 1.4826
        noise[ch] = max(1.0, sigma)
    BASE_OF_FULL = {1: "A", 2: "C", 3: "G", 4: "T"}

    # Merge peaks from all channels: position -> {ch: amp}
    merged = {}
    for ch, pks in peaks14.items():
        for p in pks:
            amp = float(full[ch][p])
            if amp < noise[ch] * min_snr:
                continue
            merged.setdefault(int(p), {})[ch] = max(merged.get(int(p), {}).get(ch, 0.0), amp)

    # Candidate calls in DATA1-4 coords, with PT-style acceptance gate:
    # keep if SNR >= min_snr_for_keep OR secondary_amp/primary_amp <= secondary_max_pct/100
    cand_pos14 = []
    cand_base = []
    cand_qv = []
    for pos in sorted(merged):
        amps = merged[pos]
        sorted_amps = sorted(amps.items(), key=lambda kv: -kv[1])
        primary_ch, primary_amp = sorted_amps[0]
        snr = primary_amp / noise[primary_ch]

        # PT-style dual criterion
        if snr >= min_snr_for_keep:
            keep = True
        elif len(sorted_amps) > 1:
            secondary_amp = sorted_amps[1][1]
            secondary_pct = (secondary_amp / primary_amp) * 100.0 if primary_amp > 0 else 100.0
            keep = secondary_pct <= secondary_max_pct
        else:
            keep = False  # no secondary peak to compare; single-channel call must clear SNR

        if not keep:
            continue

        qv_val = max(1, min(62, int(round(10 * np.log10(snr * 10))))) if snr >= 1.0 else 1
        # FIX #7: downgrade low-QV extension bases to 'N' (PT behavior)
        if qv_val < qv_floor:
            base_char = "N"
        else:
            base_char = BASE_OF_FULL[primary_ch]
        cand_pos14.append(pos)
        cand_base.append(ord(base_char))
        cand_qv.append(qv_val)

    if not cand_pos14:
        return pb, ploc, qv

    # Map to DATA9-12 coords
    cand_pos9 = map_to_data9(np.array(cand_pos14), map_params)

    # FIX #9: allow candidates beyond trace.n_scans (Seq7 truncation). PeakTrace
    # extends the chromatogram to fit these; we do the same downstream.
    # Old code filtered `cand_pos9 < trace.n_scans` which dropped all extension
    # positions, limiting our extension to ~original Seq7 length.
    valid = cand_pos9 >= 0
    cand_pos9 = cand_pos9[valid]
    cand_base = np.array(cand_base, dtype=np.uint8)[valid]
    cand_qv = np.array(cand_qv, dtype=np.uint8)[valid]

    # Merge with Seq7 calls
    # Only add new bases where Seq7 has a GAP (dropped peak) — i.e., where the
    # distance flanking Seq7 calls exceeds 1.5x median Seq7 spacing. Within
    # normal-density regions, trust Seq7 and add nothing.
    seq7_pos = ploc.astype(np.int32)
    spacings = np.diff(seq7_pos)
    med_spacing = float(np.median(spacings)) if len(spacings) else 12.0
    gap_centers = []  # (gap_start, g_end) in DATA9-12 coords
    # NOTE: no leading gap — inserting bases before the first Seq7 call risks
    # primer-injection artifacts and breaks prefix integrity. Skip it.
    for i in range(len(seq7_pos) - 1):
        if spacings[i] > med_spacing * 1.5:
            gap_centers.append((int(seq7_pos[i]), int(seq7_pos[i + 1])))
    # Trailing gap (after last Seq7 base — the classic extension region).
    # FIX #9: extend the trailing gap to include positions beyond trace.n_scans
    # so rebasecall candidates from DATA1-4 can land there. Old code used
    # `trace.n_scans` as g_end which capped extension at Seq7's truncation point.
    if len(seq7_pos):
        trailing_end = max(trace.n_scans, int(cand_pos9.max()) + 10 if len(cand_pos9) else trace.n_scans)
        if trailing_end - seq7_pos[-1] > med_spacing * 1.5:
            gap_centers.append((int(seq7_pos[-1]), int(trailing_end)))

    keep_new = np.zeros(len(cand_pos9), dtype=bool)
    for i, p in enumerate(cand_pos9):
        for g_start, g_end in gap_centers:
            # inside a gap, but not too close to the flanking Seq7 calls
            if g_start + 3 < p < g_end - 3:
                keep_new[i] = True
                break

    new_pos = cand_pos9[keep_new]
    new_base = cand_base[keep_new]
    new_qv = new_qv_raw = cand_qv[keep_new]

    if len(new_pos) == 0:
        return pb, ploc, qv

    # FIX #6+#7: PT stops extension after a run of low-QV bases. Apply this
    # to the trailing gap region only (other gaps are short insertions).
    # Find the index range that corresponds to the trailing gap (the one
    # whose g_end == trace.n_scans).
    trailing_mask = np.zeros(len(new_pos), dtype=bool)
    trailing_start = -1
    if gap_centers and gap_centers[-1][1] == trace.n_scans:
        trailing_start = gap_centers[-1][0]
        trailing_mask = new_pos > trailing_start

    if trailing_mask.any():
        # Truncate trailing extension at the first run of `stop_quiet_bases`
        # consecutive bases with QV < qv_floor. We keep partial gaps.
        # Walk forward; once we hit stop_quiet_bases quiet bases in a row,
        # discard that base and everything after.
        idxs = np.where(trailing_mask)[0]
        quiet_run = 0
        cut_at = len(new_pos)  # default: keep all
        for j, idx in enumerate(idxs):
            if new_qv[idx] < qv_floor:
                quiet_run += 1
                if quiet_run >= stop_quiet_bases:
                    cut_at = idx  # discard this and subsequent
                    break
            else:
                quiet_run = 0
        if cut_at < len(new_pos):
            keep_mask = np.ones(len(new_pos), dtype=bool)
            keep_mask[cut_at:] = False
            new_pos = new_pos[keep_mask]
            new_base = new_base[keep_mask]
            new_qv = new_qv[keep_mask]

    if len(new_pos) == 0:
        return pb, ploc, qv

    # Final merge: Seq7 + new, sorted by position
    all_pos = np.concatenate([seq7_pos, new_pos])
    all_base = np.concatenate([pb, new_base])
    all_qv = np.concatenate([qv, new_qv])
    order = np.argsort(all_pos, kind="stable")

    return (all_base[order].astype(np.uint8),
            all_pos[order].astype(np.int32),
            all_qv[order].astype(np.uint8))
