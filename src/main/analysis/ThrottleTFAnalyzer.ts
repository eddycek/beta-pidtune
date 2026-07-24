/**
 * Throttle-indexed transfer function analyzer.
 *
 * Bins flight data by throttle level and estimates TF (Wiener deconvolution)
 * per band. Reveals TPA tuning problems and throttle-dependent instability.
 *
 * Inspired by Plasmatree PID-Analyzer's response-vs-throttle visualization.
 */

import type { BlackboxFlightData } from '@shared/types/blackbox.types';
import type { PIDRecommendation } from '@shared/types/analysis.types';
import { binByThrottle, findContiguousRuns } from './ThrottleSpectrogramAnalyzer';
import {
  estimateTransferFunction,
  extractMetrics,
  computeSyntheticStepResponse,
  trimBode,
} from './TransferFunctionEstimator';
import type { TransferFunctionMetrics } from './TransferFunctionEstimator';
import type { TPAContext } from './PIDRecommender';
import {
  TPA_TF_OVERSHOOT_DELTA_PP,
  TPA_TF_OVERDAMPED_OVERSHOOT_PCT,
  TPA_TF_RATE_STEP,
  TPA_TF_RATE_MIN,
  TPA_TF_RATE_MAX,
  TPA_TF_MIN_BANDS,
  TPA_TF_BREAKPOINT_MIN,
  TPA_TF_BREAKPOINT_MAX,
  TPA_TF_BREAKPOINT_DEADZONE,
} from './constants';

/** Default number of throttle bands for TF analysis */
export const DEFAULT_TF_BANDS = 5;

/** Minimum samples per band for meaningful TF estimation (need enough for Welch averaging) */
export const MIN_TF_SAMPLES = 2048;

/** Variance threshold for TPA warning */
export const TPA_VARIANCE_THRESHOLD = {
  bandwidthHz: 15, // std dev > 15 Hz across bands → possible TPA issue
  overshootPercent: 10, // std dev > 10% → significant instability variation
  phaseMarginDeg: 10, // std dev > 10° → stability varies with throttle
};

/** Maximum frequency for per-band TF */
const TF_MAX_FREQ_HZ = 500;

export interface ThrottleTFBand {
  /** Lower throttle bound (normalized 0-1) */
  throttleMin: number;
  /** Upper throttle bound (normalized 0-1) */
  throttleMax: number;
  /** Number of samples in this band */
  sampleCount: number;
  /** TF metrics (null if insufficient data) */
  metrics: TransferFunctionMetrics | null;
}

/** Per-axis throttle-TF sub-result */
export interface AxisThrottleTF {
  bands: ThrottleTFBand[];
  bandsWithData: number;
  metricsVariance: {
    bandwidthHz: number;
    overshootPercent: number;
    phaseMarginDeg: number;
  };
}

export interface ThrottleTFResult {
  /** Per-band results (roll axis — primary, kept top-level for compatibility) */
  bands: ThrottleTFBand[];
  /** Number of bands with enough data for TF estimation */
  bandsWithData: number;
  /** Variance of key metrics across bands (std dev, roll axis) */
  metricsVariance: {
    bandwidthHz: number;
    overshootPercent: number;
    phaseMarginDeg: number;
  };
  /** Pitch-axis per-band analysis (P2.8) — absent when pitch lacks data */
  pitch?: AxisThrottleTF;
  /** TPA warning message if variance exceeds threshold (worst axis) */
  tpaWarning?: string;
}

/** Minimum contiguous run length usable for per-band TF estimation.
 * TF deconvolution needs an unbroken time series — splicing non-contiguous
 * samples corrupts the cross-spectra. */
export const MIN_TF_RUN_SAMPLES = 2048;

/**
 * Compute standard deviation of an array of numbers.
 */
function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Estimate transfer function per throttle band for a single axis.
 */
