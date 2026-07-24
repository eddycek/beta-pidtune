# Tuning Algorithms Audit & Improvement Roadmap

> **Status**: Active

Deep audit of FPVPIDlab's tuning algorithms (July 2026): DSP correctness review of `src/main/analysis/`, knowledge-base/apply/verification flow review, and a market benchmark against state-of-the-art tools (PIDtoolbox PRO v0.74, Plasmatree PID-Analyzer, Betaflight Blackbox Explorer 2025.12, FPVtune). Produces a phased roadmap toward being the best FPV tuning tool on the market.

**Implementation status (July 2026)**: Phase 0 (P0.1) and all of Phase 1 (P1.1–P1.9) are ✅ implemented — calibrated v2 power spectrum with all dB thresholds recalibrated (`SPECTRUM_SCALE_VERSION = 2`), robust peak detection, size-aware frame-resonance bands, coherence computation + TF rule gating, quick-win batch, contiguity-safe throttle-binned FFT/TF, clean-segment prop-wash baseline, yaw coverage, and extended apply verification. Phases 2 and 3 remain proposed.

**Overall assessment**: the architecture is solid and above average — convergent absolute-target filter recommendations, notch-aware resonance handling, quad-size bounds, second-flight verification with similarity matching, convergence detection, data quality scoring with confidence downgrades, and a knowledge base enforced as source of truth. The code faithfully implements the documented rules. However, the DSP core has correctness gaps and methodology shortfalls that SOTA tools handle better — chiefly step response without deconvolution/stacking, uncalibrated "PSD", dead coherence plumbing, and missing Betaflight 4.5/4.6 coverage.

---

## Part 1 — Audit Findings

### A. DSP correctness (`src/main/analysis/`)

