/**
 * Golden-output regression harness for the analysis pipelines.
 *
 * Runs the full FilterAnalyzer / PIDAnalyzer / TransferFunction pipelines over
 * deterministic inputs (seeded demo BBLs + a real BBL fixture) and compares a
 * stable summary of the outputs against JSON fixtures in
 * `__fixtures__/golden/`.
 *
 * Purpose: any PR that changes analysis behavior shows up as a golden diff.
 * The two planned recalibration events (calibrated PSD, deconvolved step
 * response) are the ONLY PRs allowed to regenerate these fixtures wholesale;
 * every other change must either leave them untouched or justify the diff.
 *
 * To regenerate fixtures: UPDATE_GOLDEN=1 npx vitest run goldenOutputs
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BlackboxParser } from '../blackbox/BlackboxParser';
import { analyze as analyzeFilters } from './FilterAnalyzer';
import { analyzePID, analyzeTransferFunction } from './PIDAnalyzer';
import {
  generateFilterDemoBBL,
  generatePIDDemoBBL,
  generateFlashDemoBBL,
} from '../demo/DemoDataGenerator';
import { extractFlightPIDs } from './PIDRecommender';
import { enrichSettingsFromBBLHeaders } from './headerValidation';
import { DEFAULT_FILTER_SETTINGS } from '@shared/types/analysis.types';
import type {
  FilterAnalysisResult,
  PIDAnalysisResult,
  AxisNoiseProfile,
} from '@shared/types/analysis.types';
import type { PIDConfiguration } from '@shared/types/pid.types';
import type { BlackboxFlightData } from '@shared/types/blackbox.types';

const GOLDEN_DIR = path.resolve(__dirname, '__fixtures__/golden');
const REAL_BBL_PATH = path.resolve(
  __dirname,
  '../../../test-fixtures/bbl/blackbox_2026-03-29T11-09-44-682Z.bbl'
);
const UPDATE = process.env.UPDATE_GOLDEN === '1';

const DEFAULT_PIDS: PIDConfiguration = {
  roll: { P: 45, I: 80, D: 30 },
  pitch: { P: 47, I: 84, D: 32 },
  yaw: { P: 45, I: 80, D: 0 },
};

// ── Deterministic RNG (demo generator uses Math.random for gyro noise) ──

/** mulberry32 seeded PRNG — stable across platforms */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const realRandom = Math.random;

function seedRandom(seed: number): void {
  Math.random = mulberry32(seed);
}

function restoreRandom(): void {
  Math.random = realRandom;
}

// ── Stable summaries (rounded so tiny FP differences don't flake) ──

function round(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  const r = Math.round(v * f) / f;
  // Normalize -0 so JSON round-trips are stable
  return Object.is(r, -0) ? 0 : r;
}

interface RecSummary {
  setting: string;
  currentValue: number;
  recommendedValue: number;
  ruleId?: string;
  confidence: string;
  informational?: boolean;
}

function summarizeRecs(
  recs: Array<{
    setting: string;
    currentValue: number;
    recommendedValue: number;
    ruleId?: string;
    confidence: string;
    informational?: boolean;
  }>
): RecSummary[] {
  return recs
    .map((r) => ({
      setting: r.setting,
      currentValue: round(r.currentValue, 1),
      recommendedValue: round(r.recommendedValue, 1),
      ...(r.ruleId ? { ruleId: r.ruleId } : {}),
      confidence: r.confidence,
      ...(r.informational ? { informational: true } : {}),
    }))
    .sort((a, b) =>
      a.setting === b.setting
        ? (a.ruleId ?? '').localeCompare(b.ruleId ?? '')
        : a.setting.localeCompare(b.setting)
    );
}

function summarizeAxisNoise(axis: AxisNoiseProfile) {
  return {
    noiseFloorDb: round(axis.noiseFloorDb, 1),
    peaks: axis.peaks.slice(0, 8).map((p) => ({
      frequency: round(p.frequency, 0),
      amplitude: round(p.amplitude, 1),
      type: p.type,
    })),
  };
}

function summarizeFilterResult(r: FilterAnalysisResult) {
  return {
    overallLevel: r.noise.overallLevel,
    roll: summarizeAxisNoise(r.noise.roll),
    pitch: summarizeAxisNoise(r.noise.pitch),
    yaw: summarizeAxisNoise(r.noise.yaw),
    segmentsUsed: r.segmentsUsed,
    dataQuality: r.dataQuality
      ? { tier: r.dataQuality.tier, overall: round(r.dataQuality.overall, 0) }
      : null,
    groupDelay: r.groupDelay
      ? {
          gyroTotalMs: round(r.groupDelay.gyroTotalMs, 2),
          dtermTotalMs: round(r.groupDelay.dtermTotalMs, 2),
        }
      : null,
    warningCodes: (r.warnings ?? []).map((w) => w.code).sort(),
    recommendations: summarizeRecs(r.recommendations),
  };
}

function summarizeAxisStep(p: PIDAnalysisResult['roll']) {
  return {
    responses: p.responses.length,
    meanOvershoot: round(p.meanOvershoot, 1),
    meanRiseTimeMs: round(p.meanRiseTimeMs, 1),
    meanSettlingTimeMs: round(p.meanSettlingTimeMs, 0),
    meanLatencyMs: round(p.meanLatencyMs, 1),
    meanSteadyStateError: round(p.meanSteadyStateError, 1),
  };
}

