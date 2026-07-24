/**
 * RPM filter tuning rules (P2.6).
 *
 * Uses measured harmonic tracks (throttle-spectrogram reclassification, P2.2)
 * and the dynamic-idle floor to tune rpm_filter_min_hz, rpm_filter_harmonics,
 * rpm_filter_fade_range_hz and (advisory, BF 4.5+) rpm_filter_weights.
 *
 * All rules require an active RPM filter. Latency awareness: min_hz is never
 * pushed below the frequency the motors can actually reach (deep low-frequency
 * notches cost delay for nothing), and harmonic count is only raised when a
 * measured track proves an unfiltered harmonic order exists.
 */
import type {
  NoiseProfile,
  NoisePeak,
  FilterRecommendation,
  CurrentFilterSettings,
} from '@shared/types/analysis.types';
import type { DroneSize } from '@shared/types/profile.types';
import {
  RPM_MIN_HZ_IDLE_RATIO,
  RPM_MIN_HZ_TRACK_RATIO,
  RPM_MIN_HZ_FLOOR,
  RPM_MIN_HZ_CEILING,
  RPM_MIN_HZ_DEADZONE_HZ,
  RPM_HARMONIC_RATIO_TOLERANCE,
  RPM_HARMONICS_MAX,
  RPM_FADE_RANGE_DEFAULT_HZ,
  RPM_FILTER_WEIGHTS_BY_SIZE,
  RESONANCE_ACTION_THRESHOLD_DB,
} from './constants';

