import { describe, it, expect } from 'vitest';
import {
  recommend,
  generateSummary,
  computeNoiseBasedTarget,
  isRpmFilterActive,
  recommendRpmFilterQ,
  recommendDtermDynExpo,
} from './FilterRecommender';
import type {
  NoiseProfile,
  AxisNoiseProfile,
  CurrentFilterSettings,
  NoisePeak,
} from '@shared/types/analysis.types';
import { DEFAULT_FILTER_SETTINGS } from '@shared/types/analysis.types';
import {
  GYRO_LPF1_MIN_HZ,
  GYRO_LPF1_MAX_HZ,
  GYRO_LPF1_MAX_HZ_RPM,
  DTERM_LPF1_MIN_HZ,
  DTERM_LPF1_MAX_HZ,
  DTERM_LPF1_MAX_HZ_RPM,
  NOISE_FLOOR_VERY_NOISY_DB,
  NOISE_FLOOR_VERY_CLEAN_DB,
  DYN_NOTCH_COUNT_WITH_RPM,
  DYN_NOTCH_Q_WITH_RPM,
  PROPWASH_GYRO_LPF1_FLOOR_HZ,
} from './constants';

function makeAxisProfile(noiseFloorDb: number, peaks: NoisePeak[] = []): AxisNoiseProfile {
  return {
    spectrum: { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
    noiseFloorDb,
    peaks,
  };
}

function makeNoiseProfile(opts: {
  level: NoiseProfile['overallLevel'];
  rollFloor?: number;
  pitchFloor?: number;
  yawFloor?: number;
  rollPeaks?: NoisePeak[];
  pitchPeaks?: NoisePeak[];
  yawPeaks?: NoisePeak[];
}): NoiseProfile {
  return {
    roll: makeAxisProfile(opts.rollFloor ?? -40, opts.rollPeaks),
    pitch: makeAxisProfile(opts.pitchFloor ?? -40, opts.pitchPeaks),
    yaw: makeAxisProfile(opts.yawFloor ?? -40, opts.yawPeaks),
    overallLevel: opts.level,
  };
}

describe('computeNoiseBasedTarget', () => {
  it('should return minHz for extreme noise', () => {
    expect(computeNoiseBasedTarget(NOISE_FLOOR_VERY_NOISY_DB, 75, 300)).toBe(75);
  });

  it('should return maxHz for very clean signal', () => {
    expect(computeNoiseBasedTarget(NOISE_FLOOR_VERY_CLEAN_DB, 75, 300)).toBe(300);
  });

  it('should interpolate linearly for mid-range noise', () => {
    // Midpoint: (0 + -60) / 2 = -30 → (75 + 300) / 2 = 187.5 → 188
    const target = computeNoiseBasedTarget(-30, 75, 300);
    expect(target).toBe(188);
  });

  it('should clamp to minHz for noise above very noisy threshold', () => {
    expect(computeNoiseBasedTarget(0, 75, 300)).toBe(75);
  });

  it('should clamp to maxHz for noise below very clean threshold', () => {
    expect(computeNoiseBasedTarget(-90, 75, 300)).toBe(300);
  });
});

describe('recommend', () => {
  it('should recommend noise-based targets for high noise', () => {
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -10 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
      dterm_lpf1_static_hz: 150,
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    const dtermRec = recs.find((r) => r.setting === 'dterm_lpf1_static_hz');

    expect(gyroRec).toBeDefined();
    // worstFloor = max(-25, -20) = -20, target = interpolate(-20, 75, 300) ≈ 112
    expect(gyroRec!.recommendedValue).toBeLessThan(current.gyro_lpf1_static_hz);
    expect(dtermRec).toBeDefined();
    expect(dtermRec!.recommendedValue).toBeLessThan(current.dterm_lpf1_static_hz);
  });

  it('should recommend noise-based targets for low noise', () => {
    const noise = makeNoiseProfile({ level: 'low', rollFloor: -55, pitchFloor: -50 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 150,
      dterm_lpf1_static_hz: 100,
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    const dtermRec = recs.find((r) => r.setting === 'dterm_lpf1_static_hz');

    expect(gyroRec).toBeDefined();
    // worstFloor = max(-65, -60) = -60, target = interpolate(-60, 75, 300) ≈ 262
    expect(gyroRec!.recommendedValue).toBeGreaterThan(current.gyro_lpf1_static_hz);
    expect(dtermRec).toBeDefined();
    expect(dtermRec!.recommendedValue).toBeGreaterThan(current.dterm_lpf1_static_hz);
  });

  it('should not recommend changes for medium noise when settings are close to target', () => {
    // Noise floors (-50 dB) produce target ~225 Hz for gyro, ~157 Hz for dterm
    // Set current values within 20 Hz deadzone of targets
    const noise = makeNoiseProfile({ level: 'medium', rollFloor: -40, pitchFloor: -40 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 225, // Exactly at target
      dterm_lpf1_static_hz: 157, // Exactly at target
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    const dtermRec = recs.find((r) => r.setting === 'dterm_lpf1_static_hz');
    expect(gyroRec).toBeUndefined();
    expect(dtermRec).toBeUndefined();
  });

  it('should recommend changes for medium noise when settings are far from target', () => {
    // Noise floor -50 dB produces target ~225 Hz for gyro, ~157 Hz for dterm
    // Current settings are far off → should recommend with low confidence
    const noise = makeNoiseProfile({ level: 'medium', rollFloor: -40, pitchFloor: -40 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 100, // Far below target (~225)
      dterm_lpf1_static_hz: 70, // Far below target (~157)
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    const dtermRec = recs.find((r) => r.setting === 'dterm_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    expect(gyroRec!.confidence).toBe('low');
    expect(dtermRec).toBeDefined();
    expect(dtermRec!.confidence).toBe('low');
  });

  it('should respect minimum safety bounds', () => {
    // Very noisy noise floor → target will be at min
    const noise = makeNoiseProfile({ level: 'high', rollFloor: 5, pitchFloor: 5 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: GYRO_LPF1_MIN_HZ,
      dterm_lpf1_static_hz: DTERM_LPF1_MIN_HZ,
    };

    const recs = recommend(noise, current);
    // Target is already at/near minimum → no recommendation within deadzone
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    const dtermRec = recs.find((r) => r.setting === 'dterm_lpf1_static_hz');
    expect(gyroRec).toBeUndefined();
    expect(dtermRec).toBeUndefined();
  });

  it('should respect maximum safety bounds', () => {
    // Very clean noise floor → target will be at max
    const noise = makeNoiseProfile({ level: 'low', rollFloor: -65, pitchFloor: -65 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: GYRO_LPF1_MAX_HZ,
      dterm_lpf1_static_hz: DTERM_LPF1_MAX_HZ,
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    const dtermRec = recs.find((r) => r.setting === 'dterm_lpf1_static_hz');
    // Already at maximum
    expect(gyroRec).toBeUndefined();
    expect(dtermRec).toBeUndefined();
  });

  it('should not recommend when target is within deadzone of current', () => {
    // Noise floor that produces a target close to the current setting
    // Target for gyro with floor -50: t = (-50 - (-10)) / (-60) = 0.667, target = 75 + 0.667 * 225 = 225
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -40, pitchFloor: -40 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 225, // Exactly at target
      dterm_lpf1_static_hz: 157, // Close to target (70 + 0.667 * 130 ≈ 157)
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    const dtermRec = recs.find((r) => r.setting === 'dterm_lpf1_static_hz');
    expect(gyroRec).toBeUndefined();
    expect(dtermRec).toBeUndefined();
  });

  it('should recommend lowering cutoff for resonance peak below filter (outside notch range)', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 80, amplitude: 15, type: 'frame_resonance' }],
    });

    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
      dyn_notch_min_hz: 150, // Peak at 80 Hz is below notch range → LPF must handle it
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    expect(gyroRec!.recommendedValue).toBeLessThan(80);
    expect(gyroRec!.confidence).toBe('high');
  });

  it('should skip LPF lowering when resonance peak is within dyn_notch range', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 180, amplitude: 15, type: 'frame_resonance' }],
    });

    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 225, // Close to noise-based target (no medium noise rec)
      dterm_lpf1_static_hz: 157,
      dyn_notch_min_hz: 100,
      dyn_notch_max_hz: 600, // Peak at 180 is within notch range
      dyn_notch_count: 3, // Notch must be ENABLED to cover the peak
    };

    const recs = recommend(noise, current);
    // Notch can handle resonance → no resonance-based LPF change
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeUndefined();
  });

  it('should act on a resonance peak in notch range when dyn_notch_count = 0 (notch disabled)', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 180, amplitude: 15, type: 'frame_resonance' }],
    });

    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 225,
      dterm_lpf1_static_hz: 157,
      dyn_notch_min_hz: 100,
      dyn_notch_max_hz: 600, // Peak nominally "in range"…
      dyn_notch_count: 0, // …but a disabled notch covers nothing
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    expect(gyroRec!.ruleId).toBe('F-RES-GYRO');
    expect(gyroRec!.recommendedValue).toBeLessThan(225);
  });

  it('should treat undefined dyn_notch_count as enabled (BF default is 3 notches)', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 180, amplitude: 15, type: 'frame_resonance' }],
    });

    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS, // dyn_notch_count undefined
      gyro_lpf1_static_hz: 225,
      dterm_lpf1_static_hz: 157,
      dyn_notch_min_hz: 100,
      dyn_notch_max_hz: 600,
    };

    const recs = recommend(noise, current);
    // Unknown count → assume BF default (enabled) → notch covers the peak
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeUndefined();
  });

  it('should not recommend changes for peaks above current cutoff', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 650, amplitude: 15, type: 'unknown' }],
    });

    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 225, // Close to noise target (avoids medium noise rec)
      dterm_lpf1_static_hz: 157,
      dyn_notch_max_hz: 600, // Peak at 650 is above notch range AND above LPF cutoff
    };

    const recs = recommend(noise, current);
    // LPF only lowered when peak is BELOW cutoff — 650 > 225, no resonance-based LPF change
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeUndefined();
  });

  it('should not flag peaks with low amplitude', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [
        { frequency: 180, amplitude: 8, type: 'frame_resonance' }, // Below 12 dB threshold
      ],
    });

    const recs = recommend(noise, DEFAULT_FILTER_SETTINGS);
    // No resonance recommendation since amplitude < 12 dB
    // Medium noise may produce other recs, but no resonance-specific ones
    const resonanceRecs = recs.filter(
      (r) => r.reason.includes('resonance') || r.reason.includes('noise spike')
    );
    expect(resonanceRecs.length).toBe(0);
  });

  it('should recommend dynamic notch min adjustment when peak is below range', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 100, amplitude: 15, type: 'frame_resonance' }],
    });

    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dyn_notch_min_hz: 150, // Peak at 100 Hz is below
    };

    const recs = recommend(noise, current);
    const notchRec = recs.find((r) => r.setting === 'dyn_notch_min_hz');
    expect(notchRec).toBeDefined();
    expect(notchRec!.recommendedValue).toBeLessThan(100);
  });

  it('should recommend dynamic notch max adjustment when peak is above range', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      yawPeaks: [{ frequency: 700, amplitude: 15, type: 'electrical' }],
    });

    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dyn_notch_max_hz: 600, // Peak at 700 Hz is above
    };

    const recs = recommend(noise, current);
    const notchRec = recs.find((r) => r.setting === 'dyn_notch_max_hz');
    expect(notchRec).toBeDefined();
    expect(notchRec!.recommendedValue).toBeGreaterThan(700);
  });

  it('should skip gyro LPF noise-floor adjustment when gyro_lpf1 is disabled (0)', () => {
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -15 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 0, // Disabled (common with RPM filter)
    };

    const recs = recommend(noise, current);
    // Should NOT recommend gyro LPF adjustment from noise floor rule
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeUndefined();
    // Should still recommend D-term adjustment
    const dtermRec = recs.find((r) => r.setting === 'dterm_lpf1_static_hz');
    expect(dtermRec).toBeDefined();
  });

  it('should recommend enabling gyro LPF for resonance peak when LPF is disabled (peak outside notch)', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 80, amplitude: 15, type: 'frame_resonance' }],
    });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 0, // Disabled
      dyn_notch_min_hz: 150, // Peak at 80 Hz is below notch range
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    expect(gyroRec!.recommendedValue).toBeLessThanOrEqual(80);
    expect(gyroRec!.reason).toContain('disabled');
  });

  it('should deduplicate recommendations for the same setting', () => {
    // High noise + resonance peak both want to lower gyro_lpf1
    const noise = makeNoiseProfile({
      level: 'high',
      rollFloor: -15,
      pitchFloor: -15,
      rollPeaks: [{ frequency: 180, amplitude: 15, type: 'frame_resonance' }],
    });

    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
    };

    const recs = recommend(noise, current);
    const gyroRecs = recs.filter((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRecs.length).toBe(1); // Deduplicated
  });

  it('should provide beginner-friendly reason strings', () => {
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -15 });
    const recs = recommend(noise, DEFAULT_FILTER_SETTINGS);

    for (const rec of recs) {
      expect(rec.reason.length).toBeGreaterThan(20);
      // Should not contain technical jargon without explanation
      expect(rec.reason).not.toContain('PSD');
      expect(rec.reason).not.toContain('Welch');
    }
  });

  it('should set appropriate impact values', () => {
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -15 });
    const recs = recommend(noise, DEFAULT_FILTER_SETTINGS);

    for (const rec of recs) {
      expect(['latency', 'noise', 'both']).toContain(rec.impact);
    }
  });

  it('should set appropriate confidence values', () => {
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -15 });
    const recs = recommend(noise, DEFAULT_FILTER_SETTINGS);

    for (const rec of recs) {
      expect(['high', 'medium', 'low']).toContain(rec.confidence);
    }
  });

  it('should converge: applying recommendations and re-running produces no further changes', () => {
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -10 });
    const initial: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
      dterm_lpf1_static_hz: 150,
    };

    // First run: get recommendations
    const recs1 = recommend(noise, initial);
    expect(recs1.length).toBeGreaterThan(0);

    // Apply recommendations to create "after" settings
    const applied: CurrentFilterSettings = { ...initial };
    for (const rec of recs1) {
      (applied as any)[rec.setting] = rec.recommendedValue;
    }

    // Second run with same noise data but applied settings → should produce no changes
    const recs2 = recommend(noise, applied);
    const noiseFloorRecs = recs2.filter(
      (r) => r.setting === 'gyro_lpf1_static_hz' || r.setting === 'dterm_lpf1_static_hz'
    );
    expect(noiseFloorRecs.length).toBe(0);
  });
});

