import { describe, it, expect } from 'vitest';
import {
  analyzeFeedforward,
  deriveMaxStickRate,
  MAX_STICK_RATE_FLOOR,
  MAX_STICK_RATE_FALLBACK,
  recommendFeedforward,
  recommendRCLinkBaseline,
  mergeFFRecommendations,
  extractRCLinkRate,
  LEADING_EDGE_RATIO_THRESHOLD,
  SMALL_STEP_RATIO_THRESHOLD,
  SMOOTH_FACTOR_MAX,
  JITTER_FACTOR_MAX,
  RC_LINK_DEVIATION_THRESHOLD,
} from './FeedforwardAnalyzer';
import { lookupRCLinkProfile, RC_LINK_PROFILES } from './constants';
import type {
  FeedforwardContext,
  FeedforwardAnalysis,
  StepResponse,
  StepEvent,
  PIDRecommendation,
} from '@shared/types/analysis.types';

// ---- Helpers ----

function makeStep(magnitude: number, axis: 0 | 1 | 2 = 0): StepEvent {
  return {
    axis,
    startIndex: 0,
    endIndex: 100,
    magnitude,
    direction: magnitude > 0 ? 'positive' : 'negative',
  };
}

function makeResponse(overrides: Partial<StepResponse> & { step: StepEvent }): StepResponse {
  return {
    riseTimeMs: 10,
    overshootPercent: 15,
    settlingTimeMs: 50,
    latencyMs: 3,
    ringingCount: 0,
    peakValue: 100,
    steadyStateValue: 80,
    trackingErrorRMS: 0.1,
    steadyStateErrorPercent: 2,
    leadingEdgeOvershootPercent: 12,
    ffDominated: true,
    ffEnergyRatio: 0.7,
    ...overrides,
  };
}

const activeFF: FeedforwardContext = {
  active: true,
  boost: 15,
  smoothFactor: 25,
  jitterFactor: 7,
};

// ================================================================
// analyzeFeedforward (step-response analysis)
// ================================================================

