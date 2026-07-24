/**
 * Top-level PID analysis orchestrator.
 *
 * Unified pipeline: mode-specific extraction → shared post-processing.
 *
 * Two entry points:
 * - analyzePID(): Step response based (PID Tune)
 * - analyzeTransferFunction(): Wiener deconvolution based (Flash Tune)
 *
 * Both feed into analyzePIDCore() for identical post-processing:
 * prop wash, D-term effectiveness, feedforward, recommendations,
 * quality scoring, Bayesian optimization, slider mapping.
 */
import type { BlackboxFlightData } from '@shared/types/blackbox.types';
import type { PIDConfiguration } from '@shared/types/pid.types';
import type { DroneSize, FlightStyle } from '@shared/types/profile.types';
import type {
  AnalysisProgress,
  AnalysisWarning,
  AxisStepProfile,
  BayesianSuggestion,
  PIDAnalysisResult,
  StepEvent,
  StepResponse,
} from '@shared/types/analysis.types';
import { detectSteps } from './StepDetector';
import {
  computeStepResponse,
  aggregateAxisMetrics,
  classifyFFContribution,
  computeFFEnergyRatio,
  computeAdaptiveWindowMs,
} from './StepMetrics';
import {
  recommendPID,
  generatePIDSummary,
  extractFeedforwardContext,
  extractDMinContext,
  extractTPAContext,
  extractItermRelaxCutoff,
  extractItermRelaxMode,
  recommendItermRelaxCutoff,
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
import type { TransferFunctionContext } from './PIDRecommender';
import {
  scorePIDDataQuality,
  scoreWienerDataQuality,
  adjustPIDConfidenceByQuality,
} from './DataQualityScorer';
import { estimateAllAxes, type TransferFunctionResult } from './TransferFunctionEstimator';
import { STEP_RESPONSE_WINDOW_MAX_MS } from './constants';
import { analyzeCrossAxisCoupling } from './CrossAxisDetector';
import { analyzePropWash } from './PropWashDetector';
import { suggestNextPID, type PIDObservation } from './BayesianPIDOptimizer';
import { analyzeDTermEffectiveness } from './DTermAnalyzer';
import { mapToSliders, computeSliderDelta, buildRecommendedPIDs } from './SliderMapper';
import {
  analyzeFeedforward,
  deriveMaxStickRate,
  recommendFeedforward,
  recommendRCLinkBaseline,
  mergeFFRecommendations,
} from './FeedforwardAnalyzer';
import { analyzeThrottleTF, recommendTPAFromThrottleTF } from './ThrottleTFAnalyzer';
import { computeDeconvolvedStepResponse } from './StepResponseStacker';
import { DECONV_DISAGREEMENT_RATIO, DECONV_DISAGREEMENT_MIN_PP } from './constants';

/** Default PID configuration if none provided */
const DEFAULT_PIDS: PIDConfiguration = {
  roll: { P: 45, I: 80, D: 30 },
  pitch: { P: 47, I: 84, D: 32 },
  yaw: { P: 45, I: 80, D: 0 },
};

// ── Mode-specific extraction results ──

interface StepExtractionResult {
  mode: 'step_response';
  profiles: { roll: AxisStepProfile; pitch: AxisStepProfile; yaw: AxisStepProfile };
  steps: StepEvent[];
  allResponses: StepResponse[];
  axisResponses: {
    roll: StepResponse[];
    pitch: StepResponse[];
    yaw: StepResponse[];
  };
  /** Warnings from the deconvolved/per-step cross-check */
  deconvWarnings?: AnalysisWarning[];
  tfResult?: undefined;
  tfMetrics?: undefined;
}

interface WienerExtractionResult {
  mode: 'wiener_deconvolution';
  profiles: { roll: AxisStepProfile; pitch: AxisStepProfile; yaw: AxisStepProfile };
  steps: StepEvent[];
  allResponses: StepResponse[];
  axisResponses: {
    roll: StepResponse[];
    pitch: StepResponse[];
    yaw: StepResponse[];
  };
  tfResult: TransferFunctionResult;
  tfMetrics: TransferFunctionContext;
}

type ExtractionResult = StepExtractionResult | WienerExtractionResult;

// ── Mode-specific extraction ──

async function extractViaStepResponse(
  flightData: BlackboxFlightData,
  onProgress?: (progress: AnalysisProgress) => void
): Promise<StepExtractionResult> {
  // Step 1: Detect step inputs with generous window for adaptive sizing
  onProgress?.({ step: 'detecting', percent: 5 });
  const firstPassSteps = detectSteps(flightData, STEP_RESPONSE_WINDOW_MAX_MS);

  await yieldToEventLoop();

  // Step 1b: First-pass metrics to determine adaptive window
  const firstPassResponses: StepResponse[] = [];
  for (const step of firstPassSteps) {
    firstPassResponses.push(
      computeStepResponse(
        flightData.setpoint[step.axis],
        flightData.gyro[step.axis],
        step,
        flightData.sampleRateHz
      )
    );
  }
  const adaptiveWindowMs = computeAdaptiveWindowMs(firstPassResponses);

  await yieldToEventLoop();

  // Step 2: Re-detect with adaptive window (skip if same as first pass)
  onProgress?.({ step: 'detecting', percent: 10 });
  const steps =
    adaptiveWindowMs === STEP_RESPONSE_WINDOW_MAX_MS
      ? firstPassSteps
      : detectSteps(flightData, adaptiveWindowMs);

  await yieldToEventLoop();

  // Step 3: Compute metrics for each step with adaptive window
  onProgress?.({ step: 'measuring', percent: 30 });

  const rollResponses: StepResponse[] = [];
  const pitchResponses: StepResponse[] = [];
  const yawResponses: StepResponse[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const response = computeStepResponse(
      flightData.setpoint[step.axis],
      flightData.gyro[step.axis],
      step,
      flightData.sampleRateHz
    );

    // Classify FF contribution when pidP/pidF available
    if (flightData.pidP[step.axis] && flightData.pidF[step.axis]) {
      // Energy-based FF ratio (robust, uses entire response window)
      const energyRatio = computeFFEnergyRatio(
        step,
        flightData.pidP[step.axis],
        flightData.pidF[step.axis]
      );
      if (energyRatio !== undefined) {
        response.ffEnergyRatio = energyRatio;
        response.ffDominated = energyRatio > 0.6;
      } else {
        // Fallback: single-sample peak comparison (legacy)
        const ffResult = classifyFFContribution(
          response,
          flightData.pidP[step.axis],
          flightData.pidF[step.axis],
          flightData.gyro[step.axis]
        );
        if (ffResult !== undefined) {
          response.ffDominated = ffResult;
        }
      }
    }

    if (step.axis === 0) rollResponses.push(response);
    else if (step.axis === 1) pitchResponses.push(response);
    else yawResponses.push(response);

    // Report progress within measuring phase (30-70%)
    if (steps.length > 0) {
      const pct = 30 + ((i + 1) / steps.length) * 40;
      onProgress?.({ step: 'measuring', percent: Math.round(pct) });
    }

    // Yield periodically to avoid blocking
    if (i % 10 === 9) {
      await yieldToEventLoop();
    }
  }

  const roll = aggregateAxisMetrics(rollResponses);
  const pitch = aggregateAxisMetrics(pitchResponses);
  const yaw = aggregateAxisMetrics(yawResponses);

  // Deconvolved (stacked) step response — the primary source of
  // overshoot/rise/settling when coherent. Per-step means remain the
  // fallback and serve as a cross-check.
  const profiles = { roll, pitch, yaw };
  const deconvWarnings: AnalysisWarning[] = [];
  try {
    const deconv = computeDeconvolvedStepResponse(flightData);
    for (const axis of ['roll', 'pitch', 'yaw'] as const) {
      const profile = profiles[axis];
      const axisDeconv = deconv[axis];
      profile.metricsSource = 'per_step';
      if (axisDeconv.low || axisDeconv.high) {
        profile.inputSplit = {
          splitThresholdDegS: deconv.splitThresholdDegS,
          ...(axisDeconv.low ? { low: axisDeconv.low } : {}),
          ...(axisDeconv.high ? { high: axisDeconv.high } : {}),
        };
      }
      const primary = axisDeconv.primary;
      if (!primary) continue;

      // Cross-check: large relative disagreement between the two methods
      // (above a floor where both mean "fine") lowers trust in the data
      const perStepOvershoot = profile.meanOvershoot;
      const bothMeaningful =
        Math.max(perStepOvershoot, primary.overshootPercent) >= DECONV_DISAGREEMENT_MIN_PP &&
        profile.responses.length > 0;
      if (bothMeaningful) {
        const rel =
          Math.abs(primary.overshootPercent - perStepOvershoot) /
          Math.max(perStepOvershoot, primary.overshootPercent);
        if (rel > DECONV_DISAGREEMENT_RATIO) {
          deconvWarnings.push({
            code: 'step_deconv_disagreement',
            message:
              `Deconvolved and per-step overshoot disagree on ${axis} ` +
              `(${primary.overshootPercent.toFixed(0)}% vs ${perStepOvershoot.toFixed(0)}%). ` +
              'Metrics may be less reliable — consider a cleaner flight with distinct stick snaps.',
            severity: 'warning',
          });
        }
      }

      // Promote the deconvolved metrics to the headline values
      profile.perStepMetrics = {
        meanOvershoot: profile.meanOvershoot,
        meanRiseTimeMs: profile.meanRiseTimeMs,
        meanSettlingTimeMs: profile.meanSettlingTimeMs,
      };
      profile.meanOvershoot = primary.overshootPercent;
      profile.meanRiseTimeMs = primary.riseTimeMs;
      profile.meanSettlingTimeMs = primary.settlingTimeMs;
      profile.metricsSource = 'deconvolved';
    }
  } catch {
    // Deconvolution unavailable (e.g. extremely short log) — keep per-step
  }

  return {
    mode: 'step_response',
    profiles,
    steps,
    allResponses: [...rollResponses, ...pitchResponses, ...yawResponses],
    axisResponses: { roll: rollResponses, pitch: pitchResponses, yaw: yawResponses },
    ...(deconvWarnings.length > 0 ? { deconvWarnings } : {}),
  };
}

async function extractViaWiener(
  flightData: BlackboxFlightData,
  onProgress?: (progress: AnalysisProgress) => void
): Promise<WienerExtractionResult> {
  onProgress?.({ step: 'detecting', percent: 5 });

  const tfResult = estimateAllAxes(
    {
      roll: flightData.setpoint[0].values,
      pitch: flightData.setpoint[1].values,
      yaw: flightData.setpoint[2].values,
    },
    {
      roll: flightData.gyro[0].values,
      pitch: flightData.gyro[1].values,
      yaw: flightData.gyro[2].values,
    },
    flightData.sampleRateHz,
    (p) => {
      onProgress?.({ step: 'measuring', percent: 5 + Math.round(p.percent * 0.65) });
    }
  );

  await yieldToEventLoop();

  const axes = ['roll', 'pitch', 'yaw'] as const;
  const profiles: Record<string, AxisStepProfile> = {};

  for (const axis of axes) {
    const m = tfResult.metrics[axis];
    profiles[axis] = {
      responses: [],
      meanOvershoot: m.overshootPercent,
      meanRiseTimeMs: m.riseTimeMs,
      meanSettlingTimeMs: m.settlingTimeMs,
      meanLatencyMs: 0,
      meanTrackingErrorRMS: 0,
      meanSteadyStateError: 0,
    };
  }

  return {
    mode: 'wiener_deconvolution',
    profiles: {
      roll: profiles.roll as AxisStepProfile,
      pitch: profiles.pitch as AxisStepProfile,
      yaw: profiles.yaw as AxisStepProfile,
    },
    steps: [],
    allResponses: [],
    axisResponses: { roll: [], pitch: [], yaw: [] },
    tfResult,
    tfMetrics: {
      roll: tfResult.metrics.roll,
      pitch: tfResult.metrics.pitch,
      yaw: tfResult.metrics.yaw,
    },
  };
}

// ── Shared post-processing core ──

interface CoreParams {
  flightData: BlackboxFlightData;
  extracted: ExtractionResult;
  sessionIndex: number;
  currentPIDs: PIDConfiguration;
  flightPIDs?: PIDConfiguration;
  rawHeaders?: Map<string, string>;
  flightStyle: FlightStyle;
  droneSize?: DroneSize;
  droneWeight?: number;
  throttleNoiseIncreaseDeltaDb?: number;
  historyObservations?: PIDObservation[];
  onProgress?: (progress: AnalysisProgress) => void;
  startTime: number;
}

async function analyzePIDCore(params: CoreParams): Promise<PIDAnalysisResult> {
  const {
    flightData,
    extracted,
    sessionIndex,
    currentPIDs,
    flightPIDs,
    rawHeaders,
    flightStyle,
    droneSize,
    droneWeight,
    throttleNoiseIncreaseDeltaDb,
    historyObservations,
    onProgress,
    startTime,
  } = params;
  const { profiles, steps, allResponses, axisResponses } = extracted;

  // ── Data quality scoring (mode-aware) ──
  let qualityResult;
  if (extracted.mode === 'step_response') {
    qualityResult = scorePIDDataQuality({
      totalSteps: steps.length,
      axisResponses,
    });
  } else {
    // Compute setpoint RMS for Wiener quality scoring
    const setpointValues = flightData.setpoint[0].values;
    let sumSq = 0;
    for (let i = 0; i < setpointValues.length; i++) {
      sumSq += setpointValues[i] * setpointValues[i];
    }
    const setpointRMS = Math.sqrt(sumSq / setpointValues.length);

    const tfMetrics = extracted.tfResult.metrics;
    const coherenceMean =
      tfMetrics.roll.coherenceMean !== undefined &&
      tfMetrics.pitch.coherenceMean !== undefined &&
      tfMetrics.yaw.coherenceMean !== undefined
        ? {
            roll: tfMetrics.roll.coherenceMean,
            pitch: tfMetrics.pitch.coherenceMean,
            yaw: tfMetrics.yaw.coherenceMean,
          }
        : undefined;

    qualityResult = scoreWienerDataQuality({
      sampleCount: flightData.frameCount,
      sampleRateHz: flightData.sampleRateHz,
      setpointRMS,
      ...(coherenceMean ? { coherenceMean } : {}),
    });
  }

  // ── Analyses on raw flight data (both modes) ──
  const propWash = analyzePropWash(flightData);
  const dTermEffectiveness = analyzeDTermEffectiveness(flightData);
  const feedforwardContext = rawHeaders ? extractFeedforwardContext(rawHeaders) : undefined;
  const dMinContext = rawHeaders ? extractDMinContext(rawHeaders) : undefined;
  const tpaContext = rawHeaders ? extractTPAContext(rawHeaders) : undefined;

  // ── Per-band TF analysis (Flash Tune only) ──
  const throttleTF =
    extracted.mode === 'wiener_deconvolution'
      ? analyzeThrottleTF(flightData, flightData.sampleRateHz)
      : undefined;

  // ── Analyses requiring step events (PID Tune only, null for Flash) ──
  const crossAxisCoupling =
    steps.length > 0 ? analyzeCrossAxisCoupling(steps, flightData) : undefined;
  const feedforwardAnalysis =
    allResponses.length > 0
      ? analyzeFeedforward(
          allResponses,
          feedforwardContext,
          deriveMaxStickRate(flightData.setpoint)
        )
      : undefined;

  await yieldToEventLoop();

  // ── Recommendations (one call, all parameters) ──
  onProgress?.({ step: 'scoring', percent: 80 });
  const rawRecommendations = recommendPID(
    profiles.roll,
    profiles.pitch,
    profiles.yaw,
    currentPIDs,
    flightPIDs,
    feedforwardContext,
    flightStyle,
    extracted.tfMetrics,
    dTermEffectiveness,
    propWash,
    droneSize,
    dMinContext,
    tpaContext
  );

  // FF recommendations: RC-link baseline + step-response refinement, merged (no duplicates)
  const rcLinkBaselineRecs = recommendRCLinkBaseline(feedforwardContext, flightStyle);
  const stepFFRecs = recommendFeedforward(feedforwardAnalysis ?? undefined, feedforwardContext);
  const ffRecommendations = mergeFFRecommendations(rcLinkBaselineRecs, stepFFRecs);
  rawRecommendations.push(...ffRecommendations);

  // I-term relax cutoff recommendation (flight-style + propwash-aware advisory)
  const itermRelaxCutoff = rawHeaders ? extractItermRelaxCutoff(rawHeaders) : undefined;
  const itermRelaxMode = rawHeaders ? extractItermRelaxMode(rawHeaders) : undefined;
  const itermRelaxRec = recommendItermRelaxCutoff(
    itermRelaxCutoff,
    flightStyle,
    propWash,
    itermRelaxMode
  );
  if (itermRelaxRec) {
    rawRecommendations.push(itermRelaxRec);
  }

  // Dynamic idle min RPM recommendation (size-based advisory)
  if (rawHeaders) {
    const dynIdleMinRpm = extractDynIdleMinRpm(rawHeaders);
    const rpmFilterActive = extractRpmFilterActive(rawHeaders);
    const dynIdleRec = recommendDynIdleMinRpm(dynIdleMinRpm, rpmFilterActive, droneSize);
    if (dynIdleRec) {
      rawRecommendations.push(dynIdleRec);
    }
  }

  // PID sum limit recommendation (weight-based advisory)
  if (rawHeaders) {
    const { pidsumLimit, pidsumLimitYaw } = extractPidsumLimits(rawHeaders);
    const pidsumRecs = recommendPidsumLimits(pidsumLimit, pidsumLimitYaw, droneWeight);
    rawRecommendations.push(...pidsumRecs);
  }

  // Feedforward max rate limit recommendation (racing advisory)
  const ffMaxRateLimit = feedforwardContext?.maxRateLimit;
  const ffMaxRateLimitRec = recommendFFMaxRateLimit(ffMaxRateLimit, flightStyle);
  if (ffMaxRateLimitRec) {
    rawRecommendations.push(ffMaxRateLimitRec);
  }

  // Anti-gravity gain recommendation (weight + SSE based)
  const antiGravityGain = rawHeaders ? extractAntiGravityGain(rawHeaders) : undefined;
  const antiGravityRec = recommendAntiGravityGain(antiGravityGain, droneWeight, {
    roll: profiles.roll.meanSteadyStateError,
    pitch: profiles.pitch.meanSteadyStateError,
  });
  if (antiGravityRec) {
    rawRecommendations.push(antiGravityRec);
  }

  // Thrust linearization recommendation (size-based advisory)
  const thrustLinear = rawHeaders ? extractThrustLinear(rawHeaders) : undefined;
  const thrustLinearRec = recommendThrustLinear(thrustLinear, droneSize);
  if (thrustLinearRec) {
    rawRecommendations.push(thrustLinearRec);
  }

  // TPA tuning: measured per-band TF trends (P2.8) take precedence over the
  // static size-based advisory for the same setting; propwash safety rules
  // (PW-TPA-*) always win — they protect prop wash recovery authority.
  const tpaRecs = recommendTPA(tpaContext, droneSize, throttleNoiseIncreaseDeltaDb, propWash);
  const pwTpaSettings = new Set(
    tpaRecs.filter((r) => r.ruleId?.startsWith('PW-')).map((r) => r.setting)
  );
  const tfTpaRecs = throttleTF
    ? recommendTPAFromThrottleTF(throttleTF, tpaContext).filter(
        (r) => !pwTpaSettings.has(r.setting)
      )
    : [];
  const tfTpaSettings = new Set(tfTpaRecs.map((r) => r.setting));
  rawRecommendations.push(
    ...tpaRecs.filter((r) => r.ruleId?.startsWith('PW-') || !tfTpaSettings.has(r.setting)),
    ...tfTpaRecs
  );

  // VBat sag compensation advisory (flight-style-based)
  const vbatSag = rawHeaders ? extractVbatSagCompensation(rawHeaders) : undefined;
  const vbatSagRec = recommendVbatSagCompensation(vbatSag, flightStyle);
  if (vbatSagRec) {
    rawRecommendations.push(vbatSagRec);
  }

  // Quality-adjusted confidence — no blanket cap, gating handles it
  const recommendations = adjustPIDConfidenceByQuality(
    rawRecommendations,
    qualityResult.score.tier
  );
  const summary = generatePIDSummary(
    profiles.roll,
    profiles.pitch,
    profiles.yaw,
    recommendations,
    flightStyle
  );

  onProgress?.({ step: 'scoring', percent: 100 });

  // ── Warnings ──
  const warnings: AnalysisWarning[] = [
    ...qualityResult.warnings,
    ...(extracted.mode === 'step_response' && extracted.deconvWarnings
      ? extracted.deconvWarnings
      : []),
  ];
  if (throttleTF?.tpaWarning) {
    warnings.push({
      code: 'tpa_variance',
      message: throttleTF.tpaWarning,
      severity: 'warning',
    });
  }
  if (feedforwardContext?.active) {
    const ffMessage =
      extracted.mode === 'wiener_deconvolution'
        ? 'Feedforward is active. Transfer function includes FF contribution — some overshoot may be from FF.'
        : 'Feedforward is active on this flight. Overshoot and rise time measurements include feedforward contribution — some overshoot may be from FF rather than P/D imbalance.';
    warnings.push({
      code: 'feedforward_active',
      message: ffMessage,
      severity: 'info',
    });
  }

  // ── Bayesian PID optimization ──
  let bayesianSuggestion: BayesianSuggestion | undefined;
  if (historyObservations && historyObservations.length >= 3) {
    bayesianSuggestion = suggestNextPID(historyObservations) ?? undefined;
  }

  return {
    roll: profiles.roll,
    pitch: profiles.pitch,
    yaw: profiles.yaw,
    recommendations,
    summary,
    analysisTimeMs: Math.round(performance.now() - startTime),
    sessionIndex,
    stepsDetected: steps.length,
    currentPIDs,
    feedforwardContext,
    flightStyle,
    dataQuality: qualityResult.score,
    ...(extracted.mode === 'wiener_deconvolution'
      ? { analysisMethod: 'wiener_deconvolution' as const }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(crossAxisCoupling ? { crossAxisCoupling } : {}),
    ...(propWash ? { propWash } : {}),
    ...(bayesianSuggestion ? { bayesianSuggestion } : {}),
    ...(dTermEffectiveness ? { dTermEffectiveness } : {}),
    ...(feedforwardAnalysis ? { feedforwardAnalysis } : {}),
    ...(throttleTF ? { throttleTF } : {}),
    ...(extracted.tfResult ? { transferFunction: extracted.tfResult } : {}),
    ...(extracted.tfResult
      ? {
          transferFunctionMetrics: {
            roll: extracted.tfResult.metrics.roll,
            pitch: extracted.tfResult.metrics.pitch,
            yaw: extracted.tfResult.metrics.yaw,
          },
        }
      : {}),
    sliderPosition: mapToSliders(currentPIDs),
    ...(recommendations.length > 0
      ? {
          sliderDelta: computeSliderDelta(
            currentPIDs,
            buildRecommendedPIDs(currentPIDs, recommendations)
          ),
        }
      : {}),
  };
}

// ── Public API (thin wrappers) ──

/**
 * Run the full PID analysis pipeline on parsed flight data (PID Tune).
 *
 * Uses step detection → step response computation → shared post-processing.
 */
export async function analyzePID(
  flightData: BlackboxFlightData,
  sessionIndex: number = 0,
  currentPIDs: PIDConfiguration = DEFAULT_PIDS,
  onProgress?: (progress: AnalysisProgress) => void,
  flightPIDs?: PIDConfiguration,
  rawHeaders?: Map<string, string>,
  flightStyle: FlightStyle = 'balanced',
  historyObservations?: PIDObservation[],
  droneSize?: DroneSize,
  droneWeight?: number,
  throttleNoiseIncreaseDeltaDb?: number
): Promise<PIDAnalysisResult> {
  const startTime = performance.now();
  const extracted = await extractViaStepResponse(flightData, onProgress);
  return analyzePIDCore({
    flightData,
    extracted,
    sessionIndex,
    currentPIDs,
    flightPIDs,
    rawHeaders,
    flightStyle,
    droneSize,
    droneWeight,
    throttleNoiseIncreaseDeltaDb,
    historyObservations,
    onProgress,
    startTime,
  });
}

/**
 * Run PID analysis using Wiener deconvolution (Flash Tune).
 *
 * Works with any flight data — no stick snaps required. Uses the same
 * shared post-processing as step-response analysis.
 */
export async function analyzeTransferFunction(
  flightData: BlackboxFlightData,
  sessionIndex: number = 0,
  currentPIDs: PIDConfiguration = DEFAULT_PIDS,
  onProgress?: (progress: AnalysisProgress) => void,
  flightPIDs?: PIDConfiguration,
  rawHeaders?: Map<string, string>,
  flightStyle: FlightStyle = 'balanced',
  historyObservations?: PIDObservation[],
  droneSize?: DroneSize,
  droneWeight?: number,
  throttleNoiseIncreaseDeltaDb?: number
): Promise<PIDAnalysisResult & { transferFunction: TransferFunctionResult }> {
  const startTime = performance.now();
  const extracted = await extractViaWiener(flightData, onProgress);
  const result = await analyzePIDCore({
    flightData,
    extracted,
    sessionIndex,
    currentPIDs,
    flightPIDs,
    rawHeaders,
    flightStyle,
    droneSize,
    droneWeight,
    throttleNoiseIncreaseDeltaDb,
    historyObservations,
    onProgress,
    startTime,
  });
  return result as PIDAnalysisResult & { transferFunction: TransferFunctionResult };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
