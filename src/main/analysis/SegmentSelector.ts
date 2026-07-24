/**
 * Segment selector for finding flight segments suitable for analysis.
 *
 * Two modes:
 * 1. Steady hover segments — low gyro variance, mid-throttle (for legacy/fallback)
 * 2. Throttle sweep segments — monotonically changing throttle across wide range
 *    (preferred for filter analysis: captures noise across full RPM range)
 */
import type { BlackboxFlightData } from '@shared/types/blackbox.types';
import { normalizeThrottle } from './throttleUtils';
import type { FlightSegment } from '@shared/types/analysis.types';
import {
  THROTTLE_MIN_FLIGHT,
  THROTTLE_MAX_HOVER,
  GYRO_STEADY_MAX_STD,
  YAW_STEADY_MULTIPLIER,
  SEGMENT_MIN_DURATION_S,
  SEGMENT_WINDOW_DURATION_S,
  SWEEP_MIN_THROTTLE_RANGE,
  SWEEP_MIN_DURATION_S,
  SWEEP_MAX_DURATION_S,
  SWEEP_MAX_RESIDUAL,
} from './constants';

/**
 * Find stable hover segments in the flight data.
 *
 * A segment is "steady" if:
 * 1. Throttle is in hover range (above min, below max)
 * 2. Gyro variance is low (not doing aggressive maneuvers)
 * 3. Duration is at least SEGMENT_MIN_DURATION_S
 *
 * @returns Segments sorted by duration (longest first)
 */
export function findSteadySegments(flightData: BlackboxFlightData): FlightSegment[] {
  const { sampleRateHz } = flightData;
  const throttle = flightData.setpoint[3]; // Throttle channel
  const gyroRoll = flightData.gyro[0];
  const gyroPitch = flightData.gyro[1];
  const gyroYaw = flightData.gyro[2];

  const numSamples = throttle.values.length;
  if (numSamples === 0) return [];

  const minSegmentSamples = Math.floor(SEGMENT_MIN_DURATION_S * sampleRateHz);

  // Build a boolean mask: true = sample is in steady hover
  const steadyMask = new Uint8Array(numSamples);
  const windowSize = Math.min(Math.floor(SEGMENT_WINDOW_DURATION_S * sampleRateHz), numSamples);
  const halfWindow = Math.floor(windowSize / 2);

  for (let i = 0; i < numSamples; i++) {
    // Check throttle range
    const thr = normalizeThrottle(throttle.values[i]);
    if (thr < THROTTLE_MIN_FLIGHT || thr > THROTTLE_MAX_HOVER) {
      continue;
    }

    // Check gyro variance in a local window (yaw with a relaxed threshold —
    // inherently noisier, but an active yaw spin is not a steady hover)
    const wStart = Math.max(0, i - halfWindow);
    const wEnd = Math.min(numSamples, i + halfWindow);
    const rollStd = computeStd(gyroRoll.values, wStart, wEnd);
    const pitchStd = computeStd(gyroPitch.values, wStart, wEnd);
    const yawStd = computeStd(gyroYaw.values, wStart, wEnd);

    if (
      rollStd <= GYRO_STEADY_MAX_STD &&
      pitchStd <= GYRO_STEADY_MAX_STD &&
      yawStd <= GYRO_STEADY_MAX_STD * YAW_STEADY_MULTIPLIER
    ) {
      steadyMask[i] = 1;
    }
  }

  // Extract contiguous segments from the mask
  const segments: FlightSegment[] = [];
  let segStart = -1;

  for (let i = 0; i <= numSamples; i++) {
    const isSet = i < numSamples && steadyMask[i] === 1;

    if (isSet && segStart === -1) {
      segStart = i;
    } else if (!isSet && segStart !== -1) {
      const length = i - segStart;
      if (length >= minSegmentSamples) {
        const startTime =
          segStart < throttle.time.length ? throttle.time[segStart] : segStart / sampleRateHz;
        const endTime =
          i - 1 < throttle.time.length ? throttle.time[i - 1] : (i - 1) / sampleRateHz;
        const duration = endTime - startTime;

        // Compute average, min, max throttle
        let thrSum = 0;
        let thrMin = Infinity;
        let thrMax = -Infinity;
        for (let j = segStart; j < i; j++) {
          const thr = normalizeThrottle(throttle.values[j]);
          thrSum += thr;
          if (thr < thrMin) thrMin = thr;
          if (thr > thrMax) thrMax = thr;
        }

        segments.push({
          startIndex: segStart,
          endIndex: i,
          durationSeconds: duration > 0 ? duration : length / sampleRateHz,
          averageThrottle: thrSum / length,
          minThrottle: thrMin,
          maxThrottle: thrMax,
        });
      }
      segStart = -1;
    }
  }

  // Sort by duration, longest first
  segments.sort((a, b) => b.durationSeconds - a.durationSeconds);

  return segments;
}

