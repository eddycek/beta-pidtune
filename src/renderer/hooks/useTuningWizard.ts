import { useState, useCallback, useEffect } from 'react';
import type { BlackboxLogSession, BlackboxParseProgress } from '@shared/types/blackbox.types';
import type {
  FilterAnalysisResult,
  PIDAnalysisResult,
  AnalysisProgress,
} from '@shared/types/analysis.types';
import type {
  ApplyRecommendationsProgress,
  ApplyRecommendationsResult,
} from '@shared/types/ipc.types';
import type { TuningMode } from '@shared/types/tuning.types';
import { TUNING_MODE } from '@shared/constants';
import { markIntentionalDisconnect } from './useConnection';

export type ApplyState = 'idle' | 'confirming' | 'applying' | 'done' | 'error';

export type WizardStep = 'guide' | 'session' | 'filter' | 'pid' | 'flash_analysis' | 'summary';

export interface UseTuningWizardReturn {
  mode: TuningMode;
  step: WizardStep;
  setStep: (step: WizardStep) => void;
  logId: string;
  sessionIndex: number;
  selectSession: (idx: number) => void;
  sessionSelected: boolean;
  sessions: BlackboxLogSession[] | null;

  // Parse
  parsing: boolean;
  parseProgress: BlackboxParseProgress | null;
  parseError: string | null;
  parseLog: () => Promise<void>;

  // Filter analysis
  filterResult: FilterAnalysisResult | null;
  filterAnalyzing: boolean;
  filterProgress: AnalysisProgress | null;
  filterError: string | null;
  runFilterAnalysis: () => Promise<void>;

  // PID analysis
  pidResult: PIDAnalysisResult | null;
  pidAnalyzing: boolean;
  pidProgress: AnalysisProgress | null;
  pidError: string | null;
  runPIDAnalysis: () => Promise<void>;

  // Transfer function analysis (Quick Tune)
  tfResult: PIDAnalysisResult | null;
  tfAnalyzing: boolean;
  tfError: string | null;
  runTransferFunctionAnalysis: () => Promise<void>;

  // Quick analysis (filter + TF in parallel)
  runQuickAnalysis: () => Promise<void>;
  quickAnalyzing: boolean;

  // Apply
  applyState: ApplyState;
  applyProgress: ApplyRecommendationsProgress | null;
  applyResult: ApplyRecommendationsResult | null;
  applyError: string | null;
  startApply: () => void;
  confirmApply: () => Promise<void>;
  cancelApply: () => void;
}

