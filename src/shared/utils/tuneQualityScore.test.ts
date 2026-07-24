import { describe, it, expect } from 'vitest';
import { computeTuneQualityScore, spectrogramDelta } from './tuneQualityScore';
import type {
  FilterMetricsSummary,
  PIDMetricsSummary,
  TransferFunctionMetricsSummary,
  CompactThrottleSpectrogram,
} from '../types/tuning-history.types';

const perfectFilter: FilterMetricsSummary = {
  noiseLevel: 'low',
  roll: { noiseFloorDb: -50, peakCount: 0 },
  pitch: { noiseFloorDb: -50, peakCount: 0 },
  yaw: { noiseFloorDb: -50, peakCount: 0 },
  segmentsUsed: 5,
  summary: 'Perfect',
};

const perfectPID: PIDMetricsSummary = {
  roll: {
    meanOvershoot: 0,
    meanRiseTimeMs: 5,
    meanSettlingTimeMs: 50,
    meanLatencyMs: 2,
    meanTrackingErrorRMS: 0,
  },
  pitch: {
    meanOvershoot: 0,
    meanRiseTimeMs: 5,
    meanSettlingTimeMs: 50,
    meanLatencyMs: 2,
    meanTrackingErrorRMS: 0,
  },
  yaw: {
    meanOvershoot: 0,
    meanRiseTimeMs: 5,
    meanSettlingTimeMs: 50,
    meanLatencyMs: 2,
    meanTrackingErrorRMS: 0,
  },
  stepsDetected: 30,
  currentPIDs: {
    roll: { P: 45, I: 80, D: 30 },
    pitch: { P: 47, I: 82, D: 32 },
    yaw: { P: 35, I: 90, D: 0 },
  },
  summary: 'Perfect',
};

const worstFilter: FilterMetricsSummary = {
  noiseLevel: 'high',
  roll: { noiseFloorDb: -10, peakCount: 5 },
  pitch: { noiseFloorDb: -10, peakCount: 5 },
  yaw: { noiseFloorDb: -10, peakCount: 5 },
  segmentsUsed: 1,
  summary: 'Terrible',
};

const worstPID: PIDMetricsSummary = {
  roll: {
    meanOvershoot: 50,
    meanRiseTimeMs: 100,
    meanSettlingTimeMs: 500,
    meanLatencyMs: 30,
    meanTrackingErrorRMS: 0.5,
  },
  pitch: {
    meanOvershoot: 50,
    meanRiseTimeMs: 100,
    meanSettlingTimeMs: 500,
    meanLatencyMs: 30,
    meanTrackingErrorRMS: 0.5,
  },
  yaw: {
    meanOvershoot: 50,
    meanRiseTimeMs: 100,
    meanSettlingTimeMs: 500,
    meanLatencyMs: 30,
    meanTrackingErrorRMS: 0.5,
  },
  stepsDetected: 3,
  currentPIDs: {
    roll: { P: 45, I: 80, D: 30 },
    pitch: { P: 47, I: 82, D: 32 },
    yaw: { P: 35, I: 90, D: 0 },
  },
  summary: 'Terrible',
};

