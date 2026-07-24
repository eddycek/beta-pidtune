import React from 'react';
import { RecommendationCard, SETTING_LABELS } from './RecommendationCard';
import type {
  FilterAnalysisResult,
  PIDAnalysisResult,
  FilterRecommendation,
  PIDRecommendation,
} from '@shared/types/analysis.types';
import type {
  ApplyRecommendationsProgress,
  ApplyRecommendationsResult,
} from '@shared/types/ipc.types';
import type { TuningMode } from '@shared/types/tuning.types';
import { TUNING_MODE } from '@shared/constants';
import type { ApplyState } from '../../hooks/useTuningWizard';

interface TuningSummaryStepProps {
  filterResult: FilterAnalysisResult | null;
  pidResult: PIDAnalysisResult | null;
  /** Transfer function result — used as PID source in flash mode */
  tfResult?: PIDAnalysisResult | null;
  mode?: TuningMode;
  onExit: () => void;
  onApply: () => void;
  applyState: ApplyState;
  applyProgress: ApplyRecommendationsProgress | null;
  applyResult: ApplyRecommendationsResult | null;
  applyError: string | null;
}

function getChangeText(current: number, recommended: number): { text: string; className: string } {
  if (current === recommended) return { text: '0%', className: '' };
  if (current === 0) return { text: `+${recommended}`, className: 'positive' };
  const pct = Math.round(((recommended - current) / Math.abs(current)) * 100);
  if (pct === 0) return { text: '0%', className: '' };
  const sign = pct > 0 ? '+' : '';
  return {
    text: `${sign}${pct}%`,
    className: pct > 0 ? 'positive' : 'negative',
  };
}

function getApplyButtonLabel(mode: TuningMode, applyState: ApplyState, hasRecs: boolean): string {
  if (applyState === 'applying') return 'Applying...';
  if (!hasRecs) return 'Continue (No Changes)';
  switch (mode) {
    case 'filter':
      return 'Apply Filters';
    case 'pid':
      return 'Apply PIDs';
    case 'flash':
      return 'Apply All Changes';
    default:
      return 'Apply Changes';
  }
}

function getSuccessMessage(
  mode: TuningMode,
  applyResult: ApplyRecommendationsResult
): React.ReactNode {
  switch (mode) {
    case 'filter':
      return (
        <>
          <strong>Filters applied!</strong>
          <br />
          {applyResult.appliedFilters} filter{applyResult.appliedFilters !== 1 ? 's' : ''} written
          to FC.
          <br />
          Next: erase Blackbox, fly the PID test flight (stick snaps on all axes), then reconnect to
          continue tuning.
          <br />
          <em>After your next flight, check motor temperatures.</em>
        </>
      );
    case 'pid':
      return (
        <>
          <strong>PIDs applied!</strong>
          <br />
          {applyResult.appliedPIDs} PID{applyResult.appliedPIDs !== 1 ? 's' : ''} written to FC.
          <br />
          Fly a normal flight to verify the feel, then reconnect to download the verification log.
        </>
      );
    case 'flash':
      return (
        <>
          <strong>All changes applied!</strong>
          <br />
          {applyResult.appliedFilters} filter{applyResult.appliedFilters !== 1 ? 's' : ''} and{' '}
          {applyResult.appliedPIDs} PID{applyResult.appliedPIDs !== 1 ? 's' : ''} written to FC.
          <br />
          Fly a verification hover to confirm noise improvement, then reconnect to download the log.
        </>
      );
    default:
      return (
        <>
          <strong>Changes applied successfully!</strong>
          <br />
          {applyResult.appliedPIDs} PID{applyResult.appliedPIDs !== 1 ? 's' : ''} and{' '}
          {applyResult.appliedFilters} filter{applyResult.appliedFilters !== 1 ? 's' : ''} written
          to FC.
          <br />
          Your FC is rebooting. Close the wizard and reconnect via the Connection panel.
        </>
      );
  }
}

