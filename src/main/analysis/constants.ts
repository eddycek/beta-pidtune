/**
 * Constants for FFT analysis, filter tuning, and PID step-response analysis.
 * All thresholds are tunable — adjust based on real-world data.
 */

import type { DroneSize, FlightStyle } from '@shared/types/profile.types';

// ---- FFT Parameters ----

/** FFT window size in samples. 4096 at 8 kHz → 0.5s window, ~2 Hz resolution */
export const FFT_WINDOW_SIZE = 4096;

/** Overlap ratio for Welch's method (0.5 = 50%) */
export const FFT_OVERLAP = 0.5;

/** Minimum frequency of interest in Hz (below this is mostly vibration/drift) */
export const FREQUENCY_MIN_HZ = 20;

/** Maximum frequency of interest in Hz (above this is typically aliased/irrelevant) */
export const FREQUENCY_MAX_HZ = 1000;

// ---- Segment Selection ----

/** Minimum throttle percentage to consider "in flight" (0-1 scale, 0.15 = 15%) */
export const THROTTLE_MIN_FLIGHT = 0.15;

/** Maximum throttle percentage for "hover" detection (0-1 scale) */
export const THROTTLE_MAX_HOVER = 0.75;

/** Maximum gyro standard deviation (deg/s) for a "steady" segment */
export const GYRO_STEADY_MAX_STD = 50;

/** Yaw steadiness threshold multiplier — yaw is inherently noisier than
 * roll/pitch, but an active yaw spin still disqualifies a "steady" segment. */
export const YAW_STEADY_MULTIPLIER = 1.5;

/** Minimum segment duration in seconds */
export const SEGMENT_MIN_DURATION_S = 0.5;

/** Target window duration in seconds for gyro variance check */
export const SEGMENT_WINDOW_DURATION_S = 0.15;

// ---- Throttle Sweep Detection ----

/** Minimum throttle range covered by a sweep (0-1 scale, 0.4 = 40%) */
export const SWEEP_MIN_THROTTLE_RANGE = 0.4;

/** Minimum sweep duration in seconds */
export const SWEEP_MIN_DURATION_S = 2.0;

/** Maximum sweep duration in seconds */
export const SWEEP_MAX_DURATION_S = 15.0;

/** Maximum throttle regression residual for "monotonic" classification */
export const SWEEP_MAX_RESIDUAL = 0.15;

// ---- Noise Analysis ----

/**
 * Spectrum scale version. v2 = calibrated one-sided power spectrum
 * (detrended, Hanning, (Σw)² coherent-gain normalization, power-domain
 * Welch averaging, dB = 10·log10). A sine of amplitude A reads
 * 10·log10(A²/2). Absolute dB thresholds below are calibrated to this
 * scale — they sit ≈10 dB above the legacy amplitude-averaged scale (v1),
 * and ≈10 dB above the PIDToolBox amplitude-dB convention cited in older
 * community sources. Stored metrics from v1 app versions are not directly
 * comparable to v2 values.
 */
export const SPECTRUM_SCALE_VERSION = 2;

/** Peak detection: minimum prominence above local noise floor in dB.
 * Relative (peak vs floor) — identical meaning on the v1 and v2 scales. */
export const PEAK_PROMINENCE_DB = 6;

/** Peak detection: minimum spacing between reported peaks (Hz).
 * A broad resonance hump spans several bins — without spacing enforcement
 * it registers as multiple adjacent "peaks". Weaker candidates within this
 * distance of a stronger peak are suppressed. */
export const PEAK_MIN_SPACING_HZ = 15;

/** Number of bins on each side for local noise floor estimation */
export const PEAK_LOCAL_WINDOW_BINS = 50;

/** Percentile for noise floor estimation (0.25 = lower quartile) */
export const NOISE_FLOOR_PERCENTILE = 0.25;

/** Noise level thresholds in dB (noise floor above these values).
 * These are the 5" defaults — use NOISE_LEVEL_BY_SIZE for size-aware classification.
 * Source: PIDToolBox community standard (-30 dB amplitude convention for a
 * "clean" 5" build) shifted +10 dB to the v2 power-spectrum scale. */
export const NOISE_LEVEL_HIGH_DB = -20;
export const NOISE_LEVEL_MEDIUM_DB = -40;

// ---- Size-Aware Noise Classification ----
// Smaller quads with higher KV motors have inherently higher noise floors.
// The -30 dB PIDToolBox standard was calibrated for 5" freestyle quads.
// Source: community testing, BF tuning notes, PIDToolBox convention.

export interface NoiseLevelThresholds {
  /** Noise floor above this = HIGH noise (aggressive filtering needed) */
  highDb: number;
  /** Noise floor above this = MEDIUM noise (moderate filtering). Below = LOW (clean). */
  mediumDb: number;
}

/**
 * Per-size noise classification thresholds.
 * Higher KV motors excite the gyro more → higher noise floor is "normal".
 */