describe('analyzeFeedforward', () => {
  it('should return undefined when FF is not active', () => {
    const responses = [makeResponse({ step: makeStep(300) })];
    const result = analyzeFeedforward(responses, { active: false });

    expect(result).toBeUndefined();
  });

  it('should return undefined when FF context is undefined', () => {
    const responses = [makeResponse({ step: makeStep(300) })];
    const result = analyzeFeedforward(responses, undefined);

    expect(result).toBeUndefined();
  });

  it('should return undefined with fewer than 3 steps', () => {
    const responses = [
      makeResponse({ step: makeStep(300) }),
      makeResponse({ step: makeStep(300) }),
    ];
    const result = analyzeFeedforward(responses, activeFF);

    expect(result).toBeUndefined();
  });

  it('should detect leading-edge dominated overshoot', () => {
    // Leading edge overshoot = 30%, total overshoot = 15% → ratio = 2.0
    const responses = Array.from({ length: 5 }, () =>
      makeResponse({
        step: makeStep(300),
        overshootPercent: 15,
        leadingEdgeOvershootPercent: 30,
      })
    );
    const result = analyzeFeedforward(responses, activeFF);

    expect(result).toBeDefined();
    expect(result!.leadingEdgeRatio).toBe(2.0);
    expect(result!.hasRecommendations).toBe(true);
    expect(result!.summary).toContain('ff_smooth_factor');
  });

  it('should not flag when leading-edge ratio is below threshold', () => {
    // Leading edge = 10%, total = 15% → ratio = 0.67 (below threshold)
    const responses = Array.from({ length: 5 }, () =>
      makeResponse({
        step: makeStep(300),
        overshootPercent: 15,
        leadingEdgeOvershootPercent: 10,
      })
    );
    const result = analyzeFeedforward(responses, activeFF);

    expect(result).toBeDefined();
    expect(result!.leadingEdgeRatio).toBeLessThan(LEADING_EDGE_RATIO_THRESHOLD);
    expect(result!.summary).not.toContain('ff_smooth_factor');
  });

  it('should detect small-step overshoot dominance', () => {
    // maxStickRate = 670, threshold = 201
    // Small steps (<201 deg/s) overshoot 40%, large steps (>=201) overshoot 15%
    const smallSteps = Array.from({ length: 4 }, () =>
      makeResponse({
        step: makeStep(100),
        overshootPercent: 40,
        leadingEdgeOvershootPercent: 10,
      })
    );
    const largeSteps = Array.from({ length: 4 }, () =>
      makeResponse({
        step: makeStep(400),
        overshootPercent: 15,
        leadingEdgeOvershootPercent: 10,
      })
    );

    const result = analyzeFeedforward([...smallSteps, ...largeSteps], activeFF);

    expect(result).toBeDefined();
    expect(result!.smallStepOvershootRatio).toBeGreaterThan(SMALL_STEP_RATIO_THRESHOLD);
    expect(result!.smallStepCount).toBe(4);
    expect(result!.largeStepCount).toBe(4);
    expect(result!.hasRecommendations).toBe(true);
    expect(result!.summary).toContain('feedforward_jitter_factor');
  });

  it('should not flag when small-step ratio is below threshold', () => {
    const smallSteps = Array.from({ length: 4 }, () =>
      makeResponse({
        step: makeStep(100),
        overshootPercent: 15,
        leadingEdgeOvershootPercent: 10,
      })
    );
    const largeSteps = Array.from({ length: 4 }, () =>
      makeResponse({
        step: makeStep(400),
        overshootPercent: 14,
        leadingEdgeOvershootPercent: 10,
      })
    );

    const result = analyzeFeedforward([...smallSteps, ...largeSteps], activeFF);

    expect(result).toBeDefined();
    expect(result!.smallStepOvershootRatio).toBeLessThan(SMALL_STEP_RATIO_THRESHOLD);
    expect(result!.summary).not.toContain('feedforward_jitter_factor');
  });

  it('should report RC link rate in summary when high-speed', () => {
    const responses = Array.from({ length: 5 }, () =>
      makeResponse({
        step: makeStep(300),
        overshootPercent: 15,
        leadingEdgeOvershootPercent: 10,
      })
    );
    const ffWithRC: FeedforwardContext = { ...activeFF, rcLinkRateHz: 500 };
    const result = analyzeFeedforward(responses, ffWithRC);

    expect(result).toBeDefined();
    expect(result!.rcLinkRateHz).toBe(500);
    expect(result!.summary).toContain('500 Hz');
  });

  it('should handle responses without ffDominated field', () => {
    const responses = Array.from({ length: 5 }, () =>
      makeResponse({
        step: makeStep(300),
        ffDominated: undefined,
        overshootPercent: 20,
      })
    );
    // Without ffDominated, responses are filtered out → not enough data
    const result = analyzeFeedforward(responses, activeFF);

    expect(result).toBeUndefined();
  });

  it('should report well-tuned when no issues found', () => {
    const responses = Array.from({ length: 5 }, () =>
      makeResponse({
        step: makeStep(300),
        overshootPercent: 10,
        leadingEdgeOvershootPercent: 5,
      })
    );
    const result = analyzeFeedforward(responses, activeFF);

    expect(result).toBeDefined();
    expect(result!.hasRecommendations).toBe(false);
    expect(result!.summary).toContain('well-tuned');
  });
});

// ================================================================
// recommendFeedforward (step-response-based refinement)
// ================================================================

