import { describe, it, expect } from 'vitest';
import {
  analyzeDynamicLowpass,
  recommendDynamicLowpass,
  DYNAMIC_LOWPASS_NOISE_INCREASE_DB,
  DYNAMIC_LOWPASS_MIN_CORRELATION,
  DYNAMIC_LOWPASS_DISABLE_DB,
} from './DynamicLowpassRecommender';
import { DYNAMIC_LOWPASS_RATIO } from './constants';
import type { ThrottleSpectrogramResult, ThrottleBand } from '@shared/types/analysis.types';

function makeBand(
  throttleMin: number,
  throttleMax: number,
  noiseFloorDb: [number, number, number]
): ThrottleBand {
  return {
    throttleMin,
    throttleMax,
    sampleCount: 5000,
    noiseFloorDb,
  };
}

function makeSpectrogram(bands: ThrottleBand[]): ThrottleSpectrogramResult {
  return {
    bands,
    numBands: bands.length,
    minSamplesPerBand: 1000,
    bandsWithData: bands.filter((b) => b.noiseFloorDb).length,
  };
}

const recommendedAnalysis = {
  recommended: true,
  noiseIncreaseDeltaDb: 10,
  throttleNoiseCorrelation: 0.9,
  bandsAnalyzed: 5,
  summary: 'Dynamic lowpass recommended.',
};

const notRecommendedAnalysis = {
  recommended: false,
  noiseIncreaseDeltaDb: 3,
  throttleNoiseCorrelation: 0.3,
  bandsAnalyzed: 5,
  summary: 'Static lowpass is appropriate.',
};

/** Helper: create settings with static-only config (dynamic off) */
function staticSettings(gyro: number, dterm: number = 0) {
  return {
    gyro_lpf1_static_hz: gyro,
    gyro_lpf1_dyn_min_hz: 0,
    gyro_lpf1_dyn_max_hz: 0,
    dterm_lpf1_static_hz: dterm,
    dterm_lpf1_dyn_min_hz: 0,
    dterm_lpf1_dyn_max_hz: 0,
  };
}

/** Helper: create settings with dynamic already active */
function dynamicSettings(
  gyroMin: number,
  gyroMax: number,
  dtermMin: number = 0,
  dtermMax: number = 0
) {
  return {
    gyro_lpf1_static_hz: Math.min(gyroMin, 250),
    gyro_lpf1_dyn_min_hz: gyroMin,
    gyro_lpf1_dyn_max_hz: gyroMax,
    dterm_lpf1_static_hz: dtermMin > 0 ? Math.min(dtermMin, 150) : 150,
    dterm_lpf1_dyn_min_hz: dtermMin,
    dterm_lpf1_dyn_max_hz: dtermMax,
  };
}