export const NOISE_LEVEL_BY_SIZE: Record<DroneSize, NoiseLevelThresholds> = {
  // v2 power-spectrum scale (legacy amplitude-scale values +10 dB)
  '1"': { highDb: -5, mediumDb: -20 }, // Extreme KV (19000+), budget gyros
  '2.5"': { highDb: -10, mediumDb: -25 }, // High KV (4500+)
  '3"': { highDb: -15, mediumDb: -30 }, // High KV (3000-4500)
  '4"': { highDb: -17, mediumDb: -30 }, // Medium-high KV (2500-3500)
  '5"': { highDb: -20, mediumDb: -40 }, // PIDToolBox standard (+10 dB)
  '6"': { highDb: -23, mediumDb: -40 }, // Lower KV, larger props
  '7"': { highDb: -25, mediumDb: -45 }, // Lowest KV, should be very clean
};

/** Fallback when drone size is unknown (= 5" standard) */
export const NOISE_LEVEL_DEFAULT: NoiseLevelThresholds = NOISE_LEVEL_BY_SIZE['5"'];

// ---- Peak Classification Frequency Bands ----

/** Frame resonance band for a 5" quad: typically 80-200 Hz.
 * Fallback when drone size is unknown — use FRAME_RESONANCE_BY_SIZE otherwise. */
export const FRAME_RESONANCE_MIN_HZ = 80;
export const FRAME_RESONANCE_MAX_HZ = 200;

/** Frame resonance band bounds per drone size (Hz). */
export interface FrameResonanceBand {
  min: number;
  max: number;
}

/**
 * Size-aware frame resonance bands. Smaller/stiffer/lighter frames resonate
 * at higher frequencies than the classic 5" 80-200 Hz band — a 2.5" frame
 * resonating at 300 Hz must not be classified as electrical noise.
 * House extrapolation anchored on the 5" community convention.
 */
export const FRAME_RESONANCE_BY_SIZE: Record<DroneSize, FrameResonanceBand> = {
  '1"': { min: 150, max: 350 },
  '2.5"': { min: 150, max: 350 },
  '3"': { min: 120, max: 280 },
  '4"': { min: 100, max: 240 },
  '5"': { min: 80, max: 200 },
  '6"': { min: 70, max: 170 },
  '7"': { min: 60, max: 150 },
};

/** Electrical noise: typically above 500 Hz */
export const ELECTRICAL_NOISE_MIN_HZ = 500;

/** Motor harmonic detection: tolerance as fraction of expected harmonic frequency */
export const MOTOR_HARMONIC_TOLERANCE_RATIO = 0.05;

/** Motor harmonic detection: minimum tolerance in Hz (FFT bin resolution floor) */
export const MOTOR_HARMONIC_TOLERANCE_MIN_HZ = 5;

/** Minimum number of equally-spaced peaks to classify as motor harmonics */
export const MOTOR_HARMONIC_MIN_PEAKS = 3;

// ---- Filter Recommendation Safety Bounds ----

/** Absolute minimum gyro lowpass 1 cutoff in Hz (BF guide: 50 very noisy, 80 slightly noisy) */
export const GYRO_LPF1_MIN_HZ = 75;

/** Absolute maximum gyro lowpass 1 cutoff in Hz */
export const GYRO_LPF1_MAX_HZ = 300;

/** Absolute minimum D-term lowpass 1 cutoff in Hz (BF guide: "70-90 Hz range") */
export const DTERM_LPF1_MIN_HZ = 70;

/** Absolute maximum D-term lowpass 1 cutoff in Hz */
export const DTERM_LPF1_MAX_HZ = 200;

// ---- RPM Filter Conditional Bounds ----

/** Maximum gyro LPF1 cutoff when RPM filter is active (Hz) */
export const GYRO_LPF1_MAX_HZ_RPM = 500;

/** Maximum D-term LPF1 cutoff when RPM filter is active (Hz) */
export const DTERM_LPF1_MAX_HZ_RPM = 300;

/** Recommended dynamic notch count with RPM filter active.
 * Sub-5" quads keep 2 notches (frame resonance + residual motor harmonic) because
 * smaller frames have more complex vibration coupling that RPM filter alone may not cover.
 * 5"+ quads use 1 notch (frame resonance only — RPM handles motor noise). */
export const DYN_NOTCH_COUNT_WITH_RPM = 1;
export const DYN_NOTCH_COUNT_WITH_RPM_BY_SIZE: Record<DroneSize, number> = {
  '1"': 2,
  '2.5"': 2,
  '3"': 2,
  '4"': 2,
  '5"': 1,
  '6"': 1,
  '7"': 1,
};
/** Max dyn_notch_count reduction per iteration (conservative stepping) */
export const DYN_NOTCH_COUNT_MAX_STEP = 2;

/** Recommended dynamic notch Q with RPM filter active */
export const DYN_NOTCH_Q_WITH_RPM = 500;

/** Default dynamic notch count without RPM filter (must track motor noise) */
export const DYN_NOTCH_COUNT_WITHOUT_RPM = 3;

/** Default dynamic notch Q without RPM filter */
export const DYN_NOTCH_Q_WITHOUT_RPM = 300;

/** dB level for extreme noise (maps to minimum cutoff in noise-based targeting).
 * v2 power-spectrum scale. */
export const NOISE_FLOOR_VERY_NOISY_DB = 0;

/** dB level for very clean signal (maps to maximum cutoff in noise-based targeting).
 * v2 power-spectrum scale. */
export const NOISE_FLOOR_VERY_CLEAN_DB = -60;

/** Minimum difference to recommend a noise-based filter change (Hz) */
export const NOISE_TARGET_DEADZONE_HZ = 5;

// ---- Verification Flight Similarity ----

