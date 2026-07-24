/**
 * Transfer function estimation via Wiener deconvolution.
 *
 * Computes the closed-loop transfer function H(f) = S_xy(f) / S_xx(f)
 * from setpoint → gyro data. Works with any flight data (no stick snaps required).
 *
 * Reference: Plasmatree PID-Analyzer (2s Hanning windows, Welch averaging).
 */

import FFT from 'fft.js';
import { applyHanningWindow } from './FFTCompute';

// ---- Constants ----

/** Window size for transfer function estimation (2s at 4kHz = 8192 samples) */
const TF_WINDOW_SIZE = 8192;

/** Overlap ratio for Welch-style averaging */
const TF_OVERLAP = 0.5;

/** Regularization floor — prevents division by zero in low-energy bins */
const REGULARIZATION_FLOOR = 1e-10;

/** Maximum frequency of interest for transfer function (Hz) */
const TF_MAX_FREQ_HZ = 500;

/** Synthetic step response duration (seconds) */
const STEP_RESPONSE_DURATION_S = 0.2;
const IMPULSE_SMOOTH_WINDOW = 8;

/** Bandwidth threshold: -3 dB below DC gain */
const BANDWIDTH_THRESHOLD_DB = -3;

/** Low-frequency band used as the DC-gain reference (Hz).
 * Bin 0 itself is numerically unreliable: rate setpoints are ~zero-mean, so the
 * DC bin carries almost no excitation energy and H[0] is regularization-dominated.
 * Averaging 1-5 Hz gives a stable steady-state gain estimate instead. */
const DC_REFERENCE_MIN_HZ = 1;
const DC_REFERENCE_MAX_HZ = 5;

/** Settling tolerance for synthetic step response (±2%) */
const SETTLING_TOLERANCE = 0.02;

/** Upper bound of the band used for the mean-coherence summary (Hz).
 * Stick input carries most energy below ~40 Hz; the mean uses 1-30 Hz (bin 0 excluded, see DC_REFERENCE notes) — coherence above that band
 * reflects noise, not tracking, and would dilute the mean. */
const COHERENCE_BAND_MAX_HZ = 30;

// ---- Types ----

export interface BodeResult {
  /** Frequency bins in Hz */
  frequencies: Float64Array;
  /** Magnitude in dB */
  magnitude: Float64Array;
  /** Phase in degrees */
  phase: Float64Array;
  /** Magnitude-squared coherence γ²(f) = |S_xy|²/(S_xx·S_yy), 0-1 per bin.
   * Absent when only one Welch window fits (coherence is trivially 1). */
  coherence?: Float64Array;
}

export interface SyntheticStepResponse {
  /** Time points in ms */
  timeMs: number[];
  /** Normalized response (0 = no response, 1 = full tracking) */
  response: number[];
}

export interface TransferFunctionMetrics {
  /** -3dB bandwidth in Hz */
  bandwidthHz: number;
  /** Gain margin in dB */
  gainMarginDb: number;
  /** Phase margin in degrees */
  phaseMarginDeg: number;
  /** Overshoot from synthetic step response (%) */
  overshootPercent: number;
  /** Settling time from synthetic step response (ms) */
  settlingTimeMs: number;
  /** Rise time from synthetic step response (ms) */
  riseTimeMs: number;
  /** DC gain in dB — 0 dB = perfect steady-state tracking */
  dcGainDb: number;
  /** Mean magnitude-squared coherence over the 1-30 Hz stick-input band (0-1).
   * Undefined when the log was too short for multi-window Welch averaging. */
  coherenceMean?: number;
  /** False when the phase never crossed -180° — gainMarginDb is then the 60 dB
   * cap (an "at least this stable" placeholder), not a measured margin. */
  gainMarginCrossingFound?: boolean;
  /** False when the gain never crossed 0 dB — phaseMarginDeg is then the 90°
   * cap, not a measured margin. */
  phaseMarginCrossingFound?: boolean;
}

