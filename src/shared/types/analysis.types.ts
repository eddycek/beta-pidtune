/**
 * Types for FFT-based noise analysis, filter tuning, and PID step-response analysis.
 */

import type { PIDConfiguration } from './pid.types';
import type { FlightStyle } from './profile.types';

/** Power spectrum for one axis */
export interface PowerSpectrum {
  /** Frequency bins in Hz */
  frequencies: Float64Array;
  /** Magnitude values in dB */
  magnitudes: Float64Array;
}

/** A detected noise peak */
export interface NoisePeak {
  /** Peak frequency in Hz */
  frequency: number;
  /** Amplitude above local noise floor in dB */
  amplitude: number;
  /** Classification of peak source */
  type: 'frame_resonance' | 'motor_harmonic' | 'electrical' | 'unknown';
  /** How the classification was determined. 'throttle_track' = the peak's
   * frequency was regressed against throttle bands (definitive: tracks
   * throttle = motor, stationary = frame/electrical); 'heuristic' = the
   * whole-flight equal-spacing/band fallback. */
  classifiedBy?: 'throttle_track' | 'heuristic';
  /** Measured frequency track across throttle bands (motor harmonics only) —
   * feeds RPM-filter recommendations */
  throttleTrack?: { throttleMid: number[]; frequencyHz: number[] };
}

/** Noise characteristics for one axis */
export interface AxisNoiseProfile {
  /** Power spectrum data */
  spectrum: PowerSpectrum;
  /** Overall noise floor in dB */
  noiseFloorDb: number;
  /** Detected noise peaks */
  peaks: NoisePeak[];
}

/** Overall noise assessment across all axes */
export interface NoiseProfile {
  roll: AxisNoiseProfile;
  pitch: AxisNoiseProfile;
  yaw: AxisNoiseProfile;
  /** Summary noise level */
  overallLevel: 'low' | 'medium' | 'high';
}

/** A single filter recommendation */
export interface FilterRecommendation {
  /** Betaflight CLI setting name (e.g. "gyro_lpf1_static_hz") */
  setting: string;
  /** Current value on the FC */
  currentValue: number;
  /** Recommended new value */
  recommendedValue: number;
  /** Beginner-friendly explanation */
  reason: string;
  /** What this change affects */
  impact: 'latency' | 'noise' | 'both';
  /** How confident the recommendation is */
  confidence: 'high' | 'medium' | 'low';
  /** Structured rule identifier for telemetry tracking (e.g. "F-NF-H-GYRO") */
  ruleId?: string;
  /** When true, this recommendation is advisory-only (informational, not auto-applied) */
  informational?: boolean;
}

/** Data quality score for analysis input data */
export interface DataQualityScore {
  /** Overall quality score 0-100 */
  overall: number;
  /** Quality tier derived from overall score */
  tier: 'excellent' | 'good' | 'fair' | 'poor';
  /** Individual sub-scores that make up the overall score */
  subScores: DataQualitySubScore[];
}

/** A sub-score contributing to the overall data quality */
export interface DataQualitySubScore {
  /** Human-readable name of this metric */
  name: string;
  /** Score 0-100 */
  score: number;
  /** Weight in the overall score (0-1) */
  weight: number;
}

/** A warning about data quality or configuration issues */
export interface AnalysisWarning {
  code:
    | 'low_logging_rate'
    | 'wrong_debug_mode'
    | 'no_sweep_segments'
    | 'few_steps'
    | 'feedforward_active'
    | 'short_hover_time'
    | 'few_segments'
    | 'narrow_throttle_coverage'
    | 'few_steps_per_axis'
    | 'missing_axis_coverage'
    | 'low_step_magnitude'
    | 'tpa_variance'
    | 'low_coherence'
    | 'verification_dissimilar_throttle'
    | 'verification_dissimilar_peaks'
    | 'verification_dissimilar_segments'
    | 'verification_dissimilar_steps'
    | 'verification_dissimilar_activity'
    | 'verification_rejected'
    | 'flat_step_response'
    | 'step_deconv_disagreement';
  message: string;
  severity: 'info' | 'warning' | 'error';
}

// ---- Verification Similarity Types ----

