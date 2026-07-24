import { describe, it, expect } from 'vitest';
import {
  detectFilterConvergence,
  detectPIDConvergence,
  detectFlashConvergence,
} from './ConvergenceDetector';
import type {
  FilterMetricsSummary,
  PIDMetricsSummary,
  TransferFunctionMetricsSummary,
} from '@shared/types/tuning-history.types';
import type { PIDConfiguration } from '@shared/types/pid.types';

// ---- Test helpers ----

function makeFilterMetrics(
  rollFloor: number,
  pitchFloor: number,
  yawFloor: number
): FilterMetricsSummary {
  return {
    noiseLevel: 'medium',
    roll: { noiseFloorDb: rollFloor, peakCount: 1 },
    pitch: { noiseFloorDb: pitchFloor, peakCount: 1 },
    yaw: { noiseFloorDb: yawFloor, peakCount: 0 },
    segmentsUsed: 3,
    summary: 'test',
  };
}

const defaultPIDs: PIDConfiguration = {
  roll: { P: 45, I: 80, D: 30 },
  pitch: { P: 47, I: 84, D: 32 },
  yaw: { P: 45, I: 80, D: 0 },
};

function makePIDMetrics(
  rollOvershoot: number,
  pitchOvershoot: number,
  yawOvershoot: number,
  rollSettling: number = 100,
  pitchSettling: number = 100,
  yawSettling: number = 100
): PIDMetricsSummary {
  return {
    roll: {
      meanOvershoot: rollOvershoot,
      meanRiseTimeMs: 20,
      meanSettlingTimeMs: rollSettling,
      meanLatencyMs: 5,
    },
    pitch: {
      meanOvershoot: pitchOvershoot,
      meanRiseTimeMs: 20,
      meanSettlingTimeMs: pitchSettling,
      meanLatencyMs: 5,
    },
    yaw: {
      meanOvershoot: yawOvershoot,
      meanRiseTimeMs: 25,
      meanSettlingTimeMs: yawSettling,
      meanLatencyMs: 8,
    },
    stepsDetected: 15,
    currentPIDs: defaultPIDs,
    summary: 'test',
  };
}

function makeTFMetrics(
  bw: number = 50,
  pm: number = 45,
  overshoot: number = 15
): TransferFunctionMetricsSummary {
  const axis = {
    bandwidthHz: bw,
    phaseMarginDeg: pm,
    gainMarginDb: 10,
    overshootPercent: overshoot,
    settlingTimeMs: 100,
    riseTimeMs: 20,
  };
  return { roll: { ...axis }, pitch: { ...axis }, yaw: { ...axis } };
}

// ---- Filter convergence ----

describe('detectFilterConvergence', () => {
  it('detects convergence when noise floor changed < 1.5 dB', () => {
    const initial = makeFilterMetrics(-50, -48, -45);
    const verification = makeFilterMetrics(-51, -49, -45.5); // ~1 dB improvement
    const result = detectFilterConvergence(initial, verification);
    expect(result.status).toBe('converged');
  });

  it('detects diminishing returns when noise floor changed 1.5-3 dB', () => {
    const initial = makeFilterMetrics(-50, -48, -45);
    const verification = makeFilterMetrics(-52.5, -50, -47); // ~2.5 dB improvement
    const result = detectFilterConvergence(initial, verification);
    expect(result.status).toBe('diminishing_returns');
  });

  it('continues when noise floor improved significantly', () => {
    const initial = makeFilterMetrics(-50, -48, -45);
    const verification = makeFilterMetrics(-55, -53, -50); // 5 dB improvement
    const result = detectFilterConvergence(initial, verification);
    expect(result.status).toBe('continue');
  });

  it('does not declare convergence on regression', () => {
    const initial = makeFilterMetrics(-50, -48, -45);
    const verification = makeFilterMetrics(-49, -47, -44); // 1 dB regression
    const result = detectFilterConvergence(initial, verification);
    expect(result.status).toBe('continue');
    expect(result.improvementDelta).toBeGreaterThan(0); // positive = worse
  });

  it('includes per-axis details', () => {
    const initial = makeFilterMetrics(-50, -48, -45);
    const verification = makeFilterMetrics(-51, -49, -46);
    const result = detectFilterConvergence(initial, verification);
    expect(result.details).toHaveLength(3);
    expect(result.details[0].metric).toBe('roll noise floor');
    expect(result.details[0].unit).toBe('dB');
  });
});

// ---- PID convergence ----

