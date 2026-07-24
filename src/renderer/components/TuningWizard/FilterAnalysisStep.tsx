import React from 'react';
import { RecommendationCard } from './RecommendationCard';
import { SpectrumChart } from './charts/SpectrumChart';
import { ThrottleSpectrogramChart } from './charts/ThrottleSpectrogramChart';
import type { FilterAnalysisResult, AnalysisProgress } from '@shared/types/analysis.types';
import type { TuningMode } from '@shared/types/tuning.types';
import { TUNING_MODE } from '@shared/constants';
import { CHART_DESCRIPTIONS, METRIC_TOOLTIPS } from '@shared/constants/metricTooltips';

interface FilterAnalysisStepProps {
  filterResult: FilterAnalysisResult | null;
  filterAnalyzing: boolean;
  filterProgress: AnalysisProgress | null;
  filterError: string | null;
  runFilterAnalysis: () => Promise<void>;
  onContinue: () => void;
  mode?: TuningMode;
}

const STEP_LABELS: Record<string, string> = {
  segmenting: 'Finding steady flight segments...',
  fft: 'Computing frequency spectrum...',
  analyzing: 'Analyzing noise patterns...',
  recommending: 'Generating recommendations...',
};

const PEAK_TYPE_LABELS: Record<string, string> = {
  frame_resonance: 'Frame',
  motor_harmonic: 'Motor',
  electrical: 'Electrical',
  unknown: 'Unknown',
};