export interface TransferFunctionResult {
  /** Per-axis Bode plot data */
  roll: BodeResult;
  pitch: BodeResult;
  yaw: BodeResult;
  /** Per-axis synthetic step response */
  syntheticStepResponse: {
    roll: SyntheticStepResponse;
    pitch: SyntheticStepResponse;
    yaw: SyntheticStepResponse;
  };
  /** Per-axis metrics derived from transfer function */
  metrics: {
    roll: TransferFunctionMetrics;
    pitch: TransferFunctionMetrics;
    yaw: TransferFunctionMetrics;
  };
  /** Analysis time in ms */
  analysisTimeMs: number;
}

export interface TransferFunctionProgress {
  step: 'windowing' | 'fft' | 'transfer_function' | 'metrics';
  percent: number;
}

// ---- Core Algorithm ----

/**
 * Estimate the closed-loop transfer function from setpoint → gyro.
 *
 * Uses cross-spectral density method with Welch averaging:
 *   H(f) = S_xy(f) / (S_xx(f) + epsilon)
 *
 * where S_xy = cross-spectral density, S_xx = auto-spectral density of input.
 */
export function estimateTransferFunction(
  setpoint: Float64Array,
  gyro: Float64Array,
  sampleRateHz: number,
  onProgress?: (progress: TransferFunctionProgress) => void
): { bode: BodeResult; impulseResponse: Float64Array } {
  const N = Math.min(setpoint.length, gyro.length);
  const windowSize = Math.min(TF_WINDOW_SIZE, largestPowerOf2(N));

  if (windowSize < 64) {
    throw new Error(`Signal too short for transfer function estimation: ${N} samples`);
  }

  const step = Math.floor(windowSize * (1 - TF_OVERLAP));
  const numWindows = Math.max(1, Math.floor((N - windowSize) / step) + 1);

  const numBins = windowSize / 2 + 1;

  // Accumulators for cross-spectral and auto-spectral densities
  const sxyRe = new Float64Array(numBins); // Real part of S_xy
  const sxyIm = new Float64Array(numBins); // Imaginary part of S_xy
  const sxx = new Float64Array(numBins); // |X(f)|^2
  const syy = new Float64Array(numBins); // |Y(f)|^2 (for coherence)

  onProgress?.({ step: 'windowing', percent: 5 });

  const fft = new FFT(windowSize);

  for (let w = 0; w < numWindows; w++) {
    const start = w * step;

    // Extract and window both signals
    const xSeg = applyHanningWindow(setpoint.subarray(start, start + windowSize));
    const ySeg = applyHanningWindow(gyro.subarray(start, start + windowSize));

    // FFT of both
    const X = fft.createComplexArray();
    const Y = fft.createComplexArray();
    fft.realTransform(X, xSeg);
    fft.completeSpectrum(X);
    fft.realTransform(Y, ySeg);
    fft.completeSpectrum(Y);

    // Accumulate: S_xy += Y * conj(X), S_xx += |X|^2
    for (let i = 0; i < numBins; i++) {
      const xRe = X[2 * i];
      const xIm = X[2 * i + 1];
      const yRe = Y[2 * i];
      const yIm = Y[2 * i + 1];

      // Y * conj(X) = (yRe + j*yIm)(xRe - j*xIm)
      sxyRe[i] += yRe * xRe + yIm * xIm;
      sxyIm[i] += yIm * xRe - yRe * xIm;

      // |X|^2 and |Y|^2
      sxx[i] += xRe * xRe + xIm * xIm;
      syy[i] += yRe * yRe + yIm * yIm;
    }

    onProgress?.({
      step: 'fft',
      percent: 5 + Math.round((w / numWindows) * 50),
    });
  }

  onProgress?.({ step: 'transfer_function', percent: 60 });

  // Compute noise-floor-based regularization (epsilon)
  const epsilon = computeRegularization(sxx, numWindows);

  // H(f) = S_xy / (S_xx + epsilon)
  const freqResolution = sampleRateHz / windowSize;
  const frequencies = new Float64Array(numBins);
  const magnitude = new Float64Array(numBins);
  const phase = new Float64Array(numBins);
  const hRe = new Float64Array(numBins);
  const hIm = new Float64Array(numBins);

  // Magnitude-squared coherence γ²(f) = |S_xy|²/(S_xx·S_yy).
  // With a single Welch window it is identically 1 — report it only when
  // at least 2 windows were averaged.
  const coherence = numWindows >= 2 ? new Float64Array(numBins) : undefined;

  for (let i = 0; i < numBins; i++) {
    frequencies[i] = i * freqResolution;

    const denom = sxx[i] + epsilon;
    hRe[i] = sxyRe[i] / denom;
    hIm[i] = sxyIm[i] / denom;

    const mag = Math.sqrt(hRe[i] * hRe[i] + hIm[i] * hIm[i]);
    magnitude[i] = mag > 1e-12 ? 20 * Math.log10(mag) : -240;
    phase[i] = (Math.atan2(hIm[i], hRe[i]) * 180) / Math.PI;

    if (coherence) {
      const crossPower = sxyRe[i] * sxyRe[i] + sxyIm[i] * sxyIm[i];
      const autoProduct = sxx[i] * syy[i];
      coherence[i] = autoProduct > 1e-20 ? Math.min(1, Math.max(0, crossPower / autoProduct)) : 0;
    }
  }

  // Compute impulse response via IFFT of H(f)
  const impulseResponse = computeImpulseResponse(fft, hRe, hIm, windowSize);

  onProgress?.({ step: 'metrics', percent: 80 });

  return {
    bode: { frequencies, magnitude, phase, ...(coherence ? { coherence } : {}) },
    impulseResponse,
  };
}

