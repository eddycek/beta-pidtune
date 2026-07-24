/**
 * Deconvolved (stacked) step response for PID Tune.
 *
 * Estimates the setpoint→gyro step response via Wiener deconvolution across
 * the whole flight — the Plasmatree/PIDtoolbox method — instead of averaging
 * individually measured steps. Deconvolution stacks information from every
 * Welch window, so single noisy steps no longer distort the axis means, and
 * the response is split by commanded input magnitude (<500 / >=500 deg/s)
 * because Betaflight's feedforward and D-setpoint transition behave
 * differently in the two regimes.
 *
 * The estimate is trusted for an axis only when its stick-band coherence
 * clears TF_COHERENCE_GATE-equivalent gating and at least DECONV_MIN_WINDOWS
 * Welch windows were stacked; otherwise the caller falls back to per-step
 * means (the pre-existing behavior).
 */
import type { BlackboxFlightData } from '@shared/types/blackbox.types';
import type { DeconvolvedStepMetrics } from '@shared/types/analysis.types';
import {
  estimateSplitTransferFunction,
  computeSyntheticStepResponse,
  extractMetrics,
  trimBode,
  type SplitTFGroup,
} from './TransferFunctionEstimator';
import { INPUT_SPLIT_THRESHOLD_DEG_S, DECONV_MIN_WINDOWS } from './constants';

/** Minimum stick-band coherence for a deconvolved group to be trusted.
 * Same rationale as TF_COHERENCE_GATE in PIDRecommender: low coherence means
 * the response reflects noise/disturbance, not commanded motion. */
export const DECONV_COHERENCE_GATE = 0.5;

/** Maximum frequency of interest for the stacked response (Hz) */
const DECONV_MAX_FREQ_HZ = 500;

/** Synthetic-step duration for the stacked response (s). Longer than the
 * Flash Tune default 0.2 s: normalizing the cumulative sum by a final value
 * taken mid-ring (before the response settles) systematically underestimates
 * overshoot. 0.5 s matches the per-step adaptive window maximum. */
const DECONV_STEP_DURATION_S = 0.5;

/** Downsample target for the stored step-response curve (chart rendering) */
const STEP_CURVE_MAX_POINTS = 100;

export interface AxisDeconvolvedResponse {
  /** Headline metrics — from the high-magnitude group when trustworthy
   * (large inputs exercise the P/D response the tuner cares about),
   * otherwise from the low group. */
  primary?: DeconvolvedStepMetrics;
  low?: DeconvolvedStepMetrics;
  high?: DeconvolvedStepMetrics;
}

export interface DeconvolvedStepResult {
  roll: AxisDeconvolvedResponse;
  pitch: AxisDeconvolvedResponse;
  yaw: AxisDeconvolvedResponse;
  splitThresholdDegS: number;
}

function downsampleCurve(curve: { timeMs: number[]; response: number[] }): {
  timeMs: number[];
  response: number[];
} {
  const n = curve.timeMs.length;
  if (n <= STEP_CURVE_MAX_POINTS) return curve;
  const stride = Math.ceil(n / STEP_CURVE_MAX_POINTS);
  const timeMs: number[] = [];
  const response: number[] = [];
  for (let i = 0; i < n; i += stride) {
    timeMs.push(Math.round(curve.timeMs[i] * 100) / 100);
    response.push(Math.round(curve.response[i] * 10000) / 10000);
  }
  return { timeMs, response };
}

function groupToMetrics(group: SplitTFGroup, sampleRateHz: number): DeconvolvedStepMetrics {
  const trimmed = trimBode(group.bode, DECONV_MAX_FREQ_HZ);
  const synStep = computeSyntheticStepResponse(
    group.impulseResponse,
    sampleRateHz,
    DECONV_STEP_DURATION_S
  );
  const metrics = extractMetrics(trimmed, synStep, sampleRateHz);
  return {
    overshootPercent: metrics.overshootPercent,
    riseTimeMs: metrics.riseTimeMs,
    settlingTimeMs: metrics.settlingTimeMs,
    windowCount: group.windowCount,
    ...(group.coherenceMean !== undefined ? { coherenceMean: group.coherenceMean } : {}),
    stepResponse: downsampleCurve(synStep),
  };
}

/** True when a deconvolved group is trustworthy enough to drive metrics */
export function isGroupTrustworthy(
  m: DeconvolvedStepMetrics | undefined
): m is DeconvolvedStepMetrics {
  return (
    m !== undefined &&
    m.windowCount >= DECONV_MIN_WINDOWS &&
    m.coherenceMean !== undefined &&
    m.coherenceMean >= DECONV_COHERENCE_GATE
  );
}

/**
 * Compute the magnitude-split deconvolved step response for all three axes.
 * Returns per-axis low/high metrics plus the primary (trusted) pick.
 */
export function computeDeconvolvedStepResponse(
  flightData: BlackboxFlightData,
  splitThresholdDegS: number = INPUT_SPLIT_THRESHOLD_DEG_S
): DeconvolvedStepResult {
  const axes = ['roll', 'pitch', 'yaw'] as const;
  const result: Partial<Record<(typeof axes)[number], AxisDeconvolvedResponse>> = {};

  for (let axisIdx = 0; axisIdx < 3; axisIdx++) {
    const axis = axes[axisIdx];
    let axisResult: AxisDeconvolvedResponse = {};
    try {
      const split = estimateSplitTransferFunction(
        flightData.setpoint[axisIdx].values,
        flightData.gyro[axisIdx].values,
        flightData.sampleRateHz,
        splitThresholdDegS
      );
      const low = split.low ? groupToMetrics(split.low, flightData.sampleRateHz) : undefined;
      const high = split.high ? groupToMetrics(split.high, flightData.sampleRateHz) : undefined;

      // Prefer the high-magnitude response (exercises P/D where tuning
      // matters), fall back to low; only trustworthy groups qualify.
      const primary = isGroupTrustworthy(high) ? high : isGroupTrustworthy(low) ? low : undefined;

      axisResult = {
        ...(low ? { low } : {}),
        ...(high ? { high } : {}),
        ...(primary ? { primary } : {}),
      };
    } catch {
      // Signal too short for deconvolution — axis stays empty (caller falls
      // back to per-step metrics)
    }
    result[axis] = axisResult;
  }

  return {
    roll: result.roll!,
    pitch: result.pitch!,
    yaw: result.yaw!,
    splitThresholdDegS,
  };
}
