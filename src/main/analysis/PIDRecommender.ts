/**
 * Rule-based PID recommendation engine.
 *
 * Analyzes step response profiles for each axis and produces
 * beginner-friendly PID tuning recommendations with safety bounds.
 */
import type { PIDConfiguration } from '@shared/types/pid.types';
import type {
  AxisStepProfile,
  DTermEffectiveness,
  FeedforwardContext,
  PIDRecommendation,
  PropWashAnalysis,
} from '@shared/types/analysis.types';
import type { DroneSize, FlightStyle } from '@shared/types/profile.types';
import type { TransferFunctionMetrics } from './TransferFunctionEstimator';
import {
  PID_STYLE_THRESHOLDS,
  DECONV_THRESHOLD_SCALE,
  DAMPING_RATIO_MIN,
  DAMPING_RATIO_MAX,
  DAMPING_RATIO_MAX_MICRO,
  DAMPING_RATIO_DEADZONE,
  QUAD_SIZE_BOUNDS,
  DEFAULT_QUAD_SIZE_BOUNDS,
  BANDWIDTH_LOW_HZ_BY_STYLE,
  ITERM_RELAX_CUTOFF_BY_STYLE,
  ITERM_RELAX_DEVIATION_THRESHOLD,
  DYN_IDLE_MIN_RPM_BY_SIZE,
  DYN_IDLE_MIN_RPM_DEFAULT,
  PIDSUM_LIMIT_DEFAULT,
  PIDSUM_LIMIT_YAW_DEFAULT,
  PIDSUM_LIMIT_RECOMMENDED,
  PIDSUM_LIMIT_YAW_RECOMMENDED,
  PIDSUM_LIMIT_WEIGHT_THRESHOLD_G,
  FF_MAX_RATE_LIMIT_DEFAULT,
  FF_MAX_RATE_LIMIT_RACE_RECOMMENDED,
  ANTI_GRAVITY_GAIN_DEFAULT,
  ANTI_GRAVITY_WEIGHT_THRESHOLD_G,
  ANTI_GRAVITY_HEAVY_RECOMMENDED,
  ANTI_GRAVITY_MEDIUM_RECOMMENDED,
  ANTI_GRAVITY_SSE_THRESHOLD,
  ANTI_GRAVITY_LOW_THRESHOLD,
  THRUST_LINEAR_BY_SIZE,
  THRUST_LINEAR_DEVIATION_THRESHOLD,
  TPA_BY_SIZE,
  TPA_SIZE_CATEGORY,
  TPA_RATE_DEVIATION_THRESHOLD,
  TPA_SEVERE_NOISE_INCREASE_DB,
  TPA_MODE_D_ONLY,
  TPA_MODE_PD,
  DMIN_BY_SIZE,
  DMIN_GAIN_FREESTYLE,
  DMIN_GAP_MIN_FRACTION,
  PROPWASH_IRELAX_CUTOFF_REDUCTION,
  PROPWASH_IRELAX_CUTOFF_FLOOR,
  PROPWASH_IRELAX_CUTOFF_FLOOR_SEVERE,
  PROPWASH_TPA_BREAKPOINT_MIN,
  PROPWASH_TPA_RATE_MAX,
  PROPWASH_SEVERITY_SEVERE,
  PROPWASH_SEVERITY_MINIMAL,
  FF_DOMINATED_MIN_STEPS,
  type QuadSizeBounds,
} from './constants';

/** Per-axis transfer function metrics for frequency-domain PID recommendations */
export interface TransferFunctionContext {
  roll?: TransferFunctionMetrics;
  pitch?: TransferFunctionMetrics;
  yaw?: TransferFunctionMetrics;
}

const AXIS_NAMES = ['roll', 'pitch', 'yaw'] as const;

/** Resolve PID bounds for a given drone size (falls back to 5" defaults) */
export function resolveBounds(droneSize?: DroneSize): QuadSizeBounds {
  if (!droneSize) return DEFAULT_QUAD_SIZE_BOUNDS;
  return QUAD_SIZE_BOUNDS[droneSize] ?? DEFAULT_QUAD_SIZE_BOUNDS;
}

/**
 * Generate PID recommendations from step response profiles.
 *
 * When `flightPIDs` is provided (extracted from the BBL header), targets are
 * anchored to the PIDs that were active during the recorded flight. This makes
 * recommendations convergent: applying the target and re-analyzing the same
 * session yields no further changes because `target == current`.
 *
 * Fallback: when `flightPIDs` is undefined (older firmware without PID headers),
 * targets are anchored to `currentPIDs` (non-convergent but functional).
 */
