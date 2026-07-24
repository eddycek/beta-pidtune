/**
 * Types for tuning history records — compact summaries of completed tuning sessions.
 *
 * These types store JSON-safe metrics (no Float64Array) for persistence and comparison.
 */

import type { AppliedChange, TuningType } from './tuning.types';
import type { PIDConfiguration, RatesConfiguration } from './pid.types';
import type { ConvergenceResult, VerificationSimilarity } from './analysis.types';

/** Downsampled power spectrum safe for JSON serialization (128 bins) */
export interface CompactSpectrum {
  /** Frequency bins in Hz */
  frequencies: number[];
  /** Roll axis magnitudes in dB */
  roll: number[];
  /** Pitch axis magnitudes in dB */
  pitch: number[];
  /** Yaw axis magnitudes in dB */
  yaw: number[];
}

/** Per-axis noise summary */
export interface AxisNoiseSummary {
  noiseFloorDb: number;
  peakCount: number;
}

/** Compact per-band throttle spectrogram data for history storage */
export interface CompactThrottleBand {
  throttleMin: number;
  throttleMax: number;
  /** Downsampled dB magnitudes per axis (same length as parent frequencies array) */
  roll: number[];
  pitch: number[];
  yaw: number[];
}

/** Compact throttle spectrogram safe for JSON serialization */
export interface CompactThrottleSpectrogram {
  /** Shared frequency bins in Hz (downsampled to ~120 bins) */
  frequencies: number[];
  /** Throttle bands with per-axis dB magnitudes */
  bands: CompactThrottleBand[];
  /** Number of bands that had sufficient data */
  bandsWithData: number;
}

/** Compact filter analysis metrics for history storage */
export interface FilterMetricsSummary {
  /** Overall noise level */
  noiseLevel: 'low' | 'medium' | 'high';
  /** Per-axis noise summaries */
  roll: AxisNoiseSummary;
  pitch: AxisNoiseSummary;
  yaw: AxisNoiseSummary;
  /** Number of flight segments used for analysis */
  segmentsUsed: number;
  /** Whether RPM filter was active */
  rpmFilterActive?: boolean;
  /** 1-2 sentence summary */
  summary: string;
  /** Optional downsampled spectrum for chart rendering */
  spectrum?: CompactSpectrum;
  /** Data quality score summary */
  dataQuality?: { overall: number; tier: string };
  /** Wind/disturbance level during hover segments */
  windDisturbance?: { level: string; worstVariance: number };
  /** Optional compact throttle spectrogram for heatmap rendering */
  throttleSpectrogram?: CompactThrottleSpectrogram;
  /** Spectrum scale version the dB values were measured on (see
   * SPECTRUM_SCALE_VERSION in shared/constants). Absent = legacy v1 scale
   * (≈10 dB below v2) — not directly comparable to v2 records. */
  spectrumScaleVersion?: number;
}

/** Compact per-axis PID step response metrics */
export interface AxisPIDSummary {
  meanOvershoot: number;
  meanRiseTimeMs: number;
  meanSettlingTimeMs: number;
  meanLatencyMs: number;
  meanTrackingErrorRMS?: number;
}

/** A single component contributing to the tune quality score */
export interface TuneQualityComponent {
  label: string;
  score: number;
  maxPoints: number;
  rawValue: number;
}

/** Overall tune quality score computed from filter + PID metrics */
export interface TuneQualityScore {
  overall: number;
  tier: 'excellent' | 'good' | 'fair' | 'poor';
  components: TuneQualityComponent[];
}

/** Compact PID analysis metrics for history storage */
export interface PIDMetricsSummary {
  /** Per-axis step response summaries */
  roll: AxisPIDSummary;
  pitch: AxisPIDSummary;
  yaw: AxisPIDSummary;
  /** Total steps detected across all axes */
  stepsDetected: number;
  /** PID values used during the flight */
  currentPIDs: PIDConfiguration;
  /** 1-2 sentence summary */
  summary: string;
  /** Data quality score summary */
  dataQuality?: { overall: number; tier: string };
  /** Best step response trace per axis (downsampled for history chart) */
  stepResponse?: CompactStepResponse;
}

/** Per-axis transfer function metrics summary for history storage */
export interface AxisTransferFunctionSummary {
  bandwidthHz: number;
  phaseMarginDeg: number;
  gainMarginDb: number;
  overshootPercent: number;
  settlingTimeMs: number;
  riseTimeMs: number;
  /** False when the gain never crossed 0 dB — phaseMarginDeg is the 90° cap,
   * not a measured margin. Absent on records from older app versions. */
  phaseMarginCrossingFound?: boolean;
}

