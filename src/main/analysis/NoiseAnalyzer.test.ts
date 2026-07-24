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
  reclassifyPeaksWithThrottle,
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

  it('should detect a flat-topped (plateau) peak once, at its center', () => {
    const spectrum = createSpectrum({ numBins: 512, freqResolution: 2, baselineDb: -60 });
    // Plateau: bins 98-102 all at -40 (frequency 196-204 Hz, center 200 Hz)
    for (let b = 98; b <= 102; b++) spectrum.magnitudes[b] = -40;

    const peaks = detectPeaks(spectrum);
    const near200 = peaks.filter((p) => Math.abs(p.frequency - 200) < 10);
    expect(near200.length).toBe(1);
    expect(near200[0].frequency).toBeCloseTo(200, 0);
    expect(near200[0].amplitude).toBeCloseTo(20, 0);
  });

  it('should suppress weaker candidates within the minimum spacing', () => {
    const spectrum = createSpectrum({ numBins: 512, freqResolution: 2, baselineDb: -60 });
    // Broad hump: strong peak at 200 Hz plus a weaker shoulder 6 Hz away
    spectrum.magnitudes[100] = -30; // 200 Hz
    spectrum.magnitudes[99] = -38;
    spectrum.magnitudes[101] = -38;
    spectrum.magnitudes[103] = -36; // 206 Hz shoulder (local max)
    spectrum.magnitudes[102] = -42;
    spectrum.magnitudes[104] = -42;

    const peaks = detectPeaks(spectrum);
    const near = peaks.filter((p) => Math.abs(p.frequency - 203) < 12);
    expect(near.length).toBe(1);
    expect(near[0].frequency).toBeCloseTo(200, 0);
  });

  it('should keep separate peaks farther apart than the minimum spacing', () => {
    const spectrum = createSpectrum({
      numBins: 512,
      freqResolution: 2,
      baselineDb: -60,
      peaks: [
        { freqHz: 200, amplitudeDb: 20 },
        { freqHz: 220, amplitudeDb: 15 }, // 20 Hz away — beyond 15 Hz spacing
      ],
    });

    const peaks = detectPeaks(spectrum);
    expect(peaks.some((p) => Math.abs(p.frequency - 200) < 5)).toBe(true);
    expect(peaks.some((p) => Math.abs(p.frequency - 220) < 5)).toBe(true);
  });

  it('should interpolate sub-bin peak frequency (parabolic)', () => {
    // Asymmetric neighbors → true peak sits between bins, toward the higher side
    const spectrum = createSpectrum({ numBins: 512, freqResolution: 2, baselineDb: -60 });
    spectrum.magnitudes[99] = -45; // 198 Hz
    spectrum.magnitudes[100] = -30; // 200 Hz (max bin)
    spectrum.magnitudes[101] = -35; // 202 Hz (higher than 198 → peak shifted right)

    const peaks = detectPeaks(spectrum);
    const peak = peaks.find((p) => Math.abs(p.frequency - 200) < 4)!;
    expect(peak).toBeDefined();
    expect(peak.frequency).toBeGreaterThan(200);
    expect(peak.frequency).toBeLessThan(201);
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

  it('should use size-aware frame resonance bands', () => {
    // 300 Hz: outside the 5" band (80-200) but inside the 2.5" band (150-350)
    const allPeaks = [{ frequency: 300 }];
    expect(classifyPeak(300, allPeaks)).toBe('unknown'); // 5" fallback
    expect(classifyPeak(300, allPeaks, '2.5"')).toBe('frame_resonance');
    expect(classifyPeak(300, allPeaks, '1"')).toBe('frame_resonance');

    // 65 Hz: below the 5" band but inside the 7" band (60-150)
    const lowPeaks = [{ frequency: 65 }];
    expect(classifyPeak(65, lowPeaks)).toBe('unknown');
    expect(classifyPeak(65, lowPeaks, '7"')).toBe('frame_resonance');

    // 190 Hz: inside 5" band but above the 7" band (60-150)
    const midPeaks = [{ frequency: 190 }];
    expect(classifyPeak(190, midPeaks)).toBe('frame_resonance');
    expect(classifyPeak(190, midPeaks, '7"')).toBe('unknown');
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

describe('reclassifyPeaksWithThrottle', () => {
  /** Build a throttle band whose axis-0 spectrum has one peak at peakHz */
  function makeBand(
    throttleMin: number,
    throttleMax: number,
    peakHz: number,
    baselineDb = -40,
    peakDb = -15
  ) {
    const numBins = 512;
    const freqRes = 2;
    const frequencies = new Float64Array(numBins).map((_, i) => i * freqRes);
    const magnitudes = new Float64Array(numBins).fill(baselineDb);
    const bin = Math.round(peakHz / freqRes);
    magnitudes[bin] = peakDb;
    const spectrum = { frequencies, magnitudes };
    return {
      throttleMin,
      throttleMax,
      sampleCount: 5000,
      spectra: [spectrum, spectrum, spectrum] as [
        typeof spectrum,
        typeof spectrum,
        typeof spectrum,
      ],
      noiseFloorDb: [baselineDb, baselineDb, baselineDb] as [number, number, number],
    };
  }

  const basePeak = { frequency: 200, amplitude: 20, type: 'frame_resonance' as const };

  it('reclassifies a throttle-tracking peak as motor_harmonic with its track', () => {
    // Peak frequency rises 140→260 Hz across throttle — motor noise
    const bands = [
      makeBand(0.1, 0.2, 140),
      makeBand(0.3, 0.4, 180),
      makeBand(0.5, 0.6, 220),
      makeBand(0.7, 0.8, 260),
    ];
    const [peak] = reclassifyPeaksWithThrottle([basePeak], bands, 0, '5"');
    expect(peak.type).toBe('motor_harmonic');
    expect(peak.classifiedBy).toBe('throttle_track');
    expect(peak.throttleTrack).toBeDefined();
    expect(peak.throttleTrack!.frequencyHz.length).toBe(4);
  });

  it('reclassifies a stationary peak as frame_resonance (definitively not motor)', () => {
    // Same frequency at every throttle — stationary
    const misclassified = { frequency: 160, amplitude: 20, type: 'motor_harmonic' as const };
    const bands = [
      makeBand(0.1, 0.2, 160),
      makeBand(0.3, 0.4, 160),
      makeBand(0.5, 0.6, 160),
      makeBand(0.7, 0.8, 162),
    ];
    const [peak] = reclassifyPeaksWithThrottle([misclassified], bands, 0, '5"');
    expect(peak.type).toBe('frame_resonance');
    expect(peak.classifiedBy).toBe('throttle_track');
  });

  it('classifies a stationary high-frequency peak as electrical', () => {
    const p = { frequency: 600, amplitude: 15, type: 'motor_harmonic' as const };
    const bands = [makeBand(0.1, 0.2, 600), makeBand(0.3, 0.4, 600), makeBand(0.5, 0.6, 602)];
    const [peak] = reclassifyPeaksWithThrottle([p], bands, 0, '5"');
    expect(peak.type).toBe('electrical');
  });

  it('keeps the heuristic classification for ambiguous tracks', () => {
    // Range ~10% — between stationary (8%) and tracking (15%) thresholds
    const bands = [
      makeBand(0.1, 0.2, 190),
      makeBand(0.3, 0.4, 196),
      makeBand(0.5, 0.6, 202),
      makeBand(0.7, 0.8, 210),
    ];
    const [peak] = reclassifyPeaksWithThrottle([basePeak], bands, 0, '5"');
    expect(peak.type).toBe('frame_resonance'); // unchanged
    expect(peak.classifiedBy).toBe('heuristic');
  });

  it('keeps the heuristic classification with too few bands', () => {
    const bands = [makeBand(0.1, 0.2, 140), makeBand(0.7, 0.8, 260)];
    const [peak] = reclassifyPeaksWithThrottle([basePeak], bands, 0, '5"');
    expect(peak.classifiedBy).toBe('heuristic');
    expect(peak.type).toBe('frame_resonance');
  });

  it('skips bands where the peak is not prominent', () => {
    // Peak visible in only 2 of 4 bands (others flat) → heuristic kept
    const flat = makeBand(0.3, 0.4, 180);
    flat.spectra[0].magnitudes.fill(-40);
    const flat2 = makeBand(0.5, 0.6, 220);
    flat2.spectra[0].magnitudes.fill(-40);
    const bands = [makeBand(0.1, 0.2, 140), flat, flat2, makeBand(0.7, 0.8, 260)];
    const [peak] = reclassifyPeaksWithThrottle([basePeak], bands, 0, '5"');
    expect(peak.classifiedBy).toBe('heuristic');
  });

  it('uses the size-aware frame band for stationary peaks', () => {
    // 300 Hz stationary: inside the 2.5" frame band, outside the 5" band
    const p = { frequency: 300, amplitude: 15, type: 'unknown' as const };
    const bands = [makeBand(0.1, 0.2, 300), makeBand(0.3, 0.4, 300), makeBand(0.5, 0.6, 301)];
    const [micro] = reclassifyPeaksWithThrottle([p], bands, 0, '2.5"');
    expect(micro.type).toBe('frame_resonance');
    const [five] = reclassifyPeaksWithThrottle([p], bands, 0, '5"');
    expect(five.type).toBe('unknown'); // 300 Hz outside 5" band, below electrical
  });
});
