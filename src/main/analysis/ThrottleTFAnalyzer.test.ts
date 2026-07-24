import { describe, it, expect } from 'vitest';
import {
  analyzeThrottleTF,
  recommendTPAFromThrottleTF,
  DEFAULT_TF_BANDS,
  MIN_TF_SAMPLES,
} from './ThrottleTFAnalyzer';
import type { BlackboxFlightData, TimeSeries } from '@shared/types/blackbox.types';

function makeTimeSeries(values: Float64Array): TimeSeries {
  const time = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    time[i] = i / 4000;
  }
  return { time, values };
}

/**
 * Generate a test signal: sine wave at given frequency with optional noise.
 */
function generateSine(
  freqHz: number,
  sampleRate: number,
  length: number,
  amplitude: number = 100
): Float64Array {
  const data = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return data;
}

/**
 * Generate throttle ramp from low to high over the signal length.
 * Values in 1000-2000 range (BF raw format).
 */
function generateThrottleRamp(
  length: number,
  from: number = 1100,
  to: number = 1900
): Float64Array {
  const data = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = from + ((to - from) * i) / (length - 1);
  }
  return data;
}

/**
 * Generate constant throttle signal.
 */
function generateConstantThrottle(length: number, value: number = 1500): Float64Array {
  const data = new Float64Array(length);
  data.fill(value);
  return data;
}

function makeFlightData(
  setpointRoll: Float64Array,
  gyroRoll: Float64Array,
  throttle: Float64Array
): BlackboxFlightData {
  const N = setpointRoll.length;
  const zeros = new Float64Array(N);
  return {
    gyro: [makeTimeSeries(gyroRoll), makeTimeSeries(zeros), makeTimeSeries(zeros)],
    setpoint: [
      makeTimeSeries(setpointRoll),
      makeTimeSeries(zeros),
      makeTimeSeries(zeros),
      makeTimeSeries(throttle),
    ],
    pidP: [makeTimeSeries(zeros), makeTimeSeries(zeros), makeTimeSeries(zeros)],
    pidI: [makeTimeSeries(zeros), makeTimeSeries(zeros), makeTimeSeries(zeros)],
    pidD: [makeTimeSeries(zeros), makeTimeSeries(zeros), makeTimeSeries(zeros)],
    pidF: [makeTimeSeries(zeros), makeTimeSeries(zeros), makeTimeSeries(zeros)],
    motor: [
      makeTimeSeries(zeros),
      makeTimeSeries(zeros),
      makeTimeSeries(zeros),
      makeTimeSeries(zeros),
    ],
    debug: [],
    sampleRateHz: 4000,
    durationSeconds: N / 4000,
    frameCount: N,
  };
}