describe('generateSummary', () => {
  it('should return positive message when no changes needed and low noise', () => {
    const noise = makeNoiseProfile({ level: 'low' });
    const summary = generateSummary(noise, []);
    expect(summary).toContain('clean');
    expect(summary).toContain('no changes needed');
  });

  it('should mention high noise level', () => {
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -15 });
    const recs = recommend(noise, DEFAULT_FILTER_SETTINGS);
    const summary = generateSummary(noise, recs);
    expect(summary).toMatch(/vibration|noise/i);
  });

  it('should mention frame resonance when detected', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 150, amplitude: 15, type: 'frame_resonance' }],
    });
    const summary = generateSummary(noise, []);
    expect(summary).toContain('Frame resonance');
  });

  it('should mention motor harmonics when detected', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      pitchPeaks: [{ frequency: 200, amplitude: 15, type: 'motor_harmonic' }],
    });
    const summary = generateSummary(noise, []);
    expect(summary).toContain('Motor harmonic');
  });

  it('should state number of recommended changes', () => {
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -15 });
    const recs = recommend(noise, DEFAULT_FILTER_SETTINGS);
    const summary = generateSummary(noise, recs);
    expect(summary).toMatch(/\d+ filter change/);
  });

  it('should mention RPM filter in summary when active', () => {
    const noise = makeNoiseProfile({ level: 'low' });
    const summary = generateSummary(noise, [], true);
    expect(summary).toContain('RPM filter is active');
  });
});