export function useTuningWizard(logId: string, mode: TuningMode = 'full'): UseTuningWizardReturn {
  // Skip guide for filter/pid modes — wizard opens from tuning session where flight is already done
  const [step, setStep] = useState<WizardStep>(mode === 'full' ? 'guide' : 'session');
  const [sessionIndex, setSessionIndex] = useState(0);
  const [sessionSelected, setSessionSelected] = useState(false);
  const [sessions, setSessions] = useState<BlackboxLogSession[] | null>(null);

  // Parse state
  const [parsing, setParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState<BlackboxParseProgress | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Filter analysis state
  const [filterResult, setFilterResult] = useState<FilterAnalysisResult | null>(null);
  const [filterAnalyzing, setFilterAnalyzing] = useState(false);
  const [filterProgress, setFilterProgress] = useState<AnalysisProgress | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);

  // PID analysis state
  const [pidResult, setPidResult] = useState<PIDAnalysisResult | null>(null);
  const [pidAnalyzing, setPidAnalyzing] = useState(false);
  const [pidProgress, setPidProgress] = useState<AnalysisProgress | null>(null);
  const [pidError, setPidError] = useState<string | null>(null);

  // Transfer function analysis state (Quick Tune)
  const [tfResult, setTfResult] = useState<PIDAnalysisResult | null>(null);
  const [tfAnalyzing, setTfAnalyzing] = useState(false);
  const [tfError, setTfError] = useState<string | null>(null);

  // Apply state
  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [applyProgress, setApplyProgress] = useState<ApplyRecommendationsProgress | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyRecommendationsResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const selectSession = useCallback((idx: number) => {
    setSessionIndex(idx);
    setSessionSelected(true);
  }, []);

  const parseLog = useCallback(async () => {
    setParsing(true);
    setParseProgress(null);
    setParseError(null);

    try {
      const result = await window.betaflight.parseBlackboxLog(logId, (progress) => {
        setParseProgress(progress);
      });

      if (!result.success || result.sessions.length === 0) {
        setParseError(result.error || 'No flight sessions found in log');
        return;
      }

      setSessions(result.sessions);

      // Auto-advance if single session
      if (result.sessions.length === 1) {
        setSessionIndex(0);
        setSessionSelected(true);
        // Skip to the correct step based on mode
        if (mode === TUNING_MODE.FLASH) {
          setStep('flash_analysis');
        } else if (mode === TUNING_MODE.PID) {
          setStep('pid');
        } else {
          setStep('filter');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to parse log';
      setParseError(message);
    } finally {
      setParsing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logId]);

  const runFilterAnalysis = useCallback(async () => {
    setFilterAnalyzing(true);
    setFilterProgress(null);
    setFilterError(null);

    try {
      const result = await window.betaflight.analyzeFilters(
        logId,
        sessionIndex,
        undefined,
        (progress) => {
          setFilterProgress(progress);
        }
      );

      setFilterResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to analyze filters';
      setFilterError(message);
    } finally {
      setFilterAnalyzing(false);
    }
  }, [logId, sessionIndex]);

  const runPIDAnalysis = useCallback(async () => {
    setPidAnalyzing(true);
    setPidProgress(null);
    setPidError(null);

    try {
      const result = await window.betaflight.analyzePID(
        logId,
        sessionIndex,
        undefined,
        (progress) => {
          setPidProgress(progress);
        }
      );

      setPidResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to analyze PIDs';
      setPidError(message);
    } finally {
      setPidAnalyzing(false);
    }
  }, [logId, sessionIndex]);

  const runTransferFunctionAnalysis = useCallback(async () => {
    setTfAnalyzing(true);
    setTfError(null);

    try {
      const result = await window.betaflight.analyzeTransferFunction(logId, sessionIndex);
      setTfResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to analyze transfer function';
      setTfError(message);
    } finally {
      setTfAnalyzing(false);
    }
  }, [logId, sessionIndex]);

  const runQuickAnalysis = useCallback(async () => {
    // Run filter + transfer function analyses in parallel
    await Promise.all([runFilterAnalysis(), runTransferFunctionAnalysis()]);
  }, [runFilterAnalysis, runTransferFunctionAnalysis]);

  const quickAnalyzing = filterAnalyzing || tfAnalyzing;

  // Subscribe to apply progress events
  useEffect(() => {
    const cleanup = window.betaflight.onApplyProgress((progress) => {
      setApplyProgress(progress);
    });
    return cleanup;
  }, []);

  const cancelApply = useCallback(() => {
    setApplyState('idle');
  }, []);

  const confirmApply = useCallback(async () => {
    setApplyState('applying');
    setApplyProgress(null);
    setApplyError(null);
    setApplyResult(null);

    try {
      // In mode-specific modes, only send relevant recommendations
      const filterRecs =
        mode === TUNING_MODE.PID
          ? []
          : (filterResult?.recommendations ?? []).filter(
              (r) => !r.informational && r.currentValue !== r.recommendedValue
            );
      // For Flash Tune mode, PID recs come from transfer function analysis
      const allPidRecs =
        mode === TUNING_MODE.FILTER
          ? []
          : mode === TUNING_MODE.FLASH
            ? (tfResult?.recommendations ?? [])
            : (pidResult?.recommendations ?? []);
      // Informational recs (P-HI-P, P-PIDLIM, P-DTE-BLOCK, …) are advisory-only
      // and must never be auto-applied.
      const pidRecs = allPidRecs.filter(
        (r) =>
          !r.informational && r.setting.startsWith('pid_') && r.currentValue !== r.recommendedValue
      );
      // CLI-based settings: feedforward_*, iterm_relax_*, and any other non-MSP settings
      const ffRecs = allPidRecs.filter(
        (r) =>
          !r.informational && !r.setting.startsWith('pid_') && r.currentValue !== r.recommendedValue
      );

      const hasChanges = filterRecs.length + pidRecs.length + ffRecs.length > 0;

      // Only mark intentional disconnect when changes will cause a reboot
      if (hasChanges) {
        markIntentionalDisconnect();
      }

      const result = await window.betaflight.applyRecommendations({
        filterRecommendations: filterRecs,
        pidRecommendations: pidRecs,
        feedforwardRecommendations: ffRecs,
      });

      setApplyResult(result);
      setApplyState('done');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to apply recommendations';
      setApplyError(message);
      setApplyState('error');
    }
  }, [filterResult, pidResult, tfResult, mode]);

  const startApply = useCallback(() => {
    // Check if there are any recommendations to apply
    const fRecs = mode === TUNING_MODE.PID ? [] : (filterResult?.recommendations ?? []);
    const pRecs =
      mode === TUNING_MODE.FILTER
        ? []
        : mode === TUNING_MODE.FLASH
          ? (tfResult?.recommendations ?? [])
          : (pidResult?.recommendations ?? []);
    const totalRecs = fRecs.length + pRecs.length;

    if (totalRecs === 0) {
      // No changes — skip confirmation modal, apply directly (returns immediately)
      confirmApply();
    } else {
      setApplyState('confirming');
    }
  }, [mode, filterResult, pidResult, tfResult, confirmApply]);

  return {
    mode,
    step,
    setStep,
    logId,
    sessionIndex,
    selectSession,
    sessionSelected,
    sessions,
    parsing,
    parseProgress,
    parseError,
    parseLog,
    filterResult,
    filterAnalyzing,
    filterProgress,
    filterError,
    runFilterAnalysis,
    pidResult,
    pidAnalyzing,
    pidProgress,
    pidError,
    runPIDAnalysis,
    tfResult,
    tfAnalyzing,
    tfError,
    runTransferFunctionAnalysis,
    runQuickAnalysis,
    quickAnalyzing,
    applyState,
    applyProgress,
    applyResult,
    applyError,
    startApply,
    confirmApply,
    cancelApply,
  };
}
