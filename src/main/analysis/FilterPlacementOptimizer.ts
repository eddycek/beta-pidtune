/**
 * Filter placement optimizer (P3.3).
 *
 * Discrete search over the gyro filter configuration space (LPF1 cutoff,
 * LPF2 on/off, dynamic notch count/Q) minimizing group delay subject to an
 * attenuation constraint on every measured noise peak: each significant peak
 * must be knocked down to the residual target using the magnitude models from
 * filterResponse.ts plus an effective per-notch depth for the SDFT dynamic
 * notch.
 *
 * The result is advisory — it shows the pilot the latency-optimal way to
 * cover the peaks their quad actually produces, next to what their current
 * config costs. It never auto-applies.
 */
import type {
  NoiseProfile,
  NoisePeak,
  CurrentFilterSettings,
  FilterRecommendation,
} from '@shared/types/analysis.types';
import type { DroneSize } from '@shared/types/profile.types';
import { lowpassMagnitudeDb } from '@shared/utils/filterResponse';
import { pt1GroupDelay, notchGroupDelay, resolveLatencyBudget } from './GroupDelayEstimator';
import { RESONANCE_ACTION_THRESHOLD_DB } from './constants';

/** Residual noise target: peaks must be attenuated to ≤ this above the floor */
export const OPT_RESIDUAL_TARGET_DB = 6;
/** Effective attenuation of one SDFT dynamic notch at its tracked peak */
export const OPT_NOTCH_EFFECTIVE_DB = -20;
/** Reference frequency for the group-delay objective */
export const OPT_REFERENCE_HZ = 80;
/** Minimum delay improvement (ms) worth surfacing to the pilot */
export const OPT_MIN_IMPROVEMENT_MS = 0.3;

/** Candidate gyro LPF1 cutoffs (0 = disabled, only allowed with RPM filter) */
const LPF1_CANDIDATES = [0, 100, 150, 200, 250, 300, 400, 500];
/** Candidate gyro LPF2 cutoffs */
const LPF2_CANDIDATES = [0, 250, 500];
/** Candidate dynamic notch counts */
const NOTCH_COUNT_CANDIDATES = [0, 1, 2, 3];
/** Candidate dynamic notch Q values */
const NOTCH_Q_CANDIDATES = [300, 500];

/** One evaluated filter configuration */
export interface FilterPlacementCandidate {
  gyro_lpf1_static_hz: number;
  gyro_lpf2_static_hz: number;
  dyn_notch_count: number;
  dyn_notch_q: number;
  /** Total gyro-chain group delay at the reference frequency (ms) */
  delayMs: number;
}

/** Optimizer output */
export interface FilterPlacementResult {
  /** Whether any candidate covered every peak */
  feasible: boolean;
  /** The latency-optimal feasible configuration */
  best?: FilterPlacementCandidate;
  /** Group delay of the CURRENT configuration (ms, same model) */
  currentDelayMs: number;
  /** best.delayMs − currentDelayMs (negative = the optimizer found a faster config) */
  deltaMs?: number;
  /** The peaks the optimization constrained on */
  peaks: { frequencyHz: number; amplitudeDb: number }[];
}

/** Collect the unique significant roll/pitch peaks the optimizer must cover */
function collectPeaks(noise: NoiseProfile): NoisePeak[] {
  const peaks: NoisePeak[] = [];
  for (const axis of [noise.roll, noise.pitch]) {
    for (const peak of axis.peaks) {
      if (peak.amplitude < RESONANCE_ACTION_THRESHOLD_DB) continue;
      const dup = peaks.find((p) => Math.abs(p.frequency - peak.frequency) < 10);
      if (dup) {
        if (peak.amplitude > dup.amplitude) {
          peaks[peaks.indexOf(dup)] = peak;
        }
        continue;
      }
      peaks.push(peak);
    }
  }
  // Strongest first — dynamic notches track the strongest peaks
  return peaks.sort((a, b) => b.amplitude - a.amplitude);
}

/** Gyro-chain group delay of a candidate at the reference frequency (ms) */
function candidateDelayMs(
  lpf1Hz: number,
  lpf2Hz: number,
  notchCount: number,
  notchQ: number,
  notchCenterHz: number
): number {
  let delayS = 0;
  if (lpf1Hz > 0) delayS += pt1GroupDelay(lpf1Hz, OPT_REFERENCE_HZ);
  if (lpf2Hz > 0) delayS += pt1GroupDelay(lpf2Hz, OPT_REFERENCE_HZ);
  if (notchCount > 0) {
    const actualQ = notchQ > 10 ? notchQ / 100 : notchQ;
    delayS += notchGroupDelay(notchCenterHz, OPT_REFERENCE_HZ, actualQ) * notchCount;
  }
  return delayS * 1000;
}

/** Residual level of one peak (dB above floor) under a candidate config.
 * The dynamic notch covers the `notchCount` strongest peaks inside its range. */
function residualDb(
  peak: NoisePeak,
  peakRank: number,
  lpf1Hz: number,
  lpf2Hz: number,
  notchCount: number,
  notchMinHz: number,
  notchMaxHz: number
): number {
  let attenuation = 0;
  attenuation += lowpassMagnitudeDb(peak.frequency, lpf1Hz, undefined); // PT1 (BF default)
  attenuation += lowpassMagnitudeDb(peak.frequency, lpf2Hz, undefined);
  const notchCovers =
    peakRank < notchCount && peak.frequency >= notchMinHz && peak.frequency <= notchMaxHz;
  if (notchCovers) attenuation += OPT_NOTCH_EFFECTIVE_DB;
  return peak.amplitude + attenuation;
}

/**
 * Search the discrete configuration space for the minimum-delay config that
 * attenuates every significant peak to the residual target.
 */
