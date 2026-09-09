# Peak Tracer v1.8 development results

Validated on 9 September 2026, on `dev-peak-tracer`. This is a development checkpoint, not a locked or packaged release.

**v1.8 now produces a measurable improvement in the saved chromatograms.** It resolves overlapping measured peaks, preserves the raw acquisition data, and removes the unsafe insertion path used by v1.7. Across the two supplied plates, 4,550 high-quality repeated-base pairs acquired a distinct valley under the declared resolution metric. The previous version changed the displayed signal very little.

**This establishes trace-resolution value, not a complete PeakTrace replacement.** Default v1.8 retains the Seq7 sequence and confidence, except for explicitly masking very weak calls as N and repairing one duplicate call coordinate per plate. It does not yet recover the longer high-quality sequence returned by PeakTrace. Those limitations are visible in the plots and reported rather than hidden by raising quality scores.

## Changes implemented

| Area | v1.8 behavior |
|---|---|
| Channel identity | Reads `FWO_1`, including GATC in these plates; no hardcoded ACGT assumption in the live analysis. |
| Input call set | Uses complete unedited `PBAS2/PCON2/PLOC2`, with whole-set fallback. |
| Peak resolution | Baseline correction, light noise filtering, locally measured peak widths, and damped regularized Richardson–Lucy deconvolution on a locally uniform spacing grid. |
| Evidence | Operates on measured analyzed DATA9–12. Call positions define the coordinate grid, but base letters do not generate or template peaks. No commercial comparator or reference sequence is passed to processing. |
| Output signal | Writes the processed DATA9–12 into AB1. One common display gain preserves dye intensity ratios; P1AM is recomputed from the serialized signal. |
| Basecalling | Retires the v1.7 raw-gap insertion path and synthetic QV promotion. Default processing makes no A/C/G/T substitutions or insertions. |
| Quality | Retains KB QVs, masks QV <= 2 as N, and records provenance. Peak sharpness does not increase stored QVs. |
| Structural consistency | Synchronizes both call sets, requires strictly increasing in-range PLOC, and repairs duplicate input coordinates by retaining the higher-QV call. |
| Clear range and sequence | Computes a documented 3-prime arithmetic-Q window range (Q9/window40); AB1 retains full calls, and default plain `.seq` exports that clear range. Optional two-filename-header format and full-read export are available. |
| File handling | Plans names and detects collisions before processing; inputs and unrelated text files remain intact. Short bad reads produce consistent AB1/sequence outputs, including an empty clear-range export. |
| GUI/CLI | Shared GUI defaults, validated positive/negative flags, explicit rejection of retired options and unknown settings, and buffered JSON progress messages. |
| Reproducibility | Run manifest and custom `PT18` ABIF provenance include parameters, input SHA256, exact processing-source SHA256, decisions, and diagnostics. |

The old helper modules remain for historical tests and compatibility, but the retired calling and destructive batch-preprocessing functions are not used by the live CLI. Enabling the retired calling flags fails explicitly.

The algorithm uses a default resolution strength of 0.75 and 24 iterations. Widths come from isolated measured peaks, with a common local kernel for all dyes. Damping and a small smoothness penalty restrain noise amplification. The analyzed coordinate grid and read length are preserved. Raw DATA1–4 are preserved as evidence; this version does not attempt the previously invalid length-ratio raw-to-analyzed mapping.

## Controlled comparison

Sample4 contains 78 reads. Folder 4 was generated from `f1412e0` before any edits and has its own input-hash manifest. Folder 5 was generated through the real v1.8 CLI from the same frozen folder-2 input. Batch preprocessing was disabled in both comparisons to isolate processing; non-mutating preprocessing was exercised separately in tests.

Sample5 contains 68 reads and was processed with the same final defaults, without plate-specific parameter changes. Its v1.7 comparator is the frozen `analysis_v1.7/runs/sample5_default` result from the earlier audit. Sample5 had already been examined in that audit, so this is a second-plate replication, not a blinded or never-seen clinical validation set.

