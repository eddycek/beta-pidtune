/**
 * System identification + what-if simulation (P3.2).
 *
 * Fits a low-order plant model (2nd order + transport delay) to the measured
 * closed-loop transfer function by dividing out the known PID controller,
 * then re-closes the loop with proposed gains to PREDICT the step response
 * before anything is applied to the quad.
 *
 * Method:
 *   1. Measured closed loop T(jω) (Wiener estimate, complex per bin)
 *   2. Open loop L = T / (1 − T)
 *   3. Plant estimate P̂ = L / C, with C(jω) the Betaflight PID in physical
 *      units (P·0.032029 + I·0.244381/jω + D·0.000529·jω — firmware scales)
 *   4. Coherence-weighted least-squares fit of
 *         P(jω) = K·e^(−jωτ) / (1 + 2ζ(jω/ωn) + (jω/ωn)²)
 *      over the stick band (grid search + refinement; K analytic per candidate)
 *   5. What-if: T′ = C′P/(1 + C′P) with proposed gains → impulse (IFFT) →
 *      synthetic step response + metrics
 *
 * Everything is gated on measurement coherence and fit quality, and results
 * are always labeled as predictions.
 */
import FFT from 'fft.js';
import type { BodeResult, TransferFunctionMetrics } from './TransferFunctionEstimator';
import {
  computeSyntheticStepResponse,
  extractMetrics,
  trimBode,
  type SyntheticStepResponse,
} from './TransferFunctionEstimator';

/** Betaflight firmware PID scale factors (pid.c) — map integer gains to physical units */
export const BF_PTERM_SCALE = 0.032029;
export const BF_ITERM_SCALE = 0.244381;
export const BF_DTERM_SCALE = 0.000529;

/** Frequency band used for plant fitting (stick-input energy lives here) */
export const SYSID_FIT_MIN_HZ = 2;
export const SYSID_FIT_MAX_HZ = 60;
/** Bins below this coherence are excluded from the fit */
export const SYSID_MIN_BIN_COHERENCE = 0.4;
/** Gates: mean coherence over the fit band and fit quality (1 − relative residual) */
export const SYSID_COHERENCE_GATE = 0.5;
export const SYSID_FIT_QUALITY_GATE = 0.6;
/** Minimum usable bins for a meaningful fit */
export const SYSID_MIN_BINS = 8;

/** Per-axis integer PID gains as configured in Betaflight */
export interface PIDGains {
  P: number;
  I: number;
  D: number;
}

/** Identified plant model: 2nd order + transport delay */
export interface PlantModel {
  /** DC gain (physical units) */
  gainK: number;
  /** Natural frequency in Hz */
  naturalFreqHz: number;
  /** Damping ratio ζ */
  damping: number;
  /** Transport delay in ms */
  delayMs: number;
  /** 1 − coherence-weighted relative residual of the fit (0-1, higher = better) */
  fitQuality: number;
}

/** Predicted closed-loop behavior for a set of gains */
export interface PredictedResponse {
  pids: PIDGains;
  response: SyntheticStepResponse;
  metrics: TransferFunctionMetrics;
}

/** Per-axis what-if result */
export interface AxisWhatIf {
  plant: PlantModel;
  /** Prediction with the CURRENT flight gains (sanity anchor vs measured) */
  current: PredictedResponse;
  /** Prediction with the PROPOSED gains */
  proposed: PredictedResponse;
}

/** Complex helpers (interleaved re/im pairs avoided — plain object math) */
interface Complex {
  re: number;
  im: number;
}