/** Downsampled synthetic step response for history chart rendering */
export interface CompactStepResponse {
  timeMs: number[];
  roll: number[];
  pitch: number[];
  yaw: number[];
}

/** Compact transfer function metrics for history storage */
export interface TransferFunctionMetricsSummary {
  roll: AxisTransferFunctionSummary;
  pitch: AxisTransferFunctionSummary;
  yaw: AxisTransferFunctionSummary;
  /** Data quality score summary */
  dataQuality?: { overall: number; tier: string };
  /** Downsampled synthetic step response for history chart rendering */
  stepResponse?: CompactStepResponse;
  /** Throttle-band TF analysis summary (Flash Tune only) */
  throttleBands?: {
    bandsWithData: number;
    metricsVariance: { bandwidthHz: number; overshootPercent: number; phaseMarginDeg: number };
    tpaWarning?: string;
  };
  /** Per-axis DC gain from transfer function (dB) */
  dcGain?: { roll: number; pitch: number; yaw: number };
}

/** Compact metadata of a single recommendation for telemetry tracking */
export interface RecommendationTrace {
  ruleId: string;
  setting: string;
  confidence: 'high' | 'medium' | 'low';
  applied: boolean; // was this included in appliedChanges?
  delta: number; // recommendedValue - currentValue
  informational?: boolean;
}

/** Before/after verification delta for a tuning session */
export interface VerificationDelta {
  noiseFloorDeltaDb?: { roll: number; pitch: number; yaw: number };
  overshootDeltaPct?: { roll: number; pitch: number; yaw: number };
  riseTimeDeltaMs?: { roll: number; pitch: number; yaw: number };
  bandwidthDeltaHz?: { roll: number; pitch: number; yaw: number };
  phaseMarginDeltaDeg?: { roll: number; pitch: number; yaw: number };
  overallImprovement: number; // -100 to +100, positive = better
}

/** A completed tuning session archived for history/comparison */
export interface CompletedTuningRecord {
  /** Unique record ID */
  id: string;
  /** Profile this record belongs to */
  profileId: string;
  /** When the tuning session was started (ISO string) */
  startedAt: string;
  /** When the tuning session was completed (ISO string) */
  completedAt: string;

  /** Filter, PID, or Flash (quick) */
  tuningType: TuningType;

  /** Snapshot IDs (nullable — may not exist if skipped or deleted) */
  baselineSnapshotId: string | null;
  postFilterSnapshotId: string | null;
  postTuningSnapshotId: string | null;

  /** Log IDs (nullable) */
  filterLogId: string | null;
  pidLogId: string | null;
  quickLogId: string | null;
  verificationLogId: string | null;

  /** Applied changes */
  appliedFilterChanges: AppliedChange[];
  appliedPIDChanges: AppliedChange[];
  appliedFeedforwardChanges: AppliedChange[];

  /** Analysis metrics (nullable — may not have been computed) */
  filterMetrics: FilterMetricsSummary | null;
  pidMetrics: PIDMetricsSummary | null;
  verificationMetrics: FilterMetricsSummary | null;
  verificationPidMetrics: PIDMetricsSummary | null;

  /** Transfer function metrics from Wiener deconvolution (Quick Tune only) */
  transferFunctionMetrics: TransferFunctionMetricsSummary | null;

  /** Verification TF metrics (Flash Tune only — for before/after PID comparison) */
  verificationTransferFunctionMetrics?: TransferFunctionMetricsSummary | null;

  /** BF PID profile used in this tuning session (0-based) */
  bfPidProfileIndex?: number;

  /** App version that created this record (for debugging) */
  appVersion?: string;

  /** Per-recommendation metadata for telemetry tracking */
  recommendationTraces?: RecommendationTrace[];

  /** Before/after verification delta summary */
  verificationDelta?: VerificationDelta;

  /** Overall tune quality score (0-100) */
  qualityScore?: number;

  /** RC rates configuration at time of tuning (for telemetry correlation) */
  ratesConfig?: RatesConfiguration;

  /** Auto-generated diagnostic report ID (from apply verification failure) */
  autoReportId?: string;

  /** Convergence detection result (computed at verification completion) */
  convergence?: ConvergenceResult;

  /** Verification flight similarity score (computed at verification analysis) */
  verificationSimilarity?: VerificationSimilarity;

  /** Number of recent tuning iterations of this type (within lookback window) */
  iterationCount?: number;
}
