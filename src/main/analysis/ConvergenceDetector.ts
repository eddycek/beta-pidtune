/**
 * Convergence detection for tuning sessions.
 *
 * Compares initial and verification metrics to determine if further tuning
 * would yield meaningful improvement. Prevents infinite tuning loops.
 */
import type { ConvergenceResult, ConvergenceDetail } from '@shared/types/analysis.types';
import type {
  FilterMetricsSummary,
  PIDMetricsSummary,
  TransferFunctionMetricsSummary,
} from '@shared/types/tuning-history.types';
import {
  FILTER_CONVERGENCE_DB,
  FILTER_DIMINISHING_DB,
  PID_CONVERGENCE_OVERSHOOT_PCT,
  PID_CONVERGENCE_SETTLING_MS,
  PID_DIMINISHING_OVERSHOOT_PCT,
  PID_DIMINISHING_SETTLING_MS,
  FLASH_CONVERGENCE_BW_HZ,
  FLASH_CONVERGENCE_PM_DEG,
  FLASH_DIMINISHING_BW_HZ,
  FLASH_DIMINISHING_PM_DEG,
  FILTER_CONVERGENCE_DB as FLASH_NOISE_CONVERGENCE_DB,
} from './constants';

/** True when two filter summaries were measured on different spectrum scale
 * versions (absent field = legacy v1). Their dB values differ by ≈10 dB for
 * the same physical noise and must not be compared directly. */
function scaleVersionsDiffer(a: FilterMetricsSummary, b: FilterMetricsSummary): boolean {
  return (a.spectrumScaleVersion ?? 1) !== (b.spectrumScaleVersion ?? 1);
}

/**
 * Detect filter tuning convergence.
 *
 * Compares per-axis noise floor deltas. Uses worst-axis (weakest link) logic.
 * Only declares convergence when improvement is genuinely small AND positive (not regression).
 */
export function detectFilterConvergence(
  initial: FilterMetricsSummary,
  verification: FilterMetricsSummary
): ConvergenceResult {
  // Cross-scale comparison guard: a v1-stored initial vs a v2 verification
  // (session spanning an app update) carries a phantom ~+10 dB shift that
  // would read as a huge regression. Report neutral "continue" instead.
  if (scaleVersionsDiffer(initial, verification)) {
    return {
      status: 'continue',
      improvementDelta: 0,
      meaningfulThreshold: FILTER_CONVERGENCE_DB,
      message:
        'The two flights were analyzed on different noise-scale versions (app update between ' +
        'them) — their dB values are not directly comparable. Fly a fresh analysis + ' +
        'verification pair to measure improvement.',
      details: [],
    };
  }

  const details: ConvergenceDetail[] = [];

  const axes = ['roll', 'pitch', 'yaw'] as const;
  let worstDelta = 0;

  for (const axis of axes) {
    const initFloor = initial[axis].noiseFloorDb;
    const verFloor = verification[axis].noiseFloorDb;
    const delta = verFloor - initFloor; // negative = improvement

    details.push({
      metric: `${axis} noise floor`,
      initialValue: initFloor,
      verificationValue: verFloor,
      delta,
      unit: 'dB',
    });

    // Worst axis = largest positive delta (most regression) or smallest negative delta (least improvement)
    if (delta > worstDelta || details.length === 1) {
      worstDelta = delta;
    }
  }

  const absDelta = Math.abs(worstDelta);

  // Regression: don't declare convergence even if delta is small
  if (worstDelta > 0) {
    return {
      status: 'continue',
      improvementDelta: worstDelta,
      meaningfulThreshold: FILTER_CONVERGENCE_DB,
      message: `Noise floor regressed by ${worstDelta.toFixed(1)} dB on the worst axis. Review flight conditions or filter settings.`,
      details,
    };
  }

  if (absDelta < FILTER_CONVERGENCE_DB) {
    return {
      status: 'converged',
      improvementDelta: worstDelta,
      meaningfulThreshold: FILTER_CONVERGENCE_DB,
      message:
        'Filters are optimized for this quad. Further tuning is unlikely to produce measurable improvement.',
      details,
    };
  }

  if (absDelta < FILTER_DIMINISHING_DB) {
    return {
      status: 'diminishing_returns',
      improvementDelta: worstDelta,
      meaningfulThreshold: FILTER_DIMINISHING_DB,
      message: `Improvement is within normal flight-to-flight variation (${absDelta.toFixed(1)} dB). Another iteration is unlikely to help.`,
      details,
    };
  }

  return {
    status: 'continue',
    improvementDelta: worstDelta,
    meaningfulThreshold: FILTER_CONVERGENCE_DB,
    message: `Noise floor improved by ${absDelta.toFixed(1)} dB. Tuning is progressing well.`,
    details,
  };
}

