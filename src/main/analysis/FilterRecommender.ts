/**
 * Filter recommendation engine.
 *
 * Takes a noise profile and current filter settings, then applies rule-based
 * heuristics to generate tuning recommendations with beginner-friendly explanations.
 */
import type {
  NoiseProfile,
  FilterRecommendation,
  CurrentFilterSettings,
  NoisePeak,
  FilterGroupDelay,
} from '@shared/types/analysis.types';
import { DEFAULT_FILTER_SETTINGS } from '@shared/types/analysis.types';
import type { DroneSize, FlightStyle } from '@shared/types/profile.types';
import {
  GYRO_LPF1_MIN_HZ,
  GYRO_LPF1_MAX_HZ,
  DTERM_LPF1_MIN_HZ,
  DTERM_LPF1_MAX_HZ,
  GYRO_LPF1_MAX_HZ_RPM,
  DTERM_LPF1_MAX_HZ_RPM,
  DYN_NOTCH_COUNT_WITH_RPM,
  DYN_NOTCH_COUNT_WITH_RPM_BY_SIZE,
  DYN_NOTCH_COUNT_MAX_STEP,
  DYN_NOTCH_Q_WITH_RPM,
  NOISE_FLOOR_VERY_NOISY_DB,
  NOISE_FLOOR_VERY_CLEAN_DB,
  NOISE_TARGET_DEADZONE_HZ,
  RESONANCE_ACTION_THRESHOLD_DB,
  PEAK_MIN_SPACING_HZ,
  RESONANCE_CUTOFF_MARGIN_HZ,
  PROPWASH_GYRO_LPF1_FLOOR_HZ,
  PROPWASH_FLOOR_BYPASS_DB,
  GYRO_LPF2_DISABLE_THRESHOLD_DB,
  DTERM_LPF2_DISABLE_THRESHOLD_DB,
  RPM_FILTER_Q_BY_SIZE,
  RPM_FILTER_Q_DEVIATION_THRESHOLD,
  DTERM_DYN_EXPO_BY_STYLE,
  DTERM_DYN_EXPO_DEFAULT,
  DYNAMIC_LOWPASS_RATIO,
  MAX_VARIABILITY_BONUS_HZ,
  VARIABILITY_TO_HZ_SCALE,
} from './constants';
import { recommendRpmFilterTuning } from './RpmFilterRecommender';
import {
  pt1GroupDelay,
  resolveLatencyBudget,
  GROUP_DELAY_REFERENCE_HZ,
} from './GroupDelayEstimator';

/** Optional noise variability context for hysteresis-aware deadzone */
export interface ConfidenceContext {
  /** Standard deviation of noise floor across segments (dB). Higher = more variable = wider deadzone. */
  noiseFloorStdDb?: number;
}

/** Detect whether RPM filter is active from settings */
export function isRpmFilterActive(settings: CurrentFilterSettings): boolean {
  return (settings.rpm_filter_harmonics ?? 0) > 0;
}

/** Detect whether gyro LPF1 dynamic lowpass is active (dyn_min > 0) */
export function isGyroDynamicActive(settings: CurrentFilterSettings): boolean {
  return (settings.gyro_lpf1_dyn_min_hz ?? 0) > 0;
}

/** Detect whether D-term LPF1 dynamic lowpass is active (dyn_min > 0) */
export function isDtermDynamicActive(settings: CurrentFilterSettings): boolean {
  return (settings.dterm_lpf1_dyn_min_hz ?? 0) > 0;
}

/**
 * Generate filter recommendations based on noise analysis.
 *
 * @param noise - Analyzed noise profile from NoiseAnalyzer
 * @param current - Current filter settings from FC (defaults to Betaflight 4.4 defaults)
 * @returns Array of recommendations, sorted by impact
 */
export function recommend(
  noise: NoiseProfile,
  current: CurrentFilterSettings = DEFAULT_FILTER_SETTINGS,
  droneSize?: DroneSize,
  confidenceContext?: ConfidenceContext,
  groupDelay?: FilterGroupDelay
): FilterRecommendation[] {
  const recommendations: FilterRecommendation[] = [];
  const rpmActive = isRpmFilterActive(current);

  // 1. Noise-floor-based lowpass adjustments
  recommendNoiseFloorAdjustments(noise, current, recommendations, rpmActive, confidenceContext);

  // 2. Resonance-peak-based recommendations
  recommendResonanceFixes(noise, current, recommendations, rpmActive);

  // 3. Dynamic notch validation
  recommendDynamicNotchAdjustments(noise, current, recommendations);

  // 4. RPM-aware dynamic notch count/Q recommendations (conditional on resonance peaks)
  if (rpmActive) {
    recommendDynamicNotchForRPM(noise, current, recommendations, droneSize);
  }

  // 5. RPM filter tuning rules (min_hz / harmonics / fade / weights) from
  // measured harmonic tracks and the dynamic-idle floor
  if (rpmActive) {
    recommendations.push(...recommendRpmFilterTuning(noise, current, droneSize));
  }

  // 6. Motor harmonic diagnostic (when RPM active but motor harmonics still detected).
  // Skipped when a harmonic-count increase was recommended — the residual harmonic
  // is explained by the missing notch order, not by motor_poles/telemetry issues.
  if (rpmActive && !recommendations.some((r) => r.ruleId === 'F-RPM-HARM-UP')) {
    recommendMotorHarmonicDiagnostic(noise, recommendations);
  }

  // 7. LPF2 recommendations (disable when clean + RPM, enable when noisy),
  // weighed against the per-size filter latency budget when delay data exists
  recommendLpf2Adjustments(noise, current, recommendations, rpmActive, groupDelay, droneSize);

  // 8. Yaw-only resonance observation (informational — yaw never drives LPF cutoffs)
  recommendYawResonanceObservation(noise, current, recommendations);

  // Deduplicate: if multiple rules recommend the same setting, keep the more aggressive one
  return deduplicateRecommendations(recommendations);
}

