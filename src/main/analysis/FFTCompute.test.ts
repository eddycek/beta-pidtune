import { describe, it, expect } from 'vitest';
import {
  applyHanningWindow,
  computeSegmentSpectrum,
  computePowerSpectrum,
  trimSpectrum,
} from './FFTCompute';

/**
 * Generate a pure sine wave signal.
 */
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
 * Generate white noise signal.
 */
function generateWhiteNoise(numSamples: number, amplitude = 1.0): Float64Array {
  const signal = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    signal[i] = (Math.random() * 2 - 1) * amplitude;
  }
  return signal;
}

describe('applyHanningWindow', () => {
  it('should zero out the endpoints', () => {
    const signal = new Float64Array([1, 1, 1, 1, 1, 1, 1, 1]);
    const windowed = applyHanningWindow(signal);
    expect(windowed[0]).toBeCloseTo(0, 5);
    expect(windowed[signal.length - 1]).toBeCloseTo(0, 5);
  });

  it('should have maximum at center', () => {
    const N = 256;
    const signal = new Float64Array(N).fill(1);
    const windowed = applyHanningWindow(signal);
    const mid = Math.floor(N / 2);
    // Center should be close to 1 (window value ~1 at center)
    expect(windowed[mid]).toBeCloseTo(1, 1);
    // Edges should be near 0
    expect(Math.abs(windowed[0])).toBeLessThan(0.01);
  });

  it('should not modify the original signal', () => {
    const signal = new Float64Array([1, 2, 3, 4]);
    applyHanningWindow(signal);
    expect(signal[0]).toBe(1);
    expect(signal[1]).toBe(2);
  });

  it('should reduce the energy of the signal', () => {
    const signal = new Float64Array(128).fill(1);
    const windowed = applyHanningWindow(signal);
    const originalEnergy = signal.reduce((sum, v) => sum + v * v, 0);
    const windowedEnergy = windowed.reduce((sum, v) => sum + v * v, 0);
    expect(windowedEnergy).toBeLessThan(originalEnergy);
  });
});

describe('computeSegmentSpectrum', () => {
  it('should throw for non-power-of-2 length', () => {
    const signal = new Float64Array(100);
    expect(() => computeSegmentSpectrum(signal, 1000)).toThrow('power of 2');
  });

  it('should throw for empty signal', () => {
    const signal = new Float64Array(0);
    expect(() => computeSegmentSpectrum(signal, 1000)).toThrow('power of 2');
  });

  it('should produce correct number of frequency bins', () => {
    const N = 256;
    const signal = new Float64Array(N);
    const { frequencies, magnitudes } = computeSegmentSpectrum(signal, 1000);
    expect(frequencies.length).toBe(N / 2 + 1);
    expect(magnitudes.length).toBe(N / 2 + 1);
  });

  it('should produce correct frequency resolution', () => {
    const N = 1024;
    const sampleRate = 8000;
    const signal = new Float64Array(N);
    const { frequencies } = computeSegmentSpectrum(signal, sampleRate);
    const expectedResolution = sampleRate / N; // 7.8125 Hz
    expect(frequencies[1] - frequencies[0]).toBeCloseTo(expectedResolution, 3);
    expect(frequencies[0]).toBe(0);
    expect(frequencies[frequencies.length - 1]).toBeCloseTo(sampleRate / 2, 1);
  });

  it('should detect a pure sine wave at the correct frequency', () => {
    const N = 4096;
    const sampleRate = 8000;
    const targetFreq = 200; // Hz
    const signal = generateSine(targetFreq, sampleRate, N);

    const { frequencies, magnitudes } = computeSegmentSpectrum(signal, sampleRate);

    // Find the peak
    let peakIdx = 0;
    let peakMag = -Infinity;
    for (let i = 1; i < magnitudes.length; i++) {
      if (magnitudes[i] > peakMag) {
        peakMag = magnitudes[i];
        peakIdx = i;
      }
    }

    // Peak should be within 1 bin of target frequency
    const freqResolution = sampleRate / N;
    expect(Math.abs(frequencies[peakIdx] - targetFreq)).toBeLessThan(freqResolution * 1.5);
  });

  it('should detect a DC signal at bin 0', () => {
    const N = 256;
    const signal = new Float64Array(N).fill(1);
    // Without window, DC should show up at bin 0
    const { magnitudes } = computeSegmentSpectrum(signal, 1000, false);
    // Bin 0 should be the dominant bin
    let peakIdx = 0;
    for (let i = 1; i < magnitudes.length; i++) {
      if (magnitudes[i] > magnitudes[peakIdx]) {
        peakIdx = i;
      }
    }
    expect(peakIdx).toBe(0);
  });

  it('should detect two sine waves at their respective frequencies', () => {
    const N = 4096;
    const sampleRate = 8000;
    const freq1 = 100;
    const freq2 = 400;
    const signal = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      signal[i] =
        Math.sin((2 * Math.PI * freq1 * i) / sampleRate) +
        Math.sin((2 * Math.PI * freq2 * i) / sampleRate);
    }

    const { frequencies, magnitudes } = computeSegmentSpectrum(signal, sampleRate);

    // Find top 2 peaks (excluding DC)
    const peaks: Array<{ idx: number; mag: number }> = [];
    for (let i = 1; i < magnitudes.length - 1; i++) {
      if (magnitudes[i] > magnitudes[i - 1] && magnitudes[i] > magnitudes[i + 1]) {
        peaks.push({ idx: i, mag: magnitudes[i] });
      }
    }
    peaks.sort((a, b) => b.mag - a.mag);

    const detectedFreqs = peaks
      .slice(0, 2)
      .map((p) => frequencies[p.idx])
      .sort((a, b) => a - b);
    const freqRes = sampleRate / N;
    expect(Math.abs(detectedFreqs[0] - freq1)).toBeLessThan(freqRes * 1.5);
    expect(Math.abs(detectedFreqs[1] - freq2)).toBeLessThan(freqRes * 1.5);
  });

  it('should produce lower leakage with windowing enabled', () => {
    const N = 256;
    const sampleRate = 1000;
    // Frequency that doesn't land exactly on a bin → causes leakage
    const freq = 123.456;
    const signal = generateSine(freq, sampleRate, N);

    const withWindow = computeSegmentSpectrum(signal, sampleRate, true);
    const withoutWindow = computeSegmentSpectrum(signal, sampleRate, false);

    // Find peak bin in each
    let peakIdxWindowed = 0;
    let peakIdxRaw = 0;
    for (let i = 1; i < withWindow.magnitudes.length; i++) {
      if (withWindow.magnitudes[i] > withWindow.magnitudes[peakIdxWindowed]) peakIdxWindowed = i;
      if (withoutWindow.magnitudes[i] > withoutWindow.magnitudes[peakIdxRaw]) peakIdxRaw = i;
    }

    // Measure spectral leakage: sum of magnitudes far from peak (linear domain)
    function leakageSum(mags: Float64Array, peakIdx: number): number {
      let sum = 0;
      for (let i = 0; i < mags.length; i++) {
        if (Math.abs(i - peakIdx) > 5) {
          sum += Math.pow(10, mags[i] / 20);
        }
      }
      return sum;
    }

    const leakageWindowed = leakageSum(withWindow.magnitudes, peakIdxWindowed);
    const leakageRaw = leakageSum(withoutWindow.magnitudes, peakIdxRaw);
    expect(leakageWindowed).toBeLessThan(leakageRaw);
  });
});