/** Minimum peak matching tolerance (Hz) — floor for low-frequency peaks */
export const PEAK_MATCH_TOLERANCE_MIN_HZ = 10;

/** Similarity score threshold for accepting verification comparison.
 * Calibrated against test-fixtures/bbl LOG1-LOG2 (same VX3.5 quad).
 * Observed same-quad scores 89/100 → 70 gives 19pt margin against false rejection.
 * Adjust if telemetry false-rejection rate exceeds 5% target. */
export const SIMILARITY_ACCEPT_THRESHOLD = 70;

/** Similarity score threshold below which verification is rejected.
 * Below this, flight conditions are too different for meaningful comparison.
 * Calibrated to reject truly dissimilar flights (different quad, different style). */
export const SIMILARITY_REJECT_THRESHOLD = 40;

// ---- Recommendation Hysteresis (Variability-Aware) ----

/** Maximum additional deadzone from noise floor variability (Hz) */
export const MAX_VARIABILITY_BONUS_HZ = 15;

/** Scale factor: dB of noise floor std → Hz of additional deadzone.
 * Derived from computeNoiseBasedTarget() slope: 60 dB range → 225 Hz = 3.75 Hz/dB. */
export const VARIABILITY_TO_HZ_SCALE = 3.75;

/** Maximum CoV difference for PID magnitude similarity scoring.
 * CoV (std/mean) normalizes for absolute magnitude — similar style regardless of battery weight.
 * Typical stick snap CoV: 0.2-0.6. Diff of 0.5 = completely different style → score 0. */
export const PID_MAGNITUDE_MAX_COV_DIFF = 0.5;

// ---- Convergence Detection ----

/** Filter convergence: worst-axis noise floor delta below this = converged (dB) */
export const FILTER_CONVERGENCE_DB = 1.5;

/** Filter convergence: delta below this = diminishing returns (dB) */
export const FILTER_DIMINISHING_DB = 3.0;

/** PID convergence: overshoot delta below this = converged (%) */
export const PID_CONVERGENCE_OVERSHOOT_PCT = 2;

/** PID convergence: settling time delta below this = converged (ms) */
export const PID_CONVERGENCE_SETTLING_MS = 5;

/** PID diminishing returns: overshoot delta threshold (%) */
export const PID_DIMINISHING_OVERSHOOT_PCT = 5;

/** PID diminishing returns: settling time delta threshold (ms) */
export const PID_DIMINISHING_SETTLING_MS = 15;

/** Flash convergence: bandwidth delta below this = converged (Hz) */
export const FLASH_CONVERGENCE_BW_HZ = 2;

/** Flash convergence: phase margin delta below this = converged (°) */
export const FLASH_CONVERGENCE_PM_DEG = 3;

/** Flash diminishing returns: bandwidth delta (Hz) */
export const FLASH_DIMINISHING_BW_HZ = 5;

/** Flash diminishing returns: phase margin delta (°) */
export const FLASH_DIMINISHING_PM_DEG = 5;

// ---- Iteration Tracking ----

/** Number of recent same-type tuning sessions that triggers iteration warning */
export const ITERATION_WARNING_THRESHOLD = 3;

/** Lookback window for iteration counting (days) */
export const ITERATION_LOOKBACK_DAYS = 7;

/** Resonance peak amplitude threshold for notch/cutoff recommendation (dB above floor) */
export const RESONANCE_ACTION_THRESHOLD_DB = 12;

/** Margin below a resonance peak when lowering cutoff (Hz) */
export const RESONANCE_CUTOFF_MARGIN_HZ = 20;

// ---- Propwash Safety Floor ----

/** Propwash-aware minimum gyro LPF1 cutoff (Hz). Prevents excessive phase delay
 * that degrades propwash recovery during aggressive maneuvers (flips, rolls).
 * Only applies to noise-floor-based recommendations, not resonance-based. */
export const PROPWASH_GYRO_LPF1_FLOOR_HZ = 100;

/** Noise floor threshold (dB, v2 power-spectrum scale) above which the propwash floor
 * is bypassed. When noise is this severe, aggressive filtering takes priority over
 * propwash handling. */
export const PROPWASH_FLOOR_BYPASS_DB = -5;

// ---- Step Detection ----

/** Minimum setpoint change to count as a step (deg/s).
 * Raised from 100 to 150 to reduce false positives in turbulent data.
 * DataQualityScorer warns below 200 deg/s for "clear" responses. */
export const STEP_MIN_MAGNITUDE_DEG_S = 150;

/** Minimum setpoint derivative (deg/s per second) for edge detection */
export const STEP_DERIVATIVE_THRESHOLD = 500;

/** Default window after step to measure response (ms) — fallback when adaptive not available */
export const STEP_RESPONSE_WINDOW_MS = 300;

/** Maximum response window for first-pass adaptive detection (ms) — generous for large quads */
export const STEP_RESPONSE_WINDOW_MAX_MS = 500;

/** Minimum response window (ms) — prevents clipping for tiny quads */
export const STEP_RESPONSE_WINDOW_MIN_MS = 150;

/** Multiplier for median settling time to compute adaptive window */
export const ADAPTIVE_WINDOW_SETTLING_MULTIPLIER = 2;