/** Sub-score for verification similarity matching */
export interface SimilaritySubScore {
  name: string;
  score: number;
  weight: number;
}

/** Result of comparing verification flight to initial analysis flight */
export interface VerificationSimilarity {
  /** Overall similarity score 0-100 */
  score: number;
  /** Classification tier */
  tier: 'good' | 'marginal' | 'poor';
  /** Action recommendation for the UI */
  recommendation: 'accept' | 'warn' | 'reject_reflight';
  /** Per-metric sub-scores */
  subScores: SimilaritySubScore[];
  /** Human-readable warnings */
  warnings: AnalysisWarning[];
}

/** Reference context from initial analysis for verification matching */
export interface VerificationReferenceContext {
  /** Noise profile from initial analysis (Filter/Flash) */
  noiseProfile?: NoiseProfile;
  /** Segments from initial analysis (Filter/Flash) */
  segments?: FlightSegment[];
  /** PID metrics from initial analysis (PID) */
  pidMetrics?: import('./tuning-history.types').PIDMetricsSummary;
  /** Transfer function metrics from initial analysis (Flash) */
  transferFunctionMetrics?: import('./tuning-history.types').TransferFunctionMetricsSummary;
}

// ---- Convergence Detection Types ----

/** Per-metric convergence detail */
export interface ConvergenceDetail {
  metric: string;
  initialValue: number;
  verificationValue: number;
  delta: number;
  unit: string;
}

/** Previous session snapshot for cross-session convergence comparison */
export interface PreviousSessionSnapshot {
  /** When the previous session was completed */
  completedAt: string;
  /** Worst-axis noise floor from filter/flash analysis (dB) */
  noiseFloorDb?: number;
  /** Worst-axis overshoot from PID analysis (%) */
  overshootPct?: number;
  /** Worst-axis bandwidth from flash analysis (Hz) */
  bandwidthHz?: number;
}

/** Result of convergence detection between initial and verification analysis */
export interface ConvergenceResult {
  /** Whether tuning has converged */
  status: 'converged' | 'diminishing_returns' | 'continue';
  /** Actual improvement measured (primary metric) */
  improvementDelta: number;
  /** Minimum delta considered meaningful */
  meaningfulThreshold: number;
  /** Human-readable recommendation */
  message: string;
  /** Per-metric details */
  details: ConvergenceDetail[];
  /** Previous session metrics for cross-session comparison (any time range) */
  previousSession?: PreviousSessionSnapshot;
}

/** Complete filter analysis result */
export interface FilterAnalysisResult {
  /** Noise profile for all axes */
  noise: NoiseProfile;
  /** List of filter tuning recommendations */
  recommendations: FilterRecommendation[];
  /** 1-2 sentence summary for beginners */
  summary: string;
  /** Time taken for analysis in ms */
  analysisTimeMs: number;
  /** Which session was analyzed */
  sessionIndex: number;
  /** How many steady flight segments were used */
  segmentsUsed: number;
  /** Whether RPM filter is active (detected from FC settings or BBL headers) */
  rpmFilterActive?: boolean;
  /** Data quality warnings */
  warnings?: AnalysisWarning[];
  /** Data quality score for the input flight data */
  dataQuality?: DataQualityScore;
  /** Throttle-indexed spectrogram (noise vs throttle level) */
  throttleSpectrogram?: ThrottleSpectrogramResult;
  /** Estimated group delay of the current filter chain */
  groupDelay?: FilterGroupDelay;
  /** Wind/disturbance detection result */
  windDisturbance?: WindDisturbanceResult;
  /** Mechanical health diagnostic result */
  mechanicalHealth?: MechanicalHealthResult;
  /** Dynamic lowpass analysis (throttle-dependent noise) */
  dynamicLowpass?: DynamicLowpassAnalysis;
  /** Filter settings the analysis ran against (post BBL-header enrichment) —
   * lets the renderer overlay the configured filter response on spectra */
  filterSettings?: CurrentFilterSettings;
  /** Verification flight similarity (only present when analyzing verification log with reference context) */
  verificationSimilarity?: VerificationSimilarity;
}

// ---- Throttle Spectrogram Types ----

