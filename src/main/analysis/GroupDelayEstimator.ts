/**
 * Filter group delay estimator.
 *
 * Computes the approximate group delay (phase delay) of Betaflight's
 * gyro and D-term filter chains. Group delay directly impacts PID
 * response latency — excessive delay causes sluggish response and
 * can create instability through phase lag.
 *
 * BF filter stack (BF 4.3+ defaults all lowpasses to PT1; biquad/PT2/PT3
 * remain CLI options but are not the default):
 * - Gyro path: LPF1 (PT1) → LPF2 (PT1) → dynamic notch(es)
 * - D-term path: LPF1 (PT1) → LPF2 (PT1)
 *
 * Group delay for a first-order PT1 lowpass at frequency f:
 *   τ(f) = 1 / (2π * fc * (1 + (f/fc)²))
 *
 * Group delay for a second-order biquad lowpass (Q≈0.707) at frequency f:
 *   τ(f) ≈ (2 * fc) / (2π * ((fc² - f²)² + (f * fc / Q)²)) * (fc² + f²)
 *   Simplified at low frequencies (f << fc): τ ≈ Q / (π * fc)
 *
 * For practical drone tuning, we compute group delay at a reference
 * frequency (default: 80 Hz, typical control bandwidth) and sum the
 * chain. This gives pilots actionable latency numbers.
 */
import type {
  CurrentFilterSettings,
  FilterGroupDelay,
  SingleFilterDelay,
} from '@shared/types/analysis.types';
import type { DroneSize } from '@shared/types/profile.types';
import {
  FILTER_LATENCY_BUDGET_BY_SIZE,
  FILTER_LATENCY_BUDGET_DEFAULT,
  type FilterLatencyBudget,
} from './constants';

/** Default reference frequency for group delay computation (Hz) */
export const GROUP_DELAY_REFERENCE_HZ = 80;

/** Group delay threshold above which a warning is issued (ms) — legacy
 * fallback; the per-size budgets in constants.ts take precedence. */
export const GROUP_DELAY_WARNING_MS = 2.0;

/** Resolve the latency budget for a drone size (default when size unknown) */
export function resolveLatencyBudget(droneSize?: DroneSize): FilterLatencyBudget {
  return (droneSize && FILTER_LATENCY_BUDGET_BY_SIZE[droneSize]) || FILTER_LATENCY_BUDGET_DEFAULT;
}

/**
 * Compute group delay of a first-order PT1 lowpass filter at a given frequency.
 *
 * @param cutoffHz - Filter cutoff frequency in Hz
 * @param freqHz - Frequency at which to evaluate group delay
 * @returns Group delay in seconds
 */
export function pt1GroupDelay(cutoffHz: number, freqHz: number): number {
  if (cutoffHz <= 0) return 0;
  const wc = 2 * Math.PI * cutoffHz;
  const w = 2 * Math.PI * freqHz;
  // τ(ω) = ωc / (ωc² + ω²)  [derived from d(phase)/dω of H(s) = ωc/(s+ωc)]
  return wc / (wc * wc + w * w);
}

/**
 * Compute group delay of a second-order biquad lowpass filter at a given frequency.
 * Uses standard Q = 1/√2 (Butterworth).
 *
 * @param cutoffHz - Filter cutoff frequency in Hz
 * @param freqHz - Frequency at which to evaluate group delay
 * @param Q - Quality factor (default: 1/√2 for Butterworth)
 * @returns Group delay in seconds
 */
export function biquadGroupDelay(
  cutoffHz: number,
  freqHz: number,
  Q: number = Math.SQRT1_2
): number {
  if (cutoffHz <= 0) return 0;
  const w0 = 2 * Math.PI * cutoffHz;
  const w = 2 * Math.PI * freqHz;

  // For a 2nd-order lowpass H(s) = w0² / (s² + (w0/Q)*s + w0²)
  // Group delay: τ(ω) = (w0/Q * (w0² + ω²)) / ((w0² - ω²)² + (w0*ω/Q)²)
  const w0sq = w0 * w0;
  const wsq = w * w;
  const num = (w0 / Q) * (w0sq + wsq);
  const denom = (w0sq - wsq) * (w0sq - wsq) + ((w0 * w) / Q) * ((w0 * w) / Q);

  if (denom === 0) return 0;
  return num / denom;
}

/**
 * Compute group delay of a notch filter at a given frequency.
 * BF dynamic notch is a biquad notch with configurable Q.
 *
 * For a notch filter: maximum group delay occurs near the notch frequency.
 * Away from the notch, the delay is minimal.
 *
 * @param notchHz - Notch center frequency in Hz
 * @param freqHz - Frequency at which to evaluate group delay
 * @param Q - Quality factor (higher Q = narrower notch, less delay outside)
 * @returns Group delay in seconds
 */
export function notchGroupDelay(notchHz: number, freqHz: number, Q: number = 3.0): number {
  if (notchHz <= 0) return 0;
  const w0 = 2 * Math.PI * notchHz;
  const w = 2 * Math.PI * freqHz;

  // Notch: H(s) = (s² + w0²) / (s² + (w0/Q)*s + w0²)
  // At s = jω the numerator (w0² − ω²) is purely real, so its phase
  // derivative is zero almost everywhere — the group delay comes from
  // the denominator alone:
  //   τ(ω) = bw * (w0² + ω²) / ((w0² − ω²)² + bw²ω²),  bw = w0/Q
  // Sanity anchor (BF filtering doc): phase is 90° at center, 45° at the
  // −3 dB edges — ≈1 ms for a wide notch centered near 250 Hz.
  const w0sq = w0 * w0;
  const wsq = w * w;
  const bw = w0 / Q;

  return (bw * (w0sq + wsq)) / ((w0sq - wsq) * (w0sq - wsq) + bw * bw * wsq);
}