### Measured resolution

For adjacent identical A/C/G/T calls with both input QVs at least 20, find a local crest around each call (within 30% of the call spacing). Define valley contrast as `1 - minimum_between_crests / smaller_crest`. A pair is counted as separated when contrast is at least 0.15. Edge pairs, spacing below four samples, and zero-signal pairs are excluded. Gain cannot improve this ratio. This is a descriptive signal-shape metric, not a validated base-error metric.

| Plate | Seq7 | Frozen v1.7 | v1.8 | PeakTrace comparator* |
|---|---:|---:|---:|---:|
| sample4 separated pairs / eligible pairs | 12,947 / 17,843 | 12,952 / 17,897 | **15,218 / 17,843** | 21,428 / 23,618 |
| sample4 fraction | 72.56% | 72.37% | **85.29%** | 90.73% |
| sample5 separated pairs / eligible pairs | 12,825 / 17,703 | 12,826 / 17,741 | **15,104 / 17,703** | 21,531 / 23,265 |
| sample5 fraction | 72.44% | 72.30% | **85.32%** | 92.55% |

*PeakTrace and v1.7 contain different call populations, so their fractions are contextual comparisons. Input versus v1.8 uses the exact same eligible pairs and coordinates.

The paired audit found 2,271 newly separated pairs on sample4 and 2,279 on sample5, with **zero pairs losing separation at this threshold**. Net separation increased in 76/78 sample4 reads and all 68 sample5 reads; the remaining two sample4 reads were tied. This does not mean there were no local artifacts, peak-shape degradations, or errors outside the chosen metric.

A sample4 ablation kept baseline correction, smoothing, N policy, export policy and gain unchanged but disabled deconvolution. It separated only **12,892/17,843 pairs (72.25%)**, versus 15,218 with deconvolution. Thus the measured gain is attributable to the new resolution operation, rather than a gain adjustment or renamed files.

### Sequence and confidence

| Plate / output | Bases | Ns | Stored Q20 | Stored Q30 |
|---|---:|---:|---:|---:|
| sample4 Seq7 | 91,757 | 0 | 70,268 | 62,874 |
| sample4 v1.7 | 100,064 | 1,451 | 72,317 | 62,874 |
| sample4 v1.8 | 91,756 | 1,487 | 70,268 | 62,874 |
| sample4 PeakTrace | 117,347 | 3,483 | 88,736 | 82,221 |
| sample5 Seq7 | 80,777 | 0 | 65,186 | 59,022 |
| sample5 v1.7 | 88,745 | 1,274 | 67,266 | 59,022 |
| sample5 v1.8 | 80,776 | 1,300 | 65,186 | 59,022 |
| sample5 PeakTrace | 100,075 | 2,292 | 82,188 | 76,930 |

The one-base reductions are duplicate-position repairs, not trimming of the AB1 sequence. `.seq` lengths can be shorter because their default export uses the clear range.

v1.7 added 8,359 new positions on sample4 and 8,021 on sample5; the earlier audit showed nearly all were internal rather than true extension. v1.8 adds **zero new positions**, performs **zero retained-position A/C/G/T substitutions**, and increases **zero retained QVs**. Non-increasing PLOC pairs fall from 24 and 31 in v1.7 to zero.

The affine-gap comparator alignment reports sample4 internal query insertions of 7,495 for v1.7 and 1,203 for v1.8 (Seq7: 854); sample5 gives 7,138 and 938 (Seq7: 644). These are alignment events against PeakTrace, not known biological errors. The candidate's N masking changes the alignment, so lower mismatch counts must not be advertised as independent accuracy improvements. The coordinate-based audit is the stronger evidence that unsupported inserted calls were removed.

An optional `--recall-low-quality` experiment revised just one sample4 base, agreeing with PeakTrace at that position. It requires agreement between original and resolved signal, rejects weak/displaced evidence, and never raises QV. One favorable comparison is insufficient validation, so **this option remains off by default**.

## The five reported issues