export function recommendPID(
  roll: AxisStepProfile,
  pitch: AxisStepProfile,
  yaw: AxisStepProfile,
  currentPIDs: PIDConfiguration,
  flightPIDs?: PIDConfiguration,
  feedforwardContext?: FeedforwardContext,
  flightStyle: FlightStyle = 'balanced',
  tfMetrics?: TransferFunctionContext,
  dTermEffectiveness?: DTermEffectiveness,
  propWash?: PropWashAnalysis,
  droneSize?: DroneSize,
  dMinContext?: DMinContext,
  tpaContext?: TPAContext
): PIDRecommendation[] {
  const recommendations: PIDRecommendation[] = [];
  const profiles = [roll, pitch, yaw] as const;
  const thresholds = PID_STYLE_THRESHOLDS[flightStyle];
  const bounds = resolveBounds(droneSize);

  for (let axis = 0; axis < 3; axis++) {
    const profile = profiles[axis];
    const axisName = AXIS_NAMES[axis];
    const pids = currentPIDs[axisName];
    // Anchor to flight PIDs (from BBL header) when available, else fall back to current
    const base = flightPIDs ? flightPIDs[axisName] : pids;
    const axisTF = tfMetrics?.[axisName];

    // If we have transfer function metrics and no step data, use frequency-domain rules
    if (profile.responses.length === 0 && axisTF) {
      generateFrequencyDomainRecs(
        axisTF,
        axisName,
        pids,
        base,
        thresholds,
        recommendations,
        bounds,
        flightStyle
      );
      continue;
    }

    // Skip axes with no step data (and no TF metrics)
    if (profile.responses.length === 0) continue;

    // Check if overshoot on this axis is FF-dominated (majority of steps)
    // Require minimum classified steps to avoid single-step noise affecting recommendations
    const ffClassified = profile.responses.filter((r) => r.ffDominated !== undefined);
    const ffDominatedCount = ffClassified.filter((r) => r.ffDominated === true).length;
    const axisFFDominated =
      ffClassified.length >= FF_DOMINATED_MIN_STEPS && ffDominatedCount > ffClassified.length / 2;

    // Compute mean FF energy ratio for this axis (used to modulate P recommendations)
    const meanFFEnergyRatio = profile.meanFFEnergyRatio;

    // Yaw is analyzed with relaxed thresholds
    const isYaw = axis === 2;
    // Deconvolved (stacked) metrics read systematically lower than per-step
    // measurements for the same physical response — scale overshoot/settling
    // thresholds accordingly (rise time is comparable, not scaled).
    const deconvScale = profile.metricsSource === 'deconvolved' ? DECONV_THRESHOLD_SCALE : 1;
    const overshootThreshold =
      (isYaw ? thresholds.overshootMax * 1.5 : thresholds.overshootMax) * deconvScale;
    const moderateOvershoot =
      (isYaw ? thresholds.overshootMax : thresholds.moderateOvershoot) * deconvScale;
    const overshootIdealScaled = thresholds.overshootIdeal * deconvScale;
    const settlingMaxScaled = thresholds.settlingMax * deconvScale;
    const sluggishRiseMs = isYaw ? thresholds.sluggishRise * 1.5 : thresholds.sluggishRise;
    // KB §6: ALL overshoot/ringing thresholds relax ×1.5 for yaw (slower axis, less authority)
    const ringingThreshold = isYaw ? thresholds.ringingMax * 1.5 : thresholds.ringingMax;

    // FF-dominated overshoot: skip P/D rules, recommend FF adjustment instead
    if (axisFFDominated && profile.meanOvershoot > moderateOvershoot) {
      const boost = feedforwardContext?.boost;
      // Only emit feedforward_boost recommendation once (not per-axis)
      const existingFFRec = recommendations.find((r) => r.setting === 'feedforward_boost');
      if (!existingFFRec && boost !== undefined && boost > 0) {
        const targetBoost = Math.max(0, boost - 3);
        recommendations.push({
          setting: 'feedforward_boost',
          currentValue: boost,
          recommendedValue: targetBoost,
          reason: `Overshoot on ${axisName} appears to be caused by feedforward, not P/D imbalance (${Math.round(profile.meanOvershoot)}%). Reducing feedforward_boost will tame the overshoot without losing PID responsiveness.`,
          impact: 'stability',
          confidence: 'medium',
          ruleId: 'P-FF-BOOST',
        });
      }
      // Skip P/D overshoot rules for this axis (continue to other rules)
      // Still check ringing and settling which are PID-related
    } else if (profile.meanOvershoot > overshootThreshold) {
      // Rule 1: Severe overshoot → D-first strategy (non-FF case)
      // Scale D step with overshoot severity for faster convergence
      const severity = profile.meanOvershoot / overshootThreshold;
      const dStep = severity > 4 ? 15 : severity > 2 ? 10 : 5;
      const targetD = clamp(base.D + dStep, bounds.dMin, bounds.dMax);
      // Guard: don't introduce D from zero on yaw — D=0 on yaw is a deliberate BF default.
      // Adding D to yaw requires intentional pilot decision, not auto-recommendation.
      if (targetD !== pids.D && !(axisName === 'yaw' && pids.D === 0)) {
        recommendations.push({
          setting: `pid_${axisName}_d`,
          currentValue: pids.D,
          recommendedValue: targetD,
          reason: `Significant overshoot detected on ${axisName} (${Math.round(profile.meanOvershoot)}%). Increasing D-term dampens the bounce-back for a smoother, more controlled feel.`,
          impact: 'both',
          confidence: 'high',
          ruleId: `P-OS-D-${axisName}`,
        });
      }
      // Reduce P when overshoot is extreme (>2x threshold) or D is already high
      if (severity > 2 || base.D >= bounds.dMax * 0.6) {
        const pStep = severity > 4 ? 10 : 5;
        const targetP = clamp(base.P - pStep, bounds.pMin, bounds.pMax);
        if (targetP !== pids.P) {
          const ffNote =
            meanFFEnergyRatio !== undefined && meanFFEnergyRatio > 0.6
              ? ' Overshoot appears feedforward-dominated — consider reducing FF before lowering P.'
              : '';
          recommendations.push({
            setting: `pid_${axisName}_p`,
            currentValue: pids.P,
            recommendedValue: targetP,
            reason: `${severity > 4 ? 'Extreme' : 'Significant'} overshoot on ${axisName} (${Math.round(profile.meanOvershoot)}%). Reducing P-term helps prevent the quad from overshooting its target.${ffNote}`,
            impact: 'both',
            confidence: meanFFEnergyRatio !== undefined && meanFFEnergyRatio > 0.6 ? 'low' : 'high',
            ruleId: `P-OS-P-${axisName}`,
          });
        }
      }
    } else if (profile.meanOvershoot > moderateOvershoot) {
      // Moderate overshoot (15-25%): increase D only
      const targetD = clamp(base.D + 5, bounds.dMin, bounds.dMax);
      if (targetD !== pids.D) {
        recommendations.push({
          setting: `pid_${axisName}_d`,
          currentValue: pids.D,
          recommendedValue: targetD,
          reason: `Your quad overshoots on ${axisName} stick inputs (${Math.round(profile.meanOvershoot)}%). Increasing D-term will dampen the response.`,
          impact: 'stability',
          confidence: 'medium',
          ruleId: `P-OS-D-${axisName}`,
        });
      }
    }

    // Rule 2: Sluggish response (low overshoot + slow rise) → increase P (severity-scaled)
    if (profile.meanOvershoot < overshootIdealScaled && profile.meanRiseTimeMs > sluggishRiseMs) {
      const slugSeverity = profile.meanRiseTimeMs / sluggishRiseMs;
      const pStep = slugSeverity > 2 ? 10 : 5;
      const targetP = clamp(base.P + pStep, bounds.pMin, bounds.pMax);
      if (targetP !== pids.P) {
        recommendations.push({
          setting: `pid_${axisName}_p`,
          currentValue: pids.P,
          recommendedValue: targetP,
          reason: `Response is sluggish on ${axisName} (${Math.round(profile.meanRiseTimeMs)}ms rise time). A P increase will make your quad feel more locked in.`,
          impact: 'response',
          confidence: 'medium',
          ruleId: `P-SLUG-P-${axisName}`,
        });
      }
    }

    // Rule 3: Excessive ringing → increase D (BF: any visible bounce-back should be addressed)
    const maxRinging = Math.max(...profile.responses.map((r) => r.ringingCount));
    if (maxRinging > ringingThreshold) {
      const targetD = clamp(base.D + 5, bounds.dMin, bounds.dMax);
      if (targetD !== pids.D && !(axisName === 'yaw' && pids.D === 0)) {
        // Don't duplicate if we already recommended D increase for overshoot
        const existingDRec = recommendations.find((r) => r.setting === `pid_${axisName}_d`);
        if (!existingDRec) {
          recommendations.push({
            setting: `pid_${axisName}_d`,
            currentValue: pids.D,
            recommendedValue: targetD,
            reason: `Oscillation detected on ${axisName} after stick moves (${maxRinging} cycles). More D-term will calm the wobble.`,
            impact: 'stability',
            confidence: 'medium',
            ruleId: `P-RING-D-${axisName}`,
          });
        }
      }
    }

    // Rule 4: Slow settling → might need more D or less I
    if (
      profile.meanSettlingTimeMs > settlingMaxScaled &&
      profile.meanOvershoot < moderateOvershoot
    ) {
      // Only if overshoot isn't the problem (settling from other causes)
      const existingDRec = recommendations.find((r) => r.setting === `pid_${axisName}_d`);
      if (!existingDRec) {
        const targetD = clamp(base.D + 5, bounds.dMin, bounds.dMax);
        if (targetD !== pids.D) {
          recommendations.push({
            setting: `pid_${axisName}_d`,
            currentValue: pids.D,
            recommendedValue: targetD,
            reason: `${axisName.charAt(0).toUpperCase() + axisName.slice(1)} takes ${Math.round(profile.meanSettlingTimeMs)}ms to settle. A slight D increase will help it lock in faster.`,
            impact: 'stability',
            confidence: 'low',
            ruleId: `P-SETT-D-${axisName}`,
          });
        }
      }
    }

    // Rule 5: I-term — steady-state tracking error
    const ssError = profile.meanSteadyStateError;
    if (ssError > thresholds.steadyStateErrorMax) {
      // High hold-phase error → I-term is too low (quad drifts from target)
      const iStep = ssError > thresholds.steadyStateErrorMax * 2 ? 10 : 5;
      const targetI = clamp(base.I + iStep, bounds.iMin, bounds.iMax);
      if (targetI !== pids.I) {
        recommendations.push({
          setting: `pid_${axisName}_i`,
          currentValue: pids.I,
          recommendedValue: targetI,
          reason: `${axisName.charAt(0).toUpperCase() + axisName.slice(1)} drifts from target during holds (${ssError.toFixed(1)}% error). Increasing I-term improves tracking accuracy and wind resistance.`,
          impact: 'stability',
          confidence: ssError > thresholds.steadyStateErrorMax * 2 ? 'high' : 'medium',
          ruleId: `P-SSE-I-${axisName}`,
        });
      }
    } else if (
      ssError < thresholds.steadyStateErrorLow &&
      profile.meanSettlingTimeMs > settlingMaxScaled &&
      profile.meanOvershoot > moderateOvershoot
    ) {
      // Low error but slow settling + overshoot → I may be causing slow oscillation
      const targetI = clamp(base.I - 5, bounds.iMin, bounds.iMax);
      if (targetI !== pids.I) {
        recommendations.push({
          setting: `pid_${axisName}_i`,
          currentValue: pids.I,
          recommendedValue: targetI,
          reason: `${axisName.charAt(0).toUpperCase() + axisName.slice(1)} has slow settling (${Math.round(profile.meanSettlingTimeMs)}ms) with overshoot. Reducing I-term can help the quad settle faster.`,
          impact: 'stability',
          confidence: 'low',
          ruleId: `P-SSE-I-DEC-${axisName}`,
        });
      }
    }
  }

  // Post-process: apply D-term effectiveness gating FIRST — removes/blocks D increases
  // when effectiveness is < 30%. Must run BEFORE damping ratio to prevent compensatory
  // P increases that are counterproductive when D isn't effective.
  if (dTermEffectiveness) {
    applyDTermEffectiveness(recommendations, dTermEffectiveness);
  }

  // Post-process: validate D/P damping ratio for coordinated P/D recommendations.
  // Only applies to roll and pitch (yaw often has D=0).
  // Must run BEFORE informational P warnings so damping ratio recs take priority.
  // Micro quads (whoops) legitimately run D/P up to ~0.95 per community presets
  const dampingMax =
    droneSize === '1"' || droneSize === '2.5"' ? DAMPING_RATIO_MAX_MICRO : DAMPING_RATIO_MAX;
  validateDampingRatio(recommendations, currentPIDs, bounds, dampingMax);

  // Re-run DTE gating after damping ratio — damping ratio may have added new D recs
  // (P-DR-UD underdamped) that also need to be blocked when D is ineffective.
  if (dTermEffectiveness) {
    applyDTermEffectiveness(recommendations, dTermEffectiveness);
  }

  // Post-process: P informational warnings (after damping ratio to avoid conflicts)
  detectHighP(recommendations, currentPIDs, bounds);
  detectLowP(recommendations, currentPIDs, bounds);

  // Post-process: prop wash context — boost D confidence or suggest D when severe
  if (propWash) {
    applyPropWashContext(recommendations, propWash, currentPIDs, flightPIDs, bounds);
  }

  // Post-process: propwash-aware d_min recommendations
  if (propWash || dMinContext) {
    const dMinRecs = recommendPropWashDMin(
      propWash,
      dMinContext,
      flightPIDs,
      droneSize,
      flightStyle
    );
    recommendations.push(...dMinRecs);
  }

  // Post-process: D-min/D-max advisory notes (includes D-max gain recommendation)
  if (dMinContext?.active) {
    applyDMinAdvisory(recommendations, dMinContext, droneSize);
  }

  // Post-process: TPA advisory notes
  if (tpaContext?.active) {
    applyTPAAdvisory(recommendations, tpaContext);
  }

  return recommendations;
}

/**
 * Post-process recommendations to ensure P/D changes maintain a healthy damping
 * ratio (D/P). Catches three cases:
 *
 * 1. Underdamped (D/P too low) with no D recommendation → add D increase
 * 2. Overdamped (D/P too high) after D increase without P adjustment → add P
 * 3. Overdamped (D/P too high) with no recommendations → reduce D
 */
/**
 * Detect P values significantly above the quad's typical range.
 * Emits an informational (low confidence) recommendation when P is high
 * but step response doesn't show problems — may cause hot motors/noise.
 */
function detectHighP(
  recommendations: PIDRecommendation[],
  currentPIDs: PIDConfiguration,
  bounds: QuadSizeBounds
): void {
  const highPThreshold = bounds.pTypical * 1.3; // 30% above typical

  for (const axisName of ['roll', 'pitch'] as const) {
    const pids = currentPIDs[axisName];

    // Skip if we already have a P recommendation for this axis
    const existingPRec = recommendations.find((r) => r.setting === `pid_${axisName}_p`);
    if (existingPRec) continue;

    if (pids.P > highPThreshold) {
      recommendations.push({
        setting: `pid_${axisName}_p`,
        currentValue: pids.P,
        recommendedValue: pids.P, // informational — same value
        reason:
          `P-term on ${axisName} (${pids.P}) is higher than typical for this quad size (${bounds.pTypical}). ` +
          'Step response looks fine, but monitor motor temperatures — high P amplifies noise and can cause motor heating.',
        impact: 'both',
        confidence: 'low',
        informational: true,
        ruleId: `P-HI-P-${axisName}`,
      });
    }
  }
}

/**
 * Detect P values significantly below the quad's typical range.
 * Emits an informational (low confidence) recommendation — counterpart to detectHighP.
 * Especially important for micro quads where P=20-25 is dangerously unresponsive.
 */
