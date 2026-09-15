# v2.0 native evidence: implementation and experiment record

Date: 15 September 2026. Branch: `dev-peak-tracer`. Continues the direction in
[NEXT_STEPS.md](NEXT_STEPS.md) after removing TraceTuner. v2.0 remains open.

## Outcome and scope

The app now has an optional native signal-evidence diagnostic path. It compares
original and resolved traces, measures sensitivity to processing strength, and
fits competing one-peak/two-peak explanations for isolated same-base pairs.
It does **not** assign new QVs, insert/delete calls, or change resolution behavior.
The default app still uses v1.9 resolution and inherited Seq7 qualities.
This is implemented app code, not just an external plotting experiment, but is
currently exposed only through the CLI `--write-evidence` option.

The scientific result is a useful diagnostic foundation, not proof that we can
replace PeakTrace's caller or quality model. No new biological accuracy claim is
made. TraceTuner is not a dependency and has not been reintroduced.

## Starting plan and what was implemented

| Documented step | Status in this increment |
| --- | --- |
| Per-base native evidence | Implemented competing-dye ratio, local spacing ratio, crest offset, local high-frequency residual proxy and strength sensitivity. Repeat valley contrast and fit residuals are available for modeled pairs. There is no independent fit residual for every base. |
| Synthetic and real-window investigation | Implemented seeded synthetic experiments, a second harder parameter challenge, and diagnostics for both real plates. |
| Competing local hypotheses | Implemented one-versus-two Gaussian fits for isolated double repeats, on original and resolved analyzed signal separately. Longer runs, alternative-dye model fitting and raw-channel forward modeling remain open. |
| Published-method quality calibration | Not implemented. Measurements are not error probabilities. Independent confirmed outcomes and held-out calibration data are still needed. |
| Correct recovery / error-rate evaluation | Synthetic one-versus-two truth is tested. Real biological substitutions, indels and confident-error rates are not established by these samples. PT agreement is not substituted for truth. |

## Diagnostic definitions and boundaries

`peaktrace/evidence.py` subtracts a slow fifth-percentile baseline separately from
each analyzed dye. Per-base features use the **source** call positions and dye
order (`FWO_1`), before any output masking or duplicate-position removal. Both
original and resolved features use that same coordinate system. Index fields are
zero-based source indices; plots also show human-readable one-based call numbers.
Evidence describes floating-point processing channels before AB1 display scaling
and integer serialization. Small plotted differences can arise from quantization.

The competing-dye ratio is the strongest other-dye maximum divided by the called
dye maximum in a local quarter-spacing window. Noise fraction uses a robust
residual from a seven-sample quadratic smoother, divided by the called height.
It is a **shape-sensitive noise proxy**: sharpening itself can change it. Neither
ratio is a posterior error probability. Missing/zero-signal features are null,
not a fabricated quality. Ambiguous calls and neighborhoods with duplicate
positions are explicitly unavailable.

Stability compares the chosen strength with strength minus/plus 0.05, clipped to
the allowed range. At the current default this means 0.75 and 0.85 around 0.80.
It records crest movement, competing-dye ratio changes and dominant-dye switches.
This measures local parameter sensitivity, not reproducibility across instruments
or chemistry. Short reads and disabled resolution do not fabricate a stability
measurement. Extra resolver runs and local feature calculations add runtime.

For an isolated pair, a three-spacing window is fit with one Gaussian or two
Gaussians sharing width but having separate nonnegative amplitudes and bounded
centers. A coarse grid initializes bounded continuous least-squares refinement
of **both** model families. Width bounds are 0.20–1.10 base spacings. The one-peak
center can span -0.25–1.25; double centers lie within ±0.15 of the two source
anchors. The local fifth-percentile background is held fixed. Edge windows,
spacing outside 4–100 scans, flat signal and failed convergence are unavailable.
Width-boundary flags are recorded.

The reported delta is `n*log(SSE_one/SSE_two) - 2*log(n)`, with a numerical SSE
floor. It is a descriptive BIC-style comparison with two additional parameters,
**not** a calibrated significance, Bayes factor, or confidence probability.
Residuals are correlated; real peaks need not be Gaussian; bounded optimization
does not guarantee a global optimum. Neighbor contamination and a fixed baseline
can bias the result. Existing source anchors constrain the hypothesis: this is
not a de novo peak detector and cannot discover arbitrary missing calls.

Only exactly two adjacent identical source calls are modeled. AAA/AAAA and longer
runs are marked as needing a joint model. In particular, this increment does not
claim to fix the original long-A repeat issue. No reference or PT trace is used
to select calls or fit hypotheses.

