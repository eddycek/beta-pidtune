/**
 * Utilities for extracting compact, JSON-safe metrics from analysis results.
 *
 * Used to create history records from completed tuning sessions.
 */

import type {
  FilterAnalysisResult,
  PIDAnalysisResult,
  StepResponse,
} from '../types/analysis.types';
import type {
  CompactSpectrum,
  CompactStepResponse,
  CompactThrottleSpectrogram,
  FilterMetricsSummary,
  PIDMetricsSummary,
  TransferFunctionMetricsSummary,
} from '../types/tuning-history.types';
import type { ThrottleSpectrogramResult } from '../types/analysis.types';
import { SPECTRUM_SCALE_VERSION } from '../constants';

/**
 * Downsample a full-resolution FFT spectrum to a fixed number of bins.
 *
 * Uses linear interpolation via binary search for accurate resampling.
 * Output values are rounded to 2 decimal places for compact JSON storage.
 *
 * @param frequencies - Original frequency bins (Hz), must be sorted ascending
 * @param magnitudes - Per-axis magnitude arrays (dB)
 * @param targetBins - Number of output bins (default 128)
 * @param maxFreqHz - Maximum frequency to include (default 4000 Hz)
 */
export function downsampleSpectrum(
  frequencies: Float64Array,
  magnitudes: { roll: Float64Array; pitch: Float64Array; yaw: Float64Array },
  targetBins = 128,
  maxFreqHz = 4000
): CompactSpectrum {
  if (frequencies.length === 0) {
    return { frequencies: [], roll: [], pitch: [], yaw: [] };
  }

  // Clamp maxFreqHz to actual data range
  const actualMax = Math.min(maxFreqHz, frequencies[frequencies.length - 1]);
  const step = actualMax / targetBins;

  const outFreqs: number[] = [];
  const outRoll: number[] = [];
  const outPitch: number[] = [];
  const outYaw: number[] = [];

  for (let i = 0; i < targetBins; i++) {
    const targetFreq = (i + 0.5) * step; // Center of each bin
    outFreqs.push(Math.round(targetFreq * 10) / 10);
    outRoll.push(interpolate(frequencies, magnitudes.roll, targetFreq));
    outPitch.push(interpolate(frequencies, magnitudes.pitch, targetFreq));
    outYaw.push(interpolate(frequencies, magnitudes.yaw, targetFreq));
  }

  return {
    frequencies: outFreqs,
    roll: outRoll,
    pitch: outPitch,
    yaw: outYaw,
  };
}

