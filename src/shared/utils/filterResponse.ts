/**
 * Filter magnitude-response models (P2.3).
 *
 * Computes |H(f)| in dB for the Betaflight gyro / D-term lowpass chains so the
 * renderer can overlay the configured filter attenuation on measured noise
 * spectra and throttle spectrograms (parity with Blackbox Explorer 2025.12).
 *
 * Models match the firmware:
 * - PT1/PT2/PT3 as cascaded first-order stages with Betaflight's cutoff
 *   correction (the cascade is -3 dB at the configured cutoff)
 * - BIQUAD as a 2nd-order Butterworth lowpass (Q = 1/√2)
 * - Dynamic lowpass cutoff via the firmware's throttle curve
 *   (dynLpfCutoffFreq: curve = t·(1−t)·expo/10 + t)
 */
import type { CurrentFilterSettings } from '../types/analysis.types';

/** Betaflight filter type values (gyro_lpf1_type etc.) */
export const FILTER_TYPE_PT1 = 0;
export const FILTER_TYPE_BIQUAD = 1;
export const FILTER_TYPE_PT2 = 2;
export const FILTER_TYPE_PT3 = 3;

/** Betaflight cutoff corrections so PTn cascades hit -3 dB at the set cutoff */
const PT2_CUTOFF_CORRECTION = 1.553773974;
const PT3_CUTOFF_CORRECTION = 1.961459177;

/** Attenuation floor for display — notches are mathematically -∞ at center */
export const FILTER_RESPONSE_FLOOR_DB = -60;

/** PT1 lowpass magnitude in dB at frequency f for cutoff fc */
export function pt1MagnitudeDb(f: number, fc: number): number {
  if (fc <= 0) return 0;
  const r = f / fc;
  return -10 * Math.log10(1 + r * r);
}

/** PTn cascade magnitude in dB (BF cutoff-corrected so -3 dB lands at fc) */
export function ptnMagnitudeDb(f: number, fc: number, order: 2 | 3): number {
  if (fc <= 0) return 0;
  const correction = order === 2 ? PT2_CUTOFF_CORRECTION : PT3_CUTOFF_CORRECTION;
  return order * pt1MagnitudeDb(f, fc * correction);
}

/** Biquad (Butterworth, Q = 1/√2) lowpass magnitude in dB */
export function biquadLpfMagnitudeDb(f: number, fc: number): number {
  if (fc <= 0) return 0;
  const r = f / fc;
  const q = Math.SQRT1_2;
  const denom = (1 - r * r) * (1 - r * r) + (r / q) * (r / q);
  return -10 * Math.log10(denom);
}

/** Notch magnitude in dB for center frequency fc and quality factor q */
export function notchMagnitudeDb(f: number, fc: number, q: number): number {
  if (fc <= 0 || q <= 0) return 0;
  const r = f / fc;
  const num = (1 - r * r) * (1 - r * r);
  const denom = num + (r / q) * (r / q);
  if (num <= 0 || denom <= 0) return FILTER_RESPONSE_FLOOR_DB;
  return Math.max(10 * Math.log10(num / denom), FILTER_RESPONSE_FLOOR_DB);
}

/** Magnitude of one lowpass stage by Betaflight filter type */
export function lowpassMagnitudeDb(f: number, fc: number, type: number | undefined): number {
  switch (type) {
    case FILTER_TYPE_BIQUAD:
      return biquadLpfMagnitudeDb(f, fc);
    case FILTER_TYPE_PT2:
      return ptnMagnitudeDb(f, fc, 2);
    case FILTER_TYPE_PT3:
      return ptnMagnitudeDb(f, fc, 3);
    case FILTER_TYPE_PT1:
    default:
      return pt1MagnitudeDb(f, fc);
  }
}

/**
 * Dynamic lowpass cutoff at a given throttle — Betaflight's dynLpfCutoffFreq.
 * @param throttleNorm - normalized throttle 0..1
 * @param expo - dyn expo setting 0-10 (0 = linear)
 */