describe('detectPIDConvergence', () => {
  it('detects convergence when overshoot and settling barely changed', () => {
    const initial = makePIDMetrics(15, 12, 8, 100, 95, 80);
    const verification = makePIDMetrics(14.5, 11.5, 7.5, 98, 93, 78);
    const result = detectPIDConvergence(initial, verification);
    expect(result.status).toBe('converged');
  });

  it('detects diminishing returns for moderate changes', () => {
    const initial = makePIDMetrics(15, 12, 8, 100, 95, 80);
    const verification = makePIDMetrics(12, 9, 6, 90, 85, 72);
    const result = detectPIDConvergence(initial, verification);
    expect(result.status).toBe('diminishing_returns');
  });

  it('continues when overshoot changed significantly', () => {
    const initial = makePIDMetrics(25, 22, 15, 150, 140, 120);
    const verification = makePIDMetrics(15, 12, 8, 100, 95, 80);
    const result = detectPIDConvergence(initial, verification);
    expect(result.status).toBe('continue');
  });

  it('includes both overshoot and settling details per axis', () => {
    const initial = makePIDMetrics(15, 12, 8);
    const verification = makePIDMetrics(14, 11, 7);
    const result = detectPIDConvergence(initial, verification);
    expect(result.details).toHaveLength(6); // 3 axes × 2 metrics
  });
});

// ---- Flash convergence ----

describe('detectFlashConvergence', () => {
  it('detects convergence when BW and PM barely changed', () => {
    const initial = makeTFMetrics(50, 45, 15);
    const verification = makeTFMetrics(51, 44, 14);
    const result = detectFlashConvergence(initial, verification);
    expect(result.status).toBe('converged');
  });

  it('detects diminishing returns for moderate TF changes', () => {
    const initial = makeTFMetrics(50, 45);
    const verification = makeTFMetrics(54, 41);
    const result = detectFlashConvergence(initial, verification);
    expect(result.status).toBe('diminishing_returns');
  });

  it('continues when bandwidth improved significantly', () => {
    const initial = makeTFMetrics(35, 40);
    const verification = makeTFMetrics(55, 50);
    const result = detectFlashConvergence(initial, verification);
    expect(result.status).toBe('continue');
  });

  it('includes filter metrics when provided', () => {
    const initial = makeTFMetrics(50, 45);
    const verification = makeTFMetrics(51, 44);
    const initFilter = makeFilterMetrics(-50, -48, -45);
    const verFilter = makeFilterMetrics(-50.5, -48.5, -45.5);
    const result = detectFlashConvergence(initial, verification, initFilter, verFilter);
    expect(result.status).toBe('converged');
    expect(result.details.length).toBeGreaterThan(6); // TF + noise details
  });

  it('handles null filter metrics gracefully', () => {
    const initial = makeTFMetrics(50, 45);
    const verification = makeTFMetrics(51, 44);
    const result = detectFlashConvergence(initial, verification, null, null);
    expect(result.status).toBe('converged');
  });
});

describe('spectrum scale version guard', () => {
  const makeSummary = (floor: number, version?: number) => ({
    noiseLevel: 'medium' as const,
    roll: { noiseFloorDb: floor, peakCount: 0 },
    pitch: { noiseFloorDb: floor, peakCount: 0 },
    yaw: { noiseFloorDb: floor, peakCount: 0 },
    segmentsUsed: 3,
    summary: '',
    ...(version !== undefined ? { spectrumScaleVersion: version } : {}),
  });

  it('does not report a phantom regression across scale versions', () => {
    // v1 initial (-30 on old scale) vs v2 verification (-20 = same physical
    // noise on the new scale) — would read as +10 dB "regression"
    const result = detectFilterConvergence(makeSummary(-30), makeSummary(-20, 2));
    expect(result.status).toBe('continue');
    expect(result.improvementDelta).toBe(0);
    expect(result.message).toContain('not directly comparable');
  });

  it('compares normally when both sides are on the same version', () => {
    const result = detectFilterConvergence(makeSummary(-20, 2), makeSummary(-25, 2));
    expect(result.message).not.toContain('not directly comparable');
    expect(result.details.length).toBe(3);
  });
});

describe('flash convergence phase-margin sentinel guard', () => {
  const makeTF = (pm: number, crossingFound?: boolean) => {
    const axis = {
      bandwidthHz: 50,
      phaseMarginDeg: pm,
      gainMarginDb: 10,
      overshootPercent: 10,
      settlingTimeMs: 100,
      riseTimeMs: 30,
      ...(crossingFound !== undefined ? { phaseMarginCrossingFound: crossingFound } : {}),
    };
    return { roll: axis, pitch: axis, yaw: axis };
  };

  it('ignores the 90° placeholder when the crossing was not found', () => {
    // initial measured 45°, verification capped 90° (no crossing) — the ±45°
    // "delta" is an artifact and must not block convergence
    const result = detectFlashConvergence(makeTF(45, true), makeTF(90, false));
    expect(result.status).toBe('converged');
    expect(result.details.some((d) => d.metric.includes('phase margin'))).toBe(false);
  });

  it('uses measured phase margins normally', () => {
    const result = detectFlashConvergence(makeTF(45, true), makeTF(75, true));
    expect(result.details.some((d) => d.metric.includes('phase margin'))).toBe(true);
    expect(result.status).toBe('continue');
  });
});
