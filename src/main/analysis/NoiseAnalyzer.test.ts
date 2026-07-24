import { describe, it, expect } from 'vitest';
import {
  estimateNoiseFloor,
  localNoiseFloor,
  detectPeaks,
  classifyPeak,
  analyzeAxisNoise,
  averageSpectra,
  categorizeNoiseLevel,
  buildNoiseProfile,
} from './NoiseAnalyzer';
import type { PowerSpectrum, AxisNoiseProfile } from '@shared/types/analysis.types';
import { computePowerSpectrum, trimSpectrum } from './FFTCompute';

/**
 * Create a synthetic power spectrum with a flat baseline and optional peaks.
 */
function createSpectrum(opts: {
  numBins: number;
  freqResolution: number;
  baselineDb: number;
  peaks?: Array<{ freqHz: number; amplitudeDb: number }>;
}): PowerSpectrum {
  const { numBins, freqResolution, baselineDb, peaks = [] } = opts;
  const frequencies = new Float64Array(numBins);
  const magnitudes = new Float64Array(numBins);

  for (let i = 0; i < numBins; i++) {
    frequencies[i] = i * freqResolution;
    magnitudes[i] = baselineDb;
  }

  // Add peaks (Gaussian shape, 3 bins wide)
  for (const peak of peaks) {
    const peakBin = Math.round(peak.freqHz / freqResolution);
    if (peakBin >= 0 && peakBin < numBins) {
      magnitudes[peakBin] = baselineDb + peak.amplitudeDb;
      // Add some spread
      if (peakBin > 0) magnitudes[peakBin - 1] = baselineDb + peak.amplitudeDb * 0.5;
      if (peakBin < numBins - 1) magnitudes[peakBin + 1] = baselineDb + peak.amplitudeDb * 0.5;
    }
  }

  return { frequencies, magnitudes };
}

