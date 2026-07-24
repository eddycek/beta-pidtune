import { describe, it, expect } from 'vitest';
import {
  pt1MagnitudeDb,
  ptnMagnitudeDb,
  biquadLpfMagnitudeDb,
  notchMagnitudeDb,
  lowpassMagnitudeDb,
  dynLpfCutoffHz,
  computeFilterChainCurve,
  gyroLpf1CutoffAtThrottle,
  FILTER_TYPE_BIQUAD,
  FILTER_TYPE_PT2,
  FILTER_TYPE_PT3,
  FILTER_RESPONSE_FLOOR_DB,
} from './filterResponse';
import { DEFAULT_FILTER_SETTINGS } from '../types/analysis.types';
import type { CurrentFilterSettings } from '../types/analysis.types';

function settings(overrides: Partial<CurrentFilterSettings>): CurrentFilterSettings {
  return { ...DEFAULT_FILTER_SETTINGS, ...overrides };
}

describe('filter magnitude models', () => {
  it('PT1 is -3 dB at its cutoff and 0 dB at DC', () => {
    expect(pt1MagnitudeDb(0, 100)).toBeCloseTo(0, 5);
    expect(pt1MagnitudeDb(100, 100)).toBeCloseTo(-3.0103, 3);
    // First-order rolloff: -20 dB/decade
    expect(pt1MagnitudeDb(1000, 100)).toBeCloseTo(-20.04, 1);
  });

  it('PT2 and PT3 cascades are -3 dB at the configured cutoff (BF correction)', () => {
    expect(ptnMagnitudeDb(100, 100, 2)).toBeCloseTo(-3.01, 1);
    expect(ptnMagnitudeDb(100, 100, 3)).toBeCloseTo(-3.01, 1);
    // Steeper rolloff than PT1 past the cutoff
    expect(ptnMagnitudeDb(1000, 100, 2)).toBeLessThan(pt1MagnitudeDb(1000, 100));
    expect(ptnMagnitudeDb(1000, 100, 3)).toBeLessThan(ptnMagnitudeDb(1000, 100, 2));
  });

  it('Butterworth biquad is -3 dB at cutoff with -40 dB/decade rolloff', () => {
    expect(biquadLpfMagnitudeDb(100, 100)).toBeCloseTo(-3.0103, 3);
    expect(biquadLpfMagnitudeDb(1000, 100)).toBeCloseTo(-40, 0);
  });

  it('notch is deepest at center and near-transparent far away', () => {
    expect(notchMagnitudeDb(200, 200, 5)).toBe(FILTER_RESPONSE_FLOOR_DB);
    expect(notchMagnitudeDb(20, 200, 5)).toBeGreaterThan(-1);
    expect(notchMagnitudeDb(2000, 200, 5)).toBeGreaterThan(-1);
  });

  it('disabled stages (cutoff 0) contribute 0 dB', () => {
    expect(pt1MagnitudeDb(100, 0)).toBe(0);
    expect(biquadLpfMagnitudeDb(100, 0)).toBe(0);
    expect(notchMagnitudeDb(100, 0, 5)).toBe(0);
  });

  it('lowpassMagnitudeDb dispatches by BF filter type', () => {
    expect(lowpassMagnitudeDb(100, 100, FILTER_TYPE_BIQUAD)).toBeCloseTo(
      biquadLpfMagnitudeDb(100, 100),
      6
    );
    expect(lowpassMagnitudeDb(100, 100, FILTER_TYPE_PT2)).toBeCloseTo(
      ptnMagnitudeDb(100, 100, 2),
      6
    );
    expect(lowpassMagnitudeDb(100, 100, FILTER_TYPE_PT3)).toBeCloseTo(
      ptnMagnitudeDb(100, 100, 3),
      6
    );
    // undefined defaults to PT1
    expect(lowpassMagnitudeDb(100, 100, undefined)).toBeCloseTo(pt1MagnitudeDb(100, 100), 6);
  });
});