/**
 * Surface strong yaw-only noise peaks that no other rule covers.
 *
 * Yaw is deliberately excluded from LPF cutoff decisions (inherently noisier;
 * lowering a global LPF for a yaw-only peak taxes roll/pitch latency) and
 * from the notch-range rules only when the notch already covers the peak.
 * A strong yaw peak that the dynamic notch cannot handle and that no
 * roll/pitch rule will act on still deserves the pilot's attention — it
 * often indicates a loose stack, tension mismatch, or yaw-axis frame flex.
 */
function recommendYawResonanceObservation(
  noise: NoiseProfile,
  current: CurrentFilterSettings,
  out: FilterRecommendation[]
): void {
  const rollPitchPeaks = [...noise.roll.peaks, ...noise.pitch.peaks].filter(
    (p) => p.amplitude >= RESONANCE_ACTION_THRESHOLD_DB
  );

  const yawOnlyPeaks = noise.yaw.peaks.filter(
    (p) =>
      p.amplitude >= RESONANCE_ACTION_THRESHOLD_DB &&
      !isPeakInDynNotchRange(p.frequency, current) &&
      // Skip peaks that also appear on roll/pitch — those rules already act
      !rollPitchPeaks.some((rp) => Math.abs(rp.frequency - p.frequency) < PEAK_MIN_SPACING_HZ)
  );

  if (yawOnlyPeaks.length === 0) return;

  const strongest = yawOnlyPeaks.reduce((a, b) => (b.amplitude > a.amplitude ? b : a));
  out.push({
    setting: 'dyn_notch_count',
    currentValue: current.dyn_notch_count ?? 3,
    recommendedValue: current.dyn_notch_count ?? 3,
    reason:
      `A strong yaw-only noise peak was detected at ${Math.round(strongest.frequency)} Hz ` +
      `(${Math.round(strongest.amplitude)} dB above the floor) that the dynamic notch does not cover. ` +
      'Yaw peaks like this often point to a loose FC stack, uneven motor mounting, or frame flex — ' +
      'inspect hardware, or extend the dynamic notch range to cover it.',
    impact: 'noise',
    confidence: 'low',
    informational: true,
    ruleId: 'F-YAW-RES',
  });
}

/**
 * Compute an absolute target cutoff from the noise floor dB level.
 * Linear interpolation: VERY_NOISY_DB → minHz, VERY_CLEAN_DB → maxHz.
 * Result is clamped to [minHz, maxHz] and rounded.
 */
export function computeNoiseBasedTarget(
  worstNoiseFloorDb: number,
  minHz: number,
  maxHz: number
): number {
  // Linear interpolation: noisyDb maps to minHz, cleanDb maps to maxHz
  const t =
    (worstNoiseFloorDb - NOISE_FLOOR_VERY_NOISY_DB) /
    (NOISE_FLOOR_VERY_CLEAN_DB - NOISE_FLOOR_VERY_NOISY_DB);
  const target = minHz + t * (maxHz - minHz);
  return Math.round(clamp(target, minHz, maxHz));
}

/**
 * Adjust lowpass filters based on overall noise level using absolute noise-based targets.
 * Targets depend only on the noise floor dB, NOT on current settings → convergent.
 * When RPM filter is active, wider safety bounds are used.
 */
