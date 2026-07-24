/**
 * Mechanical health diagnostic module.
 *
 * Pre-tuning check that detects hardware issues before PID analysis:
 * - Extreme noise floor (>-10 dB on the v2 scale, size-aware) — damaged prop, loose motor, vibration
 * - Asymmetric per-axis noise — bent prop, damaged motor, gyro mounting
 * - Abnormal motor output variance — motor imbalance, ESC issues
 *
 * Runs on hover segments to get clean data unaffected by pilot input.
 */
import type { BlackboxFlightData } from '@shared/types/blackbox.types';
import type {
  NoiseProfile,
  HealthSeverity,
  MechanicalHealthIssue,
  MechanicalHealthResult,
} from '@shared/types/analysis.types';
import { THROTTLE_MIN_FLIGHT, THROTTLE_MAX_HOVER, NOISE_LEVEL_BY_SIZE } from './constants';
import { computePowerSpectrum, trimSpectrum } from './FFTCompute';
import type { DroneSize } from '@shared/types/profile.types';

export type { HealthSeverity, MechanicalHealthIssue, MechanicalHealthResult };

// ---- Constants ----

/** Noise floor above this dB level indicates extreme noise (mechanical issue).
 * v2 power-spectrum scale. Baseline for a 5" quad; smaller quads are naturally
 * noisier, so the effective threshold is derived from NOISE_LEVEL_BY_SIZE
 * (highDb + margin) when the drone size is known — a healthy whoop hovers
 * around -10…-5 dB on this scale and must not be flagged as damaged hardware. */
export const EXTREME_NOISE_FLOOR_DB = -10;

/** Margin (dB) above the size's "high noise" classification threshold before
 * noise is considered a mechanical fault rather than just a dirty build. */
export const EXTREME_NOISE_MARGIN_DB = 5;

/** Resolve the extreme-noise threshold for a drone size (falls back to 5" baseline). */
export function resolveExtremeNoiseThresholdDb(droneSize?: DroneSize): number {
  if (!droneSize) return EXTREME_NOISE_FLOOR_DB;
  const levels = NOISE_LEVEL_BY_SIZE[droneSize];
  if (!levels) return EXTREME_NOISE_FLOOR_DB;
  return Math.max(EXTREME_NOISE_FLOOR_DB, levels.highDb + EXTREME_NOISE_MARGIN_DB);
}

/** Per-axis noise floor difference above this dB indicates asymmetry */
export const AXIS_ASYMMETRY_THRESHOLD_DB = 8;

/** Motor variance ratio — if max/min axis variance > this, motors are imbalanced */
export const MOTOR_VARIANCE_RATIO_THRESHOLD = 3.0;

/** Minimum hover duration for motor analysis (seconds) */
const MIN_HOVER_DURATION_S = 1.0;

// ---- Per-motor spectral fault signatures (P3.4, experimental) ----

/** Rotation-order band searched for a bent-prop / imbalance signature (Hz).
 * The PID loop counteracts a 1×/rev vibration, which shows up as a
 * narrowband peak in that motor's COMMAND signal at the rotation frequency. */
export const MOTOR_ORDER_MIN_HZ = 60;
export const MOTOR_ORDER_MAX_HZ = 350;
/** One motor's order peak must exceed the other motors' level at the same
 * frequency by this much to flag a prop signature */
export const MOTOR_PEAK_DELTA_DB = 8;
/** Broadband band checked for a bearing-wear signature (Hz) */
export const MOTOR_BROADBAND_MIN_HZ = 200;
export const MOTOR_BROADBAND_MAX_HZ = 500;
/** One motor's broadband median must sit this far above the others' median */
export const MOTOR_BROADBAND_DELTA_DB = 6;
/** Minimum samples for per-motor spectral analysis */
const MOTOR_SPECTRUM_MIN_SAMPLES = 4096;
/** FFT window for per-motor spectra */
const MOTOR_SPECTRUM_WINDOW = 1024;

// ---- Implementation ----

/**
 * Compute variance of samples within hover segments.
 */
