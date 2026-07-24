import React, { useState } from 'react';
import { useAnalysisOverview } from '../../hooks/useAnalysisOverview';
import { SpectrumChart } from '../TuningWizard/charts/SpectrumChart';
import { ThrottleSpectrogramChart } from '../TuningWizard/charts/ThrottleSpectrogramChart';
import { StepResponseChart } from '../TuningWizard/charts/StepResponseChart';
import { TFStepResponseChart } from '../TuningWizard/charts/TFStepResponseChart';
import { BodePlot } from '../TuningWizard/charts/BodePlot';
import { CHART_DESCRIPTIONS, METRIC_TOOLTIPS } from '@shared/constants/metricTooltips';
import './AnalysisOverview.css';

/** Strip recommendation sentences from analysis summaries (diagnostic-only view). */
function stripRecommendation(summary: string): string {
  return summary
    .replace(/\s*\d+ filter changes? recommended\.$/, '')
    .replace(/\s*Current filter settings look good — no changes needed\.$/, '')
    .replace(/\s*No changes recommended\.$/, '')
    .replace(/\s*\d+ adjustments? recommended\b[^.]*\.$/, '');
}

interface AnalysisOverviewProps {
  logId: string;
  logName: string;
  onExit: () => void;
}

const FILTER_STEP_LABELS: Record<string, string> = {
  segmenting: 'Finding steady flight segments...',
  fft: 'Computing frequency spectrum...',
  analyzing: 'Analyzing noise patterns...',
  recommending: 'Generating recommendations...',
};

const PID_STEP_LABELS: Record<string, string> = {
  detecting: 'Detecting step inputs...',
  measuring: 'Measuring step responses...',
  scoring: 'Scoring PID performance...',
  recommending: 'Generating recommendations...',
};

const PEAK_TYPE_LABELS: Record<string, string> = {
  frame_resonance: 'Frame',
  motor_harmonic: 'Motor',
  electrical: 'Electrical',
  unknown: 'Unknown',
};