function detectLowP(
  recommendations: PIDRecommendation[],
  currentPIDs: PIDConfiguration,
  bounds: QuadSizeBounds
): void {
  const lowPThreshold = bounds.pTypical * 0.7; // 30% below typical

  for (const axisName of ['roll', 'pitch'] as const) {
    const pids = currentPIDs[axisName];

    // Skip if we already have a P recommendation for this axis
    const existingPRec = recommendations.find((r) => r.setting === `pid_${axisName}_p`);
    if (existingPRec) continue;

    if (pids.P < lowPThreshold) {
      recommendations.push({
        setting: `pid_${axisName}_p`,
        currentValue: pids.P,
        recommendedValue: pids.P, // informational — same value
        reason:
          `P-term on ${axisName} (${pids.P}) is lower than typical for this quad size (${bounds.pTypical}). ` +
          'The quad may feel sluggish or unresponsive. Consider increasing P for better stick feel.',
        impact: 'response',
        confidence: 'low',
        informational: true,
        ruleId: `P-LO-P-${axisName}`,
      });
    }
  }
}

function validateDampingRatio(
  recommendations: PIDRecommendation[],
  currentPIDs: PIDConfiguration,
  bounds: QuadSizeBounds,
  maxRatio: number = DAMPING_RATIO_MAX
): void {
  for (const axisName of ['roll', 'pitch'] as const) {
    const pids = currentPIDs[axisName];

    // Informational recs (e.g. a DTE-blocked D increase) are not real changes
    const pRec = recommendations.find((r) => r.setting === `pid_${axisName}_p` && !r.informational);
    const dRec = recommendations.find((r) => r.setting === `pid_${axisName}_d` && !r.informational);

    // Compute resulting P and D after applying any recommendations
    const resultP = pRec ? pRec.recommendedValue : pids.P;
    const resultD = dRec ? dRec.recommendedValue : pids.D;

    // Skip if P or D is zero (some setups run D=0)
    if (resultP <= 0 || resultD <= 0) continue;

    const ratio = resultD / resultP;

    if (ratio < DAMPING_RATIO_MIN && !dRec) {
      // Underdamped — need more D relative to P
      const targetD = clamp(Math.round(resultP * DAMPING_RATIO_MIN), bounds.dMin, bounds.dMax);
      if (Math.abs(targetD - pids.D) >= DAMPING_RATIO_DEADZONE) {
        recommendations.push({
          setting: `pid_${axisName}_d`,
          currentValue: pids.D,
          recommendedValue: targetD,
          reason: `D/P ratio on ${axisName} is low (${ratio.toFixed(2)}). Increasing D improves dampening and reduces bounce-back without sacrificing response.`,
          impact: 'stability',
          confidence: 'medium',
          ruleId: `P-DR-UD-${axisName}`,
        });
      }
    } else if (ratio > maxRatio && dRec && !pRec) {
      // D was increased by a rule but P wasn't adjusted — ratio pushed too high
      const targetP = clamp(Math.round(resultD / maxRatio), bounds.pMin, bounds.pMax);
      if (targetP > pids.P && Math.abs(targetP - pids.P) >= DAMPING_RATIO_DEADZONE) {
        recommendations.push({
          setting: `pid_${axisName}_p`,
          currentValue: pids.P,
          recommendedValue: targetP,
          reason: `Adding a small P increase on ${axisName} to maintain healthy D/P balance (${ratio.toFixed(2)}) after the D-term adjustment.`,
          impact: 'response',
          confidence: 'low',
          ruleId: `P-DR-OD-${axisName}`,
        });
      }
    } else if (ratio > maxRatio && dRec && pRec) {
      // Both P and D were adjusted (e.g. P-OS-P + P-OS-D from same overshoot rule)
      // but the combined result exceeds damping ratio.
      // Use the CURRENT P (not reduced P) as anchor to avoid dragging D below its
      // current value. If P was decreased and D was increased, clamping D to
      // (reducedP × 0.85) can produce D < currentD — the opposite of what the
      // overshoot rule intended.
      const anchorP = Math.max(resultP, pids.P);
      const clampedD = clamp(Math.round(anchorP * maxRatio), bounds.dMin, bounds.dMax);
      if (clampedD < pids.D) {
        // Clamped D would be LOWER than current — drop the D rec entirely
        // rather than recommending a counterproductive decrease
        const dIdx = recommendations.indexOf(dRec);
        if (dIdx >= 0) recommendations.splice(dIdx, 1);
      } else if (clampedD !== dRec.recommendedValue) {
        dRec.recommendedValue = clampedD;
        dRec.reason += ` (D clamped from ${resultD} to ${clampedD} to maintain D/P ratio ≤ ${maxRatio}.)`;
        dRec.confidence = 'low';
      }
    } else if (ratio > maxRatio && !dRec && pRec && pRec.recommendedValue < pids.P) {
      // P was decreased (e.g. overshoot rule) but D wasn't adjusted
      // (e.g. blocked by D-term effectiveness gating) — ratio pushed too high.
      // Only triggers on P decrease — P increase would lower the ratio, not raise it.
      const targetD = clamp(Math.round(resultP * maxRatio), bounds.dMin, bounds.dMax);
      if (targetD < pids.D && Math.abs(targetD - pids.D) >= DAMPING_RATIO_DEADZONE) {
        recommendations.push({
          setting: `pid_${axisName}_d`,
          currentValue: pids.D,
          recommendedValue: targetD,
          reason: `Reducing D on ${axisName} to maintain healthy D/P balance (${ratio.toFixed(2)}) after P reduction. High D/P ratio causes sluggish response and motor heating.`,
          impact: 'both',
          confidence: 'medium',
          ruleId: `P-DR-OD-${axisName}`,
        });
      }
    } else if (ratio > maxRatio && !dRec && !pRec) {
      // No existing recommendations but ratio is already too high — reduce D
      const targetD = clamp(Math.round(resultP * maxRatio), bounds.dMin, bounds.dMax);
      if (Math.abs(targetD - pids.D) >= DAMPING_RATIO_DEADZONE) {
        recommendations.push({
          setting: `pid_${axisName}_d`,
          currentValue: pids.D,
          recommendedValue: targetD,
          reason: `D/P ratio on ${axisName} is high (${ratio.toFixed(2)}). Reducing D helps with motor temperature and noise without losing stability.`,
          impact: 'both',
          confidence: 'medium',
          ruleId: `P-DR-OD-${axisName}`,
        });
      }
    }
  }
}

/**
 * Post-process D recommendations using D-term effectiveness data.
 *
 * Three tiers of D-increase gating:
 * - D ratio > 0.7 (dCritical) → D has headroom, boost confidence to high
 * - D ratio 0.3–0.7 → D increase OK, add caution note about noise cost
 * - D ratio < 0.3 → D is mostly noise, redirect to "improve filters first"
 *
 * For D decreases: annotate when D effectiveness is low.
 */
function applyDTermEffectiveness(
  recommendations: PIDRecommendation[],
  dte: DTermEffectiveness
): void {
  // Iterate backwards so we can splice without index issues
  for (let i = recommendations.length - 1; i >= 0; i--) {
    const rec = recommendations[i];
    if (!rec.setting.includes('_d')) continue;
    if (rec.informational) continue; // already-blocked or advisory recs — nothing to gate

    const isIncrease = rec.recommendedValue > rec.currentValue;

    if (isIncrease) {
      if (dte.dCritical) {
        // D is highly effective — safe to increase
        rec.confidence = 'high';
      } else if (dte.overall < 0.3) {
        // D is mostly amplifying noise — BLOCK the increase and tell the
        // pilot why (KB §6: redirect to "improve filters first"). Without the
        // informational rec the D change would silently vanish and the pilot
        // would get no guidance at all.
        recommendations.splice(i, 1, {
          setting: rec.setting,
          currentValue: rec.currentValue,
          recommendedValue: rec.currentValue, // informational — same value
          reason:
            `A D increase was considered for this axis, but D-term effectiveness is very low ` +
            `(${(dte.overall * 100).toFixed(0)}%) — most of D's output is amplified noise, so more D ` +
            'would mainly heat motors. Improve filtering first (run a Filter Tune), then revisit D.',
          impact: 'stability',
          confidence: 'low',
          informational: true,
          ruleId: `P-DTE-BLOCK-${rec.setting}`,
        });
      } else {
        // Balanced range — allow increase but warn about noise cost
        rec.reason += ` D-term effectiveness is moderate (${(dte.overall * 100).toFixed(0)}%) — monitor motor temperatures after applying.`;
      }
    } else {
      // D decrease
      if (dte.overall < 0.3) {
        rec.reason += ' D-term effectiveness is low — D may not be doing much dampening work.';
      }
    }
  }
}

/** Prop wash severity thresholds for recommendation integration */
const PROPWASH_MODERATE_THRESHOLD = 2.0;
const PROPWASH_SEVERE_THRESHOLD = 5.0;

/**
 * Post-process recommendations with prop wash context.
 *
 * - Severe prop wash + existing D increase → boost confidence
 * - Severe prop wash + no D recommendation → suggest D increase on worst axis
 * - Prop wash concentrated on one axis → flag asymmetric issue
 */
function applyPropWashContext(
  recommendations: PIDRecommendation[],
  pw: PropWashAnalysis,
  currentPIDs: PIDConfiguration,
  flightPIDs?: PIDConfiguration,
  bounds: QuadSizeBounds = DEFAULT_QUAD_SIZE_BOUNDS
): void {
  if (pw.events.length < 3 || pw.meanSeverity < PROPWASH_MODERATE_THRESHOLD) return;

  const isSevere = pw.meanSeverity >= PROPWASH_SEVERE_THRESHOLD;
  const worstAxis = pw.worstAxis;

  // Boost confidence on existing D increase for worst axis
  const existingDRec = recommendations.find(
    (r) => r.setting === `pid_${worstAxis}_d` && r.recommendedValue > r.currentValue
  );

  if (existingDRec) {
    if (isSevere) {
      existingDRec.confidence = 'high';
      existingDRec.reason += ` Prop wash is severe on ${worstAxis} (${pw.meanSeverity.toFixed(1)}× baseline at ~${Math.round(pw.dominantFrequencyHz)} Hz) — D increase will help.`;
    }
    return;
  }

  // No D recommendation exists for worst axis — suggest one if prop wash is severe
  if (isSevere) {
    const pids = currentPIDs[worstAxis];
    const base = flightPIDs ? flightPIDs[worstAxis] : pids;
    const targetD = clamp(base.D + 5, bounds.dMin, bounds.dMax);
    if (targetD !== pids.D) {
      recommendations.push({
        setting: `pid_${worstAxis}_d`,
        currentValue: pids.D,
        recommendedValue: targetD,
        reason:
          `Severe prop wash detected on ${worstAxis} (${pw.meanSeverity.toFixed(1)}× baseline at ~${Math.round(pw.dominantFrequencyHz)} Hz). ` +
          'Increasing D-term will help dampen the oscillation during descents.',
        impact: 'stability',
        confidence: 'medium',
        ruleId: `P-PW-D-${worstAxis}`,
      });
    }
  }
}