/**
 * Mean coherence over the stick-input band (1 to COHERENCE_BAND_MAX_HZ).
 * Returns undefined when the Bode result carries no coherence data.
 */
export function computeCoherenceMean(bode: BodeResult): number | undefined {
  if (!bode.coherence) return undefined;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < bode.frequencies.length; i++) {
    const f = bode.frequencies[i];
    if (f >= DC_REFERENCE_MIN_HZ && f <= COHERENCE_BAND_MAX_HZ) {
      sum += bode.coherence[i];
      count++;
    }
    if (f > COHERENCE_BAND_MAX_HZ) break;
  }
  return count > 0 ? sum / count : undefined;
}

/**
 * Estimate transfer function for all 3 axes and derive metrics.
 */
export function estimateAllAxes(
  setpoint: { roll: Float64Array; pitch: Float64Array; yaw: Float64Array },
  gyro: { roll: Float64Array; pitch: Float64Array; yaw: Float64Array },
  sampleRateHz: number,
  onProgress?: (progress: TransferFunctionProgress) => void
): TransferFunctionResult {
  const startTime = performance.now();

  const axes = ['roll', 'pitch', 'yaw'] as const;
  const bodeResults: Record<string, BodeResult> = {};
  const stepResponses: Record<string, SyntheticStepResponse> = {};
  const metricsResults: Record<string, TransferFunctionMetrics> = {};

  for (let a = 0; a < axes.length; a++) {
    const axis = axes[a];

    const axisProgress = (p: TransferFunctionProgress) => {
      onProgress?.({
        step: p.step,
        percent: Math.round(a * 33 + (p.percent * 33) / 100),
      });
    };

    const { bode, impulseResponse } = estimateTransferFunction(
      setpoint[axis],
      gyro[axis],
      sampleRateHz,
      axisProgress
    );

    // Trim to max frequency of interest
    const trimmed = trimBode(bode, TF_MAX_FREQ_HZ);
    bodeResults[axis] = trimmed;

    // Extract synthetic step response from impulse response
    const synStep = computeSyntheticStepResponse(impulseResponse, sampleRateHz);
    stepResponses[axis] = synStep;

    // Derive metrics
    metricsResults[axis] = extractMetrics(trimmed, synStep, sampleRateHz);
  }

  onProgress?.({ step: 'metrics', percent: 100 });

  return {
    roll: bodeResults.roll,
    pitch: bodeResults.pitch,
    yaw: bodeResults.yaw,
    syntheticStepResponse: {
      roll: stepResponses.roll,
      pitch: stepResponses.pitch,
      yaw: stepResponses.yaw,
    },
    metrics: {
      roll: metricsResults.roll,
      pitch: metricsResults.pitch,
      yaw: metricsResults.yaw,
    },
    analysisTimeMs: performance.now() - startTime,
  };
}

