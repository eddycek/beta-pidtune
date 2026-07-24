import { describe, it, expect } from 'vitest';
import {
  binByThrottle,
  computeThrottleSpectrogram,
  DEFAULT_NUM_BANDS,
  MIN_SAMPLES_PER_BAND,
  findContiguousRuns,
} from './ThrottleSpectrogramAnalyzer';
import type { BlackboxFlightData, TimeSeries } from '@shared/types/blackbox.types';

const SAMPLE_RATE = 4000;

/**
 * Create a TimeSeries with constant value.
 */
function makeConstSeries(value: number, numSamples: number): TimeSeries {
  const time = new Float64Array(numSamples);
  const values = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    time[i] = i / SAMPLE_RATE;
    values[i] = value;
  }
  return { time, values };
}

/**
 * Create a TimeSeries with a sine wave at a given frequency.
 */
function makeSineSeries(
  frequency: number,
  amplitude: number,
  numSamples: number,
  sampleRate: number = SAMPLE_RATE
): TimeSeries {
  const time = new Float64Array(numSamples);
  const values = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    time[i] = i / sampleRate;
    values[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return { time, values };
}

/**
 * Create a zero TimeSeries.
 */
function makeZeroSeries(numSamples: number): TimeSeries {
  return {
    time: new Float64Array(numSamples).map((_, i) => i / SAMPLE_RATE),
    values: new Float64Array(numSamples),
  };
}

/**
 * Create flight data with throttle ramping linearly from 0 to 1 and controllable gyro noise.
 */
function createRampFlightData(opts: {
  numSamples: number;
  sampleRate?: number;
  gyroFreqHz?: number;
  gyroAmplitude?: number;
}): BlackboxFlightData {
  const { numSamples, sampleRate = SAMPLE_RATE, gyroFreqHz = 0, gyroAmplitude = 0 } = opts;

  const throttle: TimeSeries = {
    time: new Float64Array(numSamples).map((_, i) => i / sampleRate),
    values: new Float64Array(numSamples).map((_, i) => i / numSamples), // linear 0→1
  };

  const gyroFn = (i: number) =>
    gyroAmplitude > 0
      ? gyroAmplitude * Math.sin((2 * Math.PI * gyroFreqHz * i) / sampleRate)
      : (Math.random() - 0.5) * 0.01;

  function makeGyro(): TimeSeries {
    const time = new Float64Array(numSamples);
    const values = new Float64Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      time[i] = i / sampleRate;
      values[i] = gyroFn(i);
    }
    return { time, values };
  }

  const zero = makeZeroSeries(numSamples);

  return {
    gyro: [makeGyro(), makeGyro(), makeGyro()],
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

describe('ThrottleSpectrogramAnalyzer', () => {
  describe('binByThrottle', () => {
    it('should distribute uniform throttle evenly across bands', () => {
      // 10000 samples with throttle ramping 0→1
      const numSamples = 10000;
      const values = new Float64Array(numSamples).map((_, i) => i / numSamples);

      const bins = binByThrottle(values, 10);

      expect(bins.length).toBe(10);
      // Each band should get ~1000 samples (±50 for rounding)
      for (const bin of bins) {
        expect(bin.length).toBeGreaterThan(900);
        expect(bin.length).toBeLessThan(1100);
      }
    });

    it('should place all samples in one band for constant throttle', () => {
      const values = new Float64Array(5000).fill(0.35);

      const bins = binByThrottle(values, 10);

      // 0.35 → band 3 (floor(0.35 * 10) = 3)
      expect(bins[3].length).toBe(5000);
      // All other bands should be empty
      for (let i = 0; i < 10; i++) {
        if (i !== 3) expect(bins[i].length).toBe(0);
      }
    });

    it('should handle 1000-2000 range throttle values', () => {
      // Betaflight raw RC pulse width: 1500 → normalized 0.5 → band 5 (of 10)
      const values = new Float64Array(1000).fill(1500);

      const bins = binByThrottle(values, 10);

      expect(bins[5].length).toBe(1000);
    });

    it('should clamp throttle=1.0 into the last band', () => {
      const values = new Float64Array(100).fill(1.0);

      const bins = binByThrottle(values, 10);

      // floor(1.0 * 10) = 10 → clamped to 9
      expect(bins[9].length).toBe(100);
    });

    it('should handle zero throttle', () => {
      const values = new Float64Array(100).fill(0);

      const bins = binByThrottle(values, 10);

      expect(bins[0].length).toBe(100);
    });

    it('should support custom number of bands', () => {
      const values = new Float64Array(2000).map((_, i) => i / 2000);

      const bins = binByThrottle(values, 5);

      expect(bins.length).toBe(5);
      // Each band should get ~400 samples
      for (const bin of bins) {
        expect(bin.length).toBeGreaterThan(350);
        expect(bin.length).toBeLessThan(450);
      }
    });
  });

  describe('computeThrottleSpectrogram', () => {
    it('should return correct number of bands', () => {
      const data = createRampFlightData({ numSamples: 20000 });

      const result = computeThrottleSpectrogram(data, 10);

      expect(result.numBands).toBe(10);
      expect(result.bands.length).toBe(10);
      expect(result.minSamplesPerBand).toBe(MIN_SAMPLES_PER_BAND);
    });

    it('should produce spectra for bands with sufficient samples', () => {
      // 20000 samples ramping 0→1, 10 bands → ~2000 per band (well above MIN_SAMPLES_PER_BAND=512)
      const data = createRampFlightData({
        numSamples: 20000,
        gyroFreqHz: 150,
        gyroAmplitude: 10,
      });

      const result = computeThrottleSpectrogram(data, 10);

      expect(result.bandsWithData).toBeGreaterThan(0);
      for (const band of result.bands) {
        if (band.sampleCount >= MIN_SAMPLES_PER_BAND) {
          expect(band.spectra).toBeDefined();
          expect(band.spectra!.length).toBe(3); // roll, pitch, yaw
          expect(band.noiseFloorDb).toBeDefined();
          expect(band.noiseFloorDb!.length).toBe(3);
          // Spectra should have frequency bins
          expect(band.spectra![0].frequencies.length).toBeGreaterThan(0);
          expect(band.spectra![0].magnitudes.length).toBeGreaterThan(0);
        }
      }
    });

    it('should skip bands with too few samples', () => {
      // 1000 samples total, 10 bands → ~100 per band < 512 minimum
      const data = createRampFlightData({ numSamples: 1000 });

      const result = computeThrottleSpectrogram(data, 10);

      expect(result.bandsWithData).toBe(0);
      for (const band of result.bands) {
        expect(band.spectra).toBeUndefined();
        expect(band.noiseFloorDb).toBeUndefined();
      }
    });

    it('should detect noise frequency in spectra', () => {
      // Strong 200 Hz noise, 20000 samples → each band has ~2000 samples
      const data = createRampFlightData({
        numSamples: 20000,
        gyroFreqHz: 200,
        gyroAmplitude: 50,
      });

      const result = computeThrottleSpectrogram(data, 10);

      // Check a band with data — the 200 Hz peak should be visible
      const bandWithData = result.bands.find((b) => b.spectra);
      expect(bandWithData).toBeDefined();

      const spectrum = bandWithData!.spectra![0]; // roll axis
      // Find bin closest to 200 Hz
      let peakBin = 0;
      let peakMag = -Infinity;
      for (let i = 0; i < spectrum.frequencies.length; i++) {
        if (spectrum.magnitudes[i] > peakMag) {
          peakMag = spectrum.magnitudes[i];
          peakBin = i;
        }
      }
      const peakFreq = spectrum.frequencies[peakBin];
      expect(Math.abs(peakFreq - 200)).toBeLessThan(30);
    });

    it('should handle empty throttle data', () => {
      const zero = makeZeroSeries(0);
      const emptyThrottle: TimeSeries = {
        time: new Float64Array(0),
        values: new Float64Array(0),
      };

      const data: BlackboxFlightData = {
        gyro: [zero, zero, zero],
        setpoint: [zero, zero, zero, emptyThrottle],
        pidP: [zero, zero, zero],
        pidI: [zero, zero, zero],
        pidD: [zero, zero, zero],
        pidF: [zero, zero, zero],
        motor: [zero, zero, zero, zero],
        debug: [],
        sampleRateHz: SAMPLE_RATE,
        durationSeconds: 0,
        frameCount: 0,
      };

      const result = computeThrottleSpectrogram(data);

      expect(result.bands.length).toBe(0);
      expect(result.bandsWithData).toBe(0);
    });

    it('should use DEFAULT_NUM_BANDS when not specified', () => {
      const data = createRampFlightData({ numSamples: 20000 });

      const result = computeThrottleSpectrogram(data);

      expect(result.numBands).toBe(DEFAULT_NUM_BANDS);
      expect(result.bands.length).toBe(DEFAULT_NUM_BANDS);
    });

    it('should set correct throttleMin and throttleMax per band', () => {
      const data = createRampFlightData({ numSamples: 20000 });

      const result = computeThrottleSpectrogram(data, 5);

      expect(result.bands[0].throttleMin).toBe(0);
      expect(result.bands[0].throttleMax).toBe(0.2);
      expect(result.bands[1].throttleMin).toBe(0.2);
      expect(result.bands[1].throttleMax).toBe(0.4);
      expect(result.bands[4].throttleMin).toBe(0.8);
      expect(result.bands[4].throttleMax).toBe(1);
    });

    it('should report accurate sampleCount per band', () => {
      // Constant 50% throttle → all samples in one band
      const numSamples = 5000;
      const zero = makeZeroSeries(numSamples);
      const throttle = makeConstSeries(0.55, numSamples);
      const gyro = makeSineSeries(100, 1, numSamples);

      const data: BlackboxFlightData = {
        gyro: [gyro, gyro, gyro],
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

      const result = computeThrottleSpectrogram(data, 10);

      // 0.55 → band 5 (floor(0.55*10)=5)
      expect(result.bands[5].sampleCount).toBe(numSamples);
      // Only band 5 should have data (5000 >= 512)
      expect(result.bandsWithData).toBe(1);
    });

    it('should produce per-axis noise floor values', () => {
      const data = createRampFlightData({
        numSamples: 20000,
        gyroFreqHz: 100,
        gyroAmplitude: 20,
      });

      const result = computeThrottleSpectrogram(data, 10);

      const bandWithData = result.bands.find((b) => b.noiseFloorDb);
      expect(bandWithData).toBeDefined();
      // Noise floor should be a finite number for each axis
      for (let axis = 0; axis < 3; axis++) {
        expect(Number.isFinite(bandWithData!.noiseFloorDb![axis])).toBe(true);
      }
    });

    it('should handle large number of bands gracefully', () => {
      // 20000 samples, 50 bands → ~400 per band (below MIN_SAMPLES_PER_BAND for some)
      const data = createRampFlightData({ numSamples: 20000 });

      const result = computeThrottleSpectrogram(data, 50);

      expect(result.numBands).toBe(50);
      expect(result.bands.length).toBe(50);
      // Some bands should have data, some not
      expect(result.bandsWithData).toBeLessThanOrEqual(50);
    });

    it('should not include spectra for bands below MIN_SAMPLES_PER_BAND threshold', () => {
      // Create data where most throttle is at 50%, so extreme bands are empty
      const numSamples = 5000;
      const zero = makeZeroSeries(numSamples);
      // Throttle centered at 0.5 with very small variance
      const throttle: TimeSeries = {
        time: new Float64Array(numSamples).map((_, i) => i / SAMPLE_RATE),
        values: new Float64Array(numSamples).fill(0.5),
      };
      const gyro = makeSineSeries(100, 1, numSamples);

      const data: BlackboxFlightData = {
        gyro: [gyro, gyro, gyro],
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

      const result = computeThrottleSpectrogram(data, 10);

      // Band 0 (0-10%) should have no samples → no spectra
      expect(result.bands[0].sampleCount).toBe(0);
      expect(result.bands[0].spectra).toBeUndefined();
      // Band 5 (50-60%) should have all samples → spectra present
      expect(result.bands[5].sampleCount).toBe(numSamples);
      expect(result.bands[5].spectra).toBeDefined();
    });
  });
});

describe('findContiguousRuns', () => {
  it('returns one run for fully contiguous indices', () => {
    const indices = Array.from({ length: 600 }, (_, i) => 100 + i);
    expect(findContiguousRuns(indices, 512)).toEqual([{ start: 100, end: 700 }]);
  });

  it('splits on gaps and drops short runs', () => {
    // Run A: 0-599 (600 long), gap, run B: 1000-1299 (300 long — too short)
    const indices = [
      ...Array.from({ length: 600 }, (_, i) => i),
      ...Array.from({ length: 300 }, (_, i) => 1000 + i),
    ];
    expect(findContiguousRuns(indices, 512)).toEqual([{ start: 0, end: 600 }]);
  });

  it('sorts runs longest first', () => {
    const indices = [
      ...Array.from({ length: 600 }, (_, i) => i),
      ...Array.from({ length: 900 }, (_, i) => 2000 + i),
    ];
    expect(findContiguousRuns(indices, 512)).toEqual([
      { start: 2000, end: 2900 },
      { start: 0, end: 600 },
    ]);
  });

  it('returns empty for empty input', () => {
    expect(findContiguousRuns([], 512)).toEqual([]);
  });
});

describe('contiguity-safe band spectra', () => {
  it('excludes a band whose samples are only short non-contiguous chunks', () => {
    // Throttle alternates every 100 samples between band 2 (~0.25) and
    // band 7 (~0.75): both bands collect >512 total samples but no
    // contiguous run reaches MIN_CONTIGUOUS_RUN.
    const numSamples = 20000;
    const time = new Float64Array(numSamples).map((_, i) => i / SAMPLE_RATE);
    const throttleValues = new Float64Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      throttleValues[i] = Math.floor(i / 100) % 2 === 0 ? 0.25 : 0.75;
    }
    const gyro = makeSineSeries(150, 30, numSamples);
    const zero = makeZeroSeries(numSamples);
    const flightData: BlackboxFlightData = {
      gyro: [gyro, gyro, gyro],
      setpoint: [zero, zero, zero, { time, values: throttleValues }],
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

    const result = computeThrottleSpectrogram(flightData);
    const band2 = result.bands[2];
    const band7 = result.bands[7];
    expect(band2.sampleCount).toBeGreaterThan(MIN_SAMPLES_PER_BAND);
    expect(band7.sampleCount).toBeGreaterThan(MIN_SAMPLES_PER_BAND);
    // Chunks are 100 samples — below MIN_CONTIGUOUS_RUN → no FFT
    expect(band2.spectra).toBeUndefined();
    expect(band7.spectra).toBeUndefined();
    expect(result.bandsWithData).toBe(0);
  });

  it('computes spectra from contiguous runs only', () => {
    // First half in band 2, second half in band 7 — both fully contiguous
    const numSamples = 20000;
    const time = new Float64Array(numSamples).map((_, i) => i / SAMPLE_RATE);
    const throttleValues = new Float64Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      throttleValues[i] = i < numSamples / 2 ? 0.25 : 0.75;
    }
    const gyro = makeSineSeries(150, 30, numSamples);
    const zero = makeZeroSeries(numSamples);
    const flightData: BlackboxFlightData = {
      gyro: [gyro, gyro, gyro],
      setpoint: [zero, zero, zero, { time, values: throttleValues }],
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

    const result = computeThrottleSpectrogram(flightData);
    expect(result.bandsWithData).toBe(2);
    const spectrum = result.bands[2].spectra![0];
    // The 150 Hz tone must be the dominant peak
    let peakIdx = 0;
    for (let i = 1; i < spectrum.magnitudes.length; i++) {
      if (spectrum.magnitudes[i] > spectrum.magnitudes[peakIdx]) peakIdx = i;
    }
    expect(Math.abs(spectrum.frequencies[peakIdx] - 150)).toBeLessThan(5);
  });
});