describe('analyzeDynamicLowpass', () => {
  it('should return undefined for undefined spectrogram', () => {
    expect(analyzeDynamicLowpass(undefined)).toBeUndefined();
  });

  it('should return undefined for insufficient bands', () => {
    const spec = makeSpectrogram([
      makeBand(0.0, 0.2, [-40, -40, -30]),
      makeBand(0.2, 0.4, [-35, -35, -25]),
    ]);
    expect(analyzeDynamicLowpass(spec)).toBeUndefined();
  });

  it('should recommend dynamic lowpass when noise increases with throttle', () => {
    const spec = makeSpectrogram([
      makeBand(0.0, 0.2, [-50, -50, -40]),
      makeBand(0.2, 0.4, [-45, -45, -35]),
      makeBand(0.4, 0.6, [-40, -40, -30]),
      makeBand(0.6, 0.8, [-35, -35, -25]),
      makeBand(0.8, 1.0, [-30, -30, -20]),
    ]);
    const result = analyzeDynamicLowpass(spec);

    expect(result).toBeDefined();
    expect(result!.recommended).toBe(true);
    expect(result!.noiseIncreaseDeltaDb).toBeGreaterThanOrEqual(DYNAMIC_LOWPASS_NOISE_INCREASE_DB);
    expect(result!.throttleNoiseCorrelation).toBeGreaterThanOrEqual(
      DYNAMIC_LOWPASS_MIN_CORRELATION
    );
    expect(result!.summary).toContain('Dynamic lowpass recommended');
  });

  it('should not recommend when noise is flat across throttle', () => {
    const spec = makeSpectrogram([
      makeBand(0.0, 0.2, [-40, -40, -30]),
      makeBand(0.2, 0.4, [-40, -41, -31]),
      makeBand(0.4, 0.6, [-41, -40, -30]),
      makeBand(0.6, 0.8, [-40, -40, -30]),
      makeBand(0.8, 1.0, [-41, -40, -31]),
    ]);
    const result = analyzeDynamicLowpass(spec);

    expect(result).toBeDefined();
    expect(result!.recommended).toBe(false);
    expect(result!.summary).toContain('Static lowpass is appropriate');
  });

  it('should not recommend when noise increase is below threshold', () => {
    const spec = makeSpectrogram([
      makeBand(0.0, 0.3, [-42, -42, -35]),
      makeBand(0.3, 0.6, [-40, -40, -33]),
      makeBand(0.6, 1.0, [-38, -38, -31]),
    ]);
    const result = analyzeDynamicLowpass(spec);

    expect(result).toBeDefined();
    expect(result!.noiseIncreaseDeltaDb).toBeLessThan(DYNAMIC_LOWPASS_NOISE_INCREASE_DB);
    expect(result!.recommended).toBe(false);
  });

  it('should use average of roll and pitch, excluding yaw', () => {
    const spec = makeSpectrogram([
      makeBand(0.0, 0.2, [-40, -40, -10]),
      makeBand(0.2, 0.4, [-40, -40, -15]),
      makeBand(0.4, 0.6, [-40, -40, -20]),
      makeBand(0.6, 0.8, [-40, -40, -25]),
    ]);
    const result = analyzeDynamicLowpass(spec);

    expect(result).toBeDefined();
    expect(result!.recommended).toBe(false);
  });

  it('should correctly report bands analyzed', () => {
    const spec = makeSpectrogram([
      makeBand(0.0, 0.25, [-50, -50, -40]),
      makeBand(0.25, 0.5, [-45, -45, -35]),
      makeBand(0.5, 0.75, [-38, -38, -28]),
      makeBand(0.75, 1.0, [-30, -30, -20]),
    ]);
    const result = analyzeDynamicLowpass(spec);

    expect(result).toBeDefined();
    expect(result!.bandsAnalyzed).toBe(4);
  });

  it('should skip bands without noise floor data', () => {
    const spec = makeSpectrogram([
      makeBand(0.0, 0.2, [-50, -50, -40]),
      { throttleMin: 0.2, throttleMax: 0.4, sampleCount: 10 }, // No data
      makeBand(0.4, 0.6, [-40, -40, -30]),
      makeBand(0.6, 0.8, [-35, -35, -25]),
      makeBand(0.8, 1.0, [-30, -30, -20]),
    ]);
    const result = analyzeDynamicLowpass(spec);

    expect(result).toBeDefined();
    expect(result!.bandsAnalyzed).toBe(4);
  });
});