1. **POS1 merged mountains:** substantially improved. The TTTT and adjacent A repeats acquire separate measured peaks; they are still less uniformly separated than PeakTrace. [Four-way plot](figures/pos1_resolution.png).
2. **POS1 extra bases near GGG:** the v1.7 insertion path is removed. The candidate retains the Seq7 sequence there and improves the signal, without claiming that every G has become independently resolved. [Four-way plot](figures/pos1_insertions.png).
3. **U0827 Ns and amplitude:** N policy and common display gain are explicit and consistent. N counts and amplitudes do not exactly reproduce PeakTrace, and matching them numerically is not an accuracy target.
4. **U0827 low-quality/end-of-read behavior:** processing and exports are coherent, and overlapping peaks improve, but the difficult AAAA region still has shallow shoulders. No unsupported long tail is appended. [Resolution plot](figures/u0827_resolution.png).
5. **Geneious confidence deteriorates earlier:** **not solved**. The retained KB quality profile still deteriorates earlier than PeakTrace. Raising PCON values to change viewer colors would conceal the gap. [Quality plot](figures/u0827_quality.png).

All plots are drawn from the saved AB1 files using their FWO channel order, not from transient processing arrays. Motifs identify windows independently in each file; axes are local analyzed-sample coordinates, not shared raw-time axes. Within each panel one common normalization is applied to all four dyes.

## Verification and limitations

**97 unit/integration tests passed** using the available Python 3.11.16 runtime (Biopython 1.88, NumPy 2.4.6, SciPy 1.17.1). Tests include all 24 channel orders, independent Biopython AB1 round trips, inline tags, malformed spans, call-set selection, collision rejection, source preservation, short bad reads, synthetic overlapping peaks with known multiplicity, flat-signal behavior, independence from base letters, conservative substitution rejection, and actual Node-built argv parsed by Python. Node syntax checks passed for the Electron main process and parameter builder.

Final CLI runs completed **78/78 in 27.04 seconds** and **68/68 in 23.41 seconds** on this laptop. The independent audit passed all 146 files: input hashes match recorded provenance; opaque original tags and raw channels are preserved; call sets agree; PLOC is strict and in bounds; QVs are retained; only permitted N changes occurred; clear ranges agree with the declared convention; and `.seq` matches the selected AB1 range. All sample4 input hashes also match the pre-edit baseline freeze.

Processing source SHA256 for both final runs:

`47f86c38769e4138dd69b022c8f4912092525d68f94949eed41a69174a22a8da`

ABIF `phTR1` is serialized as two short integers using zero-based first/last included indices, and `phTR2` is left at the unavailable sentinel rather than fabricating a trim probability. The file audit checks this declared convention. **Fresh SnapGene/Geneious import and clear-range interpretation have not been verified in their GUIs.** No Electron build, installer, portable EXE or ZIP was produced, per the requested scope.

The signal model is approximate. It uses a Gaussian broadening model, inherits the KB spacing grid, and can sharpen noise or retain unresolved shoulders. Synthetic tests and the two plates cannot establish behavior on all chemistries, mixtures, failed reactions, dye blobs, saturated traces or very long reads. No independent truth-labelled panel was supplied, and PeakTrace agreement alone is not biological validation.

### Synthetic stress check

An additional deterministic experiment generated 32 traces from known peaks with variable spacing, unequal peak amplitudes, slowly increasing broadening, a baseline and four noise levels. Each noise level contains eight seeds and 1,472 true peak centers. The same v1.8 defaults were used without tuning. Prominent crests were matched within four samples of the known centers, with a prominence threshold of 15% of the noiseless channel's 99th percentile.

| Added noise SD / nominal peak height | Input matched / unmatched crests | v1.8 matched / unmatched crests |
|---|---:|---:|
| 0% | 1,384 / 1 | 1,426 / 0 |
| 2% | 1,385 / 3 | 1,425 / 0 |
| 5% | 1,399 / 60 | 1,428 / 3 |
| 10% | 1,444 / 2,778 | 1,435 / 204 |