/**
 * Estimate the group delay of the current filter configuration.
 *
 * BF 4.3+ defaults every gyro/D-term lowpass (LPF1 and LPF2) to PT1.
 * Biquad remains a CLI option but modeling it by default would
 * overestimate LPF2 delay by roughly 2× (BF doc: PT1 ≈ 1 ms @ 100 Hz,
 * biquad ≈ 2 ms @ 100 Hz).
 *
 * @param settings - Current filter settings from the FC
 * @param referenceHz - Frequency at which to compute delay (default: 80 Hz)
 * @param droneSize - When provided, delay is judged against the per-size
 *   latency budget (P2.7) instead of the fixed 2 ms threshold
 * @returns Group delay breakdown
 */
export function estimateGroupDelay(
  settings: CurrentFilterSettings,
  referenceHz: number = GROUP_DELAY_REFERENCE_HZ,
  droneSize?: DroneSize
): FilterGroupDelay {
  const filters: SingleFilterDelay[] = [];
  let gyroTotalS = 0;
  let dtermTotalS = 0;

  // Gyro LPF1: use dyn_min when dynamic is active (tightest point = worst-case delay)
  const gyroDynActive = (settings.gyro_lpf1_dyn_min_hz ?? 0) > 0;
  const effectiveGyroLpf1 = gyroDynActive
    ? settings.gyro_lpf1_dyn_min_hz!
    : settings.gyro_lpf1_static_hz;
  if (effectiveGyroLpf1 > 0) {
    const delay = pt1GroupDelay(effectiveGyroLpf1, referenceHz);
    gyroTotalS += delay;
    filters.push({
      type: 'gyro_lpf1',
      cutoffHz: effectiveGyroLpf1,
      delayMs: delay * 1000,
    });
  }

  // Gyro LPF2 (PT1 by default in BF 4.3+)
  if (settings.gyro_lpf2_static_hz > 0) {
    const delay = pt1GroupDelay(settings.gyro_lpf2_static_hz, referenceHz);
    gyroTotalS += delay;
    filters.push({
      type: 'gyro_lpf2',
      cutoffHz: settings.gyro_lpf2_static_hz,
      delayMs: delay * 1000,
    });
  }

  // Dynamic notch (contributes to gyro path delay)
  if (settings.dyn_notch_min_hz > 0 && settings.dyn_notch_max_hz > 0) {
    const notchCenter = (settings.dyn_notch_min_hz + settings.dyn_notch_max_hz) / 2;
    const Q = settings.dyn_notch_q ?? 300;
    // Q in BF is stored as Q*100 internally, but our settings use actual Q
    const actualQ = Q > 10 ? Q / 100 : Q;
    const count = settings.dyn_notch_count ?? 3;
    // Each notch adds some delay; worst case is when tracking near reference freq
    const delay = notchGroupDelay(notchCenter, referenceHz, actualQ) * count;
    gyroTotalS += delay;
    filters.push({
      type: 'dyn_notch',
      cutoffHz: notchCenter,
      delayMs: delay * 1000,
    });
  }

  // D-term LPF1: use dyn_min when dynamic is active
  const dtermDynActive = (settings.dterm_lpf1_dyn_min_hz ?? 0) > 0;
  const effectiveDtermLpf1 = dtermDynActive
    ? settings.dterm_lpf1_dyn_min_hz!
    : settings.dterm_lpf1_static_hz;
  if (effectiveDtermLpf1 > 0) {
    const delay = pt1GroupDelay(effectiveDtermLpf1, referenceHz);
    dtermTotalS += delay;
    filters.push({
      type: 'dterm_lpf1',
      cutoffHz: effectiveDtermLpf1,
      delayMs: delay * 1000,
    });
  }

  // D-term LPF2 (PT1 by default in BF 4.3+)
  if (settings.dterm_lpf2_static_hz > 0) {
    const delay = pt1GroupDelay(settings.dterm_lpf2_static_hz, referenceHz);
    dtermTotalS += delay;
    filters.push({
      type: 'dterm_lpf2',
      cutoffHz: settings.dterm_lpf2_static_hz,
      delayMs: delay * 1000,
    });
  }

  const gyroTotalMs = gyroTotalS * 1000;
  const dtermTotalMs = dtermTotalS * 1000;

  const budget = resolveLatencyBudget(droneSize);
  const gyroOverBudget = gyroTotalMs > budget.gyroMs;
  const dtermOverBudget = dtermTotalMs > budget.dtermMs;

  let warning: string | undefined;
  if (gyroOverBudget) {
    warning =
      `Gyro filter chain adds ${gyroTotalMs.toFixed(1)}ms of delay at ${referenceHz} Hz — ` +
      `over the ${budget.gyroMs.toFixed(1)}ms latency budget${droneSize ? ` for a ${droneSize} quad` : ''}. ` +
      'This may cause sluggish response. Consider raising cutoff frequencies or using RPM filter to reduce reliance on software filters.';
  }

  return {
    filters,
    gyroTotalMs: Math.round(gyroTotalMs * 100) / 100,
    dtermTotalMs: Math.round(dtermTotalMs * 100) / 100,
    referenceFreqHz: referenceHz,
    ...(warning ? { warning } : {}),
    gyroBudgetMs: budget.gyroMs,
    dtermBudgetMs: budget.dtermMs,
    gyroOverBudget,
    dtermOverBudget,
  };
}
