import React, { useEffect, useMemo, useState } from 'react';
import { NoiseComparisonChart } from '../TuningHistory/NoiseComparisonChart';
import { StepResponseComparison } from '../TuningHistory/StepResponseComparison';
import { extractFilterMetrics, extractPIDMetrics } from '@shared/utils/metricsExtract';
import type { FilterAnalysisResult, PIDAnalysisResult } from '@shared/types/analysis.types';
import type {
  CompletedTuningRecord,
  FilterMetricsSummary,
  PIDMetricsSummary,
} from '@shared/types/tuning-history.types';
import './PreviousSessionComparison.css';

interface PreviousSessionComparisonProps {
  mode: 'filter' | 'pid';
  /** Current live analysis (filter mode) */
  filterResult?: FilterAnalysisResult;
  /** Current live analysis (pid mode) */
  pidResult?: PIDAnalysisResult;
}

/** Newest archived record carrying comparable metrics for the given mode.
 * Prefers the verification-flight metrics (the previous session's FINAL state)
 * over its pre-tuning analysis metrics. */
function findPreviousMetrics(
  records: CompletedTuningRecord[],
  mode: 'filter' | 'pid'
): {
  record: CompletedTuningRecord;
  filter?: FilterMetricsSummary;
  pid?: PIDMetricsSummary;
} | null {
  for (const record of records) {
    if (mode === 'filter') {
      const metrics = record.verificationMetrics ?? record.filterMetrics;
      if (metrics?.spectrum) return { record, filter: metrics };
    } else {
      const metrics = record.verificationPidMetrics ?? record.pidMetrics;
      if (metrics) return { record, pid: metrics };
    }
  }
  return null;
}

/**
 * Before/after comparison against the last completed tuning session (P2.4).
 *
 * Shown inside the analysis steps when the profile has archived history:
 * overlays the previous session's compact spectrum (filter mode) or step
 * metrics (pid mode) against the current analysis with delta annotations.
 * Cross-scale comparisons (spectrum-scale or metrics-source mismatch) are
 * refused with an explanatory note instead of a misleading chart.
 */
export function PreviousSessionComparison({
  mode,
  filterResult,
  pidResult,
}: PreviousSessionComparisonProps) {
  const [records, setRecords] = useState<CompletedTuningRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.betaflight
      .getTuningHistory()
      .then((history) => {
        if (!cancelled) setRecords(history);
      })
      .catch(() => {
        if (!cancelled) setRecords([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const previous = useMemo(
    () => (records ? findPreviousMetrics(records, mode) : null),
    [records, mode]
  );

  const current = useMemo(() => {
    if (mode === 'filter' && filterResult) return { filter: extractFilterMetrics(filterResult) };
    if (mode === 'pid' && pidResult) return { pid: extractPIDMetrics(pidResult) };
    return null;
  }, [mode, filterResult, pidResult]);

  if (!previous || !current) return null;

  const completedDate = new Date(previous.record.completedAt).toLocaleDateString();

  let body: React.ReactNode;
  if (mode === 'filter' && previous.filter && current.filter) {
    if (previous.filter.spectrumScaleVersion !== current.filter.spectrumScaleVersion) {
      body = (
        <p className="previous-session-comparison-note">
          The previous session was analyzed with an older spectrum scale — its dB values are not
          comparable with this analysis. The comparison will be available after the next completed
          session.
        </p>
      );
    } else {
      body = <NoiseComparisonChart before={previous.filter} after={current.filter} />;
    }
  } else if (mode === 'pid' && previous.pid && current.pid) {
    const beforeSource = previous.pid.metricsSource ?? 'per_step';
    const afterSource = current.pid.metricsSource ?? 'per_step';
    if (beforeSource !== afterSource) {
      body = (
        <p className="previous-session-comparison-note">
          The previous session's step metrics were measured with a different method (
          {beforeSource.replace('_', '-')}) than this analysis ({afterSource.replace('_', '-')}) —
          overshoot and settling values are not directly comparable.
        </p>
      );
    } else {
      body = <StepResponseComparison before={previous.pid} after={current.pid} />;
    }
  } else {
    return null;
  }

  return (
    <div className="previous-session-comparison">
      <h4 className="previous-session-comparison-title">
        Compared to previous session ({completedDate})
      </h4>
      <p className="previous-session-comparison-subtitle">
        Previous = the last completed tuning session's{' '}
        {mode === 'filter' ? 'noise spectrum' : 'step response'}; Current = this flight.
      </p>
      {body}
    </div>
  );
}