function recommendNoiseFloorAdjustments(
  noise: NoiseProfile,
  current: CurrentFilterSettings,
  out: FilterRecommendation[],
  rpmActive: boolean,
  confidenceContext?: ConfidenceContext
): void {
  const { overallLevel } = noise;

  // Skip gyro LPF noise-floor adjustment when gyro_lpf1 is disabled (0 = common in BF 4.4+ with RPM filter)
  const gyroLpfDisabled = current.gyro_lpf1_static_hz === 0;

  // Select bounds based on RPM filter state
  const gyroMaxHz = rpmActive ? GYRO_LPF1_MAX_HZ_RPM : GYRO_LPF1_MAX_HZ;
  const dtermMaxHz = rpmActive ? DTERM_LPF1_MAX_HZ_RPM : DTERM_LPF1_MAX_HZ;

  // Compute worst noise floor across roll and pitch (the critical axes).
  // Yaw is excluded: yaw noise is less critical for motor heating and flight feel,
  // and yaw gyro often picks up frame vibrations differently than roll/pitch.
  const worstFloor = Math.max(noise.roll.noiseFloorDb, noise.pitch.noiseFloorDb);

  // Compute absolute targets from noise data (independent of current settings)
  let targetGyroLpf1 = computeNoiseBasedTarget(worstFloor, GYRO_LPF1_MIN_HZ, gyroMaxHz);
  const targetDtermLpf1 = computeNoiseBasedTarget(worstFloor, DTERM_LPF1_MIN_HZ, dtermMaxHz);

  // Propwash-aware floor: prevent gyro LPF1 from going so low that phase delay
  // degrades propwash recovery. Only bypass when noise is extreme.
  let propwashNote = '';
  if (targetGyroLpf1 < PROPWASH_GYRO_LPF1_FLOOR_HZ && worstFloor <= PROPWASH_FLOOR_BYPASS_DB) {
    targetGyroLpf1 = PROPWASH_GYRO_LPF1_FLOOR_HZ;
    propwashNote =
      ' (Raised to propwash safety floor — lowering further would add phase delay that hurts propwash handling during flips and rolls.)';
  }

  const rpmNote = rpmActive
    ? ' With RPM filter active, motor noise is already handled, allowing higher filter cutoffs for better response.'
    : '';

  // Dynamic lowpass detection: when active, tune dyn_min/max instead of static
  const gyroDynActive = isGyroDynamicActive(current);
  const dtermDynActive = isDtermDynamicActive(current);

  // Variability-aware deadzone bonus: widen deadzone when noise floor varies between segments,
  // preventing recommendation churn from flight-to-flight noise floor variation.
  const variabilityBonus = Math.min(
    (confidenceContext?.noiseFloorStdDb ?? 0) * VARIABILITY_TO_HZ_SCALE,
    MAX_VARIABILITY_BONUS_HZ
  );
  const baseDeadzone = NOISE_TARGET_DEADZONE_HZ + variabilityBonus;

  // For dynamic mode: the effective "current cutoff" is dyn_min (tightest point at high throttle;
  // BF ramps from dyn_max at low throttle down to dyn_min at high throttle)
  const effectiveGyroCutoff = gyroDynActive
    ? (current.gyro_lpf1_dyn_min_hz ?? current.gyro_lpf1_static_hz)
    : current.gyro_lpf1_static_hz;
  const effectiveDtermCutoff = dtermDynActive
    ? (current.dterm_lpf1_dyn_min_hz ?? current.dterm_lpf1_static_hz)
    : current.dterm_lpf1_static_hz;

  // Helper: push gyro LPF1 recommendation (static or dynamic mode)
  const pushGyroRec = (
    target: number,
    reason: string,
    impact: FilterRecommendation['impact'],
    confidence: FilterRecommendation['confidence'],
    ruleId: string
  ) => {
    if (gyroLpfDisabled) return;
    if (gyroDynActive) {
      // Dynamic mode: tune dyn_min_hz, use BF 2:1 ratio for dyn_max_hz
      const currentMin = current.gyro_lpf1_dyn_min_hz!;
      const currentMax = current.gyro_lpf1_dyn_max_hz ?? currentMin * DYNAMIC_LOWPASS_RATIO;
      let newMax = Math.round(clamp(target * DYNAMIC_LOWPASS_RATIO, target, gyroMaxHz));
      // Enforce BF 2:1 ratio: if clamping broke it, lower dyn_min to preserve ratio
      let adjustedTarget = target;
      if (newMax < target * DYNAMIC_LOWPASS_RATIO) {
        adjustedTarget = Math.floor(newMax / DYNAMIC_LOWPASS_RATIO);
        newMax = adjustedTarget * DYNAMIC_LOWPASS_RATIO;
      }
      if (Math.abs(adjustedTarget - currentMin) > baseDeadzone) {
        out.push({
          setting: 'gyro_lpf1_dyn_min_hz',
          currentValue: currentMin,
          recommendedValue: adjustedTarget,
          reason: reason + ' (Dynamic lowpass active — adjusting the minimum cutoff.)',
          impact,
          confidence,
          ruleId,
        });
        out.push({
          setting: 'gyro_lpf1_dyn_max_hz',
          currentValue: currentMax,
          recommendedValue: newMax,
          reason: 'Set to BF 2:1 ratio (dyn_max = 2 × dyn_min), capped by safety bounds.',
          impact: 'latency',
          confidence,
          ruleId,
        });
        // Ensure static_hz ≤ dyn_min (BF floor constraint)
        if (current.gyro_lpf1_static_hz > adjustedTarget) {
          out.push({
            setting: 'gyro_lpf1_static_hz',
            currentValue: current.gyro_lpf1_static_hz,
            recommendedValue: adjustedTarget,
            reason: 'Static cutoff must be ≤ dynamic minimum (Betaflight constraint).',
            impact: 'both',
            confidence,
            ruleId,
          });
        }
      }
    } else {
      // Static mode: tune static_hz directly
      if (Math.abs(target - current.gyro_lpf1_static_hz) > baseDeadzone) {
        out.push({
          setting: 'gyro_lpf1_static_hz',
          currentValue: current.gyro_lpf1_static_hz,
          recommendedValue: target,
          reason,
          impact,
          confidence,
          ruleId,
        });
      }
    }
  };

  // Helper: push D-term LPF1 recommendation (static or dynamic mode)
  const pushDtermRec = (
    target: number,
    reason: string,
    impact: FilterRecommendation['impact'],
    confidence: FilterRecommendation['confidence'],
    ruleId: string
  ) => {
    if (dtermDynActive) {
      const currentMin = current.dterm_lpf1_dyn_min_hz!;
      const currentMax = current.dterm_lpf1_dyn_max_hz ?? currentMin * DYNAMIC_LOWPASS_RATIO;
      let newMax = Math.round(clamp(target * DYNAMIC_LOWPASS_RATIO, target, dtermMaxHz));
      // Enforce BF 2:1 ratio: if clamping broke it, lower dyn_min to preserve ratio
      let adjustedTarget = target;
      if (newMax < target * DYNAMIC_LOWPASS_RATIO) {
        adjustedTarget = Math.floor(newMax / DYNAMIC_LOWPASS_RATIO);
        newMax = adjustedTarget * DYNAMIC_LOWPASS_RATIO;
      }
      if (Math.abs(adjustedTarget - currentMin) > baseDeadzone) {
        out.push({
          setting: 'dterm_lpf1_dyn_min_hz',
          currentValue: currentMin,
          recommendedValue: adjustedTarget,
          reason: reason + ' (Dynamic lowpass active — adjusting the minimum cutoff.)',
          impact,
          confidence,
          ruleId,
        });
        out.push({
          setting: 'dterm_lpf1_dyn_max_hz',
          currentValue: currentMax,
          recommendedValue: newMax,
          reason: 'Set to BF 2:1 ratio (dyn_max = 2 × dyn_min), capped by safety bounds.',
          impact: 'latency',
          confidence,
          ruleId,
        });
        if (current.dterm_lpf1_static_hz > adjustedTarget) {
          out.push({
            setting: 'dterm_lpf1_static_hz',
            currentValue: current.dterm_lpf1_static_hz,
            recommendedValue: adjustedTarget,
            reason: 'Static cutoff must be ≤ dynamic minimum (Betaflight constraint).',
            impact: 'both',
            confidence,
            ruleId,
          });
        }
      }
    } else {
      if (Math.abs(target - current.dterm_lpf1_static_hz) > baseDeadzone) {
        out.push({
          setting: 'dterm_lpf1_static_hz',
          currentValue: current.dterm_lpf1_static_hz,
          recommendedValue: target,
          reason,
          impact,
          confidence,
          ruleId,
        });
      }
    }
  };

  // Use deadzone against effective cutoff (dyn_min when dynamic, static otherwise)
  const gyroDeadzone =
    (overallLevel === 'medium' ? 20 : NOISE_TARGET_DEADZONE_HZ) + variabilityBonus;
  const dtermDeadzone =
    (overallLevel === 'medium' ? 20 : NOISE_TARGET_DEADZONE_HZ) + variabilityBonus;

  const gyroOffTarget = Math.abs(targetGyroLpf1 - effectiveGyroCutoff) > gyroDeadzone;
  const dtermOffTarget = Math.abs(targetDtermLpf1 - effectiveDtermCutoff) > dtermDeadzone;

  if (overallLevel === 'high') {
    if (gyroOffTarget) {
      pushGyroRec(
        targetGyroLpf1,
        'Your gyro data has a lot of noise. Adjusting the gyro lowpass filter will clean up the signal, ' +
          'which helps your flight controller respond to real movement instead of vibrations.' +
          rpmNote +
          propwashNote,
        'both',
        'high',
        'F-NF-H-GYRO'
      );
    }
    if (dtermOffTarget) {
      pushDtermRec(
        targetDtermLpf1,
        'High noise is reaching the D-term (derivative) calculation. Adjusting this filter reduces motor ' +
          'heating and oscillation caused by noisy D-term output.' +
          rpmNote,
        'both',
        'high',
        'F-NF-H-DTERM'
      );
    }
  } else if (overallLevel === 'low') {
    if (gyroOffTarget) {
      pushGyroRec(
        targetGyroLpf1,
        'Your quad is very clean with minimal vibrations. Raising the gyro filter cutoff will give you ' +
          'faster response and sharper control with almost no downside.' +
          rpmNote +
          propwashNote,
        'latency',
        'medium',
        'F-NF-L-GYRO'
      );
    }
    if (dtermOffTarget) {
      pushDtermRec(
        targetDtermLpf1,
        'Low noise means the D-term filter cutoff can be raised for sharper stick response. ' +
          'This makes your quad feel more locked-in during fast moves.' +
          rpmNote,
        'latency',
        'medium',
        'F-NF-L-DTERM'
      );
    }
  } else {
    // Medium noise
    if (gyroOffTarget) {
      pushGyroRec(
        targetGyroLpf1,
        'Noise levels are moderate but your gyro filter cutoff is significantly off from the optimal range. ' +
          'Adjusting it will better balance noise rejection and response.' +
          rpmNote +
          propwashNote,
        'both',
        'low',
        'F-NF-M-GYRO'
      );
    }
    if (dtermOffTarget) {
      pushDtermRec(
        targetDtermLpf1,
        'Noise levels are moderate but your D-term filter cutoff is significantly off from the optimal range. ' +
          'Adjusting it will reduce motor heating without sacrificing too much response.' +
          rpmNote,
        'both',
        'low',
        'F-NF-M-DTERM'
      );
    }
  }
}