// ---- Helper Functions ----

/**
 * Compute noise-floor-based regularization parameter.
 * Uses the median of S_xx as the noise floor estimate.
 */
function computeRegularization(sxx: Float64Array, numWindows: number): number {
  // Average S_xx across windows
  const avgSxx = new Float64Array(sxx.length);
  for (let i = 0; i < sxx.length; i++) {
    avgSxx[i] = sxx[i] / numWindows;
  }

  // Find median as noise floor estimate
  const sorted = Array.from(avgSxx).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Regularization = fraction of noise floor (prevents artifacts in low-energy bins)
  return Math.max(median * 0.01, REGULARIZATION_FLOOR);
}

/**
 * Compute impulse response from H(f) via IFFT.
 */
function computeImpulseResponse(
  fft: FFT,
  hRe: Float64Array,
  hIm: Float64Array,
  windowSize: number
): Float64Array {
  // Build full complex spectrum for inverse FFT
  const complexH = fft.createComplexArray();
  const numBins = windowSize / 2 + 1;

  // Fill positive frequencies
  for (let i = 0; i < numBins; i++) {
    complexH[2 * i] = hRe[i];
    complexH[2 * i + 1] = hIm[i];
  }

  // Fill negative frequencies (conjugate symmetry)
  for (let i = 1; i < windowSize / 2; i++) {
    const mirror = windowSize - i;
    complexH[2 * mirror] = hRe[i];
    complexH[2 * mirror + 1] = -hIm[i];
  }

  // Inverse FFT
  const timeDomain = fft.createComplexArray();
  fft.inverseTransform(timeDomain, complexH);

  // Extract real part
  const impulse = new Float64Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    impulse[i] = timeDomain[2 * i];
  }

  return impulse;
}

/**
 * Compute synthetic step response by integrating (cumulative sum) the impulse response.
 */
export function computeSyntheticStepResponse(
  impulseResponse: Float64Array,
  sampleRateHz: number
): SyntheticStepResponse {
  const maxSamples = Math.min(
    Math.floor(STEP_RESPONSE_DURATION_S * sampleRateHz),
    Math.floor(impulseResponse.length / 2) // Use first half only
  );

  if (maxSamples < 2) {
    return { timeMs: [0], response: [0] };
  }

  // Smooth impulse response with moving average to reduce noise
  const halfW = Math.floor(IMPULSE_SMOOTH_WINDOW / 2);
  const smoothed = new Float64Array(maxSamples);
  for (let i = 0; i < maxSamples; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - halfW); j <= Math.min(maxSamples - 1, i + halfW); j++) {
      sum += impulseResponse[j];
      count++;
    }
    smoothed[i] = sum / count;
  }

  const timeMs: number[] = [];
  const response: number[] = [];
  let cumSum = 0;

  for (let i = 0; i < maxSamples; i++) {
    cumSum += smoothed[i];
    timeMs.push((i / sampleRateHz) * 1000);
    response.push(cumSum);
  }

  // Normalize by final value so overshoot is measured relative to the system's own
  // steady state, not the setpoint. This separates P/D tuning (overshoot) from I-term
  // issues (DC gain deficit). A system with poor DC gain (I too low) that oscillates
  // before settling will correctly show overshoot here, while TF-4 handles the DC gain
  // deficit separately via bode.magnitude[0].
  const finalValue = response[response.length - 1];
  if (Math.abs(finalValue) > 1e-10) {
    for (let i = 0; i < response.length; i++) {
      response[i] /= finalValue;
    }
  }

  return { timeMs, response };
}