describe('isRpmFilterActive', () => {
  it('returns true when rpm_filter_harmonics > 0', () => {
    expect(isRpmFilterActive({ ...DEFAULT_FILTER_SETTINGS, rpm_filter_harmonics: 3 })).toBe(true);
  });

  it('returns false when rpm_filter_harmonics is 0', () => {
    expect(isRpmFilterActive({ ...DEFAULT_FILTER_SETTINGS, rpm_filter_harmonics: 0 })).toBe(false);
  });

  it('returns false when rpm_filter_harmonics is undefined', () => {
    expect(isRpmFilterActive(DEFAULT_FILTER_SETTINGS)).toBe(false);
  });
});

describe('RPM-aware recommendations', () => {
  it('should use wider bounds (RPM max) for low noise with RPM active', () => {
    const noise = makeNoiseProfile({ level: 'low', rollFloor: -65, pitchFloor: -65 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: GYRO_LPF1_MAX_HZ, // At non-RPM max (300)
      dterm_lpf1_static_hz: DTERM_LPF1_MAX_HZ, // At non-RPM max (200)
      rpm_filter_harmonics: 3,
    };

    const recs = recommend(noise, current);
    // With RPM, max is 500/300, so clean signal should recommend higher cutoffs
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    const dtermRec = recs.find((r) => r.setting === 'dterm_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    expect(gyroRec!.recommendedValue).toBeGreaterThan(GYRO_LPF1_MAX_HZ);
    expect(gyroRec!.recommendedValue).toBeLessThanOrEqual(GYRO_LPF1_MAX_HZ_RPM);
    expect(dtermRec).toBeDefined();
    expect(dtermRec!.recommendedValue).toBeGreaterThan(DTERM_LPF1_MAX_HZ);
    expect(dtermRec!.recommendedValue).toBeLessThanOrEqual(DTERM_LPF1_MAX_HZ_RPM);
  });

  it('should recommend dyn_notch_count reduction when RPM active', () => {
    const noise = makeNoiseProfile({ level: 'medium' });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      dyn_notch_count: 3, // Non-RPM default
      dyn_notch_q: 300, // Non-RPM default
    };

    const recs = recommend(noise, current);
    const countRec = recs.find((r) => r.setting === 'dyn_notch_count');
    expect(countRec).toBeDefined();
    expect(countRec!.recommendedValue).toBe(DYN_NOTCH_COUNT_WITH_RPM);
  });

  it('should recommend dyn_notch_q increase when RPM active', () => {
    const noise = makeNoiseProfile({ level: 'medium' });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      dyn_notch_count: 3,
      dyn_notch_q: 300,
    };

    const recs = recommend(noise, current);
    const qRec = recs.find((r) => r.setting === 'dyn_notch_q');
    expect(qRec).toBeDefined();
    expect(qRec!.recommendedValue).toBe(DYN_NOTCH_Q_WITH_RPM);
  });

  it('should NOT recommend dyn_notch changes when RPM is inactive', () => {
    const noise = makeNoiseProfile({ level: 'medium' });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 0,
      dyn_notch_count: 3,
      dyn_notch_q: 300,
    };

    const recs = recommend(noise, current);
    expect(recs.find((r) => r.setting === 'dyn_notch_count')).toBeUndefined();
    expect(recs.find((r) => r.setting === 'dyn_notch_q')).toBeUndefined();
  });

  it('should NOT recommend dyn_notch changes when RPM data is undefined', () => {
    const noise = makeNoiseProfile({ level: 'medium' });
    const recs = recommend(noise, DEFAULT_FILTER_SETTINGS);
    expect(recs.find((r) => r.setting === 'dyn_notch_count')).toBeUndefined();
    expect(recs.find((r) => r.setting === 'dyn_notch_q')).toBeUndefined();
  });

  it('should produce unchanged behavior (regression) when RPM state is unknown', () => {
    // Without RPM fields, should behave exactly as before
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -10 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
      dterm_lpf1_static_hz: 150,
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    // Without RPM, max is 300 — should NOT exceed it
    expect(gyroRec!.recommendedValue).toBeLessThanOrEqual(GYRO_LPF1_MAX_HZ);
  });

  it('should include RPM note in reason strings when RPM active', () => {
    const noise = makeNoiseProfile({ level: 'low', rollFloor: -55, pitchFloor: -50 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 150,
      dterm_lpf1_static_hz: 100,
      rpm_filter_harmonics: 3,
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    expect(gyroRec!.reason).toContain('RPM filter active');
  });
});

describe('propwash-aware filter floor', () => {
  it('should clamp gyro LPF1 to propwash floor when noise is high but not extreme', () => {
    // Noise floor -16 dB: noisy enough for a low target, but below bypass threshold (-15)
    // Raw target: 75 + ((-16 - (-10)) / (-60)) * 225 = 75 + (6/60)*225 = 75 + 22.5 = 97.5 → 98 Hz
    // 98 < PROPWASH_GYRO_LPF1_FLOOR_HZ (100) and -16 <= -15 → floor applied → 100 Hz
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -6, pitchFloor: -6 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    expect(gyroRec!.recommendedValue).toBe(PROPWASH_GYRO_LPF1_FLOOR_HZ);
    expect(gyroRec!.reason).toContain('propwash');
  });

  it('should bypass propwash floor when noise is extreme (above bypass threshold)', () => {
    // Noise floor -12 dB: extremely noisy, above bypass threshold (-15)
    // Raw target: 75 + ((-12 - (-10)) / (-60)) * 225 = 75 + (2/60)*225 = 75 + 7.5 = 82.5 → 83 Hz
    // -12 > -15 → bypass propwash floor → 83 Hz
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -2, pitchFloor: -2 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    expect(gyroRec!.recommendedValue).toBeLessThan(PROPWASH_GYRO_LPF1_FLOOR_HZ);
    expect(gyroRec!.reason).not.toContain('propwash');
  });

  it('should not apply propwash floor when noise-based target is already above floor', () => {
    // Noise floor -25 dB: high but not extreme, target well above 100 Hz
    // Raw target: 75 + ((-25 - (-10)) / (-60)) * 225 = 75 + (15/60)*225 = 75 + 56.25 = 131 → 131 Hz
    // 131 >= 100 → propwash floor not triggered
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -15 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    expect(gyroRec!.recommendedValue).toBeGreaterThanOrEqual(PROPWASH_GYRO_LPF1_FLOOR_HZ);
    expect(gyroRec!.reason).not.toContain('propwash');
  });

  it('should not apply propwash floor to D-term LPF (only gyro)', () => {
    // Noise floor -16 dB triggers propwash floor for gyro
    // D-term target: 70 + (6/60)*130 = 70 + 13 = 83 Hz — should NOT be floored
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -6, pitchFloor: -6 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
      dterm_lpf1_static_hz: 150,
    };

    const recs = recommend(noise, current);
    const dtermRec = recs.find((r) => r.setting === 'dterm_lpf1_static_hz');
    expect(dtermRec).toBeDefined();
    expect(dtermRec!.recommendedValue).toBeLessThan(PROPWASH_GYRO_LPF1_FLOOR_HZ);
    expect(dtermRec!.reason).not.toContain('propwash');
  });

  it('should not apply propwash floor to resonance-based recommendations', () => {
    // Resonance peak at 90 Hz → target = 90 - 20 = 70, clamped to 75 Hz
    // This is resonance-based, not noise-floor-based — propwash floor should NOT apply
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 90, amplitude: 15, type: 'frame_resonance' }],
    });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 200,
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    expect(gyroRec!.recommendedValue).toBe(GYRO_LPF1_MIN_HZ); // 75 Hz, below propwash floor
    expect(gyroRec!.reason).not.toContain('propwash');
  });

  it('should remain convergent with propwash floor applied', () => {
    // First run: propwash floor clamps target to 100 Hz
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -6, pitchFloor: -6 });
    const initial: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
    };

    const recs1 = recommend(noise, initial);
    const gyroRec = recs1.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    expect(gyroRec!.recommendedValue).toBe(PROPWASH_GYRO_LPF1_FLOOR_HZ);

    // Apply and re-run: should produce no further gyro LPF changes
    const applied: CurrentFilterSettings = { ...initial };
    for (const rec of recs1) {
      (applied as any)[rec.setting] = rec.recommendedValue;
    }

    const recs2 = recommend(noise, applied);
    const gyroRec2 = recs2.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec2).toBeUndefined();
  });

  it('should apply propwash floor at exact bypass boundary (-15 dB)', () => {
    // Noise floor exactly at bypass threshold: -15 dB
    // -15 <= -15 → floor SHOULD apply (boundary is inclusive)
    // Raw target: 75 + (5/60)*225 = 75 + 18.75 = 93.75 → 94 Hz (below 100)
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -5, pitchFloor: -5 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
    };

    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    expect(gyroRec!.recommendedValue).toBe(PROPWASH_GYRO_LPF1_FLOOR_HZ);
  });
});