/** A single throttle band with its per-axis noise spectra */
export interface ThrottleBand {
  /** Lower bound of this throttle band (0-1 range) */
  throttleMin: number;
  /** Upper bound of this throttle band (0-1 range) */
  throttleMax: number;
  /** Number of gyro samples that fell into this band */
  sampleCount: number;
  /** Per-axis power spectra [roll, pitch, yaw] (undefined if too few samples) */
  spectra?: [PowerSpectrum, PowerSpectrum, PowerSpectrum];
  /** Per-axis noise floor in dB [roll, pitch, yaw] */
  noiseFloorDb?: [number, number, number];
}

/** Complete throttle spectrogram result */
export interface ThrottleSpectrogramResult {
  /** Throttle bands from low to high */
  bands: ThrottleBand[];
  /** Number of bands requested */
  numBands: number;
  /** Minimum samples required per band for FFT */
  minSamplesPerBand: number;
  /** Number of bands with sufficient data for spectra */
  bandsWithData: number;
}

// ---- Filter Group Delay Types ----

/** Group delay estimate for a single filter */
export interface SingleFilterDelay {
  /** Filter type identifier */
  type: 'gyro_lpf1' | 'gyro_lpf2' | 'dterm_lpf1' | 'dterm_lpf2' | 'dyn_notch';
  /** Cutoff frequency in Hz */
  cutoffHz: number;
  /** Estimated group delay at a reference frequency in ms */
  delayMs: number;
}

/** Combined group delay estimate for the full filter chain */
export interface FilterGroupDelay {
  /** Individual filter delays */
  filters: SingleFilterDelay[];
  /** Total estimated delay of the gyro filter chain in ms */
  gyroTotalMs: number;
  /** Total estimated delay of the D-term filter chain in ms */
  dtermTotalMs: number;
  /** Reference frequency used for delay computation (Hz) */
  referenceFreqHz: number;
  /** Warning if total delay exceeds a safe threshold */
  warning?: string;
  /** Per-size latency budget for the gyro chain in ms (P2.7) */
  gyroBudgetMs?: number;
  /** Per-size latency budget for the D-term chain in ms (P2.7) */
  dtermBudgetMs?: number;
  /** True when the gyro chain delay exceeds its budget */
  gyroOverBudget?: boolean;
  /** True when the D-term chain delay exceeds its budget */
  dtermOverBudget?: boolean;
}

/** A steady flight segment identified from throttle/gyro data */
export interface FlightSegment {
  /** Start sample index in the time series */
  startIndex: number;
  /** End sample index (exclusive) */
  endIndex: number;
  /** Duration in seconds */
  durationSeconds: number;
  /** Mean throttle value in this segment (0-1 range) */
  averageThrottle: number;
  /** Minimum throttle value in this segment (0-1 range) */
  minThrottle: number;
  /** Maximum throttle value in this segment (0-1 range) */
  maxThrottle: number;
}

/** Progress during analysis pipeline */
export interface AnalysisProgress {
  /** Current pipeline step */
  step: 'segmenting' | 'fft' | 'analyzing' | 'recommending' | 'detecting' | 'measuring' | 'scoring';
  /** Completion percentage (0-100) */
  percent: number;
}

/** Input for filter analysis - current filter settings from the FC */
export interface CurrentFilterSettings {
  /** Gyro lowpass 1 cutoff in Hz (0 = disabled) */
  gyro_lpf1_static_hz: number;
  /** Gyro lowpass 2 cutoff in Hz (0 = disabled) */
  gyro_lpf2_static_hz: number;
  /** D-term lowpass 1 cutoff in Hz (0 = disabled) */
  dterm_lpf1_static_hz: number;
  /** D-term lowpass 2 cutoff in Hz (0 = disabled) */
  dterm_lpf2_static_hz: number;
  /** Dynamic notch filter minimum Hz */
  dyn_notch_min_hz: number;
  /** Dynamic notch filter maximum Hz */
  dyn_notch_max_hz: number;