/**
 * Compute standard deviation of a sub-range of a Float64Array.
 */
function computeStd(arr: Float64Array, start: number, end: number): number {
  const n = end - start;
  if (n <= 1) return 0;

  let sum = 0;
  for (let i = start; i < end; i++) {
    sum += arr[i];
  }
  const mean = sum / n;

  let variance = 0;
  for (let i = start; i < end; i++) {
    const d = arr[i] - mean;
    variance += d * d;
  }

  return Math.sqrt(variance / n);
}

/**
 * Find throttle sweep segments in the flight data.
 *
 * A sweep is a monotonically increasing (or decreasing) throttle ramp covering
 * at least SWEEP_MIN_THROTTLE_RANGE across at least SWEEP_MIN_DURATION_S.
 * These segments contain noise data across the full RPM range — preferred for
 * filter analysis over hover-only segments.
 *
 * Algorithm:
 * 1. Smooth throttle with a moving average to reduce jitter
 * 2. Slide a window across the data, checking monotonicity via linear regression
 * 3. Accept windows where the residual is below SWEEP_MAX_RESIDUAL and
 *    throttle range exceeds SWEEP_MIN_THROTTLE_RANGE
 *
 * @returns Segments sorted by throttle range covered (widest first)
 */
export function findThrottleSweepSegments(flightData: BlackboxFlightData): FlightSegment[] {
  const { sampleRateHz } = flightData;
  const throttle = flightData.setpoint[3]; // Throttle channel
  const numSamples = throttle.values.length;

  if (numSamples === 0) return [];

  const minSweepSamples = Math.floor(SWEEP_MIN_DURATION_S * sampleRateHz);
  const maxSweepSamples = Math.floor(SWEEP_MAX_DURATION_S * sampleRateHz);

  if (numSamples < minSweepSamples) return [];

  // Smooth throttle values with a moving average to reduce jitter
  const smoothWindowSize = Math.max(1, Math.floor(sampleRateHz * 0.05)); // 50ms window
  const smoothed = smoothThrottle(throttle.values, smoothWindowSize);

  const segments: FlightSegment[] = [];

  // Sliding window approach: try to find the longest sweep starting at each position.
  // Use a coarse step (100ms) for the inner window extension to avoid O(n²×m) complexity.
  // Without this, throttle discontinuities (e.g. prop wash cuts) prevent early sweep
  // discovery and cause the outer loop to increment by 1 for every sample — resulting
  // in millions of expensive computeLinearResidual calls.
  const coarseStep = Math.max(1, Math.floor(sampleRateHz * 0.1)); // 100ms step
  const outerStep = Math.max(1, Math.floor(sampleRateHz * 0.05)); // 50ms outer advance on failure

  let i = 0;
  while (i < numSamples - minSweepSamples) {
    const startThr = smoothed[i];

    // Skip if throttle too low (not in flight)
    if (startThr < THROTTLE_MIN_FLIGHT) {
      i += outerStep;
      continue;
    }

    // Quick monotonicity check at minimum window — if it fails, skip ahead
    const quickEnd = i + minSweepSamples;
    const quickRange = Math.abs(smoothed[quickEnd - 1] - startThr);
    if (quickRange < SWEEP_MIN_THROTTLE_RANGE * 0.5) {
      // Not enough throttle change even at minimum window — skip ahead
      i += outerStep;
      continue;
    }

    // Extend the window as far as the monotonicity holds (coarse step)
    let bestEnd = -1;
    let bestRange = 0;
    let consecutiveFails = 0;

    for (
      let end = i + minSweepSamples;
      end <= Math.min(i + maxSweepSamples, numSamples);
      end += coarseStep
    ) {
      const endThr = smoothed[end - 1];
      const range = Math.abs(endThr - startThr);

      if (range < SWEEP_MIN_THROTTLE_RANGE) {
        continue;
      }

      // Check monotonicity via linear regression residual
      const residual = computeLinearResidual(smoothed, i, end);
      if (residual <= SWEEP_MAX_RESIDUAL) {
        if (range > bestRange) {
          bestRange = range;
          bestEnd = end;
        }
        consecutiveFails = 0;
      } else {
        consecutiveFails++;
        // If residual fails 3 times in a row, monotonicity is broken — stop extending
        if (consecutiveFails >= 3) break;
      }
    }

    if (bestEnd > 0) {
      const startTime = i < throttle.time.length ? throttle.time[i] : i / sampleRateHz;
      const endTime =
        bestEnd - 1 < throttle.time.length
          ? throttle.time[bestEnd - 1]
          : (bestEnd - 1) / sampleRateHz;
      const duration = endTime - startTime;

      let thrSum = 0;
      let thrMin = Infinity;
      let thrMax = -Infinity;
      for (let j = i; j < bestEnd; j++) {
        thrSum += smoothed[j];
        if (smoothed[j] < thrMin) thrMin = smoothed[j];
        if (smoothed[j] > thrMax) thrMax = smoothed[j];
      }

      segments.push({
        startIndex: i,
        endIndex: bestEnd,
        durationSeconds: duration > 0 ? duration : (bestEnd - i) / sampleRateHz,
        averageThrottle: thrSum / (bestEnd - i),
        minThrottle: thrMin,
        maxThrottle: thrMax,
      });

      // Jump past this sweep
      i = bestEnd;
    } else {
      i += outerStep;
    }
  }

  // Sort by throttle range covered (widest first)
  segments.sort((a, b) => {
    const rangeA = computeThrottleRange(smoothed, a.startIndex, a.endIndex);
    const rangeB = computeThrottleRange(smoothed, b.startIndex, b.endIndex);
    return rangeB - rangeA;
  });

  return segments;
}