function cDiv(a: Complex, b: Complex): Complex {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

function cMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

function cAbs2(a: Complex): number {
  return a.re * a.re + a.im * a.im;
}

/** Betaflight PID controller frequency response C(jω) in physical units */
export function pidResponse(pids: PIDGains, omega: number): Complex {
  const kp = pids.P * BF_PTERM_SCALE;
  const ki = pids.I * BF_ITERM_SCALE;
  const kd = pids.D * BF_DTERM_SCALE;
  // C(jω) = kp + ki/(jω) + kd·jω = kp + j(kd·ω − ki/ω)
  return { re: kp, im: kd * omega - (omega > 1e-9 ? ki / omega : 0) };
}

/** 2nd-order + delay plant frequency response at ω */
function plantResponse(model: Omit<PlantModel, 'fitQuality'>, omega: number): Complex {
  const wn = 2 * Math.PI * model.naturalFreqHz;
  const r = omega / wn;
  // Denominator: 1 − r² + j·2ζr
  const denom: Complex = { re: 1 - r * r, im: 2 * model.damping * r };
  const base = cDiv({ re: model.gainK, im: 0 }, denom);
  const theta = -omega * (model.delayMs / 1000);
  return cMul(base, { re: Math.cos(theta), im: Math.sin(theta) });
}

/** Closed loop T = CP/(1+CP) at ω */
function closedLoopResponse(
  model: Omit<PlantModel, 'fitQuality'>,
  pids: PIDGains,
  omega: number
): Complex {
  const cp = cMul(pidResponse(pids, omega), plantResponse(model, omega));
  return cDiv(cp, { re: 1 + cp.re, im: cp.im });
}

/** Extracted per-bin plant estimate with its fit weight */
interface PlantBin {
  omega: number;
  plant: Complex;
  weight: number;
}

/**
 * Divide the known controller out of the measured closed loop to get
 * nonparametric plant estimates per bin. Bins where the loop inversion is
 * ill-conditioned (|1−T| small) or coherence is low are dropped.
 */
function estimatePlantBins(bode: BodeResult, pids: PIDGains): PlantBin[] {
  const bins: PlantBin[] = [];
  for (let i = 0; i < bode.frequencies.length; i++) {
    const f = bode.frequencies[i];
    if (f < SYSID_FIT_MIN_HZ || f > SYSID_FIT_MAX_HZ) continue;
    const gamma = bode.coherence?.[i] ?? 1;
    if (gamma < SYSID_MIN_BIN_COHERENCE) continue;

    const mag = Math.pow(10, bode.magnitude[i] / 20);
    const ph = (bode.phase[i] * Math.PI) / 180;
    const T: Complex = { re: mag * Math.cos(ph), im: mag * Math.sin(ph) };

    const oneMinusT: Complex = { re: 1 - T.re, im: -T.im };
    if (Math.sqrt(cAbs2(oneMinusT)) < 0.05) continue; // near-unity loop — inversion blows up

    const omega = 2 * Math.PI * f;
    const C = pidResponse(pids, omega);
    if (Math.sqrt(cAbs2(C)) < 1e-6) continue;

    const L = cDiv(T, oneMinusT);
    const plant = cDiv(L, C);
    // Weight: coherence × input energy (when available)
    const energy = bode.coherenceWeights?.[i] ?? 1;
    bins.push({ omega, plant, weight: gamma * gamma * energy });
  }

  // Normalize weights to a sane scale
  const maxW = Math.max(...bins.map((b) => b.weight), 1e-12);
  for (const b of bins) b.weight /= maxW;
  return bins;
}

/** Weighted relative residual of a candidate model against the plant bins.
 * K is solved analytically per candidate (linear in the model). */
function fitCandidate(
  bins: PlantBin[],
  naturalFreqHz: number,
  damping: number,
  delayMs: number
): { gainK: number; cost: number } {
  // M(jω) = model response with K = 1
  let num = 0; // Σ w·Re(P̂·conj(M))
  let den = 0; // Σ w·|M|²
  const models: Complex[] = [];
  for (const b of bins) {
    const m = plantResponse({ gainK: 1, naturalFreqHz, damping, delayMs }, b.omega);
    models.push(m);
    num += b.weight * (b.plant.re * m.re + b.plant.im * m.im);
    den += b.weight * cAbs2(m);
  }
  const gainK = den > 1e-12 ? num / den : 0;
  if (gainK <= 0) return { gainK: 0, cost: Infinity };

  let residual = 0;
  let total = 0;
  for (let i = 0; i < bins.length; i++) {
    const b = bins[i];
    const err: Complex = {
      re: b.plant.re - gainK * models[i].re,
      im: b.plant.im - gainK * models[i].im,
    };
    residual += b.weight * cAbs2(err);
    total += b.weight * cAbs2(b.plant);
  }
  return { gainK, cost: total > 1e-12 ? residual / total : Infinity };
}

/**
 * Identify a 2nd-order + delay plant model from the measured closed loop.
 * Returns null when the measurement can't support a trustworthy fit
 * (insufficient coherent bins, or the fit residual is too large).
 */
export function identifyPlant(bode: BodeResult, pids: PIDGains): PlantModel | null {
  const bins = estimatePlantBins(bode, pids);
  if (bins.length < SYSID_MIN_BINS) return null;

  // Coherence gate over the fit band
  if (bode.coherence) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < bode.frequencies.length; i++) {
      const f = bode.frequencies[i];
      if (f < SYSID_FIT_MIN_HZ || f > SYSID_FIT_MAX_HZ) continue;
      sum += bode.coherence[i];
      n++;
    }
    if (n > 0 && sum / n < SYSID_COHERENCE_GATE) return null;
  }

  // Coarse grid search
  const wnGrid: number[] = [];
  for (let f = 5; f <= 120; f *= 1.25) wnGrid.push(f);
  const zetaGrid = [0.3, 0.45, 0.6, 0.8, 1.0, 1.3, 1.7, 2.2];
  const tauGrid = [0, 2, 4, 6, 8, 12, 16, 20];

  let best = { wn: 30, zeta: 0.8, tau: 4, gainK: 0, cost: Infinity };
  for (const wn of wnGrid) {
    for (const zeta of zetaGrid) {
      for (const tau of tauGrid) {
        const { gainK, cost } = fitCandidate(bins, wn, zeta, tau);
        if (cost < best.cost) best = { wn, zeta, tau, gainK, cost };
      }
    }
  }

  // Local refinement (two passes, halving the step each time)
  let steps = { wn: best.wn * 0.12, zeta: 0.08, tau: 1 };
  for (let pass = 0; pass < 2; pass++) {
    for (const wn of [best.wn - steps.wn, best.wn, best.wn + steps.wn]) {
      for (const zeta of [best.zeta - steps.zeta, best.zeta, best.zeta + steps.zeta]) {
        for (const tau of [best.tau - steps.tau, best.tau, best.tau + steps.tau]) {
          if (wn < 2 || zeta < 0.1 || tau < 0) continue;
          const { gainK, cost } = fitCandidate(bins, wn, zeta, tau);
          if (cost < best.cost) best = { wn, zeta, tau, gainK, cost };
        }
      }
    }
    steps = { wn: steps.wn / 2, zeta: steps.zeta / 2, tau: steps.tau / 2 };
  }

  const fitQuality = Math.max(0, 1 - Math.sqrt(best.cost));
  if (fitQuality < SYSID_FIT_QUALITY_GATE) return null;

  return {
    gainK: best.gainK,
    naturalFreqHz: Math.round(best.wn * 10) / 10,
    damping: Math.round(best.zeta * 100) / 100,
    delayMs: Math.round(best.tau * 10) / 10,
    fitQuality: Math.round(fitQuality * 100) / 100,
  };
}

