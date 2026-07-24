/**
 * Throttle-indexed transfer function analyzer.
 *
 * Bins flight data by throttle level and estimates TF (Wiener deconvolution)
 * per band. Reveals TPA tuning problems and throttle-dependent instability.
 *
 * Inspired by Plasmatree PID-Analyzer's response-vs-throttle visualization.
 */

import type { BlackboxFlightData } from '@shared/types/blackbox.types';
import { binByThrottle, findContiguousRuns } from './ThrottleSpectrogramAnalyzer';
import {
  estimateTransferFunction,
  extractMetrics,
  computeSyntheticStepResponse,
  trimBode,
} from './TransferFunctionEstimator';
import type { TransferFunctionMetrics } from './TransferFunctionEstimator';

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

export interface ThrottleTFResult {
  /** Per-band results */
  bands: ThrottleTFBand[];
  /** Number of bands with enough data for TF estimation */
  bandsWithData: number;
  /** Variance of key metrics across bands (std dev) */
  metricsVariance: {
    bandwidthHz: number;
    overshootPercent: number;
    phaseMarginDeg: number;
  };
  /** TPA warning message if variance exceeds threshold */
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
 * Analyze transfer function across throttle bands.
 *
 * Uses roll axis as the primary indicator (most sensitive to TPA effects).
 * Returns per-band metrics, cross-band variance, and optional TPA warning.
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
  // Use roll axis as primary (most sensitive to TPA)
  const bands = estimatePerBand(
    flightData.setpoint[0].values,
    flightData.gyro[0].values,
    flightData.setpoint[3].values,
    sampleRateHz,
    numBands
  );

  const bandsWithData = bands.filter((b) => b.metrics !== null).length;

  if (bandsWithData < 2) {
    return null; // Need at least 2 bands to compute variance
  }

  // Compute variance across bands with data
  const metricsWithData = bands
    .filter((b): b is ThrottleTFBand & { metrics: TransferFunctionMetrics } => b.metrics !== null)
    .map((b) => b.metrics);

  const metricsVariance = {
    bandwidthHz: Math.round(stdDev(metricsWithData.map((m) => m.bandwidthHz)) * 100) / 100,
    overshootPercent:
      Math.round(stdDev(metricsWithData.map((m) => m.overshootPercent)) * 100) / 100,
    phaseMarginDeg: Math.round(stdDev(metricsWithData.map((m) => m.phaseMarginDeg)) * 100) / 100,
  };

  // Generate TPA warning if variance is high
  const warnings: string[] = [];
  if (metricsVariance.bandwidthHz > TPA_VARIANCE_THRESHOLD.bandwidthHz) {
    warnings.push(
      `Bandwidth varies by ±${metricsVariance.bandwidthHz.toFixed(0)} Hz across throttle range`
    );
  }
  if (metricsVariance.overshootPercent > TPA_VARIANCE_THRESHOLD.overshootPercent) {
    warnings.push(
      `Overshoot varies by ±${metricsVariance.overshootPercent.toFixed(0)}% across throttle range`
    );
  }
  if (metricsVariance.phaseMarginDeg > TPA_VARIANCE_THRESHOLD.phaseMarginDeg) {
    warnings.push(
      `Phase margin varies by ±${metricsVariance.phaseMarginDeg.toFixed(0)}° across throttle range`
    );
  }

  const tpaWarning =
    warnings.length > 0
      ? `TPA tuning may need adjustment: ${warnings.join('; ')}. Consider reviewing D-term TPA settings.`
      : undefined;

  return {
    bands,
    bandsWithData,
    metricsVariance,
    tpaWarning,
  };
}
