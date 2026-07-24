# Analysis Engine

Noise analysis, step response, transfer function, and data quality scoring modules.

## FFT Analysis Engine

**Pipeline**: SegmentSelector → FFTCompute → NoiseAnalyzer → FilterRecommender → FilterAnalyzer

- **SegmentSelector**: Finds stable hover segments and throttle sweep segments (excludes takeoff/landing/acro)
- **FFTCompute**: detrended + Hanning window, Welch's method (50% overlap, power-domain averaging), calibrated one-sided power spectrum (`SPECTRUM_SCALE_VERSION = 2`: sine of amplitude A reads 10·log10(A²/2); dB values sit ≈10 dB above the legacy v1 amplitude-averaged scale)
- **NoiseAnalyzer**: Noise floor estimation, peak detection (prominence-based), source classification (frame resonance via size-aware `FRAME_RESONANCE_BY_SIZE` bands — 5" default 80-200 Hz, micros up to 350 Hz; motor harmonics; electrical >500 Hz). Peak detection: prominence-based with plateau handling, 15 Hz minimum spacing (`PEAK_MIN_SPACING_HZ`), parabolic sub-bin interpolation
- **FilterRecommender**: Absolute noise-based target computation (convergent), safety bounds, propwash-aware gyro LPF1 floor (100 Hz min, bypass at -5 dB extreme noise on the v2 scale), beginner-friendly explanations. Medium noise handling (conditional LPF2 recommendations, incl. `DTERM_LPF2_DISABLE_THRESHOLD_DB` for the D-term disable rule), notch-aware resonance (notch counts as covering a peak only when `dyn_notch_count > 0`), conditional dynamic notch Q based on noise severity, size-aware dyn_notch_count target (2 sub-5", 1 for 5"+, max step 2/iteration). Dynamic-lowpass-aware: when `dyn_min_hz > 0`, all noise-floor and resonance rules target `dyn_min_hz`/`dyn_max_hz` instead of `static_hz`, proportionally adjusting max to maintain ratio. Exports `isGyroDynamicActive()`, `isDtermDynamicActive()`
- **ThrottleSpectrogramAnalyzer**: Bins gyro data by throttle level (10 bands). Per-band spectra are computed from **contiguous runs only** (`findContiguousRuns`, min 512 samples/run; per-run Welch FFT, length-weighted power average) — concatenating non-contiguous samples would create splice artifacts. Bands lacking a long-enough run report no spectrum. Returns `ThrottleSpectrogramResult`
- **GroupDelayEstimator**: Per-filter group delay estimation (PT1, biquad, notch). All lowpasses (LPF1 + LPF2) modeled as PT1 — the BF 4.3+ default (modeling LPF2 as biquad would overestimate its delay ~2×). Notch delay uses the denominator-only formula `τ(ω) = bw·(w0²+ω²) / ((w0²−ω²)² + bw²ω²)` (the numerator is purely real, contributing no phase slope). Returns `FilterGroupDelay` with gyroTotalMs, dtermTotalMs, warning if >2ms. Smart `dyn_notch_q` handling: `Q > 10 ? Q / 100 : Q` for BF internal storage quirk. Uses `dyn_min_hz` when dynamic lowpass is active (worst-case delay at tightest cutoff point)
- **DynamicLowpassRecommender**: Analyzes throttle spectrogram for throttle-dependent noise (enable trigger: ≥6 dB increase, Pearson ≥0.6, ≥3 throttle bands with data). When dynamic is NOT active and throttle noise detected: recommends enabling dynamic lowpass (dyn_min = current static cutoff, dyn_max = static × 2 per BF 2:1 convention). When dynamic IS already active: returns no recommendations (FilterRecommender handles tuning dyn_min/max directly). When dynamic IS active but NO throttle-dependent noise: recommends disabling (dyn_min → 0) with low confidence — only when the delta is below `DYNAMIC_LOWPASS_DISABLE_DB = 4` (hysteresis: 4–6 dB gray zone leaves config untouched, preventing enable/disable flip-flop). Rules: F-DLPF-GYRO, F-DLPF-DTERM (enable), F-DLPF-GYRO-OFF, F-DLPF-DTERM-OFF (disable)
- **FilterAnalyzer**: Orchestrator with async progress reporting. Passes both `gyro_lpf1_static_hz` and `dterm_lpf1_static_hz` to dynamic lowpass recommender. Returns throttle spectrogram + group delay in result
- IPC: `ANALYSIS_RUN_FILTER` + `EVENT_ANALYSIS_PROGRESS`
- Dependency: `fft.js`
- Constants in `constants.ts` (tunable thresholds)

## Step Response Analysis Engine

**Pipeline**: StepDetector → StepMetrics → PIDRecommender → PIDAnalyzer

- **StepDetector**: Derivative-based step input detection in setpoint data, hold/cooldown validation. Configurable window parameter (`windowMs?`)
- **StepMetrics**: Rise time, overshoot percentage, settling time, latency, ringing measurement with SNR filter (`RINGING_MIN_AMPLITUDE_FRACTION` = 5% of step magnitude excludes gyro noise from ringing count). Adaptive two-pass window sizing (`computeAdaptiveWindowMs()` — median-based, clamped 150-500ms). Steady-state error tracking (`steadyStateErrorPercent`)
- **PIDRecommender**: Flight-PID-anchored P/D/I recommendations (convergent), `extractFlightPIDs()` from BBL header, proportional severity-based steps (D: +5/+10/+15, P: -5/-10), I-term rules based on `meanSteadyStateError` with flight-style thresholds, D/P damping ratio validation (0.45-0.85 range; ceiling 1.0 for 1"/2.5" micros via `DAMPING_RATIO_MAX_MICRO`), safety bounds (P: 20-120, D: 15-80 for 5"/15-90 for 6"/15-100 for 7", I: 40-120). **Quad-size-aware bounds**: `droneSize` parameter narrows P/D/I bounds via `QUAD_SIZE_BOUNDS` (e.g., micro quads pMin=30 prevents dangerously low P). **Severity-scaled sluggish P**: P increase scales with rise time severity (+5/+10). **P-too-high warning**: when P > 1.3× pTypical, emits informational recommendation (`informational: true`). **P-too-low warning**: when P < 0.7× pTypical, emits informational warning (important for micros). **D-term effectiveness gating**: 3-tier D-increase gating (>0.7 boost confidence, 0.3-0.7 allow+warn, <0.3 block the increase and emit an informational "improve filters first" rec — `P-DTE-BLOCK`). **Prop wash integration**: severe prop wash (≥5×) boosts D-increase confidence or generates new D+5 recommendation on worst axis. **Propwash iterm_relax**: two-tier progressive reduction — moderate propwash (2-5×) lowers cutoff by 5 with floor 15 (PW-IRELAX-CUTOFF-MOD), severe (≥5×) lowers with floor 7 (PW-IRELAX-CUTOFF). **Rule TF-4**: DC gain deficit from transfer function → I-term increase recommendation (Flash Tune equivalent of steady-state error detection). Style-aware threshold `20·log10(1 − steadyStateErrorMax/100)` dB; +10 step and medium confidence at 2× threshold. **D-min/TPA advisory**: `extractDMinContext()` and `extractTPAContext()` from BBL headers annotate D recommendations when D-min or TPA is active. **FF boost step**: reduced from 5 to 3 for finer convergence. **VBat sag advisory** (P-VBAT-SAG): recommends `vbat_sag_compensation=75` for freestyle/cinematic when disabled
- **CrossAxisDetector**: Pearson correlation coupling detection between axis pairs. Thresholds: none (<0.15), mild (0.15-0.4), significant (≥0.4). Returns `CrossAxisCoupling`
- **PropWashDetector**: Throttle-down event detection, post-event FFT in 20-90 Hz band. Severity ratio uses a **clean baseline** — band energy of contiguous runs outside every drop + post-drop window (per-run FFT, length-weighted; falls back to whole flight when no clean run ≥ 1024 samples). Returns `PropWashAnalysis` with events, meanSeverity, worstAxis, dominantFrequencyHz. Passed to `recommendPID()` for prop wash-aware D recommendations
- **PIDAnalyzer**: Orchestrator with async progress reporting, threads `flightPIDs` through pipeline. Two-pass step detection (first 500ms, then adaptive). Passes `dTermEffectiveness`, `propWash`, `dMinContext`, and `tpaContext` to `recommendPID()` for integrated D-gain gating and advisory annotations
- IPC: `ANALYSIS_RUN_PID` + `EVENT_ANALYSIS_PROGRESS`

### Additional Analysis Modules

- **DTermAnalyzer**: D-term effectiveness via FFT energy ratio in 20-150 Hz band. Used for D-increase gating
- **FeedforwardAnalyzer**: RC-link-aware FF baseline + step-response refinement (smooth/jitter factors)
- **MechanicalHealthChecker**: Pre-tuning diagnostics — extreme noise, axis asymmetry, motor imbalance. Extreme-noise threshold is size-aware: `max(-20 dB, NOISE_LEVEL_BY_SIZE[size].highDb + 5 dB)` — avoids false "damaged prop" flags on inherently noisy 1"/2.5" builds. Produces mechanical-health flags consumed by analyzers (may lower confidence or add warnings)
- **WindDisturbanceDetector**: Gyro variance analysis for environmental disturbance. Computes and attaches `windDisturbance` metric to analysis result
- **BayesianPIDOptimizer**: Lightweight Gaussian Process surrogate for iterative PID tuning across sessions
- **ThrottleTFAnalyzer**: Per-throttle-band transfer function (Wiener deconvolution) for TPA diagnostics (5 bands). Uses the longest contiguous run per band (min 2048 samples) — TF cross-spectra require an unbroken time series
- **SliderMapper**: Maps raw PID gains to Betaflight Configurator slider UI positions
- **headerValidation**: BBL header parsing/validation utilities, field name mapping. Low-logging-rate warning uses the effective log rate `1e6 / (looptime × pInterval × pDenom)`, not the raw gyro rate. Static LPF cutoffs (`gyro/dterm_lpf1/lpf2_static_hz`) and `dyn_notch_min/max_hz` are always enriched from BBL headers when present (BBL is the primary source — pre-populated defaults never mask header values)

## Transfer Function Analysis Engine

**Pipeline**: TransferFunctionEstimator (setpoint → gyro deconvolution → H(f) = S_xy(f) / S_xx(f))

- **TransferFunctionEstimator**: Cross-spectral density estimation, bandwidth/phase margin extraction, `dcGainDb` field for I-term approximation (computed as the 1–5 Hz band average, not the unreliable bin 0; the -3 dB bandwidth reference uses the same band), PID recommendations based on frequency response characteristics. Computes **magnitude-squared coherence** γ²(f) per axis (`BodeResult.coherence`, requires ≥2 Welch windows) and `coherenceMean` over the 1-30 Hz stick band (`TransferFunctionMetrics.coherenceMean`) — feeds the Wiener data-quality axis-coverage sub-score and gates TF-1..TF-4 recommendations per axis (`TF_COHERENCE_GATE = 0.5` in PIDRecommender)
- Used in Flash Tune mode for combined filter + PID analysis from a single flight
- IPC: `ANALYSIS_RUN_TRANSFER_FUNCTION` + `EVENT_ANALYSIS_PROGRESS`

## Data Quality Scoring (`DataQualityScorer.ts`)

Rates flight data quality 0-100 before generating recommendations. Integrated into both FilterAnalyzer and PIDAnalyzer.

- Computes 0-100 score from weighted sub-scores (segment/step count, coverage, hold quality)
- Downgrades recommendation confidence for fair/poor data quality
- Tier mapping: 80-100 excellent, 60-79 good, 40-59 fair, 0-39 poor

## Flight Quality Score (`src/shared/utils/tuneQualityScore.ts`)

Composite 0-100 score with type-aware components (noise floor, overshoot, settling, bandwidth, phase margin). Points redistributed evenly among available components. Displayed as badge in TuningCompletionSummary and TuningHistoryPanel.