function estimatePerBand(
  setpoint: Float64Array,
  gyro: Float64Array,
  throttle: Float64Array,
  sampleRateHz: number,
  numBands: number
): ThrottleTFBand[] {
  const bins = binByThrottle(throttle, numBands);

  return bins.map((indices, bandIdx) => {
    const throttleMin = bandIdx / numBands;
    const throttleMax = (bandIdx + 1) / numBands;
    const sampleCount = indices.length;

    if (sampleCount < MIN_TF_SAMPLES) {
      return { throttleMin, throttleMax, sampleCount, metrics: null };
    }

    // TF needs an unbroken time series — use the longest contiguous run in
    // the band instead of splicing non-contiguous samples together.
    const runs = findContiguousRuns(indices, MIN_TF_RUN_SAMPLES);
    if (runs.length === 0) {
      return { throttleMin, throttleMax, sampleCount, metrics: null };
    }
    const run = runs[0]; // longest first

    const { bode, impulseResponse } = estimateTransferFunction(
      setpoint.subarray(run.start, run.end),
      gyro.subarray(run.start, run.end),
      sampleRateHz
    );
    const trimmed = trimBode(bode, TF_MAX_FREQ_HZ);
    const synStep = computeSyntheticStepResponse(impulseResponse, sampleRateHz);
    const metrics = extractMetrics(trimmed, synStep, sampleRateHz);

    return { throttleMin, throttleMax, sampleCount, metrics };
  });
}

/**
 * Analyze one axis's transfer function across throttle bands.
 * Returns null when fewer than 2 bands have enough data.
 */
function analyzeAxisThrottleTF(
  setpoint: Float64Array,
  gyro: Float64Array,
  throttle: Float64Array,
  sampleRateHz: number,
  numBands: number
): AxisThrottleTF | null {
  const bands = estimatePerBand(setpoint, gyro, throttle, sampleRateHz, numBands);
  const bandsWithData = bands.filter((b) => b.metrics !== null).length;
  if (bandsWithData < 2) return null;

  const metricsWithData = bands
    .filter((b): b is ThrottleTFBand & { metrics: TransferFunctionMetrics } => b.metrics !== null)
    .map((b) => b.metrics);

  const metricsVariance = {
    bandwidthHz: Math.round(stdDev(metricsWithData.map((m) => m.bandwidthHz)) * 100) / 100,
    overshootPercent:
      Math.round(stdDev(metricsWithData.map((m) => m.overshootPercent)) * 100) / 100,
    phaseMarginDeg: Math.round(stdDev(metricsWithData.map((m) => m.phaseMarginDeg)) * 100) / 100,
  };

  return { bands, bandsWithData, metricsVariance };
}

/**
 * Analyze transfer function across throttle bands.
 *
 * Roll is the primary axis (kept top-level for compatibility); pitch is
 * analyzed as well (P2.8) and attached when it has enough data. The TPA
 * warning reflects the worst axis.
 *
 * @param flightData - Parsed blackbox flight data
 * @param sampleRateHz - Sample rate in Hz
 * @param numBands - Number of throttle bands (default 5)
 * @returns ThrottleTFResult, or null if insufficient throttle data
 */