describe('recommendFeedforward', () => {
  const baseAnalysis: FeedforwardAnalysis = {
    hasRecommendations: true,
    leadingEdgeRatio: 2.0,
    smallStepOvershootRatio: 1.0,
    smallStepCount: 5,
    largeStepCount: 5,
    summary: 'test',
  };

  it('should return empty when analysis is undefined', () => {
    expect(recommendFeedforward(undefined, activeFF)).toEqual([]);
  });

  it('should return empty when FF is not active', () => {
    expect(recommendFeedforward(baseAnalysis, { active: false })).toEqual([]);
  });

  it('should recommend smooth factor increase for leading-edge overshoot', () => {
    const recs = recommendFeedforward(baseAnalysis, activeFF);

    const smoothRec = recs.find((r) => r.setting === 'feedforward_smooth_factor');
    expect(smoothRec).toBeDefined();
    expect(smoothRec!.currentValue).toBe(25);
    expect(smoothRec!.recommendedValue).toBe(35); // 25 + 10
    expect(smoothRec!.reason).toContain('leading-edge');
  });

  it('should recommend larger smooth factor step for high-speed RC', () => {
    const ffWithRC: FeedforwardContext = { ...activeFF, rcLinkRateHz: 500 };
    const recs = recommendFeedforward(baseAnalysis, ffWithRC);

    const smoothRec = recs.find((r) => r.setting === 'feedforward_smooth_factor');
    expect(smoothRec).toBeDefined();
    expect(smoothRec!.recommendedValue).toBe(45); // 25 + 10 + 10 (high-speed bonus)
    expect(smoothRec!.reason).toContain('High-speed RC link');
  });

  it('should clamp smooth factor to maximum', () => {
    const ffHighSmooth: FeedforwardContext = { ...activeFF, smoothFactor: 70, rcLinkRateHz: 500 };
    const recs = recommendFeedforward(baseAnalysis, ffHighSmooth);

    const smoothRec = recs.find((r) => r.setting === 'feedforward_smooth_factor');
    expect(smoothRec).toBeDefined();
    expect(smoothRec!.recommendedValue).toBe(SMOOTH_FACTOR_MAX);
  });

  it('should recommend jitter factor increase for small-step overshoot', () => {
    const analysis: FeedforwardAnalysis = {
      ...baseAnalysis,
      leadingEdgeRatio: 1.0, // no leading-edge issue
      smallStepOvershootRatio: 2.0, // small steps overshoot 2x more
    };
    const recs = recommendFeedforward(analysis, activeFF);

    const jitterRec = recs.find((r) => r.setting === 'feedforward_jitter_factor');
    expect(jitterRec).toBeDefined();
    expect(jitterRec!.currentValue).toBe(7);
    expect(jitterRec!.recommendedValue).toBe(10); // 7 + 3
    expect(jitterRec!.reason).toContain('Small stick movements');
  });

  it('should clamp jitter factor to maximum', () => {
    const ffHighJitter: FeedforwardContext = { ...activeFF, jitterFactor: 19 };
    const analysis: FeedforwardAnalysis = {
      ...baseAnalysis,
      leadingEdgeRatio: 1.0,
      smallStepOvershootRatio: 2.0,
    };
    const recs = recommendFeedforward(analysis, ffHighJitter);

    const jitterRec = recs.find((r) => r.setting === 'feedforward_jitter_factor');
    expect(jitterRec).toBeDefined();
    expect(jitterRec!.recommendedValue).toBe(JITTER_FACTOR_MAX);
  });

  it('should produce both recommendations when both issues present', () => {
    const analysis: FeedforwardAnalysis = {
      ...baseAnalysis,
      leadingEdgeRatio: 2.0,
      smallStepOvershootRatio: 2.0,
    };
    const recs = recommendFeedforward(analysis, activeFF);

    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.setting)).toContain('feedforward_smooth_factor');
    expect(recs.map((r) => r.setting)).toContain('feedforward_jitter_factor');
  });

  it('should not recommend when smooth factor is already at max', () => {
    const ffMaxSmooth: FeedforwardContext = { ...activeFF, smoothFactor: SMOOTH_FACTOR_MAX };
    const recs = recommendFeedforward(baseAnalysis, ffMaxSmooth);

    const smoothRec = recs.find((r) => r.setting === 'feedforward_smooth_factor');
    expect(smoothRec).toBeUndefined();
  });
});

// ================================================================
// lookupRCLinkProfile
// ================================================================