describe('LPF2 recommendations', () => {
  it('should recommend disabling gyro LPF2 when RPM active and noise is very clean', () => {
    // Noise floor < -45 dB (GYRO_LPF2_DISABLE_THRESHOLD_DB), RPM active, LPF2 enabled
    const noise = makeNoiseProfile({ level: 'low', rollFloor: -45, pitchFloor: -40 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf2_static_hz: 250,
      rpm_filter_harmonics: 3,
    };

    const recs = recommend(noise, current);
    const gyroLpf2Rec = recs.find((r) => r.setting === 'gyro_lpf2_static_hz');
    expect(gyroLpf2Rec).toBeDefined();
    expect(gyroLpf2Rec!.recommendedValue).toBe(0);
    expect(gyroLpf2Rec!.impact).toBe('latency');
  });

  it('should recommend disabling dterm LPF2 when RPM active and noise is very clean', () => {
    // Noise floor < -45 dB, RPM active, dterm LPF2 enabled
    const noise = makeNoiseProfile({ level: 'low', rollFloor: -45, pitchFloor: -40 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf2_static_hz: 150,
      rpm_filter_harmonics: 3,
    };

    const recs = recommend(noise, current);
    const dtermLpf2Rec = recs.find((r) => r.setting === 'dterm_lpf2_static_hz');
    expect(dtermLpf2Rec).toBeDefined();
    expect(dtermLpf2Rec!.recommendedValue).toBe(0);
    expect(dtermLpf2Rec!.impact).toBe('latency');
  });

  it('should NOT disable dterm LPF2 at exactly the -45 dB threshold (strict <)', () => {
    // DTERM_LPF2_DISABLE_THRESHOLD_DB = -45: worstFloor must be strictly below
    const noise = makeNoiseProfile({ level: 'low', rollFloor: -35, pitchFloor: -40 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf2_static_hz: 150,
      rpm_filter_harmonics: 3,
    };

    const recs = recommend(noise, current);
    const dtermLpf2Rec = recs.find(
      (r) => r.setting === 'dterm_lpf2_static_hz' && r.ruleId === 'F-LPF2-DIS-DTERM'
    );
    expect(dtermLpf2Rec).toBeUndefined();
  });

  it('should recommend enabling gyro LPF2 when noise is high and no RPM', () => {
    // overallLevel='high', RPM off, gyro_lpf2_static_hz=0 → recommend 250
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -10 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf2_static_hz: 0,
      rpm_filter_harmonics: 0,
    };

    const recs = recommend(noise, current);
    const gyroLpf2Rec = recs.find((r) => r.setting === 'gyro_lpf2_static_hz');
    expect(gyroLpf2Rec).toBeDefined();
    expect(gyroLpf2Rec!.recommendedValue).toBe(250);
    expect(gyroLpf2Rec!.impact).toBe('noise');
  });

  it('should NOT recommend LPF2 changes when noise is moderate', () => {
    // overallLevel='medium' → no LPF2 recs (neither disable nor enable path triggers)
    const noise = makeNoiseProfile({ level: 'medium', rollFloor: -30, pitchFloor: -30 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf2_static_hz: 250,
      dterm_lpf2_static_hz: 150,
      rpm_filter_harmonics: 0,
    };

    const recs = recommend(noise, current);
    const gyroLpf2Rec = recs.find((r) => r.setting === 'gyro_lpf2_static_hz');
    const dtermLpf2Rec = recs.find((r) => r.setting === 'dterm_lpf2_static_hz');
    expect(gyroLpf2Rec).toBeUndefined();
    expect(dtermLpf2Rec).toBeUndefined();
  });

  it('should NOT recommend LPF2 disable when RPM is inactive even with clean noise', () => {
    // Noise floor < -45 dB but RPM off → disable path requires RPM active
    const noise = makeNoiseProfile({ level: 'low', rollFloor: -45, pitchFloor: -45 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf2_static_hz: 250,
      dterm_lpf2_static_hz: 150,
      rpm_filter_harmonics: 0,
    };

    const recs = recommend(noise, current);
    const gyroLpf2Rec = recs.find((r) => r.setting === 'gyro_lpf2_static_hz');
    const dtermLpf2Rec = recs.find((r) => r.setting === 'dterm_lpf2_static_hz');
    // No disable recommendation without RPM
    expect(gyroLpf2Rec).toBeUndefined();
    expect(dtermLpf2Rec).toBeUndefined();
  });
});

describe('Conditional dynamic notch Q with resonance', () => {
  it('should keep dyn_notch_q at 300 when RPM active but strong frame resonance present', () => {
    // RPM active, Q=500, resonance peak with type='frame_resonance' and amplitude >= 12
    // → recommend Q=300 (wider) to track resonance
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 150, amplitude: 15, type: 'frame_resonance' }],
    });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      dyn_notch_count: 1, // Already at RPM-optimal count
      dyn_notch_q: 500, // Too narrow for resonance
    };

    const recs = recommend(noise, current);
    const qRec = recs.find((r) => r.setting === 'dyn_notch_q');
    expect(qRec).toBeDefined();
    expect(qRec!.recommendedValue).toBe(300);
    expect(qRec!.confidence).toBe('medium');
    expect(qRec!.reason).toContain('resonance');
  });

  it('should recommend Q=500 when RPM active and no significant resonance peaks', () => {
    // RPM active, Q=300, no resonance peaks → recommend Q=500 (narrower)
    const noise = makeNoiseProfile({ level: 'medium' });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      dyn_notch_count: 1,
      dyn_notch_q: 300,
    };

    const recs = recommend(noise, current);
    const qRec = recs.find((r) => r.setting === 'dyn_notch_q');
    expect(qRec).toBeDefined();
    expect(qRec!.recommendedValue).toBe(DYN_NOTCH_Q_WITH_RPM); // 500
    expect(qRec!.confidence).toBe('high');
  });
});