/**
 * Smooth throttle values with a simple moving average.
 * Returns normalized (0-1) values.
 */
function smoothThrottle(values: Float64Array, windowSize: number): Float64Array {
  const n = values.length;
  const result = new Float64Array(n);

  // First normalize all values
  for (let i = 0; i < n; i++) {
    result[i] = normalizeThrottle(values[i]);
  }

  if (windowSize <= 1) return result;

  // Apply moving average in-place using a copy
  const copy = new Float64Array(result);
  const halfW = Math.floor(windowSize / 2);

  for (let i = 0; i < n; i++) {
    const wStart = Math.max(0, i - halfW);
    const wEnd = Math.min(n, i + halfW + 1);
    let sum = 0;
    for (let j = wStart; j < wEnd; j++) {
      sum += copy[j];
    }
    result[i] = sum / (wEnd - wStart);
  }

  return result;
}

/**
 * Compute the normalized residual of a linear regression fit.
 * Returns a value in [0, 1] range where 0 = perfectly linear.
 */
function computeLinearResidual(data: Float64Array, start: number, end: number): number {
  const n = end - start;
  if (n <= 2) return 0;

  // Fit linear regression: y = a + b*x
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0;
  for (let i = start; i < end; i++) {
    const x = i - start;
    const y = data[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }

  const meanX = sumX / n;
  const meanY = sumY / n;
  const b = (sumXY - n * meanX * meanY) / (sumXX - n * meanX * meanX);
  const a = meanY - b * meanX;

  // Compute residual (RMSE normalized by range)
  let ssRes = 0;
  let yMin = Infinity,
    yMax = -Infinity;
  for (let i = start; i < end; i++) {
    const x = i - start;
    const predicted = a + b * x;
    const diff = data[i] - predicted;
    ssRes += diff * diff;
    if (data[i] < yMin) yMin = data[i];
    if (data[i] > yMax) yMax = data[i];
  }

  const range = yMax - yMin;
  if (range === 0) return 1; // Flat line is not a sweep

  const rmse = Math.sqrt(ssRes / n);
  return rmse / range;
}

/**
 * Compute throttle range within a segment.
 */
function computeThrottleRange(data: Float64Array, start: number, end: number): number {
  let min = Infinity,
    max = -Infinity;
  for (let i = start; i < end; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  return max - min;
}

// Export for testing
export { normalizeThrottle, computeStd };