/**
 * Detect PID tuning convergence.
 *
 * Compares per-axis overshoot and settling time deltas.
 */
export function detectPIDConvergence(
  initial: PIDMetricsSummary,
  verification: PIDMetricsSummary
): ConvergenceResult {
  const details: ConvergenceDetail[] = [];
  const axes = ['roll', 'pitch', 'yaw'] as const;

  let maxOvershootDelta = 0;
  let maxSettlingDelta = 0;

  for (const axis of axes) {
    const overshootDelta = Math.abs(verification[axis].meanOvershoot - initial[axis].meanOvershoot);
    const settlingDelta = Math.abs(
      verification[axis].meanSettlingTimeMs - initial[axis].meanSettlingTimeMs
    );

    details.push({
      metric: `${axis} overshoot`,
      initialValue: initial[axis].meanOvershoot,
      verificationValue: verification[axis].meanOvershoot,
      delta: verification[axis].meanOvershoot - initial[axis].meanOvershoot,
      unit: '%',
    });
    details.push({
      metric: `${axis} settling time`,
      initialValue: initial[axis].meanSettlingTimeMs,
      verificationValue: verification[axis].meanSettlingTimeMs,
      delta: verification[axis].meanSettlingTimeMs - initial[axis].meanSettlingTimeMs,
      unit: 'ms',
    });

    maxOvershootDelta = Math.max(maxOvershootDelta, overshootDelta);
    maxSettlingDelta = Math.max(maxSettlingDelta, settlingDelta);
  }

  const primaryDelta = maxOvershootDelta;

  if (
    maxOvershootDelta < PID_CONVERGENCE_OVERSHOOT_PCT &&
    maxSettlingDelta < PID_CONVERGENCE_SETTLING_MS
  ) {
    return {
      status: 'converged',
      improvementDelta: primaryDelta,
      meaningfulThreshold: PID_CONVERGENCE_OVERSHOOT_PCT,
      message:
        'PID response is stable. Overshoot and settling time are within measurement noise across sessions.',
      details,
    };
  }

  if (
    maxOvershootDelta < PID_DIMINISHING_OVERSHOOT_PCT &&
    maxSettlingDelta < PID_DIMINISHING_SETTLING_MS
  ) {
    return {
      status: 'diminishing_returns',
      improvementDelta: primaryDelta,
      meaningfulThreshold: PID_DIMINISHING_OVERSHOOT_PCT,
      message: `PID changes are small (${maxOvershootDelta.toFixed(1)}% overshoot, ${maxSettlingDelta.toFixed(0)}ms settling). Another iteration may not be noticeable in flight.`,
      details,
    };
  }

  return {
    status: 'continue',
    improvementDelta: primaryDelta,
    meaningfulThreshold: PID_CONVERGENCE_OVERSHOOT_PCT,
    message: `PID response changed significantly (${maxOvershootDelta.toFixed(1)}% overshoot, ${maxSettlingDelta.toFixed(0)}ms settling). Tuning is progressing.`,
    details,
  };
}

/**
 * Detect Flash Tune convergence.
 *
 * Combines filter metrics (noise floor) + transfer function metrics (bandwidth, phase margin).
 */