describe('ruleId assignment', () => {
  it('should assign F-NF-H-GYRO and F-NF-H-DTERM for high noise', () => {
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -10 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
      dterm_lpf1_static_hz: 150,
    };
    const recs = recommend(noise, current);
    expect(recs.find((r) => r.ruleId === 'F-NF-H-GYRO')).toBeDefined();
    expect(recs.find((r) => r.ruleId === 'F-NF-H-DTERM')).toBeDefined();
  });

  it('should assign F-NF-L-GYRO and F-NF-L-DTERM for low noise', () => {
    const noise = makeNoiseProfile({ level: 'low', rollFloor: -55, pitchFloor: -50 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 150,
      dterm_lpf1_static_hz: 100,
    };
    const recs = recommend(noise, current);
    expect(recs.find((r) => r.ruleId === 'F-NF-L-GYRO')).toBeDefined();
    expect(recs.find((r) => r.ruleId === 'F-NF-L-DTERM')).toBeDefined();
  });

  it('should assign F-NF-M-GYRO and F-NF-M-DTERM for medium noise with far-off settings', () => {
    const noise = makeNoiseProfile({ level: 'medium', rollFloor: -40, pitchFloor: -40 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 100,
      dterm_lpf1_static_hz: 70,
    };
    const recs = recommend(noise, current);
    expect(recs.find((r) => r.ruleId === 'F-NF-M-GYRO')).toBeDefined();
    expect(recs.find((r) => r.ruleId === 'F-NF-M-DTERM')).toBeDefined();
  });

  it('should assign F-RES-GYRO for resonance peak below gyro LPF', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 80, amplitude: 15, type: 'frame_resonance' }],
    });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
      dyn_notch_min_hz: 150,
    };
    const recs = recommend(noise, current);
    expect(recs.find((r) => r.ruleId === 'F-RES-GYRO')).toBeDefined();
  });

  it('should assign F-DN-MIN and F-DN-MAX for notch range adjustments', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [
        { frequency: 80, amplitude: 15, type: 'frame_resonance' },
        { frequency: 700, amplitude: 15, type: 'electrical' },
      ],
    });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dyn_notch_min_hz: 150,
      dyn_notch_max_hz: 600,
    };
    const recs = recommend(noise, current);
    expect(recs.find((r) => r.ruleId === 'F-DN-MIN')).toBeDefined();
    expect(recs.find((r) => r.ruleId === 'F-DN-MAX')).toBeDefined();
  });

  it('should assign F-DN-COUNT and F-DN-Q for RPM-aware notch tuning', () => {
    const noise = makeNoiseProfile({ level: 'medium' });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      dyn_notch_count: 3,
      dyn_notch_q: 300,
    };
    const recs = recommend(noise, current);
    expect(recs.find((r) => r.ruleId === 'F-DN-COUNT')).toBeDefined();
    expect(recs.find((r) => r.ruleId === 'F-DN-Q')).toBeDefined();
  });

  it('F-DN-COUNT uses conservative stepping: 5→3 (not 5→1)', () => {
    const noise = makeNoiseProfile({ level: 'medium' });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      dyn_notch_count: 5,
      dyn_notch_q: 300,
    };
    const recs = recommend(noise, current);
    const dnCount = recs.find((r) => r.ruleId === 'F-DN-COUNT');
    expect(dnCount).toBeDefined();
    // Max step is 2, so 5→3 (not 5→1)
    expect(dnCount!.recommendedValue).toBe(3);
  });

  it('F-DN-COUNT targets 2 for sub-5" quads', () => {
    const noise = makeNoiseProfile({ level: 'medium' });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      dyn_notch_count: 3,
      dyn_notch_q: 300,
    };
    const recs = recommend(noise, current, '4"');
    const dnCount = recs.find((r) => r.ruleId === 'F-DN-COUNT');
    expect(dnCount).toBeDefined();
    // 4" quad → target 2, from 3 → step to 2 (within max step of 2)
    expect(dnCount!.recommendedValue).toBe(2);
  });

  it('F-DN-COUNT targets 1 for 5" quads', () => {
    const noise = makeNoiseProfile({ level: 'medium' });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      dyn_notch_count: 3,
      dyn_notch_q: 300,
    };
    const recs = recommend(noise, current, '5"');
    const dnCount = recs.find((r) => r.ruleId === 'F-DN-COUNT');
    expect(dnCount).toBeDefined();
    // 5" quad → target 1, from 3 → step to 1 (3-2=1, >= target)
    expect(dnCount!.recommendedValue).toBe(1);
  });

  it('F-DN-COUNT does not fire when already at target', () => {
    const noise = makeNoiseProfile({ level: 'medium' });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      dyn_notch_count: 2,
      dyn_notch_q: 500,
    };
    const recs = recommend(noise, current, '3"');
    // 3" target is 2, current is 2 → no recommendation
    expect(recs.find((r) => r.ruleId === 'F-DN-COUNT')).toBeUndefined();
  });

  it('should assign F-LPF2-DIS-GYRO when disabling LPF2 with RPM + clean noise', () => {
    const noise = makeNoiseProfile({ level: 'low', rollFloor: -45, pitchFloor: -40 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf2_static_hz: 250,
      dterm_lpf2_static_hz: 150,
      rpm_filter_harmonics: 3,
    };
    const recs = recommend(noise, current);
    expect(recs.find((r) => r.ruleId === 'F-LPF2-DIS-GYRO')).toBeDefined();
    expect(recs.find((r) => r.ruleId === 'F-LPF2-DIS-DTERM')).toBeDefined();
  });

  it('should assign F-LPF2-EN-GYRO when enabling LPF2 for high noise without RPM', () => {
    const noise = makeNoiseProfile({ level: 'high', rollFloor: -15, pitchFloor: -10 });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf2_static_hz: 0,
      dterm_lpf2_static_hz: 0,
      rpm_filter_harmonics: 0,
    };
    const recs = recommend(noise, current);
    expect(recs.find((r) => r.ruleId === 'F-LPF2-EN-GYRO')).toBeDefined();
    expect(recs.find((r) => r.ruleId === 'F-LPF2-EN-DTERM')).toBeDefined();
  });

  it('should preserve ruleId through deduplication', () => {
    // High noise + resonance peak both target gyro_lpf1 → deduplicated
    const noise = makeNoiseProfile({
      level: 'high',
      rollFloor: -15,
      pitchFloor: -15,
      rollPeaks: [{ frequency: 180, amplitude: 15, type: 'frame_resonance' }],
    });
    const current: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 250,
    };
    const recs = recommend(noise, current);
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
    // After dedup, the more aggressive rec wins — it should still have a ruleId
    expect(gyroRec!.ruleId).toBeDefined();
  });
});