/**
 * Propwash-aware d_min recommendations.
 *
 * When propwash is severe, d_min settings can be optimized to allow
 * faster D ramp-up during propwash events (descents, power loops).
 *
 * Three rules:
 * - PW-DMIN-GAIN: Increase d_min_gain for faster D boost during propwash
 * - PW-DMIN-GAP: Widen d_min/d_max gap for more propwash headroom
 * - PW-DMIN-ENABLE: Enable d_min when it's disabled and propwash is severe
 */
export function recommendPropWashDMin(
  propWash: PropWashAnalysis | undefined,
  dMinContext: DMinContext | undefined,
  flightPIDs: PIDConfiguration | undefined,
  droneSize?: DroneSize,
  flightStyle: FlightStyle = 'balanced'
): PIDRecommendation[] {
  const recs: PIDRecommendation[] = [];
  if (!dMinContext) return recs;

  const isSevere = propWash ? propWash.meanSeverity >= PROPWASH_SEVERITY_SEVERE : false;

  // Rule PW-DMIN-GAIN: If propwash severe AND d_min active AND gain is low → increase
  if (isSevere && propWash && dMinContext.active && dMinContext.gain !== undefined) {
    const sizeProfile = droneSize ? DMIN_BY_SIZE[droneSize] : undefined;
    // Style-aware gain: smooth pilots get lower target, aggressive pilots get higher
    const targetGain =
      sizeProfile?.gainByStyle?.[flightStyle] ?? sizeProfile?.gain ?? DMIN_GAIN_FREESTYLE;
    if (dMinContext.gain < DMIN_GAIN_FREESTYLE && targetGain > (dMinContext.gain ?? 0)) {
      recs.push({
        setting: 'd_min_gain',
        currentValue: dMinContext.gain,
        recommendedValue: targetGain,
        reason:
          `Severe prop wash detected (${propWash.meanSeverity.toFixed(1)}× baseline). ` +
          `D-min gain is ${dMinContext.gain} — increasing to ${targetGain} allows faster D ramp-up during propwash events, ` +
          'helping the quad recover more quickly from descents and power loops.',
        impact: 'stability',
        confidence: 'medium',
        ruleId: 'PW-DMIN-GAIN',
      });
    }
  }

  // Rule PW-DMIN-GAP: If d_min active AND gap too narrow → recommend widening
  if (dMinContext.active && flightPIDs) {
    for (const axis of ['roll', 'pitch'] as const) {
      const dMinValue = dMinContext[axis];
      const dMax = flightPIDs[axis].D;
      if (dMinValue === undefined || dMax <= 0) continue;

      const gap = (dMax - dMinValue) / dMax;
      if (gap < DMIN_GAP_MIN_FRACTION) {
        const targetDMin = clamp(Math.round(dMax * 0.7), 0, dMax);
        if (targetDMin !== dMinValue) {
          recs.push({
            setting: `d_min_${axis}`,
            currentValue: dMinValue,
            recommendedValue: targetDMin,
            reason:
              `D-min on ${axis} is ${dMinValue} with D-max ${dMax} (gap ${Math.round(gap * 100)}%). ` +
              `This leaves little headroom for propwash D boost. Lowering d_min to ${targetDMin} ` +
              '(30% below D-max) gives more room for the D-term to ramp up during propwash events.',
            impact: 'stability',
            confidence: 'low',
            ruleId: 'PW-DMIN-GAP',
          });
        }
      }
    }
  }

  // Rule PW-DMIN-ENABLE: If propwash severe AND d_min is disabled → recommend enabling
  if (isSevere && propWash && !dMinContext.active && flightPIDs) {
    for (const axis of ['roll', 'pitch'] as const) {
      const dMax = flightPIDs[axis].D;
      if (dMax <= 0) continue;

      const targetDMin = clamp(Math.round(dMax * 0.7), 0, dMax);
      recs.push({
        setting: `d_min_${axis}`,
        currentValue: 0,
        recommendedValue: targetDMin,
        reason:
          `Severe prop wash detected (${propWash.meanSeverity.toFixed(1)}× baseline) but d_min is disabled. ` +
          `Enabling d_min on ${axis} at ${targetDMin} (70% of D-max ${dMax}) allows the D-term to run lower ` +
          'during normal flight while ramping up during propwash events for better oscillation control.',
        impact: 'stability',
        confidence: 'low',
        ruleId: 'PW-DMIN-ENABLE',
      });
    }
  }

  return recs;
}

/**
 * Generate a beginner-friendly summary of the PID analysis.
 */
const STYLE_CONTEXT: Record<FlightStyle, string> = {
  smooth: 'for smooth flying preferences',
  balanced: '',
  aggressive: 'optimized for racing response',
};

export function generatePIDSummary(
  roll: AxisStepProfile,
  pitch: AxisStepProfile,
  yaw: AxisStepProfile,
  recommendations: PIDRecommendation[],
  flightStyle: FlightStyle = 'balanced'
): string {
  const totalSteps = roll.responses.length + pitch.responses.length + yaw.responses.length;
  const styleContext = STYLE_CONTEXT[flightStyle];
  const styleNote = styleContext ? ` ${styleContext}` : '';

  if (totalSteps === 0) {
    return 'No step inputs detected in this flight. Try flying with quick, decisive stick movements for better PID analysis.';
  }

  if (recommendations.length === 0) {
    return `Analyzed ${totalSteps} stick inputs${styleNote}. Your PID tune looks good — response is quick with minimal overshoot. No changes recommended.`;
  }

  const hasOvershoot = recommendations.some(
    (r) => r.reason.includes('overshoot') || r.reason.includes('Overshoot')
  );
  const hasSluggish = recommendations.some(
    (r) => r.reason.includes('sluggish') || r.reason.includes('Sluggish')
  );
  const hasRinging = recommendations.some(
    (r) => r.reason.includes('scillation') || r.reason.includes('wobble')
  );
  const hasTracking = recommendations.some(
    (r) => r.reason.includes('drifts') || r.reason.includes('I-term')
  );

  const issues: string[] = [];
  if (hasOvershoot) issues.push('overshoot');
  if (hasSluggish) issues.push('sluggish response');
  if (hasRinging) issues.push('oscillation');
  if (hasTracking) issues.push('tracking drift');

  const issueText = issues.length > 0 ? issues.join(' and ') : 'room for improvement';

  return `Analyzed ${totalSteps} stick inputs${styleNote} and found ${issueText}. ${recommendations.length} adjustment${recommendations.length === 1 ? '' : 's'} recommended — apply them for a tighter, more locked-in feel.`;
}

/**
 * Extract flight-time PIDs from a BBL log header.
 * Betaflight logs PIDs as "rollPID" → "P,I,D" (e.g. "45,80,30").
 * Returns undefined if any axis PID is missing from the header.
 */
export function extractFlightPIDs(rawHeaders: Map<string, string>): PIDConfiguration | undefined {
  const rollPID = rawHeaders.get('rollPID');
  const pitchPID = rawHeaders.get('pitchPID');
  const yawPID = rawHeaders.get('yawPID');

  if (!rollPID || !pitchPID || !yawPID) return undefined;

  const parse = (s: string): { P: number; I: number; D: number } => {
    const parts = s.split(',').map(Number);
    return { P: parts[0] || 0, I: parts[1] || 0, D: parts[2] || 0 };
  };

  return { roll: parse(rollPID), pitch: parse(pitchPID), yaw: parse(yawPID) };
}

/**
 * Extract feedforward context from BBL raw headers.
 *
 * BF 4.3+ logs feedforward parameters in the blackbox header.
 * FF is considered "active" when boost > 0 (BF default is 15).
 * Missing headers are treated as FF inactive (graceful fallback for older FW).
 */
export function extractFeedforwardContext(rawHeaders: Map<string, string>): FeedforwardContext {
  const boost = parseIntOr(rawHeaders.get('feedforward_boost'));
  const maxRateLimit = parseIntOr(rawHeaders.get('feedforward_max_rate_limit'));
  const smoothFactor = parseIntOr(rawHeaders.get('feedforward_smooth_factor'));
  const jitterFactor = parseIntOr(rawHeaders.get('feedforward_jitter_factor'));
  const averaging = parseIntOr(rawHeaders.get('feedforward_averaging'));
  const rcSmoothingAutoFactor = parseIntOr(rawHeaders.get('rc_smoothing_auto_factor'));

  // Extract RC link rate from headers
  const rcSmoothingInputHz = parseIntOr(rawHeaders.get('rc_smoothing_input_hz'));
  const rcIntervalMs = parseIntOr(rawHeaders.get('rcIntervalMs'));
  const rcLinkRateHz =
    rcSmoothingInputHz !== undefined && rcSmoothingInputHz > 0
      ? rcSmoothingInputHz
      : rcIntervalMs !== undefined && rcIntervalMs > 0
        ? Math.round(1000 / rcIntervalMs)
        : undefined;

  const active = (boost ?? 0) > 0;

  return {
    active,
    ...(boost !== undefined ? { boost } : {}),
    ...(maxRateLimit !== undefined ? { maxRateLimit } : {}),
    ...(smoothFactor !== undefined ? { smoothFactor } : {}),
    ...(jitterFactor !== undefined ? { jitterFactor } : {}),
    ...(averaging !== undefined ? { averaging } : {}),
    ...(rcLinkRateHz !== undefined ? { rcLinkRateHz } : {}),
    ...(rcSmoothingAutoFactor !== undefined ? { rcSmoothingAutoFactor } : {}),
  };
}

/**
 * Extract D-min context from BBL raw headers (BF 4.3+).
 *
 * When d_min is active (d_min_roll/pitch > 0), the D value in PID config
 * represents d_max. The actual D varies between d_min and d_max based on
 * stick input. FPVPIDlab's D recommendations target d_max only.
 */
export interface DMinContext {
  active: boolean;
  roll?: number;
  pitch?: number;
  yaw?: number;
  /** d_min_boost_gain — how fast D ramps up during propwash/stick input (BF default 20) */
  gain?: number;
}

