import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PreviousSessionComparison } from './PreviousSessionComparison';
import { SPECTRUM_SCALE_VERSION } from '@shared/constants';
import type { FilterAnalysisResult, PIDAnalysisResult } from '@shared/types/analysis.types';
import type {
  CompletedTuningRecord,
  FilterMetricsSummary,
  PIDMetricsSummary,
} from '@shared/types/tuning-history.types';

function makeSpectrum(len = 64) {
  const frequencies = new Float64Array(len);
  const magnitudes = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    frequencies[i] = 20 + i * 10;
    magnitudes[i] = -30;
  }
  return { frequencies, magnitudes };
}

function makeFilterResult(): FilterAnalysisResult {
  const axis = () => ({ spectrum: makeSpectrum(), noiseFloorDb: -30, peaks: [] });
  return {
    noise: { roll: axis(), pitch: axis(), yaw: axis(), overallLevel: 'medium' },
    recommendations: [],
    summary: 'test',
    analysisTimeMs: 1,
    sessionIndex: 0,
    segmentsUsed: 2,
  };
}

function makePidResult(metricsSource: 'per_step' | 'deconvolved' = 'per_step'): PIDAnalysisResult {
  const axis = () =>
    ({
      meanOvershoot: 10,
      meanRiseTimeMs: 40,
      meanSettlingTimeMs: 90,
      meanLatencyMs: 5,
      meanTrackingErrorRMS: 2,
      metricsSource,
      responses: [],
      stepCount: 3,
    }) as unknown as PIDAnalysisResult['roll'];
  return {
    roll: axis(),
    pitch: axis(),
    yaw: axis(),
    recommendations: [],
    stepsDetected: 9,
    currentPIDs: {
      roll: { P: 45, I: 80, D: 40 },
      pitch: { P: 47, I: 84, D: 46 },
      yaw: { P: 45, I: 80, D: 0 },
    },
    summary: 'test',
    analysisTimeMs: 1,
  } as unknown as PIDAnalysisResult;
}

function makeFilterSummary(scaleVersion?: number): FilterMetricsSummary {
  return {
    noiseLevel: 'medium',
    roll: { noiseFloorDb: -25, peakCount: 1 },
    pitch: { noiseFloorDb: -26, peakCount: 1 },
    yaw: { noiseFloorDb: -28, peakCount: 0 },
    segmentsUsed: 2,
    summary: 'prev',
    spectrum: {
      frequencies: [20, 100, 200],
      roll: [-25, -30, -35],
      pitch: [-25, -30, -35],
      yaw: [-25, -30, -35],
    },
    ...(scaleVersion !== undefined ? { spectrumScaleVersion: scaleVersion } : {}),
  };
}

function makePidSummary(metricsSource?: 'per_step' | 'deconvolved'): PIDMetricsSummary {
  const axis = () => ({
    meanOvershoot: 20,
    meanRiseTimeMs: 50,
    meanSettlingTimeMs: 110,
    meanLatencyMs: 6,
    meanTrackingErrorRMS: 3,
  });
  return {
    roll: axis(),
    pitch: axis(),
    yaw: axis(),
    stepsDetected: 12,
    currentPIDs: {
      roll: { P: 42, I: 80, D: 38 },
      pitch: { P: 44, I: 84, D: 44 },
      yaw: { P: 42, I: 80, D: 0 },
    },
    summary: 'prev',
    ...(metricsSource ? { metricsSource } : {}),
  };
}

function makeRecord(overrides: Partial<CompletedTuningRecord>): CompletedTuningRecord {
  return {
    id: 'rec-1',
    profileId: 'p1',
    startedAt: '2026-07-01T10:00:00Z',
    completedAt: '2026-07-01T11:00:00Z',
    tuningType: 'filter',
    baselineSnapshotId: null,
    postFilterSnapshotId: null,
    postTuningSnapshotId: null,
    filterLogId: null,
    pidLogId: null,
    quickLogId: null,
    verificationLogId: null,
    appliedFilterChanges: [],
    appliedPIDChanges: [],
    appliedFeedforwardChanges: [],
    filterMetrics: null,
    pidMetrics: null,
    verificationMetrics: null,
    verificationPidMetrics: null,
    transferFunctionMetrics: null,
    ...overrides,
  } as CompletedTuningRecord;
}

describe('PreviousSessionComparison (P2.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the noise comparison against the previous session', async () => {
    vi.mocked(window.betaflight.getTuningHistory).mockResolvedValue([
      makeRecord({ verificationMetrics: makeFilterSummary(SPECTRUM_SCALE_VERSION) }),
    ]);

    render(<PreviousSessionComparison mode="filter" filterResult={makeFilterResult()} />);

    await waitFor(() => {
      expect(screen.getByText(/Compared to previous session/)).toBeInTheDocument();
    });
  });

  it('refuses cross-scale spectrum comparisons with a note', async () => {
    vi.mocked(window.betaflight.getTuningHistory).mockResolvedValue([
      makeRecord({ verificationMetrics: makeFilterSummary(undefined) }),
    ]);

    render(<PreviousSessionComparison mode="filter" filterResult={makeFilterResult()} />);

    await waitFor(() => {
      expect(screen.getByText(/older spectrum scale/)).toBeInTheDocument();
    });
  });

  it('renders nothing when there is no history', async () => {
    vi.mocked(window.betaflight.getTuningHistory).mockResolvedValue([]);

    const { container } = render(
      <PreviousSessionComparison mode="filter" filterResult={makeFilterResult()} />
    );

    await waitFor(() => {
      expect(vi.mocked(window.betaflight.getTuningHistory)).toHaveBeenCalled();
    });
    expect(container.querySelector('.previous-session-comparison')).toBeNull();
  });

  it('renders the step-metrics comparison for pid mode', async () => {
    vi.mocked(window.betaflight.getTuningHistory).mockResolvedValue([
      makeRecord({ verificationPidMetrics: makePidSummary('per_step'), tuningType: 'pid' }),
    ]);

    render(<PreviousSessionComparison mode="pid" pidResult={makePidResult('per_step')} />);

    await waitFor(() => {
      expect(screen.getByText(/Compared to previous session/)).toBeInTheDocument();
    });
  });

  it('refuses cross-method step comparisons with a note', async () => {
    // Previous archived with per-step metrics; current analysis uses deconvolved
    vi.mocked(window.betaflight.getTuningHistory).mockResolvedValue([
      makeRecord({ verificationPidMetrics: makePidSummary('per_step'), tuningType: 'pid' }),
    ]);

    render(<PreviousSessionComparison mode="pid" pidResult={makePidResult('deconvolved')} />);

    await waitFor(() => {
      expect(screen.getByText(/different method/)).toBeInTheDocument();
    });
  });

  it('prefers verification metrics over pre-tuning metrics', async () => {
    const verification = makeFilterSummary(SPECTRUM_SCALE_VERSION);
    verification.summary = 'verification-metrics';
    vi.mocked(window.betaflight.getTuningHistory).mockResolvedValue([
      makeRecord({
        filterMetrics: makeFilterSummary(undefined), // old scale — would show the note
        verificationMetrics: verification, // current scale — should be used instead
      }),
    ]);

    render(<PreviousSessionComparison mode="filter" filterResult={makeFilterResult()} />);

    await waitFor(() => {
      expect(screen.getByText(/Compared to previous session/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/older spectrum scale/)).not.toBeInTheDocument();
  });
});
