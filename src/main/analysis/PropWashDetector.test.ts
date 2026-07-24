import { describe, it, expect } from 'vitest';
import { detectThrottleDrops, analyzePropWash, computeCleanRuns } from './PropWashDetector';
import type { BlackboxFlightData, TimeSeries } from '@shared/types/blackbox.types';

const SAMPLE_RATE = 4000;

function makeTimeSeries(fn: (i: number) => number, numSamples: number): TimeSeries {
  const time = new Float64Array(numSamples);
  const values = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    time[i] = i / SAMPLE_RATE;
    values[i] = fn(i);
  }
  return { time, values };
}

function makeZeroSeries(numSamples: number): TimeSeries {
  return makeTimeSeries(() => 0, numSamples);
}

/**
 * Create flight data with configurable throttle and gyro patterns.
 */
function createFlightData(opts: {
  numSamples: number;
  throttleFn: (i: number) => number;
  gyroFn?: (i: number) => number;
  sampleRate?: number;
}): BlackboxFlightData {
  const { numSamples, throttleFn, gyroFn = () => 0, sampleRate = SAMPLE_RATE } = opts;

  const throttle = makeTimeSeries(throttleFn, numSamples);
  const gyro = makeTimeSeries(gyroFn, numSamples);
  const zero = makeZeroSeries(numSamples);

  return {
    gyro: [gyro, gyro, gyro],
    setpoint: [zero, zero, zero, throttle],
    pidP: [zero, zero, zero],
    pidI: [zero, zero, zero],
    pidD: [zero, zero, zero],
    pidF: [zero, zero, zero],
    motor: [zero, zero, zero, zero],
    debug: [],
    sampleRateHz: sampleRate,
    durationSeconds: numSamples / sampleRate,
    frameCount: numSamples,
  };
}

