# Peak Tracer v2.0: quality reassessment results

> Status, 15 September 2026: the report below describes the historical `8e27cac` checkpoint. TraceTuner's adapter and CLI switches have now been removed from the app at the user's request. The `7-v2.0-experimental-qv` files and metrics are preserved experiment results, not outputs reproducible with the current CLI. Use the historical checkpoint to reproduce that integration. Current development retains v1.9 signal processing and Seq7 QVs; v2.0 is not locked. See [NEXT_STEPS.md](NEXT_STEPS.md).

Experiments and implementation completed 9 September 2026; documentation finalized after resuming on 10 September. Starting point: v1.9 `7e0931f`. Plan/evaluation commit: `c35cb78`; implementation: `16c65ac`, on `dev-peak-tracer`. This is a development checkpoint, not a locked or packaged release.

**v2.0 now has a working, opt-in TraceTuner quality reassessment mode.** It changes QVs using the engine's existing 3730 lookup table while preserving v1.9's peaks, base identities and label positions. On the two plates, predicted Q20 counts rise by 1.83% and 2.67%, and Q30 counts by 7.40% and 7.28%. This is progress toward meaningful confidence estimation, not demonstrated improvement in sequence accuracy or equivalence to PeakTrace.

**Default app behavior still retains Seq7 QVs.** New scoring requires `--quality-mode tracetuner` and an explicit executable path. The GUI does not expose this experimental option. The new review folders were generated with that option enabled; they are not the output of an ordinary default GUI run.

## Where to look

Relative to the task folder containing `task_progress.html`:

- `v2.0_validation/sample4/7-v2.0-experimental-qv`: 78 actual app-generated AB1/SEQ pairs.
- `v2.0_validation/sample5/7-v2.0-experimental-qv`: 68 pairs.
- `v1.9_validation/sample4/6-v1.9` and the corresponding sample5 folder: unchanged baselines.
- `v2.0_validation/sample4/comparison` and `sample5/comparison`: audits and graphs.
- `v2.0_validation/experiments`: all six engine conditions, retained PHD outputs, logs, summaries and input hashes. These are research artifacts, not additional workflow steps.
- `v2.0_validation/engine`: the tested executable, corresponding source archive, license and build record. It is not yet bundled into the app.

The plan/report also live beside the wiki as `Peak_Tracer_v2.0_Plan.md` and `Peak_Tracer_v2.0_Results.md`. Repository copies are in `docs/v2.0`.

## Engine and published basis

