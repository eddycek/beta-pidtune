import { describe, it, expect } from 'vitest';
import {
  findSteadySegments,
  findThrottleSweepSegments,
  normalizeThrottle,
  computeStd,
} from './SegmentSelector';
import type { BlackboxFlightData, TimeSeries } from '@shared/types/blackbox.types';

/**
 * Create a minimal BlackboxFlightData with specified throttle and gyro values.
 */
function createFlightData(opts: {
  sampleRate: number;
  numSamples: number;
  throttle?: (i: number) => number;
  gyroRoll?: (i: number) => number;
  gyroPitch?: (i: number) => number;
  gyroYaw?: (i: number) => number;
}): BlackboxFlightData {
  const { sampleRate, numSamples } = opts;
  const throttleFn = opts.throttle || (() => 0.5);
  const rollFn = opts.gyroRoll || (() => 0);
  const pitchFn = opts.gyroPitch || (() => 0);
  const yawFn = opts.gyroYaw || (() => 0);

  function makeSeries(fn: (i: number) => number): TimeSeries {
    const time = new Float64Array(numSamples);
    const values = new Float64Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      time[i] = i / sampleRate;
      values[i] = fn(i);
    }
    return { time, values };
  }

  const zeroSeries = makeSeries(() => 0);

  return {
    gyro: [makeSeries(rollFn), makeSeries(pitchFn), makeSeries(yawFn)],
    setpoint: [zeroSeries, zeroSeries, zeroSeries, makeSeries(throttleFn)],
    pidP: [zeroSeries, zeroSeries, zeroSeries],
    pidI: [zeroSeries, zeroSeries, zeroSeries],
    pidD: [zeroSeries, zeroSeries, zeroSeries],
    pidF: [zeroSeries, zeroSeries, zeroSeries],
    motor: [zeroSeries, zeroSeries, zeroSeries, zeroSeries],
    debug: [],
    sampleRateHz: sampleRate,
    durationSeconds: numSamples / sampleRate,
    frameCount: numSamples,
  };
}

describe('normalizeThrottle', () => {
  it('should pass through values in 0-1 range', () => {
    expect(normalizeThrottle(0.5)).toBeCloseTo(0.5);
    expect(normalizeThrottle(0)).toBeCloseTo(0);
    expect(normalizeThrottle(1)).toBeCloseTo(1);
  });

  it('should normalize 0-100 range to 0-1', () => {
    expect(normalizeThrottle(50)).toBeCloseTo(0.5);
    expect(normalizeThrottle(100)).toBeCloseTo(1.0);
  });

  it('should normalize 0-1000 range to 0-1', () => {
    expect(normalizeThrottle(500)).toBeCloseTo(0.5);
    expect(normalizeThrottle(1000)).toBeCloseTo(1.0);
  });

  it('should normalize 1000-2000 range to 0-1', () => {
    expect(normalizeThrottle(1500)).toBeCloseTo(0.5);
    expect(normalizeThrottle(2000)).toBeCloseTo(1.0);
  });
});

describe('computeStd', () => {
  it('should return 0 for constant values', () => {
    const arr = new Float64Array([5, 5, 5, 5, 5]);
    expect(computeStd(arr, 0, 5)).toBe(0);
  });

  it('should compute correct standard deviation', () => {
    const arr = new Float64Array([2, 4, 4, 4, 5, 5, 7, 9]);
    const std = computeStd(arr, 0, 8);
    expect(std).toBeCloseTo(2.0, 1);
  });

  it('should handle sub-range', () => {
    const arr = new Float64Array([100, 100, 1, 2, 3, 100, 100]);
    const std = computeStd(arr, 2, 5); // [1, 2, 3]
    expect(std).toBeCloseTo(0.816, 2);
  });

  it('should return 0 for single element', () => {
    const arr = new Float64Array([42]);
    expect(computeStd(arr, 0, 1)).toBe(0);
  });
});