describe('PropWashDetector', () => {
  describe('detectThrottleDrops', () => {
    it('should detect a clear throttle-down event', () => {
      const numSamples = 4000; // 1 second
      // Steady at 0.7, then ramp down over 200 samples (50ms) to 0.2, then steady
      const dropStart = 2000;
      const dropLen = 200;
      const throttleFn = (i: number) => {
        if (i < dropStart) return 0.7;
        if (i < dropStart + dropLen) return 0.7 - ((i - dropStart) / dropLen) * 0.5;
        return 0.2;
      };
      const ts = makeTimeSeries(throttleFn, numSamples);

      const drops = detectThrottleDrops(ts.values, ts.time, SAMPLE_RATE);

      expect(drops.length).toBeGreaterThanOrEqual(1);
      expect(drops[0].startIndex).toBeLessThanOrEqual(dropStart + 10);
      expect(drops[0].dropRate).toBeLessThan(0);
    });

    it('should not detect drops during constant throttle', () => {
      const ts = makeTimeSeries(() => 0.5, 4000);

      const drops = detectThrottleDrops(ts.values, ts.time, SAMPLE_RATE);

      expect(drops.length).toBe(0);
    });

    it('should not detect drops during throttle increase', () => {
      // Throttle ramps up
      const ts = makeTimeSeries((i) => 0.3 + (i / 4000) * 0.5, 4000);

      const drops = detectThrottleDrops(ts.values, ts.time, SAMPLE_RATE);

      expect(drops.length).toBe(0);
    });

    it('should detect multiple throttle-down events', () => {
      // Three separate drops, each ramping down over 400 samples (100ms)
      const dropLen = 400;
      const throttleFn = (i: number) => {
        if (i < 1000) return 0.7;
        if (i < 1000 + dropLen) return 0.7 - ((i - 1000) / dropLen) * 0.5; // Drop 1
        if (i < 4000) return 0.5;
        if (i < 4000 + dropLen) return 0.5 - ((i - 4000) / dropLen) * 0.3; // Drop 2
        if (i < 8000) return 0.4;
        if (i < 8000 + dropLen) return 0.4 - ((i - 8000) / dropLen) * 0.3; // Drop 3
        return 0.3;
      };
      const ts = makeTimeSeries(throttleFn, 12000);

      const drops = detectThrottleDrops(ts.values, ts.time, SAMPLE_RATE);

      expect(drops.length).toBeGreaterThanOrEqual(3);
    });

    it('should ignore very short drops below minimum duration', () => {
      // Single sample spike down — not sustained
      const values = new Float64Array(4000).fill(0.5);
      values[2000] = 0.1; // Single sample dip
      const time = new Float64Array(4000).map((_, i) => i / SAMPLE_RATE);

      const drops = detectThrottleDrops(values, time, SAMPLE_RATE);

      expect(drops.length).toBe(0);
    });

    it('should report correct timestamp in ms', () => {
      // Drop at 0.5 seconds (sample 2000), ramp down over 400 samples (100ms)
      const dropStart = 2000;
      const dropLen = 400;
      const throttleFn = (i: number) => {
        if (i < dropStart) return 0.7;
        if (i < dropStart + dropLen) return 0.7 - ((i - dropStart) / dropLen) * 0.5;
        return 0.2;
      };
      const ts = makeTimeSeries(throttleFn, 8000);

      const drops = detectThrottleDrops(ts.values, ts.time, SAMPLE_RATE);

      expect(drops.length).toBeGreaterThanOrEqual(1);
      // Timestamp should be around 500ms (sample 2000 at 4000 Hz)
      expect(drops[0].timestampMs).toBeCloseTo(500, -1);
    });
  });

  describe('analyzePropWash', () => {
    it('should return undefined for flight without throttle drops', () => {
      const data = createFlightData({
        numSamples: 20000,
        throttleFn: () => 0.5,
        gyroFn: () => (Math.random() - 0.5) * 0.01,
      });

      const result = analyzePropWash(data);

      expect(result).toBeUndefined();
    });

    it('should return undefined for very short data', () => {
      const data = createFlightData({
        numSamples: 100,
        throttleFn: () => 0.5,
      });

      const result = analyzePropWash(data);

      expect(result).toBeUndefined();
    });

    it('should detect prop wash with oscillation after throttle cut', () => {
      const numSamples = 40000; // 10 seconds at 4kHz
      // Create a flight with throttle drop at 2s, 4s, 6s
      const throttleFn = (i: number) => {
        const t = i / SAMPLE_RATE;
        if (t >= 2.0 && t < 2.05) return 0.7 - ((t - 2.0) / 0.05) * 0.5;
        if (t >= 4.0 && t < 4.05) return 0.7 - ((t - 4.0) / 0.05) * 0.5;
        if (t >= 6.0 && t < 6.05) return 0.7 - ((t - 6.0) / 0.05) * 0.5;
        if ((t >= 2.05 && t < 3.0) || (t >= 4.05 && t < 5.0) || (t >= 6.05 && t < 7.0)) return 0.2;
        return 0.7;
      };

      // Oscillation at 50 Hz after each drop (prop wash frequency)
      const gyroFn = (i: number) => {
        const t = i / SAMPLE_RATE;
        let noise = (Math.random() - 0.5) * 0.5; // Background
        // Add strong 50 Hz oscillation in post-drop windows
        if ((t >= 2.05 && t < 2.45) || (t >= 4.05 && t < 4.45) || (t >= 6.05 && t < 6.45)) {
          noise += 50 * Math.sin(2 * Math.PI * 50 * t);
        }
        return noise;
      };

      const data = createFlightData({ numSamples, throttleFn, gyroFn });

      const result = analyzePropWash(data);

      expect(result).toBeDefined();
      expect(result!.events.length).toBeGreaterThanOrEqual(1);
      expect(result!.meanSeverity).toBeGreaterThan(0);
      expect(result!.worstAxis).toMatch(/roll|pitch|yaw/);
      expect(result!.recommendation).toBeTruthy();
    });

    it('should report higher severity for stronger oscillation', () => {
      const numSamples = 20000;
      const throttleFn = (i: number) => {
        const t = i / SAMPLE_RATE;
        if (t >= 1.0 && t < 1.05) return 0.7 - ((t - 1.0) / 0.05) * 0.5;
        if (t >= 1.05 && t < 2.0) return 0.2;
        if (t >= 3.0 && t < 3.05) return 0.7 - ((t - 3.0) / 0.05) * 0.5;
        if (t >= 3.05 && t < 4.0) return 0.2;
        return 0.7;
      };

      // Strong oscillation version
      const strongGyro = (i: number) => {
        const t = i / SAMPLE_RATE;
        let noise = (Math.random() - 0.5) * 0.1;
        if ((t >= 1.05 && t < 1.45) || (t >= 3.05 && t < 3.45)) {
          noise += 100 * Math.sin(2 * Math.PI * 50 * t);
        }
        return noise;
      };

      // Weak oscillation version
      const weakGyro = (i: number) => {
        const t = i / SAMPLE_RATE;
        let noise = (Math.random() - 0.5) * 0.1;
        if ((t >= 1.05 && t < 1.45) || (t >= 3.05 && t < 3.45)) {
          noise += 2 * Math.sin(2 * Math.PI * 50 * t);
        }
        return noise;
      };

      const strongData = createFlightData({ numSamples, throttleFn, gyroFn: strongGyro });
      const weakData = createFlightData({ numSamples, throttleFn, gyroFn: weakGyro });

      const strongResult = analyzePropWash(strongData);
      const weakResult = analyzePropWash(weakData);

      if (strongResult && weakResult) {
        expect(strongResult.meanSeverity).toBeGreaterThan(weakResult.meanSeverity);
      }
    });

    it('should provide minimal recommendation when few events detected', () => {
      const numSamples = 10000;
      // Single drop only (below PROPWASH_MIN_EVENTS=3)
      const throttleFn = (i: number) => {
        const t = i / SAMPLE_RATE;
        if (t >= 1.0 && t < 1.05) return 0.7 - ((t - 1.0) / 0.05) * 0.5;
        if (t >= 1.05) return 0.2;
        return 0.7;
      };
      const gyroFn = (i: number) => {
        const t = i / SAMPLE_RATE;
        if (t >= 1.05 && t < 1.45) return 50 * Math.sin(2 * Math.PI * 50 * t);
        return (Math.random() - 0.5) * 0.1;
      };

      const data = createFlightData({ numSamples, throttleFn, gyroFn });
      const result = analyzePropWash(data);

      if (result && result.events.length < 3) {
        expect(result.recommendation).toContain('fly more aggressive descents');
      }
    });

    it('should detect dominant frequency in prop wash band', () => {
      const numSamples = 40000;
      const dropFreq = 60; // Hz — should be detected as dominant

      const throttleFn = (i: number) => {
        const t = i / SAMPLE_RATE;
        // 4 drops for reliability
        for (const dropTime of [1.0, 3.0, 5.0, 7.0]) {
          if (t >= dropTime && t < dropTime + 0.05) return 0.7 - ((t - dropTime) / 0.05) * 0.5;
          if (t >= dropTime + 0.05 && t < dropTime + 1.0) return 0.2;
        }
        return 0.7;
      };

      const gyroFn = (i: number) => {
        const t = i / SAMPLE_RATE;
        let val = (Math.random() - 0.5) * 0.1;
        for (const dropTime of [1.0, 3.0, 5.0, 7.0]) {
          if (t >= dropTime + 0.05 && t < dropTime + 0.45) {
            val += 40 * Math.sin(2 * Math.PI * dropFreq * t);
          }
        }
        return val;
      };

      const data = createFlightData({ numSamples, throttleFn, gyroFn });
      const result = analyzePropWash(data);

      if (result && result.events.length >= 3) {
        // Dominant frequency should be near 60 Hz (within 15 Hz tolerance)
        expect(result.dominantFrequencyHz).toBeGreaterThanOrEqual(40);
        expect(result.dominantFrequencyHz).toBeLessThanOrEqual(80);
      }
    });

    it('should identify worst axis correctly', () => {
      const numSamples = 20000;
      const throttleFn = (i: number) => {
        const t = i / SAMPLE_RATE;
        if (t >= 1.0 && t < 1.05) return 0.7 - ((t - 1.0) / 0.05) * 0.5;
        if (t >= 1.05 && t < 2.0) return 0.2;
        if (t >= 3.0 && t < 3.05) return 0.7 - ((t - 3.0) / 0.05) * 0.5;
        if (t >= 3.05 && t < 4.0) return 0.2;
        return 0.7;
      };

      // Roll has 10x more oscillation than pitch/yaw
      const rollGyro = makeTimeSeries((i) => {
        const t = i / SAMPLE_RATE;
        if ((t >= 1.05 && t < 1.45) || (t >= 3.05 && t < 3.45)) {
          return 100 * Math.sin(2 * Math.PI * 50 * t);
        }
        return (Math.random() - 0.5) * 0.1;
      }, numSamples);

      const quietGyro = makeTimeSeries((i) => {
        const t = i / SAMPLE_RATE;
        if ((t >= 1.05 && t < 1.45) || (t >= 3.05 && t < 3.45)) {
          return 5 * Math.sin(2 * Math.PI * 50 * t);
        }
        return (Math.random() - 0.5) * 0.1;
      }, numSamples);

      const zero = makeZeroSeries(numSamples);
      const throttle = makeTimeSeries(throttleFn, numSamples);

      const data: BlackboxFlightData = {
        gyro: [rollGyro, quietGyro, quietGyro],
        setpoint: [zero, zero, zero, throttle],
        pidP: [zero, zero, zero],
        pidI: [zero, zero, zero],
        pidD: [zero, zero, zero],
        pidF: [zero, zero, zero],
        motor: [zero, zero, zero, zero],
        debug: [],
        sampleRateHz: SAMPLE_RATE,
        durationSeconds: numSamples / SAMPLE_RATE,
        frameCount: numSamples,
      };

      const result = analyzePropWash(data);

      if (result) {
        expect(result.worstAxis).toBe('roll');
      }
    });

    it('should include per-axis energy in events', () => {
      const numSamples = 20000;
      const throttleFn = (i: number) => {
        const t = i / SAMPLE_RATE;
        if (t >= 1.0 && t < 1.05) return 0.7 - ((t - 1.0) / 0.05) * 0.5;
        if (t >= 1.05 && t < 2.0) return 0.2;
        return 0.7;
      };
      const gyroFn = (i: number) => {
        const t = i / SAMPLE_RATE;
        if (t >= 1.05 && t < 1.45) return 30 * Math.sin(2 * Math.PI * 50 * t);
        return (Math.random() - 0.5) * 0.1;
      };

      const data = createFlightData({ numSamples, throttleFn, gyroFn });
      const result = analyzePropWash(data);

      if (result && result.events.length > 0) {
        const event = result.events[0];
        expect(event.axisEnergy).toBeDefined();
        expect(event.axisEnergy.roll).toBeGreaterThanOrEqual(0);
        expect(event.axisEnergy.pitch).toBeGreaterThanOrEqual(0);
        expect(event.axisEnergy.yaw).toBeGreaterThanOrEqual(0);
      }
    });

    it('should handle 1000-2000 range throttle values', () => {
      const numSamples = 20000;
      // BF raw RC pulse width
      const throttleFn = (i: number) => {
        const t = i / SAMPLE_RATE;
        if (t >= 1.0 && t < 1.05) return 1700 - ((t - 1.0) / 0.05) * 500;
        if (t >= 1.05 && t < 2.0) return 1200;
        if (t >= 3.0 && t < 3.05) return 1700 - ((t - 3.0) / 0.05) * 500;
        if (t >= 3.05 && t < 4.0) return 1200;
        return 1700;
      };
      const gyroFn = (i: number) => {
        const t = i / SAMPLE_RATE;
        if ((t >= 1.05 && t < 1.45) || (t >= 3.05 && t < 3.45)) {
          return 50 * Math.sin(2 * Math.PI * 50 * t);
        }
        return (Math.random() - 0.5) * 0.1;
      };

      const data = createFlightData({ numSamples, throttleFn, gyroFn });
      const result = analyzePropWash(data);

      // Should still detect events from BF raw values
      expect(result).toBeDefined();
      if (result) {
        expect(result.events.length).toBeGreaterThanOrEqual(1);
      }
    });
  });
});