export function detectFlashConvergence(
  initial: TransferFunctionMetricsSummary,
  verification: TransferFunctionMetricsSummary,
  initialFilter?: FilterMetricsSummary | null,
  verificationFilter?: FilterMetricsSummary | null
): ConvergenceResult {
  const details: ConvergenceDetail[] = [];
  const axes = ['roll', 'pitch', 'yaw'] as const;

  // Bandwidth and phase margin deltas
  let maxBwDelta = 0;
  let maxPmDelta = 0;

  for (const axis of axes) {
    const bwDelta = Math.abs(verification[axis].bandwidthHz - initial[axis].bandwidthHz);

    details.push({
      metric: `${axis} bandwidth`,
      initialValue: initial[axis].bandwidthHz,
      verificationValue: verification[axis].bandwidthHz,
      delta: verification[axis].bandwidthHz - initial[axis].bandwidthHz,
      unit: 'Hz',
    });
    maxBwDelta = Math.max(maxBwDelta, bwDelta);

    // Phase margin: only when both sides carry a MEASURED margin. When the
    // gain never crossed 0 dB, phaseMarginDeg is a 90° placeholder — diffing
    // it against a measured ~45° would fabricate a ±45° "change".
    const pmMeasured =
      initial[axis].phaseMarginCrossingFound !== false &&
      verification[axis].phaseMarginCrossingFound !== false;
    if (pmMeasured) {
      const pmDelta = Math.abs(verification[axis].phaseMarginDeg - initial[axis].phaseMarginDeg);
      details.push({
        metric: `${axis} phase margin`,
        initialValue: initial[axis].phaseMarginDeg,
        verificationValue: verification[axis].phaseMarginDeg,
        delta: verification[axis].phaseMarginDeg - initial[axis].phaseMarginDeg,
        unit: '°',
      });
      maxPmDelta = Math.max(maxPmDelta, pmDelta);
    }
  }

  // Optional noise floor delta (skip when the two flights were measured on
  // different spectrum scale versions — dB values are not comparable)
  let noiseConverged = true;
  if (
    initialFilter &&
    verificationFilter &&
    !scaleVersionsDiffer(initialFilter, verificationFilter)
  ) {
    for (const axis of axes) {
      const noiseDelta = Math.abs(
        verificationFilter[axis].noiseFloorDb - initialFilter[axis].noiseFloorDb
      );
      details.push({
        metric: `${axis} noise floor`,
        initialValue: initialFilter[axis].noiseFloorDb,
        verificationValue: verificationFilter[axis].noiseFloorDb,
        delta: verificationFilter[axis].noiseFloorDb - initialFilter[axis].noiseFloorDb,
        unit: 'dB',
      });
      if (noiseDelta >= FLASH_NOISE_CONVERGENCE_DB) {
        noiseConverged = false;
      }
    }
  }

  const primaryDelta = maxBwDelta;

  if (
    maxBwDelta < FLASH_CONVERGENCE_BW_HZ &&
    maxPmDelta < FLASH_CONVERGENCE_PM_DEG &&
    noiseConverged
  ) {
    return {
      status: 'converged',
      improvementDelta: primaryDelta,
      meaningfulThreshold: FLASH_CONVERGENCE_BW_HZ,
      message: 'Transfer function and noise profile are stable. Tuning is complete for this quad.',
      details,
    };
  }

  if (maxBwDelta < FLASH_DIMINISHING_BW_HZ && maxPmDelta < FLASH_DIMINISHING_PM_DEG) {
    return {
      status: 'diminishing_returns',
      improvementDelta: primaryDelta,
      meaningfulThreshold: FLASH_DIMINISHING_BW_HZ,
      message: `Changes are small (${maxBwDelta.toFixed(1)} Hz BW, ${maxPmDelta.toFixed(1)}° PM). Another iteration may not be noticeable.`,
      details,
    };
  }

  return {
    status: 'continue',
    improvementDelta: primaryDelta,
    meaningfulThreshold: FLASH_CONVERGENCE_BW_HZ,
    message: `Transfer function changed significantly (${maxBwDelta.toFixed(1)} Hz BW, ${maxPmDelta.toFixed(1)}° PM). Tuning is progressing.`,
    details,
  };
}
