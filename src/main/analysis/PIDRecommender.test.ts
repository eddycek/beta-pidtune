import { describe, it, expect } from 'vitest';
import {
  recommendPID,
  generatePIDSummary,
  extractFlightPIDs,
  extractFeedforwardContext,
  extractDMinContext,
  extractTPAContext,
  extractItermRelaxCutoff,
  extractItermRelaxMode,
  recommendItermRelaxCutoff,
  recommendPropWashDMin,
  extractDynIdleMinRpm,
  extractRpmFilterActive,
  recommendDynIdleMinRpm,
  extractPidsumLimits,
  recommendPidsumLimits,
  recommendFFMaxRateLimit,
  extractAntiGravityGain,
  recommendAntiGravityGain,
  extractThrustLinear,
  recommendThrustLinear,
  recommendTPA,
  extractVbatSagCompensation,
  recommendVbatSagCompensation,
} from './PIDRecommender';
import type { DMinContext, TPAContext } from './PIDRecommender';
import type { TransferFunctionContext } from './PIDRecommender';
import type { PIDConfiguration } from '@shared/types/pid.types';
import type {
  AxisStepProfile,
  FeedforwardContext,
  PropWashAnalysis,
  StepResponse,
  StepEvent,
} from '@shared/types/analysis.types';
import type { TransferFunctionMetrics } from './TransferFunctionEstimator';
import { P_GAIN_MAX, D_GAIN_MAX, DAMPING_RATIO_MIN, DAMPING_RATIO_MAX } from './constants';

function makeStep(): StepEvent {
  return { axis: 0, startIndex: 0, endIndex: 1200, magnitude: 300, direction: 'positive' };
}

function makeResponse(overrides: Partial<StepResponse> = {}): StepResponse {
  return {
    step: makeStep(),
    riseTimeMs: 30,
    overshootPercent: 5,
    settlingTimeMs: 80,
    latencyMs: 5,
    ringingCount: 0,
    peakValue: 315,
    steadyStateValue: 300,
    ...overrides,
  };
}

function makeProfile(
  overrides: Partial<AxisStepProfile> & { responses?: StepResponse[] } = {}
): AxisStepProfile {
  const responses = overrides.responses || [makeResponse()];
  return {
    responses,
    meanOvershoot: overrides.meanOvershoot ?? responses[0].overshootPercent,
    meanRiseTimeMs: overrides.meanRiseTimeMs ?? responses[0].riseTimeMs,
    meanSettlingTimeMs: overrides.meanSettlingTimeMs ?? responses[0].settlingTimeMs,
    meanLatencyMs: overrides.meanLatencyMs ?? responses[0].latencyMs,
    meanTrackingErrorRMS: 0,
    meanSteadyStateError: overrides.meanSteadyStateError ?? 0,
  };
}

function emptyProfile(): AxisStepProfile {
  return {
    responses: [],
    meanOvershoot: 0,
    meanRiseTimeMs: 0,
    meanSettlingTimeMs: 0,
    meanLatencyMs: 0,
    meanTrackingErrorRMS: 0,
    meanSteadyStateError: 0,
  };
}

const DEFAULT_PIDS: PIDConfiguration = {
  roll: { P: 45, I: 80, D: 30 },
  pitch: { P: 47, I: 84, D: 32 },
  yaw: { P: 45, I: 80, D: 0 },
};