/**
 * Extract transfer function metrics from Bode plot and synthetic step response.
 */
export function extractMetrics(
  bode: BodeResult,
  stepResponse: SyntheticStepResponse,
  _sampleRateHz: number
): TransferFunctionMetrics {
  const coherenceMean = computeCoherenceMean(bode);
  const gainMargin = computeGainMargin(bode);
  const phaseMargin = computePhaseMargin(bode);
  return {
    bandwidthHz: computeBandwidth(bode),
    gainMarginDb: gainMargin.valueDb,
    phaseMarginDeg: phaseMargin.valueDeg,
    gainMarginCrossingFound: gainMargin.crossingFound,
    phaseMarginCrossingFound: phaseMargin.crossingFound,
    overshootPercent: computeOvershoot(stepResponse),
    settlingTimeMs: computeSettlingTime(stepResponse),
    riseTimeMs: computeRiseTime(stepResponse),
    dcGainDb: computeDcGainDb(bode),
    ...(coherenceMean !== undefined ? { coherenceMean } : {}),
  };
}

/**
 * Steady-state (DC) gain estimated from the 1-5 Hz band average.
 * See DC_REFERENCE_MIN_HZ for why bin 0 is not used directly.
 */
export function computeDcGainDb(bode: BodeResult): number {
  if (bode.magnitude.length === 0) return 0;

  let sum = 0;
  let count = 0;
  for (let i = 0; i < bode.frequencies.length; i++) {
    const f = bode.frequencies[i];
    if (f >= DC_REFERENCE_MIN_HZ && f <= DC_REFERENCE_MAX_HZ) {
      sum += bode.magnitude[i];
      count++;
    }
    if (f > DC_REFERENCE_MAX_HZ) break;
  }
  if (count > 0) return sum / count;

  // Very coarse resolution — fall back to the first bin above DC, then bin 0
  return bode.magnitude.length > 1 ? bode.magnitude[1] : bode.magnitude[0];
}

/**
 * Find -3dB bandwidth: highest frequency where magnitude is within 3dB of DC gain.
 */
function computeBandwidth(bode: BodeResult): number {
  if (bode.frequencies.length === 0) return 0;

  // DC gain from the low-frequency reference band (not the unreliable bin 0)
  const dcGain = computeDcGainDb(bode);
  const threshold = dcGain + BANDWIDTH_THRESHOLD_DB;

  let bandwidthHz = 0;
  for (let i = 0; i < bode.frequencies.length; i++) {
    if (bode.magnitude[i] >= threshold) {
      bandwidthHz = bode.frequencies[i];
    }
  }

  return bandwidthHz;
}

/**
 * Compute gain margin: how much gain (in dB) before instability.
 * Found at the frequency where phase crosses -180 degrees.
 */
function computeGainMargin(bode: BodeResult): { valueDb: number; crossingFound: boolean } {
  // Find phase crossover frequency (where phase = -180)
  for (let i = 1; i < bode.phase.length; i++) {
    if (bode.phase[i] <= -180 && bode.phase[i - 1] > -180) {
      // Interpolate
      const f0 = bode.phase[i - 1];
      const f1 = bode.phase[i];
      const t = (-180 - f0) / (f1 - f0);
      const idx = i - 1 + t;
      const fracIdx = Math.floor(idx);
      const frac = idx - fracIdx;

      const magAtCrossover =
        bode.magnitude[fracIdx] * (1 - frac) +
        bode.magnitude[Math.min(fracIdx + 1, bode.magnitude.length - 1)] * frac;

      // Gain margin = -magnitude at phase crossover (positive = stable)
      return { valueDb: -magAtCrossover, crossingFound: true };
    }
  }

  // Phase never crossed -180 within the analysis band — no measurable margin.
  // The 60 dB cap is a placeholder; crossingFound=false marks it as unmeasured.
  return { valueDb: 60, crossingFound: false };
}

/**
 * Compute phase margin: how much additional phase lag before instability.
 * Found at the frequency where gain crosses 0 dB.
 */