function computeHoverVariance(
  values: Float64Array,
  throttle: Float64Array,
  sampleRateHz: number
): number {
  const minSamples = Math.floor(MIN_HOVER_DURATION_S * sampleRateHz);
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  // Collect hover samples
  for (let i = 0; i < values.length && i < throttle.length; i++) {
    const t = throttle[i];
    if (t >= THROTTLE_MIN_FLIGHT && t <= THROTTLE_MAX_HOVER) {
      sum += values[i];
      count++;
    }
  }

  if (count < minSamples) return 0;

  const mean = sum / count;
  for (let i = 0; i < values.length && i < throttle.length; i++) {
    const t = throttle[i];
    if (t >= THROTTLE_MIN_FLIGHT && t <= THROTTLE_MAX_HOVER) {
      const diff = values[i] - mean;
      sumSq += diff * diff;
    }
  }

  return sumSq / (count - 1);
}

/**
 * Check for extreme noise floor issues from FFT analysis results.
 */
function checkExtremeNoise(
  noiseProfile: NoiseProfile,
  droneSize?: DroneSize
): MechanicalHealthIssue[] {
  const issues: MechanicalHealthIssue[] = [];
  const thresholdDb = resolveExtremeNoiseThresholdDb(droneSize);
  const axes: Array<{ name: 'roll' | 'pitch' | 'yaw'; floor: number }> = [
    { name: 'roll', floor: noiseProfile.roll.noiseFloorDb },
    { name: 'pitch', floor: noiseProfile.pitch.noiseFloorDb },
    { name: 'yaw', floor: noiseProfile.yaw.noiseFloorDb },
  ];

  for (const axis of axes) {
    if (axis.floor > thresholdDb) {
      issues.push({
        type: 'extreme_noise',
        severity: 'critical',
        message: `Extreme noise on ${axis.name} axis (${axis.floor.toFixed(0)} dB). Check for damaged prop, loose motor mount, or excessive vibration.`,
        affectedAxis: axis.name,
        measuredValue: axis.floor,
        threshold: thresholdDb,
      });
    }
  }

  return issues;
}

/**
 * Check for asymmetric noise between axes.
 */
function checkAxisAsymmetry(noiseProfile: NoiseProfile): MechanicalHealthIssue[] {
  const issues: MechanicalHealthIssue[] = [];
  const floors = {
    roll: noiseProfile.roll.noiseFloorDb,
    pitch: noiseProfile.pitch.noiseFloorDb,
    yaw: noiseProfile.yaw.noiseFloorDb,
  };

  // Compare roll vs pitch (should be similar on a symmetric quad)
  const rpDiff = Math.abs(floors.roll - floors.pitch);
  if (rpDiff > AXIS_ASYMMETRY_THRESHOLD_DB) {
    const louder = floors.roll > floors.pitch ? 'roll' : 'pitch';
    issues.push({
      type: 'axis_asymmetry',
      severity: 'warning',
      message: `Asymmetric noise: ${louder} axis is ${rpDiff.toFixed(0)} dB louder than ${louder === 'roll' ? 'pitch' : 'roll'}. May indicate a bent prop, damaged motor, or gyro mounting issue.`,
      affectedAxis: louder,
      measuredValue: rpDiff,
      threshold: AXIS_ASYMMETRY_THRESHOLD_DB,
    });
  }

  return issues;
}

/**
 * Check for motor output variance imbalance during hover.
 */
