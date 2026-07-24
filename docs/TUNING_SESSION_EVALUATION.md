# Tuning Session Evaluation Strategy

> **Status**: Active

How FPVPIDlab evaluates tuning sessions across all modes — what metrics drive recommendations, how success is measured, and when convergence is achieved.

## Data Source Priority

**Critical rule: BBL headers are the primary source for analysis settings, MSP is fallback only.**

| Source | Used for | Why |
|--------|----------|-----|
| **BBL headers** (primary) | Filter config, PIDs, d_min, iterm_relax, TPA during analysis | Captures exact config at flight time — between flying and analyzing, user may change settings in BF Configurator |
| **MSP** (fallback) | Fields BBL doesn't cover, UI display, apply verification | Live FC state — correct for readback and display, but may not match flight-time config |

**Implementation**: `analysisHandlers.ts` parses BBL first, builds settings via `enrichSettingsFromBBLHeaders()`, then fills gaps from MSP. PID analysis already uses `extractFlightPIDs(rawHeaders)` from BBL.

**Real BBL integration test**: `test-fixtures/bbl/` contains one tracked BBL fixture (6.2 MB, VX3.5 BF 4.5.2) validated in CI. Header formats verified: CSV fields (`d_min:30,34,0`, `gyro_lpf1_dyn_hz:250,500`), BF naming (`d_max_gain` not `d_min_gain`).

## Size-Aware Noise Classification

Noise floor thresholds are adjusted per drone size. Smaller quads with higher KV motors have inherently higher noise floors — classifying them with 5" standards produces false "HIGH" readings.

Classification uses strict `>` comparisons: exactly on the boundary = the lower category.

All dB values are on the **v2 calibrated power-spectrum scale** (`SPECTRUM_SCALE_VERSION = 2`: detrended Hanning windows, power-domain Welch averaging, 10·log10 — a sine of amplitude A reads 10·log10(A²/2)). They sit ≈10 dB above the legacy v1 amplitude-averaged scale; stored metrics from v1 app versions are not directly comparable.

| Size | HIGH (noisy) | MEDIUM | LOW (clean) | Typical KV |
|------|-------------|--------|-------------|------------|
| 1" | > -5 dB | > -20 and ≤ -5 | ≤ -20 | 19,000+ |
| 2.5" | > -10 dB | > -25 and ≤ -10 | ≤ -25 | 4,500+ |
| 3" | > -15 dB | > -30 and ≤ -15 | ≤ -30 | 3,000-4,500 |
| 4" | > -17 dB | > -30 and ≤ -17 | ≤ -30 | 2,500-3,500 |
| 5" | > -20 dB | > -40 and ≤ -20 | ≤ -40 | 1,750-2,100 |
| 6" | > -23 dB | > -40 and ≤ -23 | ≤ -40 | 1,300-1,500 |
| 7" | > -25 dB | > -45 and ≤ -25 | ≤ -45 | 1,100-1,300 |