/** Linear interpolation with binary search on sorted frequency array */
function interpolate(frequencies: Float64Array, values: Float64Array, targetFreq: number): number {
  // Edge cases
  if (targetFreq <= frequencies[0]) {
    return round2(values[0]);
  }
  if (targetFreq >= frequencies[frequencies.length - 1]) {
    return round2(values[values.length - 1]);
  }

  // Binary search for the interval containing targetFreq
  let lo = 0;
  let hi = frequencies.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (frequencies[mid] <= targetFreq) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Linear interpolation between lo and hi
  const fLo = frequencies[lo];
  const fHi = frequencies[hi];
  const t = (targetFreq - fLo) / (fHi - fLo);
  const interpolated = values[lo] + t * (values[hi] - values[lo]);
  return round2(interpolated);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

const SPECTROGRAM_TARGET_BINS = 120;

/**
 * Downsample a Float64Array spectrum to a fixed number of bins by averaging.
 * Returns plain number[] for JSON serialization.
 */
function downsampleFloat64(
  frequencies: Float64Array,
  magnitudes: Float64Array,
  targetBins: number
): { frequencies: number[]; magnitudes: number[] } {
  const srcLen = frequencies.length;
  if (srcLen <= targetBins) {
    return {
      frequencies: Array.from(frequencies).map((f) => round2(f)),
      magnitudes: Array.from(magnitudes).map((m) => round2(m)),
    };
  }

  const binSize = srcLen / targetBins;
  const outFreqs: number[] = [];
  const outMags: number[] = [];

  for (let i = 0; i < targetBins; i++) {
    const start = Math.floor(i * binSize);
    const end = Math.floor((i + 1) * binSize);
    let freqSum = 0;
    let magSum = 0;
    const count = end - start;

    for (let j = start; j < end; j++) {
      freqSum += frequencies[j];
      magSum += magnitudes[j];
    }

    outFreqs.push(round2(freqSum / count));
    outMags.push(round2(magSum / count));
  }

  return { frequencies: outFreqs, magnitudes: outMags };
}

/**
 * Extract compact throttle spectrogram from a full ThrottleSpectrogramResult.
 *
 * Downsamples each band's per-axis spectra to ~120 frequency bins for compact JSON storage.
 * Returns null if no bands have data.
 */
export function extractThrottleSpectrogram(
  result: ThrottleSpectrogramResult
): CompactThrottleSpectrogram | null {
  const bandsWithSpectra = result.bands.filter((b) => b.spectra);
  if (bandsWithSpectra.length === 0) return null;

  // Use first available spectrum to build shared frequency grid
  const refSpectrum = bandsWithSpectra[0].spectra![0];
  const refDs = downsampleFloat64(
    refSpectrum.frequencies,
    refSpectrum.magnitudes,
    SPECTROGRAM_TARGET_BINS
  );
  const frequencies = refDs.frequencies;

  const bands: CompactThrottleSpectrogram['bands'] = [];

  for (const band of result.bands) {
    if (!band.spectra) continue;

    const rollDs = downsampleFloat64(
      band.spectra[0].frequencies,
      band.spectra[0].magnitudes,
      SPECTROGRAM_TARGET_BINS
    );
    const pitchDs = downsampleFloat64(
      band.spectra[1].frequencies,
      band.spectra[1].magnitudes,
      SPECTROGRAM_TARGET_BINS
    );
    const yawDs = downsampleFloat64(
      band.spectra[2].frequencies,
      band.spectra[2].magnitudes,
      SPECTROGRAM_TARGET_BINS
    );

    bands.push({
      throttleMin: band.throttleMin,
      throttleMax: band.throttleMax,
      roll: rollDs.magnitudes,
      pitch: pitchDs.magnitudes,
      yaw: yawDs.magnitudes,
    });
  }

  return {
    frequencies,
    bands,
    bandsWithData: bandsWithSpectra.length,
  };
}

/**
 * Extract compact filter metrics from a full FilterAnalysisResult.
 *
 * Spectrum access: result.noise.roll.spectrum.frequencies (shared across axes)
 */
export function extractFilterMetrics(result: FilterAnalysisResult): FilterMetricsSummary {
  const spectrum = downsampleSpectrum(result.noise.roll.spectrum.frequencies, {
    roll: result.noise.roll.spectrum.magnitudes,
    pitch: result.noise.pitch.spectrum.magnitudes,
    yaw: result.noise.yaw.spectrum.magnitudes,
  });

  return {
    noiseLevel: result.noise.overallLevel,
    spectrumScaleVersion: SPECTRUM_SCALE_VERSION,
    roll: {
      noiseFloorDb: round2(result.noise.roll.noiseFloorDb),
      peakCount: result.noise.roll.peaks.length,
    },
    pitch: {
      noiseFloorDb: round2(result.noise.pitch.noiseFloorDb),
      peakCount: result.noise.pitch.peaks.length,
    },
    yaw: {
      noiseFloorDb: round2(result.noise.yaw.noiseFloorDb),
      peakCount: result.noise.yaw.peaks.length,
    },
    segmentsUsed: result.segmentsUsed,
    rpmFilterActive: result.rpmFilterActive,
    summary: result.summary,
    spectrum,
    ...(result.dataQuality
      ? { dataQuality: { overall: result.dataQuality.overall, tier: result.dataQuality.tier } }
      : {}),
    ...(result.windDisturbance
      ? {
          windDisturbance: {
            level: result.windDisturbance.level,
            worstVariance: round2(result.windDisturbance.worstVariance),
          },
        }
      : {}),
    ...(result.throttleSpectrogram && result.throttleSpectrogram.bandsWithData > 0
      ? { throttleSpectrogram: extractThrottleSpectrogram(result.throttleSpectrogram) ?? undefined }
      : {}),
  };
}

/** Per-axis synthetic step response input */
interface SyntheticStepResponseInput {
  roll: { timeMs: number[]; response: number[] };
  pitch: { timeMs: number[]; response: number[] };
  yaw: { timeMs: number[]; response: number[] };
}

/**
 * Downsample a per-axis synthetic step response to a fixed number of uniformly-spaced points.
 *
 * All 3 axes share the same time base (taken from the roll axis).
 * Uses linear interpolation for accurate resampling.
 *
 * @param input - Per-axis step response data (timeMs + response per axis)
 * @param targetPoints - Number of output points (default 64)
 */
export function downsampleStepResponse(
  input: SyntheticStepResponseInput,
  targetPoints = 64
): CompactStepResponse {
  const refTime = input.roll.timeMs;
  if (refTime.length === 0) {
    return { timeMs: [], roll: [], pitch: [], yaw: [] };
  }

  if (refTime.length === 1) {
    return {
      timeMs: [round2(refTime[0])],
      roll: [round2(input.roll.response[0])],
      pitch: [round2(input.pitch.response[0])],
      yaw: [round2(input.yaw.response[0])],
    };
  }

  const tMin = refTime[0];
  const tMax = refTime[refTime.length - 1];
  const step = (tMax - tMin) / (targetPoints - 1);

  const outTime: number[] = [];
  const outRoll: number[] = [];
  const outPitch: number[] = [];
  const outYaw: number[] = [];

  for (let i = 0; i < targetPoints; i++) {
    const t = tMin + i * step;
    outTime.push(round2(t));
    outRoll.push(interpolateLinear(input.roll.timeMs, input.roll.response, t));
    outPitch.push(interpolateLinear(input.pitch.timeMs, input.pitch.response, t));
    outYaw.push(interpolateLinear(input.yaw.timeMs, input.yaw.response, t));
  }

  return { timeMs: outTime, roll: outRoll, pitch: outPitch, yaw: outYaw };
}

/** Linear interpolation with binary search on sorted time array */
function interpolateLinear(times: number[], values: number[], targetT: number): number {
  if (times.length === 0) return 0;
  if (targetT <= times[0]) return round2(values[0]);
  if (targetT >= times[times.length - 1]) return round2(values[values.length - 1]);

  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= targetT) lo = mid;
    else hi = mid;
  }

  const tLo = times[lo];
  const tHi = times[hi];
  const t = (targetT - tLo) / (tHi - tLo);
  return round2(values[lo] + t * (values[hi] - values[lo]));
}