/**
 * Check if a peak frequency falls within the dynamic notch filter's tracking range.
 * If the notch can handle it, we prefer notch tracking over lowering the LPF cutoff
 * (less phase delay).
 */
function isPeakInDynNotchRange(freq: number, current: CurrentFilterSettings): boolean {
  // A disabled notch (count = 0) covers nothing — without this check a strong
  // frame resonance inside the nominal min/max range would be silently assumed
  // handled and left with no mitigation at all. An unknown count (undefined)
  // is treated as enabled, since BF defaults to 3 notches.
  if (current.dyn_notch_count !== undefined && current.dyn_notch_count <= 0) return false;
  return freq >= current.dyn_notch_min_hz && freq <= current.dyn_notch_max_hz;
}

/**
 * Recommend fixes for detected resonance peaks.
 * Notch-aware: if a peak is within dyn_notch range, prefer notch handling
 * over lowering the lowpass cutoff (less phase delay).
 */
function recommendResonanceFixes(
  noise: NoiseProfile,
  current: CurrentFilterSettings,
  out: FilterRecommendation[],
  rpmActive: boolean
): void {
  // Collect significant peaks from roll and pitch.
  // Note: peak frequency bands are fixed (frame resonance 80-200 Hz, electrical >500 Hz).
  // These work across quad sizes because the noise analysis detects peaks at their actual
  // frequencies, which naturally vary by frame size (smaller quads resonate higher).
  const significantPeaks: NoisePeak[] = [];
  for (const axis of [noise.roll, noise.pitch]) {
    for (const peak of axis.peaks) {
      if (peak.amplitude >= RESONANCE_ACTION_THRESHOLD_DB) {
        significantPeaks.push(peak);
      }
    }
  }

  if (significantPeaks.length === 0) return;

  // Select bounds based on RPM filter state
  const gyroMaxHz = rpmActive ? GYRO_LPF1_MAX_HZ_RPM : GYRO_LPF1_MAX_HZ;
  const dtermMaxHz = rpmActive ? DTERM_LPF1_MAX_HZ_RPM : DTERM_LPF1_MAX_HZ;

  // Filter out peaks that the dynamic notch can already handle (prefer notch over LPF)
  const peaksNeedingLpf = significantPeaks.filter(
    (p) => !isPeakInDynNotchRange(p.frequency, current)
  );

  // If all peaks are within notch range, no LPF changes needed
  if (peaksNeedingLpf.length === 0) return;

  // Find the lowest significant peak frequency that the notch can't handle
  const lowestPeakFreq = Math.min(...peaksNeedingLpf.map((p) => p.frequency));

  // Use effective cutoff (dyn_min when dynamic active, static otherwise)
  const gyroDynActive = isGyroDynamicActive(current);
  const effectiveGyroCutoff = gyroDynActive
    ? (current.gyro_lpf1_dyn_min_hz ?? current.gyro_lpf1_static_hz)
    : current.gyro_lpf1_static_hz;
  const gyroLpfDisabled = current.gyro_lpf1_static_hz === 0;
  if (gyroLpfDisabled || lowestPeakFreq < effectiveGyroCutoff) {
    const targetCutoff = Math.round(
      clamp(lowestPeakFreq - RESONANCE_CUTOFF_MARGIN_HZ, GYRO_LPF1_MIN_HZ, gyroMaxHz)
    );

    // When disabled, always recommend enabling; otherwise check it's lower than current
    if (gyroLpfDisabled || targetCutoff < effectiveGyroCutoff) {
      const peakType =
        peaksNeedingLpf.find((p) => p.frequency === lowestPeakFreq)?.type || 'unknown';
      const typeLabel =
        peakType === 'frame_resonance'
          ? 'frame resonance'
          : peakType === 'motor_harmonic'
            ? 'motor harmonic'
            : peakType === 'electrical'
              ? 'electrical noise'
              : 'noise spike';

      // Dynamic mode: target dyn_min_hz; static mode: target static_hz
      const settingName = gyroDynActive ? 'gyro_lpf1_dyn_min_hz' : 'gyro_lpf1_static_hz';
      const reasonText = gyroLpfDisabled
        ? `A strong ${typeLabel} was detected at ${Math.round(lowestPeakFreq)} Hz, but your gyro lowpass filter is disabled. ` +
          `Enabling it at ${targetCutoff} Hz will block this vibration.`
        : `A strong ${typeLabel} was detected at ${Math.round(lowestPeakFreq)} Hz, which is below your current ` +
          `gyro filter cutoff of ${effectiveGyroCutoff} Hz. Lowering the filter will block this vibration.`;

      out.push({
        setting: settingName,
        currentValue: effectiveGyroCutoff,
        recommendedValue: targetCutoff,
        reason: reasonText,
        impact: 'both',
        confidence: 'high',
        ruleId: 'F-RES-GYRO',
      });
    }
  }

  // Check D-term LPF similarly
  const dtermDynActive = isDtermDynamicActive(current);
  const effectiveDtermCutoff = dtermDynActive
    ? (current.dterm_lpf1_dyn_min_hz ?? current.dterm_lpf1_static_hz)
    : current.dterm_lpf1_static_hz;

  if (lowestPeakFreq < effectiveDtermCutoff) {
    const targetCutoff = Math.round(
      clamp(lowestPeakFreq - RESONANCE_CUTOFF_MARGIN_HZ, DTERM_LPF1_MIN_HZ, dtermMaxHz)
    );

    if (targetCutoff < effectiveDtermCutoff) {
      const settingName = dtermDynActive ? 'dterm_lpf1_dyn_min_hz' : 'dterm_lpf1_static_hz';
      out.push({
        setting: settingName,
        currentValue: effectiveDtermCutoff,
        recommendedValue: targetCutoff,
        reason:
          `A strong resonance peak at ${Math.round(lowestPeakFreq)} Hz is getting through to the D-term. ` +
          'Lowering the D-term filter will reduce motor heat and improve flight smoothness.',
        impact: 'both',
        confidence: 'high',
        ruleId: 'F-RES-DTERM',
      });
    }
  }
}

