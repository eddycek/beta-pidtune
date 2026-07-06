import { describe, it, expect } from 'vitest';
import {
  checkMechanicalHealth,
  resolveExtremeNoiseThresholdDb,
  EXTREME_NOISE_FLOOR_DB,
  EXTREME_NOISE_MARGIN_DB,
  AXIS_ASYMMETRY_THRESHOLD_DB,
  MOTOR_VARIANCE_RATIO_THRESHOLD,
} from './MechanicalHealthChecker';
import type { NoiseProfile } from '@shared/types/analysis.types';
import type { BlackboxFlightData, TimeSeries } from '@shared/types/blackbox.types';

function makeSeries(length: number, fn: (i: number) => number): TimeSeries {
  const time = new Float64Array(length);
  const values = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    time[i] = i / 4000;
    values[i] = fn(i);
  }
  return { time, values };
}

function makeFlightData(opts?: {
  length?: number;
  throttle?: number;
  motorFns?: Array<(i: number) => number>;
}): BlackboxFlightData {
  const length = opts?.length ?? 20000;
  const throttle = opts?.throttle ?? 0.5;
  const zero = makeSeries(length, () => 0);

  const motorFns = opts?.motorFns ?? [() => 0.5, () => 0.5, () => 0.5, () => 0.5];

  return {
    gyro: [
      makeSeries(length, (i) => Math.sin(i * 0.1) * 5),
      makeSeries(length, (i) => Math.sin(i * 0.1) * 5),
      makeSeries(length, (i) => Math.sin(i * 0.1) * 5),
    ],
    setpoint: [zero, zero, zero, makeSeries(length, () => throttle)],
    pidP: [zero, zero, zero] as [TimeSeries, TimeSeries, TimeSeries],
    pidI: [zero, zero, zero] as [TimeSeries, TimeSeries, TimeSeries],
    pidD: [zero, zero, zero] as [TimeSeries, TimeSeries, TimeSeries],
    pidF: [zero, zero, zero] as [TimeSeries, TimeSeries, TimeSeries],
    motor: [
      makeSeries(length, motorFns[0]),
      makeSeries(length, motorFns[1]),
      makeSeries(length, motorFns[2]),
      makeSeries(length, motorFns[3]),
    ] as [TimeSeries, TimeSeries, TimeSeries, TimeSeries],
    debug: [],
    sampleRateHz: 4000,
    durationSeconds: length / 4000,
    frameCount: length,
  };
}

function makeNoiseProfile(opts?: {
  rollFloor?: number;
  pitchFloor?: number;
  yawFloor?: number;
}): NoiseProfile {
  const spec = {
    frequencies: new Float64Array([100, 200]),
    magnitudes: new Float64Array([-40, -50]),
  };
  return {
    roll: { spectrum: spec, noiseFloorDb: opts?.rollFloor ?? -45, peaks: [] },
    pitch: { spectrum: spec, noiseFloorDb: opts?.pitchFloor ?? -45, peaks: [] },
    yaw: { spectrum: spec, noiseFloorDb: opts?.yawFloor ?? -45, peaks: [] },
    overallLevel: 'low',
  };
}