export function extractDMinContext(rawHeaders: Map<string, string>): DMinContext {
  // BF BBL writes d_min as CSV: "H d_min:30,34,0" (roll,pitch,yaw)
  // and gain/advance as: "H d_max_gain:37", "H d_max_advance:20"
  let dMinRoll: number | undefined;
  let dMinPitch: number | undefined;
  let dMinYaw: number | undefined;

  const dMinCsv = rawHeaders.get('d_min');
  if (dMinCsv) {
    const parts = dMinCsv.split(',').map((s) => parseInt(s.trim(), 10));
    if (parts.length >= 3 && parts.every((n) => !isNaN(n))) {
      dMinRoll = parts[0];
      dMinPitch = parts[1];
      dMinYaw = parts[2];
    }
  }

  // Fallback: try individual headers (used by demo data / older formats)
  if (dMinRoll === undefined) dMinRoll = parseIntOr(rawHeaders.get('d_min_roll'));
  if (dMinPitch === undefined) dMinPitch = parseIntOr(rawHeaders.get('d_min_pitch'));
  if (dMinYaw === undefined) dMinYaw = parseIntOr(rawHeaders.get('d_min_yaw'));

  // BF uses "d_max_gain" and "d_max_advance" (not "d_min_gain")
  const dMinGain =
    parseIntOr(rawHeaders.get('d_max_gain')) ?? parseIntOr(rawHeaders.get('d_min_gain'));
  const active = (dMinRoll ?? 0) > 0 || (dMinPitch ?? 0) > 0;

  return {
    active,
    ...(dMinRoll !== undefined ? { roll: dMinRoll } : {}),
    ...(dMinPitch !== undefined ? { pitch: dMinPitch } : {}),
    ...(dMinYaw !== undefined ? { yaw: dMinYaw } : {}),
    ...(dMinGain !== undefined ? { gain: dMinGain } : {}),
  };
}

/**
 * Extract TPA (Throttle PID Attenuation) context from BBL raw headers.
 *
 * TPA attenuates D (and optionally P) at high throttle. When active,
 * step responses at high throttle may show less damping than the configured
 * D value suggests, because effective D is reduced.
 */
export interface TPAContext {
  active: boolean;
  rate?: number; // 0-250, amount of attenuation
  breakpoint?: number; // throttle value where TPA starts (0-2000)
  mode?: number; // 0 = D-only, 1 = PD
  /** BF 4.5+ low-throttle TPA fields (undefined when FW doesn't support them) */
  lowRate?: number; // 0-100
  lowBreakpoint?: number; // 0-2000
  lowAlways?: number; // 0 = OFF, 1 = ON
}

export function extractTPAContext(rawHeaders: Map<string, string>): TPAContext {
  const tpaRate = parseIntOr(rawHeaders.get('tpa_rate'));
  const tpaBreakpoint = parseIntOr(rawHeaders.get('tpa_breakpoint'));
  const tpaMode = parseIntOr(rawHeaders.get('tpa_mode'));
  const tpaLowRate = parseIntOr(rawHeaders.get('tpa_low_rate'));
  const tpaLowBreakpoint = parseIntOr(rawHeaders.get('tpa_low_breakpoint'));
  const tpaLowAlways = parseIntOr(rawHeaders.get('tpa_low_always'));
  const active = (tpaRate ?? 0) > 0;

  return {
    active,
    ...(tpaRate !== undefined ? { rate: tpaRate } : {}),
    ...(tpaBreakpoint !== undefined ? { breakpoint: tpaBreakpoint } : {}),
    ...(tpaMode !== undefined ? { mode: tpaMode } : {}),
    ...(tpaLowRate !== undefined ? { lowRate: tpaLowRate } : {}),
    ...(tpaLowBreakpoint !== undefined ? { lowBreakpoint: tpaLowBreakpoint } : {}),
    ...(tpaLowAlways !== undefined ? { lowAlways: tpaLowAlways } : {}),
  };
}

/** Parse an integer from a string, returning undefined if missing or NaN. */
function parseIntOr(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? undefined : n;
}

// ---- Frequency-domain recommendation thresholds ----

/** Phase margin threshold below which we consider the system under-damped */
const PHASE_MARGIN_LOW_DEG = 45;

/** Phase margin threshold below which we consider the system critically under-damped */
const PHASE_MARGIN_CRITICAL_DEG = 30;

/** Minimum stick-band coherence for TF-derived gain recommendations.
 * Below this the transfer function estimate is dominated by noise/disturbance
 * rather than commanded motion, so TF-1..TF-4 must not fire for the axis. */
const TF_COHERENCE_GATE = 0.5;

/**
 * Generate PID recommendations from transfer function metrics (frequency domain).
 *
 * Used when Wiener deconvolution produces TF metrics but no step responses exist.
 * Bandwidth indicates responsiveness (P), phase margin indicates damping (D).
 */
function generateFrequencyDomainRecs(
  tf: TransferFunctionMetrics,
  axisName: string,
  pids: { P: number; I: number; D: number },
  base: { P: number; I: number; D: number },
  thresholds: (typeof PID_STYLE_THRESHOLDS)[FlightStyle],
  recommendations: PIDRecommendation[],
  bounds: QuadSizeBounds = DEFAULT_QUAD_SIZE_BOUNDS,
  flightStyle: FlightStyle = 'balanced'
): void {
  // Coherence gate: when the setpoint→gyro coherence in the stick-input band
  // is too low, the transfer function for this axis is not trustworthy enough
  // to drive gain changes — skip all TF rules (the data quality scorer already
  // emits a low_coherence warning for the axis).
  if (tf.coherenceMean !== undefined && tf.coherenceMean < TF_COHERENCE_GATE) {
    return;
  }

  const isYaw = axisName === 'yaw';
  const overshootThreshold = isYaw ? thresholds.overshootMax * 1.5 : thresholds.overshootMax;
  const moderateOvershoot = isYaw ? thresholds.overshootMax : thresholds.moderateOvershoot;
  const bandwidthLowBase = BANDWIDTH_LOW_HZ_BY_STYLE[flightStyle];
  const bandwidthLow = isYaw ? bandwidthLowBase * 0.7 : bandwidthLowBase;

  // Rule TF-1: Low phase margin → increase D (under-damped system)
  if (tf.phaseMarginDeg < PHASE_MARGIN_LOW_DEG && tf.phaseMarginDeg > 0) {
    const dStep = tf.phaseMarginDeg < PHASE_MARGIN_CRITICAL_DEG ? 10 : 5;
    const targetD = clamp(base.D + dStep, bounds.dMin, bounds.dMax);
    if (targetD !== pids.D) {
      recommendations.push({
        setting: `pid_${axisName}_d`,
        currentValue: pids.D,
        recommendedValue: targetD,
        reason: `Transfer function shows low phase margin on ${axisName} (${Math.round(tf.phaseMarginDeg)}°). Increasing D-term adds damping to prevent oscillation.`,
        impact: 'stability',
        confidence: 'medium',
        ruleId: `TF-1-D-${axisName}`,
      });
    }
  }

  // Rule TF-2: Overshoot from synthetic step response
  if (tf.overshootPercent > overshootThreshold) {
    const severity = tf.overshootPercent / overshootThreshold;
    const dStep = severity > 4 ? 15 : severity > 2 ? 10 : 5;
    const existingDRec = recommendations.find((r) => r.setting === `pid_${axisName}_d`);
    if (!existingDRec) {
      const targetD = clamp(base.D + dStep, bounds.dMin, bounds.dMax);
      if (targetD !== pids.D) {
        recommendations.push({
          setting: `pid_${axisName}_d`,
          currentValue: pids.D,
          recommendedValue: targetD,
          reason: `Synthetic step response shows ${Math.round(tf.overshootPercent)}% overshoot on ${axisName}. Increasing D-term will dampen the response.`,
          impact: 'both',
          confidence: 'medium',
          ruleId: `TF-2-D-${axisName}`,
        });
      }
    }
    // Reduce P for extreme overshoot
    if (severity > 2 || base.D >= bounds.dMax * 0.6) {
      const pStep = severity > 4 ? 10 : 5;
      const targetP = clamp(base.P - pStep, bounds.pMin, bounds.pMax);
      if (targetP !== pids.P) {
        recommendations.push({
          setting: `pid_${axisName}_p`,
          currentValue: pids.P,
          recommendedValue: targetP,
          reason: `High overshoot on ${axisName} (${Math.round(tf.overshootPercent)}%) from transfer function analysis. Reducing P-term helps prevent overshooting.`,
          impact: 'both',
          confidence: 'medium',
          ruleId: `TF-2-P-${axisName}`,
        });
      }
    }
  } else if (tf.overshootPercent > moderateOvershoot) {
    // Moderate overshoot
    const existingDRec = recommendations.find((r) => r.setting === `pid_${axisName}_d`);
    if (!existingDRec) {
      const targetD = clamp(base.D + 5, bounds.dMin, bounds.dMax);
      if (targetD !== pids.D) {
        recommendations.push({
          setting: `pid_${axisName}_d`,
          currentValue: pids.D,
          recommendedValue: targetD,
          reason: `Transfer function indicates moderate overshoot on ${axisName} (${Math.round(tf.overshootPercent)}%). A D-term increase will improve damping.`,
          impact: 'stability',
          confidence: 'medium',
          ruleId: `TF-2-D-${axisName}`,
        });
      }
    }
  }

  // Rule TF-3: Low bandwidth → increase P (sluggish system)
  if (
    tf.bandwidthHz < bandwidthLow &&
    tf.bandwidthHz > 0 &&
    tf.overshootPercent < thresholds.overshootIdeal
  ) {
    const targetP = clamp(base.P + 5, bounds.pMin, bounds.pMax);
    if (targetP !== pids.P) {
      const existingPRec = recommendations.find((r) => r.setting === `pid_${axisName}_p`);
      if (!existingPRec) {
        recommendations.push({
          setting: `pid_${axisName}_p`,
          currentValue: pids.P,
          recommendedValue: targetP,
          reason: `Low bandwidth on ${axisName} (${Math.round(tf.bandwidthHz)} Hz) suggests sluggish response. Increasing P-term will improve responsiveness.`,
          impact: 'response',
          confidence: 'medium',
          ruleId: `TF-3-P-${axisName}`,
        });
      }
    }
  }

  // Rule TF-4: DC gain deficit → I-term too low (poor steady-state tracking).
  // Style-aware, consistent with the step-response SSE rule: a DC gain of
  // 20·log10(1 − sse/100) dB corresponds to the style's steady-state error limit
  // (e.g. 5% balanced → −0.45 dB), so both I-term paths trigger at the same error.
  // Floored at −0.4 dB: the Wiener DC-gain estimate from hover data carries
  // ~±0.3 dB noise, and a tighter threshold (aggressive style → −0.26 dB) would
  // fire persistently on well-tuned quads and ratchet I upward every session.
  const TF4_MIN_THRESHOLD_DB = -0.4;
  const dcGainThresholdDb = Math.min(
    20 * Math.log10(1 - thresholds.steadyStateErrorMax / 100),
    TF4_MIN_THRESHOLD_DB
  );
  if (tf.dcGainDb < dcGainThresholdDb) {
    const deficit = Math.abs(tf.dcGainDb);
    // +10 at 2× the style threshold (mirrors the step-response rule's 2× escalation)
    const iStep = deficit > 2 * Math.abs(dcGainThresholdDb) ? 10 : 5;
    const targetI = clamp(base.I + iStep, bounds.iMin, bounds.iMax);
    if (targetI !== pids.I) {
      const existingIRec = recommendations.find((r) => r.setting === `pid_${axisName}_i`);
      if (!existingIRec) {
        recommendations.push({
          setting: `pid_${axisName}_i`,
          currentValue: pids.I,
          recommendedValue: targetI,
          reason:
            `DC gain on ${axisName} is ${tf.dcGainDb.toFixed(1)} dB (below 0 dB), ` +
            'indicating the system does not fully track the target at steady state. ' +
            'Increasing I-term improves long-term tracking accuracy.',
          impact: 'response',
          confidence: deficit > 2 * Math.abs(dcGainThresholdDb) ? 'medium' : 'low',
          ruleId: `TF-4-I-${axisName}`,
        });
      }
    }
  }
}

