/**
 * Top-level filter analysis orchestrator.
 *
 * Coordinates the full pipeline: segment selection → FFT → noise analysis → recommendations.
 * This is the main entry point for the analysis module.
 */
import type { DroneSize, FlightStyle } from '@shared/types/profile.types';
import type { BlackboxFlightData } from '@shared/types/blackbox.types';
import type {
  FilterAnalysisResult,
  FilterRecommendation,
  AnalysisProgress,
  AnalysisWarning,
  CurrentFilterSettings,
  DataQualityScore,
  PowerSpectrum,
  ThrottleSpectrogramResult,
} from '@shared/types/analysis.types';
import { DEFAULT_FILTER_SETTINGS } from '@shared/types/analysis.types';
import { findSteadySegments, findThrottleSweepSegments } from './SegmentSelector';
import { computePowerSpectrum, trimSpectrum } from './FFTCompute';
import { analyzeAxisNoise, buildNoiseProfile } from './NoiseAnalyzer';
import {
  recommend,
  generateSummary,
  isRpmFilterActive,
  recommendRpmFilterQ,
  recommendDtermDynExpo,
  type ConfidenceContext,
} from './FilterRecommender';
import { scoreFilterDataQuality, adjustFilterConfidenceByQuality } from './DataQualityScorer';
import { computeThrottleSpectrogram } from './ThrottleSpectrogramAnalyzer';
import { estimateGroupDelay } from './GroupDelayEstimator';
import { analyzeWindDisturbance } from './WindDisturbanceDetector';
import { checkMechanicalHealth } from './MechanicalHealthChecker';
import { analyzeDynamicLowpass, recommendDynamicLowpass } from './DynamicLowpassRecommender';
import { FFT_WINDOW_SIZE, FREQUENCY_MIN_HZ, FREQUENCY_MAX_HZ } from './constants';

/** Maximum number of segments to use (more = slower but more accurate) */
const MAX_SEGMENTS = 5;

/** Optional profile context for size/style-aware advisory recommendations */
export interface FilterAnalysisOptions {
  /** Drone size from user profile (enables RPM Q advisory) */
  droneSize?: DroneSize;
  /** Flight style from user profile (enables D-term expo advisory) */
  flightStyle?: FlightStyle;
}

/**
 * Run the full filter analysis pipeline on parsed flight data.
 *
 * @param flightData - Parsed Blackbox flight data for one session
 * @param sessionIndex - Which session is being analyzed
 * @param currentSettings - Current filter settings from the FC
 * @param onProgress - Optional progress callback
 * @param options - Optional profile context for size/style-aware advisories
 * @returns Complete analysis result with noise profile and recommendations
 */