/** Minimum ringing amplitude as fraction of step magnitude.
 * Zero-crossings with amplitude below this are treated as noise, not real oscillation.
 * 5% filters out gyro noise while preserving genuine mechanical ringing. */
export const RINGING_MIN_AMPLITUDE_FRACTION = 0.05;

/** Minimum gap between steps to avoid rapid reversals (ms) */
export const STEP_COOLDOWN_MS = 100;

/** Step must hold for at least this long (ms) */
export const STEP_MIN_HOLD_MS = 50;

// ---- Step Response Metrics ----

/** Settling tolerance: +/-2% of target */
export const SETTLING_TOLERANCE = 0.02;

/** Rise time low threshold (10% of final value) */
export const RISE_TIME_LOW = 0.1;

/** Rise time high threshold (90% of final value) */
export const RISE_TIME_HIGH = 0.9;

/** Threshold for detecting first movement (5% of step magnitude) */
export const LATENCY_THRESHOLD = 0.05;

// ---- PID Scoring ----

/** Target overshoot percentage (ideal) — 10-15% is normal for multirotors (PIDtoolbox) */
export const OVERSHOOT_IDEAL_PERCENT = 10;

/** Maximum acceptable overshoot percentage (BF: bounce-back = problematic) */
export const OVERSHOOT_MAX_PERCENT = 25;

/** Maximum acceptable ringing count (BF: any visible bounce-back should be addressed) */
export const RINGING_MAX_COUNT = 2;

/** Maximum acceptable settling time (ms) — feed-forward makes 150-200ms normal */
export const SETTLING_MAX_MS = 200;

// ---- PID Style Thresholds ----

export interface PIDStyleThresholds {
  overshootIdeal: number;
  overshootMax: number;
  settlingMax: number;
  ringingMax: number;
  moderateOvershoot: number;
  sluggishRise: number;
  /** Steady-state error threshold (%) above which I is considered too low */
  steadyStateErrorMax: number;
  /** Steady-state error threshold (%) below which I might be safely reduced */
  steadyStateErrorLow: number;
}

export const PID_STYLE_THRESHOLDS: Record<FlightStyle, PIDStyleThresholds> = {
  smooth: {
    overshootIdeal: 3,
    overshootMax: 12,
    settlingMax: 250,
    ringingMax: 1,
    moderateOvershoot: 8,
    sluggishRise: 120,
    steadyStateErrorMax: 8,
    steadyStateErrorLow: 2,
  },
  balanced: {
    overshootIdeal: 10,
    overshootMax: 25,
    settlingMax: 200,
    ringingMax: 2,
    moderateOvershoot: 15,
    sluggishRise: 80,
    steadyStateErrorMax: 5,
    steadyStateErrorLow: 1,
  },
  aggressive: {
    overshootIdeal: 18,
    overshootMax: 35,
    settlingMax: 150,
    ringingMax: 3,
    moderateOvershoot: 25,
    sluggishRise: 50,
    steadyStateErrorMax: 3,
    steadyStateErrorLow: 1,
  },
} as const;

// ---- PID Safety Bounds ----

/** Minimum P gain */
export const P_GAIN_MIN = 20;

/** Maximum P gain */
export const P_GAIN_MAX = 120;

/** Minimum D gain */
export const D_GAIN_MIN = 15;

/** Maximum D gain */
export const D_GAIN_MAX = 80;

// ---- D/P Damping Ratio ----

/** Minimum healthy D/P ratio. Below this the quad is underdamped (bouncy, oscillatory).
 * Typical BF defaults: D/P ≈ 0.55-0.65. Only checked on roll/pitch (yaw D often 0). */
export const DAMPING_RATIO_MIN = 0.45;

/** Maximum healthy D/P ratio. Above this the quad is overdamped (sluggish motors, noise amplification). */
export const DAMPING_RATIO_MAX = 0.85;

/** Maximum healthy D/P ratio for micro quads (1-2.5").
 * Whoop presets legitimately run more damping: whoop_justice D/P ≈ 0.91-0.94,
 * whoop_ayyykayyy ≈ 0.95 — the standard 0.85 ceiling would fight stock tunes. */
export const DAMPING_RATIO_MAX_MICRO = 1.0;

/** Minimum D/P change (in absolute terms) to emit a damping ratio recommendation.
 * Prevents trivial 1-point adjustments from rounding. */
export const DAMPING_RATIO_DEADZONE = 3;

/** Minimum classified steps required for FF-dominated axis classification.
 * Prevents single-step noise from overriding PID recommendations for entire axis. */
export const FF_DOMINATED_MIN_STEPS = 3;

/** Minimum I gain. 40 prevents dangerous hover drift (BF defaults I=60-90).
 * I=30 causes poor wind rejection and attitude drift. */
export const I_GAIN_MIN = 40;

/** Maximum I gain */
export const I_GAIN_MAX = 120;

// ---- Quad-Size-Aware PID Bounds ----

export interface QuadSizeBounds {
  pMin: number;
  pMax: number;
  dMin: number;
  dMax: number;
  iMin: number;
  iMax: number;
  /** Typical P for this size — used for "P too high" and "P too low" informational warnings */
  pTypical: number;
}

/**
 * Per-size PID safety bounds. Prevents dangerous values on small quads
 * (motor saturation) and allows higher D on large quads (high inertia).
 *
 * Sizes map to categories: micro (1-2.5"), small (3-4"), standard (5"),
 * large (6-7").
 */