describe('dynLpfCutoffHz (BF throttle curve)', () => {
  it('hits min at zero throttle and max at full throttle', () => {
    expect(dynLpfCutoffHz(0, 250, 500, 5)).toBe(250);
    expect(dynLpfCutoffHz(1, 250, 500, 5)).toBe(500);
  });

  it('is linear when expo is 0', () => {
    expect(dynLpfCutoffHz(0.5, 250, 500, 0)).toBeCloseTo(375, 5);
  });

  it('expo boosts the cutoff at mid throttle', () => {
    // curve = 0.5·0.5·0.5 + 0.5 = 0.625 → 250 + 0.625·250 = 406.25
    expect(dynLpfCutoffHz(0.5, 250, 500, 5)).toBeCloseTo(406.25, 2);
  });

  it('clamps throttle outside 0..1', () => {
    expect(dynLpfCutoffHz(-0.5, 250, 500, 5)).toBe(250);
    expect(dynLpfCutoffHz(1.5, 250, 500, 5)).toBe(500);
  });
});

describe('computeFilterChainCurve', () => {
  it('combines LPF1 + LPF2 attenuation in dB', () => {
    const s = settings({
      gyro_lpf1_static_hz: 100,
      gyro_lpf2_static_hz: 100,
      gyro_lpf1_dyn_min_hz: 0,
    });
    const curve = computeFilterChainCurve(s, 'gyro', [100]);
    expect(curve).not.toBeNull();
    // Two PT1 stages at 100 Hz → 2 × -3.01 dB at 100 Hz
    expect(curve![0]).toBeCloseTo(-6.02, 1);
  });

  it('returns null when the chain has no active stage', () => {
    const s = settings({
      gyro_lpf1_static_hz: 0,
      gyro_lpf2_static_hz: 0,
      gyro_lpf1_dyn_min_hz: 0,
    });
    expect(computeFilterChainCurve(s, 'gyro', [100])).toBeNull();
  });

  it('evaluates dynamic LPF1 at the requested throttle', () => {
    const s = settings({
      gyro_lpf1_dyn_min_hz: 250,
      gyro_lpf1_dyn_max_hz: 500,
      gyro_lpf1_dyn_expo: 0,
      gyro_lpf2_static_hz: 0,
    });
    const low = computeFilterChainCurve(s, 'gyro', [250], 0)!;
    const high = computeFilterChainCurve(s, 'gyro', [250], 1)!;
    expect(low[0]).toBeCloseTo(-3.01, 1); // cutoff at 250 → -3 dB
    expect(high[0]).toBeGreaterThan(low[0]); // cutoff at 500 → less attenuation at 250 Hz
  });

  it('clamps combined attenuation to the display floor', () => {
    const s = settings({
      gyro_lpf1_static_hz: 50,
      gyro_lpf2_static_hz: 50,
      gyro_lpf1_dyn_min_hz: 0,
    });
    const curve = computeFilterChainCurve(s, 'gyro', [5000])!;
    expect(curve[0]).toBe(FILTER_RESPONSE_FLOOR_DB);
  });

  it('uses the D-term fields for the dterm chain', () => {
    const s = settings({
      dterm_lpf1_static_hz: 150,
      dterm_lpf2_static_hz: 0,
      dterm_lpf1_dyn_min_hz: 0,
    });
    const curve = computeFilterChainCurve(s, 'dterm', [150])!;
    expect(curve[0]).toBeCloseTo(-3.01, 1);
  });
});

describe('gyroLpf1CutoffAtThrottle', () => {
  it('returns the static cutoff regardless of throttle', () => {
    const s = settings({ gyro_lpf1_static_hz: 250, gyro_lpf1_dyn_min_hz: 0 });
    expect(gyroLpf1CutoffAtThrottle(s, 0)).toBe(250);
    expect(gyroLpf1CutoffAtThrottle(s, 1)).toBe(250);
  });

  it('follows the dynamic curve when dynamic LPF is active', () => {
    const s = settings({
      gyro_lpf1_dyn_min_hz: 250,
      gyro_lpf1_dyn_max_hz: 500,
      gyro_lpf1_dyn_expo: 0,
    });
    expect(gyroLpf1CutoffAtThrottle(s, 0)).toBe(250);
    expect(gyroLpf1CutoffAtThrottle(s, 1)).toBe(500);
  });

  it('returns null when LPF1 is fully disabled', () => {
    const s = settings({ gyro_lpf1_static_hz: 0, gyro_lpf1_dyn_min_hz: 0 });
    expect(gyroLpf1CutoffAtThrottle(s, 0.5)).toBeNull();
  });
});