function makeAxisProfile(noiseFloorDb: number): AxisNoiseProfile {
  return {
    spectrum: { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
    noiseFloorDb,
    peaks: [],
  };
}

describe('estimateNoiseFloor', () => {
  it('should return lower quartile of magnitudes', () => {
    // 100 bins at -60 dB, 10 bins at -20 dB
    const mags = new Float64Array(110);
    for (let i = 0; i < 100; i++) mags[i] = -60;
    for (let i = 100; i < 110; i++) mags[i] = -20;

    const floor = estimateNoiseFloor(mags);
    // Lower quartile should be -60 dB
    expect(floor).toBe(-60);
  });

  it('should return -240 for empty spectrum', () => {
    expect(estimateNoiseFloor(new Float64Array(0))).toBe(-240);
  });

  it('should handle uniform spectrum', () => {
    const mags = new Float64Array(100).fill(-45);
    expect(estimateNoiseFloor(mags)).toBe(-45);
  });

  it('should filter out sentinel bins when >25% are at -240 dB', () => {
    // 30 sentinel bins + 70 real bins at -50 dB → 30% sentinels should be excluded
    const mags = new Float64Array(100);
    for (let i = 0; i < 30; i++) mags[i] = -240;
    for (let i = 30; i < 100; i++) mags[i] = -50;

    const floor = estimateNoiseFloor(mags);
    // Sentinel bins filtered out, noise floor based only on real data
    expect(floor).toBe(-50);
    // Must NOT be dragged down toward -240
    expect(floor).toBeGreaterThan(-100);
  });
});

describe('localNoiseFloor', () => {
  it('should estimate median of surrounding bins', () => {
    const mags = new Float64Array(200).fill(-50);
    // Add a peak
    mags[100] = -10;
    mags[99] = -30;
    mags[101] = -30;

    const floor = localNoiseFloor(mags, 100);
    expect(floor).toBeCloseTo(-50, 0);
  });

  it('should handle edge bins', () => {
    const mags = new Float64Array(20).fill(-40);
    mags[0] = -10;
    const floor = localNoiseFloor(mags, 0);
    expect(floor).toBeCloseTo(-40, 0);
  });
});

describe('detectPeaks', () => {
  it('should detect a single prominent peak', () => {
    const spectrum = createSpectrum({
      numBins: 512,
      freqResolution: 2, // 2 Hz per bin
      baselineDb: -60,
      peaks: [{ freqHz: 150, amplitudeDb: 20 }],
    });

    const peaks = detectPeaks(spectrum);
    expect(peaks.length).toBeGreaterThanOrEqual(1);
    // Highest peak should be near 150 Hz
    expect(Math.abs(peaks[0].frequency - 150)).toBeLessThan(5);
    expect(peaks[0].amplitude).toBeGreaterThan(6);
  });

  it('should detect multiple peaks', () => {
    const spectrum = createSpectrum({
      numBins: 512,
      freqResolution: 2,
      baselineDb: -60,
      peaks: [
        { freqHz: 100, amplitudeDb: 15 },
        { freqHz: 300, amplitudeDb: 12 },
        { freqHz: 600, amplitudeDb: 10 },
      ],
    });

    const peaks = detectPeaks(spectrum);
    expect(peaks.length).toBeGreaterThanOrEqual(3);

    const peakFreqs = peaks.map((p) => p.frequency).sort((a, b) => a - b);
    expect(peakFreqs.some((f) => Math.abs(f - 100) < 5)).toBe(true);
    expect(peakFreqs.some((f) => Math.abs(f - 300) < 5)).toBe(true);
    expect(peakFreqs.some((f) => Math.abs(f - 600) < 5)).toBe(true);
  });

  it('should not detect peaks below prominence threshold', () => {
    const spectrum = createSpectrum({
      numBins: 512,
      freqResolution: 2,
      baselineDb: -60,
      peaks: [{ freqHz: 200, amplitudeDb: 3 }], // Below 6 dB threshold
    });

    const peaks = detectPeaks(spectrum);
    // Should not detect the weak peak
    const near200 = peaks.filter((p) => Math.abs(p.frequency - 200) < 10);
    expect(near200.length).toBe(0);
  });

  it('should return peaks sorted by amplitude (strongest first)', () => {
    const spectrum = createSpectrum({
      numBins: 512,
      freqResolution: 2,
      baselineDb: -60,
      peaks: [
        { freqHz: 100, amplitudeDb: 10 },
        { freqHz: 300, amplitudeDb: 25 },
        { freqHz: 500, amplitudeDb: 15 },
      ],
    });

    const peaks = detectPeaks(spectrum);
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i].amplitude).toBeLessThanOrEqual(peaks[i - 1].amplitude);
    }
  });

  it('should return empty for flat spectrum', () => {
    const spectrum = createSpectrum({
      numBins: 256,
      freqResolution: 4,
      baselineDb: -50,
    });

    const peaks = detectPeaks(spectrum);
    expect(peaks.length).toBe(0);
  });

  it('should return empty for spectrum with fewer than 3 bins', () => {
    const spectrum: PowerSpectrum = {
      frequencies: new Float64Array([0, 100]),
      magnitudes: new Float64Array([-50, -30]),
    };
    expect(detectPeaks(spectrum).length).toBe(0);
  });
});

describe('classifyPeak', () => {
  it('should classify 80-200 Hz peaks as frame_resonance', () => {
    const allPeaks = [{ frequency: 130 }];
    expect(classifyPeak(130, allPeaks)).toBe('frame_resonance');
    expect(classifyPeak(80, allPeaks)).toBe('frame_resonance');
    expect(classifyPeak(200, allPeaks)).toBe('frame_resonance');
  });

  it('should classify >500 Hz peaks as electrical', () => {
    const allPeaks = [{ frequency: 600 }];
    expect(classifyPeak(600, allPeaks)).toBe('electrical');
  });

  it('should classify equally-spaced peaks as motor_harmonic', () => {
    // Peaks at 150, 300, 450 Hz — harmonics of 150 Hz fundamental
    const allPeaks = [{ frequency: 150 }, { frequency: 300 }, { frequency: 450 }];
    expect(classifyPeak(150, allPeaks)).toBe('motor_harmonic');
    expect(classifyPeak(300, allPeaks)).toBe('motor_harmonic');
  });

  it('should classify non-pattern mid-range peaks as unknown', () => {
    const allPeaks = [{ frequency: 350 }];
    expect(classifyPeak(350, allPeaks)).toBe('unknown');
  });
});