export function TuningSummaryStep({
  filterResult,
  pidResult,
  tfResult,
  mode = 'full',
  onExit,
  onApply,
  applyState,
  applyProgress,
  applyResult,
  applyError,
}: TuningSummaryStepProps) {
  const showFilter = mode !== TUNING_MODE.PID;
  const showPid = mode !== TUNING_MODE.FILTER;
  const filterRecs = showFilter ? (filterResult?.recommendations ?? []) : [];
  // In flash mode, PID recs come from transfer function analysis
  const pidSource = mode === TUNING_MODE.FLASH ? tfResult : pidResult;
  const pidRecs = showPid ? (pidSource?.recommendations ?? []) : [];
  const allRecs: (FilterRecommendation | PIDRecommendation)[] = [...filterRecs, ...pidRecs];
  const totalRecs = allRecs.length;

  const confidenceCounts = { high: 0, medium: 0, low: 0 };
  for (const rec of allRecs) {
    confidenceCounts[rec.confidence]++;
  }

  const isApplyDisabled = applyState === 'applying' || applyState === 'done';

  return (
    <div className="analysis-section">
      <h3>Tuning Summary</h3>
      {totalRecs === 0 ? (
        <p>Analysis complete — no changes recommended. Your current tune looks good!</p>
      ) : (
        <>
          <div className="summary-stats">
            {showFilter && (
              <span className="analysis-meta-pill">
                {filterRecs.length} filter change{filterRecs.length !== 1 ? 's' : ''}
              </span>
            )}
            {showPid && (
              <span className="analysis-meta-pill">
                {pidRecs.length} PID change{pidRecs.length !== 1 ? 's' : ''}
              </span>
            )}
            {confidenceCounts.high > 0 && (
              <span className="analysis-meta-pill confidence-high">
                {confidenceCounts.high} high confidence
              </span>
            )}
            {confidenceCounts.medium > 0 && (
              <span className="analysis-meta-pill confidence-medium">
                {confidenceCounts.medium} medium confidence
              </span>
            )}
            {confidenceCounts.low > 0 && (
              <span className="analysis-meta-pill confidence-low">
                {confidenceCounts.low} low confidence
              </span>
            )}
          </div>

          <table className="changes-table">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Current</th>
                <th>Recommended</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {allRecs.map((rec) => {
                const change = getChangeText(rec.currentValue, rec.recommendedValue);
                const isFilter = filterRecs.includes(rec as FilterRecommendation);
                const unit = isFilter ? ' Hz' : '';
                return (
                  <tr key={rec.setting}>
                    <td>{SETTING_LABELS[rec.setting] || rec.setting}</td>
                    <td>
                      {rec.currentValue}
                      {unit}
                    </td>
                    <td>
                      {rec.recommendedValue}
                      {unit}
                    </td>
                    <td>
                      <span className={`change-badge ${change.className}`}>{change.text}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {filterRecs.length > 0 && (
        <div className="summary-section">
          <h4>Filter Recommendations</h4>
          <p className="summary-section-subtitle">{filterResult?.summary}</p>
          <div className="recommendation-list">
            {filterRecs.map((rec) => (
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
        </div>
      )}

      {filterRecs.length > 0 && pidRecs.length > 0 && <hr className="summary-divider" />}

      {pidRecs.length > 0 && (
        <div className="summary-section">
          <h4>PID Recommendations</h4>
          <p className="summary-section-subtitle">{pidSource?.summary}</p>
          <div className="recommendation-list">
            {pidRecs.map((rec) => (
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
        </div>
      )}

      {applyState === 'done' && applyResult && (
        <div className="apply-success">{getSuccessMessage(mode, applyResult)}</div>
      )}

      {applyState === 'error' && applyError && <div className="analysis-error">{applyError}</div>}

      <div className="analysis-actions">
        {applyState === 'error' ? (
          <button className="wizard-btn wizard-btn-success" onClick={onApply}>
            Retry Apply
          </button>
        ) : applyState !== 'done' ? (
          <button
            className="wizard-btn wizard-btn-success"
            disabled={isApplyDisabled}
            onClick={onApply}
          >
            {getApplyButtonLabel(mode, applyState, totalRecs > 0)}
          </button>
        ) : null}
        <button
          className={
            applyState === 'done'
              ? 'wizard-btn wizard-btn-primary'
              : 'wizard-btn wizard-btn-secondary'
          }
          onClick={onExit}
        >
          {applyState === 'done' ? 'Close Wizard' : 'Exit Wizard'}
        </button>
      </div>

      {applyState === 'applying' && (
        <div className="applying-overlay">
          <div
            className="applying-overlay-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="applying-overlay-title"
          >
            <div className="applying-overlay-spinner" />
            <h3 id="applying-overlay-title">Applying changes</h3>
            <p>{applyProgress?.message ?? 'Preparing...'}</p>
            {applyProgress && (
              <div className="applying-overlay-progress">
                <div className="analysis-progress-bar">
                  <div
                    className="analysis-progress-fill"
                    style={{ width: `${applyProgress.percent}%` }}
                  />
                </div>
                <span className="applying-overlay-percent">{applyProgress.percent}%</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