describe('recommendDynamicLowpass', () => {
  it('should return empty array when analysis is undefined', () => {
    expect(recommendDynamicLowpass(undefined, staticSettings(250))).toEqual([]);
  });

  it('should return empty array when not recommended and dynamic is off', () => {
    expect(recommendDynamicLowpass(notRecommendedAnalysis, staticSettings(250))).toEqual([]);
  });

  it('should return empty array when gyro LPF1 is disabled', () => {
    expect(recommendDynamicLowpass(recommendedAnalysis, staticSettings(0))).toEqual([]);
  });

  it('should generate min and max with BF 2:1 ratio when dynamic is off', () => {
    const recs = recommendDynamicLowpass(recommendedAnalysis, staticSettings(250));

    expect(recs).toHaveLength(2);
    expect(recs[0].setting).toBe('gyro_lpf1_dyn_min_hz');
    expect(recs[0].currentValue).toBe(0);
    expect(recs[0].recommendedValue).toBe(250); // dyn_min = static (BF convention)
    expect(recs[1].setting).toBe('gyro_lpf1_dyn_max_hz');
    expect(recs[1].recommendedValue).toBe(500); // dyn_max = static × 2 (BF 2:1 ratio)
  });

  it('should scale recommendations based on current static LPF1 value', () => {
    const recs = recommendDynamicLowpass(recommendedAnalysis, staticSettings(200));

    expect(recs[0].recommendedValue).toBe(200); // dyn_min = static
    expect(recs[1].recommendedValue).toBe(400); // dyn_max = static × 2
  });

  it('should include D-term dynamic lowpass when dterm LPF1 is provided', () => {
    const recs = recommendDynamicLowpass(recommendedAnalysis, staticSettings(250, 150));

    expect(recs).toHaveLength(4);
    expect(recs[0].setting).toBe('gyro_lpf1_dyn_min_hz');
    expect(recs[0].recommendedValue).toBe(250); // dyn_min = static
    expect(recs[1].setting).toBe('gyro_lpf1_dyn_max_hz');
    expect(recs[1].recommendedValue).toBe(500); // dyn_max = static × 2
    expect(recs[2].setting).toBe('dterm_lpf1_dyn_min_hz');
    expect(recs[2].recommendedValue).toBe(150); // dyn_min = static
    expect(recs[3].setting).toBe('dterm_lpf1_dyn_max_hz');
    expect(recs[3].recommendedValue).toBe(300); // dyn_max = static × 2
  });

  it('should skip D-term dynamic lowpass when dterm LPF1 is 0', () => {
    const recs = recommendDynamicLowpass(recommendedAnalysis, staticSettings(250, 0));

    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.setting.startsWith('gyro_'))).toBe(true);
  });

  it('should skip when both gyro and dterm dynamic are already active', () => {
    const recs = recommendDynamicLowpass(recommendedAnalysis, dynamicSettings(200, 500, 100, 250));

    // Both already active → FilterRecommender handles tuning
    expect(recs).toHaveLength(0);
  });

  it('should recommend enabling dterm dynamic when only gyro is active', () => {
    const settings = {
      gyro_lpf1_static_hz: 200,
      gyro_lpf1_dyn_min_hz: 200,
      gyro_lpf1_dyn_max_hz: 500,
      dterm_lpf1_static_hz: 150,
      dterm_lpf1_dyn_min_hz: 0,
      dterm_lpf1_dyn_max_hz: 0,
    };
    const recs = recommendDynamicLowpass(recommendedAnalysis, settings);

    // Only dterm recs (gyro already dynamic)
    expect(recs).toHaveLength(2);
    expect(recs[0].setting).toBe('dterm_lpf1_dyn_min_hz');
    expect(recs[1].setting).toBe('dterm_lpf1_dyn_max_hz');
  });

  it('should recommend disabling dynamic when no throttle-dependent noise', () => {
    const recs = recommendDynamicLowpass(
      notRecommendedAnalysis,
      dynamicSettings(200, 500, 100, 250)
    );

    // Both active but no throttle noise (delta 3 dB < 4 dB disable threshold)
    // → recommend disabling (min + max for each)
    expect(recs).toHaveLength(4);
    expect(recs[0].setting).toBe('gyro_lpf1_dyn_min_hz');
    expect(recs[0].recommendedValue).toBe(0);
    expect(recs[1].setting).toBe('gyro_lpf1_dyn_max_hz');
    expect(recs[1].recommendedValue).toBe(0);
    expect(recs[2].setting).toBe('dterm_lpf1_dyn_min_hz');
    expect(recs[2].recommendedValue).toBe(0);
    expect(recs[3].setting).toBe('dterm_lpf1_dyn_max_hz');
    expect(recs[3].recommendedValue).toBe(0);
  });

  describe('disable hysteresis (DYNAMIC_LOWPASS_DISABLE_DB = 4)', () => {
    it('exposes a disable threshold below the 6 dB enable threshold', () => {
      expect(DYNAMIC_LOWPASS_DISABLE_DB).toBe(4);
      expect(DYNAMIC_LOWPASS_DISABLE_DB).toBeLessThan(DYNAMIC_LOWPASS_NOISE_INCREASE_DB);
    });

    it('does NOT recommend disabling in the 4-6 dB gray zone (delta 5 dB)', () => {
      // Not recommended for enable (5 < 6) but ≥ disable threshold (4) → leave config
      const grayZoneAnalysis = {
        recommended: false,
        noiseIncreaseDeltaDb: 5,
        throttleNoiseCorrelation: 0.9,
        bandsAnalyzed: 5,
        summary: 'Static lowpass is appropriate.',
      };
      const recs = recommendDynamicLowpass(grayZoneAnalysis, dynamicSettings(200, 500, 100, 250));
      expect(recs).toHaveLength(0);
    });

    it('does NOT recommend disabling at exactly 4 dB (boundary stays untouched)', () => {
      const boundaryAnalysis = {
        recommended: false,
        noiseIncreaseDeltaDb: 4,
        throttleNoiseCorrelation: 0.5,
        bandsAnalyzed: 5,
        summary: 'Static lowpass is appropriate.',
      };
      const recs = recommendDynamicLowpass(boundaryAnalysis, dynamicSettings(200, 500));
      expect(recs).toHaveLength(0);
    });

    it('recommends disabling below the threshold (delta 3 dB)', () => {
      const lowDeltaAnalysis = {
        recommended: false,
        noiseIncreaseDeltaDb: 3,
        throttleNoiseCorrelation: 0.3,
        bandsAnalyzed: 5,
        summary: 'Static lowpass is appropriate.',
      };
      const recs = recommendDynamicLowpass(lowDeltaAnalysis, dynamicSettings(200, 500));
      expect(recs).toHaveLength(2);
      expect(recs.every((r) => r.ruleId === 'F-DLPF-GYRO-OFF')).toBe(true);
      expect(recs.every((r) => r.recommendedValue === 0)).toBe(true);
    });
  });
});