**Source**: PIDToolBox -30 dB standard (5" reference, amplitude-dB convention) shifted +10 dB to the v2 power-spectrum scale, scaled by KV/prop-size relationship.

**Implementation**: `NOISE_LEVEL_BY_SIZE` in `src/main/analysis/constants.ts`, consumed by `NoiseAnalyzer.categorizeNoiseLevel()`.

## Filter Tune

**Analysis metric**: Gyro noise floor (dB) per axis, classified using size-aware thresholds.

**Recommendation basis**: Absolute noise-based target cutoff via `computeNoiseBasedTarget()`. When dynamic lowpass is active, tunes `dyn_min_hz`/`dyn_max_hz` with BF 2:1 ratio. Independent of current settings → convergent.

**Verification**: Before/after throttle spectrogram comparison. Delta in dB per axis.

**Success criteria**:
- Noise floor unchanged or improved (lower dB)
- No regression on any axis > 3 dB

**Convergence signal**: Recommended changes fall within deadzone:
- HIGH/LOW noise: 5 Hz deadzone (`NOISE_TARGET_DEADZONE_HZ`)
- MEDIUM noise: 20 Hz deadzone (wider to prevent micro-adjustments)

**Known limitation**: Noise floor varies ±3-5 dB between flights due to wind, battery voltage, motor temperature, and flight style. This can cause ping-pong recommendations when the quad operates near a classification threshold boundary.

## PID Tune

**Analysis metric**: Step response — overshoot %, settling time (ms), rise time (ms), ringing count, steady-state error %.

**Recommendation basis**: Flight-PID-anchored proportional adjustments. Severity-scaled steps (D: +5/+10/+15, P: -5/-10). D/P damping ratio validation (0.45-0.85).

**Verification**: Before/after step response comparison per axis. Delta in overshoot %, settling time.

**Success criteria**:
- Overshoot ≤ style threshold (aggressive: 35%, balanced: 25%, smooth: 12%)
- Settling time ≤ style threshold (aggressive: 150ms, balanced: 200ms, smooth: 250ms)
- Ringing ≤ style threshold (aggressive: 3, balanced: 2, smooth: 1)

**Convergence signal**: P/I/D changes < minimum step size (±5). Damping ratio within healthy range.

**Advantage over Filter Tune**: Step response metrics are less sensitive to external conditions (wind doesn't significantly affect overshoot measurement from stick snaps).

## Flash Tune

**Analysis metric**: Combined filter (noise floor) + PID (transfer function via Wiener deconvolution: bandwidth Hz, phase margin °, DC gain dB).

**Recommendation basis**: Noise analysis for filters + transfer function for PIDs. Single flight provides both.

**Verification**: Before/after noise spectrum + synthetic step response from transfer function.

**Success criteria**:
- Noise: unchanged or improved
- Bandwidth: ≥ style threshold (aggressive: 60 Hz, balanced: 40 Hz, smooth: 30 Hz)
- Phase margin: ≥ 30° (stability)
- DC gain: near 0 dB (tracking accuracy)

**Convergence signal**: Both filter and PID changes below respective deadzones.

## Propwash Evaluation

Propwash is evaluated via PropWashDetector during PID Tune and Flash Tune analysis:

- **Detection**: Throttle-down events with post-event FFT in 20-90 Hz band
- **Baseline**: Severity ratio is measured against a clean-segment baseline — band energy of contiguous runs outside every drop + post-drop window (falls back to the whole flight when no clean run ≥ 1024 samples)
- **Metrics**: Mean severity ratio, worst axis, dominant frequency
- **Severity scale**: minimal (< 2.0), moderate (2.0-5.0), severe (≥ 5.0)
- **Impact on recommendations**: Triggers d_min gain adjustment, iterm_relax cutoff reduction, TPA mode/breakpoint changes
- **Success criteria**: Severity ratio decreasing across sessions, dominant frequency shifting higher (away from propwash band)

## Quality Score Components

The flight quality score (0-100) uses type-aware components:

| Mode | Components | Weight Distribution |
|------|-----------|-------------------|
| Filter Tune | Noise floor | Even across available |
| PID Tune | Tracking RMS, overshoot, settling time | Even across available |
| Flash Tune | Noise floor, overshoot (TF), phase margin, bandwidth | Even across available |

When verification data is present, a **Noise Delta** component is added (improvement/regression dB).

Noise-floor scoring anchors are on the v2 power-spectrum scale (best -50 dB, worst -10 dB). The Phase Margin component skips axes without a measured gain crossover (`phaseMarginCrossingFound === false`) — the 90° cap is a sentinel, not a measurement.

**Implementation**: `src/shared/utils/tuneQualityScore.ts`

## Convergence Detection

**Cross-scale guard**: `FilterMetricsSummary` records are stamped with `spectrumScaleVersion` at write time. When the initial and verification flights were measured on different scale versions (e.g. a v1-stored flight vs a v2 measurement after an app update), the ConvergenceDetector refuses the noise-floor comparison and reports a neutral "continue" — the ~+10 dB scale shift would otherwise read as a huge regression. Flash convergence also skips the cross-scale noise check and ignores 90° phase-margin placeholders (`phaseMarginCrossingFound = false`).

A tuning mode is considered converged when:
1. Recommended changes are all within deadzone thresholds
2. Quality score is stable across 2+ sessions (±5 points)
3. Verification shows no regression

When convergence is detected, the recommendation engine should indicate "no changes needed" rather than suggesting micro-adjustments that could destabilize the tune.