/** Per-axis transfer function metrics input (matches TransferFunctionEstimator.TransferFunctionMetrics) */
interface TFMetricsInput {
  bandwidthHz: number;
  phaseMarginDeg: number;
  gainMarginDb: number;
  overshootPercent: number;
  settlingTimeMs: number;
  riseTimeMs: number;
  dcGainDb?: number;
  phaseMarginCrossingFound?: boolean;
}

/** Throttle-band TF summary input (matches PIDAnalysisResult.throttleTF shape) */
interface ThrottleTFInput {
  bandsWithData: number;
  metricsVariance: { bandwidthHz: number; overshootPercent: number; phaseMarginDeg: number };
  tpaWarning?: string;
}

/**
 * Extract compact transfer function metrics for history storage.
 *
 * @param metrics - Per-axis transfer function metrics
 * @param dataQuality - Optional data quality summary
 * @param syntheticStepResponse - Optional synthetic step response data to downsample for history
 * @param throttleTF - Optional throttle-band TF summary for history storage
 */
export function extractTransferFunctionMetrics(
  metrics: { roll: TFMetricsInput; pitch: TFMetricsInput; yaw: TFMetricsInput },
  dataQuality?: { overall: number; tier: string },
  syntheticStepResponse?: SyntheticStepResponseInput,
  throttleTF?: ThrottleTFInput
): TransferFunctionMetricsSummary {
  const extract = (m: TFMetricsInput) => ({
    bandwidthHz: round2(m.bandwidthHz),
    phaseMarginDeg: round2(m.phaseMarginDeg),
    gainMarginDb: round2(m.gainMarginDb),
    overshootPercent: round2(m.overshootPercent),
    settlingTimeMs: round2(m.settlingTimeMs),
    riseTimeMs: round2(m.riseTimeMs),
    ...(m.phaseMarginCrossingFound !== undefined
      ? { phaseMarginCrossingFound: m.phaseMarginCrossingFound }
      : {}),
  });

  // Extract per-axis DC gain if available
  const hasDcGain =
    metrics.roll.dcGainDb !== undefined ||
    metrics.pitch.dcGainDb !== undefined ||
    metrics.yaw.dcGainDb !== undefined;

  return {
    roll: extract(metrics.roll),
    pitch: extract(metrics.pitch),
    yaw: extract(metrics.yaw),
    ...(dataQuality ? { dataQuality } : {}),
    ...(syntheticStepResponse
      ? { stepResponse: downsampleStepResponse(syntheticStepResponse) }
      : {}),
    ...(throttleTF
      ? {
          throttleBands: {
            bandsWithData: throttleTF.bandsWithData,
            metricsVariance: {
              bandwidthHz: round2(throttleTF.metricsVariance.bandwidthHz),
              overshootPercent: round2(throttleTF.metricsVariance.overshootPercent),
              phaseMarginDeg: round2(throttleTF.metricsVariance.phaseMarginDeg),
            },
            ...(throttleTF.tpaWarning ? { tpaWarning: throttleTF.tpaWarning } : {}),
          },
        }
      : {}),
    ...(hasDcGain
      ? {
          dcGain: {
            roll: round2(metrics.roll.dcGainDb ?? 0),
            pitch: round2(metrics.pitch.dcGainDb ?? 0),
            yaw: round2(metrics.yaw.dcGainDb ?? 0),
          },
        }
      : {}),
  };
}