## Tuning and deviations discovered during testing

The first implementation used the grid alone. In 216 synthetic trials, it falsely
favored two peaks in 17 of 54 symmetric single-peak cases, even after an
illustrative residual/amplitude screen. An off-grid single center/width fitted
poorly enough to give the more flexible double model an artificial advantage.

The correction was continuous bounded refinement of both families, initialized
by the grid. This removed those 17 false preferences on the same test. A targeted
off-grid single-peak regression test now protects this behavior. No QV threshold
was tuned to PT or real-plate labels. Initial grid-only real runs are preserved
as exploratory `8-v2.0-native-evidence` folders; use the final
`9-v2.0-native-evidence-refined` folders instead.

An illustrative screen was fixed before the continuous-fit correction:
delta > 10, double relative RMS < 0.15, and minor/major amplitude ratio > 0.15.
It exists in experiment scripts only. It does not drive app calls, QVs or QC.
Passing is a model-fit observation, not a biological QC pass. A stricter or looser
screen would give different counts.

## Synthetic results

Initial/final development sweep: four families × three widths × three noise
levels × six seeds = 216 trials. After refinement, both stages passed all 54 true
equal-width and all 54 true unequal-width pairs; neither passed any of the 108
single-peak cases. Zero-noise trials repeat across seeds and are not independent
replicates. This clean result prompted a tougher challenge, not deployment.

The second challenge uses new seeds 30–35, widths 0.25/0.38/0.52/0.72 spacings,
noise 1%/4%/12% of the main amplitude, a different single-peak center, stronger
asymmetry, a weaker second peak (35%), and a 2:1 width ratio in unequal pairs.
The screen and fitting code were not retuned after seeing its results.

| Synthetic truth | Trials | Original passes | Resolved passes |
| --- | ---: | ---: | ---: |
| Symmetric single | 72 | 0 | 0 |
| Asymmetric single | 72 | 0 | 0 |
| Equal-width double | 72 | 36 | 54 |
| Unequal-width double | 72 | 36 | 48 |

Resolution lets more true pairs pass in this selected synthetic family. It still
misses 18/72 equal-width and 24/72 unequal-width pairs. Zero observed false pairs
among 144 synthetic single cases is not evidence for Q30 or Q40 accuracy. The
challenge is a held-out parameter sweep, **not** a held-out biological plate.
It lacks many realistic failure modes: dye blobs, saturation, mobility artifacts,
mixed templates and correlated instrument noise. No scores are calibrated from it.

## Real-plate audit

All 146 reads completed: sample4 78/78, sample5 68/68, no skipped reads or errors.
Runs took 494 and 448 seconds respectively while running concurrently on this
laptop; these are not isolated performance benchmarks. The 109-test suite passed.

The independent BioPython audit verified source hashes against the earlier v1.9
provenance, plus exact equality with frozen v1.9 for PBAS/PCON/PLOC sets 1 and 2,
raw DATA1–4, analyzed DATA9–12, P1AM, clear-range tags and SEQ exports. The new
provenance tag differs, so whole AB1 files are not byte-identical. The processor
source hash for all final outputs is
`42f498dea02ebf6a4e7ba5d8a4868e8bcf481c47087e0ce46f7dcbad70653600`
(implementation commit `d6c9da4`).

| Plate | Native/v1.9 Q20 | PT Q20 | Native/v1.9 Q30 | PT Q30 |
| --- | ---: | ---: | ---: | ---: |
| sample4 | 70,268 | 88,736 | 62,874 | 82,221 |
| sample5 | 65,186 | 82,188 | 59,022 | 76,930 |

These counts remain unchanged by native evidence. They are predicted-quality
counts, not verified correctness or comparisons of mean Phred values.

The sidecars contain 172,534 source-call records and 44,889 adjacent same-base
pair records. Of those, 23,831 have successful fits in both stages; 21,054 have
no original fit (including deliberately excluded longer runs), and another four
have an original fit but no successful resolved fit. Consequently this analysis
does not cover all repeats.

At source calls 601–900, median competing-dye ratio changes from 0.236 to 0.077
for sample4 and 0.204 to 0.061 for sample5. This is substantial signal separation,
but the diagnostic itself is affected by resolution and must not be turned
directly into higher confidence. In that span, 6,183/6,362 modeled pairs pass the
screen on original traces and 6,221/6,362 on resolved traces: 54 additions and 16
losses, a net gain of only 38. Most isolated pairs already pass on the input.