describe('averageSpectra', () => {
  it('should return same spectrum for single input', () => {
    const spectrum = createSpectrum({
      numBins: 64,
      freqResolution: 10,
      baselineDb: -40,
    });

    const result = averageSpectra([spectrum]);
    expect(result).toBe(spectrum); // Same reference
  });

  it('should average two spectra', () => {
    const s1 = createSpectrum({ numBins: 64, freqResolution: 10, baselineDb: -40 });
    const s2 = createSpectrum({ numBins: 64, freqResolution: 10, baselineDb: -40 });

    const result = averageSpectra([s1, s2]);
    // Should be similar to individual spectra since they're the same
    for (let i = 0; i < 64; i++) {
      expect(Math.abs(result.magnitudes[i] - s1.magnitudes[i])).toBeLessThan(1);
    }
  });
});

describe('analyzeAxisNoise', () => {
  it('should return empty profile for no spectra', () => {
    const result = analyzeAxisNoise([]);
    expect(result.noiseFloorDb).toBe(-240);
    expect(result.peaks.length).toBe(0);
  });

  it('should detect peaks and noise floor from real FFT data', () => {
    // Create a signal with a sine wave at 150 Hz + noise
    const sampleRate = 4000;
    const N = 8192;
    const signal = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      signal[i] = 10 * Math.sin((2 * Math.PI * 150 * i) / sampleRate) + (Math.random() - 0.5) * 0.5;
    }

    const spectrum = computePowerSpectrum(signal, sampleRate, 1024);
    const trimmed = trimSpectrum(spectrum, 20, 1000);

    const result = analyzeAxisNoise([trimmed]);
    // Should find a peak near 150 Hz
    const peak150 = result.peaks.find((p) => Math.abs(p.frequency - 150) < 20);
    expect(peak150).toBeDefined();
    expect(peak150!.amplitude).toBeGreaterThan(5);
  });

  it('should classify peaks by frequency band', () => {
    const spectrum = createSpectrum({
      numBins: 512,
      freqResolution: 2,
      baselineDb: -60,
      peaks: [
        { freqHz: 130, amplitudeDb: 15 }, // frame_resonance
        { freqHz: 600, amplitudeDb: 12 }, // electrical
      ],
    });

    const result = analyzeAxisNoise([spectrum]);
    const frameRes = result.peaks.find((p) => p.type === 'frame_resonance');
    const electrical = result.peaks.find((p) => p.type === 'electrical');
    expect(frameRes).toBeDefined();
    expect(electrical).toBeDefined();
  });
});