describe('ruleId assignment', () => {
  it('should assign F-DLPF-GYRO to gyro dynamic lowpass recommendations', () => {
    const recs = recommendDynamicLowpass(recommendedAnalysis, staticSettings(200));
    expect(recs).toHaveLength(2);
    expect(recs[0].ruleId).toBe('F-DLPF-GYRO');
    expect(recs[1].ruleId).toBe('F-DLPF-GYRO');
  });

  it('should assign F-DLPF-DTERM to D-term dynamic lowpass recommendations', () => {
    const recs = recommendDynamicLowpass(recommendedAnalysis, staticSettings(200, 150));
    const dtermRecs = recs.filter((r) => r.ruleId === 'F-DLPF-DTERM');
    expect(dtermRecs).toHaveLength(2);
  });

  it('should assign F-DLPF-GYRO-OFF when recommending disable', () => {
    const recs = recommendDynamicLowpass(notRecommendedAnalysis, dynamicSettings(200, 500));
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0].ruleId).toBe('F-DLPF-GYRO-OFF');
  });
});

describe('community preset validation', () => {
  it('BF default 5": static=250 → dyn_min=250, dyn_max=500', () => {
    const recs = recommendDynamicLowpass(recommendedAnalysis, staticSettings(250));
    expect(recs[0].recommendedValue).toBe(250);
    expect(recs[1].recommendedValue).toBe(500);
  });

  it('BF default dterm: static=75 → dyn_min=75, dyn_max=150', () => {
    const recs = recommendDynamicLowpass(recommendedAnalysis, staticSettings(250, 75));
    const dtermRecs = recs.filter((r) => r.setting.startsWith('dterm_'));
    expect(dtermRecs[0].recommendedValue).toBe(75);
    expect(dtermRecs[1].recommendedValue).toBe(150);
  });

  it('UAV Tech 5": static=150 → dyn_min=150, dyn_max=300', () => {
    const recs = recommendDynamicLowpass(recommendedAnalysis, staticSettings(150));
    expect(recs[0].recommendedValue).toBe(150);
    expect(recs[1].recommendedValue).toBe(300);
  });

  it('SupaflyFPV 7": static=200 → dyn_min=200, dyn_max=400', () => {
    const recs = recommendDynamicLowpass(recommendedAnalysis, staticSettings(200));
    expect(recs[0].recommendedValue).toBe(200);
    expect(recs[1].recommendedValue).toBe(400);
  });

  it('SupaflyFPV 3-4": static=350 → dyn_min=350, dyn_max=700', () => {
    const recs = recommendDynamicLowpass(recommendedAnalysis, staticSettings(350));
    expect(recs[0].recommendedValue).toBe(350);
    expect(recs[1].recommendedValue).toBe(700);
  });

  it('all presets maintain 2:1 ratio (BF convention)', () => {
    for (const staticHz of [75, 150, 200, 250, 300, 350]) {
      const recs = recommendDynamicLowpass(recommendedAnalysis, staticSettings(staticHz));
      if (recs.length >= 2) {
        const min = recs[0].recommendedValue;
        const max = recs[1].recommendedValue;
        expect(max / min).toBe(DYNAMIC_LOWPASS_RATIO);
      }
    }
  });
});