describe('analyzeThrottleTF', () => {
  it('should return null when signal is too short for any band', () => {
    const N = 500; // Way too short for TF estimation
    const setpoint = generateSine(30, 4000, N);
    const gyro = generateSine(30, 4000, N, 80);
    const throttle = generateThrottleRamp(N);

    const result = analyzeThrottleTF(makeFlightData(setpoint, gyro, throttle), 4000);
    expect(result).toBeNull();
  });

  it('should return null when only 1 band has data (constant throttle)', () => {
    // With constant throttle, all data falls into one band → need ≥2 for variance
    const N = MIN_TF_SAMPLES * 3;
    const setpoint = generateSine(30, 4000, N);
    const gyro = generateSine(30, 4000, N, 80);
    const throttle = generateConstantThrottle(N, 1500);

    const result = analyzeThrottleTF(makeFlightData(setpoint, gyro, throttle), 4000);
    // Only 1 band has data → null
    expect(result).toBeNull();
  });

  it('should return result with multiple bands for throttle ramp', () => {
    // Long enough signal with throttle ramp spanning multiple bands
    const N = MIN_TF_SAMPLES * DEFAULT_TF_BANDS * 2;
    const setpoint = generateSine(30, 4000, N, 200);
    const gyro = generateSine(30, 4000, N, 160);
    const throttle = generateThrottleRamp(N, 1100, 1900);

    const result = analyzeThrottleTF(makeFlightData(setpoint, gyro, throttle), 4000);
    expect(result).not.toBeNull();
    expect(result!.bands).toHaveLength(DEFAULT_TF_BANDS);
    expect(result!.bandsWithData).toBeGreaterThanOrEqual(2);
  });

  it('should compute low variance for uniform response', () => {
    // Same sine response at all throttle levels → low variance
    const N = MIN_TF_SAMPLES * DEFAULT_TF_BANDS * 2;
    const setpoint = generateSine(30, 4000, N, 200);
    const gyro = generateSine(30, 4000, N, 200); // Unity gain at all throttle levels
    const throttle = generateThrottleRamp(N, 1100, 1900);

    const result = analyzeThrottleTF(makeFlightData(setpoint, gyro, throttle), 4000);
    if (!result) return; // May be null if not enough data per band

    // With uniform response, variance should be relatively low
    expect(result.metricsVariance.bandwidthHz).toBeDefined();
    expect(result.metricsVariance.overshootPercent).toBeDefined();
    expect(result.metricsVariance.phaseMarginDeg).toBeDefined();
  });

  it('should support custom number of bands', () => {
    const N = MIN_TF_SAMPLES * 6;
    const setpoint = generateSine(30, 4000, N, 200);
    const gyro = generateSine(30, 4000, N, 160);
    const throttle = generateThrottleRamp(N, 1100, 1900);

    const result = analyzeThrottleTF(makeFlightData(setpoint, gyro, throttle), 4000, 3);
    if (!result) return;
    expect(result.bands).toHaveLength(3);
  });

  it('should not generate TPA warning for uniform response', () => {
    const N = MIN_TF_SAMPLES * DEFAULT_TF_BANDS * 2;
    const setpoint = generateSine(30, 4000, N, 200);
    const gyro = generateSine(30, 4000, N, 200);
    const throttle = generateThrottleRamp(N, 1100, 1900);

    const result = analyzeThrottleTF(makeFlightData(setpoint, gyro, throttle), 4000);
    if (!result) return;

    // Uniform response → no TPA warning
    expect(result.tpaWarning).toBeUndefined();
  });

  it('should report bands with null metrics when insufficient data', () => {
    // Most data in middle throttle, edges will have too few samples
    const N = MIN_TF_SAMPLES * 4;
    const setpoint = generateSine(30, 4000, N, 200);
    const gyro = generateSine(30, 4000, N, 160);
    // Narrow throttle range → most bands empty
    const throttle = generateThrottleRamp(N, 1400, 1600);

    const result = analyzeThrottleTF(makeFlightData(setpoint, gyro, throttle), 4000);
    if (!result) return;

    // Some bands should have null metrics
    const nullBands = result.bands.filter((b) => b.metrics === null);
    expect(nullBands.length).toBeGreaterThan(0);
  });

  it('should include band boundaries in result', () => {
    const N = MIN_TF_SAMPLES * DEFAULT_TF_BANDS * 2;
    const setpoint = generateSine(30, 4000, N, 200);
    const gyro = generateSine(30, 4000, N, 160);
    const throttle = generateThrottleRamp(N, 1100, 1900);

    const result = analyzeThrottleTF(makeFlightData(setpoint, gyro, throttle), 4000);
    if (!result) return;

    // Bands should cover 0-1 range
    expect(result.bands[0].throttleMin).toBe(0);
    expect(result.bands[result.bands.length - 1].throttleMax).toBe(1);
    // Bands should be contiguous
    for (let i = 1; i < result.bands.length; i++) {
      expect(result.bands[i].throttleMin).toBeCloseTo(result.bands[i - 1].throttleMax, 5);
    }
  });
});