export function analyzeThrottleTF(
  flightData: BlackboxFlightData,
  sampleRateHz: number,
  numBands: number = DEFAULT_TF_BANDS
): ThrottleTFResult | null {
  // setpoint: [roll, pitch, yaw, throttle], gyro: [roll, pitch, yaw]
  const throttle = flightData.setpoint[3].values;
  const roll = analyzeAxisThrottleTF(
    flightData.setpoint[0].values,
    flightData.gyro[0].values,
    throttle,
    sampleRateHz,
    numBands
  );
  if (!roll) return null;

  const pitch = analyzeAxisThrottleTF(
    flightData.setpoint[1].values,
    flightData.gyro[1].values,
    throttle,
    sampleRateHz,
    numBands
  );

  // Warning from the worst axis
  const worstVariance = {
    bandwidthHz: Math.max(
      roll.metricsVariance.bandwidthHz,
      pitch?.metricsVariance.bandwidthHz ?? 0
    ),
    overshootPercent: Math.max(
      roll.metricsVariance.overshootPercent,
      pitch?.metricsVariance.overshootPercent ?? 0
    ),
    phaseMarginDeg: Math.max(
      roll.metricsVariance.phaseMarginDeg,
      pitch?.metricsVariance.phaseMarginDeg ?? 0
    ),
  };

  const warnings: string[] = [];
  if (worstVariance.bandwidthHz > TPA_VARIANCE_THRESHOLD.bandwidthHz) {
    warnings.push(
      `Bandwidth varies by ±${worstVariance.bandwidthHz.toFixed(0)} Hz across throttle range`
    );
  }
  if (worstVariance.overshootPercent > TPA_VARIANCE_THRESHOLD.overshootPercent) {
    warnings.push(
      `Overshoot varies by ±${worstVariance.overshootPercent.toFixed(0)}% across throttle range`
    );
  }
  if (worstVariance.phaseMarginDeg > TPA_VARIANCE_THRESHOLD.phaseMarginDeg) {
    warnings.push(
      `Phase margin varies by ±${worstVariance.phaseMarginDeg.toFixed(0)}° across throttle range`
    );
  }

  const tpaWarning =
    warnings.length > 0
      ? `TPA tuning may need adjustment: ${warnings.join('; ')}. Consider reviewing D-term TPA settings.`
      : undefined;

  return {
    bands: roll.bands,
    bandsWithData: roll.bandsWithData,
    metricsVariance: roll.metricsVariance,
    ...(pitch ? { pitch } : {}),
    tpaWarning,
  };
}

/**
 * Emit measured TPA recommendations from per-band TF trends (P2.8).
 *
 * TPA attenuates PID gains at high throttle. If the measured closed-loop
 * overshoot GROWS from the low- to the high-throttle bands, the attenuation
 * is too weak (raise tpa_rate; move the breakpoint down to where the
 * oscillation starts). If high-throttle bands are overdamped while low bands
 * still overshoot, the attenuation is too strong (lower tpa_rate).
 *
 * Trends are taken from the worst of roll/pitch. Requires tpa_rate from the
 * BBL header and ≥3 bands with TF data on the driving axis.
 */