  /** RPM filter harmonics count (0 = disabled, 1-3 = active). Undefined if not read. */
  rpm_filter_harmonics?: number;
  /** RPM filter minimum frequency in Hz */
  rpm_filter_min_hz?: number;
  /** Dynamic notch count (1-5) */
  dyn_notch_count?: number;
  /** Dynamic notch Q factor */
  dyn_notch_q?: number;
  /** RPM filter Q (notch bandwidth). Undefined if not read. */
  rpm_filter_q?: number;
  /** RPM filter fade range in Hz below min_hz where notches fade out (CLI-only, BBL header). */
  rpm_filter_fade_range_hz?: number;
  /** Per-harmonic RPM notch weights in percent, e.g. [100, 50, 100] (BF 4.5+, BBL header). */
  rpm_filter_weights?: number[];
  /** Dynamic idle minimum RPM in hundreds (value × 100 = RPM; 0 = disabled). From BBL header. */
  dyn_idle_min_rpm?: number;

  /** Gyro LPF1 dynamic minimum Hz (>0 means dynamic gyro LPF is active) */
  gyro_lpf1_dyn_min_hz?: number;
  /** Gyro LPF1 dynamic maximum Hz */
  gyro_lpf1_dyn_max_hz?: number;
  /** D-term LPF1 dynamic minimum Hz (>0 means dynamic D-term LPF is active) */
  dterm_lpf1_dyn_min_hz?: number;
  /** D-term LPF1 dynamic maximum Hz */
  dterm_lpf1_dyn_max_hz?: number;
  /** D-term LPF1 dynamic expo (0-10, controls how aggressively dynamic LPF tracks throttle) */
  dterm_lpf1_dyn_expo?: number;
  /** Gyro LPF1 dynamic expo (0-10, BF default 5). From BBL header. */
  gyro_lpf1_dyn_expo?: number;

  /** Gyro LPF1 filter type: 0=PT1, 1=BIQUAD, 2=PT2, 3=PT3 */
  gyro_lpf1_type?: number;
  /** D-term LPF1 filter type: 0=PT1, 1=BIQUAD, 2=PT2, 3=PT3 */
  dterm_lpf1_type?: number;
  /** Gyro LPF2 filter type */
  gyro_lpf2_type?: number;
  /** D-term LPF2 filter type */
  dterm_lpf2_type?: number;
}

/** Default filter settings (Betaflight 4.4+ defaults) */
export const DEFAULT_FILTER_SETTINGS: CurrentFilterSettings = {
  gyro_lpf1_static_hz: 250,
  gyro_lpf2_static_hz: 500,
  dterm_lpf1_static_hz: 150,
  dterm_lpf2_static_hz: 150,
  dyn_notch_min_hz: 100,
  dyn_notch_max_hz: 600,
  gyro_lpf1_dyn_min_hz: 0,
  gyro_lpf1_dyn_max_hz: 0,
  dterm_lpf1_dyn_min_hz: 0,
  dterm_lpf1_dyn_max_hz: 0,
};

/** Feedforward state detected from BBL headers */
export interface FeedforwardContext {
  /** Whether FF is meaningfully active (any axis has F > 0 or boost > 0) */
  active: boolean;
  /** Per-axis F gains (if available) */
  fGains?: { roll: number; pitch: number; yaw: number };
  /** FF boost value */
  boost?: number;
  /** FF max rate limit */
  maxRateLimit?: number;
  /** FF smooth factor (0-75, higher = more smoothing of FF output) */
  smoothFactor?: number;
  /** FF jitter factor (0-20, attenuates FF on small stick inputs) */
  jitterFactor?: number;
  /** FF averaging mode (0=OFF, 2=2_POINT, 3=3_POINT, 4=4_POINT) */
  averaging?: number;
  /** Detected RC link rate in Hz (from BBL header or frame timing) */
  rcLinkRateHz?: number;
  /** rc_smoothing_auto_factor value (BF default 30) */
  rcSmoothingAutoFactor?: number;
}

/** Extended feedforward analysis result */
export interface FeedforwardAnalysis {
  /** Whether FF-specific tuning opportunities were found */
  hasRecommendations: boolean;
  /** Leading-edge overshoot ratio (0-20ms vs 20-100ms). >1 = spike-dominated */
  leadingEdgeRatio: number;
  /** Small-step (<30% stick) mean FF overshoot relative to large-step mean */
  smallStepOvershootRatio: number;
  /** Number of small steps analyzed */
  smallStepCount: number;
  /** Number of large steps analyzed */
  largeStepCount: number;
  /** Detected RC link rate in Hz (undefined if not available) */
  rcLinkRateHz?: number;
  /** Human-readable summary */
  summary: string;
}