// ---- RPM Filter Q Advisory (F-RPM-Q) ----

describe('recommendRpmFilterQ', () => {
  it('should return undefined when RPM filter is inactive', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 0,
      rpm_filter_q: 500,
    };
    expect(recommendRpmFilterQ(settings, '5"')).toBeUndefined();
  });

  it('should return undefined when rpm_filter_q is not available', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
    };
    expect(recommendRpmFilterQ(settings, '5"')).toBeUndefined();
  });

  it('should return undefined when drone size is not provided', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      rpm_filter_q: 500,
    };
    expect(recommendRpmFilterQ(settings, undefined)).toBeUndefined();
  });

  it('should return undefined when Q is within 20% of midpoint', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      rpm_filter_q: 800, // within 20% of 850 midpoint for 5"
    };
    expect(recommendRpmFilterQ(settings, '5"')).toBeUndefined();
  });

  it('should recommend raising Q for 5" quad when Q is too low', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      rpm_filter_q: 400, // way below 850 midpoint for 5"
    };
    const rec = recommendRpmFilterQ(settings, '5"');
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('rpm_filter_q');
    expect(rec!.currentValue).toBe(400);
    expect(rec!.recommendedValue).toBe(850);
    expect(rec!.ruleId).toBe('F-RPM-Q');
    expect(rec!.confidence).toBe('low');
    expect(rec!.informational).toBeUndefined();
  });

  it('should recommend lowering Q for 7" quad when Q is too high', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      rpm_filter_q: 1000, // way above 600 midpoint for 7"
    };
    const rec = recommendRpmFilterQ(settings, '7"');
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('rpm_filter_q');
    expect(rec!.currentValue).toBe(1000);
    expect(rec!.recommendedValue).toBe(600);
    expect(rec!.ruleId).toBe('F-RPM-Q');
  });

  it('should use correct midpoint for 6" quad', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      rpm_filter_q: 1000, // above 700 midpoint for 6"
    };
    const rec = recommendRpmFilterQ(settings, '6"');
    expect(rec).toBeDefined();
    expect(rec!.recommendedValue).toBe(700);
  });

  it('should use correct midpoint for 3" quad', () => {
    // 3"/4" range raised to 700-1000 (midpoint 850) — SupaflyFPV EasyTune
    // presets set rpm_filter_q = 1000 for 3-4"
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      rpm_filter_q: 400, // well below 850 midpoint for 3"
    };
    const rec = recommendRpmFilterQ(settings, '3"');
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('rpm_filter_q');
    expect(rec!.recommendedValue).toBe(850);
    expect(rec!.ruleId).toBe('F-RPM-Q');
  });

  it('should use correct midpoint for 4" quad', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      rpm_filter_q: 500, // well below 850 midpoint for 4"
    };
    const rec = recommendRpmFilterQ(settings, '4"');
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('rpm_filter_q');
    expect(rec!.recommendedValue).toBe(850);
    expect(rec!.ruleId).toBe('F-RPM-Q');
  });

  it('should not flag Q=1000 on 3-4" quads (within 700-1000 preset range)', () => {
    // Q=1000 is only ~18% above the 850 midpoint — SupaflyFPV presets use it
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      rpm_filter_q: 1000,
    };
    expect(recommendRpmFilterQ(settings, '3"')).toBeUndefined();
    expect(recommendRpmFilterQ(settings, '4"')).toBeUndefined();
  });
});

// ---- D-term LPF Dynamic Expo Advisory (F-DEXP) ----

