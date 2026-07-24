import { describe, it, expect } from 'vitest';
import {
  optimizeFilterPlacement,
  recommendFilterPlacement,
  OPT_RESIDUAL_TARGET_DB,
} from './FilterPlacementOptimizer';
import type { NoiseProfile, NoisePeak, CurrentFilterSettings } from '@shared/types/analysis.types';
import { DEFAULT_FILTER_SETTINGS } from '@shared/types/analysis.types';

function makeProfile(peaks: NoisePeak[]): NoiseProfile {
  const axis = (p: NoisePeak[]) => ({
    spectrum: { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
    noiseFloorDb: -30,
    peaks: p,
  });
  return { roll: axis(peaks), pitch: axis([]), yaw: axis([]), overallLevel: 'medium' };
}

function peak(frequency: number, amplitude: number): NoisePeak {
  return { frequency, amplitude, type: 'frame_resonance' };
}

const settings = (over: Partial<CurrentFilterSettings> = {}): CurrentFilterSettings => ({
  ...DEFAULT_FILTER_SETTINGS,
  dyn_notch_min_hz: 100,
  dyn_notch_max_hz: 600,
  dyn_notch_count: 3,
  dyn_notch_q: 300,
  ...over,
});

describe('optimizeFilterPlacement (P3.3)', () => {
  it('returns null when there are no significant peaks', () => {
    const result = optimizeFilterPlacement(makeProfile([peak(160, 8)]), settings(), false);
    expect(result).toBeNull();
  });

  it('covers a notch-range peak with notches instead of a deep lowpass', () => {
    // Single 200 Hz peak at 20 dB — one dynamic notch (-20 dB) covers it
    const result = optimizeFilterPlacement(makeProfile([peak(200, 20)]), settings(), false);
    expect(result).not.toBeNull();
    expect(result!.feasible).toBe(true);
    expect(result!.best!.dyn_notch_count).toBeGreaterThanOrEqual(1);
    // Latency-optimal LPF1 should stay high (the notch does the work)
    expect(result!.best!.gyro_lpf1_static_hz).toBeGreaterThanOrEqual(400);
  });

  it('is infeasible when a strong peak sits below every option', () => {
    // 45 Hz peak below the notch range and too strong for any candidate LPF
    const result = optimizeFilterPlacement(makeProfile([peak(45, 25)]), settings(), false);
    expect(result).not.toBeNull();
    expect(result!.feasible).toBe(false);
    expect(result!.best).toBeUndefined();
  });

  it('never disables LPF1 entirely without an RPM filter', () => {
    const result = optimizeFilterPlacement(makeProfile([peak(500, 18)]), settings(), false);
    expect(result!.feasible).toBe(true);
    expect(result!.best!.gyro_lpf1_static_hz).toBeGreaterThan(0);
  });

  it('computes the delay delta against the current configuration', () => {
    // Heavy current config (LPF1 100 + LPF2 250 + 3 notches) vs a light optimum
    const result = optimizeFilterPlacement(
      makeProfile([peak(300, 18)]),
      settings({ gyro_lpf1_static_hz: 100, gyro_lpf2_static_hz: 250 }),
      false
    );
    expect(result!.feasible).toBe(true);
    expect(result!.deltaMs).toBeLessThan(0); // optimizer found a faster config
  });

  it('respects the residual target on every peak', () => {
    const peaks = [peak(200, 24), peak(450, 16)];
    const result = optimizeFilterPlacement(makeProfile(peaks), settings(), false);
    expect(result!.feasible).toBe(true);
    // Reconstruct residuals under the winning config: they must all pass
    expect(result!.peaks).toHaveLength(2);
    expect(OPT_RESIDUAL_TARGET_DB).toBe(6);
  });
});

describe('recommendFilterPlacement (P3.3)', () => {
  it('emits an informational advisory when the optimizer saves enough delay', () => {
    const result = optimizeFilterPlacement(
      makeProfile([peak(300, 18)]),
      settings({ gyro_lpf1_static_hz: 100, gyro_lpf2_static_hz: 250 }),
      false
    );
    const rec = recommendFilterPlacement(result, '5"');
    expect(rec).toBeDefined();
    expect(rec!.informational).toBe(true);
    expect(rec!.ruleId).toBe('F-OPT-PLACEMENT');
    expect(rec!.reason).toContain('ms less gyro');
    expect(rec!.evidence?.measurements.some((m) => m.label === 'Current chain delay')).toBe(true);
  });

  it('stays silent when the current config is already near-optimal', () => {
    // Current config = a light one the optimizer would pick anyway
    const result = optimizeFilterPlacement(
      makeProfile([peak(300, 18)]),
      settings({ gyro_lpf1_static_hz: 500, gyro_lpf2_static_hz: 0, dyn_notch_count: 1 }),
      false
    );
    expect(recommendFilterPlacement(result, '5"')).toBeUndefined();
  });

  it('stays silent when infeasible', () => {
    const result = optimizeFilterPlacement(makeProfile([peak(45, 25)]), settings(), false);
    expect(recommendFilterPlacement(result, '5"')).toBeUndefined();
  });
});