export function recommendTPAFromThrottleTF(
  result: ThrottleTFResult,
  tpaContext: TPAContext | undefined
): PIDRecommendation[] {
  const recs: PIDRecommendation[] = [];
  if (!tpaContext || tpaContext.rate === undefined) return recs;

  // Pick the axis with the larger low→high overshoot change (worst case)
  const axes: { label: string; bands: ThrottleTFBand[] }[] = [
    { label: 'roll', bands: result.bands },
    ...(result.pitch ? [{ label: 'pitch', bands: result.pitch.bands }] : []),
  ];

  let driving: { label: string; delta: number; low: number; high: number; onset?: number } | null =
    null;

  for (const axis of axes) {
    const withData = axis.bands.filter((b) => b.metrics !== null);
    if (withData.length < TPA_TF_MIN_BANDS) continue;

    // Split into lower and upper halves by throttle
    const midIdx = Math.floor(withData.length / 2);
    const lowBands = withData.slice(0, midIdx);
    const highBands = withData.slice(midIdx);
    const mean = (bands: ThrottleTFBand[]) =>
      bands.reduce((s, b) => s + b.metrics!.overshootPercent, 0) / bands.length;
    const low = mean(lowBands);
    const high = mean(highBands);
    const delta = high - low;

    // Throttle where overshoot first exceeds the low mean by the trigger delta
    const onsetBand = withData.find(
      (b) => b.metrics!.overshootPercent > low + TPA_TF_OVERSHOOT_DELTA_PP
    );

    if (driving === null || Math.abs(delta) > Math.abs(driving.delta)) {
      driving = { label: axis.label, delta, low, high, onset: onsetBand?.throttleMin };
    }
  }

  if (!driving) return recs;
  const rate = tpaContext.rate;

  if (driving.delta >= TPA_TF_OVERSHOOT_DELTA_PP) {
    // Oscillation grows with throttle → TPA too weak
    const target = Math.min(rate + TPA_TF_RATE_STEP, TPA_TF_RATE_MAX);
    if (target > rate) {
      recs.push({
        setting: 'tpa_rate',
        currentValue: rate,
        recommendedValue: target,
        reason:
          `Measured ${driving.label} overshoot grows from ${driving.low.toFixed(0)}% at low throttle ` +
          `to ${driving.high.toFixed(0)}% at high throttle — the PID gains are too hot up top and TPA ` +
          `is not attenuating enough. Raising tpa_rate from ${rate} to ${target} damps the ` +
          'high-throttle oscillation without touching low-throttle response.',
        impact: 'stability',
        confidence: 'medium',
        ruleId: 'TPA-TF-RATE-UP',
        evidence: {
          measurements: [
            {
              label: `Low-throttle ${driving.label} overshoot`,
              value: `${driving.low.toFixed(0)}%`,
            },
            {
              label: `High-throttle ${driving.label} overshoot`,
              value: `${driving.high.toFixed(0)}%`,
            },
          ],
          trigger: `Overshoot grows ≥ ${TPA_TF_OVERSHOOT_DELTA_PP} pp from low- to high-throttle TF bands`,
        },
      });
    }

    // Breakpoint: move to where the oscillation measurably starts
    if (tpaContext.breakpoint !== undefined && driving.onset !== undefined) {
      const onsetUs = Math.round((1000 + driving.onset * 1000) / 10) * 10;
      const target2 = Math.min(Math.max(onsetUs, TPA_TF_BREAKPOINT_MIN), TPA_TF_BREAKPOINT_MAX);
      if (tpaContext.breakpoint - target2 > TPA_TF_BREAKPOINT_DEADZONE) {
        recs.push({
          setting: 'tpa_breakpoint',
          currentValue: tpaContext.breakpoint,
          recommendedValue: target2,
          reason:
            `The measured high-throttle oscillation starts around ${Math.round((driving.onset ?? 0) * 100)}% ` +
            `throttle, but TPA only begins attenuating at breakpoint ${tpaContext.breakpoint}. ` +
            `Lowering the breakpoint to ${target2} starts the attenuation where the oscillation actually begins.`,
          impact: 'stability',
          confidence: 'medium',
          ruleId: 'TPA-TF-BREAKPOINT',
          evidence: {
            measurements: [
              {
                label: 'Measured oscillation onset',
                value: `~${Math.round((driving.onset ?? 0) * 100)}% throttle`,
              },
              { label: 'Current breakpoint', value: `${tpaContext.breakpoint}` },
            ],
            trigger: 'Overshoot exceeds the low-band mean before TPA starts attenuating',
          },
        });
      }
    }
  } else if (
    driving.delta <= -TPA_TF_OVERSHOOT_DELTA_PP &&
    driving.high < TPA_TF_OVERDAMPED_OVERSHOOT_PCT
  ) {
    // High-throttle response overdamped while low throttle still overshoots → TPA too strong
    const target = Math.max(rate - TPA_TF_RATE_STEP, TPA_TF_RATE_MIN);
    if (target < rate) {
      recs.push({
        setting: 'tpa_rate',
        currentValue: rate,
        recommendedValue: target,
        reason:
          `Measured ${driving.label} response is overdamped at high throttle ` +
          `(${driving.high.toFixed(0)}% overshoot vs ${driving.low.toFixed(0)}% at low throttle) — ` +
          `TPA is attenuating more than needed, costing punch-out authority. ` +
          `Lowering tpa_rate from ${rate} to ${target} restores high-throttle response.`,
        impact: 'response',
        confidence: 'low',
        ruleId: 'TPA-TF-RATE-DOWN',
        evidence: {
          measurements: [
            {
              label: `Low-throttle ${driving.label} overshoot`,
              value: `${driving.low.toFixed(0)}%`,
            },
            {
              label: `High-throttle ${driving.label} overshoot`,
              value: `${driving.high.toFixed(0)}%`,
            },
          ],
          trigger: `High-throttle bands overdamped (< ${TPA_TF_OVERDAMPED_OVERSHOOT_PCT}% overshoot) while low bands overshoot`,
        },
      });
    }
  }

  return recs;
}