| # | Finding | Where | Impact |
|---|---------|-------|--------|
| A1 | **Amplitude-domain spectrum averaging** — `computePowerSpectrum` and `averageSpectra` average `10^(dB/20)` (amplitude), not `10^(dB/10)` (power); no window-energy normalization, no detrending. The "PSD" is an uncalibrated relative measure; all dB thresholds in `constants.ts` are calibrated to this specific pipeline, not to physical PSD. | `FFTCompute.ts:129`, `NoiseAnalyzer.ts:238` | All absolute dB comparisons (size-aware noise levels, LPF2 disable thresholds, dynamic-LPF triggers) are pipeline-relative; cross-tool comparison impossible |
| A2 | **Naive peak detection** — local-max vs immediate neighbors only; strict `>` misses plateau peaks entirely; no minimum peak spacing (broad humps register as many peaks); no parabolic interpolation (frequencies quantized to ~2 Hz bins); local floor fixed ±50 bins. | `NoiseAnalyzer.ts:84-116` | Missed/duplicated peaks feed resonance and notch rules |
| A3 | **Frame-resonance band hardcoded 80–200 Hz** regardless of quad size. A 2.5"/3" frame resonating at 250–350 Hz is classified `electrical`/`unknown`, never `frame_resonance`. | `constants.ts:102-103`, `NoiseAnalyzer.classifyPeak` | Wrong classification → wrong filter rules for small quads |
| A4 | **Motor-harmonic classification ignores throttle/RPM** — equal-spacing heuristic on a whole-flight averaged spectrum, where harmonics smear across RPM. `ThrottleSpectrogramAnalyzer` computes the throttle-resolved view but never cross-informs `classifyPeak`. | `NoiseAnalyzer.ts:155-186` | Frame resonances near harmonic multiples misclassified as motor noise and vice versa |
| A5 | **Non-contiguous samples FFT'd as contiguous** — throttle-binned gathers concatenate samples across discontinuous time regions before FFT, introducing edge artifacts inside windows. | `ThrottleSpectrogramAnalyzer.ts:69-75`, `ThrottleTFAnalyzer` | Spectral leakage in throttle-band views used by dynamic-LPF logic |
| A6 | **Step response: direct per-step measurement, no deconvolution/stacking** — each step is measured in the time domain and arithmetic-mean aggregated. Plasmatree/PIDtoolbox use Wiener deconvolution — which the app already has in `TransferFunctionEstimator.ts` (Flash Tune path) but does not use for PID Tune. No input-magnitude split (<500 vs >500 deg/s, the FF/D-setpoint transition PIDtoolbox respects). Steady-state = mean of last 20% of window is unreliable when the pilot doesn't hold; SSE denominator inconsistent with the other metrics. | `StepMetrics.ts:33-266`, `StepDetector.ts` | Noisier metrics than SOTA; P/D rules fire on noisy means |
| A7 | **Coherence is dead** — declared in `DataQualityScorer.WienerQualityInput` but never computed/passed by `PIDAnalyzer.extractViaWiener`; axis-coverage sub-score is a constant 50 and low-coherence warnings never fire. | `DataQualityScorer.ts:265-266`, `PIDAnalyzer.ts:224` | Flash Tune quality gating partially inert |
| A8 | **TF margins from closed-loop response with silent caps** — gain/phase margins computed on the closed-loop (FF-contaminated) Bode; when no crossing is found, capped values 60 dB/90° silently feed "stable" downstream. `ThrottleTFAnalyzer` analyzes roll only. | `TransferFunctionEstimator.ts:396-433`, `ThrottleTFAnalyzer.ts:137-144` | Overconfident TF-derived recommendations; pitch TPA asymmetry invisible |
| A9 | **Size-independent magic numbers** — `computeNoiseBasedTarget` anchors -10/-70 dB drive the main filter cutoff for all sizes (noise *classification* is size-aware, the target math is not); LPF2 enable values 250/150 Hz underived; group-delay reference fixed 80 Hz; prop-wash band 20–90 Hz and D-term band 20–150 Hz size-agnostic. | `FilterRecommender.ts:112-123, 851, 864` | Suboptimal cutoffs at the size extremes (1"–3", 7") |
| A10 | **Prop-wash severity baseline biased** — event energy is divided by whole-flight 20–90 Hz energy, which itself includes prop-wash and maneuver energy → severity compressed for aggressive flights. D-term "effectiveness" (D-energy/error-energy ratio) has an arguable interpretation direction: high ratio may mean D is amplifying noise, yet it gates D increases as "headroom". | `PropWashDetector.ts:219-222`, `DTermAnalyzer.ts` | Under-detected prop wash on aggressive logs; D gating built on a shaky metric |
| A11 | **Assorted** — `normalizeThrottle` triplicated in 3 files with heuristic format detection; yaw excluded from noise/steadiness/damping analysis; `FeedforwardAnalyzer` hardcodes maxStickRate 670 deg/s instead of reading the rate profile from the BBL header. | `SegmentSelector.ts:119-134`, `FeedforwardAnalyzer.ts:78` | Drift risk; yaw issues under-detected; FF small/large-step split wrong for non-default rates |

### B. Betaflight 4.5/4.6 coverage

- **No version-conditional logic in recommenders.** The only version branch is `headerValidation.ts:25-91` (DEBUG_GYRO_SCALED removal in ≥4.6). Unhandled: `d_min`→`d`/`d_max` rename (4.6, advisory-only via `applyDMinAdvisory`), anti-gravity scale change (4.3 vs 4.5), dimmable RPM weights (4.5+), low-throttle TPA — `tpa_low_*` exists in `BF_SETTING_RANGES` (`tuningHandlers.ts:183`) but is **never emitted** by any recommender.
- **Untouched settings a best-in-class tool should reason about**: `rpm_filter_harmonics`/`rpm_filter_weights`/`rpm_filter_min_hz`/`rpm_filter_fade_range_hz` (only `rpm_filter_q` is recommended), `gyro_lpf1_dyn_expo` (only the D-term counterpart is), `feedforward_transition` and per-axis FF weights, `anti_gravity_cutoff_hz`/`anti_gravity_p_gain`, simplified tuning sliders (`SliderMapper.ts` is display-only; recommendations are never expressed as slider moves), `iterm_relax_type`, per-axis `d_min` values and `d_min_advance`.
- **Applied-but-never-verified settings** — `FF_CLI_ONLY` in `verifyAppliedConfig.ts:99-114` skips read-back for `tpa_*`, `anti_gravity_gain`, `thrust_linear`, `dyn_idle_min_rpm`, `pidsum_limit*`, `vbat_sag_compensation`, `simplified_dmax_gain`, `dterm_lpf1_dyn_expo` — even though several have MSP_PID_ADVANCED offsets in `mspLayouts.ts` that are simply not parsed by `getFeedforwardConfiguration()`.
- **`simplified_dmax_gain=0` is auto-applied for ≤5"** (`PIDRecommender.ts:~1201`, no `informational` flag) — it silently turns off a simplified-tuning slider, unlike the ≥6" branch which is advisory.

### C. Market benchmark (2026)

| Tool | Method | Strengths | Weaknesses |
|------|--------|-----------|------------|
| PIDtoolbox PRO v0.74 | Deconvolved step response split by input magnitude (<500/>500 deg/s); throttle×freq heatmaps with RPM/dyn-notch filter lines overlaid; filter delay estimation | Reference analysis suite; BF 4.6-ready | MATLAB; paywalled (Patreon) since May 2024; analysis only, no recommendations |
| Plasmatree PID-Analyzer | Wiener deconvolution step response (2 s Hanning windows) | Transparent, free, de-facto standard method | Unmaintained; no modern BF awareness; no spectral heatmaps |
| Blackbox Explorer 2025.12 | Interactive viewer + PSD curves, PSD export/import comparison, true dynamic filter curves (throttle+expo) drawn on spectrum | Official, free, PWA | Viewer only — no recommendations, no workflow |
| FPVtune | 28-feature FFNN (step-response + FFT + prop-wash features → 18 outputs), ONNX in-browser | Fast, automated, covers PID+filters+FF | Black box, no explainability; ~$9.90/analysis; unverifiable claims |

**Missing table stakes in FPVPIDlab**: deconvolved step response with magnitude split (A6); calibrated Welch PSD in dB (A1); filter response curves overlaid on spectrum/spectrogram; before/after PSD + step overlay comparison (history data already stored, no UI); recommendations expressed as simplified-slider moves.

**Differentiators nobody on the market has** (FPVPIDlab is uniquely positioned — it owns the full loop: analyze → recommend → apply → verify):
1. Setpoint↔gyro **coherence plots** (trustworthy-band shading).
2. **System identification + what-if simulation** — predict the step response of proposed gains *before* the pilot re-flies.
3. **Filter placement optimizer** — fit LPF/notch/RPM-harmonic set to measured peaks, minimizing group delay subject to attenuation targets.
4. **Mechanical fault detection** (bent prop, bearing wear) from per-motor order analysis.
5. **Explainable recommendations** — every rule annotated on the plot that triggered it (direct counter to FPVtune's black box).

---

## Part 2 — Improvement Roadmap

### Governing principle: recalibrate each measurement scale exactly once

Two orthogonal threshold families exist:

- **dB-scale thresholds** (`NOISE_LEVEL_BY_SIZE`, noise-target anchors, LPF2 disable thresholds, dynamic-LPF enable/disable deltas, peak prominence, prop-wash severity) — all shift when FFT averaging moves from amplitude to power domain.
- **Time-domain thresholds** (rise time, overshoot, settling, damping ratio) — shift when step response moves from per-step measurement to deconvolved/stacked response.

Therefore: **all dB-domain fixes land behind one recalibration event (P1.1); the step-response method change is the single time-domain recalibration event (P2.1).** Everything consuming a scale lands after its recalibration. Nothing gets recalibrated twice. Both recalibration PRs must update `docs/PID_TUNING_KNOWLEDGE.md`, `TESTING.md`, and pass the `/tuning-advisor` audit in the same PR.

### Phase 0 — Regression safety net (prerequisite, 1 PR)

| ID | Item | Effort | Risk |
|----|------|--------|------|
| P0.1 ✅ | **Golden-output harness** — test running the full FilterAnalyzer + PIDAnalyzer + TransferFunctionEstimator pipelines over demo-generator BBLs and real-log fixtures; snapshots recommendations (setting/value/ruleId/confidence), noise floors, peak lists, and step metrics into JSON fixtures. Every subsequent PR diffs against these; fixtures are regenerated only in the two recalibration PRs. New `src/main/analysis/goldenOutputs.test.ts`. Extend the demo generator with known-amplitude injected sines so absolute calibration is testable. | S | Low |

### Phase 1 — DSP correctness + quick wins (one PR per item)

| ID | Item | Fixes | Effort | Risk | Depends on |
|----|------|-------|--------|------|-----------|
| P1.1 ✅ | **Calibrated Welch PSD** — detrend segments, average in power domain, normalize by window energy and sample rate → true one-sided PSD in `FFTCompute.ts`. Recalibrate every dB threshold in the same PR (`constants.ts`, `FilterRecommender`, `MechanicalHealthChecker`, `PropWashDetector`, `DTermAnalyzer`, `DynamicLowpassRecommender`; relative dB deltas roughly double in power domain, absolute floors re-anchored via golden logs). Validate: injected sine of known amplitude matches theoretical PSD; golden diff shows unchanged recommendation *directions*. | A1 | M | **High** | P0.1 |
| P1.2 ✅ | **Robust peak detection** — prominence-based with plateau handling (centroid of flat tops), ~15–20 Hz minimum spacing, parabolic interpolation for sub-bin frequency, median-band local floor. Validate with synthetic spectra (close peaks, plateaus, between-bin peaks). | A2 | M | Medium | P1.1 |
| P1.3 ✅ | **Size-aware frame-resonance bands** — `Record<DroneSize, {min, max}>` (e.g. 7": 60–150, 5": 80–200, 3": 120–280, 2.5"/1": 150–350 Hz) threaded into `classifyPeak`. | A3 | S | Low | P1.2 |
| P1.4 ✅ | **Coherence** — compute γ²(f) = |S_xy|²/(S_xx·S_yy) in `TransferFunctionEstimator` (cross/auto spectra already exist), pass per-axis mean from `PIDAnalyzer.extractViaWiener` into `DataQualityScorer` (dormant tests come alive); gate TF-derived rules (TF-1..TF-4) on coherence ≥ ~0.5 in-band. | A7, partially A8 | M | Low | P0.1 |
| P1.5 ✅ | **Quick-win batch** — (a) dedupe `normalizeThrottle` into `src/shared/utils/`; (b) derive maxStickRate from the BBL rate profile, fallback 670; (c) mark ≤5" `simplified_dmax_gain=0` recommendation `informational: true`; (d) TF margins return `crossingFound: false` instead of silent 60/90 caps, consumers downgrade confidence. | A11, B, A8 | S | Low | P0.1 |
| P1.6 ✅ | **Contiguity-safe throttle-binned FFT** — collect whole FFT windows lying entirely within contiguous runs of a throttle band; average per-window PSDs; bands with too few windows report insufficient data. | A5 | M | Medium | P1.1 |
| P1.7 ✅ | **Prop-wash baseline fix** — compute the 20–90 Hz baseline from clean (hover/cruise) segments exposed by `SegmentSelector` instead of the whole flight; verify severity-tier ratios against golden logs. | A10 | M | Medium | P1.1 |
| P1.8 ✅ | **Yaw coverage** — include yaw in noise and steadiness analysis with yaw-specific expectations (no D rules; damping-ratio validation stays roll/pitch-only by design, documented in KB). | A11 | M | Medium | P1.1 |
| P1.9 ✅ | **Verify-applied coverage** — parse the MSP_PID_ADVANCED offsets already present in `mspLayouts.ts` (tpa, anti-gravity, thrust_linear, dyn_idle, pidsum, vbat_sag, simplified_dmax_gain, dterm dyn expo) and remove them from `FF_CLI_ONLY` so applied values are actually verified. | B | M | Low | — |

**Phase 1 exit criteria**: golden outputs stable across reruns; calibration unit tests green; `/tuning-advisor` audit passed; real-log recommendation directions unchanged vs pre-Phase-1. ✅ **Phase 0 and Phase 1 complete** — golden fixtures live in `src/main/analysis/__fixtures__/golden/` (regenerate via `UPDATE_GOLDEN=1`).

### Phase 2 — SOTA parity

| ID | Item | Effort | Risk | Depends on |
|----|------|--------|------|-----------|
| P2.1 | **Deconvolved step response for PID Tune** — make the Wiener/stacked step response (code already in the Flash Tune path) the primary source of rise/overshoot/settling, **split by input magnitude <500 / >500 deg/s** (à la PIDtoolbox); keep the per-step path as cross-check and latency source, disagreement lowers confidence. Recalibrate all time-domain thresholds in the same PR. Validate against the demo generator's known second-order plant (recovered ζ and rise time must match analytic values). ✅ Implemented (`StepResponseStacker.ts`, `DECONV_THRESHOLD_SCALE`) | L | **High** | P1.4 |
| P2.2 | **RPM/throttle-aware harmonic classification** — regress each peak's per-throttle-band frequency against throttle: tracks-throttle → motor harmonic (order from ratio to fundamental track); stationary → frame resonance/electrical. Equal-spacing heuristic kept as fallback. ✅ Implemented (`reclassifyPeaksWithThrottle()` in NoiseAnalyzer) | M | Medium | P1.2, P1.6 |
| P2.3 | **Filter response curves overlaid on PSD/spectrogram** — magnitude-response models (PT1, biquad, notch; dynamic LPF evaluated at actual throttle incl. expo) rendered over the noise spectrum and throttle×freq spectrogram. Parity with Blackbox Explorer 2025.12. ✅ Implemented (`src/shared/utils/filterResponse.ts`, overlays in SpectrumChart + ThrottleSpectrogramChart) | M | Low | P1.1 |
| P2.4 | **Before/after comparison view** — overlay previous-session compact PSD (128-bin) and step metrics from `TuningHistoryManager` against current analysis with delta annotations. Storage already exists; renderer-only work. ✅ Implemented (`PreviousSessionComparison` in Filter/PID analysis steps, cross-scale + cross-method guards) | M | Low | — |
| P2.5 | **BF version-capabilities layer** (2–3 PRs) — `bfVersionCapabilities.ts` (version → setting names/availability/defaults); d_min→d_max rename mapping across recommend/apply/verify; emit `tpa_low_*`, anti-gravity cutoff/p_gain, dimmable RPM weights; bidirectional `SliderMapper` so recommendations can be expressed as slider moves when simplified tuning is on. ✅ Core implemented (`src/shared/utils/bfVersionCapabilities.ts`: version parsing incl. calendar 2025.12, capability gates, d_min→d_max CLI translation in the apply flow; P-TPA-LOW emission gated on firmware support; F-RPM-WEIGHTS gated on header presence; slider deltas already shipped via `sliderDelta`). Remaining: anti_gravity_cutoff/p_gain rules need measured evidence — deferred | L | Medium | — |
| P2.6 | **RPM filter tuning rules** — recommend `rpm_filter_harmonics`, `min_hz`, `fade_range`, per-harmonic weights from measured harmonic tracks and dyn_idle, latency-aware. ✅ Implemented (`RpmFilterRecommender.ts`, rules F-RPM-*) | M | Medium | P2.2 |
| P2.7 | **Latency budget replaces LPF2 magic numbers** — attenuation-vs-latency decision (required attenuation at measured peak vs group-delay cost) against a per-size latency budget, surfaced as "filter latency: X ms (budget Y)". ✅ Implemented (`FILTER_LATENCY_BUDGET_BY_SIZE`, budget-aware LPF2 rules + GroupDelayEstimator) | M | Medium | P2.3 |
| P2.8 | **ThrottleTF pitch axis + TPA emission** — extend roll-only TPA diagnostics to pitch; emit tpa_rate/breakpoint/tpa_low recommendations from per-band gain trends. ✅ Implemented (`recommendTPAFromThrottleTF()`, TPA-TF-* rules; `tpa_low_*` emission deferred to P2.5 version layer) | S/M | Low | P2.5 |

**Phase 2 exit criteria**: feature-parity checklist vs PIDtoolbox PRO / Blackbox Explorer passes (deconvolved step split by magnitude, filter curves, before/after, version-aware recommendations); full `/e2e-tuning-test` pass.

### Phase 3 — Differentiators

| ID | Item | Effort | Depends on |
|----|------|--------|-----------|
| P3.1 ✅ | **Coherence plots + explainable recommendations** — per-axis coherence chart with trustworthy-band shading; structured `evidence` field on `Recommendation` (band, measured value, threshold) rendered as annotated plot regions ("this peak fired F-RES-GYRO"). Cheap, high differentiation; can land during Phase 2. | M | P1.4 |
| P3.2 | **System identification + what-if simulation** — fit low-order model (2nd order + delay) to coherence-weighted H(f); divide out known PID/filter contribution to estimate the plant; re-close the loop with proposed gains → predicted step response and margins shown next to measured, before apply. Demo generator is a known plant, so prediction accuracy is unit-testable end-to-end. Always labeled as prediction, gated on coherence and fit quality. ✅ Implemented (`SystemIdentifier.ts`, `PIDAnalysisResult.whatIf`, QuickAnalysisStep prediction chart) | L | P2.1 |
| P3.3 | **Filter placement optimizer** — discrete search over (LPF cutoffs, notch count/Q, RPM harmonic set) minimizing total group delay subject to attenuation ≥ target at every measured peak; emits standard `Recommendation` objects so apply/verify is unchanged. | L | P2.3, P2.6, P2.7 |
| P3.4 | **Mechanical fault signatures** — per-motor order analysis (eRPM/motor outputs): bent prop = strong 1×/rev on one motor; bearing wear = broadband + sub-harmonic; ship as experimental telemetry-collected flags, promote thresholds via `/telemetry-evaluator`. | M/L | P2.2 |
| P3.5 | **Longitudinal/crowd benchmarking** — opt-in fleet percentiles per quad size (telemetry pipeline exists). Deliberately last: shipping before P1.1/P2.1 would poison the dataset with pre-recalibration metric values. | L | Phases 1–2 |

### Sequencing

```
P0.1 → P1.1 → {P1.2 → P1.3, P1.6, P1.7};   P1.4, P1.5, P1.8, P1.9 in parallel after P0.1
P1.4 → P2.1 → P3.2
P1.2 + P1.6 → P2.2 → {P2.6, P3.4}
P2.3 → {P2.7, P3.3};   P2.4, P2.5, P2.8 independent within Phase 2
P1.4 → P3.1 (anytime, even during Phase 2)
P3.5 last
```

Recalibration events: exactly two — **P1.1 (dB scale)** and **P2.1 (time-domain scale)**. Golden-output fixtures (P0.1) are regenerated only in those two PRs; every other PR must not change them without explicit justification.