export function AnalysisOverview({ logId, logName, onExit }: AnalysisOverviewProps) {
  const overview = useAnalysisOverview(logId);

  const [bodeOpen, setBodeOpen] = useState(false);

  // Check if any trace data exists for step response chart
  const hasTraces = overview.pidResult
    ? ['roll', 'pitch', 'yaw'].some((axis) =>
        overview.pidResult![axis as 'roll' | 'pitch' | 'yaw'].responses.some((r) => r.trace)
      )
    : false;

  // Determine primary PID analysis method:
  // - "step_response" if enough steps detected (quality >= 40 or >= 10 steps)
  // - "frequency_response" if TF data available and step response is poor
  // - "both" if both have good data
  const stepQualityOk =
    overview.pidResult &&
    ((overview.pidResult.dataQuality && overview.pidResult.dataQuality.overall >= 40) ||
      overview.pidResult.stepsDetected >= 10);
  const hasTF =
    overview.tfResult && (overview.tfResult as any).transferFunction?.syntheticStepResponse;
  const pidMethod: 'step_response' | 'frequency_response' | 'both' =
    stepQualityOk && hasTF
      ? 'both'
      : stepQualityOk
        ? 'step_response'
        : hasTF
          ? 'frequency_response'
          : 'step_response'; // fallback: show what we have

  const isMultiSession = overview.sessions !== null && overview.sessions.length > 1;
  const selectedSession =
    overview.sessionSelected && overview.sessions ? overview.sessions[overview.sessionIndex] : null;

  return (
    <div className="analysis-overview">
      <div className="analysis-overview-header">
        <div className="analysis-overview-header-left">
          <h2>Analysis Overview</h2>
          <div className="analysis-breadcrumb">
            {isMultiSession && overview.sessionSelected ? (
              <button className="analysis-breadcrumb-log" onClick={overview.resetToSessionPicker}>
                {logName}
              </button>
            ) : (
              <span className="analysis-breadcrumb-log-static">{logName}</span>
            )}
            {selectedSession && (
              <>
                <span className="analysis-breadcrumb-arrow">{'\u2192'}</span>
                <span className="analysis-breadcrumb-session">
                  Session {overview.sessionIndex + 1}
                </span>
              </>
            )}
          </div>
          {selectedSession && (
            <div className="analysis-breadcrumb-meta">
              {selectedSession.flightData.durationSeconds.toFixed(1)}s{' \u2022 '}
              {selectedSession.flightData.frameCount.toLocaleString()} frames
              {' \u2022 '}
              {selectedSession.flightData.sampleRateHz} Hz
            </div>
          )}
        </div>
        <button className="wizard-btn wizard-btn-secondary" onClick={onExit}>
          Exit
        </button>
      </div>

      {/* Parsing phase */}
      {overview.parsing && (
        <div className="analysis-overview-section">
          <h3 className="analysis-overview-section-title">Parsing Blackbox Log</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary, #aaa)', margin: '0 0 16px 0' }}>
            Reading flight data from the log file...
          </p>
          {overview.parseProgress && (
            <div className="analysis-progress">
              <div className="analysis-progress-label">
                <span>Session {overview.parseProgress.currentSession + 1}</span>
                <span>{overview.parseProgress.percent}%</span>
              </div>
              <div className="analysis-progress-bar">
                <div
                  className="analysis-progress-fill"
                  style={{ width: `${overview.parseProgress.percent}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Parse error */}
      {overview.parseError && (
        <div className="analysis-overview-section">
          <h3 className="analysis-overview-section-title">Parse Error</h3>
          <div className="analysis-error">{overview.parseError}</div>
          <button className="wizard-btn wizard-btn-primary" onClick={overview.retryParse}>
            Retry
          </button>
        </div>
      )}

      {/* Session picker — only for multi-session logs when no session selected */}
      {overview.sessions && overview.sessions.length > 1 && !overview.sessionSelected && (
        <div className="analysis-overview-section">
          <h3 className="analysis-overview-section-title">Select Flight Session</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary, #aaa)', margin: '0 0 16px 0' }}>
            This log contains {overview.sessions.length} flight sessions. Select one to analyze.
          </p>
          <div className="session-list">
            {[...overview.sessions].reverse().map((session) => (
              <div
                key={session.index}
                className="session-item"
                role="button"
                tabIndex={0}
                onClick={() => overview.setSessionIndex(session.index)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    overview.setSessionIndex(session.index);
                  }
                }}
              >
                <div className="session-item-info">
                  <span className="session-item-title">Session {session.index + 1}</span>
                  <span className="session-item-meta">
                    <span>{session.flightData.durationSeconds.toFixed(1)}s</span>
                    <span>{session.flightData.frameCount.toLocaleString()} frames</span>
                    <span>{session.flightData.sampleRateHz} Hz</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter Analysis Section */}
      {overview.filterAnalyzing && (
        <div className="analysis-overview-section">
          <h3 className="analysis-overview-section-title">Filter Analysis</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary, #aaa)', margin: '0 0 16px 0' }}>
            Analyzing gyro noise to evaluate filter settings...
          </p>
          {overview.filterProgress && (
            <div className="analysis-progress">
              <div className="analysis-progress-label">
                <span>
                  {FILTER_STEP_LABELS[overview.filterProgress.step] || overview.filterProgress.step}
                </span>
                <span>{overview.filterProgress.percent}%</span>
              </div>
              <div className="analysis-progress-bar">
                <div
                  className="analysis-progress-fill"
                  style={{ width: `${overview.filterProgress.percent}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {overview.filterError && !overview.filterAnalyzing && (
        <div className="analysis-overview-section">
          <h3 className="analysis-overview-section-title">Filter Analysis</h3>
          <div className="analysis-error">{overview.filterError}</div>
          <button className="wizard-btn wizard-btn-primary" onClick={overview.retryFilterAnalysis}>
            Retry
          </button>
        </div>
      )}

      {overview.filterResult && (
        <div className="analysis-overview-section">
          <h3 className="analysis-overview-section-title">Filter Analysis</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary, #aaa)', margin: '0 0 16px 0' }}>
            Noise level:{' '}
            <span className={`noise-level-badge ${overview.filterResult.noise.overallLevel}`}>
              {overview.filterResult.noise.overallLevel}
            </span>{' '}
            &mdash; {stripRecommendation(overview.filterResult.summary)}
          </p>

          <div className="analysis-meta">
            <span className="analysis-meta-pill">
              {overview.filterResult.segmentsUsed} segment
              {overview.filterResult.segmentsUsed !== 1 ? 's' : ''} analyzed
            </span>
            {overview.filterResult.rpmFilterActive !== undefined && (
              <span
                className={`analysis-meta-pill ${overview.filterResult.rpmFilterActive ? 'rpm-active' : 'rpm-inactive'}`}
              >
                RPM Filter: {overview.filterResult.rpmFilterActive ? 'Active' : 'Not detected'}
              </span>
            )}
            {overview.filterResult.dataQuality && (
              <span
                className={`analysis-meta-pill quality-${overview.filterResult.dataQuality.tier}`}
                title={`Data quality: ${overview.filterResult.dataQuality.overall}/100`}
              >
                Data: {overview.filterResult.dataQuality.tier} (
                {overview.filterResult.dataQuality.overall}/100)
              </span>
            )}
            {overview.filterResult.windDisturbance && (
              <span
                className={`analysis-meta-pill wind-${overview.filterResult.windDisturbance.level}`}
                title={overview.filterResult.windDisturbance.summary}
              >
                Wind: {overview.filterResult.windDisturbance.level}
              </span>
            )}
          </div>

          {overview.filterResult.mechanicalHealth &&
            overview.filterResult.mechanicalHealth.status !== 'ok' &&
            overview.filterResult.mechanicalHealth.issues.map((issue, i) => (
              <div
                key={`mech-${i}`}
                className={`analysis-warning analysis-warning--${issue.severity === 'critical' ? 'error' : 'warning'}`}
              >
                <span className="analysis-warning-icon">
                  {issue.severity === 'critical' ? '\u274C' : '\u26A0\uFE0F'}
                </span>
                <span>{issue.message}</span>
              </div>
            ))}

          {overview.filterResult.rpmFilterActive && (
            <div className="analysis-warning analysis-warning--info">
              <span className="analysis-warning-icon">{'\u2139\uFE0F'}</span>
              <span>
                RPM filter is active — filter recommendations are optimized for lower latency.
              </span>
            </div>
          )}

          {overview.filterResult.warnings && overview.filterResult.warnings.length > 0 && (
            <div className="analysis-warnings">
              {overview.filterResult.warnings.map((w, i) => (
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
              noise={overview.filterResult.noise}
              filterSettings={overview.filterResult.filterSettings}
            />
            <div className="axis-summary">
              {(['roll', 'pitch', 'yaw'] as const).map((axis) => {
                const profile = overview.filterResult!.noise[axis];
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

          {overview.filterResult.throttleSpectrogram &&
            overview.filterResult.throttleSpectrogram.bandsWithData > 0 && (
              <div style={{ marginTop: 16 }}>
                <h4 className="chart-title">Throttle Spectrogram</h4>
                <p className="chart-description">{CHART_DESCRIPTIONS.throttleSpectrogram}</p>
                <ThrottleSpectrogramChart
                  data={overview.filterResult.throttleSpectrogram}
                  filterSettings={overview.filterResult.filterSettings}
                />
              </div>
            )}
        </div>
      )}

      {/* Unified PID Analysis Section */}
      {(overview.pidAnalyzing || overview.tfAnalyzing) &&
        !overview.pidResult &&
        !overview.tfResult && (
          <div className="analysis-overview-section">
            <h3 className="analysis-overview-section-title">PID Analysis</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary, #aaa)', margin: '0 0 16px 0' }}>
              Analyzing flight data to evaluate PID performance...
            </p>
            {overview.pidProgress && (
              <div className="analysis-progress">
                <div className="analysis-progress-label">
                  <span>
                    {PID_STEP_LABELS[overview.pidProgress.step] || overview.pidProgress.step}
                  </span>
                  <span>{overview.pidProgress.percent}%</span>
                </div>
                <div className="analysis-progress-bar">
                  <div
                    className="analysis-progress-fill"
                    style={{ width: `${overview.pidProgress.percent}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

      {overview.pidError && !overview.pidAnalyzing && !overview.pidResult && (
        <div className="analysis-overview-section">
          <h3 className="analysis-overview-section-title">PID Analysis</h3>
          <div className="analysis-error">{overview.pidError}</div>
          <button className="wizard-btn wizard-btn-primary" onClick={overview.retryPIDAnalysis}>
            Retry
          </button>
        </div>
      )}

      {(overview.pidResult || (overview.tfResult && hasTF)) && (
        <div className="analysis-overview-section">
          <h3 className="analysis-overview-section-title">PID Analysis</h3>

          {/* Step Response Method */}
          {(pidMethod === 'step_response' || pidMethod === 'both') && overview.pidResult && (
            <>
              <h4 className="current-pids-heading">
                Step Response Method
                {pidMethod === 'both' && <span className="analysis-method-badge">primary</span>}
              </h4>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--text-secondary, #aaa)',
                  margin: '0 0 8px 0',
                }}
              >
                {stripRecommendation(overview.pidResult.summary)}
              </p>
              <div className="analysis-meta">
                <span className="analysis-meta-pill">
                  {overview.pidResult.stepsDetected} step
                  {overview.pidResult.stepsDetected !== 1 ? 's' : ''} detected
                </span>
                {overview.pidResult.dataQuality && (
                  <span
                    className={`analysis-meta-pill quality-${overview.pidResult.dataQuality.tier}`}
                    title={`Data quality: ${overview.pidResult.dataQuality.overall}/100`}
                  >
                    Data: {overview.pidResult.dataQuality.tier} (
                    {overview.pidResult.dataQuality.overall}/100)
                  </span>
                )}
                {overview.pidResult.propWash && overview.pidResult.propWash.events.length >= 3 && (
                  <span
                    className={`analysis-meta-pill propwash-${overview.pidResult.propWash.meanSeverity >= 5 ? 'severe' : overview.pidResult.propWash.meanSeverity >= 2 ? 'moderate' : 'minimal'}`}
                    title={overview.pidResult.propWash.recommendation}
                  >
                    Prop wash:{' '}
                    {overview.pidResult.propWash.meanSeverity >= 5
                      ? 'severe'
                      : overview.pidResult.propWash.meanSeverity >= 2
                        ? 'moderate'
                        : 'minimal'}{' '}
                    ({overview.pidResult.propWash.worstAxis}, ~
                    {Math.round(overview.pidResult.propWash.dominantFrequencyHz)} Hz)
                  </span>
                )}
              </div>

              {overview.pidResult.warnings && overview.pidResult.warnings.length > 0 && (
                <div className="analysis-warnings">
                  {overview.pidResult.warnings.map((w, i) => (
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

              {overview.pidResult.currentPIDs && (
                <>
                  <h4 className="current-pids-heading">Current PID Values</h4>
                  <div className="axis-summary">
                    {(['roll', 'pitch', 'yaw'] as const).map((axis) => {
                      const pids = overview.pidResult!.currentPIDs[axis];
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
                  const profile = overview.pidResult![axis];
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
                      <span className="chart-legend-line" style={{ borderColor: '#51cf66' }} />{' '}
                      Pitch
                    </span>
                    <span className="chart-legend-item">
                      <span className="chart-legend-line" style={{ borderColor: '#4dabf7' }} /> Yaw
                    </span>
                  </p>
                  <StepResponseChart
                    roll={overview.pidResult!.roll}
                    pitch={overview.pidResult!.pitch}
                    yaw={overview.pidResult!.yaw}
                  />
                </>
              )}
            </>
          )}

          {/* Frequency Response Method */}
          {(pidMethod === 'frequency_response' || pidMethod === 'both') && hasTF && (
            <>
              <h4 className="current-pids-heading">
                Frequency Response Method
                <span className="analysis-method-subtitle">Wiener deconvolution</span>
              </h4>

              <TFStepResponseChart
                stepResponse={(overview.tfResult as any).transferFunction.syntheticStepResponse}
              />

              <h4 className="current-pids-heading">Transfer Function Metrics</h4>
              <div className="axis-summary">
                {(['roll', 'pitch', 'yaw'] as const).map((axis) => {
                  const metrics = (overview.tfResult as any).transferFunction.metrics[axis];
                  return (
                    <div key={`tf-${axis}`} className="axis-summary-card">
                      <div className="axis-summary-card-title">{axis}</div>
                      <div className="axis-summary-card-stat">
                        <span>Bandwidth: </span>
                        {metrics.bandwidthHz.toFixed(0)} Hz
                      </div>
                      <div className="axis-summary-card-stat">
                        <span>Phase margin: </span>
                        {metrics.phaseMarginDeg.toFixed(0)}&deg;
                      </div>
                      <div className="axis-summary-card-stat">
                        <span>Overshoot: </span>
                        {metrics.overshootPercent.toFixed(1)}%
                      </div>
                      <div className="axis-summary-card-stat">
                        <span>Rise: </span>
                        {metrics.riseTimeMs.toFixed(0)} ms
                      </div>
                    </div>
                  );
                })}
              </div>

              <details
                className="bode-details"
                open={bodeOpen}
                onToggle={(e) => setBodeOpen((e.target as HTMLDetailsElement).open)}
              >
                <summary className="bode-details-summary">Bode Plot (Advanced)</summary>
                <p className="chart-description">
                  The <strong>Bode plot</strong> shows how the quad&apos;s response changes with
                  frequency. The <strong>magnitude</strong> plot shows how well it tracks (0 dB =
                  perfect). The <strong>phase</strong> plot shows delay &mdash; more negative means
                  more lag. The dashed line at -3 dB marks the bandwidth limit.
                </p>
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
                    <span
                      className="chart-legend-line chart-legend-line--dashed"
                      style={{ borderColor: '#ff8787' }}
                    />{' '}
                    -3 dB / -180&deg;
                  </span>
                </p>
                <BodePlot
                  bode={{
                    roll: (overview.tfResult as any).transferFunction.roll,
                    pitch: (overview.tfResult as any).transferFunction.pitch,
                    yaw: (overview.tfResult as any).transferFunction.yaw,
                  }}
                />
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}
