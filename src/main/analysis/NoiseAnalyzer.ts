/**
 * Noise analysis module — detects noise floor, resonance peaks, and classifies noise sources.
 *
 * Takes power spectra (from FFTCompute) and produces noise profiles with peak
 * detection and source classification (frame resonance, motor harmonics, electrical).
 */
import type {
  PowerSpectrum,
  NoisePeak,
  AxisNoiseProfile,
  NoiseProfile,
} from '@shared/types/analysis.types';
import type { DroneSize } from '@shared/types/profile.types';
import {
  PEAK_PROMINENCE_DB,
  PEAK_LOCAL_WINDOW_BINS,
  NOISE_FLOOR_PERCENTILE,
  NOISE_LEVEL_BY_SIZE,
  NOISE_LEVEL_DEFAULT,
  FRAME_RESONANCE_MIN_HZ,
  FRAME_RESONANCE_MAX_HZ,
  ELECTRICAL_NOISE_MIN_HZ,
  MOTOR_HARMONIC_TOLERANCE_RATIO,
  MOTOR_HARMONIC_TOLERANCE_MIN_HZ,
  MOTOR_HARMONIC_MIN_PEAKS,
} from './constants';

/** Sentinel value for bins with near-zero magnitude (20*log10(1e-12)) */
export const DB_SENTINEL = -240;

/** Minimum valid noise floor — anything below is treated as no-signal */
const DB_FLOOR_VALID = -100;

/**
 * Estimate the noise floor of a magnitude spectrum.
 * Uses the lower percentile of magnitudes as the floor estimate.
 * Filters out -240 dB sentinel bins (post-filter gyro data can have most
 * high-frequency bins at the floor when aggressive filters are applied).
 */
export function estimateNoiseFloor(magnitudes: Float64Array): number {
  if (magnitudes.length === 0) return DB_SENTINEL;

  // Exclude sentinel values — they represent no-signal bins, not real noise
  const valid = Array.from(magnitudes).filter((v) => v > DB_SENTINEL);
  if (valid.length === 0) return DB_SENTINEL;

  valid.sort((a, b) => a - b);
  const idx = Math.floor(valid.length * NOISE_FLOOR_PERCENTILE);
  return valid[Math.max(0, idx)];
}

/**
 * Estimate the local noise floor around a specific bin.
 * Uses median of surrounding bins (excluding the immediate neighborhood).
 */
export function localNoiseFloor(
  magnitudes: Float64Array,
  binIndex: number,
  windowBins: number = PEAK_LOCAL_WINDOW_BINS
): number {
  const start = Math.max(0, binIndex - windowBins);
  const end = Math.min(magnitudes.length, binIndex + windowBins + 1);

  // Collect bins excluding 3 bins immediately around the peak
  const values: number[] = [];
  for (let i = start; i < end; i++) {
    if (Math.abs(i - binIndex) > 3) {
      values.push(magnitudes[i]);
    }
  }

  if (values.length === 0) return magnitudes[binIndex];

  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)]; // median
}

/**
 * Detect peaks in a power spectrum using prominence-based detection.
 *
 * A peak is a local maximum where its magnitude exceeds the local noise
 * floor by more than the prominence threshold.
 */
export function detectPeaks(
  spectrum: PowerSpectrum,
  prominenceDb: number = PEAK_PROMINENCE_DB
): Array<{ frequency: number; amplitude: number; binIndex: number }> {
  const { frequencies, magnitudes } = spectrum;
  if (magnitudes.length < 3) return [];

  const peaks: Array<{ frequency: number; amplitude: number; binIndex: number }> = [];

  for (let i = 1; i < magnitudes.length - 1; i++) {
    // Local maximum check
    if (magnitudes[i] <= magnitudes[i - 1] || magnitudes[i] <= magnitudes[i + 1]) {
      continue;
    }

    // Check prominence above local noise floor
    const localFloor = localNoiseFloor(magnitudes, i);
    const prominence = magnitudes[i] - localFloor;

    if (prominence >= prominenceDb) {
      peaks.push({
        frequency: frequencies[i],
        amplitude: prominence,
        binIndex: i,
      });
    }
  }

  // Sort by amplitude (strongest first)
  peaks.sort((a, b) => b.amplitude - a.amplitude);

  return peaks;
}

/**
 * Classify a noise peak based on its frequency.
 */
export function classifyPeak(
  frequency: number,
  allPeaks: Array<{ frequency: number }>
): NoisePeak['type'] {
  // Check for motor harmonics: equally-spaced peaks
  if (isMotorHarmonic(frequency, allPeaks)) {
    return 'motor_harmonic';
  }

  // Frame resonance band
  if (frequency >= FRAME_RESONANCE_MIN_HZ && frequency <= FRAME_RESONANCE_MAX_HZ) {
    return 'frame_resonance';
  }

  // Electrical noise band
  if (frequency >= ELECTRICAL_NOISE_MIN_HZ) {
    return 'electrical';
  }

  return 'unknown';
}