function computePhaseMargin(bode: BodeResult): { valueDeg: number; crossingFound: boolean } {
  // Find gain crossover frequency (where magnitude = 0 dB)
  for (let i = 1; i < bode.magnitude.length; i++) {
    if (bode.magnitude[i] <= 0 && bode.magnitude[i - 1] > 0) {
      // Interpolate to find exact crossover
      const m0 = bode.magnitude[i - 1];
      const m1 = bode.magnitude[i];
      const t = (0 - m0) / (m1 - m0);
      const idx = i - 1 + t;
      const fracIdx = Math.floor(idx);
      const frac = idx - fracIdx;

      const phaseAtCrossover =
        bode.phase[fracIdx] * (1 - frac) +
        bode.phase[Math.min(fracIdx + 1, bode.phase.length - 1)] * frac;

      // Phase margin = 180 + phase at gain crossover (positive = stable)
      return { valueDeg: 180 + phaseAtCrossover, crossingFound: true };
    }
  }

  // Gain never crossed 0 dB within the analysis band — no measurable margin.
  // The 90° cap is a placeholder; crossingFound=false marks it as unmeasured.
  return { valueDeg: 90, crossingFound: false };
}

/**
 * Compute overshoot percentage from synthetic step response.
 */
function computeOvershoot(step: SyntheticStepResponse): number {
  if (step.response.length < 2) return 0;

  const peak = Math.max(...step.response);
  // Response is normalized to final value = 1.0
  const overshoot = Math.max(0, (peak - 1.0) * 100);
  return Math.round(overshoot * 10) / 10;
}

/**
 * Compute settling time: time to stay within ±2% of final value.
 */
function computeSettlingTime(step: SyntheticStepResponse): number {
  if (step.response.length < 2) return 0;

  // Final value is 1.0 (normalized)
  const lower = 1.0 - SETTLING_TOLERANCE;
  const upper = 1.0 + SETTLING_TOLERANCE;

  // Find last time the response exits the tolerance band
  let lastExitIdx = 0;
  for (let i = 0; i < step.response.length; i++) {
    if (step.response[i] < lower || step.response[i] > upper) {
      lastExitIdx = i;
    }
  }

  // If never settled, return total duration
  if (lastExitIdx >= step.response.length - 1) {
    return step.timeMs[step.timeMs.length - 1];
  }

  return step.timeMs[Math.min(lastExitIdx + 1, step.timeMs.length - 1)];
}

/**
 * Compute rise time: time from 10% to 90% of final value.
 */
function computeRiseTime(step: SyntheticStepResponse): number {
  if (step.response.length < 2) return 0;

  let t10 = -1;
  let t90 = -1;

  for (let i = 0; i < step.response.length; i++) {
    if (t10 < 0 && step.response[i] >= 0.1) {
      t10 = step.timeMs[i];
    }
    if (t90 < 0 && step.response[i] >= 0.9) {
      t90 = step.timeMs[i];
      break;
    }
  }

  if (t10 < 0 || t90 < 0) {
    return step.timeMs[step.timeMs.length - 1]; // Never reached
  }

  return t90 - t10;
}

/**
 * Trim Bode plot to maximum frequency of interest.
 */
export function trimBode(bode: BodeResult, maxFreqHz: number): BodeResult {
  let endIdx = bode.frequencies.length;
  for (let i = 0; i < bode.frequencies.length; i++) {
    if (bode.frequencies[i] > maxFreqHz) {
      endIdx = i;
      break;
    }
  }

  return {
    frequencies: bode.frequencies.slice(0, endIdx),
    magnitude: bode.magnitude.slice(0, endIdx),
    phase: bode.phase.slice(0, endIdx),
    ...(bode.coherence ? { coherence: bode.coherence.slice(0, endIdx) } : {}),
  };
}

/**
 * Find the largest power of 2 less than or equal to n.
 */
function largestPowerOf2(n: number): number {
  let p = 1;
  while (p * 2 <= n) {
    p *= 2;
  }
  return p;
}