describe('lookupRCLinkProfile', () => {
  it('should return undefined for undefined rate', () => {
    expect(lookupRCLinkProfile(undefined)).toBeUndefined();
  });

  it('should return undefined for zero rate', () => {
    expect(lookupRCLinkProfile(0)).toBeUndefined();
  });

  it('should return undefined for negative rate', () => {
    expect(lookupRCLinkProfile(-50)).toBeUndefined();
  });

  it('should return CRSF 50Hz profile for 50 Hz', () => {
    const profile = lookupRCLinkProfile(50);
    expect(profile).toBeDefined();
    expect(profile!.label).toBe('CRSF 50Hz');
    expect(profile!.averaging).toBe(0);
    expect(profile!.smoothFactor).toBe(0);
    expect(profile!.jitterFactor).toBe(10);
    expect(profile!.boost).toBe(5);
  });

  it('should return CRSF 150Hz profile for 100 Hz', () => {
    const profile = lookupRCLinkProfile(100);
    expect(profile).toBeDefined();
    expect(profile!.label).toBe('CRSF 150Hz');
    expect(profile!.averaging).toBe(0);
    expect(profile!.smoothFactor).toBe(30);
    expect(profile!.jitterFactor).toBe(7);
    expect(profile!.boost).toBeUndefined();
  });

  it('should return CRSF Dynamic profile for 200 Hz', () => {
    const profile = lookupRCLinkProfile(200);
    expect(profile).toBeDefined();
    expect(profile!.label).toBe('CRSF Dynamic');
    expect(profile!.averaging).toBe(0);
    expect(profile!.smoothFactor).toBe(15);
    expect(profile!.jitterFactor).toBe(10);
    expect(profile!.boost).toBe(10);
  });

  it('should return ELRS/Tracer profile for 250 Hz', () => {
    const profile = lookupRCLinkProfile(250);
    expect(profile).toBeDefined();
    expect(profile!.label).toBe('ELRS/Tracer 250Hz');
    expect(profile!.averaging).toBe(2);
    expect(profile!.smoothFactor).toBe(35);
    expect(profile!.jitterFactor).toBe(5);
    expect(profile!.boost).toBe(18);
  });

  it('should return ELRS 500Hz+ profile for 500 Hz', () => {
    const profile = lookupRCLinkProfile(500);
    expect(profile).toBeDefined();
    expect(profile!.label).toBe('ELRS 500Hz+');
    expect(profile!.averaging).toBe(2);
    expect(profile!.smoothFactor).toBe(65);
    expect(profile!.jitterFactor).toBe(4);
    expect(profile!.boost).toBe(18);
  });

  it('should return ELRS 500Hz+ profile for 1000 Hz', () => {
    const profile = lookupRCLinkProfile(1000);
    expect(profile).toBeDefined();
    expect(profile!.label).toBe('ELRS 500Hz+');
  });

  it('should have non-overlapping bands covering all positive rates', () => {
    for (let hz = 1; hz <= 1000; hz++) {
      const profile = lookupRCLinkProfile(hz);
      expect(profile).toBeDefined();
    }
  });

  it('should have 5 profiles covering the full range', () => {
    expect(RC_LINK_PROFILES).toHaveLength(5);
  });

  it('should return profiles at exact band boundaries', () => {
    // Test boundary between band 1 and 2
    expect(lookupRCLinkProfile(60)!.label).toBe('CRSF 50Hz');
    expect(lookupRCLinkProfile(61)!.label).toBe('CRSF 150Hz');

    // Test boundary between band 2 and 3
    expect(lookupRCLinkProfile(149)!.label).toBe('CRSF 150Hz');
    expect(lookupRCLinkProfile(150)!.label).toBe('CRSF Dynamic');

    // Test boundary between band 3 and 4
    expect(lookupRCLinkProfile(249)!.label).toBe('CRSF Dynamic');
    expect(lookupRCLinkProfile(250)!.label).toBe('ELRS/Tracer 250Hz');

    // Test boundary between band 4 and 5
    expect(lookupRCLinkProfile(499)!.label).toBe('ELRS/Tracer 250Hz');
    expect(lookupRCLinkProfile(500)!.label).toBe('ELRS 500Hz+');
  });
});