Beyond call 900, there are 541 newly passing pairs and 552 lost passes, a net loss
of 11. Stability perturbations switch the dominant dye at 965 of 41,182 measured
tail calls (2.34%), versus 263 of 131,342 measured calls through 900 (0.20%).
These are sensitivity flags, not detected sequencing errors. Tail aggregation
is diagnostic only; no tail extension or improved usable read length is claimed.

Figures: [synthetic challenge](native-evidence/synthetic-challenge.png),
[real pair screen by read position](native-evidence/real-pair-screen.png), and
[real trace examples](native-evidence/real-pair-examples.png). Examples are the
largest valley gains within two explicitly selected categories among source
calls 101–900, not representative averages. “Supported” means passing the
illustrative original-signal screen; it does not mean independently confirmed.
The resolved-only example already has positive original delta but fails another
screen criterion. See [numerical audit](native-evidence/summary.json).

### Which folder to inspect

Under the task folder, final outputs are:

- `v2.0_validation/native_evidence/sample4/9-v2.0-native-evidence-refined`
- `v2.0_validation/native_evidence/sample5/9-v2.0-native-evidence-refined`
- `v2.0_validation/native_evidence/results` contains the numerical experiments,
  audit, logs and figures.

The AB1s are v1.9-equivalent; the new information is in `.evidence.json` files.
The neighboring `8-v2.0-native-evidence` directories are preliminary grid-only
diagnostics and are superseded. Historical `7-v2.0-experimental-qv` TraceTuner
outputs are also not outputs of the current app. No old output was overwritten.

## Reproduction and artifacts

From the project root, use a Python environment with the existing app requirements:

```powershell
python python-app/peaktrace_core.py --input-dir POST_SEQ7_FOLDER --output-dir FRESH_FOLDER --no-preprocess --write-evidence
python python-app/experiments/native_evidence_stress.py --output RESULTS/synthetic-refined.json
python python-app/experiments/native_evidence_stress.py --holdout --output RESULTS/synthetic-holdout.json
python python-app/experiments/summarize_native_evidence.py --task TASK_ROOT --output RESULTS
python python-app/experiments/plot_native_evidence.py --results RESULTS
python -m unittest discover -s python-app/tests
```

The real-plate summary script expects the archived folder layout used here and
asserts file counts, source SHA-256, exported array/SEQ equality against frozen
v1.9, and a single processor source hash. Plotting additionally needs matplotlib.
The tested processing interpreter was the existing packaged-v1.6 Python 3.11
runtime; plotting uses the laptop's Python environment. No engine is downloaded.

Each JSON sidecar contains provenance, summary, per-base rows and repeat-pair rows.
The run manifest links its sidecars and summaries. Existing sidecars are protected
by batch collision checks. Serialization rejects nonfinite JSON values, and
diagnostic failures occur before promoting that read's AB1/SEQ outputs.

## Next actionable development

1. Add residual diagnostics and rejection for neighboring same-dye contamination,
   saturation, baseline misfit and width-boundary fits. Expand stress tests with
   these artifacts before letting any fit alter calls.
2. Build a joint local model of three/four-base repeats, including nearby peaks,
   and compare possible peak counts on original signal. Permit physically
   justified width variation with a complexity penalty; test unequal-width cases.
   Start with the original POS1 and U0827 problem windows, plus synthetic truth.
3. Extend competing-dye evidence into local hypothesis fitting, then incorporate
   raw channels only where coordinate mapping passes existing held-out checks.
   An accepted raw mapping does not itself make raw intensities calibrated.
4. Obtain independently confirmed sequences and read-to-truth mappings, including
   real variants and failed/ambiguous samples. Split by plate and construct before
   calibration. Keep indel/gap errors separate from substitution confidence.
5. Fit and validate a native feature-to-error model on that data. Use reliability
   curves and confident-error counts on untouched holdouts before exporting new
   Phred values. Keep the current source QVs until this is demonstrated.

The supplied sample4/sample5 ZIP inventories contain AB1/SEQ (sample4 also SCF and
`.1` records); they do not contain returned SQD/PDF alignments or an explicit
independent truth-label dataset. The intended design sequence alone would not
prove what a sample actually contains. Other independent records can be added
later; their absence here is not a claim that the company has no such records.

Published grounding: [Phred II](https://doi.org/10.1101/gr.8.3.186) estimates errors
from trace parameters and validates probabilities; [LifeTrace](https://doi.org/10.1101/gr.177901)
distinguishes call quality from gap quality. These motivate empirical calibration
and separate indel evidence. This implementation is an original diagnostic
prototype, not a reproduction of either published caller or its calibration.

No build, packaging, lock, squash, push or claim of PeakTrace replacement is part
of this increment.
