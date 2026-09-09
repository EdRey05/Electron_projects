# Peak Tracer v1.9 results and development record

Completed 9 September 2026 on `dev-peak-tracer`. Starting checkpoint: v1.8 commit `27c5ef4`. Plan commit: `ee76ec6`; implementation commit: `410fba2`. This is an implemented and tested development checkpoint, not a locked, built or packaged release.

**v1.9 provides an incremental improvement over v1.8: rounder high-quality crests and better aggregate resolution in weaker regions, particularly around bases 600–900.** The gain is smaller than the v1.7-to-v1.8 change. Some individual regions regress, and the difficult U0827 AAAA example is still not well resolved. **The confidence/read-length gap with PeakTrace remains unresolved:** all saved calls, QVs, positions and sequence exports are identical to v1.8 on both plates.

Read the [starting plan](PLAN.md) and [v1.8 report](../v1.8/VALIDATION.md) alongside this record. The user's successful v1.8 inspection in SnapGene and Geneious guided the work: reduce spiky crests, improve weaker regions, and prioritize useful existing sequence over appending poor-quality tail calls.

## What the app now does

The new default resolver still works on measured DATA9–12 with the original call-position grid. It estimates local peak widths, performs a moderately stronger nonnegative inverse restoration, then applies **adaptive finite-width rounding**. Narrow peaks receive more rounding; broad peaks receive less, to avoid merging adjacent peaks again. Measured local noise moderates the inverse update. The algorithm does not synthesize peaks from PBAS letters, use a reference sequence, or read commercial comparator scores during processing.

| Parameter / behavior | v1.8 | v1.9 default |
|---|---|---|
| Resolver | Relative-width damped Richardson–Lucy | Noise-regularized inverse plus adaptive reconvolution |
| Inverse strength | 0.75 | **0.80** |
| Iterations | 24 | **40** |
| Maximum inverse sigma on the 8-samples/base grid | 5 samples | **8 samples** |
| Output rounding | No separate final rounding | **Target minimum Gaussian sigma 0.24 base-spacing units** |
| Noise handling | Global numerical floor | **Local robust noise estimate, multiplier 1**, plus numerical floor |
| Calls/QVs/clear range/export policy | Conservative retained KB contract | Unchanged |

The target width is an approximate model parameter, not a guarantee that every output peak has exactly that width. The estimated residual blur determines the additional Gaussian rounding; a small 0.04-base sigma floor regularizes broad regions. A common kernel, rounding operation and display gain are used across the dyes. Relative peak shapes and heights can still change through nonlinear processing; raw DATA1–4 remain available unchanged.

The CLI and GUI share the new strength, iterations, peak-width and noise defaults. `--peak-width 0` disables final rounding. `--resolution-model v18` selects the preserved v1.8 resolver and, unless explicitly overridden, its original 0.75/24 defaults. The legacy option is for controlled comparisons. No new raw caller is enabled. Experimental substitutions remain off by default.

For normal review, open **`v1.9_validation/sample4/6-v1.9`**, or its sample5 counterpart. `5-v1.8` remains the baseline. Comparison and raw-anchor folders are analysis artifacts, not additional steps the app requires you to run.

## Plan-to-outcome accounting

| Planned work | Outcome and deviation |
|---|---|
| Preserve v1.8 and the same inputs | Completed. Recorded and rechecked hashes of all 146 v1.8 AB1s. v1.8/v1.9 provenance identifies the same source hashes; input audits passed. |
| Finite-width peak model | Completed, with an important adjustment: uniform rounding was rejected because it merged weak peaks. Adaptive rounding was selected instead. |
| Noise regularization | Completed. A local MAD-based estimate from the signal's high-frequency residual moderates inverse updates. It had little effect on this already-processed real-data subset at multipliers 1 versus 3; synthetic noisy traces provide stronger evidence of the complete model's behavior. Do not attribute the real-plate gain solely to noise estimation. |
| Evaluate by quality and base-index region | Completed on all 146 reads, using fixed input groups, including both gains and losses. |
| Raw-to-analyzed correspondence diagnostic | Implemented and tested; internal gates passed on 142/146 reads. It remains separate from the live processing path and has not become a caller or confidence estimator. |
| Preserve call/export contract | Completed. Every v1.9 call sequence, QV array, PLOC array and `.seq` export matches v1.8 exactly on these plates. |
| Validation, plots and reports | Completed. 104 tests passed, synthetic stress comparisons ran, and all saved files passed independent audits. Fresh GUI assessment of v1.9 is still pending. |