export async function analyze(
  flightData: BlackboxFlightData,
  sessionIndex: number = 0,
  currentSettings: CurrentFilterSettings = DEFAULT_FILTER_SETTINGS,
  onProgress?: (progress: AnalysisProgress) => void,
  options?: FilterAnalysisOptions
): Promise<FilterAnalysisResult> {
  const startTime = performance.now();

  // Step 1: Find flight segments — prefer throttle sweeps over steady hovers
  onProgress?.({ step: 'segmenting', percent: 5 });
  const sweepSegments = findThrottleSweepSegments(flightData);
  const steadySegments = findSteadySegments(flightData);

  // Prefer sweeps (higher quality noise data across RPM range), fall back to hovers
  const segments = sweepSegments.length > 0 ? sweepSegments : steadySegments;

  // Use up to MAX_SEGMENTS
  const usedSegments = segments.slice(0, MAX_SEGMENTS);

  // Score data quality
  const qualityResult = scoreFilterDataQuality({
    segments: usedSegments,
    hasSweepSegments: sweepSegments.length > 0,
    flightDurationS: flightData.durationSeconds,
  });

  if (usedSegments.length === 0) {
    // No steady segments found — analyze the entire flight as one segment (with warning)
    const warnings: AnalysisWarning[] = [
      {
        code: 'no_sweep_segments',
        message:
          'No hover or throttle sweep segments found. The entire flight was analyzed, which may include stick transients and reduce accuracy. For best results, fly gentle hovers with smooth throttle sweeps.',
        severity: 'warning',
      },
      ...qualityResult.warnings,
    ];
    return analyzeEntireFlight(
      flightData,
      sessionIndex,
      currentSettings,
      startTime,
      onProgress,
      warnings,
      qualityResult.score,
      options
    );
  }

  // Yield to event loop
  await yieldToEventLoop();

  // Step 2: Compute FFT for each segment per axis
  onProgress?.({ step: 'fft', percent: 20 });

  const rollSpectra: PowerSpectrum[] = [];
  const pitchSpectra: PowerSpectrum[] = [];
  const yawSpectra: PowerSpectrum[] = [];

  for (let s = 0; s < usedSegments.length; s++) {
    const seg = usedSegments[s];

    for (let axis = 0; axis < 3; axis++) {
      const gyroValues = flightData.gyro[axis].values.subarray(seg.startIndex, seg.endIndex);
      const spectrum = computePowerSpectrum(gyroValues, flightData.sampleRateHz, FFT_WINDOW_SIZE);
      const trimmed = trimSpectrum(spectrum, FREQUENCY_MIN_HZ, FREQUENCY_MAX_HZ);

      if (axis === 0) rollSpectra.push(trimmed);
      else if (axis === 1) pitchSpectra.push(trimmed);
      else yawSpectra.push(trimmed);
    }

    const fftPercent = 20 + ((s + 1) / usedSegments.length) * 40;
    onProgress?.({ step: 'fft', percent: Math.round(fftPercent) });

    await yieldToEventLoop();
  }

  // Step 3: Noise analysis
  onProgress?.({ step: 'analyzing', percent: 65 });
  const rollNoise = analyzeAxisNoise(rollSpectra, options?.droneSize);
  const pitchNoise = analyzeAxisNoise(pitchSpectra, options?.droneSize);
  const yawNoise = analyzeAxisNoise(yawSpectra, options?.droneSize);
  const noiseProfile = buildNoiseProfile(rollNoise, pitchNoise, yawNoise, options?.droneSize);

  await yieldToEventLoop();

  // Step 3b: Compute throttle spectrogram
  let throttleSpectrogram: ThrottleSpectrogramResult | undefined;
  if (flightData.setpoint[3]?.values.length > 0) {
    throttleSpectrogram = computeThrottleSpectrogram(flightData);
  }

  await yieldToEventLoop();

  // Step 4: Generate recommendations
  onProgress?.({ step: 'recommending', percent: 85 });
  const rpmActive = isRpmFilterActive(currentSettings);

  // Compute noise floor variability across segments for hysteresis-aware deadzone
  const confidenceContext = computeNoiseFloorVariability(rollSpectra, pitchSpectra);
  const rawRecommendations = recommend(
    noiseProfile,
    currentSettings,
    options?.droneSize,
    confidenceContext
  );
  const recommendations = adjustFilterConfidenceByQuality(
    rawRecommendations,
    qualityResult.score.tier
  );
  const summary = generateSummary(noiseProfile, recommendations, rpmActive);

  // Step 5: Estimate group delay
  const groupDelay = estimateGroupDelay(currentSettings);

  // Step 6: Wind/disturbance detection
  const windDisturbance = analyzeWindDisturbance(flightData);

  // Step 7: Mechanical health diagnostic (size-aware extreme-noise threshold)
  const mechanicalHealth = checkMechanicalHealth(flightData, noiseProfile, options?.droneSize);

  // Step 8: Dynamic lowpass analysis
  // Always run analysis, but dedupe any existing dyn_min/dyn_max recommendations so we
  // don't emit conflicting or duplicate recs for the same setting (avoids React duplicate key bugs).
  const existingDynSettings = new Set(
    recommendations
      .filter((r) => r.setting.includes('dyn_min') || r.setting.includes('dyn_max'))
      .map((r) => r.setting)
  );
  const dynamicLowpass = analyzeDynamicLowpass(throttleSpectrogram);
  const dynLowpassRecs = recommendDynamicLowpass(dynamicLowpass, currentSettings).filter(
    (r) => !existingDynSettings.has(r.setting)
  );
  if (dynLowpassRecs.length > 0) {
    recommendations.push(...dynLowpassRecs);
  }

  // Step 9: Profile-aware advisory recommendations
  appendProfileAdvisories(recommendations, currentSettings, options);

  onProgress?.({ step: 'recommending', percent: 100 });

  return {
    noise: noiseProfile,
    recommendations,
    summary,
    analysisTimeMs: Math.round(performance.now() - startTime),
    sessionIndex,
    segmentsUsed: usedSegments.length,
    rpmFilterActive: rpmActive,
    dataQuality: qualityResult.score,
    ...(qualityResult.warnings.length > 0 ? { warnings: qualityResult.warnings } : {}),
    ...(throttleSpectrogram?.bandsWithData ? { throttleSpectrogram } : {}),
    groupDelay,
    windDisturbance,
    mechanicalHealth,
    dynamicLowpass,
  };
}

/**
 * Fallback: analyze the entire flight when no steady segments are found.
 */