export function dynLpfCutoffHz(
  throttleNorm: number,
  minHz: number,
  maxHz: number,
  expo: number
): number {
  const t = Math.min(1, Math.max(0, throttleNorm));
  const expof = expo / 10;
  const curve = t * (1 - t) * expof + t;
  return (maxHz - minHz) * curve + minHz;
}

/** One lowpass stage of a filter chain */
interface ChainStage {
  cutoffHz: number;
  type: number | undefined;
}

/** Resolve the active lowpass stages for a chain at a given throttle */
function resolveChainStages(
  settings: CurrentFilterSettings,
  chain: 'gyro' | 'dterm',
  throttleNorm: number
): ChainStage[] {
  const stages: ChainStage[] = [];

  if (chain === 'gyro') {
    const dynMin = settings.gyro_lpf1_dyn_min_hz ?? 0;
    if (dynMin > 0) {
      const dynMax = settings.gyro_lpf1_dyn_max_hz ?? dynMin * 2;
      const expo = settings.gyro_lpf1_dyn_expo ?? 5;
      stages.push({
        cutoffHz: dynLpfCutoffHz(throttleNorm, dynMin, dynMax, expo),
        type: settings.gyro_lpf1_type,
      });
    } else if (settings.gyro_lpf1_static_hz > 0) {
      stages.push({ cutoffHz: settings.gyro_lpf1_static_hz, type: settings.gyro_lpf1_type });
    }
    if (settings.gyro_lpf2_static_hz > 0) {
      stages.push({ cutoffHz: settings.gyro_lpf2_static_hz, type: settings.gyro_lpf2_type });
    }
  } else {
    const dynMin = settings.dterm_lpf1_dyn_min_hz ?? 0;
    if (dynMin > 0) {
      const dynMax = settings.dterm_lpf1_dyn_max_hz ?? dynMin * 2;
      const expo = settings.dterm_lpf1_dyn_expo ?? 5;
      stages.push({
        cutoffHz: dynLpfCutoffHz(throttleNorm, dynMin, dynMax, expo),
        type: settings.dterm_lpf1_type,
      });
    } else if (settings.dterm_lpf1_static_hz > 0) {
      stages.push({ cutoffHz: settings.dterm_lpf1_static_hz, type: settings.dterm_lpf1_type });
    }
    if (settings.dterm_lpf2_static_hz > 0) {
      stages.push({ cutoffHz: settings.dterm_lpf2_static_hz, type: settings.dterm_lpf2_type });
    }
  }

  return stages;
}

/**
 * Combined lowpass-chain magnitude in dB at the given frequencies.
 *
 * Dynamic lowpasses are evaluated at `throttleNorm` (default 0.5 — cruise).
 * Returns null when the chain has no active lowpass stage (nothing to draw).
 */
export function computeFilterChainCurve(
  settings: CurrentFilterSettings,
  chain: 'gyro' | 'dterm',
  frequencies: number[],
  throttleNorm = 0.5
): number[] | null {
  const stages = resolveChainStages(settings, chain, throttleNorm);
  if (stages.length === 0) return null;

  return frequencies.map((f) => {
    let db = 0;
    for (const stage of stages) {
      db += lowpassMagnitudeDb(f, stage.cutoffHz, stage.type);
    }
    return Math.max(db, FILTER_RESPONSE_FLOOR_DB);
  });
}

/**
 * Gyro LPF1 cutoff as a function of throttle for the spectrogram overlay.
 * Static configs return the same cutoff for every throttle; disabled LPF1
 * (static 0, dynamic off) returns null.
 */
export function gyroLpf1CutoffAtThrottle(
  settings: CurrentFilterSettings,
  throttleNorm: number
): number | null {
  const dynMin = settings.gyro_lpf1_dyn_min_hz ?? 0;
  if (dynMin > 0) {
    const dynMax = settings.gyro_lpf1_dyn_max_hz ?? dynMin * 2;
    const expo = settings.gyro_lpf1_dyn_expo ?? 5;
    return dynLpfCutoffHz(throttleNorm, dynMin, dynMax, expo);
  }
  return settings.gyro_lpf1_static_hz > 0 ? settings.gyro_lpf1_static_hz : null;
}