/**
 * Annotate D recommendations when D-min/D-max is active, and recommend
 * disabling simplified_dmax_gain for predictable tuning convergence.
 *
 * D-max adds unpredictability: the actual D value varies between d_min and
 * d_max based on stick input, making it harder for iterative tuning to converge.
 * Community consensus (SupaflyFPV, UAV Tech) is to disable D-max for <=5" quads.
 * For 6-7", opinions are mixed — some LR builds benefit from adaptive D.
 *
 * FPVPIDlab adjusts the D value (d_max in BF terms); d_min is separate.
 */
function applyDMinAdvisory(
  recommendations: PIDRecommendation[],
  dMin: DMinContext,
  droneSize?: DroneSize
): void {
  // Annotate existing D recommendations with D-min context
  for (const rec of recommendations) {
    if (!rec.setting.includes('_d')) continue;

    const axis = rec.setting.includes('roll')
      ? 'roll'
      : rec.setting.includes('pitch')
        ? 'pitch'
        : 'yaw';
    const dMinValue = dMin[axis as keyof Pick<DMinContext, 'roll' | 'pitch' | 'yaw'>];
    if (dMinValue && dMinValue > 0) {
      rec.reason += ` Note: D-min is active on ${axis} (d_min=${dMinValue}). This change adjusts the maximum D value — D-min may also need adjustment for consistent feel.`;
    }
  }

  // Emit D-max disable recommendation (once, not per-axis)
  const isLargeQuad = droneSize === '6"' || droneSize === '7"';
  if (isLargeQuad) {
    // For 6-7": informational only (mixed community opinion)
    recommendations.push({
      setting: 'simplified_dmax_gain',
      currentValue: 1, // D-max is effectively active (d_min < d_max)
      recommendedValue: 1, // informational — no change suggested
      reason:
        'D-max is active (d_min < d_max). For larger quads, some pilots keep D-max for ' +
        'efficiency during cruise, while others disable it for predictable tuning. ' +
        'Consider disabling (simplified_dmax_gain = 0) if your tune feels inconsistent.',
      impact: 'stability',
      confidence: 'low',
      informational: true,
      ruleId: 'P-DMAX-INFO',
    });
  } else {
    // For <=5" and whoops: suggest disabling — advisory only. Auto-applying
    // would silently flip a simplified-tuning slider off; the pilot decides.
    recommendations.push({
      setting: 'simplified_dmax_gain',
      currentValue: 1, // D-max is effectively active
      recommendedValue: 0,
      reason:
        'D-max is active (d_min < d_max), which makes the actual D value vary with stick input. ' +
        'This adds unpredictability to tuning — each analysis flight sees different effective D. ' +
        'Disabling D-max (simplified_dmax_gain = 0) gives consistent D for faster tune convergence.',
      impact: 'stability',
      confidence: 'low',
      informational: true,
      ruleId: 'P-DMAX-INFO',
    });
  }
}

/**
 * Annotate D recommendations when TPA is active.
 * TPA reduces effective D at high throttle, which may affect step response analysis.
 */
function applyTPAAdvisory(recommendations: PIDRecommendation[], tpa: TPAContext): void {
  if (!tpa.rate || tpa.rate === 0) return;

  for (const rec of recommendations) {
    if (!rec.setting.includes('_d') || rec.recommendedValue <= rec.currentValue) continue;

    rec.reason += ` Note: TPA is active (${tpa.rate}% attenuation above ${tpa.breakpoint ?? 1350}). Effective D is reduced at high throttle — step responses from high-throttle maneuvers may show less damping than the configured D value.`;
  }
}

/**
 * Extract iterm_relax_cutoff from BBL raw headers.
 * Returns undefined if the header is not present.
 */
export function extractItermRelaxCutoff(rawHeaders: Map<string, string>): number | undefined {
  return parseIntOr(rawHeaders.get('iterm_relax_cutoff'));
}

/**
 * Extract iterm_relax mode from BBL raw headers.
 * Returns undefined if the header is not present.
 * Values: 0=OFF, 1=RP, 2=RPY, 3=SETPOINT
 */
export function extractItermRelaxMode(rawHeaders: Map<string, string>): number | undefined {
  return parseIntOr(rawHeaders.get('iterm_relax'));
}

/**
 * Recommend iterm_relax_cutoff based on flight style, current value, and propwash data.
 *
 * Returns an informational recommendation when the current cutoff is >50%
 * away from the style-appropriate typical value. The recommendation is
 * advisory — the user decides whether to apply.
 *
 * When propwash is severe, propwash-specific cutoff reduction takes precedence
 * over style-based recommendations.
 *
 * When propwash is detected and iterm_relax is disabled, recommends enabling it.
 */
export function recommendItermRelaxCutoff(
  currentCutoff: number | undefined,
  flightStyle: FlightStyle,
  propWash?: PropWashAnalysis,
  itermRelaxMode?: number
): PIDRecommendation | undefined {
  // Rule PW-IRELAX-ENABLE: propwash detected + iterm_relax disabled → enable
  if (
    itermRelaxMode !== undefined &&
    itermRelaxMode === 0 &&
    propWash &&
    propWash.meanSeverity >= PROPWASH_SEVERITY_MINIMAL
  ) {
    return {
      setting: 'iterm_relax',
      currentValue: 0,
      recommendedValue: 1,
      reason:
        `Prop wash detected (${propWash.meanSeverity.toFixed(1)}× baseline) but iterm_relax is disabled. ` +
        'Enabling iterm_relax suppresses I-term windup during quick maneuvers, ' +
        'which is essential for controlling prop wash oscillation during descents.',
      impact: 'stability',
      confidence: 'medium',
      ruleId: 'PW-IRELAX-ENABLE',
    };
  }

  if (currentCutoff === undefined) return undefined;

  // Rule PW-IRELAX-CUTOFF-MOD: moderate propwash (2-5×) + cutoff above moderate floor → lower by 5
  // Floor = 15 for moderate propwash — prevents over-suppression while still reducing bounce-back.
  if (
    propWash &&
    propWash.meanSeverity >= PROPWASH_SEVERITY_MINIMAL &&
    propWash.meanSeverity < PROPWASH_SEVERITY_SEVERE &&
    currentCutoff > PROPWASH_IRELAX_CUTOFF_FLOOR
  ) {
    const floor = PROPWASH_IRELAX_CUTOFF_FLOOR;
    const targetCutoff = Math.max(floor, currentCutoff - PROPWASH_IRELAX_CUTOFF_REDUCTION);
    if (targetCutoff < currentCutoff) {
      return {
        setting: 'iterm_relax_cutoff',
        currentValue: currentCutoff,
        recommendedValue: targetCutoff,
        reason:
          `Moderate prop wash detected (${propWash.meanSeverity.toFixed(1)}× baseline) and iterm_relax_cutoff is ${currentCutoff}. ` +
          `Lowering to ${targetCutoff} slightly increases I-term suppression during descents, ` +
          'helping reduce mild oscillation without sacrificing too much tracking accuracy.',
        impact: 'stability',
        confidence: 'low',
        ruleId: 'PW-IRELAX-CUTOFF-MOD',
      };
    }
  }

  // Rule PW-IRELAX-CUTOFF: propwash severe (≥5×) + cutoff above floor → lower cutoff by 5
  // Floor = 7 for severe propwash (PROPWASH_IRELAX_CUTOFF_FLOOR_SEVERE), per community
  // guidance "reduce 15 → 10 → 7".
  if (
    propWash &&
    propWash.meanSeverity >= PROPWASH_SEVERITY_SEVERE &&
    currentCutoff > PROPWASH_IRELAX_CUTOFF_FLOOR_SEVERE
  ) {
    const floor = PROPWASH_IRELAX_CUTOFF_FLOOR_SEVERE;
    const targetCutoff = Math.max(floor, currentCutoff - PROPWASH_IRELAX_CUTOFF_REDUCTION);
    if (targetCutoff < currentCutoff) {
      return {
        setting: 'iterm_relax_cutoff',
        currentValue: currentCutoff,
        recommendedValue: targetCutoff,
        reason:
          `Severe prop wash detected (${propWash.meanSeverity.toFixed(1)}× baseline) and iterm_relax_cutoff is ${currentCutoff}. ` +
          `Lowering to ${targetCutoff} increases I-term suppression during prop wash events, ` +
          'reducing the oscillation that occurs during descents and power loops.',
        impact: 'stability',
        confidence: 'medium',
        ruleId: 'PW-IRELAX-CUTOFF',
      };
    }
  }

  // Original style-based recommendation
  const range = ITERM_RELAX_CUTOFF_BY_STYLE[flightStyle];
  const deviation = Math.abs(currentCutoff - range.typical) / range.typical;

  if (deviation <= ITERM_RELAX_DEVIATION_THRESHOLD) return undefined;

  const styleName =
    flightStyle === 'smooth' ? 'cinematic' : flightStyle === 'aggressive' ? 'racing' : 'freestyle';

  return {
    setting: 'iterm_relax_cutoff',
    currentValue: currentCutoff,
    recommendedValue: range.typical,
    reason:
      `I-term relax cutoff is ${currentCutoff} but typical for ${styleName} flying is ${range.min}-${range.max}. ` +
      (currentCutoff > range.max
        ? 'A lower value gives smoother recovery from flips and rolls.'
        : 'A higher value improves response snappiness during quick maneuvers.'),
    impact: 'both',
    confidence: 'medium',
    ruleId: 'P-IRELAX',
  };
}