/**
 * Check if the dynamic notch filter range covers the detected noise peaks.
 */
function recommendDynamicNotchAdjustments(
  noise: NoiseProfile,
  current: CurrentFilterSettings,
  out: FilterRecommendation[]
): void {
  // Collect all significant peaks across axes
  const allPeaks: NoisePeak[] = [];
  for (const axis of [noise.roll, noise.pitch, noise.yaw]) {
    for (const peak of axis.peaks) {
      if (peak.amplitude >= RESONANCE_ACTION_THRESHOLD_DB) {
        allPeaks.push(peak);
      }
    }
  }

  if (allPeaks.length === 0) return;

  // Check if any peaks fall outside the dynamic notch range
  const peaksBelow = allPeaks.filter((p) => p.frequency < current.dyn_notch_min_hz);
  const peaksAbove = allPeaks.filter((p) => p.frequency > current.dyn_notch_max_hz);

  if (peaksBelow.length > 0) {
    const lowestPeak = Math.min(...peaksBelow.map((p) => p.frequency));
    const newMin = Math.max(50, Math.round(lowestPeak - 20));

    if (newMin < current.dyn_notch_min_hz) {
      out.push({
        setting: 'dyn_notch_min_hz',
        currentValue: current.dyn_notch_min_hz,
        recommendedValue: newMin,
        reason:
          `There's a noise peak at ${Math.round(lowestPeak)} Hz that falls below the dynamic notch filter's ` +
          `minimum of ${current.dyn_notch_min_hz} Hz. Lowering the minimum lets the notch filter track and remove it.`,
        impact: 'noise',
        confidence: 'medium',
        ruleId: 'F-DN-MIN',
      });
    }
  }

  if (peaksAbove.length > 0) {
    const highestPeak = Math.max(...peaksAbove.map((p) => p.frequency));
    const newMax = Math.min(1000, Math.round(highestPeak + 20));

    if (newMax > current.dyn_notch_max_hz) {
      out.push({
        setting: 'dyn_notch_max_hz',
        currentValue: current.dyn_notch_max_hz,
        recommendedValue: newMax,
        reason:
          `A noise peak at ${Math.round(highestPeak)} Hz is above the dynamic notch filter's ` +
          `maximum of ${current.dyn_notch_max_hz} Hz. Raising the maximum lets the notch filter catch it.`,
        impact: 'noise',
        confidence: 'medium',
        ruleId: 'F-DN-MAX',
      });
    }
  }
}

/**
 * Recommend dynamic notch count and Q adjustments when RPM filter is active.
 * With RPM filter handling motor harmonics, the dynamic notch only needs to catch
 * frame resonances — fewer notches with narrower Q.
 *
 * Exception: if significant resonance peaks are detected, keep Q at 300 (wider)
 * to better track the resonance. Q=500 is too narrow for strong frame resonances.
 */