No output trial produced multiple prominent crests assigned to one known center. At 10% noise the candidate still has 204 unmatched crests and misses 37 true centers; this demonstrates why a sharp-looking trace must not automatically become a high-confidence call. Input noise can also make apparent recall rise by producing many spurious crests. This simplified Gaussian simulation supports the resolution mechanism but omits important real failure modes and supplies the correct call-position anchors. See `synthetic_stress.json` and `python-app/experiments/resolution_stress.py` for the exact experiment.

## Reproduce and inspect

From the `004_Peak_Tracer` repository, with Python and the requirements available:

```powershell
python python-app/peaktrace_core.py --input-dir 'PATH_TO_2' --output-dir 'FRESH_PATH_TO_5' --no-preprocess
python python-app/experiments/compare_plate.py --input 'PATH_TO_2' --reference 'PATH_TO_3' --baseline 'PATH_TO_4' --candidate 'PATH_TO_5' --output 'COMPARISON_FOLDER' --plots
python python-app/experiments/audit_outputs.py --input 'PATH_TO_2' --candidate 'PATH_TO_5' --output 'COMPARISON_FOLDER/audit.json'
python -m unittest discover -s python-app/tests
```

The processing Python needs NumPy, SciPy and Biopython. The comparison Python also needs matplotlib. No packages were installed during this work; the existing relocated v1.6 runtime processed files, and system Python produced plots. Use a fresh output folder: existing AB1/sequence outputs are rejected to avoid mixing runs.

Task artifacts are under `Peak_trace/v1.8_validation/`. Sample4 has the requested `2-P1905969_2026-08-28`, `3-P1905969_2026-08-28`, `4-v1.7-f1412e0`, and `5-v1.8` folders, plus `comparison/` and `ablation-no-resolution/`. Sample5 outputs and comparisons are under `sample5/`; its original 2/3 folders and frozen v1.7 outputs remain in `analysis_v1.7/`. The task comparison directories contain per-read CSV metrics, aggregate JSON, audit JSON and diagnostic plots. This repository stores aggregate results and the four plots, without committing the AB1 datasets.

## Next development work

1. **Validate the saved files in SnapGene and Geneious.** Check the two diagnostic reads, one repaired duplicate-position read, a short failed read, and clear-range boundaries. Compare exported sequence to the visible selected range. Resolve viewer interpretation before packaging.
2. **Add a truth-labelled evaluation panel.** Obtain independently validated alignments and difficult regions, including negative controls, known variants, repeats and failed reactions. Separate training/development/holdout by sample or plate. Record substitutions, insertions, deletions, usable read length and calibration rather than optimizing resemblance to PeakTrace.
3. **Implement a measured raw-coordinate mapping and caller as a separate experiment.** Detect raw peaks using FWO, align their base identities to high-confidence KB anchors, fit monotone piecewise coordinates, and evaluate held-out anchor residuals. The exploratory probe supports this approach, but it has not been promoted into production. Reject mappings with too few anchors or poor residuals; do not revive the length-ratio mapper.
4. **Compare competing sequence hypotheses.** Fit nonnegative local peak mixtures, compare k versus k+1 repeat peaks and alternative dyes with a residual/noise penalty, and require improvement over the retained KB hypothesis. Low-quality substitutions alone cannot recover missing read length. Keep this caller behind an explicit experimental switch until it wins on independent held-out data.
5. **Calibrate QVs before claiming confidence gains.** Train and evaluate empirical error probabilities from labelled outcomes; inspect reliability by Q bin, repeat length and read position. Only then promote calls or claim Q20/Q30 read-length gains. Until then keep the current honest QV policy.

The immediate milestone has been reached: useful, visible trace resolution with reproducible files and measurements. Commercial basecalling equivalence and replacement of the paid service remain open scientific milestones.

Implementation commits: `9ebb9c0` (processing core and contracts), `a2c8792` (GUI/CLI wiring and shared defaults). The experiment scripts, results and this report are committed separately. All work remains on `dev-peak-tracer`; no push, squash, version lock or packaging was performed.