/**
 * Extract dyn_idle_min_rpm from BBL raw headers.
 * Returns undefined if the header is not present.
 */
export function extractDynIdleMinRpm(rawHeaders: Map<string, string>): number | undefined {
  return parseIntOr(rawHeaders.get('dyn_idle_min_rpm'));
}

/**
 * Extract rpm_filter_harmonics from BBL raw headers.
 * Returns true when RPM filter is active (harmonics > 0).
 */
export function extractRpmFilterActive(rawHeaders: Map<string, string>): boolean {
  const harmonics = parseIntOr(rawHeaders.get('rpm_filter_harmonics'));
  return harmonics !== undefined && harmonics > 0;
}

/**
 * Recommend dyn_idle_min_rpm based on drone size and RPM filter status.
 *
 * Dynamic idle maintains minimum motor RPM for:
 * - Desync prevention on rapid throttle cuts
 * - RPM filter accuracy at low throttle
 * - Better prop wash recovery (motors always spinning)
 *
 * Only recommends when RPM filter is active and dyn_idle is disabled (0).
 * Size-based: smaller quads need higher min RPM (higher KV, faster desync).
 */
export function recommendDynIdleMinRpm(
  currentMinRpm: number | undefined,
  rpmFilterActive: boolean,
  droneSize?: DroneSize
): PIDRecommendation | undefined {
  if (currentMinRpm === undefined) return undefined;

  // Only recommend when RPM filter is active — dynamic idle complements RPM filtering
  if (!rpmFilterActive) return undefined;

  // Only recommend when currently disabled
  if (currentMinRpm !== 0) return undefined;

  const range = droneSize ? DYN_IDLE_MIN_RPM_BY_SIZE[droneSize] : DYN_IDLE_MIN_RPM_DEFAULT;
  const sizeLabel = droneSize ?? '5"';

  return {
    setting: 'dyn_idle_min_rpm',
    currentValue: 0,
    recommendedValue: range.typical,
    reason:
      `Dynamic idle is disabled but RPM filter is active. Setting dyn_idle_min_rpm to ${range.typical} ` +
      `(typical for ${sizeLabel} builds, range ${range.min}-${range.max}) prevents motor desync on ` +
      'throttle cuts and improves RPM filter accuracy at low throttle.',
    impact: 'stability',
    confidence: 'low',
    ruleId: 'P-DYN-IDLE',
  };
}

/**
 * Extract pidsum_limit and pidsum_limit_yaw from BBL raw headers.
 * Returns undefined values if headers are not present.
 */
export function extractPidsumLimits(rawHeaders: Map<string, string>): {
  pidsumLimit?: number;
  pidsumLimitYaw?: number;
} {
  return {
    pidsumLimit: parseIntOr(rawHeaders.get('pidsum_limit')),
    pidsumLimitYaw: parseIntOr(rawHeaders.get('pidsum_limit_yaw')),
  };
}

/**
 * Recommend increasing pidsum_limit and pidsum_limit_yaw for heavy/powerful quads.
 *
 * Only recommends when drone weight > 800g and current limits are at BF defaults
 * (500/400). Higher limits give full PID authority on heavy builds.
 *
 * Returns 0-2 informational recommendations.
 */
export function recommendPidsumLimits(
  pidsumLimit: number | undefined,
  pidsumLimitYaw: number | undefined,
  droneWeightG: number | undefined
): PIDRecommendation[] {
  const recs: PIDRecommendation[] = [];

  if (droneWeightG === undefined || droneWeightG <= PIDSUM_LIMIT_WEIGHT_THRESHOLD_G) return recs;

  if (pidsumLimit !== undefined && pidsumLimit === PIDSUM_LIMIT_DEFAULT) {
    recs.push({
      setting: 'pidsum_limit',
      currentValue: pidsumLimit,
      recommendedValue: PIDSUM_LIMIT_RECOMMENDED,
      reason:
        `PID sum limit is at the default ${PIDSUM_LIMIT_DEFAULT} but your quad weighs ${droneWeightG}g. ` +
        `Increasing to ${PIDSUM_LIMIT_RECOMMENDED} gives the PID controller full authority for heavy/powerful builds, ` +
        'preventing output clipping during aggressive corrections. Apply manually only if your build ' +
        'has thrust headroom — on underpowered heavy quads a higher limit can cause motor saturation and heat.',
      impact: 'response',
      confidence: 'low',
      informational: true,
      ruleId: 'P-PIDLIM',
    });
  }

  if (pidsumLimitYaw !== undefined && pidsumLimitYaw === PIDSUM_LIMIT_YAW_DEFAULT) {
    recs.push({
      setting: 'pidsum_limit_yaw',
      currentValue: pidsumLimitYaw,
      recommendedValue: PIDSUM_LIMIT_YAW_RECOMMENDED,
      reason:
        `Yaw PID sum limit is at the default ${PIDSUM_LIMIT_YAW_DEFAULT} but your quad weighs ${droneWeightG}g. ` +
        `Increasing to ${PIDSUM_LIMIT_YAW_RECOMMENDED} prevents yaw authority clipping on heavy builds. ` +
        'Apply manually only if your build has thrust headroom — a 2.5× yaw limit jump is significant.',
      impact: 'response',
      confidence: 'low',
      informational: true,
      ruleId: 'P-PIDLIM',
    });
  }

  return recs;
}

/**
 * Recommend feedforward_max_rate_limit for racing builds.
 *
 * Racing builds benefit from higher FF rate limit (95-100) for maximum
 * stick response fidelity. Only recommends when current is at default 90
 * and flight style is aggressive.
 */
export function recommendFFMaxRateLimit(
  currentMaxRateLimit: number | undefined,
  flightStyle: FlightStyle
): PIDRecommendation | undefined {
  if (currentMaxRateLimit === undefined) return undefined;
  if (flightStyle !== 'aggressive') return undefined;
  if (currentMaxRateLimit !== FF_MAX_RATE_LIMIT_DEFAULT) return undefined;

  return {
    setting: 'feedforward_max_rate_limit',
    currentValue: currentMaxRateLimit,
    recommendedValue: FF_MAX_RATE_LIMIT_RACE_RECOMMENDED,
    reason:
      `Feedforward max rate limit is at the default ${FF_MAX_RATE_LIMIT_DEFAULT} but your flight style is aggressive. ` +
      `Racing builds benefit from ${FF_MAX_RATE_LIMIT_RACE_RECOMMENDED} for maximum stick response fidelity ` +
      'at high stick rates (used by Karate, ctzsnooze, AOS race presets).',
    impact: 'response',
    confidence: 'low',
    ruleId: 'P-FF-RATELIM',
  };
}

/** Extract anti_gravity_gain from BBL raw headers. */
export function extractAntiGravityGain(rawHeaders: Map<string, string>): number | undefined {
  return parseIntOr(rawHeaders.get('anti_gravity_gain'));
}

/** Recommend anti_gravity_gain based on drone weight and steady-state error. */
export function recommendAntiGravityGain(
  currentGain: number | undefined,
  droneWeight: number | undefined,
  meanSteadyStateErrors: { roll: number; pitch: number }
): PIDRecommendation | undefined {
  if (currentGain === undefined) return undefined;
  if (droneWeight === undefined) return undefined;
  if (droneWeight <= ANTI_GRAVITY_WEIGHT_THRESHOLD_G) return undefined;
  if (currentGain >= ANTI_GRAVITY_LOW_THRESHOLD) return undefined;

  const hasHighSSE =
    meanSteadyStateErrors.roll > ANTI_GRAVITY_SSE_THRESHOLD &&
    meanSteadyStateErrors.pitch > ANTI_GRAVITY_SSE_THRESHOLD;

  const recommended = hasHighSSE ? ANTI_GRAVITY_HEAVY_RECOMMENDED : ANTI_GRAVITY_MEDIUM_RECOMMENDED;

  return {
    setting: 'anti_gravity_gain',
    currentValue: currentGain,
    recommendedValue: recommended,
    reason:
      `Anti-gravity gain is ${currentGain} (default ${ANTI_GRAVITY_GAIN_DEFAULT}) on a ${droneWeight}g build. ` +
      (hasHighSSE
        ? 'Steady-state error is elevated on roll and pitch, suggesting the I-term needs help during throttle transitions. '
        : '') +
      `Heavier quads with cameras benefit from ${recommended} for more stable punch-outs and throttle changes.`,
    impact: 'stability',
    confidence: 'medium',
    ruleId: 'P-AG',
  };
}

/** Extract thrust_linear from BBL raw headers. */
export function extractThrustLinear(rawHeaders: Map<string, string>): number | undefined {
  return parseIntOr(rawHeaders.get('thrust_linear'));
}

/** Recommend thrust_linear based on drone size. */
export function recommendThrustLinear(
  currentValue: number | undefined,
  droneSize: DroneSize | undefined
): PIDRecommendation | undefined {
  if (currentValue === undefined) return undefined;
  if (droneSize === undefined) return undefined;

  const recommended = THRUST_LINEAR_BY_SIZE[droneSize];
  if (recommended === undefined) return undefined;

  if (currentValue === 0) {
    return {
      setting: 'thrust_linear',
      currentValue: 0,
      recommendedValue: recommended,
      reason:
        `Thrust linearization is disabled but recommended at ${recommended} for ${droneSize} builds. ` +
        'It compensates for non-linear motor response at low throttle, giving more consistent feel across the throttle range.',
      impact: 'response',
      confidence: 'low',
      ruleId: 'P-THRUST-LIN',
    };
  }

  const deviation = Math.abs(currentValue - recommended) / recommended;
  if (deviation <= THRUST_LINEAR_DEVIATION_THRESHOLD) return undefined;

  const direction = currentValue > recommended ? 'high' : 'low';
  return {
    setting: 'thrust_linear',
    currentValue,
    recommendedValue: recommended,
    reason:
      `Thrust linearization is ${currentValue} which is ${direction} for a ${droneSize} build (typical: ${recommended}). ` +
      (direction === 'high'
        ? 'Too much linearization can cause twitchy low-throttle behavior.'
        : 'Too little linearization may cause inconsistent throttle response.'),
    impact: 'response',
    confidence: 'low',
    ruleId: 'P-THRUST-LIN',
  };
}