function recommendDynamicNotchForRPM(
  noise: NoiseProfile,
  current: CurrentFilterSettings,
  out: FilterRecommendation[],
  droneSize?: DroneSize
): void {
  const currentCount = current.dyn_notch_count;
  const currentQ = current.dyn_notch_q;

  // Check for significant resonance peaks — affects Q recommendation
  const hasStrongResonance = [noise.roll, noise.pitch, noise.yaw].some((axis) =>
    axis.peaks.some(
      (p) => p.amplitude >= RESONANCE_ACTION_THRESHOLD_DB && p.type === 'frame_resonance'
    )
  );

  // Size-aware target: sub-5" quads keep 2 notches (more complex vibration coupling),
  // 5"+ use 1 (RPM filter handles motor noise, 1 notch catches frame resonance).
  const targetCount = droneSize
    ? DYN_NOTCH_COUNT_WITH_RPM_BY_SIZE[droneSize]
    : DYN_NOTCH_COUNT_WITH_RPM;

  // Conservative stepping: reduce by at most DYN_NOTCH_COUNT_MAX_STEP per iteration
  // to avoid removing too many notches at once (5→1 can cause regression on axes
  // where removed notches were tracking real noise peaks).
  if (currentCount !== undefined && currentCount > targetCount) {
    const stepped = Math.max(targetCount, currentCount - DYN_NOTCH_COUNT_MAX_STEP);
    const sizeNote =
      droneSize && targetCount > 1
        ? ` Sub-5" quads benefit from ${targetCount} notches to cover frame vibration modes.`
        : '';
    out.push({
      setting: 'dyn_notch_count',
      currentValue: currentCount,
      recommendedValue: stepped,
      reason:
        'With RPM filter active, motor harmonics are already removed. The dynamic notch filter only needs to ' +
        `catch frame resonances, so fewer notches are needed.${sizeNote} This reduces CPU load and filter delay.`,
      impact: 'latency',
      confidence: 'high',
      ruleId: 'F-DN-COUNT',
    });
  }

  // Q recommendation: keep 300 (wider) if strong frame resonance, else narrow to 500
  if (!hasStrongResonance && currentQ !== undefined && currentQ < DYN_NOTCH_Q_WITH_RPM) {
    out.push({
      setting: 'dyn_notch_q',
      currentValue: currentQ,
      recommendedValue: DYN_NOTCH_Q_WITH_RPM,
      reason:
        'With RPM filter handling motor noise, the dynamic notch can use a higher Q (narrower bandwidth). ' +
        'This means less signal distortion while still catching frame resonances.',
      impact: 'latency',
      confidence: 'high',
      ruleId: 'F-DN-Q',
    });
  } else if (hasStrongResonance && currentQ !== undefined && currentQ > 300) {
    // Strong resonance present — keep Q at 300 (wider) for better tracking
    out.push({
      setting: 'dyn_notch_q',
      currentValue: currentQ,
      recommendedValue: 300,
      reason:
        'Strong frame resonance detected. Keeping the dynamic notch Q at 300 (wider bandwidth) ' +
        'ensures the notch can effectively track and suppress the resonance.',
      impact: 'noise',
      confidence: 'medium',
      ruleId: 'F-DN-Q',
    });
  }
}

/**
 * Deduplicate recommendations for the same setting.
 * When multiple rules target the same setting, keep the more aggressive change.
 */
function deduplicateRecommendations(recs: FilterRecommendation[]): FilterRecommendation[] {
  const byKey = new Map<string, FilterRecommendation>();
  // Informational observations pass through unmerged: their currentValue ===
  // recommendedValue no-op must never replace (or inherit confidence from) a
  // real recommendation that happens to share the setting name (e.g. the
  // F-YAW-RES observation vs an actionable F-DN-COUNT reduction). The
  // renderer already excludes informational/no-op recs from apply.
  const informational: FilterRecommendation[] = [];

  for (const rec of recs) {
    if (rec.informational) {
      informational.push(rec);
      continue;
    }
    const existing = byKey.get(rec.setting);
    if (!existing) {
      byKey.set(rec.setting, rec);
      continue;
    }

    // For lowpass filters, "more aggressive" = lower cutoff
    if (rec.setting.includes('lpf') || rec.setting.includes('min')) {
      if (rec.recommendedValue < existing.recommendedValue) {
        // Merge: keep the more aggressive value but upgrade confidence
        byKey.set(rec.setting, {
          ...rec,
          confidence:
            existing.confidence === 'high' || rec.confidence === 'high' ? 'high' : 'medium',
        });
      }
    } else {
      // For max filters, more aggressive = higher value
      if (rec.recommendedValue > existing.recommendedValue) {
        byKey.set(rec.setting, {
          ...rec,
          confidence:
            existing.confidence === 'high' || rec.confidence === 'high' ? 'high' : 'medium',
        });
      }
    }
  }

  return [...byKey.values(), ...informational];
}

/**
 * Generate a beginner-friendly summary of the analysis.
 */
export function generateSummary(
  noise: NoiseProfile,
  recommendations: FilterRecommendation[],
  rpmActive: boolean = false
): string {
  const { overallLevel } = noise;
  const parts: string[] = [];

  if (overallLevel === 'high') {
    parts.push('Your quad has significant vibration or noise.');
  } else if (overallLevel === 'low') {
    parts.push('Your quad is running very clean!');
  } else {
    parts.push('Your noise levels are moderate.');
  }

  if (rpmActive) {
    parts.push('RPM filter is active — motor noise is handled dynamically.');
  }

  // Mention resonance if detected
  const allPeaks = [...noise.roll.peaks, ...noise.pitch.peaks];
  const frameRes = allPeaks.find((p) => p.type === 'frame_resonance');
  const motorHarm = allPeaks.find((p) => p.type === 'motor_harmonic');

  if (frameRes) {
    parts.push(`Frame resonance detected around ${Math.round(frameRes.frequency)} Hz.`);
  }
  if (motorHarm) {
    parts.push(`Motor harmonic noise detected around ${Math.round(motorHarm.frequency)} Hz.`);
  }

  if (recommendations.length === 0) {
    parts.push('Current filter settings look good — no changes needed.');
  } else {
    parts.push(
      `${recommendations.length} filter change${recommendations.length > 1 ? 's' : ''} recommended.`
    );
  }

  return parts.join(' ');
}