// ---- PID Step Response Analysis Types ----

/** Raw trace data for visualization of a single step response */
export interface StepResponseTrace {
  /** Time relative to step start in ms */
  timeMs: number[];
  /** Setpoint values (deg/s) */
  setpoint: number[];
  /** Gyro response values (deg/s) */
  gyro: number[];
}

/** A detected step input event in the setpoint */
export interface StepEvent {
  /** Axis index: 0=roll, 1=pitch, 2=yaw */
  axis: 0 | 1 | 2;
  /** Sample index where the step begins */
  startIndex: number;
  /** Sample index for the end of the response window */
  endIndex: number;
  /** Step size in deg/s */
  magnitude: number;
  /** Direction of the step */
  direction: 'positive' | 'negative';
}

/** Metrics extracted from a single step response */
export interface StepResponse {
  /** The step event this response corresponds to */
  step: StepEvent;
  /** Time from 10% to 90% of final value in ms */
  riseTimeMs: number;
  /** (peak - target) / target * 100 */
  overshootPercent: number;
  /** Time to stay within +/-2% of target in ms */
  settlingTimeMs: number;
  /** Delay from setpoint change to first gyro movement in ms */
  latencyMs: number;
  /** Number of oscillations before settling */
  ringingCount: number;
  /** Absolute max gyro value in response window */
  peakValue: number;
  /** Final settled gyro value */
  steadyStateValue: number;
  /** Raw trace data for chart visualization */
  trace?: StepResponseTrace;
  /** Whether overshoot is dominated by feedforward (|pidF| > |pidP| at peak) */
  ffDominated?: boolean;
  /** Energy ratio of FF vs PID-P over the response window (0-1, higher = more FF) */
  ffEnergyRatio?: number;
  /** RMS of (setpoint−gyro)/|magnitude| over the response window (dimensionless) */
  trackingErrorRMS?: number;
  /** Mean |setpoint−gyro|/|magnitude| during hold phase (last 20% of window), as percentage */
  steadyStateErrorPercent?: number;
  /** Overshoot in the leading edge (0-20ms after step) — used for ff_smooth_factor analysis */
  leadingEdgeOvershootPercent?: number;
}

/** Aggregated step response metrics for one axis */
export interface AxisStepProfile {
  /** Individual step responses */
  responses: StepResponse[];
  /** Mean overshoot percentage across all steps */
  meanOvershoot: number;
  /** Mean rise time in ms */
  meanRiseTimeMs: number;
  /** Mean settling time in ms */
  meanSettlingTimeMs: number;
  /** Mean latency in ms */
  meanLatencyMs: number;
  /** Mean tracking error RMS across all steps (dimensionless) */
  meanTrackingErrorRMS: number;
  /** Mean steady-state error during hold phase across all steps (percentage) */
  meanSteadyStateError: number;
  /** Mean FF energy ratio across steps that have ffEnergyRatio (0-1) */
  meanFFEnergyRatio?: number;
  /** Where the headline overshoot/rise/settling numbers came from.
   * 'deconvolved' = Wiener-stacked step response (preferred when coherent);
   * 'per_step' = arithmetic mean of individually measured steps (fallback). */
  metricsSource?: 'deconvolved' | 'per_step';
  /** Per-step means kept for cross-checking when metricsSource='deconvolved' */
  perStepMetrics?: {
    meanOvershoot: number;
    meanRiseTimeMs: number;
    meanSettlingTimeMs: number;
  };
  /** Deconvolved step response split by commanded input magnitude
   * (Betaflight's FF/D-setpoint transition behaves differently below vs
   * above the split threshold, so the two regimes are measured separately) */
  inputSplit?: {
    splitThresholdDegS: number;
    low?: DeconvolvedStepMetrics;
    high?: DeconvolvedStepMetrics;
  };
}