export function FilterAnalysisStep({
  filterResult,
  filterAnalyzing,
  filterProgress,
  filterError,
  runFilterAnalysis,
  onContinue,
  mode = 'full',
}: FilterAnalysisStepProps) {
  const continueLabel =
    mode === TUNING_MODE.FILTER ? 'Continue to Summary' : 'Continue to PID Analysis';
  const skipLabel = mode === TUNING_MODE.FILTER ? 'Skip to Summary' : 'Skip to PIDs';

  if (filterAnalyzing) {
    return (
      <div className="analysis-section">
        <h3>Filter Analysis</h3>
        <p>Analyzing gyro noise to optimize filter settings...</p>
        {filterProgress && (
          <div className="analysis-progress">
            <div className="analysis-progress-label">
              <span>{STEP_LABELS[filterProgress.step] || filterProgress.step}</span>
              <span>{filterProgress.percent}%</span>
            </div>
            <div className="analysis-progress-bar">
              <div
                className="analysis-progress-fill"
                style={{ width: `${filterProgress.percent}%` }}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  if (filterError) {
    const hint = filterError.includes('No stable')
      ? 'Try a longer hover with smooth throttle sweeps (30-60 seconds).'
      : filterError.includes('segment')
        ? 'The flight log may be too short. Try a longer flight with varied throttle.'
        : filterError.includes('parse') || filterError.includes('corrupt')
          ? 'The log file may be corrupted. Try downloading again or fly a new flight.'
          : 'Check that the log contains valid gyro data from a real flight.';
    return (
      <div className="analysis-section">
        <h3>Filter Analysis</h3>
        <div className="analysis-error">{filterError}</div>
        <div className="analysis-error-hint">{hint}</div>
        <div className="analysis-actions">
          <button className="wizard-btn wizard-btn-primary" onClick={runFilterAnalysis}>
            Retry
          </button>
          <button className="wizard-btn wizard-btn-secondary" onClick={onContinue}>
            {skipLabel}
          </button>
        </div>
      </div>
    );
  }

  if (filterResult) {
    return (
      <div className="analysis-section">
        <h3>Filter Analysis Results</h3>
        <p>
          Noise level:{' '}
          <span className={`noise-level-badge ${filterResult.noise.overallLevel}`}>
            {filterResult.noise.overallLevel}
          </span>{' '}
          &mdash; {filterResult.summary}
        </p>

        <div className="analysis-meta">
          <span className="analysis-meta-pill">
            {filterResult.segmentsUsed} segment{filterResult.segmentsUsed !== 1 ? 's' : ''} analyzed
          </span>
          {filterResult.rpmFilterActive !== undefined && (
            <span
              className={`analysis-meta-pill ${filterResult.rpmFilterActive ? 'rpm-active' : 'rpm-inactive'}`}
            >
              RPM Filter: {filterResult.rpmFilterActive ? 'Active' : 'Not detected'}
            </span>
          )}
          {filterResult.dataQuality && (
            <span
              className={`analysis-meta-pill quality-${filterResult.dataQuality.tier}`}
              title={`Data quality: ${filterResult.dataQuality.overall}/100`}
            >
              Data: {filterResult.dataQuality.tier} ({filterResult.dataQuality.overall}/100)
            </span>
          )}
          {filterResult.windDisturbance && (
            <span
              className={`analysis-meta-pill wind-${filterResult.windDisturbance.level}`}
              title={filterResult.windDisturbance.summary}
            >
              Wind: {filterResult.windDisturbance.level}
            </span>
          )}
        </div>

        {filterResult.mechanicalHealth &&
          filterResult.mechanicalHealth.status !== 'ok' &&
          filterResult.mechanicalHealth.issues.map((issue, i) => (
            <div
              key={i}
              className={`analysis-warning analysis-warning--${issue.severity === 'critical' ? 'error' : 'warning'}`}
            >
              <span className="analysis-warning-icon">
                {issue.severity === 'critical' ? '\u274C' : '\u26A0\uFE0F'}
              </span>
              <span>{issue.message}</span>
            </div>
          ))}

        {filterResult.rpmFilterActive && (
          <div className="analysis-warning analysis-warning--info">
            <span className="analysis-warning-icon">{'\u2139\uFE0F'}</span>
            <span>
              RPM filter is active — filter recommendations are optimized for lower latency.
            </span>
          </div>
        )}

        {filterResult.warnings && filterResult.warnings.length > 0 && (
          <div className="analysis-warnings">
            {filterResult.warnings.map((w, i) => (
              <div key={i} className={`analysis-warning analysis-warning--${w.severity}`}>
                <span className="analysis-warning-icon">
                  {w.severity === 'error'
                    ? '\u274C'
                    : w.severity === 'info'
                      ? '\u2139\uFE0F'
                      : '\u26A0\uFE0F'}
                </span>
                <span>{w.message}</span>
              </div>
            ))}
          </div>
        )}

        <div className="noise-details">
          <h4 className="chart-title">Noise Spectrum</h4>
          <p className="chart-description">{CHART_DESCRIPTIONS.noiseSpectrum}</p>
          <p className="chart-legend">
            <span className="chart-legend-item">
              <span className="chart-legend-line" style={{ borderColor: '#ff6b6b' }} /> Roll
            </span>
            <span className="chart-legend-item">
              <span className="chart-legend-line" style={{ borderColor: '#51cf66' }} /> Pitch
            </span>
            <span className="chart-legend-item">
              <span className="chart-legend-line" style={{ borderColor: '#4dabf7' }} /> Yaw
            </span>
            <span className="chart-legend-item">
              <span className="chart-legend-line chart-legend-line--dashed" /> Noise floor
            </span>
            <span className="chart-legend-item">
              <span
                className="chart-legend-line chart-legend-line--dashed"
                style={{ borderColor: '#ffd43b' }}
              />{' '}
              Peak marker
            </span>
          </p>
          <SpectrumChart
            noise={filterResult.noise}
            filterSettings={filterResult.filterSettings}
            recommendations={filterResult.recommendations}
          />
          <div className="axis-summary">
            {(['roll', 'pitch', 'yaw'] as const).map((axis) => {
              const profile = filterResult.noise[axis];
              return (
                <div key={axis} className="axis-summary-card">
                  <div className="axis-summary-card-title">{axis}</div>
                  <div className="axis-summary-card-stat" title={METRIC_TOOLTIPS.noiseFloor}>
                    <span>Noise floor: </span>
                    {profile.noiseFloorDb.toFixed(0)} dB
                  </div>
                  <div className="axis-summary-card-stat">
                    <span>Peaks: </span>
                    {profile.peaks.length}
                  </div>
                  {profile.peaks.map((peak, i) => (
                    <div
                      key={i}
                      className="axis-summary-card-stat"
                      title={METRIC_TOOLTIPS.peakFrequency}
                    >
                      <span>{peak.frequency.toFixed(0)} Hz </span>
                      <span className={`noise-peak-badge ${peak.type}`}>
                        {PEAK_TYPE_LABELS[peak.type] || peak.type}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {filterResult.throttleSpectrogram && filterResult.throttleSpectrogram.bandsWithData > 0 && (
          <div className="noise-details">
            <h4 className="chart-title">Throttle Spectrogram</h4>
            <p className="chart-description">{CHART_DESCRIPTIONS.throttleSpectrogram}</p>
            <ThrottleSpectrogramChart
              data={filterResult.throttleSpectrogram}
              filterSettings={filterResult.filterSettings}
            />
          </div>
        )}

        {filterResult.recommendations.length > 0 ? (
          <div className="recommendation-list">
            {filterResult.recommendations.map((rec) => (
              <RecommendationCard
                key={rec.setting}
                setting={rec.setting}
                currentValue={rec.currentValue}
                recommendedValue={rec.recommendedValue}
                reason={rec.reason}
                impact={rec.impact}
                confidence={rec.confidence}
                evidence={rec.evidence}
                unit="Hz"
              />
            ))}
          </div>
        ) : (
          <div className="analysis-empty">
            <span className="analysis-empty-icon">&#9989;</span>
            <span>Your filter settings look good! No changes recommended.</span>
          </div>
        )}

        <div className="analysis-actions">
          <button className="wizard-btn wizard-btn-primary" onClick={onContinue}>
            {continueLabel}
          </button>
        </div>
      </div>
    );
  }

  // Initial state — not yet run
  return (
    <div className="analysis-section">
      <h3>Filter Analysis</h3>
      <p>
        Analyze gyro noise from your flight data to find optimal filter settings. This uses FFT
        (Fast Fourier Transform) to identify noise frequencies and recommend filter adjustments.
      </p>
      <button className="wizard-btn wizard-btn-primary" onClick={runFilterAnalysis}>
        Run Filter Analysis
      </button>
    </div>
  );
}