// ================================================================
// recommendRCLinkBaseline
// ================================================================

describe('recommendRCLinkBaseline', () => {
  it('should return empty when FF is not active', () => {
    expect(recommendRCLinkBaseline({ active: false })).toEqual([]);
  });

  it('should return empty when FF context is undefined', () => {
    expect(recommendRCLinkBaseline(undefined)).toEqual([]);
  });

  it('should return empty when RC link rate is unknown', () => {
    expect(recommendRCLinkBaseline({ active: true, boost: 15 })).toEqual([]);
  });

  it('should return empty when settings match the profile (ELRS 250Hz)', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 18,
      averaging: 2,
      smoothFactor: 35,
      jitterFactor: 5,
      rcLinkRateHz: 250,
    };
    const recs = recommendRCLinkBaseline(ctx);
    expect(recs).toEqual([]);
  });

  it('should recommend averaging change for ELRS 500Hz when OFF', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 18,
      averaging: 0, // OFF, should be 2_POINT
      smoothFactor: 65,
      jitterFactor: 4,
      rcLinkRateHz: 500,
    };
    const recs = recommendRCLinkBaseline(ctx);
    const avgRec = recs.find((r) => r.setting === 'feedforward_averaging');
    expect(avgRec).toBeDefined();
    expect(avgRec!.ruleId).toBe('FF-AVG');
    expect(avgRec!.currentValue).toBe(0);
    expect(avgRec!.recommendedValue).toBe(2);
    expect(avgRec!.reason).toContain('500 Hz');
    expect(avgRec!.reason).toContain('2-point averaging');
  });

  it('should recommend against averaging for low-rate CRSF 50Hz', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 5,
      averaging: 2, // 2_POINT, should be OFF for 50Hz
      smoothFactor: 0,
      jitterFactor: 10,
      rcLinkRateHz: 50,
    };
    const recs = recommendRCLinkBaseline(ctx);
    const avgRec = recs.find((r) => r.setting === 'feedforward_averaging');
    expect(avgRec).toBeDefined();
    expect(avgRec!.recommendedValue).toBe(0);
    expect(avgRec!.reason).toContain('latency');
  });

  it('should recommend smooth factor change for CRSF 150Hz', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 15,
      averaging: 0,
      smoothFactor: 0, // way off from 30
      jitterFactor: 7,
      rcLinkRateHz: 100,
    };
    const recs = recommendRCLinkBaseline(ctx);
    const smoothRec = recs.find((r) => r.setting === 'feedforward_smooth_factor');
    expect(smoothRec).toBeDefined();
    expect(smoothRec!.ruleId).toBe('FF-SMOOTH');
    expect(smoothRec!.currentValue).toBe(0);
    expect(smoothRec!.recommendedValue).toBe(30);
  });

  it('should recommend jitter factor change for ELRS/Tracer 250Hz', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 18,
      averaging: 2,
      smoothFactor: 35,
      jitterFactor: 15, // way off from 5
      rcLinkRateHz: 300,
    };
    const recs = recommendRCLinkBaseline(ctx);
    const jitterRec = recs.find((r) => r.setting === 'feedforward_jitter_factor');
    expect(jitterRec).toBeDefined();
    expect(jitterRec!.ruleId).toBe('FF-JITTER');
    expect(jitterRec!.currentValue).toBe(15);
    expect(jitterRec!.recommendedValue).toBe(5);
  });

  it('should not recommend when deviation is within 30% threshold', () => {
    // Profile for ELRS/Tracer 250Hz: smooth=35, jitter=5
    // smooth=28 → deviation = |28-35|/35 = 0.2 (within 30%)
    // jitter=4 → deviation = |4-5|/5 = 0.2 (within 30%)
    const ctx: FeedforwardContext = {
      active: true,
      boost: 18,
      averaging: 2,
      smoothFactor: 28,
      jitterFactor: 4,
      rcLinkRateHz: 300,
    };
    const recs = recommendRCLinkBaseline(ctx);
    expect(recs.filter((r) => r.setting === 'feedforward_smooth_factor')).toHaveLength(0);
    expect(recs.filter((r) => r.setting === 'feedforward_jitter_factor')).toHaveLength(0);
  });

  it('should recommend rc_smoothing_auto_factor advisory when at default for >=150Hz', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 15,
      averaging: 0,
      smoothFactor: 15,
      jitterFactor: 10,
      rcLinkRateHz: 200,
      rcSmoothingAutoFactor: 30,
    };
    const recs = recommendRCLinkBaseline(ctx);
    const rcRec = recs.find((r) => r.setting === 'rc_smoothing_auto_factor');
    expect(rcRec).toBeDefined();
    expect(rcRec!.ruleId).toBe('FF-RC-SMOOTH');
    expect(rcRec!.currentValue).toBe(30);
    expect(rcRec!.recommendedValue).toBe(45);
  });

  it('should recommend rc_smoothing_auto_factor when below recommended (non-default)', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 15,
      averaging: 0,
      smoothFactor: 15,
      jitterFactor: 10,
      rcLinkRateHz: 200,
      rcSmoothingAutoFactor: 35, // non-default, but below recommended 45
    };
    const recs = recommendRCLinkBaseline(ctx);
    const rcRec = recs.find((r) => r.setting === 'rc_smoothing_auto_factor');
    expect(rcRec).toBeDefined();
    expect(rcRec!.currentValue).toBe(35);
    expect(rcRec!.recommendedValue).toBe(45);
  });

  it('should not recommend rc_smoothing_auto_factor when at recommended', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 15,
      averaging: 0,
      smoothFactor: 15,
      jitterFactor: 10,
      rcLinkRateHz: 200,
      rcSmoothingAutoFactor: 45, // already at recommended
    };
    const recs = recommendRCLinkBaseline(ctx);
    const rcRec = recs.find((r) => r.setting === 'rc_smoothing_auto_factor');
    expect(rcRec).toBeUndefined();
  });

  it('should skip the FF-RC-SMOOTH advisory for aggressive style (racing runs 20-30)', () => {
    // Same context that fires for balanced/smooth — BF 4.3 Tuning Notes put
    // racing at auto factor 20-30, so pushing a racer to 45 would add latency.
    const ctx: FeedforwardContext = {
      active: true,
      boost: 15,
      averaging: 0,
      smoothFactor: 15,
      jitterFactor: 10,
      rcLinkRateHz: 200,
      rcSmoothingAutoFactor: 30,
    };
    const recs = recommendRCLinkBaseline(ctx, 'aggressive');
    const rcRec = recs.find((r) => r.setting === 'rc_smoothing_auto_factor');
    expect(rcRec).toBeUndefined();
  });

  it('should still emit FF-RC-SMOOTH for balanced style (explicit flightStyle param)', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 15,
      averaging: 0,
      smoothFactor: 15,
      jitterFactor: 10,
      rcLinkRateHz: 200,
      rcSmoothingAutoFactor: 30,
    };
    const recs = recommendRCLinkBaseline(ctx, 'balanced');
    const rcRec = recs.find((r) => r.setting === 'rc_smoothing_auto_factor');
    expect(rcRec).toBeDefined();
    expect(rcRec!.ruleId).toBe('FF-RC-SMOOTH');
  });

  it('should not recommend rc_smoothing_auto_factor for low RC rate', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 5,
      averaging: 0,
      smoothFactor: 0,
      jitterFactor: 10,
      rcLinkRateHz: 50,
      rcSmoothingAutoFactor: 30,
    };
    const recs = recommendRCLinkBaseline(ctx);
    const rcRec = recs.find((r) => r.setting === 'rc_smoothing_auto_factor');
    expect(rcRec).toBeUndefined();
  });

  it('should generate all 3 FF recs + rc_smoothing when everything is wrong', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 15,
      averaging: 0, // should be 2 for ELRS 500Hz
      smoothFactor: 0, // should be 65
      jitterFactor: 20, // should be 4
      rcLinkRateHz: 500,
      rcSmoothingAutoFactor: 30, // should be 45
    };
    const recs = recommendRCLinkBaseline(ctx);
    expect(recs).toHaveLength(4);
    const settings = recs.map((r) => r.setting);
    expect(settings).toContain('feedforward_averaging');
    expect(settings).toContain('feedforward_smooth_factor');
    expect(settings).toContain('feedforward_jitter_factor');
    expect(settings).toContain('rc_smoothing_auto_factor');
  });

  it('should handle missing FF context fields gracefully', () => {
    const ctx: FeedforwardContext = {
      active: true,
      // no averaging, smoothFactor, jitterFactor — all undefined → defaults to 0
      rcLinkRateHz: 500,
    };
    const recs = recommendRCLinkBaseline(ctx);
    // Should recommend averaging (0 → 2) and smooth factor (0 → 65)
    expect(recs.find((r) => r.setting === 'feedforward_averaging')).toBeDefined();
    expect(recs.find((r) => r.setting === 'feedforward_smooth_factor')).toBeDefined();
  });

  it('should include ruleId on all recommendations', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 15,
      averaging: 0,
      smoothFactor: 0,
      jitterFactor: 20,
      rcLinkRateHz: 500,
      rcSmoothingAutoFactor: 30,
    };
    const recs = recommendRCLinkBaseline(ctx);
    for (const rec of recs) {
      expect(rec.ruleId).toBeDefined();
      expect(rec.ruleId).toMatch(/^FF-/);
    }
  });

  it('should set confidence to medium on all recommendations', () => {
    const ctx: FeedforwardContext = {
      active: true,
      boost: 15,
      averaging: 0,
      smoothFactor: 0,
      jitterFactor: 20,
      rcLinkRateHz: 500,
    };
    const recs = recommendRCLinkBaseline(ctx);
    for (const rec of recs) {
      expect(rec.confidence).toBe('medium');
    }
  });

  // Test each RC link band generates correct recommendations
  describe('per-band recommendations', () => {
    it('should recommend correct values for CRSF 50Hz band', () => {
      // Mismatch everything with ELRS-style settings
      const ctx: FeedforwardContext = {
        active: true,
        boost: 18,
        averaging: 2,
        smoothFactor: 65,
        jitterFactor: 4,
        rcLinkRateHz: 50,
      };
      const recs = recommendRCLinkBaseline(ctx);
      expect(recs.find((r) => r.setting === 'feedforward_averaging')!.recommendedValue).toBe(0);
      expect(recs.find((r) => r.setting === 'feedforward_smooth_factor')!.recommendedValue).toBe(0);
      expect(recs.find((r) => r.setting === 'feedforward_jitter_factor')!.recommendedValue).toBe(
        10
      );
    });

    it('should recommend correct values for ELRS 500Hz+ band', () => {
      // Mismatch everything with CRSF-style settings
      const ctx: FeedforwardContext = {
        active: true,
        boost: 5,
        averaging: 0,
        smoothFactor: 0,
        jitterFactor: 15,
        rcLinkRateHz: 500,
      };
      const recs = recommendRCLinkBaseline(ctx);
      expect(recs.find((r) => r.setting === 'feedforward_averaging')!.recommendedValue).toBe(2);
      expect(recs.find((r) => r.setting === 'feedforward_smooth_factor')!.recommendedValue).toBe(
        65
      );
      expect(recs.find((r) => r.setting === 'feedforward_jitter_factor')!.recommendedValue).toBe(4);
    });
  });
});