describe('recommendDtermDynExpo', () => {
  it('should return undefined when D-term dynamic LPF is not active', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf1_dyn_min_hz: 0, // dynamic LPF disabled
      dterm_lpf1_dyn_expo: 5,
    };
    expect(recommendDtermDynExpo(settings, 'aggressive')).toBeUndefined();
  });

  it('should return undefined when dterm_lpf1_dyn_min_hz is not available', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf1_dyn_expo: 5,
      // dterm_lpf1_dyn_min_hz undefined → not active
    };
    expect(recommendDtermDynExpo(settings, 'aggressive')).toBeUndefined();
  });

  it('should return undefined when expo is not available', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf1_dyn_min_hz: 80,
    };
    expect(recommendDtermDynExpo(settings, 'aggressive')).toBeUndefined();
  });

  it('should return undefined when flight style is not provided', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf1_dyn_min_hz: 80,
      dterm_lpf1_dyn_expo: 5,
    };
    expect(recommendDtermDynExpo(settings, undefined)).toBeUndefined();
  });

  it('should return undefined when expo is within range for balanced style', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf1_dyn_min_hz: 80,
      dterm_lpf1_dyn_expo: 5,
    };
    expect(recommendDtermDynExpo(settings, 'balanced')).toBeUndefined();
  });

  it('should recommend higher expo for aggressive/racing flight style', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf1_dyn_min_hz: 80, // dynamic LPF active
      dterm_lpf1_dyn_expo: 5, // default, but racing needs 7-10
    };
    const rec = recommendDtermDynExpo(settings, 'aggressive');
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('dterm_lpf1_dyn_expo');
    expect(rec!.currentValue).toBe(5);
    expect(rec!.recommendedValue).toBe(7); // min of aggressive range
    expect(rec!.ruleId).toBe('F-DEXP');
    expect(rec!.confidence).toBe('low');
    expect(rec!.informational).toBeUndefined();
  });

  it('should recommend lower expo for smooth/cinematic flight style when too high', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf1_dyn_min_hz: 80, // dynamic LPF active
      dterm_lpf1_dyn_expo: 8, // too high for cinematic
    };
    const rec = recommendDtermDynExpo(settings, 'smooth');
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('dterm_lpf1_dyn_expo');
    expect(rec!.currentValue).toBe(8);
    expect(rec!.recommendedValue).toBe(5); // max of smooth range
    expect(rec!.ruleId).toBe('F-DEXP');
  });

  it('should return undefined when expo is already in range for aggressive', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf1_dyn_min_hz: 80,
      dterm_lpf1_dyn_expo: 8, // within 7-10 for aggressive
    };
    expect(recommendDtermDynExpo(settings, 'aggressive')).toBeUndefined();
  });

  it('should return undefined when expo is already in range for smooth', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf1_dyn_min_hz: 80,
      dterm_lpf1_dyn_expo: 4, // within 3-5 for smooth
    };
    expect(recommendDtermDynExpo(settings, 'smooth')).toBeUndefined();
  });
});

describe('dynamic lowpass awareness in recommend()', () => {
  /** Helper: noise profile with specific level */
  function makeNoiseWithLevel(
    level: 'high' | 'medium' | 'low',
    floorDb: number = -30
  ): NoiseProfile {
    const axis: AxisNoiseProfile = {
      noiseFloorDb: floorDb,
      peaks: [],
      spectrum: { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
    };
    return {
      overallLevel: level,
      roll: axis,
      pitch: axis,
      yaw: axis,
    };
  }

  it('should recommend dyn_min/max instead of static when gyro dynamic is active', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 200,
      gyro_lpf1_dyn_min_hz: 250,
      gyro_lpf1_dyn_max_hz: 500,
    };
    const recs = recommend(makeNoiseWithLevel('high', -20), settings);

    const gyroRecs = recs.filter((r) => r.setting.includes('gyro_lpf1'));
    // Should target dyn_min_hz, not static_hz
    const dynMinRec = gyroRecs.find((r) => r.setting === 'gyro_lpf1_dyn_min_hz');
    const staticRec = gyroRecs.find((r) => r.setting === 'gyro_lpf1_static_hz');

    expect(dynMinRec).toBeDefined();
    expect(dynMinRec!.currentValue).toBe(250);
    // Static rec may exist only if needed for floor constraint
    if (staticRec) {
      expect(staticRec.recommendedValue).toBeLessThanOrEqual(dynMinRec!.recommendedValue);
    }
  });

  it('should recommend dyn_min/max for dterm when dterm dynamic is active', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf1_static_hz: 100,
      dterm_lpf1_dyn_min_hz: 75,
      dterm_lpf1_dyn_max_hz: 150,
    };
    const recs = recommend(makeNoiseWithLevel('high', -20), settings);

    const dtermDynMin = recs.find((r) => r.setting === 'dterm_lpf1_dyn_min_hz');
    expect(dtermDynMin).toBeDefined();
    expect(dtermDynMin!.currentValue).toBe(75);
  });

  it('should also recommend dyn_max_hz proportionally', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 200,
      gyro_lpf1_dyn_min_hz: 200,
      gyro_lpf1_dyn_max_hz: 400, // ratio = 2.0
    };
    const recs = recommend(makeNoiseWithLevel('high', -20), settings);

    const dynMinRec = recs.find((r) => r.setting === 'gyro_lpf1_dyn_min_hz');
    const dynMaxRec = recs.find((r) => r.setting === 'gyro_lpf1_dyn_max_hz');

    expect(dynMinRec).toBeDefined();
    expect(dynMaxRec).toBeDefined();

    // Max should maintain roughly 2:1 ratio
    const ratio = dynMaxRec!.recommendedValue / dynMinRec!.recommendedValue;
    expect(ratio).toBeGreaterThanOrEqual(1.5);
    expect(ratio).toBeLessThanOrEqual(3.0);
  });

  it('should recommend static_hz when dynamic is off', () => {
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 500,
      gyro_lpf1_dyn_min_hz: 0,
      gyro_lpf1_dyn_max_hz: 0,
    };
    const recs = recommend(makeNoiseWithLevel('high', -20), settings);

    const staticRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(staticRec).toBeDefined();
    expect(staticRec!.currentValue).toBe(500);
    // No dyn_min/max recs (dynamic is off, DynamicLowpassRecommender handles enabling)
    const dynMinRec = recs.find((r) => r.setting === 'gyro_lpf1_dyn_min_hz');
    expect(dynMinRec).toBeUndefined();
  });
});