describe('checkMechanicalHealth', () => {
  it('should return ok status for healthy flight data', () => {
    const data = makeFlightData();
    const noise = makeNoiseProfile();
    const result = checkMechanicalHealth(data, noise);

    expect(result.status).toBe('ok');
    expect(result.issues).toHaveLength(0);
    expect(result.summary).toContain('looks good');
  });

  it('should detect extreme noise on roll axis', () => {
    const data = makeFlightData();
    // Set both axes near extreme to avoid asymmetry false positive
    const noise = makeNoiseProfile({ rollFloor: -15, pitchFloor: -18 });
    const result = checkMechanicalHealth(data, noise);

    expect(result.status).toBe('critical');
    const noiseIssues = result.issues.filter((i) => i.type === 'extreme_noise');
    expect(noiseIssues.length).toBeGreaterThanOrEqual(1);
    expect(noiseIssues[0].affectedAxis).toBe('roll');
    expect(noiseIssues[0].measuredValue).toBe(-15);
    expect(noiseIssues[0].threshold).toBe(EXTREME_NOISE_FLOOR_DB);
  });

  it('should detect extreme noise on multiple axes', () => {
    const data = makeFlightData();
    const noise = makeNoiseProfile({ rollFloor: -10, pitchFloor: -5 });
    const result = checkMechanicalHealth(data, noise);

    expect(result.status).toBe('critical');
    expect(result.issues.filter((i) => i.type === 'extreme_noise')).toHaveLength(2);
  });

  it('should not flag noise at exactly the threshold', () => {
    const data = makeFlightData();
    const noise = makeNoiseProfile({ rollFloor: EXTREME_NOISE_FLOOR_DB });
    const result = checkMechanicalHealth(data, noise);

    expect(result.issues.filter((i) => i.type === 'extreme_noise')).toHaveLength(0);
  });

  it('should detect roll-pitch asymmetry', () => {
    const data = makeFlightData();
    const noise = makeNoiseProfile({ rollFloor: -30, pitchFloor: -45 });
    const result = checkMechanicalHealth(data, noise);

    expect(result.status).toBe('warning');
    const asymmetryIssues = result.issues.filter((i) => i.type === 'axis_asymmetry');
    expect(asymmetryIssues).toHaveLength(1);
    expect(asymmetryIssues[0].affectedAxis).toBe('roll');
    expect(asymmetryIssues[0].measuredValue).toBe(15);
    expect(asymmetryIssues[0].threshold).toBe(AXIS_ASYMMETRY_THRESHOLD_DB);
  });

  it('should not flag small axis differences', () => {
    const data = makeFlightData();
    const noise = makeNoiseProfile({ rollFloor: -42, pitchFloor: -45 });
    const result = checkMechanicalHealth(data, noise);

    expect(result.issues.filter((i) => i.type === 'axis_asymmetry')).toHaveLength(0);
  });

  it('should detect motor imbalance during hover', () => {
    const data = makeFlightData({
      motorFns: [
        (i) => 0.5 + Math.sin(i * 0.01) * 0.01, // Calm motor 1
        (i) => 0.5 + Math.sin(i * 0.01) * 0.01, // Calm motor 2
        (i) => 0.5 + Math.sin(i * 0.01) * 0.01, // Calm motor 3
        (i) => 0.5 + Math.sin(i * 0.1) * 0.1, // Noisy motor 4
      ],
    });
    const noise = makeNoiseProfile();
    const result = checkMechanicalHealth(data, noise);

    const motorIssues = result.issues.filter((i) => i.type === 'motor_imbalance');
    expect(motorIssues).toHaveLength(1);
    expect(motorIssues[0].message).toContain('Motor 4');
    expect(motorIssues[0].measuredValue).toBeGreaterThan(MOTOR_VARIANCE_RATIO_THRESHOLD);
  });

  it('should not flag motor imbalance with equal motors', () => {
    const data = makeFlightData({
      motorFns: [
        (i) => 0.5 + Math.sin(i * 0.1) * 0.05,
        (i) => 0.5 + Math.sin(i * 0.1) * 0.05,
        (i) => 0.5 + Math.sin(i * 0.1) * 0.05,
        (i) => 0.5 + Math.sin(i * 0.1) * 0.05,
      ],
    });
    const noise = makeNoiseProfile();
    const result = checkMechanicalHealth(data, noise);

    expect(result.issues.filter((i) => i.type === 'motor_imbalance')).toHaveLength(0);
  });

  it('should skip motor analysis when throttle is out of hover range', () => {
    const data = makeFlightData({
      throttle: 0.0, // Not hovering
      motorFns: [(i) => Math.sin(i * 0.1) * 0.1, () => 0.5, () => 0.5, () => 0.5],
    });
    const noise = makeNoiseProfile();
    const result = checkMechanicalHealth(data, noise);

    expect(result.issues.filter((i) => i.type === 'motor_imbalance')).toHaveLength(0);
  });

  it('should combine critical and warning issues correctly', () => {
    const data = makeFlightData({
      motorFns: [
        (i) => 0.5 + Math.sin(i * 0.01) * 0.01,
        (i) => 0.5 + Math.sin(i * 0.01) * 0.01,
        (i) => 0.5 + Math.sin(i * 0.01) * 0.01,
        (i) => 0.5 + Math.sin(i * 0.1) * 0.1,
      ],
    });
    const noise = makeNoiseProfile({ rollFloor: -10, pitchFloor: -42 });
    const result = checkMechanicalHealth(data, noise);

    expect(result.status).toBe('critical');
    expect(result.issues.length).toBeGreaterThanOrEqual(3); // extreme_noise + asymmetry + motor
    expect(result.summary).toContain('Critical mechanical issues');
  });

  it('should include noise floors in result', () => {
    const data = makeFlightData();
    const noise = makeNoiseProfile({ rollFloor: -35, pitchFloor: -40, yawFloor: -38 });
    const result = checkMechanicalHealth(data, noise);

    expect(result.noiseFloors.roll).toBe(-35);
    expect(result.noiseFloors.pitch).toBe(-40);
    expect(result.noiseFloors.yaw).toBe(-38);
  });

  it('should include motor variance in result when motor data available', () => {
    const data = makeFlightData();
    const noise = makeNoiseProfile();
    const result = checkMechanicalHealth(data, noise);

    expect(result.motorVariance).toBeDefined();
    expect(result.motorVariance).toHaveLength(4);
  });

  it('should generate correct summary for warning-only issues', () => {
    const data = makeFlightData();
    const noise = makeNoiseProfile({ rollFloor: -30, pitchFloor: -45 });
    const result = checkMechanicalHealth(data, noise);

    expect(result.status).toBe('warning');
    expect(result.summary).toContain('warning');
    expect(result.summary).toContain('inspecting hardware');
  });
});

