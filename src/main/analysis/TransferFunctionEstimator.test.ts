import { describe, it, expect } from 'vitest';
import {
  estimateTransferFunction,
  estimateAllAxes,
  computeSyntheticStepResponse,
  computeDcGainDb,
  computeCoherenceMean,
  extractMetrics,
  type BodeResult,
  type SyntheticStepResponse,
} from './TransferFunctionEstimator';

// ---- Test Helpers ----

function generateSine(
  frequency: number,
  sampleRate: number,
  numSamples: number,
  amplitude = 1.0
): Float64Array {
  const signal = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    signal[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return signal;
}

/**
 * Generate a second-order system step response for testing.
 * gyro = setpoint convolved with system impulse response.
 */
function generateSecondOrderResponse(
  setpoint: Float64Array,
  sampleRate: number,
  naturalFreqHz: number,
  dampingRatio: number,
  latencyMs: number
): Float64Array {
  const gyro = new Float64Array(setpoint.length);
  const wn = 2 * Math.PI * naturalFreqHz;
  const dt = 1 / sampleRate;
  const latencySamples = Math.round((latencyMs / 1000) * sampleRate);

  // Simple simulation: x'' + 2*zeta*wn*x' + wn^2*x = wn^2*u
  let x = 0;
  let xDot = 0;

  for (let i = 0; i < setpoint.length; i++) {
    const uIdx = Math.max(0, i - latencySamples);
    const u = setpoint[uIdx];
    const xDotDot = wn * wn * (u - x) - 2 * dampingRatio * wn * xDot;
    xDot += xDotDot * dt;
    x += xDot * dt;
    gyro[i] = x;
  }

  return gyro;
}

/**
 * Generate mixed stick inputs (freestyle-like) for realistic testing.
 */
function generateMixedStickInputs(sampleRate: number, durationS: number): Float64Array {
  const N = Math.floor(sampleRate * durationS);
  const signal = new Float64Array(N);

  // Mix of step inputs at different times and magnitudes
  const steps = [
    { startS: 0.5, magnitude: 300 },
    { startS: 1.5, magnitude: -200 },
    { startS: 2.5, magnitude: 400 },
    { startS: 3.5, magnitude: -350 },
    { startS: 4.5, magnitude: 250 },
    { startS: 5.5, magnitude: -300 },
  ];

  let current = 0;
  for (let i = 0; i < N; i++) {
    const t = i / sampleRate;
    for (const step of steps) {
      if (t >= step.startS && t < step.startS + 0.3) {
        current = step.magnitude;
      }
    }
    // Smooth decay back to 0
    if (current !== 0) {
      current *= 0.999;
      if (Math.abs(current) < 1) current = 0;
    }
    signal[i] = current;
  }

  return signal;
}

// ---- Tests ----

describe('estimateTransferFunction', () => {
  const sampleRate = 4000;

  it('should estimate unity transfer function for identical input/output', () => {
    const N = 16384;
    const setpoint = generateSine(50, sampleRate, N, 100);
    const gyro = new Float64Array(setpoint); // Perfect tracking

    const { bode } = estimateTransferFunction(setpoint, gyro, sampleRate);

    expect(bode.frequencies.length).toBeGreaterThan(0);
    expect(bode.magnitude.length).toBe(bode.frequencies.length);
    expect(bode.phase.length).toBe(bode.frequencies.length);

    // At 50 Hz, magnitude should be close to 0 dB (unity)
    const idx50 = findClosestBin(bode.frequencies, 50);
    expect(bode.magnitude[idx50]).toBeCloseTo(0, 0);
  });

  it('should detect gain attenuation at high frequencies for a low-pass system', () => {
    const N = 32768;
    const setpoint = generateMixedStickInputs(sampleRate, N / sampleRate);
    const gyro = generateSecondOrderResponse(setpoint, sampleRate, 80, 0.7, 5);

    const { bode } = estimateTransferFunction(setpoint, gyro, sampleRate);

    // At low frequencies, gain should be near 0 dB
    const idxLow = findClosestBin(bode.frequencies, 10);
    expect(bode.magnitude[idxLow]).toBeGreaterThan(-6);

    // At high frequencies, gain should be attenuated
    const idxHigh = findClosestBin(bode.frequencies, 300);
    expect(bode.magnitude[idxHigh]).toBeLessThan(bode.magnitude[idxLow]);
  });

  it('should produce impulse response with correct length', () => {
    const N = 8192;
    const setpoint = generateSine(100, sampleRate, N, 200);
    const gyro = generateSecondOrderResponse(setpoint, sampleRate, 100, 0.5, 3);

    const { impulseResponse } = estimateTransferFunction(setpoint, gyro, sampleRate);

    // Impulse response length = window size (power of 2 <= N)
    expect(impulseResponse.length).toBeGreaterThanOrEqual(64);
    expect(impulseResponse.length & (impulseResponse.length - 1)).toBe(0); // power of 2
  });

  it('should throw for signal too short', () => {
    const short = new Float64Array(32);
    expect(() => estimateTransferFunction(short, short, sampleRate)).toThrow('Signal too short');
  });

  it('should handle signals of different lengths (uses minimum)', () => {
    const setpoint = generateSine(50, sampleRate, 16384, 100);
    const gyro = generateSine(50, sampleRate, 8192, 100);

    // Should not throw — uses min(16384, 8192) = 8192
    const { bode } = estimateTransferFunction(setpoint, gyro, sampleRate);
    expect(bode.frequencies.length).toBeGreaterThan(0);
  });

  it('should report progress', () => {
    const N = 16384;
    const setpoint = generateSine(50, sampleRate, N, 100);
    const gyro = new Float64Array(setpoint);

    const steps: string[] = [];
    estimateTransferFunction(setpoint, gyro, sampleRate, (p) => {
      steps.push(p.step);
    });

    expect(steps).toContain('windowing');
    expect(steps).toContain('fft');
    expect(steps).toContain('transfer_function');
    expect(steps).toContain('metrics');
  });

  it('should handle silent setpoint gracefully (no division errors)', () => {
    const N = 8192;
    const setpoint = new Float64Array(N); // All zeros
    const gyro = generateSine(50, sampleRate, N, 10);

    // Should not throw — regularization prevents division by zero
    const { bode } = estimateTransferFunction(setpoint, gyro, sampleRate);
    expect(bode.frequencies.length).toBeGreaterThan(0);
    // Magnitudes should be heavily attenuated (noise-like)
  });
});

describe('computeSyntheticStepResponse', () => {
  it('should produce normalized response approaching 1.0', () => {
    const sampleRate = 4000;
    // Simple decaying impulse
    const impulse = new Float64Array(4096);
    impulse[0] = 1;
    for (let i = 1; i < 100; i++) {
      impulse[i] = Math.exp(-i / 20);
    }

    const step = computeSyntheticStepResponse(impulse, sampleRate);

    expect(step.timeMs.length).toBeGreaterThan(0);
    expect(step.response.length).toBe(step.timeMs.length);

    // Final value should be normalized to 1.0
    const lastValue = step.response[step.response.length - 1];
    expect(lastValue).toBeCloseTo(1.0, 1);
  });

  it('should handle very short impulse response', () => {
    const impulse = new Float64Array(2);
    impulse[0] = 1;
    impulse[1] = 0;

    const step = computeSyntheticStepResponse(impulse, 4000);
    // With 2 samples, maxSamples = min(2000, 1) = 1
    expect(step.timeMs.length).toBe(1);
  });

  it('should have monotonically increasing time', () => {
    const impulse = new Float64Array(8192);
    impulse[0] = 1;
    for (let i = 1; i < 200; i++) {
      impulse[i] = Math.exp(-i / 30);
    }

    const step = computeSyntheticStepResponse(impulse, 4000);

    for (let i = 1; i < step.timeMs.length; i++) {
      expect(step.timeMs[i]).toBeGreaterThan(step.timeMs[i - 1]);
    }
  });

  it('should handle zero impulse response', () => {
    const impulse = new Float64Array(4096); // All zeros
    const step = computeSyntheticStepResponse(impulse, 4000);

    // With zero impulse, cumSum stays 0, finalValue is 0 → no normalization
    expect(step.response.every((v) => v === 0)).toBe(true);
  });
});

describe('extractMetrics', () => {
  it('should compute bandwidth from Bode magnitude', () => {
    // Flat magnitude at 0 dB up to 100 Hz, then drop
    const N = 256;
    const frequencies = new Float64Array(N);
    const magnitude = new Float64Array(N);
    const phase = new Float64Array(N);

    for (let i = 0; i < N; i++) {
      frequencies[i] = i * 2; // 0-510 Hz
      magnitude[i] = i * 2 < 100 ? 0 : -10; // -3dB drop at 100 Hz
      phase[i] = -i * 0.5;
    }

    const bode: BodeResult = { frequencies, magnitude, phase };
    const step: SyntheticStepResponse = { timeMs: [0, 1], response: [0, 1] };

    const metrics = extractMetrics(bode, step, 4000);
    // Bandwidth should be around 98 Hz (last bin above -3 dB)
    expect(metrics.bandwidthHz).toBeGreaterThanOrEqual(96);
    expect(metrics.bandwidthHz).toBeLessThanOrEqual(100);
  });

  it('should compute overshoot from step response', () => {
    const step: SyntheticStepResponse = {
      timeMs: [0, 5, 10, 15, 20, 25, 30],
      response: [0, 0.5, 1.0, 1.3, 1.1, 1.0, 1.0], // 30% overshoot
    };

    const bode: BodeResult = {
      frequencies: new Float64Array([0, 100]),
      magnitude: new Float64Array([0, -10]),
      phase: new Float64Array([0, -90]),
    };

    const metrics = extractMetrics(bode, step, 4000);
    expect(metrics.overshootPercent).toBeCloseTo(30, 0);
  });

  it('should compute rise time from step response', () => {
    const step: SyntheticStepResponse = {
      timeMs: [0, 2, 4, 6, 8, 10, 12, 14],
      response: [0, 0.05, 0.1, 0.5, 0.9, 1.0, 1.0, 1.0],
    };

    const bode: BodeResult = {
      frequencies: new Float64Array([0]),
      magnitude: new Float64Array([0]),
      phase: new Float64Array([0]),
    };

    const metrics = extractMetrics(bode, step, 4000);
    // Rise time from 0.1 (t=4ms) to 0.9 (t=8ms) = 4ms
    expect(metrics.riseTimeMs).toBeCloseTo(4, 0);
  });

  it('should compute settling time from step response', () => {
    const step: SyntheticStepResponse = {
      timeMs: [0, 5, 10, 15, 20, 25, 30, 35, 40],
      response: [0, 0.5, 1.2, 1.05, 0.97, 1.01, 1.0, 1.0, 1.0],
      // Last exit from ±2% band is at index 4 (0.97 < 0.98)
    };

    const bode: BodeResult = {
      frequencies: new Float64Array([0]),
      magnitude: new Float64Array([0]),
      phase: new Float64Array([0]),
    };

    const metrics = extractMetrics(bode, step, 4000);
    expect(metrics.settlingTimeMs).toBe(25); // index 4+1 = 5 → 25ms
  });

  it('should compute gain margin', () => {
    // Phase crosses -180 at some frequency
    const N = 100;
    const frequencies = new Float64Array(N);
    const magnitude = new Float64Array(N);
    const phase = new Float64Array(N);

    for (let i = 0; i < N; i++) {
      frequencies[i] = i * 5;
      magnitude[i] = -i * 0.2; // Linearly decreasing
      phase[i] = -i * 2; // Linearly decreasing phase
    }

    const bode: BodeResult = { frequencies, magnitude, phase };
    const step: SyntheticStepResponse = { timeMs: [0], response: [1] };

    const metrics = extractMetrics(bode, step, 4000);
    // Phase crosses -180 at i=90 → magnitude at i=90 = -18 dB → gain margin = 18 dB
    expect(metrics.gainMarginDb).toBeGreaterThan(0); // Positive = stable
  });

  it('should return high gain margin when phase never crosses -180', () => {
    const bode: BodeResult = {
      frequencies: new Float64Array([0, 100, 200]),
      magnitude: new Float64Array([0, -3, -10]),
      phase: new Float64Array([0, -45, -90]), // Never reaches -180
    };

    const step: SyntheticStepResponse = { timeMs: [0], response: [1] };
    const metrics = extractMetrics(bode, step, 4000);
    expect(metrics.gainMarginDb).toBe(60); // Capped at 60
  });

  it('should return default phase margin when gain never crosses 0 dB', () => {
    const bode: BodeResult = {
      frequencies: new Float64Array([0, 100]),
      magnitude: new Float64Array([-5, -15]), // Always below 0 dB
      phase: new Float64Array([0, -90]),
    };

    const step: SyntheticStepResponse = { timeMs: [0], response: [1] };
    const metrics = extractMetrics(bode, step, 4000);
    expect(metrics.phaseMarginDeg).toBe(90); // Default
  });

  it('should extract dcGainDb from the 1-5 Hz band (falls back past coarse bins)', () => {
    // No bins fall in 1-5 Hz (0, 50, 100) → fall back to the first bin above DC,
    // NOT the unreliable bin 0.
    const bode: BodeResult = {
      frequencies: new Float64Array([0, 50, 100]),
      magnitude: new Float64Array([-2.5, -1.0, -5.0]),
      phase: new Float64Array([0, -45, -90]),
    };

    const step: SyntheticStepResponse = { timeMs: [0], response: [1] };
    const metrics = extractMetrics(bode, step, 4000);
    expect(metrics.dcGainDb).toBe(-1.0);
  });

  it('should return dcGainDb 0 for empty Bode magnitude', () => {
    const bode: BodeResult = {
      frequencies: new Float64Array([]),
      magnitude: new Float64Array([]),
      phase: new Float64Array([]),
    };

    const step: SyntheticStepResponse = { timeMs: [0], response: [1] };
    const metrics = extractMetrics(bode, step, 4000);
    expect(metrics.dcGainDb).toBe(0);
  });
});

describe('computeDcGainDb', () => {
  it('averages magnitude over the 1-5 Hz band, excluding bin 0', () => {
    // Bins at 0,1,2,3,4,5,10 Hz — band = indices 1..5, bin 0 (value 10) excluded
    const bode: BodeResult = {
      frequencies: new Float64Array([0, 1, 2, 3, 4, 5, 10]),
      magnitude: new Float64Array([10, -1, -2, -3, -2, -2, -20]),
      phase: new Float64Array(7),
    };
    // mean(-1, -2, -3, -2, -2) = -2.0
    expect(computeDcGainDb(bode)).toBeCloseTo(-2.0, 10);
  });

  it('ignores bins above 5 Hz', () => {
    const bode: BodeResult = {
      frequencies: new Float64Array([0, 2, 4, 6, 8]),
      magnitude: new Float64Array([5, -1, -3, -30, -40]),
      phase: new Float64Array(5),
    };
    // Only 2 and 4 Hz are in band: mean(-1, -3) = -2
    expect(computeDcGainDb(bode)).toBeCloseTo(-2.0, 10);
  });

  it('falls back to magnitude[1] when no bins are in the 1-5 Hz band', () => {
    const bode: BodeResult = {
      frequencies: new Float64Array([0, 20, 40]),
      magnitude: new Float64Array([-9.0, -0.5, -6.0]),
      phase: new Float64Array(3),
    };
    expect(computeDcGainDb(bode)).toBe(-0.5);
  });

  it('falls back to magnitude[0] when only one bin exists', () => {
    const bode: BodeResult = {
      frequencies: new Float64Array([0]),
      magnitude: new Float64Array([-3.5]),
      phase: new Float64Array(1),
    };
    expect(computeDcGainDb(bode)).toBe(-3.5);
  });

  it('returns 0 for empty magnitude', () => {
    const bode: BodeResult = {
      frequencies: new Float64Array([]),
      magnitude: new Float64Array([]),
      phase: new Float64Array([]),
    };
    expect(computeDcGainDb(bode)).toBe(0);
  });
});

describe('estimateAllAxes', () => {
  it('should return results for all 3 axes', () => {
    const sampleRate = 4000;
    const N = 16384;

    const setpoint = {
      roll: generateSine(30, sampleRate, N, 200),
      pitch: generateSine(40, sampleRate, N, 150),
      yaw: generateSine(20, sampleRate, N, 100),
    };

    const gyro = {
      roll: generateSecondOrderResponse(setpoint.roll, sampleRate, 80, 0.7, 5),
      pitch: generateSecondOrderResponse(setpoint.pitch, sampleRate, 80, 0.7, 5),
      yaw: generateSecondOrderResponse(setpoint.yaw, sampleRate, 60, 0.6, 8),
    };

    const result = estimateAllAxes(setpoint, gyro, sampleRate);

    // All axes should have Bode data
    expect(result.roll.frequencies.length).toBeGreaterThan(0);
    expect(result.pitch.frequencies.length).toBeGreaterThan(0);
    expect(result.yaw.frequencies.length).toBeGreaterThan(0);

    // All axes should have step responses
    expect(result.syntheticStepResponse.roll.timeMs.length).toBeGreaterThan(0);
    expect(result.syntheticStepResponse.pitch.timeMs.length).toBeGreaterThan(0);
    expect(result.syntheticStepResponse.yaw.timeMs.length).toBeGreaterThan(0);

    // All axes should have metrics
    expect(result.metrics.roll.bandwidthHz).toBeGreaterThan(0);
    expect(result.metrics.pitch.bandwidthHz).toBeGreaterThan(0);
    expect(result.metrics.yaw.bandwidthHz).toBeGreaterThan(0);

    // Analysis time should be tracked
    expect(result.analysisTimeMs).toBeGreaterThan(0);
  });

  it('should report progress for all axes', () => {
    const sampleRate = 4000;
    const N = 8192;

    const setpoint = {
      roll: generateSine(50, sampleRate, N, 100),
      pitch: generateSine(50, sampleRate, N, 100),
      yaw: generateSine(50, sampleRate, N, 100),
    };

    const gyro = {
      roll: new Float64Array(setpoint.roll),
      pitch: new Float64Array(setpoint.pitch),
      yaw: new Float64Array(setpoint.yaw),
    };

    const percents: number[] = [];
    estimateAllAxes(setpoint, gyro, sampleRate, (p) => {
      percents.push(p.percent);
    });

    // Should end at 100
    expect(percents[percents.length - 1]).toBe(100);
    // Should have intermediate progress
    expect(percents.length).toBeGreaterThan(3);
  });

  it('should trim Bode to 500 Hz max', () => {
    const sampleRate = 4000;
    const N = 16384;

    const setpoint = {
      roll: generateSine(50, sampleRate, N, 200),
      pitch: generateSine(50, sampleRate, N, 200),
      yaw: generateSine(50, sampleRate, N, 200),
    };

    const gyro = {
      roll: new Float64Array(setpoint.roll),
      pitch: new Float64Array(setpoint.pitch),
      yaw: new Float64Array(setpoint.yaw),
    };

    const result = estimateAllAxes(setpoint, gyro, sampleRate);

    // Max frequency should be <= 500 Hz
    const maxFreq = result.roll.frequencies[result.roll.frequencies.length - 1];
    expect(maxFreq).toBeLessThanOrEqual(500);
  });
});

// ---- Helper ----

function findClosestBin(frequencies: Float64Array, targetHz: number): number {
  let closestIdx = 0;
  let closestDist = Infinity;
  for (let i = 0; i < frequencies.length; i++) {
    const dist = Math.abs(frequencies[i] - targetHz);
    if (dist < closestDist) {
      closestDist = dist;
      closestIdx = i;
    }
  }
  return closestIdx;
}

describe('coherence', () => {
  const sampleRate = 4000;

  it('reports high coherence for a clean LTI system', () => {
    const setpoint = generateMixedStickInputs(sampleRate, 10);
    const gyro = generateSecondOrderResponse(setpoint, sampleRate, 20, 0.7, 5);

    const { bode } = estimateTransferFunction(setpoint, gyro, sampleRate);
    expect(bode.coherence).toBeDefined();
    const mean = computeCoherenceMean(bode);
    expect(mean).toBeDefined();
    expect(mean!).toBeGreaterThan(0.8);
  });

  it('reports low coherence when gyro is unrelated to setpoint', () => {
    const setpoint = generateMixedStickInputs(sampleRate, 10);
    // Gyro = deterministic multi-tone unrelated to the stick input
    const gyro = new Float64Array(setpoint.length);
    for (let i = 0; i < gyro.length; i++) {
      const t = i / sampleRate;
      gyro[i] =
        40 * Math.sin(2 * Math.PI * 3.1 * t + 1.0) +
        30 * Math.sin(2 * Math.PI * 7.7 * t + 2.0) +
        20 * Math.sin(2 * Math.PI * 13.3 * t);
    }

    const { bode } = estimateTransferFunction(setpoint, gyro, sampleRate);
    const mean = computeCoherenceMean(bode);
    expect(mean).toBeDefined();
    expect(mean!).toBeLessThan(0.5);
  });

  it('omits coherence when only one Welch window fits', () => {
    // 8192 samples = exactly one TF window → coherence would be trivially 1
    const setpoint = generateMixedStickInputs(sampleRate, 2.048);
    const gyro = generateSecondOrderResponse(setpoint, sampleRate, 20, 0.7, 5);

    const { bode } = estimateTransferFunction(setpoint, gyro, sampleRate);
    expect(bode.coherence).toBeUndefined();
    expect(computeCoherenceMean(bode)).toBeUndefined();
  });

  it('estimateAllAxes carries coherenceMean into metrics', () => {
    const setpoint = generateMixedStickInputs(sampleRate, 10);
    const gyro = generateSecondOrderResponse(setpoint, sampleRate, 20, 0.7, 5);
    const axes = { roll: setpoint, pitch: setpoint, yaw: setpoint };
    const gyros = { roll: gyro, pitch: gyro, yaw: gyro };

    const result = estimateAllAxes(axes, gyros, sampleRate);
    expect(result.metrics.roll.coherenceMean).toBeDefined();
    expect(result.metrics.roll.coherenceMean!).toBeGreaterThan(0.8);
  });
});