The principal scientific departure from a full replacement remains deliberate: improve measured trace presentation while developing the prerequisites for better basecalling. Neither stronger sharpening nor rounding justifies increasing PCON values. Nucleics itself distinguishes display smoothing from its basecalling function and documents that its caller uses raw data. [Nucleics options](https://www.nucleics.com/peaktrace-online-pro-help/), [basecaller FAQ](https://www.nucleics.com/peaktrace/peaktrace-FAQ.html).

## Tuning and rejected approaches

Development used **10 deterministic sample4 reads**: every eighth filename in sorted order, with the two requested diagnostic reads included. Four recorded rounds made 210 resolver evaluations, including repeated controls. Selection used input-derived region metrics and inspection, not PeakTrace-derived target calls or QVs. After selection, both complete plates were run without further parameter changes. Sample5 had been studied earlier, so this is second-plate replication, not blinded or never-seen validation.

1. **Uniform rounding, inverse cap 5.** Tested strengths 0.90/0.95, 40/48 iterations, rounding sigma 0.14/0.18/0.22, and one noise-multiplier-3 variant. Crests became rounder but weak-repeat separation deteriorated. For example, Q20–39 separation in the subset fell from 50.69% in v1.8 to 41.19% at strength 0.90 / width 0.14. Rejected. Full record: `development_sweep.json`.
2. **Wider inverse cap 8, milder fixed rounding.** Tested strength/rounding pairs 0.80/0.06, 0.85/0.10, 0.90/0.12, 0.90/0.16 and 0.95/0.14. The 0.80/0.06 candidate improved weaker-group separation but narrowed already-sharp high-Q crests: their mean upper width fell from 0.237 to 0.221 base units. It was useful as a diagnostic, not the final default. Record: `development_sweep_2.json`.
3. **Adaptive rounding at strength 0.80 / 40 iterations.** Tested target widths 0.22, 0.24 and 0.26, plus width 0.24 with noise multiplier 3. Width 0.24 was selected as a compromise: noticeably rounder high-Q crests with nearly the weaker-region separation of 0.22. Width 0.26 sacrificed more weak-region separation. Record: `development_sweep_3.json`.
4. **Local versus whole-read noise estimate.** Checked the selected 0.24 candidate with each noise estimate. The displayed aggregate subset rates were identical to two decimal places; local estimation was retained to follow changes in noise across a read. No further real-data tuning was performed. Record: `development_sweep_4.json`.

Selected-subset separation percentages were 34.24%, 52.36%, 56.04% and 96.66% for Q3–9, Q10–19, Q20–39 and Q40+, respectively; the corresponding v1.8 rates were 32.88%, 49.21%, 50.69% and 96.34%. These are development results, not unbiased performance estimates. All four rounds can be replayed through `refine_v19.py --sweep 1`, `2`, `3` or `4` with the same input folder.

## Full-plate results

The pair metric is the same descriptive criterion used in v1.8: valley depth of at least 15% relative to the smaller local crest between adjacent identical called bases. Quality groups use the **original Seq7 QVs**, and comparisons use the same original coordinates and channel identities. Q0–2 calls, problematic edge windows, and zero-signal pairs are excluded. In weak regions, even the underlying repeat call count can be wrong; this metric measures trace shape, not sequencing accuracy.

### Separation by original quality

| Plate / group | Seq7 | v1.8 | v1.9 | Gained / lost pairs versus v1.8 |
|---|---:|---:|---:|---:|
| sample4 Q3–9 | 15.94% | 24.71% | **27.40%** | 95 / 24 |
| sample4 Q10–19 | 20.89% | 30.18% | **35.08%** | 135 / 18 |
| sample4 Q20–39 | 14.54% | 47.92% | **55.22%** | 319 / 12 |
| sample4 Q40+ | 90.47% | 96.82% | **97.14%** | 46 / 3 |
| sample5 Q3–9 | 1.29% | 9.90% | **13.76%** | 86 / 11 |
| sample5 Q10–19 | 2.50% | 11.32% | **18.52%** | 130 / 9 |
| sample5 Q20–39 | 12.73% | 46.50% | **54.35%** | 345 / 23 |
| sample5 Q40+ | 90.45% | 97.02% | **97.32%** | 42 / 2 |

Across all included quality groups, sample4 gained 595 separated pairs and lost 57, for net +538; sample5 gained 603 and lost 45, for net +558. Thus **1,198 gained and 102 lost**, not a universal improvement. Net gains occurred in 75/78 sample4 reads and all 68 sample5 reads.

For the Q20+ population used in the v1.8 headline metric, sample4 improved from **15,218/17,843 (85.29%) to 15,568/17,843 (87.25%)**; sample5 improved from **15,104/17,703 (85.32%) to 15,466/17,703 (87.36%)**. PeakTrace remains at 90.73% and 92.55% on its own different, longer Q20+ call populations; those denominators are not a paired accuracy comparison.

### Original base-index regions

| Plate / region | Eligible common pairs | v1.8 separated | v1.9 separated | Net change |
|---|---:|---:|---:|---:|
| sample4 1–300 | 6,114 | 5,809 | 5,776 | **−33** |
| sample4 301–600 | 6,312 | 6,261 | 6,272 | +11 |
| sample4 601–900 | 6,030 | 4,090 | 4,454 | **+364** |
| sample4 901+ | 4,411 | 430 | 626 | +196 |
| sample5 1–300 | 5,501 | 5,223 | 5,185 | **−38** |
| sample5 301–600 | 5,909 | 5,909 | 5,909 | 0 |
| sample5 601–900 | 5,660 | 4,102 | 4,457 | **+355** |
| sample5 901+ | 4,252 | 252 | 493 | +241 |

The improvement near bases 600–900 is useful, but better-looking late peaks do not establish additional usable sequence. The app has added no bases, and it makes no QC-pass decision. The early-region losses are a real rounding tradeoff and should be reviewed, particularly around poor primer starts.

### Crest shape and plots

Among isolated Q40+ called peaks, mean width above 80% of the crest height increased from **0.239 to 0.314 base-spacing units** on sample4 and **0.240 to 0.311** on sample5. This supports the intended reduction in narrow spikes. It is a descriptive width statistic, not proof that every peak looks better. Broad/noisy low-Q crests are not scored as successful rounding merely because they span a wide region.

- [High-quality POS1 window near base 300](figures/pos1_rounding.png): illustrates the rounding effect. The window uses a fixed index rule, not an optimized peak selection.
- [POS1 repeated peaks](figures/pos1_resolution.png): incremental change beyond v1.8; still differs from PeakTrace.
- [POS1 GGG region](figures/pos1_insertions.png): no reintroduction of the v1.7 inserted-call artifacts.
- [U0827 repeat region](figures/u0827_resolution.png): the difficult AAAA remains weakly resolved; some shoulders are less distinct after rounding. This issue is not closed.
- [Quality profiles](figures/u0827_quality.png): v1.8 and v1.9 retain the same QVs and early confidence decline.
- [Region summary](figures/region_summary.png): includes the early-region regressions alongside later gains.

Plots use the actual saved AB1 channels. Each panel has its own analyzed-sample coordinates and one common dye normalization. The plots are not a raw-time alignment. v1.9 outputs have not yet received a fresh user assessment in SnapGene/Geneious.

Three sample4 reads have net losses under the all-Q3+ pair metric and deserve explicit review:

| Input file | Net separated-pair change |
|---|---:|
| `U0827P1G8._.XP1660365._.XP1660364-F1._.U0827_H03.ab1` | −5 |
| `U0827P1G8._.XP1660365._.XP1660365-F3._.U0827_H05.ab1` | −8 |
| `U0827PFr1A1._.ZV2650311Frag._.pMON452113-VF._.U0827_B08.ab1` | −3 |

Output names omit the terminal well suffix. No sample-specific correction or special-case fallback was added to hide these regressions.

## Synthetic stress tests

Compared the exact v1.8 resolver and selected v1.9 model on 64 seeded synthetic traces: variable spacing, increasing broadening, unequal amplitudes, baseline, four noise levels and either exact or perturbed position anchors. Each condition contains eight traces and 1,472 true peak centers. Crest matching uses a fixed 15%-of-noiseless-p99 prominence criterion and a four-sample tolerance. These simplified Gaussian simulations do not represent every instrument artifact or mixture.

| Anchor perturbation / noise SD relative to nominal height | v1.8 matched / spurious crests | v1.9 matched / spurious crests |
|---|---:|---:|
| Exact / 0% | 1,426 / 0 | 1,433 / 0 |
| Exact / 2% | 1,425 / 0 | 1,435 / 0 |
| Exact / 5% | 1,428 / 3 | 1,434 / 2 |
| Exact / 10% | 1,435 / 204 | 1,441 / 112 |
| Perturbed / 0% | 1,427 / 0 | 1,433 / 0 |
| Perturbed / 2% | 1,426 / 1 | 1,433 / 1 |
| Perturbed / 5% | 1,428 / 3 | 1,433 / 2 |
| Perturbed / 10% | 1,435 / 218 | 1,438 / 122 |

Perturbations are drawn uniformly from ±1.5 analyzed samples and rounded to integer offsets. Neither resolver produced multiple prominent crests assigned to one center in this experiment. Spurious crests remain at high noise, so the new signal must not automatically be converted into confident calls. Exact inputs, seeds and counts are in `synthetic_stress.json` and `stress_v19.py`.

## Raw-coordinate investigation and the QV gap

The new `raw_mapping.py` diagnostic detects dominant raw peaks in FWO order, aligns their base identities to KB calls, and pairs matching Q30+ calls with measured raw coordinates. It requires distinct monotone anchors and holds out every fifth anchor for interpolation testing. Median error must be at most 0.35 times median raw-anchor spacing, and the 95th-percentile error at most one such spacing. The scale is anchor spacing, which can skip biological bases; it is not a universal samples-per-base constant. Prediction returns unavailable values beyond the accepted anchor span.

| Plate | Internal gate accepted | Rejected | Median of per-read median errors | Median of per-read 95th-percentile errors |
|---|---:|---:|---:|---:|
| sample4 | 75 / 78 | 3, insufficient anchors | 3.09 raw samples | 10.20 raw samples |
| sample5 | 67 / 68 | 1, held-out residual gate | 3.00 raw samples | 10.21 raw samples |

POS1 yields 730 anchors: analyzed coordinates 310–11,919 map to raw 2,244–15,395, with median held-out error 2.69 raw samples. The U0827 F1 diagnostic yields 609 anchors: analyzed 373–10,374 maps to raw 2,068–13,268, with median error 2.91. These have meaningful offsets and nonuniform correspondence; a raw/analyzed length ratio cannot represent them.

This is **progress toward a raw-space caller, not a validated mapping for arbitrary sequence changes**. Held-out anchors test interpolation consistency after sequence alignment; they do not independently prove the alignment, resolve repeat ambiguities, or establish correct tail sequence. The accepted range is mostly anchored by the inherited high-quality region, and extrapolation is prohibited. Full anchor coordinates are stored in the task's `comparison/raw_anchors.json`; Git contains compact diagnostics without the coordinate arrays.

The live app does not invoke this diagnostic. It therefore cannot improve the Geneious QV distribution through it. A proper caller must compare competing peak/base/spacing hypotheses on measured evidence, then calibrate error probabilities against independently validated sequence. Improving a QV-colored display by reassigning scores from peak sharpness or PeakTrace agreement would not establish that capability. Q20/Q30 counts and useful-length claims remain unchanged in v1.9.

## File integrity, tests and reproducibility

**104 unit/integration tests passed.** New tests cover exact legacy-resolver defaults and output parity, rounding without splitting an isolated peak, finite flat/zero behavior, noise restraint, invalid new parameters, nonlinear raw mapping, bad-anchor rejection, no extrapolation, synthetic FWO-aware raw correspondence, and GUI/CLI parameter parity. One initial rounding assertion compared integer width bins and tied; it was replaced by a normalized crest-curvature check that measures the intended sub-sample rounding. The production algorithm was not changed to satisfy that discretization artifact.

Node syntax checks passed for the Electron main process and parameter builder. Python processing used the existing relocated Python 3.11.16 / Biopython 1.88 / NumPy 2.4.6 / SciPy 1.17.1 runtime; system Python generated the figures. No dependencies were installed.

Final CLI runs succeeded on **78/78 and 68/68 reads**, with no skipped or failed files. Recorded times were 64.49 and 56.79 seconds; these runs overlapped, so the times are not a controlled performance comparison with the earlier serial v1.8 timings.

Independent saved-file audits passed all 146 outputs: raw/opaque tags preserved, synchronized call sets, strict in-range positions, valid declared clear-range/export correspondence and input hashes matching provenance. Direct v1.8-versus-v1.9 checks additionally confirmed **identical PBAS, PCON, PLOC and `.seq` bytes for every read**, and identical recorded input hashes. All 146 frozen v1.8 AB1 hashes were rechecked unchanged.

Both final runs record this processing source SHA256:

`a3263ba80c06ba4b32d1ac75a9c964ab5f3dbd7c5e61a2f5411edd6763e6452e`

The existing `PT18` custom tag name is retained as the provenance format; its JSON processor version is **1.9.0-dev** with the new source hash and parameters. The old tag name does not indicate that the old resolver ran. No executable build, packaging, ZIP, version lock, squash or push was performed.

### Commands and artifact locations

From the repository, using a Python environment with the processing requirements:

```powershell
python python-app/peaktrace_core.py --input-dir 'SEQ7_INPUT' --output-dir 'FRESH_6_V19' --no-preprocess
python python-app/experiments/compare_plate.py --input 'SEQ7_INPUT' --reference 'PT_FOLDER_3' --baseline 'V18_FOLDER_5' --candidate 'V19_FOLDER_6' --output 'COMPARISON' --plots --baseline-label '5 - v1.8' --candidate-label '6 - v1.9'
python python-app/experiments/compare_v19_regions.py --input 'SEQ7_INPUT' --baseline 'V18_FOLDER_5' --candidate 'V19_FOLDER_6' --output 'COMPARISON/regions.json'
python python-app/experiments/audit_outputs.py --input 'SEQ7_INPUT' --candidate 'V19_FOLDER_6' --output 'COMPARISON/audit.json'
python python-app/experiments/raw_anchor_audit.py --input 'SEQ7_INPUT' --output 'COMPARISON/raw_anchors.json'
python python-app/experiments/stress_v19.py --output 'synthetic_stress.json'
python -m unittest discover -s python-app/tests
```

Plot generation additionally requires matplotlib. The real-plate comparisons disable filename preprocessing to isolate the signal change. The normal GUI preprocessing option still performs non-mutating naming; it is not required as a second processing stage. Existing output files are rejected, so use a fresh folder when rerunning.

Task artifacts:

- `Peak_Tracer_v1.9_Plan.md` and `Peak_Tracer_v1.9_Results.md` sit beside the task wiki.
- `v1.9_validation/sample4/6-v1.9` and `sample5/6-v1.9` contain the final application outputs and run manifests.
- Each plate's `comparison` folder contains aggregate/per-read metrics, region comparisons, file audits and full raw-anchor diagnostics. Sample4 also contains the six figures.
- `v1.9_validation` contains the execution/test logs and synthetic/development records copied from this work.
- v1.8 outputs remain under `v1.8_validation`. Its `ablation-no-resolution` folder is still only the earlier experimental control.

Repository artifacts under `docs/v1.9` include the initial plan, immutable-baseline manifest, four tuning records, full per-read region measurements, compact raw diagnostics, synthetic results and figures. `python-app/experiments` contains the reproducible scripts. The production changes are in the resolver/configuration and shared advanced defaults; raw mapping is a separately invoked diagnostic.

## What remains from this and the original plan

1. **User review of v1.9 in both viewers.** Inspect the rounding window, U0827 weak repeats, the three net-loss reads, primer starts, mixed/minor peaks and clear-range boundaries. Basic v1.8 opening was confirmed by the user; exhaustive clear-range behavior and v1.9 viewer acceptance remain pending.
2. **Independent sequence truth and calibration data.** Add multiple new plates with validated sequences, known variants, failed reactions, mixtures, repeats and saturation/dye-blob cases. Freeze a genuinely unused holdout. More real plates can test robustness; they do not calibrate QVs unless sequence outcomes are known.
3. **A guarded raw-space caller.** Use the diagnostic mapping as a starting point, validate it more strictly for calling, and compare nonnegative local peak mixtures and competing sequence hypotheses. Evaluate substitutions and indels within the useful span before attempting tail extension. Retain uncertainty or fall back where evidence is insufficient.
4. **Existing-caller evaluation and licensing.** The original plan's assessment of alternative engines has not been completed in v1.9. Benchmark eligible engines on the same independent panel before committing to building the entire caller from scratch.
5. **Empirical QV calibration and useful read length.** Only after independent outcome validation, assign/recalibrate confidence and measure usable length. The 600-versus-900-base cyan-profile gap remains open. Appending an extra noisy tail is not a substitute for this work.
6. **Failure/mixture detection, exhaustive viewer compatibility and portable packaging.** These remain separate gates. Legacy helper cleanup and broader error-handling hardening can accompany that work; old unsupported caller switches remain rejected in the live CLI.

The selected v1.9 settings provide a measured morphology tradeoff worth reviewing, with preserved sequence evidence. They are development defaults, not proven optimal parameters or evidence of commercial basecaller equivalence.