describe('findSteadySegments', () => {
  it('should return entire flight for constant hover', () => {
    const sampleRate = 4000;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * 2, // 2 seconds
      throttle: () => 0.5,
      gyroRoll: () => 0,
      gyroPitch: () => 0,
    });

    const segments = findSteadySegments(data);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    // Largest segment should cover most of the flight
    expect(segments[0].durationSeconds).toBeGreaterThan(1.5);
    expect(segments[0].averageThrottle).toBeCloseTo(0.5, 1);
  });

  it('should return empty array for all-ground data (low throttle)', () => {
    const data = createFlightData({
      sampleRate: 4000,
      numSamples: 8000,
      throttle: () => 0.05, // Below THROTTLE_MIN_FLIGHT
    });

    const segments = findSteadySegments(data);
    expect(segments.length).toBe(0);
  });

  it('should return empty array for empty flight data', () => {
    const data = createFlightData({
      sampleRate: 4000,
      numSamples: 0,
    });

    const segments = findSteadySegments(data);
    expect(segments.length).toBe(0);
  });

  it('should exclude high-throttle segments', () => {
    const sampleRate = 4000;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * 4,
      throttle: (i) => {
        // First 2s: hover, last 2s: full throttle
        return i < sampleRate * 2 ? 0.5 : 0.95;
      },
    });

    const segments = findSteadySegments(data);
    // All segments should be in the first 2 seconds
    for (const seg of segments) {
      expect(seg.startIndex).toBeLessThan(sampleRate * 2);
    }
  });

  it('should exclude segments with high gyro variance (acro)', () => {
    const sampleRate = 4000;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * 4,
      throttle: () => 0.5,
      gyroRoll: (i) => {
        // First 2s: calm, last 2s: aggressive maneuvers
        return i < sampleRate * 2 ? Math.random() * 5 : Math.random() * 500;
      },
    });

    const segments = findSteadySegments(data);
    // Should only find segments in the calm region
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      // Segment should be primarily in the first 2 seconds
      expect(seg.startIndex).toBeLessThan(sampleRate * 2.5);
    }
  });

  it('should detect multiple hover segments', () => {
    const sampleRate = 4000;
    const totalSamples = sampleRate * 6;
    const data = createFlightData({
      sampleRate,
      numSamples: totalSamples,
      throttle: (i) => {
        const t = i / sampleRate;
        // 0-2s: hover, 2-3s: ground, 3-5s: hover, 5-6s: ground
        if (t < 2) return 0.5;
        if (t < 3) return 0.05;
        if (t < 5) return 0.5;
        return 0.05;
      },
    });

    const segments = findSteadySegments(data);
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });

  it('should reject segments shorter than minimum duration', () => {
    const sampleRate = 4000;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * 2,
      throttle: (i) => {
        const t = i / sampleRate;
        // Alternate rapidly: 0.1s hover, 0.1s ground
        const period = Math.floor(t * 10) % 2;
        return period === 0 ? 0.5 : 0.05;
      },
    });

    const segments = findSteadySegments(data);
    // 0.1s segments should be rejected (min is 0.5s)
    for (const seg of segments) {
      expect(seg.durationSeconds).toBeGreaterThanOrEqual(0.4); // slight tolerance
    }
  });

  it('should sort segments by duration (longest first)', () => {
    const sampleRate = 4000;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * 10,
      throttle: (i) => {
        const t = i / sampleRate;
        // Short hover (1s), ground (1s), long hover (5s), ground (3s)
        if (t < 1) return 0.5;
        if (t < 2) return 0.05;
        if (t < 7) return 0.5;
        return 0.05;
      },
    });

    const segments = findSteadySegments(data);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    // First segment should be longer
    expect(segments[0].durationSeconds).toBeGreaterThanOrEqual(segments[1].durationSeconds);
  });

  it('should compute correct averageThrottle', () => {
    const data = createFlightData({
      sampleRate: 4000,
      numSamples: 8000,
      throttle: () => 0.4,
    });

    const segments = findSteadySegments(data);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0].averageThrottle).toBeCloseTo(0.4, 1);
  });

  it('should populate minThrottle and maxThrottle', () => {
    const sampleRate = 4000;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * 2,
      // Throttle varies within hover range: 0.3 to 0.6
      throttle: (i) => 0.3 + (i / (sampleRate * 2)) * 0.3,
    });

    const segments = findSteadySegments(data);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0].minThrottle).toBeCloseTo(0.3, 1);
    expect(segments[0].maxThrottle).toBeCloseTo(0.6, 1);
    expect(segments[0].minThrottle).toBeLessThan(segments[0].averageThrottle);
    expect(segments[0].maxThrottle).toBeGreaterThan(segments[0].averageThrottle);
  });

  it('should handle throttle in 1000-2000 range', () => {
    const data = createFlightData({
      sampleRate: 4000,
      numSamples: 8000,
      throttle: () => 1500, // ~50% in 1000-2000 range
    });

    const segments = findSteadySegments(data);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0].averageThrottle).toBeCloseTo(0.5, 1);
  });
});

