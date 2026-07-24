/**
 * FFT computation module for gyro noise analysis.
 *
 * Provides windowed FFT, power spectral density via Welch's method,
 * and frequency bin calculation. Uses fft.js for the core transform.
 *
 * Spectra are calibrated one-sided power spectra: segments are detrended
 * (mean removed), Hanning-windowed, normalized by coherent window gain
 * ((Σw)²), and reported as 10·log10(power) in dB re (deg/s)². Welch
 * averaging happens in the power domain. Calibration: a sine of amplitude
 * A reads exactly 10·log10(A²/2) at its bin, independent of window size
 * and sample rate. White-noise floors depend only on the FFT size
 * (per-bin power ≈ 2σ²·ENBW/N ≈ 3σ²/N for Hanning), not the sample rate, so dB thresholds remain
 * comparable across logging rates.
 */
import FFT from 'fft.js';
import type { PowerSpectrum } from '@shared/types/analysis.types';
import { FFT_WINDOW_SIZE, FFT_OVERLAP, FREQUENCY_MIN_HZ, FREQUENCY_MAX_HZ } from './constants';

/** Sentinel dB value for bins with near-zero power (10*log10(1e-24)) */
export const DB_SENTINEL = -240;

/** Power floor below which a bin is reported as the sentinel */
export const POWER_FLOOR = 1e-24;

/**
 * Apply a Hanning window to a signal segment.
 * w(n) = 0.5 * (1 - cos(2*pi*n / (N-1)))
 */
export function applyHanningWindow(signal: Float64Array): Float64Array {
  const N = signal.length;
  const windowed = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    windowed[i] = signal[i] * w;
  }
  return windowed;
}