/** A motor-harmonic peak with its measured throttle track */
interface TrackedPeak {
  peak: NoisePeak;
  /** Median frequency across the measured track (robust vs outlier bands) */
  medianHz: number;
  /** Lowest frequency the track was observed at (lowest throttle band) */
  minHz: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Collect unique motor-harmonic peaks that carry a measured throttle track,
 * across all three axes. Peaks within 10 Hz median of an already-collected
 * one are treated as the same physical source (same harmonic on another axis).
 */
function collectTrackedMotorPeaks(noise: NoiseProfile): TrackedPeak[] {
  const tracked: TrackedPeak[] = [];
  for (const axis of [noise.roll, noise.pitch, noise.yaw]) {
    for (const peak of axis.peaks) {
      if (peak.type !== 'motor_harmonic' || !peak.throttleTrack) continue;
      const medianHz = median(peak.throttleTrack.frequencyHz);
      const duplicate = tracked.find((t) => Math.abs(t.medianHz - medianHz) < 10);
      if (duplicate) {
        // Keep the stronger observation of the same source
        if (peak.amplitude > duplicate.peak.amplitude) {
          duplicate.peak = peak;
        }
        continue;
      }
      tracked.push({
        peak,
        medianHz,
        minHz: Math.min(...peak.throttleTrack.frequencyHz),
      });
    }
  }
  return tracked.sort((a, b) => a.medianHz - b.medianHz);
}

/**
 * Generate RPM filter tuning recommendations.
 * Returns an empty array when the RPM filter is not active.
 */
export function recommendRpmFilterTuning(
  noise: NoiseProfile,
  current: CurrentFilterSettings,
  droneSize?: DroneSize
): FilterRecommendation[] {
  if ((current.rpm_filter_harmonics ?? 0) <= 0) return [];

  const out: FilterRecommendation[] = [];
  const trackedPeaks = collectTrackedMotorPeaks(noise);

  recommendMinHz(current, trackedPeaks, out);
  recommendHarmonicCount(current, trackedPeaks, out);
  recommendFadeRange(current, out);
  recommendWeights(current, droneSize, out);

  return out;
}

/**
 * Rule F-RPM-MIN-IDLE / F-RPM-MIN-TRACK: align rpm_filter_min_hz with the
 * lowest frequency the notches actually need to reach.
 *
 * With dynamic idle active the motors never spin below the idle floor, so the
 * fundamental never drops below idleHz = dyn_idle_min_rpm × 100 / 60. The
 * notch floor belongs just below that: higher leaves a low-throttle gap
 * (noise), much lower buys nothing and costs delay during throttle chops.
 *
 * Without dynamic-idle information, only a measured fundamental track that
 * reaches BELOW the current floor justifies lowering it (the flight proves the
 * gap exists). Raising from track data alone is unsafe — the flight may simply
 * not have visited low throttle.
 */
function recommendMinHz(
  current: CurrentFilterSettings,
  trackedPeaks: TrackedPeak[],
  out: FilterRecommendation[]
): void {
  const minHz = current.rpm_filter_min_hz;
  if (minHz === undefined) return;

  const dynIdle = current.dyn_idle_min_rpm ?? 0;
  if (dynIdle > 0) {
    const idleHz = (dynIdle * 100) / 60;
    const target = clamp(
      Math.round(idleHz * RPM_MIN_HZ_IDLE_RATIO),
      RPM_MIN_HZ_FLOOR,
      RPM_MIN_HZ_CEILING
    );
    if (Math.abs(minHz - target) <= RPM_MIN_HZ_DEADZONE_HZ) return;

    if (minHz > idleHz) {
      // Floor above the idle fundamental — uncovered gap at low throttle
      out.push({
        setting: 'rpm_filter_min_hz',
        currentValue: minHz,
        recommendedValue: target,
        reason:
          `Dynamic idle holds your motors at or above ${Math.round(idleHz)} Hz, but the RPM ` +
          `notches stop at ${minHz} Hz — motor noise between ${Math.round(idleHz)} and ${minHz} Hz ` +
          `is unfiltered at low throttle. Lowering rpm_filter_min_hz to ${target} lets the ` +
          'notches cover the full RPM range.',
        impact: 'noise',
        confidence: 'medium',
        ruleId: 'F-RPM-MIN-IDLE',
        evidence: {
          measurements: [
            {
              label: 'Dynamic idle floor',
              value: `${dynIdle * 100} RPM (${Math.round(idleHz)} Hz)`,
            },
            { label: 'Current rpm_filter_min_hz', value: `${minHz} Hz` },
          ],
          trigger: `Notch floor above the idle fundamental leaves ${Math.round(idleHz)}-${minHz} Hz uncovered`,
        },
      });
    } else {
      // Floor far below anything the motors can reach — wasted low-frequency notching
      out.push({
        setting: 'rpm_filter_min_hz',
        currentValue: minHz,
        recommendedValue: target,
        reason:
          `Dynamic idle keeps your motors at or above ${Math.round(idleHz)} Hz, so RPM notches ` +
          `below that never track real motor noise. Raising rpm_filter_min_hz from ${minHz} to ` +
          `${target} avoids deep low-frequency notches (and their delay) during throttle chops.`,
        impact: 'latency',
        confidence: 'low',
        ruleId: 'F-RPM-MIN-IDLE',
      });
    }
    return;
  }

  // No dynamic-idle info — use the measured fundamental track (lowest tracked peak)
  if (trackedPeaks.length === 0) return;
  const fundamental = trackedPeaks[0];
  if (fundamental.minHz < minHz - RPM_MIN_HZ_DEADZONE_HZ) {
    const target = clamp(
      Math.round(fundamental.minHz * RPM_MIN_HZ_TRACK_RATIO),
      RPM_MIN_HZ_FLOOR,
      RPM_MIN_HZ_CEILING
    );
    if (target >= minHz) return;
    out.push({
      setting: 'rpm_filter_min_hz',
      currentValue: minHz,
      recommendedValue: target,
      reason:
        `The measured motor fundamental reached down to ${Math.round(fundamental.minHz)} Hz in ` +
        `this flight, below your rpm_filter_min_hz of ${minHz} — the notches could not follow ` +
        `it there. Lowering the floor to ${target} keeps motor noise covered at low throttle.`,
      impact: 'noise',
      confidence: 'medium',
      ruleId: 'F-RPM-MIN-TRACK',
      evidence: {
        measurements: [
          { label: 'Lowest tracked fundamental', value: `${Math.round(fundamental.minHz)} Hz` },
          { label: 'Current rpm_filter_min_hz', value: `${minHz} Hz` },
        ],
        trigger: 'Measured fundamental track reaches below the notch floor',
        anchorFrequencyHz: fundamental.peak.frequency,
      },
    });
  }
}

/**
 * Rule F-RPM-HARM-UP: a measured track at ~k× the fundamental with k above the
 * current harmonic count proves an unfiltered harmonic order — raise the count.
 * Requires the residual peak to be strong enough to act on (≥ resonance
 * threshold) and the frequency ratio to sit close to an integer.
 */
function recommendHarmonicCount(
  current: CurrentFilterSettings,
  trackedPeaks: TrackedPeak[],
  out: FilterRecommendation[]
): void {
  const harmonics = current.rpm_filter_harmonics ?? 0;
  if (harmonics <= 0 || harmonics >= RPM_HARMONICS_MAX) return;
  if (trackedPeaks.length < 2) return;

  const fundamental = trackedPeaks[0];
  let bestOrder = 0;
  let bestPeak: TrackedPeak | undefined;

  for (const tracked of trackedPeaks.slice(1)) {
    if (tracked.peak.amplitude < RESONANCE_ACTION_THRESHOLD_DB) continue;
    const ratio = tracked.medianHz / fundamental.medianHz;
    const order = Math.round(ratio);
    if (Math.abs(ratio - order) > RPM_HARMONIC_RATIO_TOLERANCE) continue;
    if (order <= harmonics || order > RPM_HARMONICS_MAX) continue;
    if (order > bestOrder) {
      bestOrder = order;
      bestPeak = tracked;
    }
  }

  if (bestOrder > 0 && bestPeak) {
    out.push({
      setting: 'rpm_filter_harmonics',
      currentValue: harmonics,
      recommendedValue: bestOrder,
      reason:
        `A throttle-tracking noise peak at ~${Math.round(bestPeak.medianHz)} Hz measures ` +
        `${bestOrder}× your motor fundamental (~${Math.round(fundamental.medianHz)} Hz), but ` +
        `rpm_filter_harmonics is ${harmonics} so that harmonic is unfiltered. Raising it to ` +
        `${bestOrder} adds an exact notch on the measured harmonic.`,
      impact: 'noise',
      confidence: 'medium',
      ruleId: 'F-RPM-HARM-UP',
      evidence: {
        measurements: [
          { label: 'Fundamental track', value: `~${Math.round(fundamental.medianHz)} Hz` },
          { label: 'Residual harmonic track', value: `~${Math.round(bestPeak.medianHz)} Hz` },
          {
            label: 'Frequency ratio',
            value: `${(bestPeak.medianHz / fundamental.medianHz).toFixed(2)}× (order ${bestOrder})`,
          },
        ],
        trigger: `Tracked peak at an integer multiple above the current harmonic count (${harmonics})`,
        anchorFrequencyHz: bestPeak.peak.frequency,
      },
    });
  }
}

/**
 * Rule F-RPM-FADE: fade disabled (0) hard-stops the notches at min_hz.
 * The BF default of 50 Hz fades them out gradually below the floor,
 * smoothing the transition during throttle chops. Advisory only.
 */
function recommendFadeRange(current: CurrentFilterSettings, out: FilterRecommendation[]): void {
  if (current.rpm_filter_fade_range_hz !== 0) return;
  out.push({
    setting: 'rpm_filter_fade_range_hz',
    currentValue: 0,
    recommendedValue: RPM_FADE_RANGE_DEFAULT_HZ,
    reason:
      'RPM notch fade is disabled (rpm_filter_fade_range_hz = 0), so notches engage abruptly ' +
      `at the ${current.rpm_filter_min_hz ?? 100} Hz floor. The Betaflight default of ` +
      `${RPM_FADE_RANGE_DEFAULT_HZ} Hz fades notch depth out gradually below the floor, ` +
      'reducing filter-delay steps during throttle chops.',
    impact: 'latency',
    confidence: 'low',
    informational: true,
    ruleId: 'F-RPM-FADE',
  });
}

/**
 * Rule F-RPM-WEIGHTS (advisory, BF 4.5+): full-depth weights on all harmonics
 * (the BF default 100,100,100) spend delay on the second harmonic, which
 * carries less energy for most props. Community presets dim it. Only fires
 * when the firmware reports rpm_filter_weights (proof of BF 4.5+ support).
 */
function recommendWeights(
  current: CurrentFilterSettings,
  droneSize: DroneSize | undefined,
  out: FilterRecommendation[]
): void {
  const weights = current.rpm_filter_weights;
  if (!weights || weights.length < 3 || !droneSize) return;
  if (!weights.every((w) => w === 100)) return; // already customized

  const target = RPM_FILTER_WEIGHTS_BY_SIZE[droneSize];
  if (!target) return;

  out.push({
    setting: 'rpm_filter_weights',
    currentValue: weights[1],
    recommendedValue: target[1],
    reason:
      `Your RPM notch weights are all at full depth (100,100,100). For a ${droneSize} quad, ` +
      `community presets use ${target.join(',')} — the second harmonic carries less energy ` +
      'for most props, so dimming its notch trades unneeded attenuation for less filter delay. ' +
      `Set via CLI: set rpm_filter_weights = ${target.join(',')} (Betaflight 4.5+).`,
    impact: 'latency',
    confidence: 'low',
    informational: true,
    ruleId: 'F-RPM-WEIGHTS',
  });
}
