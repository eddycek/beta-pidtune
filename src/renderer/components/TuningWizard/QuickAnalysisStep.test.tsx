import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuickAnalysisStep } from './QuickAnalysisStep';
import type { FilterAnalysisResult, PIDAnalysisResult } from '@shared/types/analysis.types';

const makeFilterResult = (): FilterAnalysisResult =>
  ({
    noise: {
      roll: {
        spectrum: { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
        noiseFloorDb: -50,
        peaks: [],
      },
      pitch: {
        spectrum: { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
        noiseFloorDb: -48,
        peaks: [],
      },
      yaw: {
        spectrum: { frequencies: new Float64Array(0), magnitudes: new Float64Array(0) },
        noiseFloorDb: -52,
        peaks: [],
      },
      overallLevel: 'low',
    },
    recommendations: [
      {
        setting: 'gyro_lpf1_static_hz',
        currentValue: 250,
        recommendedValue: 180,
        confidence: 'high',
        reason: 'Reduce noise',
        impact: 'noise',
      },
    ],
    summary: 'Low noise detected.',
    analysisTimeMs: 100,
    sessionIndex: 0,
    segmentsUsed: 3,
  }) as FilterAnalysisResult;

const makeTFResult = (): PIDAnalysisResult =>
  ({
    roll: {
      responses: [],
      meanOvershoot: 10,
      meanRiseTimeMs: 12,
      meanSettlingTimeMs: 80,
      meanLatencyMs: 5,
      meanTrackingErrorRMS: 0.1,
      meanSteadyStateError: 0,
    },
    pitch: {
      responses: [],
      meanOvershoot: 10,
      meanRiseTimeMs: 12,
      meanSettlingTimeMs: 80,
      meanLatencyMs: 5,
      meanTrackingErrorRMS: 0.1,
      meanSteadyStateError: 0,
    },
    yaw: {
      responses: [],
      meanOvershoot: 10,
      meanRiseTimeMs: 12,
      meanSettlingTimeMs: 80,
      meanLatencyMs: 5,
      meanTrackingErrorRMS: 0.1,
      meanSteadyStateError: 0,
    },
    recommendations: [
      {
        setting: 'pid_roll_d',
        currentValue: 30,
        recommendedValue: 40,
        confidence: 'medium',
        reason: 'Increase D for stability',
        impact: 'stability',
      },
    ],
    summary: 'PID recommendations from transfer function.',
    analysisTimeMs: 200,
    sessionIndex: 0,
    stepsDetected: 0,
    currentPIDs: {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 47, I: 82, D: 32 },
      yaw: { P: 35, I: 90, D: 0 },
    },
  }) as PIDAnalysisResult;

describe('QuickAnalysisStep', () => {
  const defaultProps = {
    filterResult: null as FilterAnalysisResult | null,
    filterAnalyzing: false,
    filterProgress: null,
    filterError: null,
    tfResult: null as PIDAnalysisResult | null,
    tfAnalyzing: false,
    tfError: null,
    runQuickAnalysis: vi.fn().mockResolvedValue(undefined),
    quickAnalyzing: false,
    onContinue: vi.fn(),
  };

  it('auto-runs analysis on mount', () => {
    render(<QuickAnalysisStep {...defaultProps} />);
    expect(defaultProps.runQuickAnalysis).toHaveBeenCalled();
  });

  it('shows progress when analyzing', () => {
    render(<QuickAnalysisStep {...defaultProps} filterAnalyzing={true} quickAnalyzing={true} />);
    expect(screen.getByText(/Analyzing noise spectrum/)).toBeInTheDocument();
  });

  it('shows filter and TF recommendations when done', () => {
    render(
      <QuickAnalysisStep
        {...defaultProps}
        filterResult={makeFilterResult()}
        tfResult={makeTFResult()}
      />
    );

    expect(screen.getByText('Filter Recommendations')).toBeInTheDocument();
    expect(screen.getByText('PID Recommendations')).toBeInTheDocument();
    expect(screen.getByText('Low noise detected.')).toBeInTheDocument();
    expect(screen.getByText('PID recommendations from transfer function.')).toBeInTheDocument();
  });

  it('shows continue to summary button when results ready', () => {
    render(
      <QuickAnalysisStep
        {...defaultProps}
        filterResult={makeFilterResult()}
        tfResult={makeTFResult()}
      />
    );

    expect(screen.getByText('Continue to Summary')).toBeInTheDocument();
  });

  it('shows error messages', () => {
    render(<QuickAnalysisStep {...defaultProps} filterError="Filter failed" tfError="TF failed" />);

    expect(screen.getByText(/Filter analysis failed: Filter failed/)).toBeInTheDocument();
    expect(screen.getByText(/Transfer function analysis failed: TF failed/)).toBeInTheDocument();
  });

  it('disables continue when no recommendations', () => {
    const noRecsFilter = makeFilterResult();
    noRecsFilter.recommendations = [];
    const noRecsTF = makeTFResult();
    noRecsTF.recommendations = [];

    render(<QuickAnalysisStep {...defaultProps} filterResult={noRecsFilter} tfResult={noRecsTF} />);

    const btn = screen.getByText('No Changes to Apply');
    expect(btn).toBeDisabled();
  });
});

describe('QuickAnalysisStep what-if prediction (P3.2)', () => {
  const defaultProps = {
    filterResult: null as FilterAnalysisResult | null,
    filterAnalyzing: false,
    filterProgress: null,
    filterError: null,
    tfResult: null as PIDAnalysisResult | null,
    tfAnalyzing: false,
    tfError: null,
    runQuickAnalysis: vi.fn().mockResolvedValue(undefined),
    quickAnalyzing: false,
    onContinue: vi.fn(),
  };

  function makeWhatIf() {
    const response = { timeMs: [0, 50, 100, 150], response: [0, 0.8, 1.1, 1.0] };
    const metrics = {
      bandwidthHz: 40,
      phaseMarginDeg: 60,
      gainMarginDb: 10,
      overshootPercent: 10,
      settlingTimeMs: 120,
      riseTimeMs: 45,
      dcGainDb: 0,
    };
    const axis = {
      plant: { gainK: 8, naturalFreqHz: 30, damping: 0.7, delayMs: 5, fitQuality: 0.9 },
      current: { pids: { P: 45, I: 80, D: 40 }, response, metrics },
      proposed: { pids: { P: 50, I: 80, D: 48 }, response, metrics },
    };
    return {
      roll: axis,
      pitch: axis,
      proposedPIDs: {
        roll: { P: 50, I: 80, D: 48 },
        pitch: { P: 52, I: 84, D: 50 },
        yaw: { P: 45, I: 80, D: 0 },
      },
    };
  }

  it('renders the predicted-response section when whatIf is present', () => {
    const tf = makeTFResult();
    (tf as any).whatIf = makeWhatIf();
    render(<QuickAnalysisStep {...defaultProps} tfResult={tf} />);

    expect(screen.getByText('Predicted Response with Proposed Gains')).toBeInTheDocument();
    expect(screen.getByText(/fit quality/)).toBeInTheDocument();
    expect(screen.getByText(/simulation, not a measurement/)).toBeInTheDocument();
  });

  it('omits the predicted-response section without whatIf', () => {
    render(<QuickAnalysisStep {...defaultProps} tfResult={makeTFResult()} />);
    expect(screen.queryByText('Predicted Response with Proposed Gains')).not.toBeInTheDocument();
  });
});