export const QUAD_SIZE_BOUNDS: Record<DroneSize, QuadSizeBounds> = {
  // 1" whoop presets (whoop_justice, whoop_ayyykayyy, UAV Tech Whoop, Air65 BNF)
  // cluster P 63-83 / D 57-79 on roll+pitch — bounds must not clamp a stock tune.
  '1"': { pMin: 30, pMax: 90, dMin: 15, dMax: 80, iMin: 40, iMax: 100, pTypical: 72 },
  '2.5"': { pMin: 25, pMax: 90, dMin: 15, dMax: 55, iMin: 40, iMax: 110, pTypical: 42 },
  '3"': { pMin: 20, pMax: 100, dMin: 15, dMax: 60, iMin: 40, iMax: 110, pTypical: 45 },
  '4"': { pMin: 20, pMax: 110, dMin: 15, dMax: 70, iMin: 40, iMax: 120, pTypical: 46 },
  '5"': { pMin: 20, pMax: 120, dMin: 15, dMax: 80, iMin: 40, iMax: 120, pTypical: 48 },
  '6"': { pMin: 20, pMax: 120, dMin: 15, dMax: 90, iMin: 40, iMax: 120, pTypical: 50 },
  '7"': { pMin: 20, pMax: 120, dMin: 15, dMax: 100, iMin: 40, iMax: 120, pTypical: 50 },
};

/** Fallback bounds when drone size is unknown (= standard 5" bounds) */
export const DEFAULT_QUAD_SIZE_BOUNDS: QuadSizeBounds = QUAD_SIZE_BOUNDS['5"'];

// ---- Bandwidth Thresholds Per Flight Style ----

/** Minimum bandwidth (Hz) below which TF rule TF-3 recommends P increase.
 * Aggressive pilots need higher bandwidth for locked-in feel. */
export const BANDWIDTH_LOW_HZ_BY_STYLE: Record<FlightStyle, number> = {
  smooth: 30,
  balanced: 40,
  aggressive: 60,
};

// ---- LPF2 Recommendation Constants ----

/** Gyro LPF2 can be disabled when RPM filter is active and noise is this clean
 * (dB, v2 power-spectrum scale) */
export const GYRO_LPF2_DISABLE_THRESHOLD_DB = -35;

/** D-term LPF2 can be disabled when noise is this clean (dB, v2 power-spectrum scale) */
export const DTERM_LPF2_DISABLE_THRESHOLD_DB = -35;

// ---- Prop Wash Detection ----

/** Minimum throttle derivative (normalized units/s) for throttle-down event detection */
export const PROPWASH_THROTTLE_DROP_RATE = 0.3;

/** Minimum sustained duration of throttle drop (ms) */
export const PROPWASH_MIN_DROP_DURATION_MS = 50;

/** Post-event analysis window (ms) — oscillation occurs right after throttle cut */
export const PROPWASH_ANALYSIS_WINDOW_MS = 400;

/** Prop wash frequency band lower bound (Hz) */
export const PROPWASH_FREQ_MIN_HZ = 20;

/** Prop wash frequency band upper bound (Hz) */
export const PROPWASH_FREQ_MAX_HZ = 90;

/** Severity ratio threshold: below this is minimal prop wash */
export const PROPWASH_SEVERITY_MINIMAL = 2.0;

/** Severity ratio threshold: above this is severe prop wash */
export const PROPWASH_SEVERITY_SEVERE = 5.0;

/** Minimum events needed for reliable analysis */
export const PROPWASH_MIN_EVENTS = 3;

// ---- I-term Relax Cutoff ----

/** I-term relax cutoff ranges by flight style.
 * Racing needs higher cutoff (less relax) for snappier response.
 * Cinematic needs lower cutoff (more relax) for smoother recovery.
 * BF wiki (I Term Relax Explained): "30-40 is good for racing, 15 for
 * freestyle, 10 or even lower for big heavier quads"; race whoop presets
 * span 20-45, so the aggressive band is 20-40 with a typical of 30. */
export const ITERM_RELAX_CUTOFF_BY_STYLE: Record<
  FlightStyle,
  { min: number; max: number; typical: number }
> = {
  smooth: { min: 5, max: 10, typical: 7 },
  balanced: { min: 10, max: 15, typical: 12 },
  aggressive: { min: 20, max: 40, typical: 30 },
};

/** Minimum deviation (%) from style-appropriate range to trigger recommendation */
export const ITERM_RELAX_DEVIATION_THRESHOLD = 0.5; // 50%

// ---- RC Link-Aware Feedforward Profiles ----
// Source: docs/PID_TUNING_KNOWLEDGE.md Section 1 (Community Consensus)
// SupaflyFPV 4.5 presets, UAV Tech radio options, Karate race presets.

/** FF averaging modes: 0=OFF, 2=2_POINT, 3=3_POINT, 4=4_POINT */
export type FFAveragingMode = 0 | 2 | 3 | 4;

/** A single RC link rate profile with recommended FF settings */
export interface RCLinkProfile {
  /** Descriptive label for this band */
  label: string;
  /** Inclusive lower bound of RC link rate (Hz) */
  minHz: number;
  /** Inclusive upper bound of RC link rate (Hz). Infinity for the highest band */
  maxHz: number;
  /** Recommended feedforward_averaging value */
  averaging: FFAveragingMode;
  /** Recommended feedforward_smooth_factor (0-75) */
  smoothFactor: number;
  /** Recommended feedforward_jitter_factor (0-20) */
  jitterFactor: number;
  /** Recommended feedforward_boost (undefined = leave at current) */
  boost?: number;
}

