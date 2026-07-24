import { describe, it, expect } from 'vitest';
import { recommendRpmFilterTuning } from './RpmFilterRecommender';
import type { NoiseProfile, NoisePeak, CurrentFilterSettings } from '@shared/types/analysis.types';
import { DEFAULT_FILTER_SETTINGS } from '@shared/types/analysis.types';

function makeProfile(peaks: NoisePeak[]): NoiseProfile {
  const axis = (axisPeaks: NoisePeak[]) => ({
    spectrum: { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
    noiseFloorDb: -30,
    peaks: axisPeaks,
  });
  return {
    roll: axis(peaks),
    pitch: axis([]),
    yaw: axis([]),
    overallLevel: 'medium',
  };
}

function trackedMotorPeak(medianHz: number, amplitude: number, spreadHz = 40): NoisePeak {
  // Track rising with throttle around the median
  const frequencyHz = [medianHz - spreadHz, medianHz - spreadHz / 2, medianHz, medianHz + spreadHz];
  return {
    frequency: medianHz,
    amplitude,
    type: 'motor_harmonic',
    classifiedBy: 'throttle_track',
    throttleTrack: { throttleMid: [20, 40, 60, 80], frequencyHz },
  };
}

function settings(overrides: Partial<CurrentFilterSettings>): CurrentFilterSettings {
  return {
    ...DEFAULT_FILTER_SETTINGS,
    rpm_filter_harmonics: 3,
    rpm_filter_min_hz: 100,
    ...overrides,
  };
}

describe('recommendRpmFilterTuning', () => {
  it('returns nothing when RPM filter is inactive', () => {
    const recs = recommendRpmFilterTuning(
      makeProfile([trackedMotorPeak(200, 20)]),
      settings({ rpm_filter_harmonics: 0, dyn_idle_min_rpm: 30 })
    );
    expect(recs).toHaveLength(0);
  });

  describe('F-RPM-MIN-IDLE (dynamic idle floor)', () => {
    it('lowers min_hz when the floor sits above the idle fundamental', () => {
      // dyn_idle 30 → 3000 RPM → 50 Hz fundamental; min_hz 100 leaves a 50-100 Hz gap
      const recs = recommendRpmFilterTuning(
        makeProfile([]),
        settings({ rpm_filter_min_hz: 100, dyn_idle_min_rpm: 30 })
      );
      const rec = recs.find((r) => r.ruleId === 'F-RPM-MIN-IDLE');
      expect(rec).toBeDefined();
      expect(rec!.setting).toBe('rpm_filter_min_hz');
      expect(rec!.recommendedValue).toBe(45); // round(50 × 0.9)
      expect(rec!.impact).toBe('noise');
      expect(rec!.confidence).toBe('medium');
    });

    it('raises min_hz when the floor sits far below the idle fundamental', () => {
      // dyn_idle 80 → 8000 RPM → 133 Hz fundamental; min_hz 50 wastes low notching
      const recs = recommendRpmFilterTuning(
        makeProfile([]),
        settings({ rpm_filter_min_hz: 50, dyn_idle_min_rpm: 80 })
      );
      const rec = recs.find((r) => r.ruleId === 'F-RPM-MIN-IDLE');
      expect(rec).toBeDefined();
      expect(rec!.recommendedValue).toBe(120); // round(133.3 × 0.9)
      expect(rec!.impact).toBe('latency');
      expect(rec!.confidence).toBe('low');
    });

    it('stays silent inside the deadzone', () => {
      // dyn_idle 65 → 108 Hz → target 98; current 100 is within 15 Hz
      const recs = recommendRpmFilterTuning(
        makeProfile([]),
        settings({ rpm_filter_min_hz: 100, dyn_idle_min_rpm: 65 })
      );
      expect(recs.find((r) => r.setting === 'rpm_filter_min_hz')).toBeUndefined();
    });

    it('clamps the target to the house floor', () => {
      // dyn_idle 20 → 2000 RPM → 33 Hz → target 30 → clamped to 40
      const recs = recommendRpmFilterTuning(
        makeProfile([]),
        settings({ rpm_filter_min_hz: 100, dyn_idle_min_rpm: 20 })
      );
      const rec = recs.find((r) => r.ruleId === 'F-RPM-MIN-IDLE');
      expect(rec).toBeDefined();
      expect(rec!.recommendedValue).toBe(40);
    });
  });

  describe('F-RPM-MIN-TRACK (measured fundamental, no dyn idle)', () => {
    it('lowers min_hz when the measured fundamental dips below the floor', () => {
      // Fundamental track reaches 60 Hz; floor at 100 leaves it uncovered
      const fundamental = trackedMotorPeak(100, 20, 40); // min track = 60 Hz
      const recs = recommendRpmFilterTuning(
        makeProfile([fundamental]),
        settings({ rpm_filter_min_hz: 100 })
      );
      const rec = recs.find((r) => r.ruleId === 'F-RPM-MIN-TRACK');
      expect(rec).toBeDefined();
      expect(rec!.recommendedValue).toBe(54); // round(60 × 0.9)
      expect(rec!.impact).toBe('noise');
    });

    it('never raises min_hz from track data alone', () => {
      // Track never goes below 160 Hz — but the flight may not have hit low throttle
      const recs = recommendRpmFilterTuning(
        makeProfile([trackedMotorPeak(200, 20)]),
        settings({ rpm_filter_min_hz: 100 })
      );
      expect(recs.find((r) => r.setting === 'rpm_filter_min_hz')).toBeUndefined();
    });

    it('prefers the dynamic-idle rule when both sources are present', () => {
      const fundamental = trackedMotorPeak(100, 20, 40);
      const recs = recommendRpmFilterTuning(
        makeProfile([fundamental]),
        settings({ rpm_filter_min_hz: 100, dyn_idle_min_rpm: 30 })
      );
      expect(recs.find((r) => r.ruleId === 'F-RPM-MIN-TRACK')).toBeUndefined();
      expect(recs.find((r) => r.ruleId === 'F-RPM-MIN-IDLE')).toBeDefined();
    });
  });

  describe('F-RPM-HARM-UP (harmonic order from measured tracks)', () => {
    it('raises harmonics when a 2× track is measured with harmonics = 1', () => {
      const recs = recommendRpmFilterTuning(
        makeProfile([trackedMotorPeak(200, 20), trackedMotorPeak(400, 15)]),
        settings({ rpm_filter_harmonics: 1 })
      );
      const rec = recs.find((r) => r.ruleId === 'F-RPM-HARM-UP');
      expect(rec).toBeDefined();
      expect(rec!.setting).toBe('rpm_filter_harmonics');
      expect(rec!.recommendedValue).toBe(2);
      expect(rec!.confidence).toBe('medium');
    });

    it('raises harmonics to 3 when a 3× track is measured with harmonics = 2', () => {
      const recs = recommendRpmFilterTuning(
        makeProfile([trackedMotorPeak(200, 20), trackedMotorPeak(600, 14)]),
        settings({ rpm_filter_harmonics: 2 })
      );
      const rec = recs.find((r) => r.ruleId === 'F-RPM-HARM-UP');
      expect(rec).toBeDefined();
      expect(rec!.recommendedValue).toBe(3);
    });

    it('ignores tracks with a non-integer frequency ratio', () => {
      // 200 → 520: ratio 2.6, neither 2× nor 3×
      const recs = recommendRpmFilterTuning(
        makeProfile([trackedMotorPeak(200, 20), trackedMotorPeak(520, 15)]),
        settings({ rpm_filter_harmonics: 1 })
      );
      expect(recs.find((r) => r.ruleId === 'F-RPM-HARM-UP')).toBeUndefined();
    });

    it('ignores weak residual harmonics below the action threshold', () => {
      const recs = recommendRpmFilterTuning(
        makeProfile([trackedMotorPeak(200, 20), trackedMotorPeak(400, 8)]),
        settings({ rpm_filter_harmonics: 1 })
      );
      expect(recs.find((r) => r.ruleId === 'F-RPM-HARM-UP')).toBeUndefined();
    });

    it('never fires when harmonics are already at maximum', () => {
      const recs = recommendRpmFilterTuning(
        makeProfile([trackedMotorPeak(200, 20), trackedMotorPeak(400, 15)]),
        settings({ rpm_filter_harmonics: 3 })
      );
      expect(recs.find((r) => r.ruleId === 'F-RPM-HARM-UP')).toBeUndefined();
    });
  });

  describe('F-RPM-FADE', () => {
    it('recommends the BF default fade when fade is disabled', () => {
      const recs = recommendRpmFilterTuning(
        makeProfile([]),
        settings({ rpm_filter_fade_range_hz: 0 })
      );
      const rec = recs.find((r) => r.ruleId === 'F-RPM-FADE');
      expect(rec).toBeDefined();
      expect(rec!.recommendedValue).toBe(50);
      expect(rec!.informational).toBe(true);
    });

    it('stays silent when fade is unknown or already set', () => {
      expect(
        recommendRpmFilterTuning(makeProfile([]), settings({})).find(
          (r) => r.ruleId === 'F-RPM-FADE'
        )
      ).toBeUndefined();
      expect(
        recommendRpmFilterTuning(makeProfile([]), settings({ rpm_filter_fade_range_hz: 50 })).find(
          (r) => r.ruleId === 'F-RPM-FADE'
        )
      ).toBeUndefined();
    });
  });

  describe('F-RPM-WEIGHTS (BF 4.5+ advisory)', () => {
    it('suggests size-appropriate weights when all are at full depth', () => {
      const recs = recommendRpmFilterTuning(
        makeProfile([]),
        settings({ rpm_filter_weights: [100, 100, 100] }),
        '5"'
      );
      const rec = recs.find((r) => r.ruleId === 'F-RPM-WEIGHTS');
      expect(rec).toBeDefined();
      expect(rec!.informational).toBe(true);
      expect(rec!.reason).toContain('90,50,90');
    });

    it('stays silent when weights are customized, absent, or size unknown', () => {
      expect(
        recommendRpmFilterTuning(
          makeProfile([]),
          settings({ rpm_filter_weights: [100, 50, 100] }),
          '5"'
        ).find((r) => r.ruleId === 'F-RPM-WEIGHTS')
      ).toBeUndefined();
      expect(
        recommendRpmFilterTuning(makeProfile([]), settings({}), '5"').find(
          (r) => r.ruleId === 'F-RPM-WEIGHTS'
        )
      ).toBeUndefined();
      expect(
        recommendRpmFilterTuning(
          makeProfile([]),
          settings({ rpm_filter_weights: [100, 100, 100] })
        ).find((r) => r.ruleId === 'F-RPM-WEIGHTS')
      ).toBeUndefined();
    });
  });

  it('deduplicates the same harmonic source seen on multiple axes', () => {
    const fundamental = trackedMotorPeak(200, 20);
    const second = trackedMotorPeak(400, 15);
    const profile = makeProfile([fundamental, second]);
    // Same physical peaks also visible on pitch
    profile.pitch.peaks = [
      { ...fundamental, amplitude: 18 },
      { ...second, amplitude: 13 },
    ];
    const recs = recommendRpmFilterTuning(profile, settings({ rpm_filter_harmonics: 1 }));
    const harmRecs = recs.filter((r) => r.ruleId === 'F-RPM-HARM-UP');
    expect(harmRecs).toHaveLength(1);
  });
});
