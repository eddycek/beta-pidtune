/**
 * Throttle-indexed spectrogram analyzer.
 *
 * Bins gyro data by throttle level and computes per-bin power spectra.
 * Produces a 2D (throttle × frequency) map that reveals:
 * - Motor harmonic tracking (diagonal lines — frequency scales with RPM)
 * - Frame resonance (horizontal lines — constant frequency)
 * - Electrical noise (fixed high-frequency bands)
 * - Throttle ranges with worst noise
 */
import type { BlackboxFlightData } from '@shared/types/blackbox.types';
import { normalizeThrottle } from './throttleUtils';
import type {
  ThrottleSpectrogramResult,
  ThrottleBand,
  PowerSpectrum,
} from '@shared/types/analysis.types';
import { computePowerSpectrum, trimSpectrum } from './FFTCompute';
import { estimateNoiseFloor } from './NoiseAnalyzer';
import { FFT_WINDOW_SIZE, FREQUENCY_MIN_HZ, FREQUENCY_MAX_HZ } from './constants';

/** Default number of throttle bands (10% increments) */
export const DEFAULT_NUM_BANDS = 10;

/** Minimum samples per band to compute a meaningful spectrum */
export const MIN_SAMPLES_PER_BAND = 512;

/**
 * Bin flight data samples by throttle level and collect gyro indices per band.
 *
 * @param throttleValues - Raw throttle time series values
 * @param numBands - Number of throttle bands
 * @returns Array of sample index arrays, one per band
 */
export function binByThrottle(throttleValues: Float64Array, numBands: number): number[][] {
  const bins: number[][] = Array.from({ length: numBands }, () => []);

  for (let i = 0; i < throttleValues.length; i++) {
    const norm = normalizeThrottle(throttleValues[i]);
    // Clamp to [0, numBands-1]
    let band = Math.floor(norm * numBands);
    if (band >= numBands) band = numBands - 1;
    if (band < 0) band = 0;
    bins[band].push(i);
  }

  return bins;
}

/**
 * Collect gyro values at the given sample indices into a new Float64Array.
 */
function gatherSamples(gyroValues: Float64Array, indices: number[]): Float64Array {
  const out = new Float64Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    out[i] = gyroValues[indices[i]];
  }
  return out;
}

/**
 * Compute throttle-indexed spectrogram for flight data.
 *
 * @param flightData - Parsed Blackbox flight data
 * @param numBands - Number of throttle bands (default 10)
 * @returns Spectrogram result with per-band spectra
 */
export function computeThrottleSpectrogram(
  flightData: BlackboxFlightData,
  numBands: number = DEFAULT_NUM_BANDS
): ThrottleSpectrogramResult {
  const throttle = flightData.setpoint[3];

  if (!throttle || throttle.values.length === 0) {
    return {
      bands: [],
      numBands,
      minSamplesPerBand: MIN_SAMPLES_PER_BAND,
      bandsWithData: 0,
    };
  }

  // Bin samples by throttle level
  const indexBins = binByThrottle(throttle.values, numBands);

  const bands: ThrottleBand[] = [];
  let bandsWithData = 0;
  const bandWidth = 1.0 / numBands;

  for (let b = 0; b < numBands; b++) {
    const throttleMin = b * bandWidth;
    const throttleMax = (b + 1) * bandWidth;
    const indices = indexBins[b];

    const band: ThrottleBand = {
      throttleMin: Math.round(throttleMin * 100) / 100,
      throttleMax: Math.round(throttleMax * 100) / 100,
      sampleCount: indices.length,
    };

    if (indices.length >= MIN_SAMPLES_PER_BAND) {
      // Compute spectrum per axis
      const spectra: [PowerSpectrum, PowerSpectrum, PowerSpectrum] = [
        { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
        { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
        { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
      ];
      const noiseFloors: [number, number, number] = [0, 0, 0];

      // Use smaller FFT window if band has fewer samples than default window size
      const windowSize = Math.min(FFT_WINDOW_SIZE, nextPowerOf2(Math.floor(indices.length / 2)));

      for (let axis = 0; axis < 3; axis++) {
        const samples = gatherSamples(flightData.gyro[axis].values, indices);
        const raw = computePowerSpectrum(samples, flightData.sampleRateHz, windowSize);
        spectra[axis] = trimSpectrum(raw, FREQUENCY_MIN_HZ, FREQUENCY_MAX_HZ);
        noiseFloors[axis] = estimateNoiseFloor(spectra[axis].magnitudes);
      }

      band.spectra = spectra;
      band.noiseFloorDb = noiseFloors;
      bandsWithData++;
    }

    bands.push(band);
  }

  return {
    bands,
    numBands,
    minSamplesPerBand: MIN_SAMPLES_PER_BAND,
    bandsWithData,
  };
}

/**
 * Round up to the next power of 2.
 */
function nextPowerOf2(n: number): number {
  if (n <= 0) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