/**
 * RC link rate → FF settings lookup table.
 * Bands are non-overlapping and ordered by ascending rate.
 * Values from PID_TUNING_KNOWLEDGE.md Section 1.
 */
export const RC_LINK_PROFILES: readonly RCLinkProfile[] = [
  {
    label: 'CRSF 50Hz',
    minHz: 0,
    maxHz: 60,
    averaging: 0,
    smoothFactor: 0,
    jitterFactor: 10,
    boost: 5,
  },
  {
    label: 'CRSF 150Hz',
    minHz: 61,
    maxHz: 149,
    averaging: 0,
    smoothFactor: 30,
    jitterFactor: 7,
  },
  {
    label: 'CRSF Dynamic',
    minHz: 150,
    maxHz: 249,
    averaging: 0,
    smoothFactor: 15,
    jitterFactor: 10,
    boost: 10,
  },
  {
    label: 'ELRS/Tracer 250Hz',
    minHz: 250,
    maxHz: 499,
    averaging: 2,
    smoothFactor: 35,
    jitterFactor: 5,
    boost: 18,
  },
  {
    label: 'ELRS 500Hz+',
    minHz: 500,
    maxHz: Infinity,
    averaging: 2,
    smoothFactor: 65,
    jitterFactor: 4,
    boost: 18,
  },
] as const;

// ---- Dynamic Idle Min RPM ----
// Source: docs/PID_TUNING_KNOWLEDGE.md Section 10 (Community Consensus)
// Maintains minimum motor RPM for desync prevention and RPM filter accuracy.

/** Dynamic idle min RPM ranges by drone size.
 * Smaller quads need higher min RPM (higher KV motors, faster desync).
 * Larger quads can use lower min RPM (lower KV, higher inertia). */
export const DYN_IDLE_MIN_RPM_BY_SIZE: Record<
  DroneSize,
  { min: number; max: number; typical: number }
> = {
  '1"': { min: 40, max: 60, typical: 50 },
  '2.5"': { min: 40, max: 60, typical: 50 },
  '3"': { min: 40, max: 60, typical: 45 },
  '4"': { min: 25, max: 40, typical: 30 },
  '5"': { min: 20, max: 35, typical: 25 },
  '6"': { min: 15, max: 30, typical: 20 },
  '7"': { min: 15, max: 25, typical: 20 },
};

/** Fallback dynamic idle min RPM when drone size is unknown (= 5" values) */
export const DYN_IDLE_MIN_RPM_DEFAULT = DYN_IDLE_MIN_RPM_BY_SIZE['5"'];

/** rc_smoothing_auto_factor: BF default is 30, most presets recommend 45 for >=150Hz */
export const RC_SMOOTHING_AUTO_FACTOR_DEFAULT = 30;
export const RC_SMOOTHING_AUTO_FACTOR_RECOMMENDED = 45;
/** RC link rate threshold above which rc_smoothing_auto_factor advisory triggers */
export const RC_SMOOTHING_ADVISORY_MIN_HZ = 150;

/**
 * Look up the RC link profile for a given link rate.
 * Returns undefined if rate is undefined or ≤0 (invalid).
 * For valid positive rates, a profile is always found (bands cover 1-Infinity).
 */
export function lookupRCLinkProfile(rcLinkRateHz: number | undefined): RCLinkProfile | undefined {
  if (rcLinkRateHz === undefined || rcLinkRateHz <= 0) return undefined;
  return RC_LINK_PROFILES.find((p) => rcLinkRateHz >= p.minHz && rcLinkRateHz <= p.maxHz);
}

// ---- Anti-Gravity Gain ----
// Source: docs/PID_TUNING_KNOWLEDGE.md Section 10 (Community Consensus)
// Heavier quads with cameras benefit from higher anti-gravity during throttle changes.
// Race/lightweight builds keep BF default (80). BF 4.5 scale: 0-250.

/** BF 4.5 default anti_gravity_gain */
export const ANTI_GRAVITY_GAIN_DEFAULT = 80;

/** Weight threshold (grams) above which anti-gravity increase is recommended.
 * Community presets only raise anti-gravity on genuinely heavy craft:
 * SupaflyFPV 7" = 120, UAV Tech 8-9" cinelifter = 110 — their 5" presets
 * keep the default 80. 700 g excludes typical 5" freestyle builds (~650 g). */
export const ANTI_GRAVITY_WEIGHT_THRESHOLD_G = 700;

/** Recommended anti-gravity gain for heavy builds (>700g with high SSE) */
export const ANTI_GRAVITY_HEAVY_RECOMMENDED = 120;

/** Recommended anti-gravity gain for medium builds (>700g without high SSE) */
export const ANTI_GRAVITY_MEDIUM_RECOMMENDED = 110;

/** Minimum mean steady-state error (%) across roll+pitch to trigger heavy recommendation */
export const ANTI_GRAVITY_SSE_THRESHOLD = 3.0;

/** Current anti_gravity_gain must be below this to trigger recommendation */
export const ANTI_GRAVITY_LOW_THRESHOLD = 100;