// ================================================================
// mergeFFRecommendations
// ================================================================

describe('mergeFFRecommendations', () => {
  const makeRec = (setting: string, value: number, ruleId?: string): PIDRecommendation => ({
    setting,
    currentValue: 0,
    recommendedValue: value,
    reason: 'test',
    impact: 'stability',
    confidence: 'medium',
    ...(ruleId ? { ruleId } : {}),
  });

  it('should return step recs when no baseline recs', () => {
    const stepRecs = [makeRec('feedforward_smooth_factor', 35)];
    const merged = mergeFFRecommendations([], stepRecs);
    expect(merged).toHaveLength(1);
    expect(merged[0].recommendedValue).toBe(35);
  });

  it('should return baseline recs when no step recs', () => {
    const baselineRecs = [makeRec('feedforward_averaging', 2, 'FF-AVG')];
    const merged = mergeFFRecommendations(baselineRecs, []);
    expect(merged).toHaveLength(1);
    expect(merged[0].setting).toBe('feedforward_averaging');
  });

  it('should prefer step recs over baseline for same setting', () => {
    const baseline = [makeRec('feedforward_smooth_factor', 65, 'FF-SMOOTH')];
    const step = [makeRec('feedforward_smooth_factor', 45)];
    const merged = mergeFFRecommendations(baseline, step);
    expect(merged).toHaveLength(1);
    expect(merged[0].recommendedValue).toBe(45); // step wins
  });

  it('should include non-overlapping settings from both', () => {
    const baseline = [
      makeRec('feedforward_averaging', 2, 'FF-AVG'),
      makeRec('feedforward_smooth_factor', 65, 'FF-SMOOTH'),
    ];
    const step = [makeRec('feedforward_smooth_factor', 45)];
    const merged = mergeFFRecommendations(baseline, step);
    expect(merged).toHaveLength(2);
    expect(merged.find((r) => r.setting === 'feedforward_averaging')).toBeDefined();
    expect(merged.find((r) => r.setting === 'feedforward_smooth_factor')!.recommendedValue).toBe(
      45
    );
  });

  it('should handle both empty', () => {
    expect(mergeFFRecommendations([], [])).toEqual([]);
  });
});