describe('computeTuneQualityScore', () => {
  it('returns null when both metrics are null', () => {
    expect(computeTuneQualityScore({ filterMetrics: null, pidMetrics: null })).toBeNull();
  });

  it('returns null when both metrics are undefined', () => {
    expect(computeTuneQualityScore({ filterMetrics: undefined, pidMetrics: undefined })).toBeNull();
  });

  it('returns 100 / excellent for perfect metrics', () => {
    const result = computeTuneQualityScore({
      filterMetrics: perfectFilter,
      pidMetrics: perfectPID,
    });
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(100);
    expect(result!.tier).toBe('excellent');
    expect(result!.components).toHaveLength(4);
  });

  it('returns 0 / poor for worst metrics', () => {
    const result = computeTuneQualityScore({ filterMetrics: worstFilter, pidMetrics: worstPID });
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(0);
    expect(result!.tier).toBe('poor');
  });

  it('returns mid-range score for mid-range metrics', () => {
    const midFilter: FilterMetricsSummary = {
      ...perfectFilter,
      roll: { noiseFloorDb: -30, peakCount: 2 },
      pitch: { noiseFloorDb: -30, peakCount: 2 },
      yaw: { noiseFloorDb: -30, peakCount: 2 },
    };
    const midPID: PIDMetricsSummary = {
      ...perfectPID,
      roll: {
        ...perfectPID.roll,
        meanOvershoot: 25,
        meanSettlingTimeMs: 275,
        meanTrackingErrorRMS: 0.25,
      },
      pitch: {
        ...perfectPID.pitch,
        meanOvershoot: 25,
        meanSettlingTimeMs: 275,
        meanTrackingErrorRMS: 0.25,
      },
      yaw: {
        ...perfectPID.yaw,
        meanOvershoot: 25,
        meanSettlingTimeMs: 275,
        meanTrackingErrorRMS: 0.25,
      },
    };
    const result = computeTuneQualityScore({ filterMetrics: midFilter, pidMetrics: midPID });
    expect(result).not.toBeNull();
    expect(result!.overall).toBeGreaterThanOrEqual(40);
    expect(result!.overall).toBeLessThanOrEqual(60);
  });

  it('redistributes to noise floor only when only filter metrics present', () => {
    const result = computeTuneQualityScore({ filterMetrics: perfectFilter, pidMetrics: null });
    expect(result).not.toBeNull();
    expect(result!.components).toHaveLength(1);
    expect(result!.components[0].label).toBe('Noise Floor');
    expect(result!.components[0].maxPoints).toBe(100);
    expect(result!.overall).toBe(100);
    expect(result!.tier).toBe('excellent');
  });

  it('redistributes to 3 PID components when only PID metrics present', () => {
    const result = computeTuneQualityScore({ filterMetrics: null, pidMetrics: perfectPID });
    expect(result).not.toBeNull();
    expect(result!.components).toHaveLength(3);
    expect(result!.components.every((c) => c.label !== 'Noise Floor')).toBe(true);
    expect(result!.overall).toBeGreaterThanOrEqual(99); // rounding: 33*3=99
  });

  it('handles old records without trackingErrorRMS (3-component score)', () => {
    const oldPID: PIDMetricsSummary = {
      roll: { meanOvershoot: 0, meanRiseTimeMs: 5, meanSettlingTimeMs: 50, meanLatencyMs: 2 },
      pitch: { meanOvershoot: 0, meanRiseTimeMs: 5, meanSettlingTimeMs: 50, meanLatencyMs: 2 },
      yaw: { meanOvershoot: 0, meanRiseTimeMs: 5, meanSettlingTimeMs: 50, meanLatencyMs: 2 },
      stepsDetected: 30,
      currentPIDs: {
        roll: { P: 45, I: 80, D: 30 },
        pitch: { P: 47, I: 82, D: 32 },
        yaw: { P: 35, I: 90, D: 0 },
      },
      summary: 'Old record',
    };
    const result = computeTuneQualityScore({ filterMetrics: perfectFilter, pidMetrics: oldPID });
    expect(result).not.toBeNull();
    // Noise Floor + Overshoot + Settling = 3 components (tracking RMS skipped)
    expect(result!.components).toHaveLength(3);
    expect(result!.components.find((c) => c.label === 'Tracking RMS')).toBeUndefined();
  });

  it('tier boundary: 80 → excellent', () => {
    // Craft metrics that produce score of 80
    // With 4 components × 25 pts, we need exactly 20 per component → 80%
    const filter: FilterMetricsSummary = {
      ...perfectFilter,
      roll: { noiseFloorDb: -42, peakCount: 0 }, // (42-10)/(50-10) = 0.8 → 20 pts
      pitch: { noiseFloorDb: -42, peakCount: 0 },
      yaw: { noiseFloorDb: -42, peakCount: 0 },
    };
    const pid: PIDMetricsSummary = {
      ...perfectPID,
      roll: {
        ...perfectPID.roll,
        meanOvershoot: 10,
        meanSettlingTimeMs: 140,
        meanTrackingErrorRMS: 0.1,
      },
      pitch: {
        ...perfectPID.pitch,
        meanOvershoot: 10,
        meanSettlingTimeMs: 140,
        meanTrackingErrorRMS: 0.1,
      },
      yaw: {
        ...perfectPID.yaw,
        meanOvershoot: 10,
        meanSettlingTimeMs: 140,
        meanTrackingErrorRMS: 0.1,
      },
    };
    const result = computeTuneQualityScore({ filterMetrics: filter, pidMetrics: pid });
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(80);
    expect(result!.tier).toBe('excellent');
  });

  it('tier boundary: 79 → good', () => {
    const filter: FilterMetricsSummary = {
      ...perfectFilter,
      roll: { noiseFloorDb: -41, peakCount: 0 },
      pitch: { noiseFloorDb: -41, peakCount: 0 },
      yaw: { noiseFloorDb: -41, peakCount: 0 },
    };
    const pid: PIDMetricsSummary = {
      ...perfectPID,
      roll: {
        ...perfectPID.roll,
        meanOvershoot: 10,
        meanSettlingTimeMs: 140,
        meanTrackingErrorRMS: 0.1,
      },
      pitch: {
        ...perfectPID.pitch,
        meanOvershoot: 10,
        meanSettlingTimeMs: 140,
        meanTrackingErrorRMS: 0.1,
      },
      yaw: {
        ...perfectPID.yaw,
        meanOvershoot: 10,
        meanSettlingTimeMs: 140,
        meanTrackingErrorRMS: 0.1,
      },
    };
    const result = computeTuneQualityScore({ filterMetrics: filter, pidMetrics: pid });
    expect(result).not.toBeNull();
    // noise floor score drops slightly → overall < 80
    expect(result!.overall).toBeLessThan(80);
    expect(result!.tier).toBe('good');
  });

  it('tier boundary: 60/59', () => {
    // Score ~60
    const filter60: FilterMetricsSummary = {
      ...perfectFilter,
      roll: { noiseFloorDb: -34, peakCount: 0 },
      pitch: { noiseFloorDb: -34, peakCount: 0 },
      yaw: { noiseFloorDb: -34, peakCount: 0 },
    };
    const pid60: PIDMetricsSummary = {
      ...perfectPID,
      roll: {
        ...perfectPID.roll,
        meanOvershoot: 20,
        meanSettlingTimeMs: 230,
        meanTrackingErrorRMS: 0.2,
      },
      pitch: {
        ...perfectPID.pitch,
        meanOvershoot: 20,
        meanSettlingTimeMs: 230,
        meanTrackingErrorRMS: 0.2,
      },
      yaw: {
        ...perfectPID.yaw,
        meanOvershoot: 20,
        meanSettlingTimeMs: 230,
        meanTrackingErrorRMS: 0.2,
      },
    };
    const result = computeTuneQualityScore({ filterMetrics: filter60, pidMetrics: pid60 });
    expect(result).not.toBeNull();
    expect(result!.overall).toBeGreaterThanOrEqual(58);
    expect(result!.overall).toBeLessThanOrEqual(62);
  });

  it('clamps values beyond range (better than best)', () => {
    const superFilter: FilterMetricsSummary = {
      ...perfectFilter,
      roll: { noiseFloorDb: -70, peakCount: 0 },
      pitch: { noiseFloorDb: -70, peakCount: 0 },
      yaw: { noiseFloorDb: -70, peakCount: 0 },
    };
    const result = computeTuneQualityScore({ filterMetrics: superFilter, pidMetrics: perfectPID });
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(100);
  });

  it('clamps values beyond range (worse than worst)', () => {
    const terribleFilter: FilterMetricsSummary = {
      ...perfectFilter,
      roll: { noiseFloorDb: 0, peakCount: 10 },
      pitch: { noiseFloorDb: 0, peakCount: 10 },
      yaw: { noiseFloorDb: 0, peakCount: 10 },
    };
    const terriblePID: PIDMetricsSummary = {
      ...worstPID,
      roll: {
        ...worstPID.roll,
        meanOvershoot: 100,
        meanSettlingTimeMs: 1000,
        meanTrackingErrorRMS: 1.0,
      },
      pitch: {
        ...worstPID.pitch,
        meanOvershoot: 100,
        meanSettlingTimeMs: 1000,
        meanTrackingErrorRMS: 1.0,
      },
      yaw: {
        ...worstPID.yaw,
        meanOvershoot: 100,
        meanSettlingTimeMs: 1000,
        meanTrackingErrorRMS: 1.0,
      },
    };
    const result = computeTuneQualityScore({
      filterMetrics: terribleFilter,
      pidMetrics: terriblePID,
    });
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(0);
  });

  it('components have correct structure', () => {
    const result = computeTuneQualityScore({
      filterMetrics: perfectFilter,
      pidMetrics: perfectPID,
    });
    expect(result).not.toBeNull();
    for (const c of result!.components) {
      expect(c).toHaveProperty('label');
      expect(c).toHaveProperty('score');
      expect(c).toHaveProperty('maxPoints');
      expect(c).toHaveProperty('rawValue');
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(c.maxPoints);
    }
  });

  it('tier boundary: 40/39', () => {
    const filter: FilterMetricsSummary = {
      ...perfectFilter,
      roll: { noiseFloorDb: -26, peakCount: 0 },
      pitch: { noiseFloorDb: -26, peakCount: 0 },
      yaw: { noiseFloorDb: -26, peakCount: 0 },
    };
    const pid: PIDMetricsSummary = {
      ...perfectPID,
      roll: {
        ...perfectPID.roll,
        meanOvershoot: 30,
        meanSettlingTimeMs: 320,
        meanTrackingErrorRMS: 0.3,
      },
      pitch: {
        ...perfectPID.pitch,
        meanOvershoot: 30,
        meanSettlingTimeMs: 320,
        meanTrackingErrorRMS: 0.3,
      },
      yaw: {
        ...perfectPID.yaw,
        meanOvershoot: 30,
        meanSettlingTimeMs: 320,
        meanTrackingErrorRMS: 0.3,
      },
    };
    const result = computeTuneQualityScore({ filterMetrics: filter, pidMetrics: pid });
    expect(result).not.toBeNull();
    expect(result!.overall).toBeGreaterThanOrEqual(38);
    expect(result!.overall).toBeLessThanOrEqual(42);
  });

  it('skips PID components when stepsDetected is 0 and no TF metrics', () => {
    const tfPID: PIDMetricsSummary = {
      ...perfectPID,
      stepsDetected: 0,
    };
    const result = computeTuneQualityScore({
      filterMetrics: perfectFilter,
      pidMetrics: tfPID,
    });
    expect(result).not.toBeNull();
    // Only Noise Floor — Tracking RMS, Overshoot, Settling Time all skipped, no TF metrics
    expect(result!.components).toHaveLength(1);
    expect(result!.components[0].label).toBe('Noise Floor');
    expect(result!.components[0].maxPoints).toBe(100);
  });

  it('returns null when stepsDetected is 0 and no filter metrics and no TF metrics', () => {
    const tfPID: PIDMetricsSummary = {
      ...perfectPID,
      stepsDetected: 0,
    };
    const result = computeTuneQualityScore({
      filterMetrics: null,
      pidMetrics: tfPID,
    });
    // No usable components → null
    expect(result).toBeNull();
  });

  describe('transfer function metrics integration (Flash Tune)', () => {
    const perfectTF: TransferFunctionMetricsSummary = {
      roll: {
        bandwidthHz: 80,
        phaseMarginDeg: 60,
        gainMarginDb: 12,
        overshootPercent: 0,
        settlingTimeMs: 60,
        riseTimeMs: 10,
      },
      pitch: {
        bandwidthHz: 80,
        phaseMarginDeg: 60,
        gainMarginDb: 12,
        overshootPercent: 0,
        settlingTimeMs: 60,
        riseTimeMs: 10,
      },
      yaw: {
        bandwidthHz: 80,
        phaseMarginDeg: 60,
        gainMarginDb: 12,
        overshootPercent: 0,
        settlingTimeMs: 60,
        riseTimeMs: 10,
      },
    };

    const worstTF: TransferFunctionMetricsSummary = {
      roll: {
        bandwidthHz: 10,
        phaseMarginDeg: 15,
        gainMarginDb: 2,
        overshootPercent: 50,
        settlingTimeMs: 400,
        riseTimeMs: 80,
      },
      pitch: {
        bandwidthHz: 10,
        phaseMarginDeg: 15,
        gainMarginDb: 2,
        overshootPercent: 50,
        settlingTimeMs: 400,
        riseTimeMs: 80,
      },
      yaw: {
        bandwidthHz: 10,
        phaseMarginDeg: 15,
        gainMarginDb: 2,
        overshootPercent: 50,
        settlingTimeMs: 400,
        riseTimeMs: 80,
      },
    };

    it('uses TF overshoot as Overshoot component for Flash Tune (no step data)', () => {
      const result = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: { ...perfectPID, stepsDetected: 0 },
        transferFunctionMetrics: perfectTF,
      });
      expect(result).not.toBeNull();
      // Noise Floor + Overshoot (from TF) + Phase Margin + Bandwidth = 4 components
      expect(result!.components).toHaveLength(4);
      expect(result!.components.find((c) => c.label === 'Overshoot')).toBeDefined();
      expect(result!.components.find((c) => c.label === 'Noise Floor')).toBeDefined();
      expect(result!.components.find((c) => c.label === 'Phase Margin')).toBeDefined();
      expect(result!.components.find((c) => c.label === 'Bandwidth')).toBeDefined();
    });

    it('scores 100 with perfect TF + filter metrics', () => {
      const result = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: { ...perfectPID, stepsDetected: 0 },
        transferFunctionMetrics: perfectTF,
      });
      expect(result).not.toBeNull();
      // 4 components × 25 pts = 100
      expect(result!.overall).toBe(100);
      expect(result!.tier).toBe('excellent');
    });

    it('scores 0 with worst TF + filter metrics', () => {
      const result = computeTuneQualityScore({
        filterMetrics: worstFilter,
        pidMetrics: { ...perfectPID, stepsDetected: 0 },
        transferFunctionMetrics: worstTF,
      });
      expect(result).not.toBeNull();
      expect(result!.overall).toBe(0);
      expect(result!.tier).toBe('poor');
    });

    it('Flash Tune scores are comparable to PID Tune scores', () => {
      // Perfect PID Tune: 4 components × 25 pts = 100
      const pidScore = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: perfectPID,
      });
      // Perfect Flash Tune: 2 components × 50 pts = 100
      const flashScore = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: { ...perfectPID, stepsDetected: 0 },
        transferFunctionMetrics: perfectTF,
      });
      expect(pidScore).not.toBeNull();
      expect(flashScore).not.toBeNull();
      // Both perfect → both 100
      expect(flashScore!.overall).toBe(100);
    });

    it('mid-range TF overshoot produces mid-range score', () => {
      const midTF: TransferFunctionMetricsSummary = {
        roll: {
          bandwidthHz: 45,
          phaseMarginDeg: 37.5,
          gainMarginDb: 7,
          overshootPercent: 25,
          settlingTimeMs: 200,
          riseTimeMs: 40,
        },
        pitch: {
          bandwidthHz: 45,
          phaseMarginDeg: 37.5,
          gainMarginDb: 7,
          overshootPercent: 25,
          settlingTimeMs: 200,
          riseTimeMs: 40,
        },
        yaw: {
          bandwidthHz: 45,
          phaseMarginDeg: 37.5,
          gainMarginDb: 7,
          overshootPercent: 25,
          settlingTimeMs: 200,
          riseTimeMs: 40,
        },
      };
      const midFilter: FilterMetricsSummary = {
        ...perfectFilter,
        roll: { noiseFloorDb: -30, peakCount: 2 },
        pitch: { noiseFloorDb: -30, peakCount: 2 },
        yaw: { noiseFloorDb: -30, peakCount: 2 },
      };
      const result = computeTuneQualityScore({
        filterMetrics: midFilter,
        pidMetrics: { ...perfectPID, stepsDetected: 0 },
        transferFunctionMetrics: midTF,
      });
      expect(result).not.toBeNull();
      // 4 components × 25 pts each:
      // NF: (-30-(-10))/(-50-(-10)) = 0.5 → round(0.5*25) = 13
      // OS: (25-50)/(0-50) = 0.5 → round(0.5*25) = 13
      // PM: (37.5-20)/(60-20) = 0.4375 → round(0.4375*25) = 11
      // BW: (45-20)/(80-20) = 0.4167 → round(0.4167*25) = 10
      // Total = 47
      expect(result!.overall).toBe(47);
    });

    it('does not use TF overshoot when step data is available (PID Tune)', () => {
      const result = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: perfectPID,
        transferFunctionMetrics: null,
      });
      expect(result).not.toBeNull();
      // Standard 4 PID Tune components (Overshoot from step response, not TF)
      expect(result!.components).toHaveLength(4);
    });

    it('prefers step-based overshoot when both step data and TF available', () => {
      // Edge case: both step response and TF metrics available
      const result = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: perfectPID, // stepsDetected: 30
        transferFunctionMetrics: perfectTF,
      });
      expect(result).not.toBeNull();
      // Overshoot uses step data (pid.stepsDetected > 0), TF overshoot ignored
      // 6 components: PID Tune 4 (Noise Floor, Tracking RMS, Overshoot, Settling Time) + TF 2 (Phase Margin, Bandwidth)
      expect(result!.components).toHaveLength(6);
      const overshootComponent = result!.components.find((c) => c.label === 'Overshoot')!;
      // Step-based overshoot: perfectPID.roll.meanOvershoot = 0 → perfect score
      expect(overshootComponent.score).toBe(overshootComponent.maxPoints);
    });

    it('TF overshoot beyond worst clamps to 0', () => {
      const extremeTF: TransferFunctionMetricsSummary = {
        roll: { ...worstTF.roll, overshootPercent: 150 },
        pitch: { ...worstTF.pitch, overshootPercent: 150 },
        yaw: { ...worstTF.yaw, overshootPercent: 150 },
      };
      const result = computeTuneQualityScore({
        filterMetrics: worstFilter,
        pidMetrics: { ...perfectPID, stepsDetected: 0 },
        transferFunctionMetrics: extremeTF,
      });
      expect(result).not.toBeNull();
      const overshootComponent = result!.components.find((c) => c.label === 'Overshoot')!;
      expect(overshootComponent.score).toBe(0);
    });

    it('backwards compatible: old records without TF metrics still score correctly', () => {
      const result = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: perfectPID,
      });
      expect(result).not.toBeNull();
      expect(result!.overall).toBe(100);
      expect(result!.components).toHaveLength(4);
    });
  });

  describe('verification metrics integration', () => {
    const noisyFilter: FilterMetricsSummary = {
      ...perfectFilter,
      roll: { noiseFloorDb: -20, peakCount: 3 },
      pitch: { noiseFloorDb: -20, peakCount: 3 },
      yaw: { noiseFloorDb: -20, peakCount: 3 },
    };

    const cleanVerification: FilterMetricsSummary = {
      ...perfectFilter,
      roll: { noiseFloorDb: -45, peakCount: 0 },
      pitch: { noiseFloorDb: -45, peakCount: 0 },
      yaw: { noiseFloorDb: -45, peakCount: 0 },
    };

    const degradedVerification: FilterMetricsSummary = {
      ...perfectFilter,
      roll: { noiseFloorDb: -15, peakCount: 4 },
      pitch: { noiseFloorDb: -15, peakCount: 4 },
      yaw: { noiseFloorDb: -15, peakCount: 4 },
    };

    it('uses verification noise floor instead of filter when available', () => {
      // Without verification: noisy filter → low noise floor score
      const withoutVerification = computeTuneQualityScore({
        filterMetrics: noisyFilter,
        pidMetrics: perfectPID,
      });
      // With verification: clean verification → high noise floor score
      const withVerification = computeTuneQualityScore({
        filterMetrics: noisyFilter,
        pidMetrics: perfectPID,
        verificationMetrics: cleanVerification,
      });
      expect(withVerification).not.toBeNull();
      expect(withoutVerification).not.toBeNull();
      // Verification has cleaner noise floor → higher overall score
      expect(withVerification!.overall).toBeGreaterThan(withoutVerification!.overall);
    });

    it('adds Noise Delta component when both filter and verification present', () => {
      const result = computeTuneQualityScore({
        filterMetrics: noisyFilter,
        pidMetrics: perfectPID,
        verificationMetrics: cleanVerification,
      });
      expect(result).not.toBeNull();
      const deltaComponent = result!.components.find((c) => c.label === 'Noise Delta');
      expect(deltaComponent).toBeDefined();
      // 5 components when verification present
      expect(result!.components).toHaveLength(5);
    });

    it('does not add Noise Delta when verification is absent', () => {
      const result = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: perfectPID,
      });
      expect(result).not.toBeNull();
      const deltaComponent = result!.components.find((c) => c.label === 'Noise Delta');
      expect(deltaComponent).toBeUndefined();
      expect(result!.components).toHaveLength(4);
    });

    it('rewards noise improvement in Noise Delta', () => {
      // Filter flight: -20 dB, verification: -45 dB → 25 dB improvement
      const result = computeTuneQualityScore({
        filterMetrics: noisyFilter,
        pidMetrics: perfectPID,
        verificationMetrics: cleanVerification,
      });
      const deltaComponent = result!.components.find((c) => c.label === 'Noise Delta')!;
      // rawValue = verificationAvg - filterAvg = -45 - (-20) = -25
      expect(deltaComponent.rawValue).toBeLessThan(0);
      // Should get full score (best = -10, -25 is even better → clamped to max)
      expect(deltaComponent.score).toBe(deltaComponent.maxPoints);
    });

    it('penalizes noise regression in Noise Delta', () => {
      // Filter flight: -45 dB, verification: -15 dB → 30 dB regression
      const result = computeTuneQualityScore({
        filterMetrics: cleanVerification,
        pidMetrics: perfectPID,
        verificationMetrics: degradedVerification,
      });
      const deltaComponent = result!.components.find((c) => c.label === 'Noise Delta')!;
      // rawValue = -15 - (-45) = +30 dB regression
      expect(deltaComponent.rawValue).toBeGreaterThan(0);
      // Should get zero score (worst = +5, +30 is way worse → clamped to 0)
      expect(deltaComponent.score).toBe(0);
    });

    it('gives mid score for no change in Noise Delta', () => {
      // Same noise floor → delta ≈ 0
      const result = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: perfectPID,
        verificationMetrics: perfectFilter,
      });
      const deltaComponent = result!.components.find((c) => c.label === 'Noise Delta')!;
      expect(deltaComponent.rawValue).toBe(0);
      // 0 is between -10 (best) and +5 (worst): t = (0-5)/(-10-5) = -5/-15 = 0.333
      // score = round(0.333 * maxPoints)
      expect(deltaComponent.score).toBeGreaterThan(0);
      expect(deltaComponent.score).toBeLessThan(deltaComponent.maxPoints);
    });

    it('does not add Noise Delta when verification is null', () => {
      const result = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: perfectPID,
        verificationMetrics: null,
      });
      expect(result).not.toBeNull();
      expect(result!.components.find((c) => c.label === 'Noise Delta')).toBeUndefined();
    });

    it('backwards compatible: existing tests still pass without verificationMetrics', () => {
      // Perfect metrics without verification → same score as before
      const result = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: perfectPID,
      });
      expect(result).not.toBeNull();
      expect(result!.overall).toBe(100);
      expect(result!.components).toHaveLength(4);
    });

    it('noise floor uses verification even without PID metrics', () => {
      // Only filter + verification → Noise Floor uses verification, Noise Delta present
      const result = computeTuneQualityScore({
        filterMetrics: noisyFilter,
        verificationMetrics: cleanVerification,
      });
      expect(result).not.toBeNull();
      // Noise Floor + Noise Delta = 2 components
      expect(result!.components).toHaveLength(2);
      expect(result!.components.find((c) => c.label === 'Noise Floor')).toBeDefined();
      expect(result!.components.find((c) => c.label === 'Noise Delta')).toBeDefined();
      // Clean verification noise → high noise floor score
      expect(result!.overall).toBeGreaterThan(80);
    });

    it('overall score decreases when verification shows regression', () => {
      // Perfect filter, degraded verification → score should drop
      const withoutVerification = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: perfectPID,
      });
      const withDegradedVerification = computeTuneQualityScore({
        filterMetrics: perfectFilter,
        pidMetrics: perfectPID,
        verificationMetrics: degradedVerification,
      });
      expect(withDegradedVerification).not.toBeNull();
      expect(withoutVerification).not.toBeNull();
      // Degraded verification → lower overall
      expect(withDegradedVerification!.overall).toBeLessThan(withoutVerification!.overall);
    });
  });

  describe('spectrogram-based Noise Delta', () => {
    const makeSpectrogram = (dbValue: number): CompactThrottleSpectrogram => ({
      frequencies: [100, 200, 300],
      bands: [
        {
          throttleMin: 0,
          throttleMax: 0.5,
          roll: [dbValue, dbValue, dbValue],
          pitch: [dbValue, dbValue, dbValue],
          yaw: [dbValue, dbValue, dbValue],
        },
        {
          throttleMin: 0.5,
          throttleMax: 1.0,
          roll: [dbValue, dbValue, dbValue],
          pitch: [dbValue, dbValue, dbValue],
          yaw: [dbValue, dbValue, dbValue],
        },
      ],
      bandsWithData: 2,
    });

    it('spectrogramDelta returns negative for improvement', () => {
      const before = makeSpectrogram(-20);
      const after = makeSpectrogram(-25); // 5 dB quieter
      expect(spectrogramDelta(before, after)).toBeCloseTo(-5, 1);
    });

    it('spectrogramDelta returns positive for regression', () => {
      const before = makeSpectrogram(-30);
      const after = makeSpectrogram(-27); // 3 dB louder
      expect(spectrogramDelta(before, after)).toBeCloseTo(3, 1);
    });

    it('spectrogramDelta excludes -240 sentinel values', () => {
      const before = makeSpectrogram(-25);
      const after: CompactThrottleSpectrogram = {
        ...makeSpectrogram(-30),
        bands: [
          {
            throttleMin: 0,
            throttleMax: 0.5,
            roll: [-30, -240, -30], // -240 sentinel in middle
            pitch: [-30, -30, -30],
            yaw: [-30, -30, -30],
          },
        ],
      };
      const beforeOneBand: CompactThrottleSpectrogram = {
        ...before,
        bands: [before.bands[0]],
      };
      const delta = spectrogramDelta(beforeOneBand, after);
      // Only non-sentinel pairs counted: 8 cells × -5 dB = -5 avg
      expect(delta).toBeCloseTo(-5, 1);
    });

    it('spectrogramDelta does not exclude legitimately quiet values (e.g. -110 dB)', () => {
      const before = makeSpectrogram(-100);
      const after = makeSpectrogram(-110); // very quiet but valid
      expect(spectrogramDelta(before, after)).toBeCloseTo(-10, 1);
    });

    it('uses spectrogram delta for Noise Delta when both have spectrograms', () => {
      const filterWithSpec: FilterMetricsSummary = {
        ...perfectFilter,
        throttleSpectrogram: makeSpectrogram(-20),
      };
      const verificationWithSpec: FilterMetricsSummary = {
        ...perfectFilter,
        throttleSpectrogram: makeSpectrogram(-25), // 5 dB improvement
      };

      const result = computeTuneQualityScore({
        filterMetrics: filterWithSpec,
        verificationMetrics: verificationWithSpec,
      });
      expect(result).not.toBeNull();
      const deltaCmp = result!.components.find((c) => c.label === 'Noise Delta');
      expect(deltaCmp).toBeDefined();
      expect(deltaCmp!.rawValue).toBeCloseTo(-5, 1);
      // -5 dB with best=-10, worst=5 → ((-5)-5)/((-10)-5) = 10/15 = 0.667
      expect(deltaCmp!.score).toBeGreaterThan(0);
    });
  });
});