function checkMotorImbalance(flightData: BlackboxFlightData): MechanicalHealthIssue[] {
  const issues: MechanicalHealthIssue[] = [];
  const { motor, setpoint, sampleRateHz } = flightData;

  // Need 4 motor channels and throttle data
  if (motor.length < 4 || setpoint.length < 4) return issues;

  const throttle = setpoint[3].values;
  const motorVariances: number[] = [];

  for (let m = 0; m < 4; m++) {
    const variance = computeHoverVariance(motor[m].values, throttle, sampleRateHz);
    motorVariances.push(variance);
  }

  // Check if all motors have data
  if (motorVariances.every((v) => v === 0)) return issues;

  const nonZero = motorVariances.filter((v) => v > 0);
  if (nonZero.length < 2) return issues;

  const maxVar = Math.max(...nonZero);
  const minVar = Math.min(...nonZero);

  if (minVar > 0 && maxVar / minVar > MOTOR_VARIANCE_RATIO_THRESHOLD) {
    const worstMotor = motorVariances.indexOf(maxVar);
    issues.push({
      type: 'motor_imbalance',
      severity: 'warning',
      message: `Motor ${worstMotor + 1} shows ${(maxVar / minVar).toFixed(1)}x more variance than the quietest motor during hover. Check for damaged motor, ESC issue, or uneven prop balance.`,
      measuredValue: maxVar / minVar,
      threshold: MOTOR_VARIANCE_RATIO_THRESHOLD,
    });
  }

  return issues;
}

/** Median of an array (non-mutating) */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Per-motor order/spectral analysis (P3.4, experimental).
 *
 * Computes each motor command signal's power spectrum and compares the four
 * signatures against each other (relative comparison — the absolute motor
 * scale cancels):
 * - A narrowband peak on ONE motor that the others lack at the same frequency
 *   (rotation-order band) → bent prop / prop imbalance signature.
 * - One motor's broadband level sitting well above the others in the bearing
 *   band → bearing-wear signature.
 *
 * Both flags are informational and marked experimental — thresholds are being
 * calibrated from telemetry before they can gate anything.
 */
export function checkMotorSpectralSignatures(
  flightData: BlackboxFlightData
): MechanicalHealthIssue[] {
  const issues: MechanicalHealthIssue[] = [];
  const { motor, sampleRateHz } = flightData;
  if (motor.length < 4) return issues;
  if (motor.some((m) => m.values.length < MOTOR_SPECTRUM_MIN_SAMPLES)) return issues;

  // Per-motor spectra over the shared rotation-order + bearing range
  const spectra = motor.map((m) => {
    const full = computePowerSpectrum(m.values, sampleRateHz, MOTOR_SPECTRUM_WINDOW);
    return trimSpectrum(full, MOTOR_ORDER_MIN_HZ, MOTOR_BROADBAND_MAX_HZ);
  });
  const numBins = Math.min(...spectra.map((s) => s.frequencies.length));
  if (numBins < 8) return issues;

  // ── Bent-prop / imbalance: strongest per-motor order peak vs the others ──
  let worstProp: { motorIdx: number; freq: number; delta: number } | null = null;
  for (let m = 0; m < 4; m++) {
    for (let i = 0; i < numBins; i++) {
      const f = spectra[m].frequencies[i];
      if (f < MOTOR_ORDER_MIN_HZ || f > MOTOR_ORDER_MAX_HZ) continue;
      const own = spectra[m].magnitudes[i];
      const others = spectra
        .filter((_, idx) => idx !== m)
        .map((s) => s.magnitudes[Math.min(i, s.frequencies.length - 1)]);
      const delta = own - median(others);
      if (delta >= MOTOR_PEAK_DELTA_DB && (!worstProp || delta > worstProp.delta)) {
        worstProp = { motorIdx: m, freq: f, delta };
      }
    }
  }
  if (worstProp) {
    issues.push({
      type: 'motor_prop_signature',
      severity: 'info',
      message:
        `(Experimental) Motor ${worstProp.motorIdx + 1} shows a vibration signature at ` +
        `${Math.round(worstProp.freq)} Hz that is ${worstProp.delta.toFixed(0)} dB stronger than ` +
        'the other motors at the same frequency — consistent with a bent or unbalanced prop on ' +
        'that corner. Inspect the prop and motor bell.',
      measuredValue: Math.round(worstProp.delta * 10) / 10,
      threshold: MOTOR_PEAK_DELTA_DB,
      experimental: true,
    });
  }

  // ── Bearing wear: broadband median in the bearing band vs the others ──
  const broadbandMedians = spectra.map((s) => {
    const vals: number[] = [];
    for (let i = 0; i < s.frequencies.length; i++) {
      const f = s.frequencies[i];
      if (f >= MOTOR_BROADBAND_MIN_HZ && f <= MOTOR_BROADBAND_MAX_HZ) {
        vals.push(s.magnitudes[i]);
      }
    }
    return vals.length > 0 ? median(vals) : -Infinity;
  });
  if (broadbandMedians.every((v) => Number.isFinite(v))) {
    for (let m = 0; m < 4; m++) {
      const others = broadbandMedians.filter((_, idx) => idx !== m);
      const delta = broadbandMedians[m] - median(others);
      if (delta >= MOTOR_BROADBAND_DELTA_DB) {
        issues.push({
          type: 'motor_bearing_signature',
          severity: 'info',
          message:
            `(Experimental) Motor ${m + 1} shows ${delta.toFixed(0)} dB more broadband noise in the ` +
            `${MOTOR_BROADBAND_MIN_HZ}-${MOTOR_BROADBAND_MAX_HZ} Hz band than the other motors — ` +
            'consistent with bearing wear. Spin the motor by hand and listen for grinding.',
          measuredValue: Math.round(delta * 10) / 10,
          threshold: MOTOR_BROADBAND_DELTA_DB,
          experimental: true,
        });
        break; // one bearing flag is enough per flight
      }
    }
  }

  return issues;
}