describe('resolveExtremeNoiseThresholdDb (size-aware)', () => {
  it('returns -20 fallback when size is undefined', () => {
    expect(resolveExtremeNoiseThresholdDb(undefined)).toBe(EXTREME_NOISE_FLOOR_DB);
    expect(resolveExtremeNoiseThresholdDb(undefined)).toBe(-20);
  });

  it('returns -10 for 1" whoops (NOISE_LEVEL_BY_SIZE highDb -15 + 5 margin)', () => {
    expect(resolveExtremeNoiseThresholdDb('1"')).toBe(-15 + EXTREME_NOISE_MARGIN_DB);
    expect(resolveExtremeNoiseThresholdDb('1"')).toBe(-10);
  });

  it('returns -15 for 2.5" micros', () => {
    expect(resolveExtremeNoiseThresholdDb('2.5"')).toBe(-15);
  });

  it('never relaxes below the -20 dB 5" baseline for larger quads', () => {
    // 5": max(-20, -30+5) = -20; 7": max(-20, -35+5) = -20
    expect(resolveExtremeNoiseThresholdDb('5"')).toBe(-20);
    expect(resolveExtremeNoiseThresholdDb('6"')).toBe(-20);
    expect(resolveExtremeNoiseThresholdDb('7"')).toBe(-20);
  });
});

describe('checkMechanicalHealth size-aware extreme noise', () => {
  it('does NOT flag a -18 dB floor on a 1" whoop (healthy whoop noise level)', () => {
    const data = makeFlightData();
    const noise = makeNoiseProfile({ rollFloor: -18, pitchFloor: -18, yawFloor: -18 });
    const result = checkMechanicalHealth(data, noise, '1"');

    expect(result.issues.filter((i) => i.type === 'extreme_noise')).toHaveLength(0);
    expect(result.status).toBe('ok');
  });

  it('DOES flag a -18 dB floor on a 5" quad (above -20 dB threshold)', () => {
    const data = makeFlightData();
    const noise = makeNoiseProfile({ rollFloor: -18, pitchFloor: -18, yawFloor: -18 });
    const result = checkMechanicalHealth(data, noise, '5"');

    const noiseIssues = result.issues.filter((i) => i.type === 'extreme_noise');
    expect(noiseIssues).toHaveLength(3);
    expect(result.status).toBe('critical');
    expect(noiseIssues[0].threshold).toBe(-20);
  });

  it('falls back to the -20 dB threshold when size is undefined', () => {
    const data = makeFlightData();
    const noise = makeNoiseProfile({ rollFloor: -18, pitchFloor: -18, yawFloor: -18 });
    const result = checkMechanicalHealth(data, noise);

    expect(result.issues.filter((i) => i.type === 'extreme_noise')).toHaveLength(3);
    expect(result.status).toBe('critical');
  });

  it('still flags genuinely extreme noise (-5 dB) on a 1" whoop', () => {
    const data = makeFlightData();
    const noise = makeNoiseProfile({ rollFloor: -5, pitchFloor: -5, yawFloor: -5 });
    const result = checkMechanicalHealth(data, noise, '1"');

    const noiseIssues = result.issues.filter((i) => i.type === 'extreme_noise');
    expect(noiseIssues).toHaveLength(3);
    expect(noiseIssues[0].threshold).toBe(-10);
  });
});