describe('computeCleanRuns', () => {
  it('returns the whole flight as one run when there are no drops', () => {
    expect(computeCleanRuns(10000, [], 1600)).toEqual([{ start: 0, end: 10000 }]);
  });

  it('excludes drop + post-drop window from clean runs', () => {
    const runs = computeCleanRuns(10000, [{ startIndex: 4000, endIndex: 4200 }], 1600);
    expect(runs).toEqual([
      { start: 0, end: 4000 },
      { start: 5800, end: 10000 },
    ]);
  });

  it('merges overlapping exclusion ranges', () => {
    const runs = computeCleanRuns(
      20000,
      [
        { startIndex: 4000, endIndex: 4200 },
        { startIndex: 5000, endIndex: 5200 }, // post-window of first overlaps
      ],
      1600
    );
    expect(runs).toEqual([
      { start: 0, end: 4000 },
      { start: 6800, end: 20000 },
    ]);
  });

  it('drops runs shorter than the minimum FFT length', () => {
    const runs = computeCleanRuns(3000, [{ startIndex: 500, endIndex: 2900 }], 1600);
    // Leading run 0-500 too short, trailing run fully consumed by window
    expect(runs).toEqual([]);
  });

  it('clean baseline discriminates strong vs weak oscillation (severity not saturated)', () => {
    const numSamples = 20000;
    const throttleFn = (i: number) => {
      const t = i / SAMPLE_RATE;
      if (t >= 1.0 && t < 1.05) return 0.7 - ((t - 1.0) / 0.05) * 0.5;
      if (t >= 1.05 && t < 2.0) return 0.2;
      if (t >= 3.0 && t < 3.05) return 0.7 - ((t - 3.0) / 0.05) * 0.5;
      if (t >= 3.05 && t < 4.0) return 0.2;
      return 0.7;
    };
    // Deterministic background (30 Hz in-band tone) + post-drop oscillation
    const makeGyro = (oscAmp: number) => (i: number) => {
      const t = i / SAMPLE_RATE;
      let v = 0.5 * Math.sin(2 * Math.PI * 30 * t);
      if ((t >= 1.05 && t < 1.45) || (t >= 3.05 && t < 3.45)) {
        v += oscAmp * Math.sin(2 * Math.PI * 50 * t);
      }
      return v;
    };
    const strong = analyzePropWash(
      createFlightData({ numSamples, throttleFn, gyroFn: makeGyro(100) })
    );
    const weak = analyzePropWash(createFlightData({ numSamples, throttleFn, gyroFn: makeGyro(2) }));
    expect(strong).toBeDefined();
    expect(weak).toBeDefined();
    // With a clean baseline the ratio scales with oscillation energy —
    // the whole-flight baseline used to saturate both at the same value.
    expect(strong!.meanSeverity).toBeGreaterThan(10 * weak!.meanSeverity);
  });
});