/**
 * Rule 5: Motor Harmonic Diagnostic (when RPM filter active).
 * If motor harmonics are still detected at ≥12 dB despite RPM filter,
 * emit informational warning about motor_poles misconfiguration or ESC telemetry issues.
 */
function recommendMotorHarmonicDiagnostic(noise: NoiseProfile, out: FilterRecommendation[]): void {
  const axes = [noise.roll, noise.pitch, noise.yaw] as const;
  let worstAmplitude = 0;
  let worstFrequency = 0;

  for (const axis of axes) {
    for (const peak of axis.peaks) {
      if (peak.type === 'motor_harmonic' && peak.amplitude >= RESONANCE_ACTION_THRESHOLD_DB) {
        if (peak.amplitude > worstAmplitude) {
          worstAmplitude = peak.amplitude;
          worstFrequency = peak.frequency;
        }
      }
    }
  }

  if (worstAmplitude > 0) {
    out.push({
      setting: 'motor_poles',
      currentValue: 0,
      recommendedValue: 0,
      reason:
        `Motor harmonics still detected at ${Math.round(worstAmplitude)} dB (${Math.round(worstFrequency)} Hz) ` +
        'despite RPM filter being active. Check that motor_poles matches your motors ' +
        '(typically 14 for standard FPV motors) and verify ESC telemetry is working correctly.',
      impact: 'noise',
      confidence: 'low',
      informational: true,
      ruleId: 'F-MOTOR-DIAG',
    });
  }
}

/**
 * Rule 6: Recommend LPF2 adjustments:
 * - With RPM filter + clean noise: disable LPF2 for less latency. When the
 *   measured chain delay is over the per-size latency budget, the disable
 *   is upgraded to high confidence (P2.7).
 * - Without RPM + high noise + LPF2 disabled: recommend enabling — unless
 *   the added delay would blow the latency budget, in which case an
 *   informational "fix noise at the source" advisory is emitted instead.
 */
function recommendLpf2Adjustments(
  noise: NoiseProfile,
  current: CurrentFilterSettings,
  out: FilterRecommendation[],
  rpmActive: boolean,
  groupDelay?: FilterGroupDelay,
  droneSize?: DroneSize
): void {
  const worstFloor = Math.max(noise.roll.noiseFloorDb, noise.pitch.noiseFloorDb);
  const budget = resolveLatencyBudget(droneSize);
  const latencyNote = (totalMs: number | undefined, budgetMs: number): string =>
    totalMs !== undefined
      ? ` Filter latency: ${totalMs.toFixed(1)} ms (budget ${budgetMs.toFixed(1)} ms).`
      : '';

  // Clean signal + RPM active → disable LPF2 for less phase delay
  if (rpmActive && worstFloor < GYRO_LPF2_DISABLE_THRESHOLD_DB) {
    if (current.gyro_lpf2_static_hz > 0) {
      const overBudget = groupDelay?.gyroOverBudget === true;
      out.push({
        setting: 'gyro_lpf2_static_hz',
        currentValue: current.gyro_lpf2_static_hz,
        recommendedValue: 0,
        reason:
          'With RPM filter active and very clean gyro data, the second gyro lowpass filter can be ' +
          'disabled to reduce phase delay and improve response.' +
          latencyNote(groupDelay?.gyroTotalMs, budget.gyroMs),
        impact: 'latency',
        confidence: overBudget ? 'high' : 'medium',
        ruleId: 'F-LPF2-DIS-GYRO',
      });
    }
  }
  if (rpmActive && worstFloor < DTERM_LPF2_DISABLE_THRESHOLD_DB) {
    if (current.dterm_lpf2_static_hz > 0) {
      const overBudget = groupDelay?.dtermOverBudget === true;
      out.push({
        setting: 'dterm_lpf2_static_hz',
        currentValue: current.dterm_lpf2_static_hz,
        recommendedValue: 0,
        reason:
          'With RPM filter active and low noise, the second D-term lowpass filter can be ' +
          'disabled to reduce latency and improve stick feel.' +
          latencyNote(groupDelay?.dtermTotalMs, budget.dtermMs),
        impact: 'latency',
        confidence: overBudget ? 'high' : 'medium',
        ruleId: 'F-LPF2-DIS-DTERM',
      });
    }
  }

  // High noise + no RPM + LPF2 disabled → recommend enabling, if the added
  // delay fits the latency budget; otherwise point at the noise source instead
  if (!rpmActive && noise.overallLevel === 'high') {
    if (current.gyro_lpf2_static_hz === 0) {
      const addedMs = pt1GroupDelay(250, GROUP_DELAY_REFERENCE_HZ) * 1000;
      const prospectiveMs = groupDelay !== undefined ? groupDelay.gyroTotalMs + addedMs : undefined;
      if (prospectiveMs !== undefined && prospectiveMs > budget.gyroMs) {
        out.push({
          setting: 'gyro_lpf2_static_hz',
          currentValue: 0,
          recommendedValue: 0,
          reason:
            'High noise detected without RPM filter, but enabling a second gyro lowpass would push ' +
            `filter latency to ${prospectiveMs.toFixed(1)} ms — over the ${budget.gyroMs.toFixed(1)} ms ` +
            'budget for this quad size. Fix the noise at its source instead: check props/bearings, ' +
            'consider RPM filtering (bidirectional DSHOT), or soft-mount the flight controller.',
          impact: 'noise',
          confidence: 'low',
          informational: true,
          ruleId: 'F-LPF2-BUDGET-GYRO',
        });
      } else {
        out.push({
          setting: 'gyro_lpf2_static_hz',
          currentValue: 0,
          recommendedValue: 250,
          reason:
            'High noise detected without RPM filter. Enabling the second gyro lowpass filter ' +
            'provides additional noise rejection that helps with motor temperatures.' +
            latencyNote(prospectiveMs, budget.gyroMs),
          impact: 'noise',
          confidence: 'low',
          ruleId: 'F-LPF2-EN-GYRO',
        });
      }
    }
    if (current.dterm_lpf2_static_hz === 0) {
      const addedMs = pt1GroupDelay(150, GROUP_DELAY_REFERENCE_HZ) * 1000;
      const prospectiveMs =
        groupDelay !== undefined ? groupDelay.dtermTotalMs + addedMs : undefined;
      if (prospectiveMs !== undefined && prospectiveMs > budget.dtermMs) {
        out.push({
          setting: 'dterm_lpf2_static_hz',
          currentValue: 0,
          recommendedValue: 0,
          reason:
            'High noise detected without RPM filter, but enabling a second D-term lowpass would push ' +
            `D-term filter latency to ${prospectiveMs.toFixed(1)} ms — over the ${budget.dtermMs.toFixed(1)} ms ` +
            'budget for this quad size. Fix the noise at its source instead: check props/bearings, ' +
            'consider RPM filtering (bidirectional DSHOT), or soft-mount the flight controller.',
          impact: 'noise',
          confidence: 'low',
          informational: true,
          ruleId: 'F-LPF2-BUDGET-DTERM',
        });
      } else {
        out.push({
          setting: 'dterm_lpf2_static_hz',
          currentValue: 0,
          recommendedValue: 150,
          reason:
            'High noise detected without RPM filter. Enabling the second D-term lowpass filter ' +
            'helps reduce motor heating from noisy D-term output.' +
            latencyNote(prospectiveMs, budget.dtermMs),
          impact: 'noise',
          confidence: 'low',
          ruleId: 'F-LPF2-EN-DTERM',
        });
      }
    }
  }
}