/** Metrics of a Wiener-deconvolved (stacked) step response */
export interface DeconvolvedStepMetrics {
  overshootPercent: number;
  riseTimeMs: number;
  settlingTimeMs: number;
  /** Number of Welch windows stacked into this estimate */
  windowCount: number;
  /** Mean setpoint→gyro coherence over the stick band (0-1) */
  coherenceMean?: number;
  /** Normalized synthetic step response for chart rendering */
  stepResponse?: { timeMs: number[]; response: number[] };
}

/** A single PID recommendation */
export interface PIDRecommendation {
  /** Betaflight CLI setting name (e.g. "pid_roll_d") */
  setting: string;
  /** Current value on the FC */
  currentValue: number;
  /** Recommended new value */
  recommendedValue: number;
  /** Beginner-friendly explanation */
  reason: string;
  /** What aspect this affects */
  impact: 'response' | 'stability' | 'both';
  /** How confident the recommendation is */
  confidence: 'high' | 'medium' | 'low';
  /** When true, this is an advisory — recommendedValue equals currentValue (no change).
   * UI should display as a note/warning, not as an actionable recommendation. */
  informational?: boolean;
  /** Structured rule identifier for telemetry tracking (e.g. "P-OS-D-roll") */
  ruleId?: string;
}

/** Bayesian optimizer suggestion for next PID gains to try */
export interface BayesianSuggestion {
  /** Suggested PID gains [P, I, D] */
  gains: [number, number, number];
  /** Expected improvement over current best */
  expectedImprovement: number;
  /** Confidence in the suggestion */
  confidence: 'high' | 'medium' | 'low';
}

/** Complete PID analysis result */
export interface PIDAnalysisResult {
  /** Step response profile for roll axis */
  roll: AxisStepProfile;
  /** Step response profile for pitch axis */
  pitch: AxisStepProfile;
  /** Step response profile for yaw axis */
  yaw: AxisStepProfile;
  /** PID tuning recommendations */
  recommendations: PIDRecommendation[];
  /** 1-2 sentence summary for beginners */
  summary: string;
  /** Time taken for analysis in ms */
  analysisTimeMs: number;
  /** Which session was analyzed */
  sessionIndex: number;
  /** Total steps detected across all axes */
  stepsDetected: number;
  /** Current PID configuration used for analysis */
  currentPIDs: PIDConfiguration;
  /** Feedforward context detected from flight log */
  feedforwardContext?: FeedforwardContext;
  /** Flying style used for threshold calibration */
  flightStyle?: FlightStyle;
  /** Data quality warnings */
  warnings?: AnalysisWarning[];
  /** Data quality score for the input flight data */
  dataQuality?: DataQualityScore;
  /** Which analysis method was used to produce PID recommendations */
  analysisMethod?: 'step_response' | 'wiener_deconvolution';
  /** Cross-axis coupling analysis */
  crossAxisCoupling?: CrossAxisCoupling;
  /** Prop wash analysis results */
  propWash?: PropWashAnalysis;
  /** Bayesian optimizer suggestion for next PID gains */
  bayesianSuggestion?: BayesianSuggestion;
  /** D-term effectiveness analysis */
  dTermEffectiveness?: DTermEffectiveness;
  /** Current PID gains mapped to BF Configurator slider positions */
  sliderPosition?: SliderPosition;
  /** Slider change summary when recommendations are applied */
  sliderDelta?: { masterMultiplierDelta: number; pdRatioDelta: number; summary: string };
  /** Extended feedforward analysis (leading-edge, jitter, RC rate) */
  feedforwardAnalysis?: FeedforwardAnalysis;
  /** Per-band transfer function analysis across throttle levels (Flash Tune only) */
  throttleTF?: {
    bands: {
      throttleMin: number;
      throttleMax: number;
      sampleCount: number;
      metrics: {
        bandwidthHz: number;
        phaseMarginDeg: number;
        gainMarginDb: number;
        overshootPercent: number;
        settlingTimeMs: number;
        riseTimeMs: number;
        dcGainDb: number;
      } | null;
    }[];
    bandsWithData: number;
    metricsVariance: {
      bandwidthHz: number;
      overshootPercent: number;
      phaseMarginDeg: number;
    };
    /** Pitch-axis per-band analysis (P2.8) — same band/variance shape as roll */
    pitch?: {
      bands: {
        throttleMin: number;
        throttleMax: number;
        sampleCount: number;
        metrics: {
          bandwidthHz: number;
          phaseMarginDeg: number;
          gainMarginDb: number;
          overshootPercent: number;
          settlingTimeMs: number;
          riseTimeMs: number;
          dcGainDb: number;
        } | null;
      }[];
      bandsWithData: number;
      metricsVariance: {
        bandwidthHz: number;
        overshootPercent: number;
        phaseMarginDeg: number;
      };
    };
    tpaWarning?: string;
  };
  /** Full transfer function data (present only for Flash Tune / Wiener deconvolution analysis).
   * Arrays may be Float64Array (from main process) or number[] (after IPC serialization). */
  transferFunction?: {
    syntheticStepResponse: {
      roll: { timeMs: number[]; response: number[] };
      pitch: { timeMs: number[]; response: number[] };
      yaw: { timeMs: number[]; response: number[] };
    };
    roll: {
      frequencies: Float64Array | number[];
      magnitude: Float64Array | number[];
      phase: Float64Array | number[];
    };
    pitch: {
      frequencies: Float64Array | number[];
      magnitude: Float64Array | number[];
      phase: Float64Array | number[];
    };
    yaw: {
      frequencies: Float64Array | number[];
      magnitude: Float64Array | number[];
      phase: Float64Array | number[];
    };
  };
  /** Per-axis transfer function metrics (only present for Wiener deconvolution analysis) */
  transferFunctionMetrics?: {
    roll: AxisTransferFunctionMetrics;
    pitch: AxisTransferFunctionMetrics;
    yaw: AxisTransferFunctionMetrics;
  };
  /** Verification flight similarity (only present when analyzing verification log with reference context) */
  verificationSimilarity?: VerificationSimilarity;
}

