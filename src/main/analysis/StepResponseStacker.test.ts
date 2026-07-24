import { describe, it, expect } from 'vitest';
import {
  computeDeconvolvedStepResponse,
  isGroupTrustworthy,
  DECONV_COHERENCE_GATE,
} from './StepResponseStacker';
import { INPUT_SPLIT_THRESHOLD_DEG_S, DECONV_MIN_WINDOWS } from './constants';
import type { BlackboxFlightData, TimeSeries } from '@shared/types/blackbox.types';

const SAMPLE_RATE = 4000;

/** Simulate a second-order system x'' + 2ζωx' + ω²x = ω²u */
function secondOrderResponse(
  setpoint: Float64Array,
  sampleRate: number,
  naturalFreqHz: number,
  dampingRatio: number
): Float64Array {
  const gyro = new Float64Array(setpoint.length);
  const wn = 2 * Math.PI * naturalFreqHz;
  const dt = 1 / sampleRate;
  let x = 0;
  let xDot = 0;
  for (let i = 0; i < setpoint.length; i++) {
    const xDotDot = wn * wn * (setpoint[i] - x) - 2 * dampingRatio * wn * xDot;
    xDot += xDotDot * dt;
    x += xDot * dt;
    gyro[i] = x;
  }
  return gyro;
}

/** Freestyle-like stick input mixing small (<500) and large (>=500) snaps */
function mixedMagnitudeSetpoint(durationS: number): Float64Array {
  const N = Math.floor(SAMPLE_RATE * durationS);
  const signal = new Float64Array(N);
  const steps = [
    { startS: 0.5, magnitude: 200 },
    { startS: 2.0, magnitude: -800 },
    { startS: 3.5, magnitude: 300 },
    { startS: 5.0, magnitude: 700 },
    { startS: 6.5, magnitude: -250 },
    { startS: 8.0, magnitude: -900 },
    { startS: 9.5, magnitude: 150 },
    { startS: 11.0, magnitude: 850 },
    { startS: 12.5, magnitude: -300 },
    { startS: 14.0, magnitude: 750 },
    { startS: 15.5, magnitude: 220 },
    { startS: 17.0, magnitude: -650 },
  ];
  let current = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SAMPLE_RATE;
    for (const step of steps) {
      if (t >= step.startS && t < step.startS + 0.7) current = step.magnitude;
      else if (t >= step.startS + 0.7 && t < step.startS + 0.75) current = 0;
    }
    signal[i] = current;
  }
  return signal;
}

function makeFlightData(setpoint: Float64Array, gyro: Float64Array): BlackboxFlightData {
  const N = setpoint.length;
  const time = new Float64Array(N).map((_, i) => i / SAMPLE_RATE);
  const sp: TimeSeries = { time, values: setpoint };
  const gy: TimeSeries = { time, values: gyro };
  const zero: TimeSeries = { time, values: new Float64Array(N) };
  return {
    gyro: [gy, gy, gy],
    setpoint: [sp, sp, sp, zero],
    pidP: [zero, zero, zero],
    pidI: [zero, zero, zero],
    pidD: [zero, zero, zero],
    pidF: [zero, zero, zero],
    motor: [zero, zero, zero, zero],
    debug: [],
    sampleRateHz: SAMPLE_RATE,
    durationSeconds: N / SAMPLE_RATE,
    frameCount: N,
  };
}

describe('computeDeconvolvedStepResponse', () => {
  it('recovers the overshoot of a known second-order plant', () => {
    // ζ=0.45 → analytic overshoot exp(-πζ/√(1-ζ²)) ≈ 20.5%
    const setpoint = mixedMagnitudeSetpoint(19);
    const gyro = secondOrderResponse(setpoint, SAMPLE_RATE, 25, 0.45);
    const result = computeDeconvolvedStepResponse(makeFlightData(setpoint, gyro));

    const primary = result.roll.primary;
    expect(primary).toBeDefined();
    // Smoothed impulse + regularization soften the estimate — generous band
    expect(primary!.overshootPercent).toBeGreaterThan(8);
    expect(primary!.overshootPercent).toBeLessThan(35);
    expect(primary!.coherenceMean!).toBeGreaterThan(0.8);
  });

  it('a well-damped plant shows near-zero overshoot', () => {
    const setpoint = mixedMagnitudeSetpoint(19);
    const gyro = secondOrderResponse(setpoint, SAMPLE_RATE, 25, 0.95);
    const result = computeDeconvolvedStepResponse(makeFlightData(setpoint, gyro));

    const primary = result.roll.primary;
    expect(primary).toBeDefined();
    expect(primary!.overshootPercent).toBeLessThan(8);
  });

  it('splits low and high input magnitudes', () => {
    const setpoint = mixedMagnitudeSetpoint(19);
    const gyro = secondOrderResponse(setpoint, SAMPLE_RATE, 25, 0.6);
    const result = computeDeconvolvedStepResponse(makeFlightData(setpoint, gyro));

    // The mixed input includes windows both below and above 500 deg/s
    expect(result.splitThresholdDegS).toBe(INPUT_SPLIT_THRESHOLD_DEG_S);
    expect(result.roll.low ?? result.roll.high).toBeDefined();
    expect(result.roll.high).toBeDefined();
    // High-magnitude group preferred as primary when trustworthy
    if (result.roll.high && result.roll.high.coherenceMean !== undefined) {
      expect(result.roll.primary).toEqual(result.roll.high);
    }
  });

  it('withholds primary metrics when gyro is unrelated to setpoint (low coherence)', () => {
    const setpoint = mixedMagnitudeSetpoint(19);
    const gyro = new Float64Array(setpoint.length);
    for (let i = 0; i < gyro.length; i++) {
      const t = i / SAMPLE_RATE;
      gyro[i] = 100 * Math.sin(2 * Math.PI * 3.7 * t) + 60 * Math.sin(2 * Math.PI * 9.1 * t + 1);
    }
    const result = computeDeconvolvedStepResponse(makeFlightData(setpoint, gyro));
    expect(result.roll.primary).toBeUndefined();
  });

  it('returns empty axis results for very short signals', () => {
    const setpoint = new Float64Array(32).fill(100);
    const gyro = new Float64Array(32).fill(100);
    const result = computeDeconvolvedStepResponse(makeFlightData(setpoint, gyro));
    expect(result.roll.primary).toBeUndefined();
    expect(result.roll.low).toBeUndefined();
    expect(result.roll.high).toBeUndefined();
  });
});

describe('isGroupTrustworthy', () => {
  const base = {
    overshootPercent: 10,
    riseTimeMs: 30,
    settlingTimeMs: 100,
    windowCount: DECONV_MIN_WINDOWS,
    coherenceMean: DECONV_COHERENCE_GATE,
  };

  it('accepts a coherent multi-window group', () => {
    expect(isGroupTrustworthy(base)).toBe(true);
  });

  it('rejects single-window groups', () => {
    expect(isGroupTrustworthy({ ...base, windowCount: 1 })).toBe(false);
  });

  it('rejects low-coherence groups', () => {
    expect(isGroupTrustworthy({ ...base, coherenceMean: 0.3 })).toBe(false);
  });

  it('rejects groups without coherence', () => {
    const { coherenceMean: _omit, ...noCoherence } = base;
    expect(isGroupTrustworthy(noCoherence)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isGroupTrustworthy(undefined)).toBe(false);
  });
});