/**
 * Recommend RPM filter Q adjustment based on drone size.
 * Only fires when RPM filter is active and current Q differs >20% from size-appropriate value.
 *
 * Rule ID: F-RPM-Q, confidence: low (advisory)
 */
export function recommendRpmFilterQ(
  current: CurrentFilterSettings,
  droneSize?: DroneSize
): FilterRecommendation | undefined {
  // Only when RPM filter is active
  if (!isRpmFilterActive(current)) return undefined;

  // Need both current Q and drone size to make a recommendation
  if (current.rpm_filter_q === undefined || !droneSize) return undefined;

  const range = RPM_FILTER_Q_BY_SIZE[droneSize];
  if (!range) return undefined;

  const currentQ = current.rpm_filter_q;
  const targetQ = range.midpoint;

  // Check if current Q deviates >20% from the size-appropriate midpoint
  const deviation = Math.abs(currentQ - targetQ) / targetQ;
  if (deviation <= RPM_FILTER_Q_DEVIATION_THRESHOLD) return undefined;

  const direction = currentQ < targetQ ? 'raising' : 'lowering';
  const sizeLabel = droneSize;

  return {
    setting: 'rpm_filter_q',
    currentValue: currentQ,
    recommendedValue: targetQ,
    reason:
      `For a ${sizeLabel} quad, RPM filter Q of ${range.min}-${range.max} is typical. ` +
      `Your current Q of ${currentQ} is ${Math.round(deviation * 100)}% off — ` +
      `${direction} to ${targetQ} will better match your prop size. ` +
      (currentQ < targetQ
        ? 'A wider notch than needed adds unnecessary filter delay.'
        : 'A narrower notch may miss harmonic spread from larger props.'),
    impact: 'both',
    confidence: 'low',
    ruleId: 'F-RPM-Q',
  };
}

/**
 * Recommend D-term LPF1 dynamic expo adjustment based on flight style.
 * Only fires when D-term dynamic LPF is active (dterm_lpf1_dyn_min_hz > 0).
 *
 * Racing benefits from higher expo (7-10) — less D filtering at high throttle.
 * Cinematic benefits from lower expo (3-5) — smoother D-term at all throttles.
 *
 * Rule ID: F-DEXP, confidence: low (advisory)
 */
export function recommendDtermDynExpo(
  current: CurrentFilterSettings,
  flightStyle?: FlightStyle
): FilterRecommendation | undefined {
  // D-term dynamic LPF must be active (dyn_min_hz > 0 means dynamic mode is on)
  const dynActive = (current.dterm_lpf1_dyn_min_hz ?? 0) > 0;
  if (!dynActive) return undefined;

  // Need flight style and current expo to make a recommendation
  if (!flightStyle || current.dterm_lpf1_dyn_expo === undefined) return undefined;

  const range = DTERM_DYN_EXPO_BY_STYLE[flightStyle];
  const currentExpo = current.dterm_lpf1_dyn_expo;

  // Already within the recommended range
  if (currentExpo >= range.min && currentExpo <= range.max) return undefined;

  // For balanced style, the range is just 5-5 (default), so only fire if not at default
  if (flightStyle === 'balanced' && currentExpo === DTERM_DYN_EXPO_DEFAULT) return undefined;

  const targetExpo = currentExpo < range.min ? range.min : range.max;
  const styleLabel =
    flightStyle === 'aggressive' ? 'racing' : flightStyle === 'smooth' ? 'cinematic' : 'freestyle';

  let reason: string;
  if (flightStyle === 'aggressive') {
    reason =
      `For ${styleLabel} flying, a D-term dynamic expo of ${range.min}-${range.max} is recommended. ` +
      `Your current value of ${currentExpo} keeps D-term filtering too aggressive at high throttle. ` +
      'Higher expo lets the D-term filter cutoff rise faster with throttle, reducing latency when you need it most.';
  } else if (flightStyle === 'smooth') {
    reason =
      `For ${styleLabel} flying, a D-term dynamic expo of ${range.min}-${range.max} is recommended. ` +
      `Your current value of ${currentExpo} may cause D-term filtering to change too aggressively with throttle. ` +
      'Lower expo keeps D-term filtering more consistent across throttle range for smoother footage.';
  } else {
    reason =
      `For ${styleLabel} flying, D-term dynamic expo of ${range.min} (BF default) is a good balance. ` +
      `Your current value of ${currentExpo} may not be optimal for general-purpose flying.`;
  }

  return {
    setting: 'dterm_lpf1_dyn_expo',
    currentValue: currentExpo,
    recommendedValue: targetExpo,
    reason,
    impact: 'latency',
    confidence: 'low',
    ruleId: 'F-DEXP',
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