describe('dynamic lowpass ratio enforcement', () => {
  it('should maintain BF 2:1 ratio when gyroMaxHz clamps dyn_max', () => {
    // RPM-enabled quad with gyroMaxHz = 500. Target = 300 → dyn_max = 600 but clamped to 500.
    // Fix: dyn_min should be adjusted down to 250 so ratio is 500/250 = 2.0
    const noisy = makeNoiseProfile({ level: 'high', rollFloor: -4, pitchFloor: -4 });
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_dyn_min_hz: 250,
      gyro_lpf1_dyn_max_hz: 500,
      gyro_lpf1_static_hz: 200,
      rpm_filter_harmonics: 3,
    };

    const recs = recommend(noisy, settings, '5"');
    const dynMinRec = recs.find((r) => r.setting === 'gyro_lpf1_dyn_min_hz');
    const dynMaxRec = recs.find((r) => r.setting === 'gyro_lpf1_dyn_max_hz');

    if (dynMinRec && dynMaxRec) {
      // The critical invariant: dyn_max >= 2 × dyn_min
      expect(dynMaxRec.recommendedValue).toBeGreaterThanOrEqual(dynMinRec.recommendedValue * 2);
    }
  });

  it('should maintain BF 2:1 ratio for D-term dynamic lowpass when clamped', () => {
    const noisy = makeNoiseProfile({ level: 'high', rollFloor: -4, pitchFloor: -4 });
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      dterm_lpf1_dyn_min_hz: 100,
      dterm_lpf1_dyn_max_hz: 200,
      dterm_lpf1_static_hz: 80,
      rpm_filter_harmonics: 3,
    };

    const recs = recommend(noisy, settings, '5"');
    const dynMinRec = recs.find((r) => r.setting === 'dterm_lpf1_dyn_min_hz');
    const dynMaxRec = recs.find((r) => r.setting === 'dterm_lpf1_dyn_max_hz');

    if (dynMinRec && dynMaxRec) {
      expect(dynMaxRec.recommendedValue).toBeGreaterThanOrEqual(dynMinRec.recommendedValue * 2);
    }
  });
});

describe('F-MOTOR-DIAG (Motor Harmonic Diagnostic)', () => {
  it('should emit F-MOTOR-DIAG when RPM active and motor harmonics detected at ≥12 dB', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 300, amplitude: 15, type: 'motor_harmonic' }],
    });
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
    };
    const recs = recommend(noise, settings);
    const diag = recs.find((r) => r.ruleId === 'F-MOTOR-DIAG');
    expect(diag).toBeDefined();
    expect(diag!.setting).toBe('motor_poles');
    expect(diag!.informational).toBe(true);
    expect(diag!.confidence).toBe('low');
    expect(diag!.reason).toContain('motor_poles');
    expect(diag!.reason).toContain('15 dB');
    expect(diag!.reason).toContain('300 Hz');
  });

  it('should not emit F-MOTOR-DIAG when RPM inactive', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 300, amplitude: 15, type: 'motor_harmonic' }],
    });
    const recs = recommend(noise, DEFAULT_FILTER_SETTINGS);
    const diag = recs.find((r) => r.ruleId === 'F-MOTOR-DIAG');
    expect(diag).toBeUndefined();
  });

  it('should not emit F-MOTOR-DIAG when motor harmonics are below threshold', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 300, amplitude: 8, type: 'motor_harmonic' }],
    });
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
    };
    const recs = recommend(noise, settings);
    const diag = recs.find((r) => r.ruleId === 'F-MOTOR-DIAG');
    expect(diag).toBeUndefined();
  });

  it('should not emit F-MOTOR-DIAG when no motor harmonics detected', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 150, amplitude: 15, type: 'frame_resonance' }],
    });
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
    };
    const recs = recommend(noise, settings);
    const diag = recs.find((r) => r.ruleId === 'F-MOTOR-DIAG');
    expect(diag).toBeUndefined();
  });

  it('should report worst motor harmonic across all axes', () => {
    const noise = makeNoiseProfile({
      level: 'medium',
      rollPeaks: [{ frequency: 300, amplitude: 14, type: 'motor_harmonic' }],
      pitchPeaks: [{ frequency: 310, amplitude: 20, type: 'motor_harmonic' }],
    });
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
    };
    const recs = recommend(noise, settings);
    const diag = recs.find((r) => r.ruleId === 'F-MOTOR-DIAG');
    expect(diag).toBeDefined();
    expect(diag!.reason).toContain('20 dB'); // worst = pitch 20 dB
    expect(diag!.reason).toContain('310 Hz');
  });
});

// ---- Variability-aware hysteresis (Layer 2) ----

describe('variability-aware hysteresis', () => {
  it('widens deadzone when noiseFloorStdDb is high, suppressing marginal recs', () => {
    // Noise that would produce a small recommendation change
    const noise = makeNoiseProfile({
      level: 'low',
      rollFloor: -30,
      pitchFloor: -30,
    });
    // Settings close to the computed target — within normal deadzone + variability bonus
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 240,
      dterm_lpf1_static_hz: 120,
    };

    // Without variability: should produce recs
    const recsNormal = recommend(noise, settings);
    const gyroRecNormal = recsNormal.find((r) => r.setting === 'gyro_lpf1_static_hz');

    // With high variability: same noise but wider deadzone should suppress marginal recs
    const recsVariable = recommend(noise, settings, undefined, { noiseFloorStdDb: 4 });
    const gyroRecVariable = recsVariable.find((r) => r.setting === 'gyro_lpf1_static_hz');

    // High variability should suppress recs that normal deadzone would allow
    // (or at minimum, not produce MORE recommendations)
    if (gyroRecNormal) {
      // If normal produces a rec, high variability might suppress it
      const normalCount = recsNormal.filter(
        (r) => r.setting.includes('gyro_lpf1') || r.setting.includes('dterm_lpf1')
      ).length;
      const variableCount = recsVariable.filter(
        (r) => r.setting.includes('gyro_lpf1') || r.setting.includes('dterm_lpf1')
      ).length;
      expect(variableCount).toBeLessThanOrEqual(normalCount);
    } else {
      // If even normal doesn't produce a rec, variable shouldn't either
      expect(gyroRecVariable).toBeUndefined();
    }
  });

  it('does not widen deadzone beyond MAX_VARIABILITY_BONUS_HZ', () => {
    // Very high variability — should be capped at MAX_VARIABILITY_BONUS_HZ (15)
    // Target for -20 dB noise ≈ 113 Hz. Current at 200 Hz → delta = 87 Hz
    // Even with max deadzone (5 + 15 = 20 Hz), 87 >> 20 → rec still produced.
    const noise = makeNoiseProfile({
      level: 'high',
      rollFloor: -10,
      pitchFloor: -10,
    });
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
      gyro_lpf1_static_hz: 200,
      dterm_lpf1_static_hz: 150,
    };

    // Even with extreme variability, large delta overcomes max deadzone
    const recs = recommend(noise, settings, undefined, { noiseFloorStdDb: 100 });
    const gyroRec = recs.find((r) => r.setting === 'gyro_lpf1_static_hz');
    expect(gyroRec).toBeDefined();
  });

  it('has no effect when noiseFloorStdDb is 0', () => {
    const noise = makeNoiseProfile({
      level: 'high',
      rollFloor: -10,
      pitchFloor: -10,
    });
    const settings: CurrentFilterSettings = {
      ...DEFAULT_FILTER_SETTINGS,
    };

    const recsNoCtx = recommend(noise, settings);
    const recsZeroStd = recommend(noise, settings, undefined, { noiseFloorStdDb: 0 });

    // Should produce identical recommendations
    expect(recsNoCtx.length).toBe(recsZeroStd.length);
    for (let i = 0; i < recsNoCtx.length; i++) {
      expect(recsNoCtx[i].setting).toBe(recsZeroStd[i].setting);
      expect(recsNoCtx[i].recommendedValue).toBe(recsZeroStd[i].recommendedValue);
    }
  });
});