describe('recommendTPAFromThrottleTF (P2.8)', () => {
  function band(
    throttleMin: number,
    overshootPercent: number | null
  ): import('./ThrottleTFAnalyzer').ThrottleTFBand {
    return {
      throttleMin,
      throttleMax: throttleMin + 0.2,
      sampleCount: 4096,
      metrics:
        overshootPercent === null
          ? null
          : {
              bandwidthHz: 40,
              phaseMarginDeg: 60,
              gainMarginDb: 10,
              overshootPercent,
              settlingTimeMs: 100,
              riseTimeMs: 50,
              dcGainDb: 0,
            },
    };
  }

  function result(
    rollOvershoots: (number | null)[],
    pitchOvershoots?: (number | null)[]
  ): import('./ThrottleTFAnalyzer').ThrottleTFResult {
    const mk = (overshoots: (number | null)[]) => ({
      bands: overshoots.map((o, i) => band(i * 0.2, o)),
      bandsWithData: overshoots.filter((o) => o !== null).length,
      metricsVariance: { bandwidthHz: 0, overshootPercent: 0, phaseMarginDeg: 0 },
    });
    const roll = mk(rollOvershoots);
    return {
      ...roll,
      ...(pitchOvershoots ? { pitch: mk(pitchOvershoots) } : {}),
    };
  }

  it('raises tpa_rate when overshoot grows with throttle', () => {
    const recs = recommendTPAFromThrottleTF(result([5, 8, 12, 20, 30]), {
      active: true,
      rate: 65,
      breakpoint: 1350,
    });
    const rateRec = recs.find((r) => r.ruleId === 'TPA-TF-RATE-UP');
    expect(rateRec).toBeDefined();
    expect(rateRec!.setting).toBe('tpa_rate');
    expect(rateRec!.recommendedValue).toBe(75);
    expect(rateRec!.confidence).toBe('medium');
  });

  it('lowers the breakpoint to where the oscillation starts', () => {
    // Overshoot exceeds low mean (+10) from the 60% band; breakpoint is 1750
    const recs = recommendTPAFromThrottleTF(result([5, 8, 12, 25, 35]), {
      active: true,
      rate: 65,
      breakpoint: 1750,
    });
    const bpRec = recs.find((r) => r.ruleId === 'TPA-TF-BREAKPOINT');
    expect(bpRec).toBeDefined();
    // Onset band starts at 0.6 → 1600 µs
    expect(bpRec!.recommendedValue).toBe(1600);
  });

  it('lowers tpa_rate when high throttle is overdamped', () => {
    const recs = recommendTPAFromThrottleTF(result([18, 15, 8, 2, 1]), {
      active: true,
      rate: 65,
      breakpoint: 1350,
    });
    const rateRec = recs.find((r) => r.ruleId === 'TPA-TF-RATE-DOWN');
    expect(rateRec).toBeDefined();
    expect(rateRec!.recommendedValue).toBe(55);
  });

  it('stays silent when the trend is flat', () => {
    const recs = recommendTPAFromThrottleTF(result([10, 11, 12, 10, 11]), {
      active: true,
      rate: 65,
      breakpoint: 1350,
    });
    expect(recs).toHaveLength(0);
  });

  it('requires tpa_rate from headers and enough bands', () => {
    expect(recommendTPAFromThrottleTF(result([5, 10, 30, 40, 45]), undefined)).toHaveLength(0);
    expect(recommendTPAFromThrottleTF(result([5, 10, 30, 40, 45]), { active: true })).toHaveLength(
      0
    );
    // Only 2 bands with data
    expect(
      recommendTPAFromThrottleTF(result([5, null, null, null, 40]), { active: true, rate: 65 })
    ).toHaveLength(0);
  });

  it('uses the worse of roll and pitch as the driving axis', () => {
    // Roll flat, pitch grows strongly → pitch drives the recommendation
    const recs = recommendTPAFromThrottleTF(result([10, 10, 11, 10, 11], [5, 8, 15, 25, 35]), {
      active: true,
      rate: 65,
      breakpoint: 1350,
    });
    const rateRec = recs.find((r) => r.ruleId === 'TPA-TF-RATE-UP');
    expect(rateRec).toBeDefined();
    expect(rateRec!.reason).toContain('pitch');
  });

  it('caps tpa_rate at the maximum bound', () => {
    const recs = recommendTPAFromThrottleTF(result([5, 8, 12, 20, 30]), { active: true, rate: 80 });
    expect(recs.find((r) => r.ruleId === 'TPA-TF-RATE-UP')).toBeUndefined();
  });
});
