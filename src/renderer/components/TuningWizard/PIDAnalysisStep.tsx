import React from 'react';
import { RecommendationCard } from './RecommendationCard';
import { PreviousSessionComparison } from './PreviousSessionComparison';
import { StepResponseChart } from './charts/StepResponseChart';
import type { PIDAnalysisResult, AnalysisProgress } from '@shared/types/analysis.types';
import type { FlightStyle } from '@shared/types/profile.types';
import { CHART_DESCRIPTIONS, METRIC_TOOLTIPS } from '@shared/constants/metricTooltips';

const FLIGHT_STYLE_LABELS: Record<FlightStyle, string> = {
  smooth: 'Smooth',
  balanced: 'Balanced',
  aggressive: 'Aggressive',
};

interface PIDAnalysisStepProps {
  pidResult: PIDAnalysisResult | null;
  pidAnalyzing: boolean;
  pidProgress: AnalysisProgress | null;
  pidError: string | null;
  runPIDAnalysis: () => Promise<void>;
  onContinue: () => void;
}

const STEP_LABELS: Record<string, string> = {
  detecting: 'Detecting step inputs...',
  measuring: 'Measuring step responses...',
  scoring: 'Scoring PID performance...',
  recommending: 'Generating recommendations...',
};

export function PIDAnalysisStep({
  pidResult,
  pidAnalyzing,
  pidProgress,
  pidError,
  runPIDAnalysis,
  onContinue,
}: PIDAnalysisStepProps) {
  // Check if any trace data exists
  const hasTraces = pidResult
    ? ['roll', 'pitch', 'yaw'].some((axis) =>
        pidResult[axis as 'roll' | 'pitch' | 'yaw'].responses.some((r) => r.trace)
      )
    : false;

  if (pidAnalyzing) {
    return (
      <div className="analysis-section">
        <h3>PID Analysis</h3>
        <p>Analyzing step responses to optimize PID gains...</p>
        {pidProgress && (
          <div className="analysis-progress">
            <div className="analysis-progress-label">
              <span>{STEP_LABELS[pidProgress.step] || pidProgress.step}</span>
              <span>{pidProgress.percent}%</span>
            </div>
            <div className="analysis-progress-bar">
              <div
                className="analysis-progress-fill"
                style={{ width: `${pidProgress.percent}%` }}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  if (pidError) {
    const hint = pidError.includes('No step')
      ? 'The log needs sharp stick inputs (snaps). Try quick, aggressive stick movements on roll/pitch.'
      : pidError.includes('parse') || pidError.includes('corrupt')
        ? 'The log file may be corrupted. Try downloading again or fly a new flight.'
        : pidError.includes('short') || pidError.includes('segment')
          ? 'The flight may be too short. Try at least 30 seconds of stick snaps.'
          : 'Check that the log contains valid setpoint and gyro data.';
    return (
      <div className="analysis-section">
        <h3>PID Analysis</h3>
        <div className="analysis-error">{pidError}</div>
        <div className="analysis-error-hint">{hint}</div>
        <div className="analysis-actions">
          <button className="wizard-btn wizard-btn-primary" onClick={runPIDAnalysis}>
            Retry
          </button>
          <button className="wizard-btn wizard-btn-secondary" onClick={onContinue}>
            Skip to Summary
          </button>
        </div>
      </div>
    );
  }

  if (pidResult) {
    return (
      <div className="analysis-section">
        <h3>PID Analysis Results</h3>
        <p>{pidResult.summary}</p>
        <div className="analysis-meta">
          <span className="analysis-meta-pill" title={METRIC_TOOLTIPS.stepsDetected}>
            {pidResult.stepsDetected} step{pidResult.stepsDetected !== 1 ? 's' : ''} detected
          </span>
          {pidResult.flightStyle && (
            <span className="analysis-meta-pill">
              Tuning for: {FLIGHT_STYLE_LABELS[pidResult.flightStyle]} flying
            </span>
          )}
          {pidResult.dataQuality && (
            <span
              className={`analysis-meta-pill quality-${pidResult.dataQuality.tier}`}
              title={`Data quality: ${pidResult.dataQuality.overall}/100`}
            >
              Data: {pidResult.dataQuality.tier} ({pidResult.dataQuality.overall}/100)
            </span>
          )}
          {pidResult.propWash && pidResult.propWash.events.length >= 3 && (
            <span
              className={`analysis-meta-pill propwash-${pidResult.propWash.meanSeverity >= 5 ? 'severe' : pidResult.propWash.meanSeverity >= 2 ? 'moderate' : 'minimal'}`}
              title={pidResult.propWash.recommendation}
            >
              Prop wash:{' '}
              {pidResult.propWash.meanSeverity >= 5
                ? 'severe'
                : pidResult.propWash.meanSeverity >= 2
                  ? 'moderate'
                  : 'minimal'}{' '}
              ({pidResult.propWash.worstAxis}, ~{Math.round(pidResult.propWash.dominantFrequencyHz)}{' '}
              Hz)
            </span>
          )}
        </div>

        {pidResult.warnings && pidResult.warnings.length > 0 && (
          <div className="analysis-warnings">
            {pidResult.warnings.map((w, i) => (
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

        {pidResult.currentPIDs && (
          <>
            <h4 className="current-pids-heading">Current PID Values</h4>
            <div className="axis-summary">
              {(['roll', 'pitch', 'yaw'] as const).map((axis) => {
                const pids = pidResult.currentPIDs[axis];
                return (
                  <div key={`current-${axis}`} className="axis-summary-card">
                    <div className="axis-summary-card-title">{axis}</div>
                    <div className="axis-summary-card-stat">
                      <span>P: </span>
                      {pids.P}
                    </div>
                    <div className="axis-summary-card-stat">
                      <span>I: </span>
                      {pids.I}
                    </div>
                    <div className="axis-summary-card-stat">
                      <span>D: </span>
                      {pids.D}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <h4 className="current-pids-heading">Step Response Metrics</h4>
        <div className="axis-summary">
          {(['roll', 'pitch', 'yaw'] as const).map((axis) => {
            const profile = pidResult[axis];
            return (
              <div key={axis} className="axis-summary-card">
                <div className="axis-summary-card-title">{axis}</div>
                <div className="axis-summary-card-stat" title={METRIC_TOOLTIPS.overshoot}>
                  <span>Overshoot: </span>
                  {profile.meanOvershoot.toFixed(1)}%
                </div>
                <div className="axis-summary-card-stat" title={METRIC_TOOLTIPS.riseTime}>
                  <span>Rise: </span>
                  {profile.meanRiseTimeMs.toFixed(0)} ms
                </div>
                <div className="axis-summary-card-stat" title={METRIC_TOOLTIPS.settlingTime}>
                  <span>Settling: </span>
                  {profile.meanSettlingTimeMs.toFixed(0)} ms
                </div>
                <div className="axis-summary-card-stat" title={METRIC_TOOLTIPS.latency}>
                  <span>Latency: </span>
                  {profile.meanLatencyMs.toFixed(0)} ms
                </div>
              </div>
            );
          })}
        </div>

        {hasTraces && (
          <>
            <h4 className="chart-title">Step Response</h4>
            <p className="chart-description">{CHART_DESCRIPTIONS.stepResponse}</p>
            <p className="chart-legend">
              <span className="chart-legend-item">
                <span
                  className="chart-legend-line chart-legend-line--dashed"
                  style={{ borderColor: '#fff' }}
                />{' '}
                Setpoint
              </span>
              <span className="chart-legend-item">
                <span className="chart-legend-line" style={{ borderColor: '#ff6b6b' }} /> Roll
              </span>
              <span className="chart-legend-item">
                <span className="chart-legend-line" style={{ borderColor: '#51cf66' }} /> Pitch
              </span>
              <span className="chart-legend-item">
                <span className="chart-legend-line" style={{ borderColor: '#4dabf7' }} /> Yaw
              </span>
            </p>
            <StepResponseChart roll={pidResult.roll} pitch={pidResult.pitch} yaw={pidResult.yaw} />
          </>
        )}

        <PreviousSessionComparison mode="pid" pidResult={pidResult} />

        {pidResult.recommendations.length > 0 ? (
          <div className="recommendation-list">
            {pidResult.recommendations.map((rec) => (
              <RecommendationCard
                key={rec.setting}
                setting={rec.setting}
                currentValue={rec.currentValue}
                recommendedValue={rec.recommendedValue}
                reason={rec.reason}
                impact={rec.impact}
                confidence={rec.confidence}
                evidence={rec.evidence}
              />
            ))}
          </div>
        ) : (
          <div className="analysis-empty">
            <span className="analysis-empty-icon">&#9989;</span>
            <span>Your PID settings look good! No changes recommended.</span>
          </div>
        )}

        <div className="analysis-actions">
          <button className="wizard-btn wizard-btn-primary" onClick={onContinue}>
            Continue to Summary
          </button>
        </div>
      </div>
    );
  }

  // Initial state — not yet run
  return (
    <div className="analysis-section">
      <h3>PID Analysis</h3>
      <p>
        Analyze stick input step responses to evaluate PID performance. This measures overshoot,
        rise time, and settling time to find optimal P, I, and D gains.
      </p>
      <p className="analysis-section-detail">
        Tip: For best results, your test flight should include quick, sharp stick inputs (snaps) on
        each axis.
      </p>
      <button className="wizard-btn wizard-btn-primary" onClick={runPIDAnalysis}>
        Run PID Analysis
      </button>
    </div>
  );
}