// ---- Thrust Linearization ----
// Source: docs/PID_TUNING_KNOWLEDGE.md Section 10 (SupaflyFPV 4.5 presets)
// Compensates for non-linear motor/ESC thrust curve. Larger props have more
// linear thrust curves → less linearization needed.

/** Thrust linearization recommended values by drone size. */
export const THRUST_LINEAR_BY_SIZE: Partial<Record<DroneSize, number>> = {
  '3"': 40,
  '4"': 40,
  '5"': 30,
  '6"': 20,
  '7"': 10,
};

/** Deviation threshold (fraction) from size-appropriate value to trigger advisory */
export const THRUST_LINEAR_DEVIATION_THRESHOLD = 0.5; // 50%

// ---- RPM Filter Q Tuning ----
// Source: docs/PID_TUNING_KNOWLEDGE.md Section 2 (Community Presets: SupaflyFPV, UAV Tech)
// Lower Q = wider notch = catches more noise but adds delay.
// Smaller motors have narrower harmonic spread → higher Q (narrower notch) is fine.
// Larger props spread harmonics wider → need lower Q (wider notch).

/** RPM filter Q range by drone size. midpoint is used for recommendations. */
export interface RpmFilterQRange {
  min: number;
  max: number;
  midpoint: number;
}

/**
 * Size-based RPM filter Q lookup table.
 * Sizes map to categories: micro (1-2.5"), small (3-4"), standard (5"), large (6-7").
 * Values from PID_TUNING_KNOWLEDGE.md Section 2.
 */
export const RPM_FILTER_Q_BY_SIZE: Record<DroneSize, RpmFilterQRange> = {
  '1"': { min: 700, max: 1000, midpoint: 850 },
  '2.5"': { min: 700, max: 1000, midpoint: 850 },
  // SupaflyFPV EasyTune presets set rpm_filter_q = 1000 for 3-4"
  '3"': { min: 700, max: 1000, midpoint: 850 },
  '4"': { min: 700, max: 1000, midpoint: 850 },
  '5"': { min: 700, max: 1000, midpoint: 850 },
  '6"': { min: 600, max: 800, midpoint: 700 },
  '7"': { min: 500, max: 700, midpoint: 600 },
};

/** Deviation threshold (fraction) from size-appropriate Q to trigger recommendation */
export const RPM_FILTER_Q_DEVIATION_THRESHOLD = 0.2; // 20%

// ---- D-term LPF Dynamic Expo ----
// Source: docs/PID_TUNING_KNOWLEDGE.md Section 10 (Karate Race presets)
// Higher expo = LPF cutoff rises faster with throttle = less D filtering at high throttle.
// Racing benefits from minimal D-term latency at high throttle.

/** D-term LPF dynamic expo ranges by flight style */
export const DTERM_DYN_EXPO_BY_STYLE: Record<FlightStyle, { min: number; max: number }> = {
  smooth: { min: 3, max: 5 },
  balanced: { min: 5, max: 5 },
  aggressive: { min: 7, max: 10 },
};

/** BF default dterm_lpf1_dyn_expo */
export const DTERM_DYN_EXPO_DEFAULT = 5;

// ---- Dynamic Lowpass Base Frequencies ----
// Note: a per-size multiplier table (DYNAMIC_LOWPASS_BY_SIZE) used to live here
// but was never wired into any recommendation path, and current SupaflyFPV
// presets disable gyro LPF1 entirely with RPM filtering — removed as dead code.

/** BF simplified tuning base frequencies (max = 2 × min per BF convention) */
export const BF_GYRO_LPF1_DYN_BASE_HZ = 250;
export const BF_DTERM_LPF1_DYN_BASE_HZ = 75;

/** Dynamic lowpass ratio: max = min × this value (BF always uses 2:1) */
export const DYNAMIC_LOWPASS_RATIO = 2;

// ---- PID Sum Limit Advisory ----
// Source: docs/PID_TUNING_KNOWLEDGE.md Section 10
// UAV Tech universally sets both to 1000. Karate Race: yaw limit 1000.

/** BF default pidsum_limit (maximum combined PID output per axis) */
export const PIDSUM_LIMIT_DEFAULT = 500;

/** BF default pidsum_limit_yaw */
export const PIDSUM_LIMIT_YAW_DEFAULT = 400;

/** Recommended pidsum_limit for heavy/powerful builds */
export const PIDSUM_LIMIT_RECOMMENDED = 1000;

/** Recommended pidsum_limit_yaw for heavy/powerful builds */
export const PIDSUM_LIMIT_YAW_RECOMMENDED = 1000;

/** Drone weight threshold (grams AUW) above which higher pidsum_limit is recommended */
export const PIDSUM_LIMIT_WEIGHT_THRESHOLD_G = 800;

// ---- Feedforward Max Rate Limit Advisory ----
// Source: docs/PRESET_GAP_ANALYSIS.md Task 11 (community preset analysis)
// Karate Race: 100, ctzsnooze/AOS: 95. Default: 90.

/** BF default feedforward_max_rate_limit */
export const FF_MAX_RATE_LIMIT_DEFAULT = 90;

/** Recommended feedforward_max_rate_limit for racing */
export const FF_MAX_RATE_LIMIT_RACE_RECOMMENDED = 100;