/**
 * Find the best (most representative) step response with a trace from a list.
 * Prefers steps with moderate overshoot and non-zero rise time.
 */
function findBestStepWithTrace(responses: StepResponse[]): StepResponse | null {
  let best: StepResponse | null = null;
  let bestScore = -Infinity;
  for (const r of responses) {
    if (!r.trace || r.trace.timeMs.length === 0) continue;
    const isDegenerate = r.riseTimeMs === 0 || r.overshootPercent >= 500;
    const score = isDegenerate ? -1 : Math.abs(r.step.magnitude);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/**
 * Normalize a step trace to response relative to setpoint=1.0.
 * Accounts for step direction — negative steps are flipped so the trace
 * always settles toward +1.0.
 */
function normalizeStepTrace(step: StepResponse): { timeMs: number[]; response: number[] } {
  const trace = step.trace!;
  const mag = step.step.magnitude || 1; // signed magnitude preserves direction
  // Subtract baseline (gyro at step start) before dividing by magnitude.
  // trace.gyro contains absolute gyro values (e.g. 200-400 deg/s), not relative.
  // Without baseline subtraction, normalization produces wild values.
  const baseline = trace.gyro[0] ?? 0;
  return {
    timeMs: trace.timeMs,
    response: trace.gyro.map((g) => (g - baseline) / mag),
  };
}

/**
 * Extract a compact step response from the best step per axis.
 * Each axis uses its own time base; downsampleStepResponse resamples to shared grid.
 */
function extractBestStepResponse(result: PIDAnalysisResult): CompactStepResponse | undefined {
  const rollStep = findBestStepWithTrace(result.roll.responses);
  const pitchStep = findBestStepWithTrace(result.pitch.responses);
  const yawStep = findBestStepWithTrace(result.yaw.responses);

  if (!rollStep?.trace && !pitchStep?.trace && !yawStep?.trace) return undefined;

  const refStep = rollStep || pitchStep || yawStep;
  if (!refStep?.trace) return undefined;
  const refLen = refStep.trace.timeMs.length;

  const getAxisData = (step: StepResponse | null) => {
    if (!step?.trace) {
      return {
        timeMs: refStep!.trace!.timeMs,
        response: new Array(refLen).fill(0),
      };
    }
    return normalizeStepTrace(step);
  };

  return downsampleStepResponse(
    {
      roll: getAxisData(rollStep),
      pitch: getAxisData(pitchStep),
      yaw: getAxisData(yawStep),
    },
    64
  );
}

export function extractPIDMetrics(result: PIDAnalysisResult): PIDMetricsSummary {
  const stepResponse = extractBestStepResponse(result);
  return {
    roll: {
      meanOvershoot: round2(result.roll.meanOvershoot),
      meanRiseTimeMs: round2(result.roll.meanRiseTimeMs),
      meanSettlingTimeMs: round2(result.roll.meanSettlingTimeMs),
      meanLatencyMs: round2(result.roll.meanLatencyMs),
      meanTrackingErrorRMS: round2(result.roll.meanTrackingErrorRMS),
    },
    pitch: {
      meanOvershoot: round2(result.pitch.meanOvershoot),
      meanRiseTimeMs: round2(result.pitch.meanRiseTimeMs),
      meanSettlingTimeMs: round2(result.pitch.meanSettlingTimeMs),
      meanLatencyMs: round2(result.pitch.meanLatencyMs),
      meanTrackingErrorRMS: round2(result.pitch.meanTrackingErrorRMS),
    },
    yaw: {
      meanOvershoot: round2(result.yaw.meanOvershoot),
      meanRiseTimeMs: round2(result.yaw.meanRiseTimeMs),
      meanSettlingTimeMs: round2(result.yaw.meanSettlingTimeMs),
      meanLatencyMs: round2(result.yaw.meanLatencyMs),
      meanTrackingErrorRMS: round2(result.yaw.meanTrackingErrorRMS),
    },
    stepsDetected: result.stepsDetected,
    currentPIDs: result.currentPIDs,
    summary: result.summary,
    ...(result.dataQuality
      ? { dataQuality: { overall: result.dataQuality.overall, tier: result.dataQuality.tier } }
      : {}),
    ...(stepResponse ? { stepResponse } : {}),
  };
}