/**
 * Generate overall summary from issues.
 */
function generateSummary(status: HealthSeverity, issues: MechanicalHealthIssue[]): string {
  if (status === 'ok') {
    return 'Mechanical health looks good. No hardware issues detected.';
  }

  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;

  if (criticalCount > 0) {
    return `Critical mechanical issues detected (${criticalCount} critical, ${warningCount} warning). Address hardware problems before tuning.`;
  }

  return `${warningCount} mechanical warning${warningCount > 1 ? 's' : ''} detected. Consider inspecting hardware before fine-tuning.`;
}

/**
 * Run mechanical health diagnostic on flight data.
 *
 * Checks for hardware issues that should be addressed before PID tuning.
 * Requires a NoiseProfile from FFT analysis (run filter analysis first).
 *
 * @param flightData - Parsed blackbox flight data
 * @param noiseProfile - Noise profile from filter analysis
 * @returns Diagnostic result with issues and recommendations
 */
export function checkMechanicalHealth(
  flightData: BlackboxFlightData,
  noiseProfile: NoiseProfile,
  droneSize?: DroneSize
): MechanicalHealthResult {
  const issues: MechanicalHealthIssue[] = [];

  // Check 1: Extreme noise floor (size-aware — whoops are naturally noisier)
  issues.push(...checkExtremeNoise(noiseProfile, droneSize));

  // Check 2: Axis asymmetry
  issues.push(...checkAxisAsymmetry(noiseProfile));

  // Check 3: Motor imbalance
  issues.push(...checkMotorImbalance(flightData));

  // Check 4: Per-motor spectral fault signatures (P3.4, experimental, info-only)
  issues.push(...checkMotorSpectralSignatures(flightData));

  // Determine overall status (experimental info flags never change it)
  let status: HealthSeverity = 'ok';
  if (issues.some((i) => i.severity === 'critical')) {
    status = 'critical';
  } else if (issues.some((i) => i.severity === 'warning')) {
    status = 'warning';
  }

  // Extract noise floors for result
  const noiseFloors = {
    roll: noiseProfile.roll.noiseFloorDb,
    pitch: noiseProfile.pitch.noiseFloorDb,
    yaw: noiseProfile.yaw.noiseFloorDb,
  };

  // Motor variance (if available)
  let motorVariance: [number, number, number, number] | undefined;
  if (flightData.motor.length >= 4 && flightData.setpoint.length >= 4) {
    const throttle = flightData.setpoint[3].values;
    motorVariance = [0, 0, 0, 0];
    for (let m = 0; m < 4; m++) {
      motorVariance[m] = computeHoverVariance(
        flightData.motor[m].values,
        throttle,
        flightData.sampleRateHz
      );
    }
  }

  return {
    status,
    issues,
    noiseFloors,
    motorVariance,
    summary: generateSummary(status, issues),
  };
}