// ---- D-Min Per-Size Defaults ----
// Source: BF wiki D_MIN guide, community presets (BF defaults, Karate Race)
// Freestyle: d_min close to D, gain 30-35. Racing: gain 20.

export interface DMinSizeProfile {
  /** d_min_roll (0 = disabled) */
  roll: number;
  /** d_min_pitch */
  pitch: number;
  /** d_min_boost_gain (how fast D ramps up during propwash/stick input) */
  gain: number;
  /** Style-aware gain targets (overrides `gain` when flight style is known) */
  gainByStyle?: Partial<Record<FlightStyle, number>>;
}

export const DMIN_BY_SIZE: Record<DroneSize, DMinSizeProfile> = {
  '1"': { roll: 20, pitch: 22, gain: 20 },
  '2.5"': { roll: 22, pitch: 24, gain: 20 },
  '3"': { roll: 25, pitch: 27, gain: 25 },
  '4"': { roll: 27, pitch: 30, gain: 30 },
  '5"': {
    roll: 30,
    pitch: 34,
    gain: 30,
    gainByStyle: { smooth: 20, balanced: 25, aggressive: 30 },
  },
  '6"': {
    roll: 30,
    pitch: 34,
    gain: 25,
    gainByStyle: { smooth: 15, balanced: 20, aggressive: 25 },
  },
  '7"': { roll: 28, pitch: 32, gain: 20 },
};

/** BF default d_min_gain */
export const DMIN_GAIN_DEFAULT = 20;

/** Freestyle-recommended d_min_gain (more aggressive propwash D boost) */
export const DMIN_GAIN_FREESTYLE = 35;

/** Minimum d_min/d_max gap as fraction of d_max (below this = not enough propwash headroom) */
export const DMIN_GAP_MIN_FRACTION = 0.2;

/** d_min_advance: BF default is 20. 0 is better for most quads per BF wiki, but we use the BF default as reference. */
export const DMIN_ADVANCE_DEFAULT = 20;

// ---- Propwash I-term Relax ----

/** Propwash-specific iterm_relax cutoff reduction (lower = more I suppression during oscillation) */
export const PROPWASH_IRELAX_CUTOFF_REDUCTION = 5;

/** Minimum iterm_relax_cutoff floor for moderate propwash (won't reduce below this) */
export const PROPWASH_IRELAX_CUTOFF_FLOOR = 15;

/** Floor for iterm_relax_cutoff when propwash is severe (≥5×).
 * Allows progressive reduction per community guidance: "reduce 15 → 10 → 7 → 5" */
export const PROPWASH_IRELAX_CUTOFF_FLOOR_SEVERE = 7;

// ---- Propwash TPA ----

/** Minimum TPA breakpoint when propwash is severe (don't attenuate D during climb-out) */
export const PROPWASH_TPA_BREAKPOINT_MIN = 1300;

/** Maximum TPA rate when propwash is severe (preserve D damping) */
export const PROPWASH_TPA_RATE_MAX = 65;

// ---- TPA (Throttle PID Attenuation) Advisory ----
// Source: docs/PID_TUNING_KNOWLEDGE.md Section 10
// Community preset values by size and author.

/** TPA mode values: 0 = D-only (BF default), 1 = PD (attenuates both P and D) */
export const TPA_MODE_D_ONLY = 0;
export const TPA_MODE_PD = 1;

/** TPA settings by drone size category.
 * Larger quads need more TPA (higher rate, lower breakpoint) because
 * high-throttle noise is more pronounced on bigger props.
 * Source: SupaflyFPV 4.5 presets, Karate Race, BF defaults. */
export interface TPASizeProfile {
  /** Recommended tpa_rate (0-250) */
  rate: number;
  /** Recommended tpa_breakpoint (throttle value, 0-2000) */
  breakpoint: number;
  /** Recommended tpa_mode (0=D, 1=PD) */
  mode: number;
}

export const TPA_BY_SIZE: Record<string, TPASizeProfile> = {
  // Whoop/tiny presets (whoop_justice, whoop_ayyykayyy, tiny_karate) keep rate
  // near default but lower the breakpoint to ~1250.
  small: { rate: 50, breakpoint: 1250, mode: TPA_MODE_D_ONLY },
  standard: { rate: 65, breakpoint: 1350, mode: TPA_MODE_D_ONLY },
  large: { rate: 80, breakpoint: 1250, mode: TPA_MODE_D_ONLY },
};

/**
 * Map drone sizes to TPA size categories.
 * 1-4" → small, 5" → standard, 6-7" → large.
 */
export const TPA_SIZE_CATEGORY: Record<DroneSize, keyof typeof TPA_BY_SIZE> = {
  '1"': 'small',
  '2.5"': 'small',
  '3"': 'small',
  '4"': 'small',
  '5"': 'standard',
  '6"': 'large',
  '7"': 'large',
};

/** Minimum deviation (fraction) from size-appropriate TPA settings (rate/breakpoint) to trigger recommendation */
export const TPA_RATE_DEVIATION_THRESHOLD = 0.3; // 30%

/** Noise increase (dB) from DynamicLowpassAnalysis above which TPA mode PD is suggested
 * for standard 5" quads. SupaflyFPV 5" uses PD mode; 6-7" stays D-only. */
export const TPA_SEVERE_NOISE_INCREASE_DB = 10;