function summarizePIDResult(r: PIDAnalysisResult) {
  return {
    analysisMethod: r.analysisMethod ?? 'step_response',
    stepsDetected: r.stepsDetected,
    roll: summarizeAxisStep(r.roll),
    pitch: summarizeAxisStep(r.pitch),
    yaw: summarizeAxisStep(r.yaw),
    dataQuality: r.dataQuality
      ? { tier: r.dataQuality.tier, overall: round(r.dataQuality.overall, 0) }
      : null,
    transferFunctionMetrics: r.transferFunctionMetrics
      ? (['roll', 'pitch', 'yaw'] as const).reduce(
          (acc, axis) => {
            const m = r.transferFunctionMetrics![axis];
            acc[axis] = {
              bandwidthHz: round(m.bandwidthHz, 0),
              phaseMarginDeg: round(m.phaseMarginDeg, 0),
              gainMarginDb: round(m.gainMarginDb, 0),
              dcGainDb: round(m.dcGainDb ?? 0, 1),
              overshootPercent: round(m.overshootPercent, 0),
              riseTimeMs: round(m.riseTimeMs, 0),
              settlingTimeMs: round(m.settlingTimeMs, 0),
            };
            return acc;
          },
          {} as Record<string, Record<string, number>>
        )
      : null,
    warningCodes: (r.warnings ?? []).map((w) => w.code).sort(),
    recommendations: summarizeRecs(r.recommendations),
  };
}

// ── Fixture comparison ──

function checkGolden(name: string, actual: unknown): void {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  if (UPDATE) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
    return;
  }
  if (!fs.existsSync(file)) {
    throw new Error(
      `Golden fixture missing: ${file}. Run: UPDATE_GOLDEN=1 npx vitest run goldenOutputs`
    );
  }
  const expected = JSON.parse(fs.readFileSync(file, 'utf-8'));
  expect(actual).toEqual(expected);
}

async function parseBBL(buffer: Buffer): Promise<{
  flightData: BlackboxFlightData;
  rawHeaders: Map<string, string>;
}> {
  const result = await BlackboxParser.parse(buffer);
  expect(result.success).toBe(true);
  const session = result.sessions[0];
  return { flightData: session.flightData, rawHeaders: session.header.rawHeaders };
}

// ── Test cases ──

describe('golden outputs — demo BBLs (seeded RNG)', () => {
  beforeAll(() => seedRandom(0xf9d1ab));
  afterAll(() => restoreRandom());

  it('filter demo cycle 0', async () => {
    seedRandom(0xf9d1ab);
    const { flightData } = await parseBBL(generateFilterDemoBBL(0));
    const result = await analyzeFilters(flightData, 0, DEFAULT_FILTER_SETTINGS, undefined, {
      droneSize: '5"',
      flightStyle: 'balanced',
    });
    checkGolden('demo-filter-cycle0', summarizeFilterResult(result));
  }, 60000);

  it('filter demo cycle 2 (cleaner)', async () => {
    seedRandom(0xf9d1ab);
    const { flightData } = await parseBBL(generateFilterDemoBBL(2));
    const result = await analyzeFilters(flightData, 0, DEFAULT_FILTER_SETTINGS, undefined, {
      droneSize: '5"',
      flightStyle: 'balanced',
    });
    checkGolden('demo-filter-cycle2', summarizeFilterResult(result));
  }, 60000);

  it('pid demo cycle 0', async () => {
    seedRandom(0xf9d1ab);
    const { flightData, rawHeaders } = await parseBBL(generatePIDDemoBBL(0));
    const result = await analyzePID(
      flightData,
      0,
      DEFAULT_PIDS,
      undefined,
      extractFlightPIDs(rawHeaders),
      rawHeaders,
      'balanced',
      undefined,
      '5"'
    );
    checkGolden('demo-pid-cycle0', summarizePIDResult(result));
  }, 60000);

  it('flash demo cycle 0 (wiener)', async () => {
    seedRandom(0xf9d1ab);
    const { flightData, rawHeaders } = await parseBBL(generateFlashDemoBBL(0));
    const result = await analyzeTransferFunction(
      flightData,
      0,
      DEFAULT_PIDS,
      undefined,
      extractFlightPIDs(rawHeaders),
      rawHeaders,
      'balanced',
      undefined,
      '5"'
    );
    checkGolden('demo-flash-cycle0', summarizePIDResult(result));
  }, 60000);
});

describe('golden outputs — real BBL (VX3.5, BF 4.5.2)', () => {
  let flightData: BlackboxFlightData;
  let rawHeaders: Map<string, string>;

  beforeAll(async () => {
    const data = fs.readFileSync(REAL_BBL_PATH);
    const parsed = await parseBBL(data);
    flightData = parsed.flightData;
    rawHeaders = parsed.rawHeaders;
  }, 120000);

  it('filter analysis', async () => {
    const enriched =
      enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, rawHeaders) ?? DEFAULT_FILTER_SETTINGS;
    const result = await analyzeFilters(flightData, 0, enriched, undefined, {
      droneSize: '3"',
      flightStyle: 'balanced',
    });
    checkGolden('real-vx35-filter', summarizeFilterResult(result));
  }, 120000);

  it('pid analysis (step response)', async () => {
    const flightPIDs = extractFlightPIDs(rawHeaders);
    const result = await analyzePID(
      flightData,
      0,
      flightPIDs ?? DEFAULT_PIDS,
      undefined,
      flightPIDs,
      rawHeaders,
      'balanced',
      undefined,
      '3"'
    );
    checkGolden('real-vx35-pid', summarizePIDResult(result));
  }, 120000);

  it('transfer function analysis (wiener)', async () => {
    const flightPIDs = extractFlightPIDs(rawHeaders);
    const result = await analyzeTransferFunction(
      flightData,
      0,
      flightPIDs ?? DEFAULT_PIDS,
      undefined,
      flightPIDs,
      rawHeaders,
      'balanced',
      undefined,
      '3"'
    );
    checkGolden('real-vx35-tf', summarizePIDResult(result));
  }, 120000);
});