// ================================================================
// extractRCLinkRate
// ================================================================

describe('extractRCLinkRate', () => {
  it('should extract from rc_smoothing_input_hz', () => {
    const headers = new Map([['rc_smoothing_input_hz', '250']]);
    expect(extractRCLinkRate(headers)).toBe(250);
  });

  it('should extract from rcIntervalMs', () => {
    const headers = new Map([['rcIntervalMs', '4']]);
    expect(extractRCLinkRate(headers)).toBe(250);
  });

  it('should prefer rc_smoothing_input_hz over rcIntervalMs', () => {
    const headers = new Map([
      ['rc_smoothing_input_hz', '500'],
      ['rcIntervalMs', '4'],
    ]);
    expect(extractRCLinkRate(headers)).toBe(500);
  });

  it('should return undefined when no headers present', () => {
    expect(extractRCLinkRate(new Map())).toBeUndefined();
  });

  it('should return undefined for zero values', () => {
    const headers = new Map([['rc_smoothing_input_hz', '0']]);
    expect(extractRCLinkRate(headers)).toBeUndefined();
  });
});

describe('deriveMaxStickRate', () => {
  const series = (values: number[]) => ({ values: new Float64Array(values) });

  it('uses the max |setpoint| across roll/pitch/yaw', () => {
    const setpoint = [series([100, -850, 300]), series([200, 400, -300]), series([50, 0, 25])];
    expect(deriveMaxStickRate(setpoint)).toBe(850);
  });

  it('floors gentle flights at MAX_STICK_RATE_FLOOR', () => {
    const setpoint = [series([10, -40, 30]), series([20, 15, -25]), series([5, 0, 2])];
    expect(deriveMaxStickRate(setpoint)).toBe(MAX_STICK_RATE_FLOOR);
  });

  it('falls back to the BF default when no data', () => {
    expect(deriveMaxStickRate(undefined)).toBe(MAX_STICK_RATE_FALLBACK);
    expect(deriveMaxStickRate([series([0, 0]), series([0]), series([0])])).toBe(
      MAX_STICK_RATE_FALLBACK
    );
  });
});