describe('categorizeNoiseLevel', () => {
  it('should return "high" when noise floor >= -20 dB', () => {
    const roll = makeAxisProfile(-10);
    const pitch = makeAxisProfile(-15);
    const yaw = makeAxisProfile(-5);
    expect(categorizeNoiseLevel(roll, pitch, yaw)).toBe('high');
  });

  it('should return "medium" when noise floor >= -40 dB and < -20 dB', () => {
    const roll = makeAxisProfile(-30);
    const pitch = makeAxisProfile(-35);
    const yaw = makeAxisProfile(0); // yaw ignored for level calc
    expect(categorizeNoiseLevel(roll, pitch, yaw)).toBe('medium');
  });

  it('should return "low" when noise floor < -40 dB', () => {
    const roll = makeAxisProfile(-50);
    const pitch = makeAxisProfile(-45);
    const yaw = makeAxisProfile(-20);
    expect(categorizeNoiseLevel(roll, pitch, yaw)).toBe('low');
  });

  it('should use worst of roll/pitch (not yaw)', () => {
    const roll = makeAxisProfile(-50);
    const pitch = makeAxisProfile(-15); // High noise
    const yaw = makeAxisProfile(-50);
    expect(categorizeNoiseLevel(roll, pitch, yaw)).toBe('high');
  });

  it('should use size-aware thresholds for 4" quad', () => {
    // -16 dB on 5" = HIGH (> -20), on 4" also HIGH (> -17)
    // -18 dB on 5" = HIGH (> -20), but on 4" = MEDIUM (threshold is -17)
    const roll = makeAxisProfile(-18);
    const pitch = makeAxisProfile(-18);
    const yaw = makeAxisProfile(-10);
    expect(categorizeNoiseLevel(roll, pitch, yaw)).toBe('high'); // -18 > -20 → HIGH on 5"
    expect(categorizeNoiseLevel(roll, pitch, yaw, '4"')).toBe('medium'); // -18 < -17 → MEDIUM on 4"
  });

  it('should use size-aware thresholds for 7" quad', () => {
    // -24 dB on 5" = MEDIUM, but on 7" = HIGH (threshold is -25)
    const roll = makeAxisProfile(-24);
    const pitch = makeAxisProfile(-24);
    const yaw = makeAxisProfile(-20);
    expect(categorizeNoiseLevel(roll, pitch, yaw)).toBe('medium'); // 5" default
    expect(categorizeNoiseLevel(roll, pitch, yaw, '7"')).toBe('high'); // 7" threshold -25
  });

  it('should use size-aware thresholds for 1" whoop', () => {
    // -8 dB on 5" = HIGH, but on 1" = MEDIUM (threshold is -5)
    const roll = makeAxisProfile(-8);
    const pitch = makeAxisProfile(-8);
    const yaw = makeAxisProfile(0);
    expect(categorizeNoiseLevel(roll, pitch, yaw)).toBe('high'); // 5" default
    expect(categorizeNoiseLevel(roll, pitch, yaw, '1"')).toBe('medium'); // 1" threshold -5
  });
});

describe('buildNoiseProfile', () => {
  it('should combine axis profiles into a noise profile', () => {
    const roll = makeAxisProfile(-30);
    const pitch = makeAxisProfile(-35);
    const yaw = makeAxisProfile(-25);

    const profile = buildNoiseProfile(roll, pitch, yaw);
    expect(profile.roll).toBe(roll);
    expect(profile.pitch).toBe(pitch);
    expect(profile.yaw).toBe(yaw);
    expect(profile.overallLevel).toBe('medium');
  });

  it('should classify exactly-on-boundary noise as the higher tier (inclusive)', () => {
    // -20 dB is exactly highDb for 5" → should be 'high' (inclusive >=)
    const exactHigh = makeAxisProfile(-20);
    const quiet = makeAxisProfile(-50);
    expect(buildNoiseProfile(exactHigh, quiet, quiet).overallLevel).toBe('high');

    // -40 dB is exactly mediumDb for 5" → should be 'medium' (inclusive >=)
    const exactMedium = makeAxisProfile(-40);
    expect(buildNoiseProfile(exactMedium, quiet, quiet).overallLevel).toBe('medium');

    // Below mediumDb → 'low'
    const low = makeAxisProfile(-41);
    expect(buildNoiseProfile(low, quiet, quiet).overallLevel).toBe('low');
  });

  it('should pass droneSize through to categorization', () => {
    const roll = makeAxisProfile(-18);
    const pitch = makeAxisProfile(-18);
    const yaw = makeAxisProfile(-10);

    const profile5 = buildNoiseProfile(roll, pitch, yaw);
    const profile4 = buildNoiseProfile(roll, pitch, yaw, '4"');
    expect(profile5.overallLevel).toBe('high'); // -18 >= -20 → HIGH on 5"
    expect(profile4.overallLevel).toBe('medium'); // -18 < -17 → not high on 4", -18 >= -30 → MEDIUM
  });
});
