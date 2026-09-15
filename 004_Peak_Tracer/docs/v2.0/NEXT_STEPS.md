# v2.0 continued development: remove TraceTuner and investigate native confidence

Decision: 15 September 2026, continuing from `8e27cac` on `dev-peak-tracer`. Keep v2.0 open and add commits rather than resetting history. The user does not want TraceTuner in the application.

## What the experiment established

TraceTuner increased predicted Q30 counts by about 7.3% across the two plates. It also lowered many early, very high Seq7 QVs. Those changes demonstrate reassessment, not independently established improvement in confidence accuracy. The age of the source does not itself prove the estimates wrong. Applying its existing table to our modified signal has not been independently calibrated.

Peak appearance, correct base recovery and calibrated quality are different outcomes. Sharpening can reveal genuine separation, but can also make noise or incorrect hypotheses look sharper. A replacement scorer must distinguish those cases instead of converting every deeper valley into a higher QV.

## Changes made now

- Remove the TraceTuner runtime adapter, its analysis invocation, CLI options and adapter-specific tests.
- Keep v1.9 resolution/rounding, default base policy and inherited Seq7 QVs. The optional pre-existing low-quality substitution mode remains unchanged.
- Preserve the experiment scripts, engine/source archive, numerical results and saved AB1 outputs as historical evidence. They are not dependencies of the active app. No binaries were bundled into the app.
- Mark the original plan/report as historical and keep the package at `2.0.0-dev`.

Verification: 104 remaining tests passed. The analysis, configuration and resolution modules match the v1.9 checkpoint `7e0931f` exactly after removal. The removed scoring CLI option is rejected explicitly rather than ignored. No full-plate rerun was needed for an unchanged processing path; prior TraceTuner results remain tied to their historical source hash.

## Next investigation, not yet implemented

1. **Create native per-base evidence measurements.** Compare original and resolved signal around each call: competing-dye intensity, spacing irregularity, repeat separation, local noise, fit residual and stability under small changes in processing strength. Keep these as diagnostic features initially, not invented Phred scores.
2. **Test whether apparent improvement is supported.** Use known synthetic peak mixtures and existing difficult real windows to identify cases where resolution adds true separation versus artifacts. Estimate how much each feature merely reflects our own sharpening operation. Restrict initial work to the existing useful span rather than extending poor tails.
3. **Investigate local competing call hypotheses.** For unresolved repeats and uncertain bases, compare one-peak/two-peak and alternative-dye explanations against the original signal. Use raw-channel evidence where a reliable coordinate mapping is available. Do not select the hypothesis by matching the intended reference.
4. **Calibrate a native quality model using a published method.** Select and document the estimator after examining the evidence features. Train the feature-to-error relationship on independently confirmed outcomes; preserve true mutations as correct sequencing calls. Keep a plate/construct-level holdout so related reads do not leak between training and evaluation. Do not copy PT scores or replace TraceTuner with an arbitrary sharpness-to-QV formula.
5. **Compare meaningful outcomes.** Report substitutions and indels, recovered correct sequence, false confident calls and predicted-versus-observed error rates. Retain predicted Q20/Q30 counts as secondary measures. Report failures and regressions, not just aggregate increases.

Steps 1–3 can progress with current samples and synthetic data. A defensible probability calibration needs independent confirmed sequence, including variants and failed/ambiguous cases; the existing PT comparator alone does not supply that. Until then, retain original QVs in exported files and keep new diagnostic measurements separate.

This removal completes a change of direction, not a replacement scorer. GUI exposure of TraceTuner and engine bundling are canceled. No lock, squash, push or packaging is part of this change.