/** Coherent window gain Σw[n] for the Hanning window of length N */
function hanningWindowSum(N: number): number {
  let sum = 0;
  for (let i = 0; i < N; i++) {
    sum += 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  return sum;
}

/**
 * Compute the one-sided power spectrum (in dB) of a real-valued segment.
 *
 * The segment is detrended (mean removed) and windowed, and the power is
 * normalized by the coherent window gain:
 *   P(k) = scale · |X(k)|² / (Σw)²,  scale = 2 except at DC/Nyquist
 * so a sine of amplitude A reads 10·log10(A²/2) at its bin.
 *
 * @param segment - Time-domain samples (length must be power of 2)
 * @param sampleRate - Sample rate in Hz
 * @param applyWindow - Whether to apply Hanning window (default true)
 * @returns PowerSpectrum with frequencies and power magnitudes in dB
 */
export function computeSegmentSpectrum(
  segment: Float64Array,
  sampleRate: number,
  applyWindow = true
): PowerSpectrum {
  const N = segment.length;
  if (N === 0 || (N & (N - 1)) !== 0) {
    throw new Error(`FFT size must be a power of 2, got ${N}`);
  }

  // Detrend: remove mean so DC/low-frequency drift doesn't leak across bins
  let mean = 0;
  for (let i = 0; i < N; i++) mean += segment[i];
  mean /= N;
  const detrended = new Float64Array(N);
  for (let i = 0; i < N; i++) detrended[i] = segment[i] - mean;

  // Apply window
  const windowed = applyWindow ? applyHanningWindow(detrended) : detrended;

  // Coherent window gain for power normalization (rectangular gain = N)
  const windowSum = applyWindow ? hanningWindowSum(N) : N;

  // Run real FFT
  const fft = new FFT(N);
  const out = fft.createComplexArray();
  fft.realTransform(out, windowed);
  fft.completeSpectrum(out);

  // Compute one-sided PSD for positive frequencies (0 to N/2 inclusive)
  const numBins = N / 2 + 1;
  const frequencies = new Float64Array(numBins);
  const magnitudes = new Float64Array(numBins);
  const freqResolution = sampleRate / N;
  const norm = windowSum * windowSum;

  for (let i = 0; i < numBins; i++) {
    frequencies[i] = i * freqResolution;

    const re = out[2 * i];
    const im = out[2 * i + 1];
    const rawPower = re * re + im * im;

    // One-sided: double all bins except DC and Nyquist
    const scale = i === 0 || i === N / 2 ? 1 : 2;
    const power = (scale * rawPower) / norm;

    // Convert to dB (with floor to avoid -Infinity)
    magnitudes[i] = power > POWER_FLOOR ? 10 * Math.log10(power) : DB_SENTINEL;
  }

  return { frequencies, magnitudes };
}

/**
 * Compute the power spectral density using Welch's method.
 *
 * Splits the signal into overlapping windows, computes the PSD of each,
 * and averages in the power domain. This reduces variance in the estimate.
 *
 * @param signal - Full time-domain signal
 * @param sampleRate - Sample rate in Hz
 * @param windowSize - FFT window size (must be power of 2)
 * @returns Averaged PowerSpectrum
 */
export function computePowerSpectrum(
  signal: Float64Array,
  sampleRate: number,
  windowSize: number = FFT_WINDOW_SIZE
): PowerSpectrum {
  if (signal.length < windowSize) {
    // Signal shorter than one window — use next smaller power of 2
    const smallerSize = nextPowerOf2(signal.length);
    if (smallerSize < 16) {
      throw new Error(`Signal too short for FFT: ${signal.length} samples`);
    }
    return computeSegmentSpectrum(signal.subarray(0, smallerSize), sampleRate, true);
  }

  const step = Math.floor(windowSize * (1 - FFT_OVERLAP));
  const numWindows = Math.floor((signal.length - windowSize) / step) + 1;

  if (numWindows <= 0) {
    return computeSegmentSpectrum(signal.subarray(0, windowSize), sampleRate, true);
  }

  // Accumulate spectra
  const numBins = windowSize / 2 + 1;
  const avgPower = new Float64Array(numBins); // linear power for averaging
  let frequencies: Float64Array | null = null;

  for (let w = 0; w < numWindows; w++) {
    const start = w * step;
    const segment = signal.subarray(start, start + windowSize);
    const spectrum = computeSegmentSpectrum(segment, sampleRate, true);

    if (!frequencies) {
      frequencies = spectrum.frequencies;
    }

    // Average in the linear power domain (convert dB back to power)
    for (let i = 0; i < numBins; i++) {
      avgPower[i] += Math.pow(10, spectrum.magnitudes[i] / 10);
    }
  }

  // Convert averaged power back to dB
  const magnitudes = new Float64Array(numBins);
  for (let i = 0; i < numBins; i++) {
    const avg = avgPower[i] / numWindows;
    magnitudes[i] = avg > POWER_FLOOR ? 10 * Math.log10(avg) : DB_SENTINEL;
  }

  return { frequencies: frequencies!, magnitudes };
}

/**
 * Trim a power spectrum to only include frequencies within the range of interest.
 */
export function trimSpectrum(
  spectrum: PowerSpectrum,
  minHz: number = FREQUENCY_MIN_HZ,
  maxHz: number = FREQUENCY_MAX_HZ
): PowerSpectrum {
  const { frequencies, magnitudes } = spectrum;

  // Find first index >= minHz and last index <= maxHz
  let startIdx = -1;
  let endIdx = -1;

  for (let i = 0; i < frequencies.length; i++) {
    if (frequencies[i] >= minHz && startIdx === -1) {
      startIdx = i;
    }
    if (frequencies[i] <= maxHz) {
      endIdx = i;
    }
  }

  // No bins in range
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return {
      frequencies: new Float64Array(0),
      magnitudes: new Float64Array(0),
    };
  }

  return {
    frequencies: frequencies.slice(startIdx, endIdx + 1),
    magnitudes: magnitudes.slice(startIdx, endIdx + 1),
  };
}

/**
 * Find the largest power of 2 less than or equal to n.
 */
function nextPowerOf2(n: number): number {
  let p = 1;
  while (p * 2 <= n) {
    p *= 2;
  }
  return p;
}