describe('findThrottleSweepSegments', () => {
  it('should find a linear throttle ramp (upward)', () => {
    const sampleRate = 4000;
    const duration = 5; // 5 seconds
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * duration,
      throttle: (i) => {
        // Linear ramp from 0.2 to 0.9 over 5 seconds
        return 0.2 + (i / (sampleRate * duration)) * 0.7;
      },
    });

    const segments = findThrottleSweepSegments(data);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments[0].durationSeconds).toBeGreaterThan(2);
  });

  it('should find a linear throttle ramp (downward)', () => {
    const sampleRate = 4000;
    const duration = 5;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * duration,
      throttle: (i) => {
        // Linear ramp from 0.9 to 0.2 over 5 seconds
        return 0.9 - (i / (sampleRate * duration)) * 0.7;
      },
    });

    const segments = findThrottleSweepSegments(data);
    expect(segments.length).toBeGreaterThanOrEqual(1);
  });

  it('should ignore short ramps below SWEEP_MIN_DURATION_S', () => {
    const sampleRate = 4000;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * 1, // Only 1 second — below 2s minimum
      throttle: (i) => {
        return 0.2 + (i / (sampleRate * 1)) * 0.7;
      },
    });

    const segments = findThrottleSweepSegments(data);
    expect(segments.length).toBe(0);
  });

  it('should ignore ramps with insufficient throttle range', () => {
    const sampleRate = 4000;
    const duration = 5;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * duration,
      throttle: (i) => {
        // Only 20% range (0.4 to 0.6) — below 40% minimum
        return 0.4 + (i / (sampleRate * duration)) * 0.2;
      },
    });

    const segments = findThrottleSweepSegments(data);
    expect(segments.length).toBe(0);
  });

  it('should ignore non-monotonic (random) throttle data', () => {
    const sampleRate = 4000;
    const duration = 5;
    // Use a seed-like approach for deterministic "random"
    let state = 42;
    const pseudoRandom = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };

    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * duration,
      throttle: () => {
        return 0.2 + pseudoRandom() * 0.7;
      },
    });

    const segments = findThrottleSweepSegments(data);
    expect(segments.length).toBe(0);
  });

  it('should return empty for constant throttle (hover)', () => {
    const sampleRate = 4000;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * 5,
      throttle: () => 0.5,
    });

    const segments = findThrottleSweepSegments(data);
    expect(segments.length).toBe(0);
  });

  it('should return empty for empty flight data', () => {
    const data = createFlightData({
      sampleRate: 4000,
      numSamples: 0,
    });

    const segments = findThrottleSweepSegments(data);
    expect(segments.length).toBe(0);
  });

  it('should detect multiple sweeps in one flight', () => {
    const sampleRate = 4000;
    const duration = 12;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * duration,
      throttle: (i) => {
        const t = i / sampleRate;
        if (t < 4) {
          // First sweep: ramp up from 0.2 to 0.8
          return 0.2 + (t / 4) * 0.6;
        }
        if (t < 6) {
          // Steady hover (no sweep)
          return 0.5;
        }
        // Second sweep: ramp up from 0.3 to 0.9
        return 0.3 + ((t - 6) / 6) * 0.6;
      },
    });

    const segments = findThrottleSweepSegments(data);
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle throttle in 1000-2000 range', () => {
    const sampleRate = 4000;
    const duration = 5;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * duration,
      throttle: (i) => {
        // Ramp from 1200 to 1900 (normalized: 0.2 to 0.9)
        return 1200 + (i / (sampleRate * duration)) * 700;
      },
    });

    const segments = findThrottleSweepSegments(data);
    expect(segments.length).toBeGreaterThanOrEqual(1);
  });

  it('should populate minThrottle and maxThrottle for sweep segments', () => {
    const sampleRate = 4000;
    const duration = 5;
    const data = createFlightData({
      sampleRate,
      numSamples: sampleRate * duration,
      throttle: (i) => {
        // Linear ramp from 0.2 to 0.9
        return 0.2 + (i / (sampleRate * duration)) * 0.7;
      },
    });

    const segments = findThrottleSweepSegments(data);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments[0].minThrottle).toBeLessThan(segments[0].maxThrottle);
    expect(segments[0].minThrottle).toBeCloseTo(0.2, 1);
    expect(segments[0].maxThrottle).toBeCloseTo(0.9, 1);
  });
});

describe('yaw steadiness (relaxed threshold)', () => {
  it('rejects segments with an active yaw spin', () => {
    // Roll/pitch steady, yaw spinning hard (std >> 75 deg/s)
    const data = createFlightData({
      sampleRate: 1000,
      numSamples: 4000,
      throttle: () => 0.5,
      gyroYaw: (i) => 300 * Math.sin(i * 0.3),
    });
    expect(findSteadySegments(data).length).toBe(0);
  });

  it('tolerates moderate yaw noise above the roll/pitch limit', () => {
    // Yaw std ~60 deg/s: above GYRO_STEADY_MAX_STD (50) but below 50×1.5
    const data = createFlightData({
      sampleRate: 1000,
      numSamples: 4000,
      throttle: () => 0.5,
      gyroYaw: (i) => 85 * Math.sin(i * 0.3),
    });
    expect(findSteadySegments(data).length).toBeGreaterThan(0);
  });
});