/** Per-axis transfer function metrics (mirrors TransferFunctionEstimator.TransferFunctionMetrics) */
export interface AxisTransferFunctionMetrics {
  bandwidthHz: number;
  phaseMarginDeg: number;
  gainMarginDb: number;
  overshootPercent: number;
  settlingTimeMs: number;
  riseTimeMs: number;
  dcGainDb?: number;
  /** Mean setpoint→gyro coherence over the stick-input band (0-1) */
  coherenceMean?: number;
  /** False when the phase never crossed -180° (gainMarginDb is the cap) */
  gainMarginCrossingFound?: boolean;
  /** False when the gain never crossed 0 dB (phaseMarginDeg is the cap) */
  phaseMarginCrossingFound?: boolean;
}

// ---- D-Term Effectiveness Types ----

/** D-term effectiveness analysis result */
export interface DTermEffectiveness {
  /** Per-axis D-term effectiveness ratio (0-1) */
  roll: number;
  pitch: number;
  yaw: number;
  /** Overall effectiveness (weighted average of roll+pitch, yaw excluded) */
  overall: number;
  /** Whether D-term is critical for stability */
  dCritical: boolean;
}

// ---- Cross-Axis Coupling Types ----

/** Coupling between a specific pair of axes */
export interface AxisPairCoupling {
  /** Source axis (where the step input occurs) */
  sourceAxis: 'roll' | 'pitch' | 'yaw';
  /** Affected axis (where coupling oscillation appears) */
  affectedAxis: 'roll' | 'pitch' | 'yaw';
  /** Normalized correlation coefficient (0-1, where 0 = no coupling) */
  correlation: number;
  /** Rating based on correlation magnitude */
  rating: 'none' | 'mild' | 'significant';
}

/** Complete cross-axis coupling analysis */
export interface CrossAxisCoupling {
  /** All axis pair couplings */
  pairs: AxisPairCoupling[];
  /** Whether any significant coupling was detected */
  hasSignificantCoupling: boolean;
  /** Human-readable summary */
  summary: string;
}

// ---- Prop Wash Detection Types ----

