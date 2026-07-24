import { describe, it, expect } from 'vitest';
import {
  identifyPlant,
  predictResponse,
  computeWhatIf,
  pidResponse,
  BF_PTERM_SCALE,
  type PIDGains,
  type PlantModel,
} from './SystemIdentifier';
import type { BodeResult } from './TransferFunctionEstimator';

/** Analytic closed-loop bode for a known 2nd-order + delay plant and BF PID */
function makeClosedLoopBode(
  plant: { gainK: number; naturalFreqHz: number; damping: number; delayMs: number },
  pids: PIDGains,
  opts: { coherence?: number; maxHz?: number } = {}
): BodeResult {
  const maxHz = opts.maxHz ?? 100;
  const df = 0.5;
  const n = Math.floor(maxHz / df) + 1;
  const frequencies = new Float64Array(n);
  const magnitude = new Float64Array(n);
  const phase = new Float64Array(n);
  const coherence = new Float64Array(n).fill(opts.coherence ?? 0.95);
  const weights = new Float64Array(n).fill(1);

  const wn = 2 * Math.PI * plant.naturalFreqHz;
  for (let i = 0; i < n; i++) {
    const f = Math.max(i * df, 1e-3);
    frequencies[i] = i * df;
    const w = 2 * Math.PI * f;

    // Plant P(jw) = K e^{-jwτ} / (1 - r² + j2ζr)
    const r = w / wn;
    const dRe = 1 - r * r;
    const dIm = 2 * plant.damping * r;
    const dAbs2 = dRe * dRe + dIm * dIm;
    let pRe = (plant.gainK * dRe) / dAbs2;
    let pIm = (-plant.gainK * dIm) / dAbs2;
    const th = -w * (plant.delayMs / 1000);
    const c = Math.cos(th);
    const s = Math.sin(th);
    [pRe, pIm] = [pRe * c - pIm * s, pRe * s + pIm * c];

    // Controller
    const C = pidResponse(pids, w);

    // CP and T = CP/(1+CP)
    const cpRe = C.re * pRe - C.im * pIm;
    const cpIm = C.re * pIm + C.im * pRe;
    const denRe = 1 + cpRe;
    const denIm = cpIm;
    const dd = denRe * denRe + denIm * denIm;
    const tRe = (cpRe * denRe + cpIm * denIm) / dd;
    const tIm = (cpIm * denRe - cpRe * denIm) / dd;

    const mag = Math.sqrt(tRe * tRe + tIm * tIm);
    magnitude[i] = mag > 1e-12 ? 20 * Math.log10(mag) : -240;
    phase[i] = (Math.atan2(tIm, tRe) * 180) / Math.PI;
  }

  return { frequencies, magnitude, phase, coherence, coherenceWeights: weights };
}

const KNOWN_PLANT = { gainK: 8, naturalFreqHz: 30, damping: 0.7, delayMs: 5 };
const FLIGHT_PIDS: PIDGains = { P: 45, I: 80, D: 40 };

describe('identifyPlant (P3.2)', () => {
  it('recovers a known 2nd-order plant from its closed-loop response', () => {
    const bode = makeClosedLoopBode(KNOWN_PLANT, FLIGHT_PIDS);
    const model = identifyPlant(bode, FLIGHT_PIDS);
    expect(model).not.toBeNull();
    expect(model!.fitQuality).toBeGreaterThan(0.8);
    // Natural frequency within 20%, damping within ±0.2, delay within ±3 ms
    expect(model!.naturalFreqHz).toBeGreaterThan(KNOWN_PLANT.naturalFreqHz * 0.8);
    expect(model!.naturalFreqHz).toBeLessThan(KNOWN_PLANT.naturalFreqHz * 1.2);
    expect(Math.abs(model!.damping - KNOWN_PLANT.damping)).toBeLessThan(0.2);
    expect(Math.abs(model!.delayMs - KNOWN_PLANT.delayMs)).toBeLessThan(3);
  });

  it('returns null when coherence is below the gate', () => {
    const bode = makeClosedLoopBode(KNOWN_PLANT, FLIGHT_PIDS, { coherence: 0.3 });
    expect(identifyPlant(bode, FLIGHT_PIDS)).toBeNull();
  });

  it('returns null when too few usable bins exist', () => {
    const bode = makeClosedLoopBode(KNOWN_PLANT, FLIGHT_PIDS, { maxHz: 3 });
    expect(identifyPlant(bode, FLIGHT_PIDS)).toBeNull();
  });
});

describe('predictResponse (P3.2)', () => {
  const model: PlantModel = { ...KNOWN_PLANT, fitQuality: 0.95 };

  it('predicts a settled unity step response for a sane closed loop', () => {
    const pred = predictResponse(model, FLIGHT_PIDS, 2000);
    expect(pred.response.response.length).toBeGreaterThan(10);
    // Step response should settle near 1.0 (closed loop with integrator)
    const tail = pred.response.response.slice(-20);
    const tailMean = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(tailMean).toBeGreaterThan(0.85);
    expect(tailMean).toBeLessThan(1.15);
    expect(pred.metrics.riseTimeMs).toBeGreaterThan(0);
  });

  it('predicts less overshoot when D is raised', () => {
    // Lightly damped plant + hot P so the low-D loop visibly overshoots
    const oscillatory: PlantModel = {
      gainK: 8,
      naturalFreqHz: 25,
      damping: 0.25,
      delayMs: 8,
      fitQuality: 0.95,
    };
    const lowD = predictResponse(oscillatory, { P: 80, I: 80, D: 5 }, 2000);
    const highD = predictResponse(oscillatory, { P: 80, I: 80, D: 60 }, 2000);
    expect(lowD.metrics.overshootPercent).toBeGreaterThan(5);
    expect(highD.metrics.overshootPercent).toBeLessThan(lowD.metrics.overshootPercent);
  });

  it('predicts faster rise when P is raised', () => {
    const lowP = predictResponse(model, { P: 30, I: 80, D: 40 }, 2000);
    const highP = predictResponse(model, { P: 70, I: 80, D: 40 }, 2000);
    expect(highP.metrics.riseTimeMs).toBeLessThanOrEqual(lowP.metrics.riseTimeMs);
  });
});

describe('computeWhatIf (P3.2)', () => {
  it('produces current + proposed predictions from a measured loop', () => {
    const bode = makeClosedLoopBode(KNOWN_PLANT, FLIGHT_PIDS);
    const proposed: PIDGains = { P: 50, I: 80, D: 48 };
    const whatIf = computeWhatIf(bode, FLIGHT_PIDS, proposed, 2000);
    expect(whatIf).not.toBeNull();
    expect(whatIf!.current.pids).toEqual(FLIGHT_PIDS);
    expect(whatIf!.proposed.pids).toEqual(proposed);
    // The current-gains prediction should roughly reproduce the measured
    // response character (same plant, same gains)
    expect(whatIf!.current.metrics.overshootPercent).toBeGreaterThanOrEqual(0);
  });

  it('is gated on identification quality', () => {
    const bode = makeClosedLoopBode(KNOWN_PLANT, FLIGHT_PIDS, { coherence: 0.2 });
    expect(computeWhatIf(bode, FLIGHT_PIDS, { P: 50, I: 80, D: 48 }, 2000)).toBeNull();
  });
});

describe('pidResponse', () => {
  it('matches the BF P-term scale at DC-ish frequencies with I=D=0', () => {
    const c = pidResponse({ P: 100, I: 0, D: 0 }, 10);
    expect(c.re).toBeCloseTo(100 * BF_PTERM_SCALE, 6);
    expect(c.im).toBeCloseTo(0, 6);
  });
});
