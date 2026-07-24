import React, { useEffect, useRef, useState } from 'react';
import type { FilterAnalysisResult, PIDAnalysisResult } from '@shared/types/analysis.types';
import type { AnalysisProgress } from '@shared/types/analysis.types';
import { RecommendationCard } from './RecommendationCard';
import { SpectrumChart } from './charts/SpectrumChart';
import { TFStepResponseChart } from './charts/TFStepResponseChart';
import { BodePlot } from './charts/BodePlot';
import { CHART_DESCRIPTIONS, METRIC_TOOLTIPS } from '@shared/constants/metricTooltips';

const PEAK_TYPE_LABELS: Record<string, string> = {
  motor_harmonic: 'Motor',
  frame_resonance: 'Frame',
  electrical: 'Electrical',
  unknown: 'Unknown',
};

interface QuickAnalysisStepProps {
  filterResult: FilterAnalysisResult | null;
  filterAnalyzing: boolean;
  filterProgress: AnalysisProgress | null;
  filterError: string | null;
  tfResult: PIDAnalysisResult | null;
  tfAnalyzing: boolean;
  tfError: string | null;
  runQuickAnalysis: () => Promise<void>;
  quickAnalyzing: boolean;
  onContinue: () => void;
}

export function QuickAnalysisStep({
  filterResult,
  filterAnalyzing,
  filterProgress,
  filterError,
  tfResult,
  tfAnalyzing,
  tfError,
  runQuickAnalysis,
  quickAnalyzing,
  onContinue,
}: QuickAnalysisStepProps) {
  const autoRunRef = useRef(false);
  const [bodeOpen, setBodeOpen] = useState(false);

  // Auto-run on mount
  useEffect(() => {
    if (!autoRunRef.current && !filterResult && !tfResult && !quickAnalyzing) {
      autoRunRef.current = true;
      runQuickAnalysis();
    }
  }, [filterResult, tfResult, quickAnalyzing, runQuickAnalysis]);

  const allDone = !quickAnalyzing && (filterResult || filterError) && (tfResult || tfError);
  const hasResults = filterResult || tfResult;

  const filterRecs = filterResult?.recommendations ?? [];
  const tfRecs = tfResult?.recommendations ?? [];
  const allRecs = [...filterRecs, ...tfRecs];

  return (
    <div className="analysis-section">
      <h3>Flash Tune Analysis</h3>
      <p className="analysis-description">
        Analyzing filters (noise spectrum) and PIDs (transfer function) from your flight data...
      </p>

      {quickAnalyzing && (
        <div className="analysis-progress">
          <span className="spinner" />
          <span>
            {filterAnalyzing && 'Analyzing noise spectrum...'}
            {!filterAnalyzing && tfAnalyzing && 'Analyzing transfer function...'}
            {filterAnalyzing && tfAnalyzing && 'Analyzing noise & transfer function...'}
          </span>
          {filterProgress && (
            <div className="analysis-progress-detail">
              Filter: {filterProgress.step} ({Math.round(filterProgress.percent)}%)
            </div>
          )}
        </div>
      )}

      {filterError && <div className="analysis-error">Filter analysis failed: {filterError}</div>}

      {tfError && (
        <div className="analysis-error">Transfer function analysis failed: {tfError}</div>
      )}

      {hasResults && (
        <>
          {filterResult && (
            <div className="summary-section">
              <h4>Filter Recommendations</h4>
              <p className="summary-section-subtitle">{filterResult.summary}</p>

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
                </p>
                <SpectrumChart
                  noise={filterResult.noise}
                  filterSettings={filterResult.filterSettings}
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

              {filterRecs.length === 0 && (
                <p className="analysis-no-recs">No filter changes recommended.</p>
              )}
              <div className="recommendation-list">
                {filterRecs.map((rec, i) => (
                  <RecommendationCard
                    key={`filter-${i}`}
                    setting={rec.setting}
                    currentValue={rec.currentValue}
                    recommendedValue={rec.recommendedValue}
                    reason={rec.reason}
                    impact={rec.impact}
                    confidence={rec.confidence}
                    unit="Hz"
                  />
                ))}
              </div>
            </div>
          )}

          {tfResult && (
            <div className="summary-section">
              <h4>PID Recommendations</h4>
              <p className="summary-section-subtitle">{tfResult.summary}</p>

              {tfResult.transferFunction?.syntheticStepResponse && (
                <>
                  <h4 className="chart-title">Transfer Function Step Response</h4>
                  <p className="chart-description">{CHART_DESCRIPTIONS.tfStepResponse}</p>
                  <TFStepResponseChart
                    stepResponse={tfResult.transferFunction.syntheticStepResponse}
                  />
                </>
              )}

              <button className="noise-details-toggle" onClick={() => setBodeOpen(!bodeOpen)}>
                {bodeOpen ? 'Hide frequency response (Bode)' : 'Show frequency response (Bode)'}
              </button>

              {bodeOpen && tfResult.transferFunction && (
                <>
                  <h4 className="chart-title">Bode Plot (Frequency Response)</h4>
                  <p className="chart-description">{CHART_DESCRIPTIONS.bodePlot}</p>
                  <BodePlot
                    bode={{
                      roll: {
                        frequencies: tfResult.transferFunction.roll.frequencies,
                        magnitude: tfResult.transferFunction.roll.magnitude,
                        phase: tfResult.transferFunction.roll.phase,
                      },
                      pitch: {
                        frequencies: tfResult.transferFunction.pitch.frequencies,
                        magnitude: tfResult.transferFunction.pitch.magnitude,
                        phase: tfResult.transferFunction.pitch.phase,
                      },
                      yaw: {
                        frequencies: tfResult.transferFunction.yaw.frequencies,
                        magnitude: tfResult.transferFunction.yaw.magnitude,
                        phase: tfResult.transferFunction.yaw.phase,
                      },
                    }}
                  />
                </>
              )}

              {tfRecs.length === 0 && (
                <p className="analysis-no-recs">No PID changes recommended.</p>
              )}
              <div className="recommendation-list">
                {tfRecs.map((rec, i) => (
                  <RecommendationCard
                    key={`tf-${i}`}
                    setting={rec.setting}
                    currentValue={rec.currentValue}
                    recommendedValue={rec.recommendedValue}
                    reason={rec.reason}
                    impact={rec.impact}
                    confidence={rec.confidence}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {allDone && (
        <div className="analysis-actions">
          <button
            className="wizard-btn wizard-btn-primary"
            onClick={onContinue}
            disabled={allRecs.length === 0}
          >
            {allRecs.length > 0 ? 'Continue to Summary' : 'No Changes to Apply'}
          </button>
          <button className="wizard-btn wizard-btn-secondary" onClick={() => runQuickAnalysis()}>
            Re-analyze
          </button>
        </div>
      )}
    </div>
  );
}