/**
 * Recommend TPA settings based on drone size and noise profile.
 *
 * Generates advisory recommendations for tpa_mode, tpa_rate, tpa_breakpoint,
 * and BF 4.5+ tpa_low_always based on:
 * - Drone size (larger quads need more aggressive TPA)
 * - Throttle-dependent noise severity (from DynamicLowpassAnalysis)
 * - Current TPA settings from BBL headers
 *
 * All recommendations are low confidence and applied via CLI when user clicks Apply.
 * Rule ID: P-TPA
 */
export function recommendTPA(
  tpaContext: TPAContext | undefined,
  droneSize: DroneSize | undefined,
  throttleNoiseIncreaseDeltaDb?: number,
  propWash?: PropWashAnalysis
): PIDRecommendation[] {
  const recs: PIDRecommendation[] = [];
  if (!tpaContext) return recs;

  const sizeCategory = droneSize ? TPA_SIZE_CATEGORY[droneSize] : 'standard';
  const sizeProfile = TPA_BY_SIZE[sizeCategory];
  const sizeLabel = sizeCategory === 'small' ? '1-4"' : sizeCategory === 'large' ? '6-7"' : '5"';
  const pwSevere = propWash && propWash.meanSeverity >= PROPWASH_SEVERITY_SEVERE;

  // ── Propwash-aware TPA rules (take precedence over size-based when severe) ──

  // Rule PW-TPA-MODE: Propwash severe + PD mode → recommend D-only
  // During propwash, we need full D authority. PD mode attenuates both P and D.
  if (pwSevere && tpaContext.mode !== undefined && tpaContext.mode === TPA_MODE_PD) {
    recs.push({
      setting: 'tpa_mode',
      currentValue: tpaContext.mode,
      recommendedValue: TPA_MODE_D_ONLY,
      reason:
        `Severe prop wash detected (${propWash!.meanSeverity.toFixed(1)}× baseline). ` +
        'TPA mode is PD (attenuates both P and D at high throttle). ' +
        'Switching to D-only mode preserves full P authority during climb-out after descents, ' +
        'helping the quad recover from prop wash more effectively.',
      impact: 'stability',
      confidence: 'medium',
      ruleId: 'PW-TPA-MODE',
    });
  }

  // Rule PW-TPA-BREAKPOINT: Propwash severe + breakpoint too low → raise
  if (
    pwSevere &&
    tpaContext.breakpoint !== undefined &&
    tpaContext.breakpoint < PROPWASH_TPA_BREAKPOINT_MIN
  ) {
    recs.push({
      setting: 'tpa_breakpoint',
      currentValue: tpaContext.breakpoint,
      recommendedValue: 1350,
      reason:
        `Severe prop wash detected (${propWash!.meanSeverity.toFixed(1)}× baseline) and TPA breakpoint is ${tpaContext.breakpoint}. ` +
        `A low breakpoint starts D attenuation too early, reducing damping authority during prop wash recovery. ` +
        'Raising to 1350 preserves full D-term through more of the throttle range.',
      impact: 'stability',
      confidence: 'medium',
      ruleId: 'PW-TPA-BREAKPOINT',
    });
  }

  // Rule PW-TPA-RATE: Propwash severe + rate too high → cap at max
  if (pwSevere && tpaContext.rate !== undefined && tpaContext.rate > PROPWASH_TPA_RATE_MAX) {
    recs.push({
      setting: 'tpa_rate',
      currentValue: tpaContext.rate,
      recommendedValue: PROPWASH_TPA_RATE_MAX,
      reason:
        `Severe prop wash detected (${propWash!.meanSeverity.toFixed(1)}× baseline) and TPA rate is ${tpaContext.rate}. ` +
        `High TPA rate reduces D authority at high throttle, weakening prop wash damping. ` +
        `Lowering to ${PROPWASH_TPA_RATE_MAX} preserves enough D-term for effective prop wash control.`,
      impact: 'stability',
      confidence: 'medium',
      ruleId: 'PW-TPA-RATE',
    });
  }

  // ── Size-based TPA rules (skip if propwash already covered the same setting) ──

  // Rule P-TPA-RATE: TPA rate advisory based on drone size
  // Skip if propwash already generated a rate recommendation
  if (tpaContext.rate !== undefined && !recs.find((r) => r.setting === 'tpa_rate')) {
    const deviation = Math.abs(tpaContext.rate - sizeProfile.rate) / sizeProfile.rate;
    if (deviation > TPA_RATE_DEVIATION_THRESHOLD) {
      const direction = tpaContext.rate > sizeProfile.rate ? 'high' : 'low';
      recs.push({
        setting: 'tpa_rate',
        currentValue: tpaContext.rate,
        recommendedValue: sizeProfile.rate,
        reason:
          `TPA rate is ${tpaContext.rate} which is ${direction} for a ${sizeLabel} build (typical: ${sizeProfile.rate}). ` +
          (direction === 'high'
            ? 'Too much TPA can reduce PID authority at high throttle, causing sluggish response during punch-outs.'
            : 'Too little TPA may allow noise-amplified oscillations at high throttle.'),
        impact: 'both',
        confidence: 'low',
        ruleId: 'P-TPA',
      });
    }
  }

  // Rule P-TPA-BP: TPA breakpoint advisory based on drone size
  // Skip if propwash already generated a breakpoint recommendation
  if (tpaContext.breakpoint !== undefined && !recs.find((r) => r.setting === 'tpa_breakpoint')) {
    const bpDeviation =
      Math.abs(tpaContext.breakpoint - sizeProfile.breakpoint) / sizeProfile.breakpoint;
    if (bpDeviation > TPA_RATE_DEVIATION_THRESHOLD) {
      recs.push({
        setting: 'tpa_breakpoint',
        currentValue: tpaContext.breakpoint,
        recommendedValue: sizeProfile.breakpoint,
        reason:
          `TPA breakpoint is ${tpaContext.breakpoint} but typical for ${sizeLabel} builds is ${sizeProfile.breakpoint}. ` +
          (tpaContext.breakpoint > sizeProfile.breakpoint
            ? 'A lower breakpoint starts attenuation earlier, reducing noise at mid-to-high throttle.'
            : 'A higher breakpoint preserves full PID authority through more of the throttle range.'),
        impact: 'both',
        confidence: 'low',
        ruleId: 'P-TPA',
      });
    }
  }

  // Rule P-TPA-MODE: If throttle-dependent noise is severe AND mode is D-only,
  // suggest PD mode (SupaflyFPV pattern for 5" only — 6-7" stays D-only per KB Section 10)
  // Skip if propwash already generated a mode recommendation
  if (
    !recs.find((r) => r.setting === 'tpa_mode') &&
    throttleNoiseIncreaseDeltaDb !== undefined &&
    throttleNoiseIncreaseDeltaDb >= TPA_SEVERE_NOISE_INCREASE_DB &&
    tpaContext.mode !== undefined &&
    tpaContext.mode === TPA_MODE_D_ONLY &&
    sizeCategory === 'standard'
  ) {
    recs.push({
      setting: 'tpa_mode',
      currentValue: tpaContext.mode,
      recommendedValue: TPA_MODE_PD,
      reason:
        `Noise increases ${Math.round(throttleNoiseIncreaseDeltaDb)} dB from low to high throttle. ` +
        'Switching TPA mode from D-only to PD attenuates both P and D at high throttle, ' +
        'reducing noise-driven oscillations more effectively (SupaflyFPV 5" pattern).',
      impact: 'both',
      confidence: 'low',
      ruleId: 'P-TPA',
    });
  }

  // Rule P-TPA-LOW: BF 4.5+ tpa_low_always advisory
  if (tpaContext.lowAlways !== undefined && tpaContext.lowAlways === 0) {
    recs.push({
      setting: 'tpa_low_always',
      currentValue: 0,
      recommendedValue: 1,
      reason:
        'Low-throttle TPA is available (BF 4.5+) but disabled. ' +
        'Enabling tpa_low_always attenuates PID gains at low throttle too, ' +
        'reducing motor noise during descents and idle (SupaflyFPV pattern).',
      impact: 'both',
      confidence: 'low',
      ruleId: 'P-TPA',
    });
  }

  return recs;
}

/**
 * Extract vbat_sag_compensation from BBL raw headers.
 * Returns undefined if the header is not present.
 */
export function extractVbatSagCompensation(rawHeaders: Map<string, string>): number | undefined {
  return parseIntOr(rawHeaders.get('vbat_sag_compensation'));
}

/**
 * Recommend vbat_sag_compensation based on flight style.
 *
 * VBat sag compensation scales PID output based on battery voltage to maintain
 * consistent feel as battery depletes. Recommended 50-100 for freestyle/cinematic,
 * disabled (0) for racing where predictable power curve is preferred.
 *
 * Source: KB §10, community consensus.
 * Rule ID: P-VBAT-SAG, confidence: low (advisory)
 */
export function recommendVbatSagCompensation(
  currentValue: number | undefined,
  flightStyle: FlightStyle
): PIDRecommendation | undefined {
  if (currentValue === undefined) return undefined;

  // Only recommend when currently disabled
  if (currentValue !== 0) return undefined;

  // Racing pilots prefer predictable power curve (no compensation)
  if (flightStyle === 'aggressive') return undefined;

  const recommended = 75; // Midpoint of 50-100 range

  return {
    setting: 'vbat_sag_compensation',
    currentValue: 0,
    recommendedValue: recommended,
    reason:
      `VBat sag compensation is disabled. Setting to ${recommended} maintains consistent stick feel ` +
      'as the battery depletes — the flight controller scales PID output to compensate for voltage drop. ' +
      'Recommended for freestyle and cinematic flying.',
    impact: 'response',
    confidence: 'low',
    ruleId: 'P-VBAT-SAG',
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