describe('computePowerSpectrum', () => {
  it('should work with signals longer than window size (Welch averaging)', () => {
    const sampleRate = 8000;
    const duration = 2; // 2 seconds
    const numSamples = sampleRate * duration;
    const signal = generateSine(150, sampleRate, numSamples);

    const spectrum = computePowerSpectrum(signal, sampleRate, 1024);
    expect(spectrum.frequencies.length).toBe(1024 / 2 + 1);

    // Peak should be near 150 Hz
    let peakIdx = 0;
    for (let i = 1; i < spectrum.magnitudes.length; i++) {
      if (spectrum.magnitudes[i] > spectrum.magnitudes[peakIdx]) peakIdx = i;
    }
    const freqRes = sampleRate / 1024;
    expect(Math.abs(spectrum.frequencies[peakIdx] - 150)).toBeLessThan(freqRes * 1.5);
  });

  it('should handle signal shorter than window size by using smaller FFT', () => {
    const signal = generateSine(100, 1000, 200);
    // 200 samples → should use 128 (next lower power of 2)
    const spectrum = computePowerSpectrum(signal, 1000, 4096);
    expect(spectrum.frequencies.length).toBe(128 / 2 + 1);
  });

  it('should throw for very short signals', () => {
    const signal = new Float64Array(4);
    expect(() => computePowerSpectrum(signal, 1000, 4096)).toThrow('too short');
  });

  it('should produce less variance than a single FFT window', () => {
    // Generate noisy sine — Welch averaging should give smoother result
    const sampleRate = 4000;
    const N = 8192;
    const signal = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      signal[i] = Math.sin((2 * Math.PI * 200 * i) / sampleRate) + (Math.random() - 0.5) * 0.5;
    }

    // Single window
    const single = computeSegmentSpectrum(signal.subarray(0, 1024), sampleRate, true);

    // Welch averaged
    const welch = computePowerSpectrum(signal, sampleRate, 1024);

    // Both should detect peak near 200 Hz, but Welch should have lower variance
    // Compute variance of non-peak bins
    function variance(mags: Float64Array, excludePeakBin: number): number {
      const values: number[] = [];
      for (let i = 1; i < mags.length; i++) {
        if (Math.abs(i - excludePeakBin) > 10) values.push(mags[i]);
      }
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    }

    // Find peak in welch
    let peakIdx = 0;
    for (let i = 1; i < welch.magnitudes.length; i++) {
      if (welch.magnitudes[i] > welch.magnitudes[peakIdx]) peakIdx = i;
    }

    const singleVar = variance(single.magnitudes, peakIdx);
    const welchVar = variance(welch.magnitudes, peakIdx);
    expect(welchVar).toBeLessThan(singleVar);
  });

  it('should produce flat-ish spectrum for white noise', () => {
    const sampleRate = 8000;
    const signal = generateWhiteNoise(16384);
    const spectrum = computePowerSpectrum(signal, sampleRate, 1024);

    // Check that no single bin dominates (max - min spread is bounded)
    let max = -Infinity;
    let min = Infinity;
    // Skip DC bin
    for (let i = 2; i < spectrum.magnitudes.length - 1; i++) {
      if (spectrum.magnitudes[i] > max) max = spectrum.magnitudes[i];
      if (spectrum.magnitudes[i] < min) min = spectrum.magnitudes[i];
    }

    // For white noise with Welch averaging, spread should be < 20 dB
    expect(max - min).toBeLessThan(20);
  });
});