describe('PIDRecommender', () => {
  describe('recommendPID', () => {
    it('should return no recommendations for a good tune', () => {
      const goodProfile = makeProfile({
        meanOvershoot: 5,
        meanRiseTimeMs: 30,
        meanSettlingTimeMs: 50,
      });

      const recs = recommendPID(goodProfile, goodProfile, emptyProfile(), DEFAULT_PIDS);

      expect(recs.length).toBe(0);
    });

    it('should recommend D increase for moderate overshoot (15-25%)', () => {
      const profile = makeProfile({ meanOvershoot: 20 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(dRec).toBeDefined();
      expect(dRec!.recommendedValue).toBeGreaterThan(DEFAULT_PIDS.roll.D);
      expect(dRec!.reason).toContain('overshoot');
      expect(dRec!.confidence).toBe('medium');
    });

    it('should recommend only D increase for severe overshoot when D is low', () => {
      const profile = makeProfile({ meanOvershoot: 35 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      const pRec = recs.find((r) => r.setting === 'pid_roll_p');
      expect(dRec).toBeDefined();
      expect(dRec!.confidence).toBe('high');
      // D=30 is below 60% of D_GAIN_MAX, so P should NOT be reduced (D-first strategy)
      expect(pRec).toBeUndefined();
    });

    it('should recommend both P decrease and D increase for severe overshoot when D is high', () => {
      // D=50 is already high relative to P=45 (ratio 1.11).
      // Overshoot=35 → severity=1.4, D+5=55, P-5=40 (severity<2 but D≥60% of dMax).
      // Damping ratio: anchorP = max(40, 45) = 45, clampedD = round(45×0.85) = 38.
      // 38 < 50 (currentD) → D rec is REMOVED (counterproductive decrease).
      // Only P decrease survives.
      const highDPids: PIDConfiguration = {
        roll: { P: 45, I: 80, D: 50 }, // D ≥ 60% of 80 = 48
        pitch: { P: 47, I: 84, D: 32 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const profile = makeProfile({ meanOvershoot: 35 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), highDPids);

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      const pRec = recs.find((r) => r.setting === 'pid_roll_p');
      // D rec is removed because clamped D (38) < current D (50)
      expect(dRec).toBeUndefined();
      expect(pRec).toBeDefined();
      expect(pRec!.recommendedValue).toBeLessThan(highDPids.roll.P);
    });

    it('should scale D+10 and reduce P for high overshoot (>2x threshold)', () => {
      // 60% overshoot → severity = 60/25 = 2.4 (>2x)
      const profile = makeProfile({ meanOvershoot: 60 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      const pRec = recs.find((r) => r.setting === 'pid_roll_p');
      expect(dRec).toBeDefined();
      // D initially 30+10=40, P=45-5=40 → ratio 40/40=1.0 > 0.85
      // Damping ratio clamp: anchorP = max(40, 45) = 45, D = round(45 × 0.85) = 38
      expect(dRec!.recommendedValue).toBe(38);
      expect(pRec).toBeDefined();
      expect(pRec!.recommendedValue).toBe(DEFAULT_PIDS.roll.P - 5); // P: 45 - 5 = 40
    });

    it('should scale D+15 and P-10 for extreme overshoot (>4x threshold)', () => {
      // 145% overshoot → severity = 145/25 = 5.8 (>4x)
      const profile = makeProfile({ meanOvershoot: 145 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      const pRec = recs.find((r) => r.setting === 'pid_roll_p');
      expect(dRec).toBeDefined();
      // D initially 30+15=45, P=45-10=35 → ratio 45/35=1.29 > 0.85
      // Damping ratio clamp: anchorP = max(35, 45) = 45, D = round(45 × 0.85) = 38
      expect(dRec!.recommendedValue).toBe(38);
      expect(dRec!.confidence).toBe('low');
      expect(pRec).toBeDefined();
      expect(pRec!.recommendedValue).toBe(DEFAULT_PIDS.roll.P - 10); // P: 45 - 10 = 35
      expect(pRec!.reason).toContain('Extreme');
    });

    it('should drop D rec when damping ratio clamp would decrease D below current', () => {
      // D=70 is already very high. Overshoot=145 → D+15=85→80(dMax), P-10=35.
      // anchorP = max(35, 45) = 45, clampedD = round(45×0.85) = 38. 38 < 70 → D rec removed.
      const highDPids: PIDConfiguration = {
        roll: { P: 45, I: 80, D: 70 }, // near max
        pitch: { P: 47, I: 84, D: 32 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const profile = makeProfile({ meanOvershoot: 145 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), highDPids);

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      // D rec is removed because clamped D (38) < current D (70)
      expect(dRec).toBeUndefined();
      // P decrease should still exist
      const pRec = recs.find((r) => r.setting === 'pid_roll_p');
      expect(pRec).toBeDefined();
    });

    it('should recommend P increase for sluggish response', () => {
      const profile = makeProfile({
        meanOvershoot: 2,
        meanRiseTimeMs: 150,
      });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      const pRec = recs.find((r) => r.setting === 'pid_roll_p');
      expect(pRec).toBeDefined();
      expect(pRec!.recommendedValue).toBeGreaterThan(DEFAULT_PIDS.roll.P);
      expect(pRec!.reason).toContain('sluggish');
    });

    it('should recommend D increase for excessive ringing', () => {
      const response = makeResponse({ ringingCount: 5 });
      const profile = makeProfile({
        responses: [response],
        meanOvershoot: 10,
      });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(dRec).toBeDefined();
      expect(dRec!.reason).toContain('scillation');
    });

    it('should relax the yaw ringing threshold ×1.5 (like overshoot/sluggish)', () => {
      // Balanced ringingMax = 2 → yaw threshold = 3. Yaw needs D > 0 for D recs.
      const yawDPids: PIDConfiguration = {
        roll: { P: 45, I: 80, D: 30 },
        pitch: { P: 47, I: 84, D: 32 },
        yaw: { P: 45, I: 80, D: 20 },
      };
      const ringing3 = makeProfile({
        responses: [makeResponse({ ringingCount: 3 })],
        meanOvershoot: 5,
      });

      // ringingCount 3 on yaw: 3 > 2×1.5 is false → no yaw D rec
      const recsAtThreshold = recommendPID(emptyProfile(), emptyProfile(), ringing3, yawDPids);
      expect(recsAtThreshold.find((r) => r.setting === 'pid_yaw_d')).toBeUndefined();

      // Same ringingCount 3 on roll: 3 > 2 → roll D rec fires (unrelaxed)
      const recsRoll = recommendPID(ringing3, emptyProfile(), emptyProfile(), yawDPids);
      expect(recsRoll.find((r) => r.setting === 'pid_roll_d')).toBeDefined();

      // ringingCount 4 on yaw: 4 > 3 → yaw D rec fires
      const ringing4 = makeProfile({
        responses: [makeResponse({ ringingCount: 4 })],
        meanOvershoot: 5,
      });
      const recsAbove = recommendPID(emptyProfile(), emptyProfile(), ringing4, yawDPids);
      const yawD = recsAbove.find((r) => r.setting === 'pid_yaw_d');
      expect(yawD).toBeDefined();
      expect(yawD!.ruleId).toBe('P-RING-D-yaw');
    });

    it('should respect P gain safety bounds', () => {
      // PIDs already at max
      const maxPIDs: PIDConfiguration = {
        roll: { P: P_GAIN_MAX, I: 80, D: 30 },
        pitch: { P: 47, I: 84, D: 32 },
        yaw: { P: 45, I: 80, D: 0 },
      };

      const sluggish = makeProfile({
        meanOvershoot: 2,
        meanRiseTimeMs: 200,
      });

      const recs = recommendPID(sluggish, emptyProfile(), emptyProfile(), maxPIDs);

      // Should not recommend going above P_GAIN_MAX
      const pRec = recs.find((r) => r.setting === 'pid_roll_p');
      if (pRec) {
        expect(pRec.recommendedValue).toBeLessThanOrEqual(P_GAIN_MAX);
      }
    });

    it('should respect D gain safety bounds', () => {
      const maxPIDs: PIDConfiguration = {
        roll: { P: 45, I: 80, D: D_GAIN_MAX },
        pitch: { P: 47, I: 84, D: 32 },
        yaw: { P: 45, I: 80, D: 0 },
      };

      const profile = makeProfile({ meanOvershoot: 25 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), maxPIDs);

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      if (dRec) {
        expect(dRec.recommendedValue).toBeLessThanOrEqual(D_GAIN_MAX);
      }
    });

    it('should not duplicate D recommendations for same axis', () => {
      // Both overshoot and ringing on same axis
      const response = makeResponse({ ringingCount: 5, overshootPercent: 25 });
      const profile = makeProfile({
        responses: [response],
        meanOvershoot: 25,
      });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      const dRecs = recs.filter((r) => r.setting === 'pid_roll_d');
      expect(dRecs.length).toBeLessThanOrEqual(1);
    });

    it('should skip axes with no step data', () => {
      const recs = recommendPID(emptyProfile(), emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      expect(recs.length).toBe(0);
    });

    it('should generate recommendations for pitch independently', () => {
      const pitchProfile = makeProfile({ meanOvershoot: 25 });

      const recs = recommendPID(emptyProfile(), pitchProfile, emptyProfile(), DEFAULT_PIDS);

      const pitchRecs = recs.filter((r) => r.setting.includes('pitch'));
      expect(pitchRecs.length).toBeGreaterThan(0);
      // Should not have roll recommendations
      const rollRecs = recs.filter((r) => r.setting.includes('roll'));
      expect(rollRecs.length).toBe(0);
    });

    it('should use relaxed thresholds for yaw', () => {
      // 25% overshoot on yaw — should NOT trigger the moderate overshoot rule
      // because yaw uses relaxed moderate threshold (OVERSHOOT_MAX_PERCENT=25 instead of 15)
      const yawProfile = makeProfile({ meanOvershoot: 25 });

      const recs = recommendPID(emptyProfile(), emptyProfile(), yawProfile, DEFAULT_PIDS);

      // At 25%, yaw moderate threshold is 25, so 25 > 25 is false — no overshoot recs
      expect(recs.filter((r) => r.confidence === 'high').length).toBe(0);
      expect(recs.find((r) => r.setting === 'pid_yaw_d')).toBeUndefined();
    });

    it('should include beginner-friendly reason strings', () => {
      const profile = makeProfile({ meanOvershoot: 35 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      for (const rec of recs) {
        expect(rec.reason.length).toBeGreaterThan(20);
        // Should be plain English, not technical jargon
        expect(rec.reason).not.toContain('PSD');
        expect(rec.reason).not.toContain('transfer function');
      }
    });

    it('should recommend D increase for slow settling', () => {
      const profile = makeProfile({
        meanOvershoot: 10,
        meanSettlingTimeMs: 250,
      });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(dRec).toBeDefined();
      expect(dRec!.reason).toContain('settle');
    });

    // --- flightPIDs convergence tests ---

    it('should anchor targets to flightPIDs when provided', () => {
      const flightPIDs: PIDConfiguration = {
        roll: { P: 40, I: 80, D: 25 },
        pitch: { P: 42, I: 84, D: 27 },
        yaw: { P: 40, I: 80, D: 0 },
      };
      // Current PIDs are different (already applied a previous recommendation)
      const currentPIDs: PIDConfiguration = {
        roll: { P: 40, I: 80, D: 30 },
        pitch: { P: 42, I: 84, D: 32 },
        yaw: { P: 40, I: 80, D: 0 },
      };

      const profile = makeProfile({ meanOvershoot: 20 }); // moderate overshoot → D+5

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), currentPIDs, flightPIDs);

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      // Target: flightD + 5 = 25 + 5 = 30, current = 30 → no recommendation (already at target)
      expect(dRec).toBeUndefined();
    });

    it('should converge: applying recommendations as currentPIDs with same flightPIDs yields no recommendations', () => {
      const flightPIDs: PIDConfiguration = {
        roll: { P: 45, I: 80, D: 30 },
        pitch: { P: 47, I: 84, D: 32 },
        yaw: { P: 45, I: 80, D: 0 },
      };

      const overshootProfile = makeProfile({ meanOvershoot: 35 });

      // First run: get recommendations
      const recs1 = recommendPID(
        overshootProfile,
        emptyProfile(),
        emptyProfile(),
        flightPIDs,
        flightPIDs
      );
      expect(recs1.length).toBeGreaterThan(0);

      // Apply recommendations to current PIDs
      const appliedPIDs: PIDConfiguration = JSON.parse(JSON.stringify(flightPIDs));
      for (const rec of recs1) {
        const match = rec.setting.match(/^pid_(roll|pitch|yaw)_(p|i|d)$/i);
        if (match) {
          const axis = match[1] as 'roll' | 'pitch' | 'yaw';
          const term = match[2].toUpperCase() as 'P' | 'I' | 'D';
          appliedPIDs[axis][term] = rec.recommendedValue;
        }
      }

      // Second run: same flight data, same flightPIDs, but applied as current
      const recs2 = recommendPID(
        overshootProfile,
        emptyProfile(),
        emptyProfile(),
        appliedPIDs,
        flightPIDs
      );
      expect(recs2.length).toBe(0);
    });

    it('should still work without flightPIDs (fallback to currentPIDs)', () => {
      const profile = makeProfile({ meanOvershoot: 35 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      // Should still produce recommendations when flightPIDs is undefined
      expect(recs.length).toBeGreaterThan(0);
    });

    // --- FF-aware recommendation tests ---

    it('should recommend feedforward_boost reduction for FF-dominated overshoot', () => {
      const ffResponse = makeResponse({ overshootPercent: 30, ffDominated: true });
      const profile = makeProfile({
        responses: [ffResponse, ffResponse, ffResponse],
        meanOvershoot: 30,
      });
      const ffContext: FeedforwardContext = { active: true, boost: 15 };

      const recs = recommendPID(
        profile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        ffContext
      );

      const ffRec = recs.find((r) => r.setting === 'feedforward_boost');
      expect(ffRec).toBeDefined();
      expect(ffRec!.recommendedValue).toBe(12); // 15 - 3 = 12 (step size reduced from 5 to 3)
      expect(ffRec!.reason).toContain('feedforward');
      // Should NOT have P/D recommendations for this axis
      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      const pRec = recs.find((r) => r.setting === 'pid_roll_p');
      expect(dRec).toBeUndefined();
      expect(pRec).toBeUndefined();
    });

    it('should not classify axis as FF-dominated with fewer than 3 steps', () => {
      // Single FF-dominated step should NOT trigger FF classification
      const ffResponse = makeResponse({ overshootPercent: 30, ffDominated: true });
      const profile = makeProfile({
        responses: [ffResponse],
        meanOvershoot: 30,
      });
      const ffContext: FeedforwardContext = { active: true, boost: 15 };

      const recs = recommendPID(
        profile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        ffContext
      );

      // With only 1 step, axis should NOT be FF-dominated, so no feedforward_boost rec
      const ffRec = recs.find((r) => r.setting === 'feedforward_boost');
      expect(ffRec).toBeUndefined();
      // Instead, standard P/D recommendations should be generated for overshoot
      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(dRec).toBeDefined();
    });

    it('should not classify axis as FF-dominated with exactly 2 steps', () => {
      const ffResponse = makeResponse({ overshootPercent: 30, ffDominated: true });
      const profile = makeProfile({
        responses: [ffResponse, ffResponse],
        meanOvershoot: 30,
      });
      const ffContext: FeedforwardContext = { active: true, boost: 15 };

      const recs = recommendPID(
        profile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        ffContext
      );

      const ffRec = recs.find((r) => r.setting === 'feedforward_boost');
      expect(ffRec).toBeUndefined();
    });

    it('should not recommend FF changes when overshoot is P-dominated', () => {
      const pResponse = makeResponse({ overshootPercent: 30, ffDominated: false });
      const profile = makeProfile({
        responses: [pResponse],
        meanOvershoot: 30,
      });
      const ffContext: FeedforwardContext = { active: true, boost: 15 };

      const recs = recommendPID(
        profile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        ffContext
      );

      const ffRec = recs.find((r) => r.setting === 'feedforward_boost');
      expect(ffRec).toBeUndefined();
      // Should have normal D recommendation
      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(dRec).toBeDefined();
    });

    // --- FlightStyle-aware tests ---

    it('balanced style: identical behavior to default (regression test)', () => {
      const profile = makeProfile({ meanOvershoot: 20 });

      const recsDefault = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);
      const recsBalanced = recommendPID(
        profile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced'
      );

      expect(recsBalanced).toEqual(recsDefault);
    });

    it('smooth style + 10% overshoot: recommends reducing (too high for smooth)', () => {
      // smooth moderateOvershoot = 8, so 10% > 8 → should trigger D increase
      const profile = makeProfile({ meanOvershoot: 10 });

      const recs = recommendPID(
        profile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'smooth'
      );

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(dRec).toBeDefined();
      expect(dRec!.reason).toContain('overshoot');
    });

    it('aggressive style + 20% overshoot: no overshoot recommendation (acceptable)', () => {
      // aggressive moderateOvershoot = 25, overshootMax = 35
      // 20% < 25 → no moderate overshoot rule, and < 35 → no severe rule
      const profile = makeProfile({ meanOvershoot: 20 });

      const recs = recommendPID(
        profile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'aggressive'
      );

      const overshootRecs = recs.filter((r) => r.reason.includes('overshoot'));
      expect(overshootRecs.length).toBe(0);
    });

    it('smooth style + 100ms rise time: no sluggish warning (acceptable for smooth)', () => {
      // smooth sluggishRise = 120, overshootIdeal = 3
      // 100ms < 120 → not sluggish for smooth
      const profile = makeProfile({ meanOvershoot: 2, meanRiseTimeMs: 100 });

      const recs = recommendPID(
        profile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'smooth'
      );

      const sluggishRecs = recs.filter((r) => r.reason.includes('sluggish'));
      expect(sluggishRecs.length).toBe(0);
    });

    it('aggressive style + 70ms rise time: sluggish warning (too slow for aggressive)', () => {
      // aggressive sluggishRise = 50, overshootIdeal = 18
      // 70ms > 50 and meanOvershoot < 18 → sluggish
      const profile = makeProfile({ meanOvershoot: 5, meanRiseTimeMs: 70 });

      const recs = recommendPID(
        profile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'aggressive'
      );

      const sluggishRecs = recs.filter((r) => r.reason.includes('sluggish'));
      expect(sluggishRecs.length).toBeGreaterThan(0);
    });

    it('should emit feedforward_boost recommendation only once across axes', () => {
      const ffResponse = makeResponse({ overshootPercent: 30, ffDominated: true });
      const rollProfile = makeProfile({
        responses: [ffResponse, ffResponse, ffResponse],
        meanOvershoot: 30,
      });
      const pitchProfile = makeProfile({
        responses: [ffResponse, ffResponse, ffResponse],
        meanOvershoot: 30,
      });
      const ffContext: FeedforwardContext = { active: true, boost: 15 };

      const recs = recommendPID(
        rollProfile,
        pitchProfile,
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        ffContext
      );

      const ffRecs = recs.filter((r) => r.setting === 'feedforward_boost');
      expect(ffRecs.length).toBe(1);
    });

    // ---- I-term recommendation tests ----

    it('should recommend I increase when steady-state error is high', () => {
      // balanced: steadyStateErrorMax = 5
      const profile = makeProfile({ meanOvershoot: 5, meanSteadyStateError: 8 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      const iRecs = recs.filter((r) => r.setting === 'pid_roll_i');
      expect(iRecs.length).toBe(1);
      expect(iRecs[0].recommendedValue).toBeGreaterThan(DEFAULT_PIDS.roll.I);
      expect(iRecs[0].reason).toContain('drifts');
      expect(iRecs[0].confidence).toBe('medium');
    });

    it('should recommend larger I increase for very high steady-state error', () => {
      // balanced: steadyStateErrorMax = 5, 2× = 10
      const profile = makeProfile({ meanOvershoot: 5, meanSteadyStateError: 12 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      const iRecs = recs.filter((r) => r.setting === 'pid_roll_i');
      expect(iRecs.length).toBe(1);
      // Should step by 10 instead of 5
      expect(iRecs[0].recommendedValue).toBe(DEFAULT_PIDS.roll.I + 10);
      expect(iRecs[0].confidence).toBe('high');
    });

    it('should not recommend I change when steady-state error is normal', () => {
      const profile = makeProfile({ meanOvershoot: 5, meanSteadyStateError: 3 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      const iRecs = recs.filter((r) => r.setting === 'pid_roll_i');
      expect(iRecs.length).toBe(0);
    });

    it('should recommend I decrease when low error + slow settling + overshoot', () => {
      // balanced: steadyStateErrorLow = 1, settlingMax = 200, moderateOvershoot = 15
      const profile = makeProfile({
        meanOvershoot: 20,
        meanSteadyStateError: 0.5,
        meanSettlingTimeMs: 250,
      });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      const iRecs = recs.filter((r) => r.setting === 'pid_roll_i');
      expect(iRecs.length).toBe(1);
      expect(iRecs[0].recommendedValue).toBeLessThan(DEFAULT_PIDS.roll.I);
      expect(iRecs[0].reason).toContain('settle');
    });

    it('should clamp I recommendations within safety bounds', () => {
      // I already at max → no recommendation
      const highIPIDs: PIDConfiguration = {
        roll: { P: 45, I: 120, D: 30 },
        pitch: { P: 47, I: 84, D: 32 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const profile = makeProfile({ meanOvershoot: 5, meanSteadyStateError: 8 });

      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), highIPIDs);

      const iRecs = recs.filter((r) => r.setting === 'pid_roll_i');
      expect(iRecs.length).toBe(0); // already at max, clamped = same
    });

    it('should use style-specific I-term thresholds', () => {
      // smooth: steadyStateErrorMax = 8 — error of 6 is below threshold
      // balanced: steadyStateErrorMax = 5 — error of 6 exceeds threshold
      const profile = makeProfile({ meanOvershoot: 5, meanSteadyStateError: 6 });

      const smoothRecs = recommendPID(
        profile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'smooth'
      );
      const balancedRecs = recommendPID(
        profile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced'
      );

      const smoothI = smoothRecs.filter((r) => r.setting === 'pid_roll_i');
      const balancedI = balancedRecs.filter((r) => r.setting === 'pid_roll_i');

      expect(smoothI.length).toBe(0); // 6 < 8, within tolerance
      expect(balancedI.length).toBe(1); // 6 > 5, above threshold
    });

    it('summary should mention tracking drift for I-term recommendations', () => {
      const profile = makeProfile({ meanOvershoot: 5, meanSteadyStateError: 8 });
      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);
      const summary = generatePIDSummary(profile, emptyProfile(), emptyProfile(), recs);

      expect(summary).toContain('tracking drift');
    });
  });

  describe('frequency-domain recommendations (tfMetrics)', () => {
    function makeTFMetrics(
      overrides: Partial<TransferFunctionMetrics> = {}
    ): TransferFunctionMetrics {
      return {
        bandwidthHz: 60,
        gainMarginDb: 12,
        phaseMarginDeg: 60,
        overshootPercent: 5,
        settlingTimeMs: 80,
        riseTimeMs: 30,
        dcGainDb: 0,
        ...overrides,
      };
    }

    it('should skip TF rules for an axis with low coherence', () => {
      const tf: TransferFunctionContext = {
        // Critically low phase margin, but the TF is untrustworthy
        roll: makeTFMetrics({ phaseMarginDeg: 25, coherenceMean: 0.2 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      expect(recs.find((r) => r.setting === 'pid_roll_d')).toBeUndefined();
    });

    it('should apply TF rules when coherence is high', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ phaseMarginDeg: 25, coherenceMean: 0.9 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      expect(recs.find((r) => r.setting === 'pid_roll_d')).toBeDefined();
    });

    it('should use TF metrics when responses are empty', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ phaseMarginDeg: 25 }), // critically low
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(dRec).toBeDefined();
      expect(dRec!.reason).toContain('phase margin');
      expect(dRec!.confidence).toBe('medium');
    });

    it('should recommend D+10 for critically low phase margin (<30°)', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ phaseMarginDeg: 25 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(dRec).toBeDefined();
      expect(dRec!.recommendedValue).toBe(DEFAULT_PIDS.roll.D + 10);
    });

    it('should recommend D+5 for low phase margin (30-45°)', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ phaseMarginDeg: 38 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(dRec).toBeDefined();
      expect(dRec!.recommendedValue).toBe(DEFAULT_PIDS.roll.D + 5);
    });

    it('should recommend P increase for low bandwidth', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ bandwidthHz: 25, overshootPercent: 3 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      const pRec = recs.find((r) => r.setting === 'pid_roll_p');
      expect(pRec).toBeDefined();
      expect(pRec!.reason).toContain('bandwidth');
      expect(pRec!.recommendedValue).toBe(DEFAULT_PIDS.roll.P + 5);
    });

    it('should not recommend P increase when overshoot is high despite low bandwidth', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ bandwidthHz: 25, overshootPercent: 15 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      const pRec = recs.find((r) => r.setting === 'pid_roll_p' && r.reason.includes('bandwidth'));
      expect(pRec).toBeUndefined();
    });

    it('should recommend D increase for TF-based overshoot', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ overshootPercent: 35, phaseMarginDeg: 60 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(dRec).toBeDefined();
      expect(dRec!.reason).toContain('overshoot');
    });

    it('should not duplicate D recommendations from phase margin and overshoot', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ phaseMarginDeg: 25, overshootPercent: 35 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      const dRecs = recs.filter((r) => r.setting === 'pid_roll_d');
      expect(dRecs.length).toBe(1);
    });

    it('should return no recommendations when TF metrics are healthy', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics(), // all healthy defaults
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      expect(recs.length).toBe(0);
    });

    it('should prefer step-based rules when responses exist even with tfMetrics', () => {
      const stepProfile = makeProfile({ meanOvershoot: 35 });
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ phaseMarginDeg: 25 }), // would trigger TF rules
      };

      const recsWithTF = recommendPID(
        stepProfile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );
      const recsWithout = recommendPID(stepProfile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);

      // When steps exist, TF metrics are ignored — same recommendations
      expect(recsWithTF).toEqual(recsWithout);
    });

    it('should use relaxed thresholds for yaw axis with TF metrics', () => {
      const tf: TransferFunctionContext = {
        yaw: makeTFMetrics({ bandwidthHz: 25, overshootPercent: 3 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      // yaw bandwidth threshold is 40 * 0.7 = 28, so 25 < 28 → should trigger
      const pRec = recs.find((r) => r.setting === 'pid_yaw_p');
      expect(pRec).toBeDefined();
    });

    it('should cap all TF-based recommendations at medium confidence', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ phaseMarginDeg: 20, overshootPercent: 60 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      for (const rec of recs) {
        // TF recs capped at medium, but damping ratio post-processing may
        // further downgrade to 'low' when both P and D fire on same axis
        expect(['medium', 'low']).toContain(rec.confidence);
      }
    });

    it('Rule TF-4: should recommend I +5 for mild DC gain deficit (balanced threshold −0.446 dB)', () => {
      // Balanced steadyStateErrorMax = 5% → threshold = 20·log10(0.95) ≈ −0.446 dB.
      // −0.6 dB is below threshold but under 2×|threshold| (−0.891) → +5 / low.
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ dcGainDb: -0.6 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      const iRec = recs.find((r) => r.setting === 'pid_roll_i');
      expect(iRec).toBeDefined();
      expect(iRec!.recommendedValue).toBe(DEFAULT_PIDS.roll.I + 5);
      expect(iRec!.confidence).toBe('low');
      expect(iRec!.reason).toContain('DC gain');
    });

    it('Rule TF-4: should recommend I +10 with medium confidence when deficit > 2× threshold', () => {
      // −2.5 dB deficit is well over 2 × 0.446 → escalated step
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ dcGainDb: -2.5 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      const iRec = recs.find((r) => r.setting === 'pid_roll_i');
      expect(iRec).toBeDefined();
      expect(iRec!.recommendedValue).toBe(DEFAULT_PIDS.roll.I + 10);
      expect(iRec!.confidence).toBe('medium');
    });

    it('Rule TF-4: threshold is style-aware — smooth (8% → −0.724 dB) tolerates −0.5 dB', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ dcGainDb: -0.5 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'smooth',
        tf
      );

      // −0.5 dB is above the smooth threshold (−0.724) → no I rec
      const iRec = recs.find((r) => r.setting === 'pid_roll_i');
      expect(iRec).toBeUndefined();
    });

    it('Rule TF-4: aggressive threshold is floored at −0.4 dB (measurement-noise guard)', () => {
      // Aggressive style alone would give −0.265 dB, but the −0.4 dB floor wins:
      // a −0.35 dB reading (inside Wiener noise) must NOT trigger, −0.5 dB must.
      const noTrigger = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'aggressive',
        { roll: makeTFMetrics({ dcGainDb: -0.35 }) }
      );
      expect(noTrigger.find((r) => r.setting === 'pid_roll_i')).toBeUndefined();

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'aggressive',
        { roll: makeTFMetrics({ dcGainDb: -0.5 }) }
      );

      // −0.5 dB exceeds the floored threshold (−0.4) but is under 2× (−0.8) → +5 / low
      const iRec = recs.find((r) => r.setting === 'pid_roll_i');
      expect(iRec).toBeDefined();
      expect(iRec!.recommendedValue).toBe(DEFAULT_PIDS.roll.I + 5);
      expect(iRec!.confidence).toBe('low');
    });

    it('Rule TF-4: should recommend I +10 for severe DC gain deficit (>3 dB)', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ dcGainDb: -5.0 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      const iRec = recs.find((r) => r.setting === 'pid_roll_i');
      expect(iRec).toBeDefined();
      expect(iRec!.recommendedValue).toBe(DEFAULT_PIDS.roll.I + 10);
      expect(iRec!.confidence).toBe('medium');
    });

    it('Rule TF-4: should not recommend I increase when DC gain is 0 dB', () => {
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ dcGainDb: 0 }),
      };

      const recs = recommendPID(
        emptyProfile(),
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      const iRec = recs.find((r) => r.setting === 'pid_roll_i');
      expect(iRec).toBeUndefined();
    });

    it('Rule TF-4: should not duplicate I rec when step-based I rec already exists', () => {
      // Roll has steady-state error (triggers step-based I rec) + DC gain deficit (triggers TF-4)
      const profile = makeProfile({ meanOvershoot: 5, meanSteadyStateError: 8 });
      const tf: TransferFunctionContext = {
        roll: makeTFMetrics({ dcGainDb: -3.0 }),
      };

      const recs = recommendPID(
        profile,
        emptyProfile(),
        emptyProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        tf
      );

      const iRecs = recs.filter((r) => r.setting === 'pid_roll_i');
      // Only one I rec — step-based takes priority, TF-4 skipped
      expect(iRecs).toHaveLength(1);
    });
  });

  describe('extractFlightPIDs', () => {
    it('should extract PIDs from valid BBL header', () => {
      const headers = new Map<string, string>();
      headers.set('rollPID', '45,80,30');
      headers.set('pitchPID', '47,84,32');
      headers.set('yawPID', '45,80,0');

      const result = extractFlightPIDs(headers);
      expect(result).toBeDefined();
      expect(result!.roll).toEqual({ P: 45, I: 80, D: 30 });
      expect(result!.pitch).toEqual({ P: 47, I: 84, D: 32 });
      expect(result!.yaw).toEqual({ P: 45, I: 80, D: 0 });
    });

    it('should return undefined when PIDs are missing from header', () => {
      const headers = new Map<string, string>();
      headers.set('rollPID', '45,80,30');
      // Missing pitchPID and yawPID

      expect(extractFlightPIDs(headers)).toBeUndefined();
    });

    it('should return undefined for empty header map', () => {
      expect(extractFlightPIDs(new Map())).toBeUndefined();
    });

    it('should handle malformed PID values gracefully', () => {
      const headers = new Map<string, string>();
      headers.set('rollPID', '45,abc,30');
      headers.set('pitchPID', '47,,32');
      headers.set('yawPID', '45,80');

      const result = extractFlightPIDs(headers);
      expect(result).toBeDefined();
      // NaN from "abc" → 0 fallback
      expect(result!.roll).toEqual({ P: 45, I: 0, D: 30 });
      // Empty string → NaN → 0
      expect(result!.pitch).toEqual({ P: 47, I: 0, D: 32 });
      // Missing D → undefined → 0
      expect(result!.yaw).toEqual({ P: 45, I: 80, D: 0 });
    });
  });

  describe('extractFeedforwardContext', () => {
    it('should detect FF active when boost > 0', () => {
      const headers = new Map<string, string>();
      headers.set('feedforward_boost', '15');
      headers.set('feedforward_max_rate_limit', '100');

      const ctx = extractFeedforwardContext(headers);
      expect(ctx.active).toBe(true);
      expect(ctx.boost).toBe(15);
      expect(ctx.maxRateLimit).toBe(100);
    });

    it('should detect FF inactive when boost is 0', () => {
      const headers = new Map<string, string>();
      headers.set('feedforward_boost', '0');

      const ctx = extractFeedforwardContext(headers);
      expect(ctx.active).toBe(false);
      expect(ctx.boost).toBe(0);
    });

    it('should detect FF inactive when headers are missing', () => {
      const ctx = extractFeedforwardContext(new Map());
      expect(ctx.active).toBe(false);
      expect(ctx.boost).toBeUndefined();
      expect(ctx.maxRateLimit).toBeUndefined();
    });

    it('should handle non-numeric header values gracefully', () => {
      const headers = new Map<string, string>();
      headers.set('feedforward_boost', 'abc');

      const ctx = extractFeedforwardContext(headers);
      expect(ctx.active).toBe(false);
      expect(ctx.boost).toBeUndefined();
    });

    it('should extract feedforward_averaging from headers', () => {
      const headers = new Map<string, string>();
      headers.set('feedforward_boost', '15');
      headers.set('feedforward_averaging', '2');

      const ctx = extractFeedforwardContext(headers);
      expect(ctx.averaging).toBe(2);
    });

    it('should extract rc_smoothing_auto_factor from headers', () => {
      const headers = new Map<string, string>();
      headers.set('feedforward_boost', '15');
      headers.set('rc_smoothing_auto_factor', '45');

      const ctx = extractFeedforwardContext(headers);
      expect(ctx.rcSmoothingAutoFactor).toBe(45);
    });

    it('should handle missing averaging and rc_smoothing_auto_factor', () => {
      const headers = new Map<string, string>();
      headers.set('feedforward_boost', '15');

      const ctx = extractFeedforwardContext(headers);
      expect(ctx.averaging).toBeUndefined();
      expect(ctx.rcSmoothingAutoFactor).toBeUndefined();
    });
  });

  describe('generatePIDSummary', () => {
    it('should report no steps detected', () => {
      const summary = generatePIDSummary(emptyProfile(), emptyProfile(), emptyProfile(), []);

      expect(summary).toContain('No step inputs');
    });

    it('should report good tune when no recommendations', () => {
      const good = makeProfile({ meanOvershoot: 5, meanRiseTimeMs: 30 });
      const summary = generatePIDSummary(good, good, emptyProfile(), []);

      expect(summary).toContain('looks good');
    });

    it('should mention overshoot when present in recommendations', () => {
      const profile = makeProfile({ meanOvershoot: 35 });
      const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);
      const summary = generatePIDSummary(profile, emptyProfile(), emptyProfile(), recs);

      expect(summary).toContain('overshoot');
    });

    it('should include step count in summary', () => {
      const profile = makeProfile();
      const summary = generatePIDSummary(profile, profile, emptyProfile(), []);

      expect(summary).toContain('2'); // 2 total steps (1 roll + 1 pitch)
    });

    it('should include style context for smooth', () => {
      const good = makeProfile({ meanOvershoot: 2, meanRiseTimeMs: 30 });
      const summary = generatePIDSummary(good, good, emptyProfile(), [], 'smooth');
      expect(summary).toContain('smooth flying');
    });

    it('should include style context for aggressive', () => {
      const good = makeProfile({ meanOvershoot: 15, meanRiseTimeMs: 20 });
      const summary = generatePIDSummary(good, good, emptyProfile(), [], 'aggressive');
      expect(summary).toContain('racing');
    });

    it('should not include style context for balanced (default)', () => {
      const good = makeProfile({ meanOvershoot: 5, meanRiseTimeMs: 30 });
      const summary = generatePIDSummary(good, good, emptyProfile(), [], 'balanced');
      expect(summary).not.toContain('smooth');
      expect(summary).not.toContain('racing');
    });
  });

  describe('D/P damping ratio validation', () => {
    it('should add D recommendation when D/P ratio is too low (underdamped)', () => {
      // P=60, D=20 → ratio = 0.33 (< 0.45)
      const lowDPids: PIDConfiguration = {
        roll: { P: 60, I: 80, D: 20 },
        pitch: { P: 60, I: 80, D: 20 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const good = makeProfile({ meanOvershoot: 5, meanRiseTimeMs: 30 });

      const recs = recommendPID(good, good, emptyProfile(), lowDPids);

      const rollD = recs.find((r) => r.setting === 'pid_roll_d');
      expect(rollD).toBeDefined();
      expect(rollD!.recommendedValue).toBeGreaterThan(20);
      expect(rollD!.reason).toContain('D/P ratio');
      expect(rollD!.reason).toContain('low');
    });

    it('should reduce D when D/P ratio is too high (overdamped) with no other recommendations', () => {
      // P=35, D=40 → ratio = 1.14 (> 0.85)
      const highDPids: PIDConfiguration = {
        roll: { P: 35, I: 80, D: 40 },
        pitch: { P: 35, I: 80, D: 40 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const good = makeProfile({ meanOvershoot: 5, meanRiseTimeMs: 30 });

      const recs = recommendPID(good, good, emptyProfile(), highDPids);

      const rollD = recs.find((r) => r.setting === 'pid_roll_d');
      expect(rollD).toBeDefined();
      expect(rollD!.recommendedValue).toBeLessThan(40);
      expect(rollD!.reason).toContain('D/P ratio');
      expect(rollD!.reason).toContain('high');
    });

    it('should add compensating P increase when D increase pushes ratio above max', () => {
      // P=30, D=25 → ratio = 0.83 (healthy)
      // After overshoot D+5 → D=30 → ratio = 1.0 (> 0.85)
      // Damping check should add P increase to compensate
      const borderPids: PIDConfiguration = {
        roll: { P: 30, I: 80, D: 25 },
        pitch: { P: 47, I: 84, D: 32 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const overshoot = makeProfile({ meanOvershoot: 20 }); // moderate → D+5

      const recs = recommendPID(overshoot, emptyProfile(), emptyProfile(), borderPids);

      const dRec = recs.find((r) => r.setting === 'pid_roll_d');
      const pRec = recs.find((r) => r.setting === 'pid_roll_p');
      expect(dRec).toBeDefined();
      expect(pRec).toBeDefined();
      expect(pRec!.reason).toContain('D/P balance');
      expect(pRec!.confidence).toBe('low');
    });

    it('should skip damping ratio check for yaw', () => {
      // Yaw D=0 is common and should not trigger damping ratio recommendations
      const yawProfile = makeProfile({ meanOvershoot: 5 });

      const recs = recommendPID(emptyProfile(), emptyProfile(), yawProfile, DEFAULT_PIDS);

      const yawD = recs.find((r) => r.setting === 'pid_yaw_d');
      expect(yawD).toBeUndefined();
    });

    it('should not add damping recommendation when ratio is already healthy', () => {
      // P=45, D=30 → ratio = 0.67 (healthy)
      const good = makeProfile({ meanOvershoot: 5, meanRiseTimeMs: 30 });

      const recs = recommendPID(good, good, emptyProfile(), DEFAULT_PIDS);

      const dampingRecs = recs.filter((r) => r.reason.includes('D/P ratio'));
      expect(dampingRecs.length).toBe(0);
    });

    it('should not override existing D recommendation from overshoot rule', () => {
      // P=45, D=20 → ratio = 0.44 (< 0.45, underdamped)
      // But overshoot rule already recommends D increase
      const lowDPids: PIDConfiguration = {
        roll: { P: 45, I: 80, D: 20 },
        pitch: { P: 47, I: 84, D: 32 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const overshoot = makeProfile({ meanOvershoot: 20 }); // moderate → D+5

      const recs = recommendPID(overshoot, emptyProfile(), emptyProfile(), lowDPids);

      // Should have exactly one D recommendation (from overshoot), not a second from damping
      const rollDRecs = recs.filter((r) => r.setting === 'pid_roll_d');
      expect(rollDRecs.length).toBe(1);
      expect(rollDRecs[0].reason).toContain('overshoot'); // From overshoot rule, not damping
    });

    it('should check both roll and pitch independently', () => {
      // Roll: ratio low, Pitch: ratio healthy
      const mixedPids: PIDConfiguration = {
        roll: { P: 60, I: 80, D: 20 }, // ratio 0.33
        pitch: { P: 45, I: 84, D: 30 }, // ratio 0.67
        yaw: { P: 45, I: 80, D: 0 },
      };
      const good = makeProfile({ meanOvershoot: 5, meanRiseTimeMs: 30 });

      const recs = recommendPID(good, good, emptyProfile(), mixedPids);

      const rollD = recs.find((r) => r.setting === 'pid_roll_d');
      const pitchD = recs.find((r) => r.setting === 'pid_pitch_d');
      expect(rollD).toBeDefined(); // Roll needs damping fix
      expect(pitchD).toBeUndefined(); // Pitch is fine
    });

    it('should drop D when both P-OS-P and P-OS-D fire and clamped D < current D', () => {
      // Extreme overshoot (115%) triggers both P-OS-D (+15) and P-OS-P (-10)
      // P=47 → 37, D=46 → 61 → ratio = 61/37 = 1.65 (far above 0.85)
      // anchorP = max(37, 47) = 47, clampedD = round(47×0.85) = 40. 40 < 46 → D rec removed.
      const pids: PIDConfiguration = {
        roll: { P: 45, I: 80, D: 30 },
        pitch: { P: 47, I: 84, D: 46 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const extreme = makeProfile({ meanOvershoot: 115 });

      const recs = recommendPID(emptyProfile(), extreme, emptyProfile(), pids);

      const pitchP = recs.find((r) => r.setting === 'pid_pitch_p');
      const pitchD = recs.find((r) => r.setting === 'pid_pitch_d');
      expect(pitchP).toBeDefined();
      // D rec is removed because clamped D (40) < current D (46)
      expect(pitchD).toBeUndefined();
    });

    it('resulting D/P ratio should be within healthy bounds after damping correction', () => {
      // P=60, D=20 → ratio = 0.33 → should recommend D increase
      const lowDPids: PIDConfiguration = {
        roll: { P: 60, I: 80, D: 20 },
        pitch: { P: 60, I: 80, D: 20 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const good = makeProfile({ meanOvershoot: 5, meanRiseTimeMs: 30 });

      const recs = recommendPID(good, good, emptyProfile(), lowDPids);

      const rollD = recs.find((r) => r.setting === 'pid_roll_d');
      expect(rollD).toBeDefined();
      const resultRatio = rollD!.recommendedValue / 60;
      expect(resultRatio).toBeGreaterThanOrEqual(DAMPING_RATIO_MIN);
      expect(resultRatio).toBeLessThanOrEqual(DAMPING_RATIO_MAX);
    });
  });

  describe('D-term effectiveness integration', () => {
    const overshooting = makeProfile({
      meanOvershoot: 40,
      responses: [makeResponse({ overshootPercent: 40, ringingCount: 3 })],
    });

    it('should boost D-increase confidence to high when dCritical is true', () => {
      const recs = recommendPID(
        overshooting,
        overshooting,
        makeProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        undefined,
        { roll: 0.8, pitch: 0.8, yaw: 0.1, overall: 0.8, dCritical: true }
      );
      const dIncrease = recs.find(
        (r) => r.setting.includes('_d') && r.recommendedValue > r.currentValue
      );
      if (dIncrease) {
        expect(dIncrease.confidence).toBe('high');
      }
    });

    it('should annotate D decrease from damping ratio when DTE is low', () => {
      // DTE runs both before AND after damping ratio validation.
      // D decreases generated by damping ratio WILL have DTE annotation (second pass).
      const good = makeProfile({
        meanOvershoot: 5,
        responses: [makeResponse({ overshootPercent: 5, ringingCount: 0 })],
      });
      const pids: PIDConfiguration = {
        roll: { P: 40, I: 80, D: 60 }, // High D/P ratio → damping ratio creates D decrease
        pitch: { P: 40, I: 80, D: 60 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const recs = recommendPID(
        good,
        good,
        makeProfile(),
        pids,
        undefined,
        undefined,
        'balanced',
        undefined,
        { roll: 0.1, pitch: 0.1, yaw: 0, overall: 0.1, dCritical: false }
      );
      const dDecrease = recs.find(
        (r) => r.setting.includes('_d') && r.recommendedValue < r.currentValue
      );
      // D decrease exists (from damping ratio) and DTE annotation IS present
      // because DTE second pass runs after damping ratio
      if (dDecrease) {
        expect(dDecrease.reason).toContain('D-term effectiveness is low');
      }
    });

    it('should not modify non-D recommendations', () => {
      const recs = recommendPID(
        overshooting,
        overshooting,
        makeProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        undefined,
        { roll: 0.9, pitch: 0.9, yaw: 0.1, overall: 0.9, dCritical: true }
      );
      const pRecs = recs.filter((r) => r.setting.includes('_p'));
      // P recommendations should not be affected by D-term effectiveness
      for (const rec of pRecs) {
        expect(rec.reason).not.toContain('D-term effectiveness');
      }
    });

    it('should work correctly when dTermEffectiveness is undefined', () => {
      const recs = recommendPID(overshooting, overshooting, makeProfile(), DEFAULT_PIDS);
      // Should produce recommendations without errors
      expect(recs.length).toBeGreaterThan(0);
    });

    it('should remove D increase when D effectiveness is very low (<0.3)', () => {
      // When DTE overall < 0.3, D increases are spliced out entirely
      // (not annotated) to prevent counterproductive noise amplification
      const recs = recommendPID(
        overshooting,
        overshooting,
        makeProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        undefined,
        { roll: 0.1, pitch: 0.1, yaw: 0, overall: 0.1, dCritical: false }
      );
      const dIncrease = recs.find(
        (r) => r.setting.includes('_d') && r.recommendedValue > r.currentValue
      );
      // D increase is removed (spliced) when effectiveness < 0.3
      expect(dIncrease).toBeUndefined();
    });

    it('should not emit D increases from underdamped ratio validation when D effectiveness is very low', () => {
      // D/P ratio is low (underdamped) → damping ratio validator would normally add D increase
      // But with DTE < 0.3, D effectiveness gating (which runs first) should prevent this
      const lowDPids: PIDConfiguration = {
        roll: { P: 60, I: 80, D: 20 }, // ratio 0.33 < 0.45 = underdamped
        pitch: { P: 60, I: 80, D: 20 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const good = makeProfile({ meanOvershoot: 5, meanRiseTimeMs: 30 });

      const recs = recommendPID(
        good,
        good,
        makeProfile(),
        lowDPids,
        undefined,
        undefined,
        'balanced',
        undefined,
        { roll: 0.1, pitch: 0.1, yaw: 0, overall: 0.1, dCritical: false }
      );

      const dIncrease = recs.find(
        (r) => r.setting.includes('_d') && r.recommendedValue > r.currentValue
      );
      expect(dIncrease).toBeUndefined();
    });

    it('should reduce D when P is decreased but D was blocked by effectiveness gating', () => {
      // Pitch: extreme overshoot → P-OS-P fires (P 47→37), D-OS-D blocked by DTE
      // D stays at 46 → D/P = 46/37 = 1.24 > 0.85
      // Damping ratio should catch this and add D decrease
      const pids: PIDConfiguration = {
        roll: { P: 45, I: 80, D: 30 },
        pitch: { P: 47, I: 84, D: 46 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const extreme = makeProfile({ meanOvershoot: 115 });

      const recs = recommendPID(
        emptyProfile(),
        extreme,
        emptyProfile(),
        pids,
        undefined,
        undefined,
        'balanced',
        undefined,
        { roll: 0.07, pitch: 0.07, yaw: 0, overall: 0.07, dCritical: false }
      );

      const pitchP = recs.find((r) => r.setting === 'pid_pitch_p');
      // The blocked D increase is replaced by an informational rec; the damping
      // ratio validator then adds a real (non-informational) D decrease.
      const pitchD = recs.find((r) => r.setting === 'pid_pitch_d' && !r.informational);
      expect(pitchP).toBeDefined();
      expect(pitchP!.recommendedValue).toBe(37); // P reduced by overshoot rule
      expect(pitchD).toBeDefined();
      expect(pitchD!.recommendedValue).toBeLessThanOrEqual(Math.round(37 * DAMPING_RATIO_MAX)); // D reduced to maintain ratio
      // Resulting ratio should be within bounds
      const resultRatio = pitchD!.recommendedValue / pitchP!.recommendedValue;
      expect(resultRatio).toBeLessThanOrEqual(DAMPING_RATIO_MAX);
    });

    it('should replace blocked D increase with informational "improve filters first" rec', () => {
      const recs = recommendPID(
        overshooting,
        overshooting,
        makeProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        undefined,
        { roll: 0.1, pitch: 0.1, yaw: 0, overall: 0.1, dCritical: false }
      );

      const blocked = recs.find((r) => r.ruleId === 'P-DTE-BLOCK-pid_roll_d');
      expect(blocked).toBeDefined();
      expect(blocked!.setting).toBe('pid_roll_d');
      expect(blocked!.recommendedValue).toBe(blocked!.currentValue); // no change
      expect(blocked!.recommendedValue).toBe(DEFAULT_PIDS.roll.D);
      expect(blocked!.confidence).toBe('low');
      expect(blocked!.informational).toBe(true);
      expect(blocked!.reason).toMatch(/filter/i);
    });

    it('should not count the informational P-DTE-BLOCK rec as an actionable D increase', () => {
      const recs = recommendPID(
        overshooting,
        overshooting,
        makeProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        undefined,
        { roll: 0.1, pitch: 0.1, yaw: 0, overall: 0.1, dCritical: false }
      );

      const actionableDIncrease = recs.find(
        (r) => r.setting.includes('_d') && !r.informational && r.recommendedValue > r.currentValue
      );
      expect(actionableDIncrease).toBeUndefined();
    });

    it('should add moderate noise warning when D ratio is in balanced range', () => {
      const recs = recommendPID(
        overshooting,
        overshooting,
        makeProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        undefined,
        { roll: 0.5, pitch: 0.5, yaw: 0.2, overall: 0.5, dCritical: false }
      );
      const dIncrease = recs.find(
        (r) => r.setting.includes('_d') && r.recommendedValue > r.currentValue
      );
      expect(dIncrease).toBeDefined();
      expect(dIncrease!.reason).toContain('monitor motor temperatures');
    });
  });

  describe('Prop wash integration', () => {
    const overshooting = makeProfile({
      meanOvershoot: 40,
      responses: [makeResponse({ overshootPercent: 40, ringingCount: 3 })],
    });

    const goodProfile = makeProfile({
      meanOvershoot: 5,
      responses: [makeResponse({ overshootPercent: 5, ringingCount: 0 })],
    });

    const makeEvent = (severity: number, axis: 'roll' | 'pitch' | 'yaw' = 'roll') => ({
      timestampMs: 1000,
      throttleDropRate: 0.5,
      durationMs: 200,
      peakFrequencyHz: 52,
      severityRatio: severity,
      axisEnergy: {
        roll: axis === 'roll' ? severity * 10 : 1,
        pitch: axis === 'pitch' ? severity * 10 : 1,
        yaw: axis === 'yaw' ? severity * 10 : 1,
      },
    });

    it('should boost D confidence when prop wash is severe on axis with existing D increase', () => {
      const pw = {
        events: [makeEvent(6), makeEvent(7), makeEvent(5.5)],
        meanSeverity: 6.2,
        worstAxis: 'roll' as const,
        dominantFrequencyHz: 52,
        recommendation: 'Severe prop wash',
      };
      const recs = recommendPID(
        overshooting,
        makeProfile(),
        makeProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        undefined,
        undefined,
        pw
      );
      const rollDRec = recs.find(
        (r) => r.setting === 'pid_roll_d' && r.recommendedValue > r.currentValue
      );
      expect(rollDRec).toBeDefined();
      expect(rollDRec!.confidence).toBe('high');
      expect(rollDRec!.reason).toContain('Prop wash is severe');
    });

    it('should suggest D increase when prop wash is severe and no D rec exists', () => {
      const pw = {
        events: [makeEvent(6), makeEvent(7), makeEvent(5.5)],
        meanSeverity: 6.2,
        worstAxis: 'roll' as const,
        dominantFrequencyHz: 52,
        recommendation: 'Severe prop wash',
      };
      // Good profile = no overshoot = no D rec generated by main rules
      const recs = recommendPID(
        goodProfile,
        goodProfile,
        makeProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        undefined,
        undefined,
        pw
      );
      const rollDRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(rollDRec).toBeDefined();
      expect(rollDRec!.recommendedValue).toBeGreaterThan(rollDRec!.currentValue);
      expect(rollDRec!.reason).toContain('Severe prop wash');
      expect(rollDRec!.reason).toContain('52 Hz');
    });

    it('should not add prop wash recommendation when severity is below moderate threshold', () => {
      const pw = {
        events: [makeEvent(1.5), makeEvent(1.8), makeEvent(1.2)],
        meanSeverity: 1.5,
        worstAxis: 'roll' as const,
        dominantFrequencyHz: 45,
        recommendation: 'Minimal prop wash',
      };
      const recs = recommendPID(
        goodProfile,
        goodProfile,
        makeProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        undefined,
        undefined,
        pw
      );
      // No D rec should be generated from prop wash alone (severity < 2.0)
      const rollDRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(rollDRec).toBeUndefined();
    });

    it('should not add prop wash recommendation when fewer than 3 events', () => {
      const pw = {
        events: [makeEvent(6), makeEvent(7)],
        meanSeverity: 6.5,
        worstAxis: 'roll' as const,
        dominantFrequencyHz: 52,
        recommendation: 'Severe prop wash',
      };
      const recs = recommendPID(
        goodProfile,
        goodProfile,
        makeProfile(),
        DEFAULT_PIDS,
        undefined,
        undefined,
        'balanced',
        undefined,
        undefined,
        pw
      );
      const rollDRec = recs.find((r) => r.setting === 'pid_roll_d');
      expect(rollDRec).toBeUndefined();
    });

    it('should work when propWash is undefined', () => {
      const recs = recommendPID(overshooting, overshooting, makeProfile(), DEFAULT_PIDS);
      expect(recs.length).toBeGreaterThan(0);
    });
  });
});

describe('quad-size-aware PID bounds', () => {
  it('should clamp D to 1" dMax=80 (whoop presets run D 57-79)', () => {
    // 1" quad: dMax=80, pMax=90 (raised from 50/80 — whoop_justice/ayyykayyy
    // presets cluster P 63-83 / D 57-79). Moderate overshoot (20%) → D+5.
    // P=82: moderate branch has no P adjustment. D=78+5=83 → clamped to 80.
    // Damping ratio 80/82 = 0.98 ≤ DAMPING_RATIO_MAX_MICRO (1.0) → no correction.
    const profile = makeProfile({
      meanOvershoot: 20,
      meanRiseTimeMs: 30,
      meanSettlingTimeMs: 150,
    });
    const pids: PIDConfiguration = {
      roll: { P: 82, I: 60, D: 78 },
      pitch: { P: 82, I: 60, D: 78 },
      yaw: { P: 40, I: 60, D: 0 },
    };
    const recs = recommendPID(
      profile,
      emptyProfile(),
      emptyProfile(),
      pids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '1"'
    );
    const dRec = recs.find((r) => r.setting === 'pid_roll_d' && !r.informational);
    expect(dRec).toBeDefined();
    // D=78+5=83 → clamped to 80 (1" dMax)
    expect(dRec!.recommendedValue).toBe(80);
  });

  it('should not clamp a moderate 1" D increase that fits the new dMax=80', () => {
    // Old bounds (dMax=50) would have clamped 46+5=51 to 50; new bounds keep 51.
    const profile = makeProfile({
      meanOvershoot: 20,
      meanRiseTimeMs: 30,
      meanSettlingTimeMs: 150,
    });
    const pids: PIDConfiguration = {
      roll: { P: 60, I: 60, D: 46 },
      pitch: { P: 60, I: 60, D: 46 },
      yaw: { P: 40, I: 60, D: 0 },
    };
    const recs = recommendPID(
      profile,
      emptyProfile(),
      emptyProfile(),
      pids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '1"'
    );
    const dRec = recs.find((r) => r.setting === 'pid_roll_d' && !r.informational);
    expect(dRec).toBeDefined();
    expect(dRec!.recommendedValue).toBe(51); // 46+5, within 1" dMax=80
  });

  it('should allow D/P ratio up to 1.0 on micro quads (DAMPING_RATIO_MAX_MICRO)', () => {
    // D/P = 57/60 = 0.95: overdamped by the standard 0.85 ceiling but healthy
    // for whoops (whoop presets run 0.91-0.95). No recs expected on 1".
    const goodProfile = makeProfile({
      meanOvershoot: 5,
      meanRiseTimeMs: 30,
      meanSettlingTimeMs: 150,
    });
    const pids: PIDConfiguration = {
      roll: { P: 60, I: 60, D: 57 },
      pitch: { P: 60, I: 60, D: 57 },
      yaw: { P: 40, I: 60, D: 0 },
    };
    const recs = recommendPID(
      goodProfile,
      goodProfile,
      emptyProfile(),
      pids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '1"'
    );
    const dRec = recs.find((r) => r.setting === 'pid_roll_d');
    expect(dRec).toBeUndefined();
  });

  it('should still flag D/P ratio 0.95 as overdamped on 5" (standard 0.85 max)', () => {
    const goodProfile = makeProfile({
      meanOvershoot: 5,
      meanRiseTimeMs: 30,
      meanSettlingTimeMs: 150,
    });
    const pids: PIDConfiguration = {
      roll: { P: 60, I: 60, D: 57 },
      pitch: { P: 60, I: 60, D: 57 },
      yaw: { P: 40, I: 60, D: 0 },
    };
    const recs = recommendPID(
      goodProfile,
      goodProfile,
      emptyProfile(),
      pids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '5"'
    );
    const dRec = recs.find((r) => r.setting === 'pid_roll_d');
    expect(dRec).toBeDefined();
    expect(dRec!.recommendedValue).toBeLessThan(57); // reduced toward 0.85 ratio
    expect(dRec!.ruleId).toBe('P-DR-OD-roll');
  });

  it('should allow higher D for 7" long range (dMax=100)', () => {
    // 7" quad: dMax=100. Moderate overshoot (20%) > balanced moderateOvershoot(15) → D+5
    // With D=90, D+5=95 which is within 7" bounds (100) but would be capped at 80 on 5"
    const profile = makeProfile({ meanOvershoot: 20, meanRiseTimeMs: 30, meanSettlingTimeMs: 200 });
    const pids: PIDConfiguration = {
      roll: { P: 50, I: 80, D: 90 },
      pitch: { P: 50, I: 80, D: 90 },
      yaw: { P: 50, I: 80, D: 0 },
    };
    const recs = recommendPID(
      profile,
      emptyProfile(),
      emptyProfile(),
      pids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '7"'
    );
    const dRec = recs.find((r) => r.setting === 'pid_roll_d');
    expect(dRec).toBeDefined();
    expect(dRec!.recommendedValue).toBe(95); // 90+5, within 7" dMax=100
  });

  it('should use default 5" bounds when droneSize is undefined', () => {
    // Moderate overshoot (20%) → D+5 from 76 = 81, clamped to 5" dMax=80.
    // P=100, no P decrease (severity < 2 and D=76 < 60% of 80=48? No, 76>48 → P-5=95).
    // anchorP = max(95, 100) = 100, clampedD = round(100×0.85) = 85 > 80(dMax) → stays at 80.
    const profile = makeProfile({
      meanOvershoot: 20,
      meanRiseTimeMs: 30,
      meanSettlingTimeMs: 200,
    });
    const pids: PIDConfiguration = {
      roll: { P: 100, I: 80, D: 76 },
      pitch: { P: 100, I: 80, D: 76 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const recs = recommendPID(profile, emptyProfile(), emptyProfile(), pids);
    const dRec = recs.find((r) => r.setting === 'pid_roll_d');
    expect(dRec).toBeDefined();
    expect(dRec!.recommendedValue).toBeLessThanOrEqual(80); // 5" dMax
  });

  it('should clamp I to minimum 40 (raised from 30)', () => {
    // Low steady-state error + overshoot + slow settling → try to reduce I
    const profile = makeProfile({
      meanOvershoot: 20,
      meanRiseTimeMs: 30,
      meanSettlingTimeMs: 300,
      meanSteadyStateError: 0.5,
    });
    const pids: PIDConfiguration = {
      roll: { P: 45, I: 45, D: 30 },
      pitch: { P: 45, I: 45, D: 30 },
      yaw: { P: 45, I: 45, D: 0 },
    };
    const recs = recommendPID(profile, emptyProfile(), emptyProfile(), pids);
    const iRec = recs.find((r) => r.setting === 'pid_roll_i');
    if (iRec) {
      expect(iRec.recommendedValue).toBeGreaterThanOrEqual(40); // New I_GAIN_MIN
    }
  });
});

describe('severity-scaled sluggish P increase', () => {
  it('should increase P by 10 for very sluggish response (>2x threshold)', () => {
    // balanced: sluggishRise=80ms. Rise time 200ms → severity 2.5 → P+10
    const profile = makeProfile({ meanOvershoot: 3, meanRiseTimeMs: 200, meanSettlingTimeMs: 200 });
    const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);
    const pRec = recs.find((r) => r.setting === 'pid_roll_p');
    expect(pRec).toBeDefined();
    expect(pRec!.recommendedValue).toBe(DEFAULT_PIDS.roll.P + 10);
  });

  it('should increase P by 5 for moderately sluggish response (1-2x threshold)', () => {
    // balanced: sluggishRise=80ms. Rise time 100ms → severity 1.25 → P+5
    const profile = makeProfile({ meanOvershoot: 3, meanRiseTimeMs: 100, meanSettlingTimeMs: 200 });
    const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);
    const pRec = recs.find((r) => r.setting === 'pid_roll_p');
    expect(pRec).toBeDefined();
    expect(pRec!.recommendedValue).toBe(DEFAULT_PIDS.roll.P + 5);
  });
});

describe('P-too-high informational warning', () => {
  it('should warn when P is above typical for quad size (5" pTypical=48)', () => {
    // P=70 on 5" quad (pTypical=48, threshold=48*1.3=62.4) → informational warning
    const goodProfile = makeProfile({
      meanOvershoot: 5,
      meanRiseTimeMs: 30,
      meanSettlingTimeMs: 150,
    });
    const highPPids: PIDConfiguration = {
      roll: { P: 70, I: 80, D: 30 },
      pitch: { P: 70, I: 80, D: 30 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const recs = recommendPID(
      goodProfile,
      goodProfile,
      emptyProfile(),
      highPPids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '5"'
    );
    const pRec = recs.find(
      (r) => r.setting === 'pid_roll_p' && r.reason.includes('higher than typical')
    );
    expect(pRec).toBeDefined();
    expect(pRec!.confidence).toBe('low');
    expect(pRec!.recommendedValue).toBe(70); // informational — same value
  });

  it('should NOT warn when P is within typical range', () => {
    const goodProfile = makeProfile({
      meanOvershoot: 5,
      meanRiseTimeMs: 30,
      meanSettlingTimeMs: 150,
    });
    const normalPPids: PIDConfiguration = {
      roll: { P: 50, I: 80, D: 30 },
      pitch: { P: 50, I: 80, D: 30 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const recs = recommendPID(
      goodProfile,
      goodProfile,
      emptyProfile(),
      normalPPids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '5"'
    );
    const pWarning = recs.find(
      (r) => r.setting === 'pid_roll_p' && r.reason.includes('higher than typical')
    );
    expect(pWarning).toBeUndefined();
  });
});

describe('P-too-low informational warning', () => {
  it('should warn when P is below typical for quad size (1" pTypical=72)', () => {
    // P=25 on 1" quad (pTypical=72, threshold=72*0.7=50.4) → informational warning
    const goodProfile = makeProfile({
      meanOvershoot: 5,
      meanRiseTimeMs: 30,
      meanSettlingTimeMs: 150,
    });
    const lowPPids: PIDConfiguration = {
      roll: { P: 25, I: 60, D: 20 },
      pitch: { P: 25, I: 60, D: 20 },
      yaw: { P: 40, I: 60, D: 0 },
    };
    const recs = recommendPID(
      goodProfile,
      goodProfile,
      emptyProfile(),
      lowPPids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '1"'
    );
    const pRec = recs.find(
      (r) => r.setting === 'pid_roll_p' && r.reason.includes('lower than typical')
    );
    expect(pRec).toBeDefined();
    expect(pRec!.confidence).toBe('low');
    expect(pRec!.informational).toBe(true);
    expect(pRec!.recommendedValue).toBe(25); // same value
  });

  it('should NOT warn when P is within typical range', () => {
    const goodProfile = makeProfile({
      meanOvershoot: 5,
      meanRiseTimeMs: 30,
      meanSettlingTimeMs: 150,
    });
    // P=60 is within 0.7-1.3× of 1" pTypical=72 (50.4-93.6)
    const normalPPids: PIDConfiguration = {
      roll: { P: 60, I: 60, D: 20 },
      pitch: { P: 60, I: 60, D: 20 },
      yaw: { P: 40, I: 60, D: 0 },
    };
    const recs = recommendPID(
      goodProfile,
      goodProfile,
      emptyProfile(),
      normalPPids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '1"'
    );
    const pWarning = recs.find(
      (r) => r.setting === 'pid_roll_p' && r.reason.includes('lower than typical')
    );
    expect(pWarning).toBeUndefined();
  });
});

describe('informational flag', () => {
  it('should mark P-too-high as informational', () => {
    const goodProfile = makeProfile({
      meanOvershoot: 5,
      meanRiseTimeMs: 30,
      meanSettlingTimeMs: 150,
    });
    const highPPids: PIDConfiguration = {
      roll: { P: 70, I: 80, D: 30 },
      pitch: { P: 70, I: 80, D: 30 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const recs = recommendPID(
      goodProfile,
      goodProfile,
      emptyProfile(),
      highPPids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '5"'
    );
    const pRec = recs.find((r) => r.setting === 'pid_roll_p' && r.informational === true);
    expect(pRec).toBeDefined();
    expect(pRec!.recommendedValue).toBe(pRec!.currentValue);
  });
});

describe('FF boost step size', () => {
  it('should reduce feedforward_boost by 3 (not 5)', () => {
    const ffResp = makeResponse({ overshootPercent: 30, ffDominated: true });
    const overshootProfile = makeProfile({
      meanOvershoot: 30,
      responses: [ffResp, ffResp, ffResp],
    });
    const pids: PIDConfiguration = {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 45, I: 80, D: 30 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const ffContext: FeedforwardContext = { active: true, boost: 15 };
    const recs = recommendPID(
      overshootProfile,
      emptyProfile(),
      emptyProfile(),
      pids,
      undefined,
      ffContext
    );
    const ffRec = recs.find((r) => r.setting === 'feedforward_boost');
    expect(ffRec).toBeDefined();
    expect(ffRec!.recommendedValue).toBe(12); // 15 - 3 = 12
  });
});

describe('D-min/D-max advisory', () => {
  it('should annotate D recommendations when D-min is active', () => {
    const overshootProfile = makeProfile({ meanOvershoot: 30 });
    const pids: PIDConfiguration = {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 45, I: 80, D: 30 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const dMin: DMinContext = { active: true, roll: 20, pitch: 20 };
    const recs = recommendPID(
      overshootProfile,
      emptyProfile(),
      emptyProfile(),
      pids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      undefined,
      dMin
    );
    const dRec = recs.find((r) => r.setting === 'pid_roll_d');
    expect(dRec).toBeDefined();
    expect(dRec!.reason).toContain('D-min is active');
    expect(dRec!.reason).toContain('d_min=20');
  });
});

describe('TPA advisory', () => {
  it('should annotate D increase recommendations when TPA is active', () => {
    const overshootProfile = makeProfile({ meanOvershoot: 30 });
    const pids: PIDConfiguration = {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 45, I: 80, D: 30 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const tpa: TPAContext = { active: true, rate: 65, breakpoint: 1350 };
    const recs = recommendPID(
      overshootProfile,
      emptyProfile(),
      emptyProfile(),
      pids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      tpa
    );
    const dRec = recs.find((r) => r.setting === 'pid_roll_d');
    expect(dRec).toBeDefined();
    expect(dRec!.reason).toContain('TPA is active');
    expect(dRec!.reason).toContain('65%');
  });
});

describe('extractDMinContext', () => {
  it('should extract D-min values from headers', () => {
    const headers = new Map([
      ['d_min_roll', '20'],
      ['d_min_pitch', '22'],
      ['d_min_yaw', '0'],
    ]);
    const ctx = extractDMinContext(headers);
    expect(ctx.active).toBe(true);
    expect(ctx.roll).toBe(20);
    expect(ctx.pitch).toBe(22);
  });

  it('should detect inactive D-min', () => {
    const headers = new Map([
      ['d_min_roll', '0'],
      ['d_min_pitch', '0'],
    ]);
    const ctx = extractDMinContext(headers);
    expect(ctx.active).toBe(false);
  });

  it('should parse CSV format from real BBL (d_min:30,34,0)', () => {
    const headers = new Map([
      ['d_min', '30,34,0'],
      ['d_max_gain', '37'],
    ]);
    const ctx = extractDMinContext(headers);
    expect(ctx.active).toBe(true);
    expect(ctx.roll).toBe(30);
    expect(ctx.pitch).toBe(34);
    expect(ctx.yaw).toBe(0);
    expect(ctx.gain).toBe(37);
  });

  it('should prefer CSV format over individual headers', () => {
    const headers = new Map([
      ['d_min', '25,28,0'],
      ['d_min_roll', '99'],
    ]);
    const ctx = extractDMinContext(headers);
    expect(ctx.roll).toBe(25);
  });

  it('should read d_max_gain (BF naming) not d_min_gain', () => {
    const headers = new Map([
      ['d_min', '30,34,0'],
      ['d_max_gain', '35'],
    ]);
    const ctx = extractDMinContext(headers);
    expect(ctx.gain).toBe(35);
  });
});

describe('extractTPAContext', () => {
  it('should extract TPA values from headers', () => {
    const headers = new Map([
      ['tpa_rate', '65'],
      ['tpa_breakpoint', '1350'],
    ]);
    const ctx = extractTPAContext(headers);
    expect(ctx.active).toBe(true);
    expect(ctx.rate).toBe(65);
    expect(ctx.breakpoint).toBe(1350);
  });

  it('should detect inactive TPA', () => {
    const headers = new Map([['tpa_rate', '0']]);
    const ctx = extractTPAContext(headers);
    expect(ctx.active).toBe(false);
  });
});

describe('ruleId assignment', () => {
  it('should assign P-OS-D-{axis} for severe overshoot D increase', () => {
    const profile = makeProfile({ meanOvershoot: 35 });
    const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);
    const dRec = recs.find((r) => r.ruleId === 'P-OS-D-roll');
    expect(dRec).toBeDefined();
    expect(dRec!.setting).toBe('pid_roll_d');
  });

  it('should assign P-OS-P-{axis} for extreme overshoot P decrease', () => {
    // Extreme overshoot (>2x threshold) triggers P reduction
    const profile = makeProfile({ meanOvershoot: 60 });
    const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);
    const pRec = recs.find((r) => r.ruleId === 'P-OS-P-roll');
    expect(pRec).toBeDefined();
    expect(pRec!.recommendedValue).toBeLessThan(DEFAULT_PIDS.roll.P);
  });

  it('should assign P-SLUG-P-{axis} for sluggish response', () => {
    // Use PIDs with healthy D/P ratio to avoid damping ratio recs interfering
    // meanRiseTimeMs must exceed sluggishRise threshold (80ms for balanced)
    const pids: PIDConfiguration = {
      roll: { P: 40, I: 80, D: 25 },
      pitch: { P: 40, I: 80, D: 25 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const profile = makeProfile({
      meanOvershoot: 2,
      meanRiseTimeMs: 120,
      meanSteadyStateError: 0,
    });
    const recs = recommendPID(profile, emptyProfile(), emptyProfile(), pids);
    const slugRec = recs.find((r) => r.ruleId === 'P-SLUG-P-roll');
    expect(slugRec).toBeDefined();
    expect(slugRec!.recommendedValue).toBeGreaterThan(pids.roll.P);
  });

  it('should assign P-RING-D-{axis} for ringing', () => {
    // Ringing without overshoot (so no P-OS-D conflict)
    const profile = makeProfile({
      meanOvershoot: 5,
      responses: [makeResponse({ overshootPercent: 5, ringingCount: 5 })],
    });
    const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);
    const ringRec = recs.find((r) => r.ruleId === 'P-RING-D-roll');
    expect(ringRec).toBeDefined();
  });

  it('should assign P-SSE-I-{axis} for steady-state error', () => {
    const profile = makeProfile({
      meanOvershoot: 5,
      meanSteadyStateError: 8,
    });
    const recs = recommendPID(profile, emptyProfile(), emptyProfile(), DEFAULT_PIDS);
    const iRec = recs.find((r) => r.ruleId === 'P-SSE-I-roll');
    expect(iRec).toBeDefined();
    expect(iRec!.recommendedValue).toBeGreaterThan(DEFAULT_PIDS.roll.I);
  });

  it('should assign P-HI-P-{axis} for high P informational warning', () => {
    const highPPids: PIDConfiguration = {
      roll: { P: 80, I: 80, D: 40 },
      pitch: { P: 80, I: 80, D: 40 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const good = makeProfile({ meanOvershoot: 5, meanRiseTimeMs: 30 });
    const recs = recommendPID(good, good, emptyProfile(), highPPids);
    const hiPRec = recs.find((r) => r.ruleId === 'P-HI-P-roll');
    expect(hiPRec).toBeDefined();
    expect(hiPRec!.informational).toBe(true);
  });

  it('should assign P-LO-P-{axis} for low P informational warning', () => {
    const lowPPids: PIDConfiguration = {
      roll: { P: 25, I: 80, D: 30 },
      pitch: { P: 25, I: 80, D: 30 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const good = makeProfile({ meanOvershoot: 5, meanRiseTimeMs: 30 });
    const recs = recommendPID(good, good, emptyProfile(), lowPPids);
    const loPRec = recs.find((r) => r.ruleId === 'P-LO-P-roll');
    expect(loPRec).toBeDefined();
    expect(loPRec!.informational).toBe(true);
  });

  it('should assign P-DR-UD-{axis} for underdamped D/P ratio', () => {
    const lowDPids: PIDConfiguration = {
      roll: { P: 60, I: 80, D: 20 },
      pitch: { P: 60, I: 80, D: 20 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const good = makeProfile({ meanOvershoot: 5, meanRiseTimeMs: 30 });
    const recs = recommendPID(good, good, emptyProfile(), lowDPids);
    const drRec = recs.find((r) => r.ruleId?.startsWith('P-DR-UD-'));
    expect(drRec).toBeDefined();
  });

  it('should assign P-FF-BOOST for FF-dominated overshoot', () => {
    const ffProfile = makeProfile({
      meanOvershoot: 25,
      responses: [
        makeResponse({ overshootPercent: 25, ffDominated: true }),
        makeResponse({ overshootPercent: 22, ffDominated: true }),
        makeResponse({ overshootPercent: 28, ffDominated: true }),
      ],
    });
    const ffContext: FeedforwardContext = { active: true, boost: 15 };
    const recs = recommendPID(
      ffProfile,
      emptyProfile(),
      emptyProfile(),
      DEFAULT_PIDS,
      undefined,
      ffContext
    );
    const ffRec = recs.find((r) => r.ruleId === 'P-FF-BOOST');
    expect(ffRec).toBeDefined();
    expect(ffRec!.setting).toBe('feedforward_boost');
  });

  it('should assign TF-1-D-{axis} for low phase margin', () => {
    const tfMetrics: TransferFunctionContext = {
      roll: {
        bandwidthHz: 40,
        phaseMarginDeg: 25,
        gainMarginDb: 10,
        overshootPercent: 15,
        settlingTimeMs: 100,
        riseTimeMs: 30,
        dcGainDb: 0,
      },
    };
    const recs = recommendPID(
      emptyProfile(),
      emptyProfile(),
      emptyProfile(),
      DEFAULT_PIDS,
      undefined,
      undefined,
      'balanced',
      tfMetrics
    );
    const tfRec = recs.find((r) => r.ruleId === 'TF-1-D-roll');
    expect(tfRec).toBeDefined();
  });

  it('should assign TF-4-I-{axis} for DC gain deficit', () => {
    const tfMetrics: TransferFunctionContext = {
      roll: {
        bandwidthHz: 40,
        phaseMarginDeg: 60,
        gainMarginDb: 10,
        overshootPercent: 5,
        settlingTimeMs: 80,
        riseTimeMs: 30,
        dcGainDb: -4,
      },
    };
    const recs = recommendPID(
      emptyProfile(),
      emptyProfile(),
      emptyProfile(),
      DEFAULT_PIDS,
      undefined,
      undefined,
      'balanced',
      tfMetrics
    );
    const tfRec = recs.find((r) => r.ruleId === 'TF-4-I-roll');
    expect(tfRec).toBeDefined();
  });

  it('should have ruleId on all generated recommendations', () => {
    const profile = makeProfile({ meanOvershoot: 35, meanSteadyStateError: 8 });
    const recs = recommendPID(profile, profile, emptyProfile(), DEFAULT_PIDS);
    for (const rec of recs) {
      expect(rec.ruleId).toBeDefined();
      expect(rec.ruleId!.length).toBeGreaterThan(0);
    }
  });
});

describe('extractItermRelaxCutoff', () => {
  it('should extract iterm_relax_cutoff from BBL headers', () => {
    const headers = new Map([['iterm_relax_cutoff', '15']]);
    expect(extractItermRelaxCutoff(headers)).toBe(15);
  });

  it('should return undefined when header is missing', () => {
    const headers = new Map<string, string>();
    expect(extractItermRelaxCutoff(headers)).toBeUndefined();
  });

  it('should return undefined for non-numeric values', () => {
    const headers = new Map([['iterm_relax_cutoff', 'abc']]);
    expect(extractItermRelaxCutoff(headers)).toBeUndefined();
  });
});

describe('recommendItermRelaxCutoff', () => {
  it('should return undefined when cutoff is undefined', () => {
    expect(recommendItermRelaxCutoff(undefined, 'balanced')).toBeUndefined();
  });

  it('should return undefined when cutoff is within range for balanced', () => {
    // Balanced typical = 12, 50% deviation = 6. So 12 is in range.
    expect(recommendItermRelaxCutoff(12, 'balanced')).toBeUndefined();
  });

  it('should return undefined when cutoff is just within 50% threshold', () => {
    // Balanced typical = 12, 50% = 6 deviation. cutoff=18 → deviation = 6/12 = 0.5 = threshold
    expect(recommendItermRelaxCutoff(18, 'balanced')).toBeUndefined();
  });

  it('should recommend for balanced style when cutoff is too high', () => {
    // cutoff=30, typical=12, deviation = 18/12 = 1.5 > 0.5
    const rec = recommendItermRelaxCutoff(30, 'balanced');
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('iterm_relax_cutoff');
    expect(rec!.currentValue).toBe(30);
    expect(rec!.recommendedValue).toBe(12);
    expect(rec!.ruleId).toBe('P-IRELAX');
    expect(rec!.confidence).toBe('medium');
    expect(rec!.reason).toContain('freestyle');
  });

  it('should recommend for smooth style when cutoff is too high', () => {
    // cutoff=15, typical=7, deviation = 8/7 > 0.5
    const rec = recommendItermRelaxCutoff(15, 'smooth');
    expect(rec).toBeDefined();
    expect(rec!.recommendedValue).toBe(7);
    expect(rec!.reason).toContain('cinematic');
    expect(rec!.reason).toContain('smoother');
  });

  it('should recommend for aggressive style when cutoff is too low', () => {
    // cutoff=10, typical=30 (BF wiki: 30-40 for racing), deviation = 20/30 = 0.67 > 0.5
    const rec = recommendItermRelaxCutoff(10, 'aggressive');
    expect(rec).toBeDefined();
    expect(rec!.recommendedValue).toBe(30);
    expect(rec!.reason).toContain('racing');
    expect(rec!.reason).toContain('snappiness');
  });

  it('should not recommend for aggressive style when cutoff is already in range', () => {
    // cutoff=25, typical=30, deviation = 5/30 = 0.17 < 0.5
    expect(recommendItermRelaxCutoff(25, 'aggressive')).toBeUndefined();
  });

  it('should recommend typical 30 for aggressive style when cutoff is too high', () => {
    // cutoff=60, typical=30, deviation = 30/30 = 1.0 > 0.5 → recommend the 20-40 band typical
    const rec = recommendItermRelaxCutoff(60, 'aggressive');
    expect(rec).toBeDefined();
    expect(rec!.recommendedValue).toBe(30);
  });

  it('should accept cutoff 40 for aggressive style (top of 20-40 racing band)', () => {
    // cutoff=40, typical=30, deviation = 10/30 = 0.33 < 0.5 → no rec
    expect(recommendItermRelaxCutoff(40, 'aggressive')).toBeUndefined();
  });

  it('should include style-appropriate description in reason', () => {
    const rec = recommendItermRelaxCutoff(30, 'smooth');
    expect(rec).toBeDefined();
    expect(rec!.reason).toContain('cinematic');
    expect(rec!.reason).toContain('5-10');
  });
});

// ---- Task 6: D-Max Gain Awareness ----

describe('D-max gain awareness (P-DMAX-INFO)', () => {
  it('should recommend disabling D-max for 5" quads when D-min is active', () => {
    const overshootProfile = makeProfile({ meanOvershoot: 30 });
    const pids: PIDConfiguration = {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 45, I: 80, D: 30 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const dMin: DMinContext = { active: true, roll: 20, pitch: 20 };
    const recs = recommendPID(
      overshootProfile,
      emptyProfile(),
      emptyProfile(),
      pids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '5"',
      dMin
    );
    const dmaxRec = recs.find((r) => r.ruleId === 'P-DMAX-INFO');
    expect(dmaxRec).toBeDefined();
    expect(dmaxRec!.setting).toBe('simplified_dmax_gain');
    expect(dmaxRec!.recommendedValue).toBe(0);
    expect(dmaxRec!.confidence).toBe('low');
    expect(dmaxRec!.reason).toContain('unpredictability');
    // Advisory only — flipping a simplified-tuning slider must not auto-apply
    expect(dmaxRec!.informational).toBe(true);
  });

  it('should recommend disabling D-max for whoop (1") quads', () => {
    const goodProfile = makeProfile({ meanOvershoot: 5 });
    const pids: PIDConfiguration = {
      roll: { P: 80, I: 90, D: 50 },
      pitch: { P: 80, I: 90, D: 50 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const dMin: DMinContext = { active: true, roll: 30, pitch: 30 };
    const recs = recommendPID(
      goodProfile,
      goodProfile,
      emptyProfile(),
      pids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '1"',
      dMin
    );
    const dmaxRec = recs.find((r) => r.ruleId === 'P-DMAX-INFO');
    expect(dmaxRec).toBeDefined();
    expect(dmaxRec!.recommendedValue).toBe(0);
  });

  it('should emit informational-only for 7" quads (mixed community opinion)', () => {
    const goodProfile = makeProfile({ meanOvershoot: 5 });
    const pids: PIDConfiguration = {
      roll: { P: 40, I: 80, D: 25 },
      pitch: { P: 40, I: 80, D: 25 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const dMin: DMinContext = { active: true, roll: 15, pitch: 15 };
    const recs = recommendPID(
      goodProfile,
      goodProfile,
      emptyProfile(),
      pids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '7"',
      dMin
    );
    const dmaxRec = recs.find((r) => r.ruleId === 'P-DMAX-INFO');
    expect(dmaxRec).toBeDefined();
    expect(dmaxRec!.informational).toBe(true);
    expect(dmaxRec!.recommendedValue).toBe(1); // no change suggested
    expect(dmaxRec!.reason).toContain('larger quads');
  });

  it('should emit informational-only for 6" quads', () => {
    const goodProfile = makeProfile({ meanOvershoot: 5 });
    const pids: PIDConfiguration = {
      roll: { P: 42, I: 80, D: 28 },
      pitch: { P: 42, I: 80, D: 28 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const dMin: DMinContext = { active: true, roll: 18, pitch: 18 };
    const recs = recommendPID(
      goodProfile,
      goodProfile,
      emptyProfile(),
      pids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '6"',
      dMin
    );
    const dmaxRec = recs.find((r) => r.ruleId === 'P-DMAX-INFO');
    expect(dmaxRec).toBeDefined();
    expect(dmaxRec!.informational).toBe(true);
  });

  it('should not emit D-max recommendation when D-min is inactive', () => {
    const goodProfile = makeProfile({ meanOvershoot: 5 });
    const dMin: DMinContext = { active: false, roll: 0, pitch: 0 };
    const recs = recommendPID(
      goodProfile,
      goodProfile,
      emptyProfile(),
      DEFAULT_PIDS,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '5"',
      dMin
    );
    const dmaxRec = recs.find((r) => r.ruleId === 'P-DMAX-INFO');
    expect(dmaxRec).toBeUndefined();
  });

  it('should emit only one D-max recommendation (not per-axis)', () => {
    const overshootProfile = makeProfile({ meanOvershoot: 30 });
    const pids: PIDConfiguration = {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 45, I: 80, D: 30 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const dMin: DMinContext = { active: true, roll: 20, pitch: 20 };
    const recs = recommendPID(
      overshootProfile,
      overshootProfile,
      emptyProfile(),
      pids,
      undefined,
      undefined,
      'balanced',
      undefined,
      undefined,
      undefined,
      '5"',
      dMin
    );
    const dmaxRecs = recs.filter((r) => r.ruleId === 'P-DMAX-INFO');
    expect(dmaxRecs.length).toBe(1);
  });
});

// ---- Task 7: Dynamic Idle Min RPM Advisory ----

describe('extractDynIdleMinRpm', () => {
  it('should extract dyn_idle_min_rpm from headers', () => {
    const headers = new Map([['dyn_idle_min_rpm', '25']]);
    expect(extractDynIdleMinRpm(headers)).toBe(25);
  });

  it('should return undefined when header is missing', () => {
    const headers = new Map<string, string>();
    expect(extractDynIdleMinRpm(headers)).toBeUndefined();
  });
});

describe('extractRpmFilterActive', () => {
  it('should return true when rpm_filter_harmonics > 0', () => {
    const headers = new Map([['rpm_filter_harmonics', '3']]);
    expect(extractRpmFilterActive(headers)).toBe(true);
  });

  it('should return false when rpm_filter_harmonics is 0', () => {
    const headers = new Map([['rpm_filter_harmonics', '0']]);
    expect(extractRpmFilterActive(headers)).toBe(false);
  });

  it('should return false when header is missing', () => {
    const headers = new Map<string, string>();
    expect(extractRpmFilterActive(headers)).toBe(false);
  });
});

describe('recommendDynIdleMinRpm', () => {
  it('should recommend enabling when RPM filter active and dyn_idle is 0', () => {
    const rec = recommendDynIdleMinRpm(0, true, '5"');
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('dyn_idle_min_rpm');
    expect(rec!.recommendedValue).toBe(25); // 5" typical
    expect(rec!.confidence).toBe('low');
    expect(rec!.ruleId).toBe('P-DYN-IDLE');
    expect(rec!.reason).toContain('RPM filter');
  });

  it('should recommend higher min RPM for small quads (1")', () => {
    const rec = recommendDynIdleMinRpm(0, true, '1"');
    expect(rec).toBeDefined();
    expect(rec!.recommendedValue).toBe(50); // 1" typical
  });

  it('should recommend lower min RPM for large quads (7")', () => {
    const rec = recommendDynIdleMinRpm(0, true, '7"');
    expect(rec).toBeDefined();
    expect(rec!.recommendedValue).toBe(20); // 7" typical
  });

  it('should use 5" default when drone size is unknown', () => {
    const rec = recommendDynIdleMinRpm(0, true);
    expect(rec).toBeDefined();
    expect(rec!.recommendedValue).toBe(25); // 5" typical
    expect(rec!.reason).toContain('5"');
  });

  it('should not recommend when dyn_idle is already enabled', () => {
    expect(recommendDynIdleMinRpm(25, true, '5"')).toBeUndefined();
  });

  it('should not recommend when RPM filter is inactive', () => {
    expect(recommendDynIdleMinRpm(0, false, '5"')).toBeUndefined();
  });

  it('should not recommend when current value is undefined', () => {
    expect(recommendDynIdleMinRpm(undefined, true, '5"')).toBeUndefined();
  });

  it('should include size range in reason text', () => {
    const rec = recommendDynIdleMinRpm(0, true, '3"');
    expect(rec).toBeDefined();
    expect(rec!.reason).toContain('40-60'); // 3" range
    expect(rec!.recommendedValue).toBe(45); // 3" typical
  });
});

describe('extractPidsumLimits', () => {
  it('should extract pidsum_limit and pidsum_limit_yaw from headers', () => {
    const headers = new Map<string, string>();
    headers.set('pidsum_limit', '500');
    headers.set('pidsum_limit_yaw', '400');

    const result = extractPidsumLimits(headers);
    expect(result.pidsumLimit).toBe(500);
    expect(result.pidsumLimitYaw).toBe(400);
  });

  it('should return undefined for missing headers', () => {
    const headers = new Map<string, string>();
    const result = extractPidsumLimits(headers);
    expect(result.pidsumLimit).toBeUndefined();
    expect(result.pidsumLimitYaw).toBeUndefined();
  });

  it('should handle partial headers', () => {
    const headers = new Map<string, string>();
    headers.set('pidsum_limit', '1000');

    const result = extractPidsumLimits(headers);
    expect(result.pidsumLimit).toBe(1000);
    expect(result.pidsumLimitYaw).toBeUndefined();
  });
});

describe('recommendPidsumLimits', () => {
  it('should recommend both limits for heavy quads at defaults', () => {
    const recs = recommendPidsumLimits(500, 400, 900);
    expect(recs).toHaveLength(2);

    const limitRec = recs.find((r) => r.setting === 'pidsum_limit');
    expect(limitRec).toBeDefined();
    expect(limitRec!.currentValue).toBe(500);
    expect(limitRec!.recommendedValue).toBe(1000);
    expect(limitRec!.confidence).toBe('low');
    expect(limitRec!.informational).toBe(true); // advisory only — never auto-applied
    expect(limitRec!.ruleId).toBe('P-PIDLIM');

    const yawRec = recs.find((r) => r.setting === 'pidsum_limit_yaw');
    expect(yawRec).toBeDefined();
    expect(yawRec!.currentValue).toBe(400);
    expect(yawRec!.recommendedValue).toBe(1000);
    expect(yawRec!.informational).toBe(true);
  });

  it('should mark both pidsum recs informational with thrust-headroom caveat in reason', () => {
    const recs = recommendPidsumLimits(500, 400, 900);
    expect(recs.every((r) => r.informational === true)).toBe(true);
    expect(recs[0].reason).toContain('Apply manually');
    expect(recs[0].reason).toContain('thrust headroom');
    expect(recs[1].reason).toContain('thrust headroom');
  });

  it('should not recommend for light quads (<= 800g)', () => {
    const recs = recommendPidsumLimits(500, 400, 650);
    expect(recs).toHaveLength(0);
  });

  it('should not recommend when weight is exactly 800g (boundary)', () => {
    const recs = recommendPidsumLimits(500, 400, 800);
    expect(recs).toHaveLength(0);
  });

  it('should not recommend when limits are already changed from defaults', () => {
    const recs = recommendPidsumLimits(1000, 1000, 900);
    expect(recs).toHaveLength(0);
  });

  it('should not recommend when weight is undefined', () => {
    const recs = recommendPidsumLimits(500, 400, undefined);
    expect(recs).toHaveLength(0);
  });

  it('should only recommend pidsum_limit when yaw is already changed', () => {
    const recs = recommendPidsumLimits(500, 1000, 900);
    expect(recs).toHaveLength(1);
    expect(recs[0].setting).toBe('pidsum_limit');
  });

  it('should only recommend pidsum_limit_yaw when limit is already changed', () => {
    const recs = recommendPidsumLimits(1000, 400, 900);
    expect(recs).toHaveLength(1);
    expect(recs[0].setting).toBe('pidsum_limit_yaw');
  });

  it('should handle undefined header values gracefully', () => {
    const recs = recommendPidsumLimits(undefined, undefined, 900);
    expect(recs).toHaveLength(0);
  });

  it('should include weight in reason text', () => {
    const recs = recommendPidsumLimits(500, 400, 1200);
    expect(recs[0].reason).toContain('1200g');
  });
});

describe('recommendFFMaxRateLimit', () => {
  it('should recommend 100 for aggressive style at default 90', () => {
    const rec = recommendFFMaxRateLimit(90, 'aggressive');
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('feedforward_max_rate_limit');
    expect(rec!.currentValue).toBe(90);
    expect(rec!.recommendedValue).toBe(100);
    expect(rec!.confidence).toBe('low');
    expect(rec!.informational).toBeUndefined();
    expect(rec!.ruleId).toBe('P-FF-RATELIM');
    expect(rec!.reason).toContain('aggressive');
    expect(rec!.reason).toContain('Karate');
  });

  it('should not recommend for balanced style', () => {
    expect(recommendFFMaxRateLimit(90, 'balanced')).toBeUndefined();
  });

  it('should not recommend for smooth style', () => {
    expect(recommendFFMaxRateLimit(90, 'smooth')).toBeUndefined();
  });

  it('should not recommend when already changed from default', () => {
    expect(recommendFFMaxRateLimit(95, 'aggressive')).toBeUndefined();
    expect(recommendFFMaxRateLimit(100, 'aggressive')).toBeUndefined();
  });

  it('should not recommend when value is undefined', () => {
    expect(recommendFFMaxRateLimit(undefined, 'aggressive')).toBeUndefined();
  });
});

describe('extractAntiGravityGain', () => {
  it('should extract anti_gravity_gain from BBL headers', () => {
    const headers = new Map([['anti_gravity_gain', '80']]);
    expect(extractAntiGravityGain(headers)).toBe(80);
  });
  it('should return undefined when header is missing', () => {
    expect(extractAntiGravityGain(new Map())).toBeUndefined();
  });
  it('should return undefined for non-numeric values', () => {
    expect(extractAntiGravityGain(new Map([['anti_gravity_gain', 'abc']]))).toBeUndefined();
  });
});

describe('recommendAntiGravityGain', () => {
  it('should return undefined when gain is undefined', () => {
    expect(recommendAntiGravityGain(undefined, 750, { roll: 5, pitch: 5 })).toBeUndefined();
  });
  it('should return undefined when weight is undefined', () => {
    expect(recommendAntiGravityGain(80, undefined, { roll: 5, pitch: 5 })).toBeUndefined();
  });
  it('should return undefined for lightweight builds (<=700g)', () => {
    expect(recommendAntiGravityGain(80, 350, { roll: 5, pitch: 5 })).toBeUndefined();
  });
  it('should not recommend for a typical 5" build (650g — presets keep gain 80)', () => {
    // Threshold raised 400 → 700 g: 110/120 gains are for 7-9" heavy builds only
    expect(recommendAntiGravityGain(80, 650, { roll: 4.0, pitch: 4.0 })).toBeUndefined();
  });
  it('should return undefined when gain is already >= threshold', () => {
    expect(recommendAntiGravityGain(100, 750, { roll: 5, pitch: 5 })).toBeUndefined();
  });
  it('should recommend 120 for heavy build with high SSE on both axes', () => {
    const rec = recommendAntiGravityGain(80, 750, { roll: 4.0, pitch: 4.0 });
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('anti_gravity_gain');
    expect(rec!.recommendedValue).toBe(120);
    expect(rec!.ruleId).toBe('P-AG');
    expect(rec!.confidence).toBe('medium');
  });
  it('should recommend 110 for heavy build without high SSE on both axes', () => {
    const rec = recommendAntiGravityGain(80, 750, { roll: 4.0, pitch: 1.0 });
    expect(rec!.recommendedValue).toBe(110);
  });
  it('should not recommend at weight boundary (exactly 700g)', () => {
    expect(recommendAntiGravityGain(80, 700, { roll: 5, pitch: 5 })).toBeUndefined();
  });
});

describe('extractThrustLinear', () => {
  it('should extract thrust_linear from BBL headers', () => {
    expect(extractThrustLinear(new Map([['thrust_linear', '30']]))).toBe(30);
  });
  it('should return undefined when header is missing', () => {
    expect(extractThrustLinear(new Map())).toBeUndefined();
  });
});

describe('recommendThrustLinear', () => {
  it('should return undefined when value is undefined', () => {
    expect(recommendThrustLinear(undefined, '5"')).toBeUndefined();
  });
  it('should return undefined for unsupported sizes', () => {
    expect(recommendThrustLinear(0, '1"')).toBeUndefined();
  });
  it('should recommend enabling when disabled for 5" build', () => {
    const rec = recommendThrustLinear(0, '5"');
    expect(rec!.setting).toBe('thrust_linear');
    expect(rec!.recommendedValue).toBe(30);
    expect(rec!.ruleId).toBe('P-THRUST-LIN');
  });
  it('should return undefined when within 50% of recommended', () => {
    expect(recommendThrustLinear(20, '5"')).toBeUndefined();
  });
  it('should recommend when value is too high for size', () => {
    const rec = recommendThrustLinear(60, '5"');
    expect(rec!.recommendedValue).toBe(30);
    expect(rec!.reason).toContain('high');
  });
  it('should return undefined at exact recommended value', () => {
    expect(recommendThrustLinear(30, '5"')).toBeUndefined();
  });
});

// ---- Task 8: TPA Tuning Advisory ----

describe('extractTPAContext (extended fields)', () => {
  it('should extract tpa_mode from BBL headers', () => {
    const headers = new Map([
      ['tpa_rate', '65'],
      ['tpa_breakpoint', '1350'],
      ['tpa_mode', '1'],
    ]);
    const ctx = extractTPAContext(headers);
    expect(ctx.mode).toBe(1);
    expect(ctx.rate).toBe(65);
    expect(ctx.breakpoint).toBe(1350);
  });

  it('should extract BF 4.5+ low-throttle TPA fields', () => {
    const headers = new Map([
      ['tpa_rate', '50'],
      ['tpa_breakpoint', '1250'],
      ['tpa_mode', '0'],
      ['tpa_low_rate', '20'],
      ['tpa_low_breakpoint', '1050'],
      ['tpa_low_always', '0'],
    ]);
    const ctx = extractTPAContext(headers);
    expect(ctx.lowRate).toBe(20);
    expect(ctx.lowBreakpoint).toBe(1050);
    expect(ctx.lowAlways).toBe(0);
  });

  it('should leave low-throttle fields undefined when headers missing', () => {
    const headers = new Map([
      ['tpa_rate', '65'],
      ['tpa_breakpoint', '1350'],
    ]);
    const ctx = extractTPAContext(headers);
    expect(ctx.lowRate).toBeUndefined();
    expect(ctx.lowAlways).toBeUndefined();
    expect(ctx.mode).toBeUndefined();
  });
});

describe('recommendTPA', () => {
  it('should return empty array when tpaContext is undefined', () => {
    expect(recommendTPA(undefined, '5"')).toEqual([]);
  });

  it('should not recommend when TPA rate is within range for 5" build', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '5"');
    const rateRec = recs.find((r) => r.setting === 'tpa_rate');
    expect(rateRec).toBeUndefined();
  });

  it('should recommend TPA rate adjustment for 5" build when rate is too low', () => {
    const ctx: TPAContext = { active: true, rate: 30, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '5"');
    const rateRec = recs.find((r) => r.setting === 'tpa_rate');
    expect(rateRec).toBeDefined();
    expect(rateRec!.recommendedValue).toBe(65);
    expect(rateRec!.ruleId).toBe('P-TPA');
    expect(rateRec!.confidence).toBe('low');
    expect(rateRec!.informational).toBeUndefined();
  });

  it('should recommend TPA rate for 7" build (large category)', () => {
    const ctx: TPAContext = { active: true, rate: 40, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '7"');
    const rateRec = recs.find((r) => r.setting === 'tpa_rate');
    expect(rateRec).toBeDefined();
    expect(rateRec!.recommendedValue).toBe(80);
    expect(rateRec!.reason).toContain('6-7"');
  });

  it('should recommend TPA rate for 3" build (small category)', () => {
    const ctx: TPAContext = { active: true, rate: 90, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '3"');
    const rateRec = recs.find((r) => r.setting === 'tpa_rate');
    expect(rateRec).toBeDefined();
    expect(rateRec!.recommendedValue).toBe(50);
    expect(rateRec!.reason).toContain('1-4"');
    expect(rateRec!.reason).toContain('high');
  });

  it('should recommend TPA breakpoint when significantly off-target', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1800, mode: 0 };
    const recs = recommendTPA(ctx, '5"');
    const bpRec = recs.find((r) => r.setting === 'tpa_breakpoint');
    expect(bpRec).toBeDefined();
    expect(bpRec!.recommendedValue).toBe(1350);
    expect(bpRec!.reason).toContain('lower breakpoint');
  });

  it('should recommend breakpoint 1250 for small builds (whoop/tiny presets)', () => {
    // TPA_BY_SIZE.small.breakpoint = 1250 (lowered from 1500 — whoop_justice,
    // whoop_ayyykayyy, tiny_karate presets all use ~1250)
    const ctx: TPAContext = { active: true, rate: 50, breakpoint: 1800, mode: 0 };
    const recs = recommendTPA(ctx, '3"');
    const bpRec = recs.find((r) => r.setting === 'tpa_breakpoint');
    expect(bpRec).toBeDefined();
    expect(bpRec!.recommendedValue).toBe(1250);
  });

  it('should not recommend TPA breakpoint when within range', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '5"');
    const bpRec = recs.find((r) => r.setting === 'tpa_breakpoint');
    expect(bpRec).toBeUndefined();
  });

  it('should recommend PD mode when throttle noise is severe and mode is D-only on 5"', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '5"', 12);
    const modeRec = recs.find((r) => r.setting === 'tpa_mode');
    expect(modeRec).toBeDefined();
    expect(modeRec!.currentValue).toBe(0);
    expect(modeRec!.recommendedValue).toBe(1);
    expect(modeRec!.reason).toContain('PD');
    expect(modeRec!.reason).toContain('SupaflyFPV');
  });

  it('should not recommend PD mode when noise is below threshold', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '5"', 5);
    const modeRec = recs.find((r) => r.setting === 'tpa_mode');
    expect(modeRec).toBeUndefined();
  });

  it('should not recommend PD mode when already in PD mode', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 1 };
    const recs = recommendTPA(ctx, '5"', 15);
    const modeRec = recs.find((r) => r.setting === 'tpa_mode');
    expect(modeRec).toBeUndefined();
  });

  it('should not recommend PD mode for 7" build even with severe noise', () => {
    const ctx: TPAContext = { active: true, rate: 80, breakpoint: 1250, mode: 0 };
    const recs = recommendTPA(ctx, '7"', 15);
    const modeRec = recs.find((r) => r.setting === 'tpa_mode');
    expect(modeRec).toBeUndefined();
  });

  it('should recommend tpa_low_always when available and disabled', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 0, lowAlways: 0 };
    const recs = recommendTPA(ctx, '5"');
    const lowRec = recs.find((r) => r.setting === 'tpa_low_always');
    expect(lowRec).toBeDefined();
    expect(lowRec!.recommendedValue).toBe(1);
    expect(lowRec!.reason).toContain('BF 4.5+');
  });

  it('should not recommend tpa_low_always when already enabled', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 0, lowAlways: 1 };
    const recs = recommendTPA(ctx, '5"');
    const lowRec = recs.find((r) => r.setting === 'tpa_low_always');
    expect(lowRec).toBeUndefined();
  });

  it('should not recommend tpa_low_always when field is not present (pre-4.5)', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '5"');
    const lowRec = recs.find((r) => r.setting === 'tpa_low_always');
    expect(lowRec).toBeUndefined();
  });

  it('should use standard 5" defaults when droneSize is undefined', () => {
    const ctx: TPAContext = { active: true, rate: 30, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, undefined);
    const rateRec = recs.find((r) => r.setting === 'tpa_rate');
    expect(rateRec).toBeDefined();
    expect(rateRec!.recommendedValue).toBe(65);
  });

  it('should generate multiple recommendations when multiple settings are off', () => {
    const ctx: TPAContext = { active: true, rate: 30, breakpoint: 1800, mode: 0, lowAlways: 0 };
    // 5" triggers all 4: rate + breakpoint + mode (PD) + lowAlways
    const recs = recommendTPA(ctx, '5"', 15);
    expect(recs.length).toBe(4);
    expect(recs.every((r) => r.ruleId === 'P-TPA')).toBe(true);
    expect(recs.every((r) => r.confidence === 'low')).toBe(true);
  });
});

// ---- Propwash-Aware Tuning (Tasks 3-5) ----

function makePropWash(overrides: Partial<PropWashAnalysis> = {}): PropWashAnalysis {
  return {
    events: [
      {
        timestampMs: 1000,
        throttleDropRate: -500,
        durationMs: 200,
        peakFrequencyHz: 45,
        severityRatio: 6.0,
        axisEnergy: { roll: 100, pitch: 80, yaw: 20 },
      },
      {
        timestampMs: 3000,
        throttleDropRate: -400,
        durationMs: 180,
        peakFrequencyHz: 50,
        severityRatio: 5.5,
        axisEnergy: { roll: 90, pitch: 70, yaw: 15 },
      },
      {
        timestampMs: 5000,
        throttleDropRate: -450,
        durationMs: 220,
        peakFrequencyHz: 48,
        severityRatio: 6.2,
        axisEnergy: { roll: 95, pitch: 75, yaw: 18 },
      },
    ],
    meanSeverity: 5.9,
    worstAxis: 'roll',
    dominantFrequencyHz: 48,
    recommendation: 'Severe prop wash detected',
    ...overrides,
  };
}

describe('recommendPropWashDMin (Task 3)', () => {
  const severePropWash = makePropWash({ meanSeverity: 6.0 });
  const mildPropWash = makePropWash({ meanSeverity: 3.0 });

  it('PW-DMIN-GAIN: should recommend increasing gain when propwash severe + d_min active + low gain', () => {
    const dMin: DMinContext = { active: true, roll: 20, pitch: 22, gain: 15 };
    const flightPIDs: PIDConfiguration = {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 47, I: 84, D: 32 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const recs = recommendPropWashDMin(severePropWash, dMin, flightPIDs, '5"');
    const gainRec = recs.find((r) => r.ruleId === 'PW-DMIN-GAIN');
    expect(gainRec).toBeDefined();
    expect(gainRec!.setting).toBe('d_min_gain');
    expect(gainRec!.currentValue).toBe(15);
    expect(gainRec!.recommendedValue).toBe(25); // DMIN_BY_SIZE['5"'].gainByStyle.balanced
    expect(gainRec!.confidence).toBe('medium');
    expect(gainRec!.reason).toContain('prop wash');
  });

  it('PW-DMIN-GAIN: should use style-aware gain for smooth style (lower target)', () => {
    const dMin: DMinContext = { active: true, roll: 20, pitch: 22, gain: 15 };
    const flightPIDs: PIDConfiguration = {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 47, I: 84, D: 32 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const recs = recommendPropWashDMin(severePropWash, dMin, flightPIDs, '5"', 'smooth');
    const gainRec = recs.find((r) => r.ruleId === 'PW-DMIN-GAIN');
    expect(gainRec).toBeDefined();
    expect(gainRec!.recommendedValue).toBe(20); // DMIN_BY_SIZE['5"'].gainByStyle.smooth
  });

  it('PW-DMIN-GAIN: should use style-aware gain for aggressive style (higher target)', () => {
    const dMin: DMinContext = { active: true, roll: 20, pitch: 22, gain: 15 };
    const flightPIDs: PIDConfiguration = {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 47, I: 84, D: 32 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const recs = recommendPropWashDMin(severePropWash, dMin, flightPIDs, '5"', 'aggressive');
    const gainRec = recs.find((r) => r.ruleId === 'PW-DMIN-GAIN');
    expect(gainRec).toBeDefined();
    expect(gainRec!.recommendedValue).toBe(30); // DMIN_BY_SIZE['5"'].gainByStyle.aggressive
  });

  it('PW-DMIN-GAIN: should fall back to size default gain when style has no entry', () => {
    const dMin: DMinContext = { active: true, roll: 20, pitch: 22, gain: 15 };
    const flightPIDs: PIDConfiguration = {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 47, I: 84, D: 32 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    // 7" has no gainByStyle → falls back to gain: 20
    const recs = recommendPropWashDMin(severePropWash, dMin, flightPIDs, '7"', 'balanced');
    const gainRec = recs.find((r) => r.ruleId === 'PW-DMIN-GAIN');
    expect(gainRec).toBeDefined();
    expect(gainRec!.recommendedValue).toBe(20); // DMIN_BY_SIZE['7"'].gain
  });

  it('PW-DMIN-GAIN: should not fire when gain is already at freestyle level', () => {
    const dMin: DMinContext = { active: true, roll: 20, pitch: 22, gain: 40 };
    const recs = recommendPropWashDMin(severePropWash, dMin, DEFAULT_PIDS);
    const gainRec = recs.find((r) => r.ruleId === 'PW-DMIN-GAIN');
    expect(gainRec).toBeUndefined();
  });

  it('PW-DMIN-GAIN: should not fire when propwash is mild', () => {
    const dMin: DMinContext = { active: true, roll: 20, pitch: 22, gain: 15 };
    const recs = recommendPropWashDMin(mildPropWash, dMin, DEFAULT_PIDS);
    const gainRec = recs.find((r) => r.ruleId === 'PW-DMIN-GAIN');
    expect(gainRec).toBeUndefined();
  });

  it('PW-DMIN-GAP: should recommend wider gap when d_min too close to d_max', () => {
    // d_min_roll=28, d_max=30 → gap = 2/30 = 0.067 < 0.2
    const dMin: DMinContext = { active: true, roll: 28, pitch: 30 };
    const flightPIDs: PIDConfiguration = {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 47, I: 84, D: 32 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const recs = recommendPropWashDMin(undefined, dMin, flightPIDs);
    const gapRecs = recs.filter((r) => r.ruleId === 'PW-DMIN-GAP');
    expect(gapRecs.length).toBeGreaterThanOrEqual(1);
    // Roll: d_max=30, target = round(30*0.7) = 21
    const rollGap = gapRecs.find((r) => r.setting === 'd_min_roll');
    expect(rollGap).toBeDefined();
    expect(rollGap!.currentValue).toBe(28);
    expect(rollGap!.recommendedValue).toBe(21);
    expect(rollGap!.confidence).toBe('low');
    expect(rollGap!.reason).toContain('headroom');
  });

  it('PW-DMIN-GAP: should not fire when gap is sufficient', () => {
    // d_min_roll=20, d_max=30 → gap = 10/30 = 0.33 > 0.2
    const dMin: DMinContext = { active: true, roll: 20, pitch: 22 };
    const flightPIDs: PIDConfiguration = {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 47, I: 84, D: 32 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const recs = recommendPropWashDMin(undefined, dMin, flightPIDs);
    const gapRecs = recs.filter((r) => r.ruleId === 'PW-DMIN-GAP');
    expect(gapRecs.length).toBe(0);
  });

  it('PW-DMIN-ENABLE: should recommend enabling d_min when propwash severe + d_min disabled', () => {
    const dMin: DMinContext = { active: false, roll: 0, pitch: 0 };
    const flightPIDs: PIDConfiguration = {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 47, I: 84, D: 32 },
      yaw: { P: 45, I: 80, D: 0 },
    };
    const recs = recommendPropWashDMin(severePropWash, dMin, flightPIDs);
    const enableRecs = recs.filter((r) => r.ruleId === 'PW-DMIN-ENABLE');
    expect(enableRecs.length).toBe(2); // roll + pitch
    const rollEnable = enableRecs.find((r) => r.setting === 'd_min_roll');
    expect(rollEnable).toBeDefined();
    expect(rollEnable!.currentValue).toBe(0);
    expect(rollEnable!.recommendedValue).toBe(21); // round(30*0.7)
    expect(rollEnable!.confidence).toBe('low');
    expect(rollEnable!.reason).toContain('d_min is disabled');
  });

  it('PW-DMIN-ENABLE: should not fire when propwash is mild', () => {
    const dMin: DMinContext = { active: false, roll: 0, pitch: 0 };
    const recs = recommendPropWashDMin(mildPropWash, dMin, DEFAULT_PIDS);
    const enableRecs = recs.filter((r) => r.ruleId === 'PW-DMIN-ENABLE');
    expect(enableRecs.length).toBe(0);
  });

  it('should return empty array when propWash and dMinContext are undefined', () => {
    expect(recommendPropWashDMin(undefined, undefined, DEFAULT_PIDS)).toEqual([]);
  });
});

describe('recommendItermRelaxCutoff propwash-aware (Task 4)', () => {
  const severePropWash = makePropWash({ meanSeverity: 6.0 });
  const mildPropWash = makePropWash({ meanSeverity: 3.0 });

  it('PW-IRELAX-CUTOFF: should recommend lower cutoff when propwash severe + cutoff too high', () => {
    // currentCutoff=25, severe propwash → target = max(15, 25-5) = 20
    const rec = recommendItermRelaxCutoff(25, 'balanced', severePropWash);
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('iterm_relax_cutoff');
    expect(rec!.currentValue).toBe(25);
    expect(rec!.recommendedValue).toBe(20);
    expect(rec!.ruleId).toBe('PW-IRELAX-CUTOFF');
    expect(rec!.confidence).toBe('medium');
    expect(rec!.reason).toContain('prop wash');
  });

  it('PW-IRELAX-CUTOFF: should lower to floor 7 for severe propwash', () => {
    // currentCutoff=18, severe propwash → target = max(7, 18-5) = 13
    const rec = recommendItermRelaxCutoff(18, 'balanced', severePropWash);
    expect(rec).toBeDefined();
    expect(rec!.recommendedValue).toBe(13);
    expect(rec!.ruleId).toBe('PW-IRELAX-CUTOFF');
  });

  it('PW-IRELAX-CUTOFF: should lower from 15 to 10 for severe propwash', () => {
    // cutoff=15 (BF default), severe propwash → target = max(7, 15-5) = 10
    const rec = recommendItermRelaxCutoff(15, 'balanced', severePropWash);
    expect(rec).toBeDefined();
    expect(rec!.ruleId).toBe('PW-IRELAX-CUTOFF');
    expect(rec!.recommendedValue).toBe(10);
  });

  it('PW-IRELAX-CUTOFF: should use lower floor (7) for very severe propwash', () => {
    // severity=8.0 >= 5.0 * 1.5 = 7.5 → floor=7
    const verySeverePropWash = makePropWash({ meanSeverity: 8.0 });
    const rec = recommendItermRelaxCutoff(15, 'balanced', verySeverePropWash);
    expect(rec).toBeDefined();
    expect(rec!.ruleId).toBe('PW-IRELAX-CUTOFF');
    expect(rec!.recommendedValue).toBe(10); // max(7, 15-5) = 10
  });

  it('PW-IRELAX-CUTOFF: should not go below severe floor (7) even with very severe propwash', () => {
    const verySeverePropWash = makePropWash({ meanSeverity: 10.0 });
    const rec = recommendItermRelaxCutoff(12, 'balanced', verySeverePropWash);
    expect(rec).toBeDefined();
    expect(rec!.recommendedValue).toBe(7); // max(7, 12-5) = 7
  });

  it('PW-IRELAX-CUTOFF-MOD: should fire for moderate propwash when cutoff > floor 15', () => {
    // Moderate propwash (3.0×, range 2-5×) + cutoff 25 > floor 15 → moderate rule fires
    const rec = recommendItermRelaxCutoff(25, 'balanced', mildPropWash);
    expect(rec).toBeDefined();
    expect(rec!.ruleId).toBe('PW-IRELAX-CUTOFF-MOD');
    expect(rec!.recommendedValue).toBe(20); // max(15, 25-5) = 20
    expect(rec!.confidence).toBe('low');
  });

  it('PW-IRELAX-CUTOFF-MOD: should not go below moderate floor (15)', () => {
    const rec = recommendItermRelaxCutoff(17, 'balanced', mildPropWash);
    expect(rec).toBeDefined();
    expect(rec!.ruleId).toBe('PW-IRELAX-CUTOFF-MOD');
    expect(rec!.recommendedValue).toBe(15); // max(15, 17-5) = 15
  });

  it('PW-IRELAX-CUTOFF-MOD: should not fire when cutoff already at floor 15', () => {
    const rec = recommendItermRelaxCutoff(15, 'balanced', mildPropWash);
    // cutoff 15 is not > floor 15, so moderate rule doesn't fire
    // Falls through to style check: 15 vs typical 12, deviation = 3/12 = 0.25 < 0.5 → no rec
    expect(rec).toBeUndefined();
  });

  it('PW-IRELAX-CUTOFF-MOD: should not fire when propwash is minimal (< 2×)', () => {
    const minimalPropWash = makePropWash({ meanSeverity: 1.5 });
    const rec = recommendItermRelaxCutoff(25, 'balanced', minimalPropWash);
    // Below minimal threshold → falls through to style check
    expect(rec).toBeDefined();
    expect(rec!.ruleId).toBe('P-IRELAX'); // style-based, not propwash
  });

  it('PW-IRELAX-ENABLE: should recommend enabling iterm_relax when disabled + propwash detected', () => {
    const rec = recommendItermRelaxCutoff(undefined, 'balanced', mildPropWash, 0);
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('iterm_relax');
    expect(rec!.currentValue).toBe(0);
    expect(rec!.recommendedValue).toBe(1);
    expect(rec!.ruleId).toBe('PW-IRELAX-ENABLE');
    expect(rec!.reason).toContain('iterm_relax is disabled');
  });

  it('PW-IRELAX-ENABLE: should not fire when iterm_relax is already enabled', () => {
    const rec = recommendItermRelaxCutoff(undefined, 'balanced', mildPropWash, 1);
    // iterm_relax=1 (enabled), cutoff undefined → returns undefined
    expect(rec).toBeUndefined();
  });

  it('should preserve existing style-based behavior when no propwash', () => {
    // No propwash passed — original behavior
    const rec = recommendItermRelaxCutoff(30, 'balanced');
    expect(rec).toBeDefined();
    expect(rec!.ruleId).toBe('P-IRELAX');
    expect(rec!.recommendedValue).toBe(12);
  });
});

describe('extractItermRelaxMode', () => {
  it('should extract iterm_relax type from BBL headers', () => {
    const headers = new Map([['iterm_relax', '1']]);
    expect(extractItermRelaxMode(headers)).toBe(1);
  });

  it('should return undefined when header is missing', () => {
    const headers = new Map<string, string>();
    expect(extractItermRelaxMode(headers)).toBeUndefined();
  });
});

describe('recommendTPA propwash-aware (Task 5)', () => {
  const severePropWash = makePropWash({ meanSeverity: 6.0 });

  it('PW-TPA-MODE: should recommend D-only when propwash severe + PD mode', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 1 };
    const recs = recommendTPA(ctx, '5"', undefined, severePropWash);
    const modeRec = recs.find((r) => r.ruleId === 'PW-TPA-MODE');
    expect(modeRec).toBeDefined();
    expect(modeRec!.setting).toBe('tpa_mode');
    expect(modeRec!.currentValue).toBe(1);
    expect(modeRec!.recommendedValue).toBe(0);
    expect(modeRec!.confidence).toBe('medium');
    expect(modeRec!.reason).toContain('D-only');
  });

  it('PW-TPA-MODE: should not fire when mode is already D-only', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '5"', undefined, severePropWash);
    const modeRec = recs.find((r) => r.ruleId === 'PW-TPA-MODE');
    expect(modeRec).toBeUndefined();
  });

  it('PW-TPA-BREAKPOINT: should recommend raising breakpoint when propwash severe + low breakpoint', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1100, mode: 0 };
    const recs = recommendTPA(ctx, '5"', undefined, severePropWash);
    const bpRec = recs.find((r) => r.ruleId === 'PW-TPA-BREAKPOINT');
    expect(bpRec).toBeDefined();
    expect(bpRec!.setting).toBe('tpa_breakpoint');
    expect(bpRec!.currentValue).toBe(1100);
    expect(bpRec!.recommendedValue).toBe(1350);
    expect(bpRec!.confidence).toBe('medium');
    expect(bpRec!.reason).toContain('D attenuation');
  });

  it('PW-TPA-BREAKPOINT: should not fire when breakpoint is already above minimum', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1400, mode: 0 };
    const recs = recommendTPA(ctx, '5"', undefined, severePropWash);
    const bpRec = recs.find((r) => r.ruleId === 'PW-TPA-BREAKPOINT');
    expect(bpRec).toBeUndefined();
  });

  it('PW-TPA-RATE: should recommend capping rate when propwash severe + high rate', () => {
    const ctx: TPAContext = { active: true, rate: 90, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '5"', undefined, severePropWash);
    const rateRec = recs.find((r) => r.ruleId === 'PW-TPA-RATE');
    expect(rateRec).toBeDefined();
    expect(rateRec!.setting).toBe('tpa_rate');
    expect(rateRec!.currentValue).toBe(90);
    expect(rateRec!.recommendedValue).toBe(65);
    expect(rateRec!.confidence).toBe('medium');
  });

  it('PW-TPA-RATE: should not fire when rate is within limit', () => {
    const ctx: TPAContext = { active: true, rate: 60, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '5"', undefined, severePropWash);
    const rateRec = recs.find((r) => r.ruleId === 'PW-TPA-RATE');
    expect(rateRec).toBeUndefined();
  });

  it('propwash TPA rate should take precedence over size-based rate when both fire', () => {
    // Rate 90 is high for 5" (size says 65) AND propwash says cap at 65
    // Should get PW-TPA-RATE, not a duplicate P-TPA for rate
    const ctx: TPAContext = { active: true, rate: 90, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '5"', undefined, severePropWash);
    const rateRecs = recs.filter((r) => r.setting === 'tpa_rate');
    expect(rateRecs.length).toBe(1);
    expect(rateRecs[0].ruleId).toBe('PW-TPA-RATE');
  });

  it('propwash TPA breakpoint should take precedence over size-based breakpoint when both fire', () => {
    // Breakpoint 1100 is off for 5" (size says 1350) AND propwash says raise to 1350
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1100, mode: 0 };
    const recs = recommendTPA(ctx, '5"', undefined, severePropWash);
    const bpRecs = recs.filter((r) => r.setting === 'tpa_breakpoint');
    expect(bpRecs.length).toBe(1);
    expect(bpRecs[0].ruleId).toBe('PW-TPA-BREAKPOINT');
  });

  it('should preserve existing TPA behavior when no propwash', () => {
    const ctx: TPAContext = { active: true, rate: 30, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '5"');
    const rateRec = recs.find((r) => r.setting === 'tpa_rate');
    expect(rateRec).toBeDefined();
    expect(rateRec!.ruleId).toBe('P-TPA');
  });
});

// ---- VBat Sag Compensation Advisory ----

describe('extractVbatSagCompensation', () => {
  it('should extract vbat_sag_compensation from headers', () => {
    const headers = new Map([['vbat_sag_compensation', '75']]);
    expect(extractVbatSagCompensation(headers)).toBe(75);
  });

  it('should return undefined when header is missing', () => {
    expect(extractVbatSagCompensation(new Map())).toBeUndefined();
  });
});

describe('recommendVbatSagCompensation', () => {
  it('should return undefined when value is undefined', () => {
    expect(recommendVbatSagCompensation(undefined, 'balanced')).toBeUndefined();
  });

  it('should return undefined when already enabled', () => {
    expect(recommendVbatSagCompensation(50, 'balanced')).toBeUndefined();
  });

  it('should return undefined for aggressive (racing) style', () => {
    expect(recommendVbatSagCompensation(0, 'aggressive')).toBeUndefined();
  });

  it('should recommend 75 for balanced style when disabled', () => {
    const rec = recommendVbatSagCompensation(0, 'balanced');
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('vbat_sag_compensation');
    expect(rec!.currentValue).toBe(0);
    expect(rec!.recommendedValue).toBe(75);
    expect(rec!.ruleId).toBe('P-VBAT-SAG');
    expect(rec!.confidence).toBe('low');
  });

  it('should recommend 75 for smooth (cinematic) style when disabled', () => {
    const rec = recommendVbatSagCompensation(0, 'smooth');
    expect(rec).toBeDefined();
    expect(rec!.recommendedValue).toBe(75);
  });
});

describe('P-TPA-LOW (BF 4.5+ low-throttle TPA, P2.5)', () => {
  const severePropWash = makePropWash({ meanSeverity: 6.0 });

  it('recommends enabling tpa_low_always on severe propwash when supported and off', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 0, lowAlways: 0 };
    const recs = recommendTPA(ctx, '5"', undefined, severePropWash);
    const rec = recs.find((r) => r.ruleId === 'P-TPA-LOW');
    expect(rec).toBeDefined();
    expect(rec!.setting).toBe('tpa_low_always');
    expect(rec!.recommendedValue).toBe(1);
    expect(rec!.confidence).toBe('low');
  });

  it('does not fire when the firmware lacks low-throttle TPA (field undefined)', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 0 };
    const recs = recommendTPA(ctx, '5"', undefined, severePropWash);
    expect(recs.find((r) => r.ruleId === 'P-TPA-LOW')).toBeUndefined();
  });

  it('does not fire when tpa_low_always is already enabled', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 0, lowAlways: 1 };
    const recs = recommendTPA(ctx, '5"', undefined, severePropWash);
    expect(recs.find((r) => r.ruleId === 'P-TPA-LOW')).toBeUndefined();
  });

  it('does not fire without severe propwash', () => {
    const ctx: TPAContext = { active: true, rate: 65, breakpoint: 1350, mode: 0, lowAlways: 0 };
    const recs = recommendTPA(ctx, '5"', undefined, makePropWash({ meanSeverity: 1.5 }));
    expect(recs.find((r) => r.ruleId === 'P-TPA-LOW')).toBeUndefined();
  });
});