/**
 * Check if a peak frequency is part of a motor harmonic series.
 * Motor harmonics are equally-spaced peaks (e.g., 150, 300, 450 Hz).
 */
/**
 * Compute tolerance for harmonic matching — relative to expected harmonic frequency.
 * Prevents false positives at low frequencies where absolute tolerance is too wide.
 */
function harmonicTolerance(expectedHz: number): number {
  return Math.max(MOTOR_HARMONIC_TOLERANCE_MIN_HZ, expectedHz * MOTOR_HARMONIC_TOLERANCE_RATIO);
}

function isMotorHarmonic(frequency: number, allPeaks: Array<{ frequency: number }>): boolean {
  if (allPeaks.length < MOTOR_HARMONIC_MIN_PEAKS) return false;

  const peakFreqs = allPeaks.map((p) => p.frequency).sort((a, b) => a - b);

  // Check if this frequency is a harmonic of any fundamental
  for (const fundamental of peakFreqs) {
    if (fundamental < 30) continue; // Too low to be a meaningful fundamental

    let harmonicCount = 0;
    for (const pf of peakFreqs) {
      const ratio = pf / fundamental;
      const nearestInt = Math.round(ratio);
      const expectedFreq = fundamental * nearestInt;
      if (nearestInt >= 1 && Math.abs(pf - expectedFreq) < harmonicTolerance(expectedFreq)) {
        harmonicCount++;
      }
    }

    if (harmonicCount >= MOTOR_HARMONIC_MIN_PEAKS) {
      // Check if our frequency matches one of these harmonics
      const ratio = frequency / fundamental;
      const nearestInt = Math.round(ratio);
      const expectedFreq = fundamental * nearestInt;
      if (nearestInt >= 1 && Math.abs(frequency - expectedFreq) < harmonicTolerance(expectedFreq)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Analyze noise for a single axis from one or more segment spectra.
 *
 * When multiple spectra are provided (from different segments), they are
 * averaged for a more robust noise estimate.
 */
export function analyzeAxisNoise(spectra: PowerSpectrum[]): AxisNoiseProfile {
  if (spectra.length === 0) {
    return {
      spectrum: { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
      noiseFloorDb: -240,
      peaks: [],
    };
  }

  // Average the spectra
  const averaged = averageSpectra(spectra);

  // Estimate noise floor
  const noiseFloorDb = estimateNoiseFloor(averaged.magnitudes);

  // Detect peaks
  const rawPeaks = detectPeaks(averaged);

  // Classify peaks
  const peaks: NoisePeak[] = rawPeaks.map((p) => ({
    frequency: p.frequency,
    amplitude: p.amplitude,
    type: classifyPeak(p.frequency, rawPeaks),
  }));

  return {
    spectrum: averaged,
    noiseFloorDb,
    peaks,
  };
}

/**
 * Average multiple power spectra (they must have identical frequency bins).
 */
export function averageSpectra(spectra: PowerSpectrum[]): PowerSpectrum {
  if (spectra.length === 1) return spectra[0];

  const numBins = spectra[0].frequencies.length;
  const avgMagnitudes = new Float64Array(numBins);

  // Average in the linear power domain (magnitudes are PSD dB)
  for (const s of spectra) {
    for (let i = 0; i < numBins; i++) {
      avgMagnitudes[i] += Math.pow(10, s.magnitudes[i] / 10);
    }
  }

  const magnitudes = new Float64Array(numBins);
  for (let i = 0; i < numBins; i++) {
    const avg = avgMagnitudes[i] / spectra.length;
    magnitudes[i] = avg > 1e-24 ? 10 * Math.log10(avg) : -240;
  }

  return { frequencies: spectra[0].frequencies, magnitudes };
}

/**
 * Determine overall noise level from axis noise profiles.
 * Uses size-aware thresholds: smaller/higher-KV quads tolerate higher noise floors.
 */
export function categorizeNoiseLevel(
  roll: AxisNoiseProfile,
  pitch: AxisNoiseProfile,
  _yaw: AxisNoiseProfile,
  droneSize?: DroneSize
): NoiseProfile['overallLevel'] {
  const thresholds = droneSize ? NOISE_LEVEL_BY_SIZE[droneSize] : NOISE_LEVEL_DEFAULT;
  // Use the worst (highest) noise floor across roll and pitch (yaw is typically noisier, less relevant)
  const worstFloor = Math.max(roll.noiseFloorDb, pitch.noiseFloorDb);

  if (worstFloor >= thresholds.highDb) return 'high';
  if (worstFloor >= thresholds.mediumDb) return 'medium';
  return 'low';
}

/**
 * Build a complete noise profile from axis profiles.
 * @param droneSize - Used for size-aware noise classification thresholds
 */
export function buildNoiseProfile(
  roll: AxisNoiseProfile,
  pitch: AxisNoiseProfile,
  yaw: AxisNoiseProfile,
  droneSize?: DroneSize
): NoiseProfile {
  return {
    roll,
    pitch,
    yaw,
    overallLevel: categorizeNoiseLevel(roll, pitch, yaw, droneSize),
  };
}