export function optimizeFilterPlacement(
  noise: NoiseProfile,
  current: CurrentFilterSettings,
  rpmActive: boolean,
  droneSize?: DroneSize
): FilterPlacementResult | null {
  const peaks = collectPeaks(noise);
  if (peaks.length === 0) return null; // nothing to optimize against

  const notchMinHz = current.dyn_notch_min_hz > 0 ? current.dyn_notch_min_hz : 100;
  const notchMaxHz = current.dyn_notch_max_hz > 0 ? current.dyn_notch_max_hz : 600;
  const notchCenter = (notchMinHz + notchMaxHz) / 2;

  // Current config's delay under the same model (fair comparison)
  const currentDelayMs = candidateDelayMs(
    (current.gyro_lpf1_dyn_min_hz ?? 0) > 0
      ? current.gyro_lpf1_dyn_min_hz!
      : current.gyro_lpf1_static_hz,
    current.gyro_lpf2_static_hz,
    current.dyn_notch_count ?? 3,
    current.dyn_notch_q ?? 300,
    notchCenter
  );

  let best: FilterPlacementCandidate | undefined;

  for (const lpf1 of LPF1_CANDIDATES) {
    if (lpf1 === 0 && !rpmActive) continue; // disabling LPF1 requires RPM coverage
    for (const lpf2 of LPF2_CANDIDATES) {
      if (lpf1 === 0 && lpf2 === 0) continue; // no lowpass at all is never safe
      for (const notchCount of NOTCH_COUNT_CANDIDATES) {
        for (const notchQ of NOTCH_Q_CANDIDATES) {
          // Feasibility: every peak at or below the residual target
          let feasible = true;
          for (let rank = 0; rank < peaks.length; rank++) {
            const res = residualDb(
              peaks[rank],
              rank,
              lpf1,
              lpf2,
              notchCount,
              notchMinHz,
              notchMaxHz
            );
            if (res > OPT_RESIDUAL_TARGET_DB) {
              feasible = false;
              break;
            }
          }
          if (!feasible) continue;

          const delayMs = candidateDelayMs(lpf1, lpf2, notchCount, notchQ, notchCenter);
          if (
            !best ||
            delayMs < best.delayMs - 1e-9 ||
            // Tie-break: prefer the higher LPF1 cutoff (less phase lag off-reference)
            (Math.abs(delayMs - best.delayMs) < 1e-9 && lpf1 > best.gyro_lpf1_static_hz)
          ) {
            best = {
              gyro_lpf1_static_hz: lpf1,
              gyro_lpf2_static_hz: lpf2,
              dyn_notch_count: notchCount,
              dyn_notch_q: notchQ,
              delayMs: Math.round(delayMs * 100) / 100,
            };
          }
        }
      }
    }
  }

  return {
    feasible: best !== undefined,
    ...(best ? { best } : {}),
    currentDelayMs: Math.round(currentDelayMs * 100) / 100,
    ...(best ? { deltaMs: Math.round((best.delayMs - currentDelayMs) * 100) / 100 } : {}),
    peaks: peaks.map((p) => ({
      frequencyHz: Math.round(p.frequency),
      amplitudeDb: Math.round(p.amplitude * 10) / 10,
    })),
  };
}

/**
 * Turn an optimizer result into an informational recommendation when it found
 * a configuration meaningfully faster than the current one. Advisory only —
 * the discrete model ignores nuances (dyn LPF tracking, D-term path) that the
 * pilot should weigh.
 */
export function recommendFilterPlacement(
  result: FilterPlacementResult | null,
  droneSize?: DroneSize
): FilterRecommendation | undefined {
  if (!result || !result.feasible || !result.best || result.deltaMs === undefined) return undefined;
  if (result.deltaMs > -OPT_MIN_IMPROVEMENT_MS) return undefined;

  const b = result.best;
  const budget = resolveLatencyBudget(droneSize);
  return {
    setting: 'gyro_lpf1_static_hz',
    currentValue: 0,
    recommendedValue: 0,
    reason:
      `Filter placement optimizer: your measured noise peaks (${result.peaks
        .map((p) => `${p.frequencyHz} Hz`)
        .join(', ')}) can be covered with ${Math.abs(result.deltaMs).toFixed(1)} ms less gyro ` +
      `filter delay: gyro LPF1 ${b.gyro_lpf1_static_hz === 0 ? 'off' : `${b.gyro_lpf1_static_hz} Hz`}, ` +
      `LPF2 ${b.gyro_lpf2_static_hz === 0 ? 'off' : `${b.gyro_lpf2_static_hz} Hz`}, ` +
      `${b.dyn_notch_count} dynamic notch${b.dyn_notch_count === 1 ? '' : 'es'} (Q ${b.dyn_notch_q}). ` +
      `Estimated chain delay ${b.delayMs.toFixed(1)} ms vs ${result.currentDelayMs.toFixed(1)} ms now ` +
      `(budget ${budget.gyroMs.toFixed(1)} ms).`,
    impact: 'latency',
    confidence: 'low',
    informational: true,
    ruleId: 'F-OPT-PLACEMENT',
    evidence: {
      measurements: [
        { label: 'Current chain delay', value: `${result.currentDelayMs.toFixed(1)} ms` },
        { label: 'Optimized chain delay', value: `${b.delayMs.toFixed(1)} ms` },
        ...result.peaks.map((p) => ({
          label: `Peak ${p.frequencyHz} Hz`,
          value: `${p.amplitudeDb} dB above floor`,
        })),
      ],
      trigger: `All peaks attenuable to ≤ ${OPT_RESIDUAL_TARGET_DB} dB with ≥ ${OPT_MIN_IMPROVEMENT_MS} ms less delay`,
    },
  };
}