describe('trimSpectrum', () => {
  it('should trim to specified frequency range', () => {
    const N = 1024;
    const sampleRate = 4000;
    const signal = new Float64Array(N);
    const spectrum = computeSegmentSpectrum(signal, sampleRate);

    const trimmed = trimSpectrum(spectrum, 100, 500);
    expect(trimmed.frequencies[0]).toBeGreaterThanOrEqual(100);
    expect(trimmed.frequencies[trimmed.frequencies.length - 1]).toBeLessThanOrEqual(500);
    expect(trimmed.frequencies.length).toBe(trimmed.magnitudes.length);
  });

  it('should return empty-ish result if range is above Nyquist', () => {
    const N = 256;
    const sampleRate = 1000; // Nyquist = 500 Hz
    const signal = new Float64Array(N);
    const spectrum = computeSegmentSpectrum(signal, sampleRate);

    const trimmed = trimSpectrum(spectrum, 600, 1000);
    expect(trimmed.frequencies.length).toBe(0);
  });

  it('should preserve the original spectrum data', () => {
    const N = 512;
    const sampleRate = 2000;
    const signal = generateSine(300, sampleRate, N);
    const spectrum = computeSegmentSpectrum(signal, sampleRate);

    const trimmed = trimSpectrum(spectrum, 200, 400);
    // Peak should still be at ~300 Hz
    let peakIdx = 0;
    for (let i = 1; i < trimmed.magnitudes.length; i++) {
      if (trimmed.magnitudes[i] > trimmed.magnitudes[peakIdx]) peakIdx = i;
    }
    expect(Math.abs(trimmed.frequencies[peakIdx] - 300)).toBeLessThan((sampleRate / N) * 2);
  });
});

describe('power spectrum calibration (v2 scale)', () => {
  it('a sine of amplitude A reads 10*log10(A^2/2) at its bin', () => {
    const N = 4096;
    const sampleRate = 4000;
    // Bin-aligned frequency to avoid leakage: bin 205 → 200.1953125 Hz
    const freq = (205 * sampleRate) / N;
    const A = 100;
    const signal = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      signal[i] = A * Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }
    const { frequencies, magnitudes } = computeSegmentSpectrum(signal, sampleRate);

    let peakIdx = 0;
    for (let i = 1; i < magnitudes.length; i++) {
      if (magnitudes[i] > magnitudes[peakIdx]) peakIdx = i;
    }
    expect(Math.abs(frequencies[peakIdx] - freq)).toBeLessThan(sampleRate / N);
    // Theoretical: 10*log10(100^2 / 2) = 36.99 dB
    expect(magnitudes[peakIdx]).toBeCloseTo(10 * Math.log10((A * A) / 2), 0);
  });

  it('calibration is independent of window size and sample rate', () => {
    const A = 50;
    const expected = 10 * Math.log10((A * A) / 2);
    for (const [N, fs] of [
      [1024, 2000],
      [4096, 4000],
      [8192, 8000],
    ] as const) {
      const bin = Math.round(N / 16);
      const freq = (bin * fs) / N;
      const signal = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        signal[i] = A * Math.sin((2 * Math.PI * freq * i) / fs);
      }
      const { magnitudes } = computeSegmentSpectrum(signal, fs);
      let peak = -Infinity;
      for (const m of magnitudes) peak = Math.max(peak, m);
      expect(peak).toBeCloseTo(expected, 0);
    }
  });

  it('Welch averaging preserves the calibrated sine level', () => {
    const N = 1024;
    const fs = 4000;
    const A = 20;
    const bin = 64;
    const freq = (bin * fs) / N;
    const signal = new Float64Array(N * 8);
    for (let i = 0; i < signal.length; i++) {
      signal[i] = A * Math.sin((2 * Math.PI * freq * i) / fs);
    }
    const { magnitudes } = computePowerSpectrum(signal, fs, N);
    let peak = -Infinity;
    for (const m of magnitudes) peak = Math.max(peak, m);
    expect(peak).toBeCloseTo(10 * Math.log10((A * A) / 2), 0);
  });

  it('detrends the segment: a constant offset does not appear at DC', () => {
    const N = 256;
    const signal = new Float64Array(N).fill(42);
    const { magnitudes } = computeSegmentSpectrum(signal, 1000, false);
    // Mean removal leaves an all-zero signal → every bin at the sentinel floor
    for (const m of magnitudes) {
      expect(m).toBe(-240);
    }
  });
});
