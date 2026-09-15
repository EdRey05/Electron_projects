# v2.0 plan: evaluate an established Sanger quality estimator

> Status, 15 September 2026: this is the original experiment plan. TraceTuner was subsequently removed from the application at the user's request. v2.0 remains open; see [NEXT_STEPS.md](NEXT_STEPS.md) for the current direction. The experiment and its outputs remain historical evidence.

Starting checkpoint: `7e0931f` on `dev-peak-tracer` (v1.9). Scope: CLI experiments and conditional integration; no version lock, push or executable packaging. Preserve all previous input/output evidence.

## Scientific basis

Phred II describes empirically calibrated trace-feature scoring: https://doi.org/10.1101/gr.8.3.186 . TraceTuner supplies an existing implementation and an ABI 3730 POP7 lookup table, with a no-recalling mode: https://sourceforge.net/projects/tracetuner/ and https://manpages.ubuntu.com/manpages/jammy/man1/ttuner.1.html . Publication provides a defensible starting method, not automatic calibration after our resolution processing.

## Ordered work and decision gates

1. Obtain and inspect TraceTuner source, license, executable availability and build requirements. Record source hashes, exact version and any portability edits. Inspect which ABIF channels/calls it reads and whether preprocessing changes its coordinate system.
2. Freeze input/v1.9 file identities. Start with deterministic sample4 reads including POS1 and U0827; compare Seq7 versus v1.9 enhanced traces using original-call scoring and full recalling. Use the built-in 3730 table only after confirming the sample chemistry. Record engine failures and every changed call/coordinate contract.
3. Extend workable experiments to both plates without tuning on sample5. Report Q20/Q30 counts, quality by position, calls/indels and agreement with PT as comparator evidence, not independent accuracy. When reference sequences are available, separate intended-reference differences from independently proven sequencing errors. Do not fit quality scores to PT colors or to intended-reference agreement.
4. If technically sound, integrate explicit opt-in experimental scoring through a subprocess adapter with timeout, strict output validation, original-file preservation and complete provenance. Keep default retained-QV behavior until performance supports changing it. Unsupported results must fail explicitly, never silently masquerade as recalculated scores. Full recalling may remain experimental-only if coordinate/export contracts cannot be validated.
5. Test malformed outputs, failed/time-limited engine execution, missing executable, base/position/QV alignment, original-call preservation and synchronized AB1/SEQ/clear-range output. Run existing regression tests. Plot the actual results including regressions and unchanged regions.
6. Write RESULTS.md with actual commands, artifacts, metrics, deviations, implementation decision and remaining independent-calibration requirements. Mirror plan/report beside task_progress.html. Commit coherent work stages on the existing branch.

## Success criterion

A reproducible evaluation and honest integration decision. Increased quality values alone are not success: the experiment must establish what the engine scored and whether predicted confidence is supported. A useful opt-in research implementation can precede a validated default. Raw-space calling, mixture detection and portable packaging remain separate work unless directly needed for this evaluation.