/** Frequency-grid size for analytic prediction (power of 2 for the IFFT) */
const PREDICT_WINDOW_SIZE = 4096;

/**
 * Predict the closed-loop step response and metrics for a set of gains,
 * by re-closing the identified plant with the new controller analytically.
 */
export function predictResponse(
  plant: PlantModel,
  pids: PIDGains,
  sampleRateHz: number
): PredictedResponse {
  const windowSize = PREDICT_WINDOW_SIZE;
  const numBins = windowSize / 2 + 1;
  const freqResolution = sampleRateHz / windowSize;

  const frequencies = new Float64Array(numBins);
  const magnitude = new Float64Array(numBins);
  const phase = new Float64Array(numBins);
  const hRe = new Float64Array(numBins);
  const hIm = new Float64Array(numBins);

  for (let i = 0; i < numBins; i++) {
    const f = i * freqResolution;
    frequencies[i] = f;
    const T =
      i === 0
        ? closedLoopResponse(plant, pids, 1e-6)
        : closedLoopResponse(plant, pids, 2 * Math.PI * f);
    hRe[i] = T.re;
    hIm[i] = T.im;
    const mag = Math.sqrt(cAbs2(T));
    magnitude[i] = mag > 1e-12 ? 20 * Math.log10(mag) : -240;
    phase[i] = (Math.atan2(T.im, T.re) * 180) / Math.PI;
  }

  // Impulse response via IFFT (conjugate-symmetric spectrum → real signal)
  const fft = new FFT(windowSize);
  const complexH = fft.createComplexArray();
  for (let i = 0; i < numBins; i++) {
    complexH[2 * i] = hRe[i];
    complexH[2 * i + 1] = hIm[i];
  }
  for (let i = 1; i < windowSize / 2; i++) {
    const mirror = windowSize - i;
    complexH[2 * mirror] = hRe[i];
    complexH[2 * mirror + 1] = -hIm[i];
  }
  const timeDomain = fft.createComplexArray();
  fft.inverseTransform(timeDomain, complexH);
  const impulse = new Float64Array(windowSize);
  for (let i = 0; i < windowSize; i++) impulse[i] = timeDomain[2 * i];

  const response = computeSyntheticStepResponse(impulse, sampleRateHz);
  const bode: BodeResult = { frequencies, magnitude, phase };
  const metrics = extractMetrics(trimBode(bode, 500), response, sampleRateHz);

  return { pids, response, metrics };
}

/**
 * Full what-if computation for one axis: identify the plant from the measured
 * closed loop with the flight gains, then predict responses for both the
 * current and the proposed gains. Null when gated (low coherence / poor fit).
 */
export function computeWhatIf(
  bode: BodeResult,
  currentPids: PIDGains,
  proposedPids: PIDGains,
  sampleRateHz: number
): AxisWhatIf | null {
  const plant = identifyPlant(bode, currentPids);
  if (!plant) return null;

  return {
    plant,
    current: predictResponse(plant, currentPids, sampleRateHz),
    proposed: predictResponse(plant, proposedPids, sampleRateHz),
  };
}