Phred II describes the empirical relationship between trace features and per-base error probabilities, including validation against independently known sequence. This supplies a published methodological basis; it does not validate an arbitrary new preprocessing pipeline. [Ewing and Green, 1998](https://doi.org/10.1101/gr.8.3.186).

TraceTuner's source provides an existing peak-model/feature/lookup-table implementation. We obtained Debian's `3.0.6~beta+dfsg` source archive and compiled it without changing its C source, using portable Zig 0.14.1 targeting Windows x86-64 GNU C. No system-wide compiler installation was needed. The archive's internal version banner is **TT_3.0.4beta**, despite its distribution name; both identities are recorded rather than silently treating the banner as 3.0.6. [Upstream project](https://sourceforge.net/projects/tracetuner/), [Debian source archive](https://deb.debian.org/debian/pool/main/t/tracetuner/tracetuner_3.0.6~beta+dfsg.orig.tar.xz).

An important bibliographic distinction: the source README cites Denisov, Arehart and Curtin (2004) as **US Patent 6681186**, and says a journal publication was in preparation. This report does not claim that citation is a peer-reviewed TraceTuner paper. The implementation and table are publicly available; Phred and LifeTrace have separate journal descriptions.

The source headers and Debian copyright record identify GPL-2.0-or-later terms. The archived engine includes its corresponding source and license. This development change does not resolve the eventual application's complete distribution arrangement; the packaging handoff must retain the engine's applicable notices and source obligations.

| Artifact | SHA-256 |
|---|---|
| TraceTuner source archive | `24190cef98d7f6faaac35306c496d8fe16d72991da89d25cc589dcd5619938e0` |
| Tested Windows executable | `7a9d0fda67ef98d808a36b4701d52c8ddd202adf9a4bcd159a761a3172e867b5` |
| Zig 0.14.1 Python-distributed compiler archive | `e4f7e089a44d5ce34181853a90cdb8456e63c6640f5d44b844a117055326c375` |
| App processing source | `02b760eb97bd641063d2623b5b193fb883aeafd5663755c26a07590435b1e13a` |

The first SourceForge download returned HTML, not an archive; it was not executed. Debian supplied the usable source. The official Zig download initially stalled, so the compiler used for the build came from its Python distribution; the official download later completed too. Neither download altered the system Python environment. Compiler warnings in the old C source are retained in the build log, including floating-point arguments to integer `abs`; no untested numerical fixes were folded into this experiment.

## What changed from the initial plan

The initial suggestion that `-nocall` could directly reassess existing QVs was incorrect for these files. Source inspection found that it bypasses quality computation when a QV array exists, and all 292 Seq7/v1.9 control runs reproduced input qualities exactly. Removing PCON is not a reliable fix because the reader allocates a quality array. We did not patch this control flow to force a new algorithmic path.

Instead, the integrated mode uses **`-3730 -recalln -p`**. The engine recalculates quality while retaining existing A/C/G/T calls and call count, but may infer replacements for Ns and adjust peak positions internally. Our adapter verifies count and A/C/G/T identity, rejects invalid outputs, restores ambiguous input calls with Q0, and retains the original displayed PLOC labels. Its fitted positions are recorded as diagnostics, not exported as new labels. This is quality reassessment attached to the same ordered base calls, not adoption of a new basecaller.

TraceTuner sometimes assigns the same fitted location to adjacent calls: the enhanced-input N-recalling experiments contained 11 such non-increasing pairs on sample4 and four on sample5. These do not become duplicate exported labels. Decreasing or out-of-bounds fitted positions are rejected; equal fitted positions are recorded. Exported positions remain the strict v1.9 positions.

The app masks original Q0–2 calls to N before reassessment, matching v1.9's base policy. It does not rescue those Ns or apply a second new-QV masking step. The Q0 assignment to ambiguous bases is our conservative policy; all retained A/C/G/T QVs come from the engine. Quality-based clear ranges and `.seq` lengths are recomputed from the new QVs, so sequence exports may change length even though full AB1 call sequences do not.

## Experiments and selection

The pilot used 10 deterministic sample4 reads: every eighth sorted filename, with POS1 and the requested U0827/ZV270402-F1 diagnostic included. The same six conditions were then run on all 78 sample4 and 68 sample5 reads, without parameter tuning between plates:

1. Seq7 / `-nocall` control.
2. Seq7 / `-recalln`.
3. Seq7 / full recalling.
4. v1.9 / `-nocall` control.
5. v1.9 / `-recalln`.
6. v1.9 / full recalling.

All **876 full-plate engine runs** produced PHD output; the earlier pilot added 60 runs. Sample5 is replication, not a previously unseen biological holdout. No QV table was fitted, no parameter sweep was performed, and no PT sequence or QV was supplied to processing.

| Condition | sample4 Q20 / Q30 | sample5 Q20 / Q30 |
|---|---:|---:|
| Seq7 / v1.9 inherited QVs | 70,268 / 62,874 | 65,186 / 59,022 |
| TraceTuner on Seq7, N-only recalling | 68,183 / 64,442 | 63,964 / 60,740 |
| TraceTuner on Seq7, full recalling | 70,845 / 65,794 | 66,665 / 62,203 |
| TraceTuner on v1.9, N-only recalling | 71,560 / 67,525 | 66,927 / 63,321 |
| TraceTuner on v1.9, full recalling | 73,060 / 68,072 | 68,051 / 63,816 |
| **Integrated v2.0, ambiguous bases restored to Q0** | **71,552 / 67,524** | **66,925 / 63,321** |
| PeakTrace comparator | 88,736 / 82,221 | 82,188 / 76,930 |

The small differences between direct N-recalling and integrated results come from refusing to adopt inferred N replacements as confident bases. TraceTuner on unenhanced Seq7 does not automatically increase Q20 counts; the enhanced trace has a measurable effect on its estimates.

Full recalling was not integrated. On enhanced traces it increased total calls from 91,756 to 100,523 on sample4 and from 80,776 to 87,138 on sample5. Whole-read alignments against PT reported 6,017 and 5,156 internal query insertion bases, versus 1,203 and 938 for v1.9. These are alignment-dependent comparator differences, including unreliable tails, not proven biological errors, but they do not justify enabling full recalling. Three non-increasing fitted-position pairs also occurred in sample5 full-recalling output.

## Integrated results and regressions

The integrated app completed **78/78 and 68/68**, with no skipped or errored files. Measured run times were 55.48 and 45.23 seconds in this environment, not a controlled speed benchmark.

| Measure | sample4 | sample5 |
|---|---:|---:|
| Added predicted Q20 bases | +1,284 (+1.83%) | +1,739 (+2.67%) |
| Added predicted Q30 bases | +4,650 (+7.40%) | +4,299 (+7.28%) |
| Reads gaining / losing Q20 bases | 63 / 15 | 62 / 6 |
| Individual QVs increased / decreased | 26,070 / 63,956 | 21,698 / 57,907 |
| Full AB1 bases | 91,756, unchanged | 80,776, unchanged |
| Ns | 1,487, unchanged | 1,300, unchanged |

Many early KB scores near Q50–60 become approximately Q35–40; some later scores rise into that range. Therefore a lower mean QV or a different viewer color is expected despite more Q30 bases. No multiplier or minimum-Q floor was used to imitate PT's cyan display.

On fixed v1.9 base indices 601–900, Q30 counts increase from **18,282 to 20,971** on sample4 and **17,859 to 19,598** on sample5. At indices 901–1200 they increase from **1,768 to 3,950** and **2,194 to 4,953**. Early indices 1–300 lose 329 and 204 Q30 bases. These are confidence changes over existing calls, not additional recovered sequence.

The largest Q20 losses deserve viewer review:

| File | Q20 change |
|---|---:|
| sample4 `U0827P1G8._.XP1660365._.XP1660364-F2._.U0827.ab1` | -38 |
| sample4 `U0827P1G8._.XP1660365._.XP1660364-F1._.U0827.ab1` | -36 |
| sample4 `U0827P1H8._.XP1660365._.XP1660364-F1._.U0827.ab1` | -26 |
| sample5 `U0828P1E12._.ZF1680446._.ZP2680450-F1._.U0831-2.ab1` | -45 |
| sample5 `U0828P1F12._.ZF1680446._.ZP2680450-F1._.U0831-2.ab1` | -35 |
| sample5 `U0828P1H9._.XP1660364._.XP1660364-F1._.U0831-2.ab1` | -6 |

No per-file fallback or special-case tuning hides these decreases. Lower scores may be more appropriate; without independent truth we cannot classify every decrease as a scoring regression.

## Graphs and independent checks

- [U0827 QV profile](figures/u0827_quality.png): confidence remains around Q30–40 later, but PT still reaches farther.
- [POS1 QV profile](figures/pos1_quality.png): a smaller extension of the predicted high-confidence span.
- [sample4 confidence by region](figures/sample4_quality_regions.png).
- [sample5 confidence by region](figures/sample5_quality_regions.png).

All four graphs were visually inspected. PT is plotted on its own base indices, not a shared biological coordinate alignment. Region denominators differ where PT has different calls/read length. No new peak-shape figure is needed to imply improvement: **all serialized DATA9–12 values match v1.9 exactly**.

An independent BioPython audit verified all 146 saved files: identical v1.9 signal, base identities and label positions; synchronized PBAS/PCON/PLOC sets; preserved raw and opaque tags except the documented QV/clear-range/provenance changes; strict exported positions; source hashes; source-version identifiers; Q0 ambiguous calls; clear-range and sequence-export consistency. All 292 Seq7/input and frozen-v1.9 hashes were rechecked unchanged.

Black-box controls on POS1 confirmed that changing raw DATA1–4 to zero leaves N-recalling results unchanged; replacing input PCON with Q42 also leaves results unchanged; all 24 FWO permutations with correspondingly permuted analyzed channels give identical results. Zeroing DATA9–12 produces no PHD. The latter case returned process status zero, confirming why the adapter checks output existence/content as well as exit status. Thus this mode genuinely reads the enhanced analyzed signal and does not copy input QVs.

The regression suite passed **108 tests**, including malformed PHD, missing output, count/identity mismatch, invalid positions, subprocess failure/timeout, chemistry metadata, input preservation, ambiguous-call policy and configuration validation. Full-plate audits exercise real engine output beyond those mocked process-contract tests. Fresh SnapGene/Geneious assessment, GUI exposure and packaging remain pending.

## What the PT comparison does and does not establish

On aligned, unambiguous positions where PT itself has Q30+, the integrated Q30+ calls had zero substitution disagreements in 67,051 comparisons on sample4 and 62,850 on sample5. Original v1.9 Q30+ calls also had zero in their smaller compared populations. This supports further evaluation; it **does not calibrate Q30**. The comparison excludes indels and ambiguous calls, selects on PT confidence, and shares the underlying acquisition with PT. It is not independent sequencing truth.

At integrated Q20–29 there was one substitution disagreement per plate. At Q10–19 there were 72/6,636 and 65/5,372 disagreements; many previously lower-score disagreements have moved into this band. Complete bins and denominators are preserved in the audit JSON. Do not interpret these filtered disagreement rates as the actual error probabilities.

No reference-derived calibration was attempted. An intended construct sequence alone cannot distinguish a true mutation from a sequencing error. A future calibration panel needs independently confirmed sequences or well-supported independent consensus, with true variants represented and an unused holdout.

## Reproduction and code handoff

From the repository directory, using Python with the existing NumPy/SciPy/BioPython dependencies:

```powershell
python python-app/peaktrace_core.py --input-dir 'SEQ7_INPUT' --output-dir 'FRESH_OUTPUT' --quality-mode tracetuner --tracetuner-executable 'PATH_TO_TTUNER.exe'
python -m unittest discover -s python-app/tests
```

The tested runtime was the task's `analysis_v1.7/packaged_v1.6/runtime/Scripts/python.exe`. Plotting/audits used system Python with BioPython, NumPy and Matplotlib. Engine compilation can be repeated with `python-app/scripts/build_tracetuner.ps1`, passing the extracted source directory, Zig executable and desired output path. The build record identifies archives and hashes; no arbitrary prebuilt engine was substituted.

`evaluate_v20.py --task TASK --engine ENGINE --output OUTPUT --all --plate sample4` reproduces the six conditions; repeat with sample5. `summarize_v20.py` accepts the result JSON and paired PT directory. `audit_v20.py --task TASK --plate sample4 --output OUTPUT` audits the integrated folder and plots its saved files. `probe_tracetuner.py` reproduces the channel/QV controls. Engine PHD hashes include timestamped headers; numeric output comparisons use parsed calls/qualities/positions rather than expecting timestamped files to have identical hashes.

The adapter is `python-app/peaktrace/quality.py`; `analysis.py` invokes it only after the v1.9 base policy, and `config.py` validates explicit activation, executable and timeout. No C scoring changes, table fitting, resolution tuning, new tail calls, reference-guided corrections or automatic QC-pass decisions were introduced.

## Plan accounting and next steps

All six planned stages are complete at the experimental-development level: engine/source assessment, pilot, two-plate comparison, conditional integration, testing/auditing and documentation. Deviations are explicit: `-nocall` became a control rather than a rescoring mode; the unmodified `-recalln` path supplies per-call estimates; its N replacements and fitted labels are not adopted; full recalling remains evaluation-only. The limited adapter preserves existing calls so it cannot close PT's missing-base/read-length gap.

Recommended next work is to review these experimental AB1s in both viewers, particularly the named loss cases and the 600–1000-base interval; assemble independent sequence truth across additional plates and variants; measure confidence calibration and useful sequence accuracy on an unused holdout; and separately investigate the full caller's excessive low-quality calls and position defects. Keep `retain` as default until that evidence justifies a change. Raw-space modeling, mixed/failed reactions, unresolved difficult repeats and portable packaging remain open from the earlier plans.