/** A single detected prop wash event */
export interface PropWashEvent {
  /** Timestamp of throttle-down event in milliseconds from flight start */
  timestampMs: number;
  /** Rate of throttle decrease (units/s, negative) */
  throttleDropRate: number;
  /** Duration of prop wash oscillation in ms */
  durationMs: number;
  /** Dominant oscillation frequency in Hz */
  peakFrequencyHz: number;
  /** Ratio of prop wash band energy to baseline noise */
  severityRatio: number;
  /** Per-axis energy in the prop wash band */
  axisEnergy: { roll: number; pitch: number; yaw: number };
}

// ---- Slider Position Types ----

/** Per-axis PID slider multiplier */
export interface AxisSliderPosition {
  /** P multiplier relative to BF default */
  pMultiplier: number;
  /** I multiplier relative to BF default */
  iMultiplier: number;
  /** D multiplier relative to BF default */
  dMultiplier: number;
}

/** Slider-aligned representation of PID gains */
export interface SliderPosition {
  /** Master multiplier (1.0 = BF defaults) */
  masterMultiplier: number;
  /** P/D ratio relative to defaults (1.0 = default balance) */
  pdRatio: number;
  /** Per-axis slider summary */
  axes: {
    roll: AxisSliderPosition;
    pitch: AxisSliderPosition;
    yaw: AxisSliderPosition;
  };
  /** Human-readable summary */
  summary: string;
}

// ---- Dynamic Lowpass Analysis Types ----

/** Dynamic lowpass analysis result */
export interface DynamicLowpassAnalysis {
  /** Whether dynamic lowpass is recommended */
  recommended: boolean;
  /** Noise floor increase from low to high throttle bands (dB) */
  noiseIncreaseDeltaDb: number;
  /** Correlation between throttle and noise floor (0-1) */
  throttleNoiseCorrelation: number;
  /** Number of throttle bands analyzed */
  bandsAnalyzed: number;
  /** Human-readable summary */
  summary: string;
}

// ---- Mechanical Health Types ----

/** Severity of a mechanical health issue */
export type HealthSeverity = 'ok' | 'warning' | 'critical';

/** A detected mechanical health issue */
export interface MechanicalHealthIssue {
  /** Type of detected issue */
  type: 'extreme_noise' | 'axis_asymmetry' | 'motor_imbalance';
  /** Severity level */
  severity: HealthSeverity;
  /** Human-readable description */
  message: string;
  /** Affected axis or motor (if applicable) */
  affectedAxis?: 'roll' | 'pitch' | 'yaw';
  /** Measured value that triggered the issue */
  measuredValue: number;
  /** Threshold that was exceeded */
  threshold: number;
}

/** Mechanical health diagnostic result */
export interface MechanicalHealthResult {
  /** Overall health status */
  status: HealthSeverity;
  /** Detected issues (empty if healthy) */
  issues: MechanicalHealthIssue[];
  /** Per-axis noise floors used for diagnosis */
  noiseFloors: { roll: number; pitch: number; yaw: number };
  /** Per-motor variance during hover (if motor data available) */
  motorVariance?: [number, number, number, number];
  /** Human-readable summary */
  summary: string;
}

// ---- Wind Disturbance Detection Types ----

/** Disturbance level classification */
export type DisturbanceLevel = 'calm' | 'moderate' | 'windy';

/** Wind/disturbance detection result from gyro variance during hover */
export interface WindDisturbanceResult {
  /** Per-axis gyro variance during hover (deg/s²) */
  axisVariance: [number, number, number];
  /** Worst-case (maximum) variance across roll and pitch */
  worstVariance: number;
  /** Overall disturbance classification */
  level: DisturbanceLevel;
  /** Total hover time analyzed (seconds) */
  hoverDurationS: number;
  /** Number of hover samples used */
  hoverSampleCount: number;
  /** Human-readable summary */
  summary: string;
}

/** Complete prop wash analysis result */
export interface PropWashAnalysis {
  /** Detected prop wash events */
  events: PropWashEvent[];
  /** Average severity ratio across all events */
  meanSeverity: number;
  /** Axis with highest prop wash energy */
  worstAxis: 'roll' | 'pitch' | 'yaw';
  /** Most common peak frequency across events */
  dominantFrequencyHz: number;
  /** Human-readable recommendation */
  recommendation: string;
}
