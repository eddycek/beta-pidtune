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
import { computePowerSpectrum, trimSpectrum, POWER_FLOOR, DB_SENTINEL } from './FFTCompute';
import { estimateNoiseFloor } from './NoiseAnalyzer';
import { FFT_WINDOW_SIZE, FREQUENCY_MIN_HZ, FREQUENCY_MAX_HZ } from './constants';

/** Default number of throttle bands (10% increments) */
export const DEFAULT_NUM_BANDS = 10;

/** Minimum samples per band to compute a meaningful spectrum */
export const MIN_SAMPLES_PER_BAND = 512;

/** Minimum contiguous run length (samples) usable for a band FFT window.
 * Bands are FFT'd per contiguous run — concatenating non-contiguous samples
 * would create phantom spectral content at the splice discontinuities. */
export const MIN_CONTIGUOUS_RUN = 512;

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
 * Extract contiguous runs from an ascending list of original-sample indices.
 * A run is a maximal stretch where each index is the previous one + 1.
 * Returns [start, end) ranges in the original sample space, longest first.
 */
export function findContiguousRuns(
  indices: number[],
  minLength: number
): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = 0;
  for (let i = 1; i <= indices.length; i++) {
    if (i === indices.length || indices[i] !== indices[i - 1] + 1) {
      if (i - runStart >= minLength) {
        runs.push({ start: indices[runStart], end: indices[i - 1] + 1 });
      }
      runStart = i;
    }
  }
  runs.sort((a, b) => b.end - b.start - (a.end - a.start));
  return runs;
}

/**
 * Weighted power-domain average of per-run Welch spectra for one axis.
 * Each run is FFT'd on its own contiguous slice; averages are weighted by
 * run length. All runs use the same window size → identical frequency bins.
 */
function averageRunSpectra(
  gyroValues: Float64Array,
  runs: Array<{ start: number; end: number }>,
  sampleRateHz: number,
  windowSize: number
): PowerSpectrum {
  const numBins = windowSize / 2 + 1;
  const avgPower = new Float64Array(numBins);
  let frequencies: Float64Array | null = null;
  let totalWeight = 0;

  for (const run of runs) {
    const slice = gyroValues.subarray(run.start, run.end);
    if (slice.length < windowSize) continue;
    const spectrum = computePowerSpectrum(slice, sampleRateHz, windowSize);
    if (!frequencies) frequencies = spectrum.frequencies;
    const weight = run.end - run.start;
    for (let i = 0; i < numBins; i++) {
      avgPower[i] += Math.pow(10, spectrum.magnitudes[i] / 10) * weight;
    }
    totalWeight += weight;
  }

  if (!frequencies || totalWeight === 0) {
    return { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) };
  }

  const magnitudes = new Float64Array(numBins);
  for (let i = 0; i < numBins; i++) {
    const avg = avgPower[i] / totalWeight;
    magnitudes[i] = avg > POWER_FLOOR ? 10 * Math.log10(avg) : DB_SENTINEL;
  }
  return { frequencies, magnitudes };
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

    // Only contiguous runs are FFT'd — concatenating non-contiguous samples
    // creates phantom spectral content at splice discontinuities.
    const runs =
      indices.length >= MIN_SAMPLES_PER_BAND ? findContiguousRuns(indices, MIN_CONTIGUOUS_RUN) : [];

    if (runs.length > 0) {
      // Window fits inside the longest run (runs are sorted longest-first)
      const longestRun = runs[0].end - runs[0].start;
      const windowSize = Math.min(FFT_WINDOW_SIZE, prevPowerOf2(longestRun));

      const spectra: [PowerSpectrum, PowerSpectrum, PowerSpectrum] = [
        { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
        { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
        { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
      ];
      const noiseFloors: [number, number, number] = [0, 0, 0];

      for (let axis = 0; axis < 3; axis++) {
        const raw = averageRunSpectra(
          flightData.gyro[axis].values,
          runs,
          flightData.sampleRateHz,
          windowSize
        );
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
 * Round down to the largest power of 2 <= n.
 */
function prevPowerOf2(n: number): number {
  if (n < 1) return 1;
  let p = 1;
  while (p * 2 <= n) p <<= 1;
  return p;
}