async function analyzeEntireFlight(
  flightData: BlackboxFlightData,
  sessionIndex: number,
  currentSettings: CurrentFilterSettings,
  startTime: number,
  onProgress?: (progress: AnalysisProgress) => void,
  warnings?: AnalysisWarning[],
  dataQuality?: DataQualityScore,
  options?: FilterAnalysisOptions
): Promise<FilterAnalysisResult> {
  onProgress?.({ step: 'fft', percent: 30 });

  const spectraByAxis: PowerSpectrum[][] = [[], [], []];

  for (let axis = 0; axis < 3; axis++) {
    const gyroValues = flightData.gyro[axis].values;
    if (gyroValues.length < 16) continue;

    const spectrum = computePowerSpectrum(gyroValues, flightData.sampleRateHz, FFT_WINDOW_SIZE);
    spectraByAxis[axis].push(trimSpectrum(spectrum, FREQUENCY_MIN_HZ, FREQUENCY_MAX_HZ));
  }

  await yieldToEventLoop();

  onProgress?.({ step: 'analyzing', percent: 65 });
  const rollNoise = analyzeAxisNoise(spectraByAxis[0], options?.droneSize);
  const pitchNoise = analyzeAxisNoise(spectraByAxis[1], options?.droneSize);
  const yawNoise = analyzeAxisNoise(spectraByAxis[2], options?.droneSize);
  const noiseProfile = buildNoiseProfile(rollNoise, pitchNoise, yawNoise, options?.droneSize);

  // Compute throttle spectrogram
  let throttleSpectrogram: ThrottleSpectrogramResult | undefined;
  if (flightData.setpoint[3]?.values.length > 0) {
    throttleSpectrogram = computeThrottleSpectrogram(flightData);
  }

  onProgress?.({ step: 'recommending', percent: 85 });
  const rpmActive = isRpmFilterActive(currentSettings);
  const rawRecommendations = recommend(noiseProfile, currentSettings, options?.droneSize);
  const recommendations = dataQuality
    ? adjustFilterConfidenceByQuality(rawRecommendations, dataQuality.tier)
    : rawRecommendations;
  const summary = generateSummary(noiseProfile, recommendations, rpmActive);

  onProgress?.({ step: 'recommending', percent: 100 });

  const groupDelay = estimateGroupDelay(currentSettings);

  // Wind/disturbance detection
  const windDisturbance = analyzeWindDisturbance(flightData);

  // Mechanical health diagnostic (size-aware extreme-noise threshold)
  const mechanicalHealth = checkMechanicalHealth(flightData, noiseProfile, options?.droneSize);

  // Always run analysis, but dedupe existing dyn_min/dyn_max recs (same as Step 8 above)
  const existingDynSettings = new Set(
    recommendations
      .filter((r) => r.setting.includes('dyn_min') || r.setting.includes('dyn_max'))
      .map((r) => r.setting)
  );
  const dynamicLowpass = analyzeDynamicLowpass(throttleSpectrogram);
  const dynLowpassRecs = recommendDynamicLowpass(dynamicLowpass, currentSettings).filter(
    (r) => !existingDynSettings.has(r.setting)
  );
  if (dynLowpassRecs.length > 0) {
    recommendations.push(...dynLowpassRecs);
  }

  // Profile-aware advisory recommendations
  appendProfileAdvisories(recommendations, currentSettings, options);

  return {
    noise: noiseProfile,
    recommendations,
    summary,
    analysisTimeMs: Math.round(performance.now() - startTime),
    sessionIndex,
    segmentsUsed: 0,
    rpmFilterActive: rpmActive,
    warnings,
    dataQuality,
    ...(throttleSpectrogram?.bandsWithData ? { throttleSpectrogram } : {}),
    groupDelay,
    windDisturbance,
    mechanicalHealth,
    dynamicLowpass,
  };
}

/**
 * Append profile-aware advisory recommendations (RPM Q, D-term expo).
 * These are informational-only and depend on drone size / flight style from the user profile.
 */
function appendProfileAdvisories(
  recommendations: FilterRecommendation[],
  currentSettings: CurrentFilterSettings,
  options?: FilterAnalysisOptions
): void {
  if (!options) return;

  const rpmQRec = recommendRpmFilterQ(currentSettings, options.droneSize);
  if (rpmQRec) recommendations.push(rpmQRec);

  const dexpRec = recommendDtermDynExpo(currentSettings, options.flightStyle);
  if (dexpRec) recommendations.push(dexpRec);
}

/**
 * Compute noise floor variability across per-segment spectra.
 * Returns a ConfidenceContext with the standard deviation of per-segment noise floors (dB).
 * Higher std = more variable noise = wider deadzone to prevent recommendation churn.
 */
function computeNoiseFloorVariability(
  rollSpectra: PowerSpectrum[],
  pitchSpectra: PowerSpectrum[]
): ConfidenceContext {
  if (rollSpectra.length < 2) return {};

  // Compute per-segment noise floor for roll and pitch (the critical axes)
  const floors: number[] = [];
  for (let i = 0; i < rollSpectra.length; i++) {
    const rollFloor = estimateNoiseFloorFromSpectrum(rollSpectra[i]);
    const pitchFloor = estimateNoiseFloorFromSpectrum(pitchSpectra[i]);
    floors.push(Math.max(rollFloor, pitchFloor)); // worst-axis per segment
  }

  const mean = floors.reduce((a, b) => a + b, 0) / floors.length;
  const variance = floors.reduce((sum, f) => sum + (f - mean) ** 2, 0) / floors.length;
  const std = Math.sqrt(variance);

  return { noiseFloorStdDb: std };
}

/**
 * Estimate noise floor from a single power spectrum using median of magnitudes.
 * This is a lightweight approximation — NoiseAnalyzer does a more thorough job,
 * but we only need relative variability here.
 */
function estimateNoiseFloorFromSpectrum(spectrum: PowerSpectrum): number {
  const mags = Array.from(spectrum.magnitudes);
  if (mags.length === 0) return -60;
  mags.sort((a, b) => a - b);
  return mags[Math.floor(mags.length / 2)]; // median
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
