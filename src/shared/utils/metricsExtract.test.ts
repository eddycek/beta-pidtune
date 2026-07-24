import { describe, it, expect } from 'vitest';
import {
  downsampleSpectrum,
  downsampleStepResponse,
  extractFilterMetrics,
  extractPIDMetrics,
  extractTransferFunctionMetrics,
  extractThrottleSpectrogram,
} from './metricsExtract';
import type {
  FilterAnalysisResult,
  PIDAnalysisResult,
  ThrottleSpectrogramResult,
} from '../types/analysis.types';

describe('downsampleSpectrum', () => {
  it('returns correct number of bins', () => {
    const freqs = Float64Array.from({ length: 1000 }, (_, i) => i * 4); // 0-3996 Hz
    const mags = Float64Array.from({ length: 1000 }, (_, i) => -60 + i * 0.01);
    const result = downsampleSpectrum(freqs, { roll: mags, pitch: mags, yaw: mags });
    expect(result.frequencies).toHaveLength(128);
    expect(result.roll).toHaveLength(128);
    expect(result.pitch).toHaveLength(128);
    expect(result.yaw).toHaveLength(128);
  });

  it('respects custom targetBins parameter', () => {
    const freqs = Float64Array.from({ length: 500 }, (_, i) => i * 8);
    const mags = Float64Array.from({ length: 500 }, () => -40);
    const result = downsampleSpectrum(freqs, { roll: mags, pitch: mags, yaw: mags }, 64);
    expect(result.frequencies).toHaveLength(64);
  });

  it('handles empty input', () => {
    const empty = new Float64Array(0);
    const result = downsampleSpectrum(empty, { roll: empty, pitch: empty, yaw: empty });
    expect(result.frequencies).toHaveLength(0);
    expect(result.roll).toHaveLength(0);
  });

  it('interpolates values accurately', () => {
    // Linear ramp: 0 Hz = -80 dB, 4000 Hz = 0 dB → slope = 0.02 dB/Hz
    const freqs = Float64Array.from({ length: 401 }, (_, i) => i * 10); // 0-4000 Hz, step 10
    const mags = Float64Array.from({ length: 401 }, (_, i) => -80 + i * 0.2);
    const result = downsampleSpectrum(freqs, { roll: mags, pitch: mags, yaw: mags }, 8, 4000);

    // Bin 0: center = 250 Hz → -80 + 250*0.02 = -75 dB
    expect(result.frequencies[0]).toBeCloseTo(250, 0);
    expect(result.roll[0]).toBeCloseTo(-75, 1);
  });

  it('rounds frequencies to 0.1 Hz and values to 2 decimal places', () => {
    const freqs = Float64Array.from([0, 100, 200, 300, 400]);
    const mags = Float64Array.from([-60.1234, -55.5678, -50.9999, -45.0001, -40.5555]);
    const result = downsampleSpectrum(freqs, { roll: mags, pitch: mags, yaw: mags }, 4, 400);

    for (const f of result.frequencies) {
      expect(Math.round(f * 10) / 10).toBe(f);
    }
    for (const v of result.roll) {
      expect(Math.round(v * 100) / 100).toBe(v);
    }
  });

  it('clamps to actual data range when maxFreqHz exceeds data', () => {
    const freqs = Float64Array.from([0, 500, 1000]);
    const mags = Float64Array.from([-60, -40, -20]);
    const result = downsampleSpectrum(freqs, { roll: mags, pitch: mags, yaw: mags }, 4, 8000);

    // maxFreqHz clamped to 1000, so bins span 0-1000
    expect(result.frequencies[3]).toBeLessThanOrEqual(1000);
  });

  it('preserves per-axis differences', () => {
    const freqs = Float64Array.from([0, 1000, 2000, 3000, 4000]);
    const rollMags = Float64Array.from([-60, -50, -40, -30, -20]);
    const pitchMags = Float64Array.from([-70, -60, -50, -40, -30]);
    const yawMags = Float64Array.from([-80, -70, -60, -50, -40]);
    const result = downsampleSpectrum(freqs, { roll: rollMags, pitch: pitchMags, yaw: yawMags }, 4);

    // Each axis should have different values
    expect(result.roll[0]).not.toBe(result.pitch[0]);
    expect(result.pitch[0]).not.toBe(result.yaw[0]);
    // Roll should be higher (less negative) than pitch, pitch higher than yaw
    expect(result.roll[0]).toBeGreaterThan(result.pitch[0]);
    expect(result.pitch[0]).toBeGreaterThan(result.yaw[0]);
  });
});

function makeFilterResult(overrides?: Partial<FilterAnalysisResult>): FilterAnalysisResult {
  const freqs = Float64Array.from([0, 500, 1000, 1500, 2000]);
  const mags = Float64Array.from([-60, -50, -45, -40, -35]);
  return {
    noise: {
      roll: {
        spectrum: { frequencies: freqs, magnitudes: mags },
        noiseFloorDb: -55.123,
        peaks: [{ frequency: 150, amplitude: 10, type: 'frame_resonance' }],
      },
      pitch: {
        spectrum: { frequencies: freqs, magnitudes: Float64Array.from([-62, -52, -47, -42, -37]) },
        noiseFloorDb: -57.456,
        peaks: [],
      },
      yaw: {
        spectrum: { frequencies: freqs, magnitudes: Float64Array.from([-65, -55, -50, -45, -40]) },
        noiseFloorDb: -60.789,
        peaks: [
          { frequency: 100, amplitude: 8, type: 'motor_harmonic' },
          { frequency: 300, amplitude: 5, type: 'unknown' },
        ],
      },
      overallLevel: 'medium',
    },
    recommendations: [],
    summary: 'Moderate noise detected.',
    analysisTimeMs: 250,
    sessionIndex: 0,
    segmentsUsed: 3,
    rpmFilterActive: true,
    ...overrides,
  };
}

describe('extractFilterMetrics', () => {
  it('extracts all fields correctly', () => {
    const result = makeFilterResult();
    const metrics = extractFilterMetrics(result);

    expect(metrics.noiseLevel).toBe('medium');
    expect(metrics.roll.noiseFloorDb).toBe(-55.12);
    expect(metrics.roll.peakCount).toBe(1);
    expect(metrics.pitch.noiseFloorDb).toBe(-57.46);
    expect(metrics.pitch.peakCount).toBe(0);
    expect(metrics.yaw.noiseFloorDb).toBe(-60.79);
    expect(metrics.yaw.peakCount).toBe(2);
    expect(metrics.segmentsUsed).toBe(3);
    expect(metrics.rpmFilterActive).toBe(true);
    expect(metrics.summary).toBe('Moderate noise detected.');
  });

  it('includes downsampled spectrum', () => {
    const result = makeFilterResult();
    const metrics = extractFilterMetrics(result);

    expect(metrics.spectrum).toBeDefined();
    expect(metrics.spectrum!.frequencies.length).toBeGreaterThan(0);
    expect(metrics.spectrum!.roll.length).toBe(metrics.spectrum!.frequencies.length);
  });

  it('handles undefined rpmFilterActive', () => {
    const result = makeFilterResult({ rpmFilterActive: undefined });
    const metrics = extractFilterMetrics(result);
    expect(metrics.rpmFilterActive).toBeUndefined();
  });

  it('includes throttle spectrogram when available', () => {
    const result = makeFilterResult({
      throttleSpectrogram: makeThrottleSpectrogram(3),
    });
    const metrics = extractFilterMetrics(result);
    expect(metrics.throttleSpectrogram).toBeDefined();
    expect(metrics.throttleSpectrogram!.bandsWithData).toBe(3);
    expect(metrics.throttleSpectrogram!.frequencies.length).toBeGreaterThan(0);
    expect(metrics.throttleSpectrogram!.bands.length).toBe(3);
  });

  it('omits throttle spectrogram when no bands have data', () => {
    const result = makeFilterResult({
      throttleSpectrogram: makeThrottleSpectrogram(0),
    });
    const metrics = extractFilterMetrics(result);
    expect(metrics.throttleSpectrogram).toBeUndefined();
  });
});

function makeThrottleSpectrogram(bandsWithData: number): ThrottleSpectrogramResult {
  const freqs = Float64Array.from({ length: 200 }, (_, i) => i * 5);
  const makeMags = (offset: number) =>
    Float64Array.from({ length: 200 }, (_, i) => -70 + offset + i * 0.1);

  const bands = [];
  for (let i = 0; i < 10; i++) {
    const hasData = i < bandsWithData;
    bands.push({
      throttleMin: i * 0.1,
      throttleMax: (i + 1) * 0.1,
      sampleCount: hasData ? 500 : 0,
      spectra: hasData
        ? ([
            { frequencies: freqs, magnitudes: makeMags(0) },
            { frequencies: freqs, magnitudes: makeMags(-2) },
            { frequencies: freqs, magnitudes: makeMags(-5) },
          ] as [
            { frequencies: Float64Array; magnitudes: Float64Array },
            { frequencies: Float64Array; magnitudes: Float64Array },
            { frequencies: Float64Array; magnitudes: Float64Array },
          ])
        : undefined,
      noiseFloorDb: hasData ? ([-55, -57, -60] as [number, number, number]) : undefined,
    });
  }

  return {
    bands,
    numBands: 10,
    minSamplesPerBand: 256,
    bandsWithData,
  };
}

describe('extractThrottleSpectrogram', () => {
  it('extracts compact spectrogram with downsampled data', () => {
    const result = makeThrottleSpectrogram(5);
    const compact = extractThrottleSpectrogram(result);
    expect(compact).not.toBeNull();
    expect(compact!.bandsWithData).toBe(5);
    expect(compact!.bands.length).toBe(5);
    expect(compact!.frequencies.length).toBe(compact!.bands[0].roll.length);
    expect(compact!.bands[0].pitch.length).toBe(compact!.frequencies.length);
    expect(compact!.bands[0].yaw.length).toBe(compact!.frequencies.length);
  });

  it('returns null when no bands have data', () => {
    const result = makeThrottleSpectrogram(0);
    const compact = extractThrottleSpectrogram(result);
    expect(compact).toBeNull();
  });

  it('preserves throttle min/max', () => {
    const result = makeThrottleSpectrogram(3);
    const compact = extractThrottleSpectrogram(result)!;
    expect(compact.bands[0].throttleMin).toBe(0);
    expect(compact.bands[0].throttleMax).toBe(0.1);
    expect(compact.bands[2].throttleMin).toBe(0.2);
    expect(compact.bands[2].throttleMax).toBeCloseTo(0.3);
  });

  it('downsamples to target bins when spectrum is larger', () => {
    const result = makeThrottleSpectrogram(1);
    const compact = extractThrottleSpectrogram(result)!;
    // 200 source bins should be downsampled to 120
    expect(compact.frequencies.length).toBe(120);
    expect(compact.bands[0].roll.length).toBe(120);
  });

  it('keeps all bins when spectrum is smaller than target', () => {
    const freqs = Float64Array.from([0, 100, 200, 300, 400]);
    const mags = Float64Array.from([-50, -45, -40, -35, -30]);
    const spectrogram: ThrottleSpectrogramResult = {
      bands: [
        {
          throttleMin: 0,
          throttleMax: 0.5,
          sampleCount: 500,
          spectra: [
            { frequencies: freqs, magnitudes: mags },
            { frequencies: freqs, magnitudes: mags },
            { frequencies: freqs, magnitudes: mags },
          ],
        },
      ],
      numBands: 1,
      minSamplesPerBand: 256,
      bandsWithData: 1,
    };
    const compact = extractThrottleSpectrogram(spectrogram)!;
    expect(compact.frequencies.length).toBe(5);
  });
});

function makePIDResult(overrides?: Partial<PIDAnalysisResult>): PIDAnalysisResult {
  return {
    roll: {
      responses: [],
      meanOvershoot: 12.345,
      meanRiseTimeMs: 8.567,
      meanSettlingTimeMs: 25.123,
      meanLatencyMs: 3.789,
      meanTrackingErrorRMS: 0.1234,
      meanSteadyStateError: 0,
    },
    pitch: {
      responses: [],
      meanOvershoot: 10.111,
      meanRiseTimeMs: 9.222,
      meanSettlingTimeMs: 22.333,
      meanLatencyMs: 4.444,
      meanTrackingErrorRMS: 0.0987,
      meanSteadyStateError: 0,
    },
    yaw: {
      responses: [],
      meanOvershoot: 15.555,
      meanRiseTimeMs: 11.666,
      meanSettlingTimeMs: 30.777,
      meanLatencyMs: 5.888,
      meanTrackingErrorRMS: 0.1567,
      meanSteadyStateError: 0,
    },
    recommendations: [],
    summary: 'Good PID response.',
    analysisTimeMs: 150,
    sessionIndex: 0,
    stepsDetected: 42,
    currentPIDs: {
      roll: { P: 45, I: 80, D: 30 },
      pitch: { P: 47, I: 82, D: 32 },
      yaw: { P: 35, I: 90, D: 0 },
    },
    ...overrides,
  };
}

describe('extractPIDMetrics', () => {
  it('extracts all fields correctly', () => {
    const result = makePIDResult();
    const metrics = extractPIDMetrics(result);

    expect(metrics.roll.meanOvershoot).toBe(12.35);
    expect(metrics.roll.meanRiseTimeMs).toBe(8.57);
    expect(metrics.roll.meanSettlingTimeMs).toBe(25.12);
    expect(metrics.roll.meanLatencyMs).toBe(3.79);

    expect(metrics.pitch.meanOvershoot).toBe(10.11);
    expect(metrics.yaw.meanOvershoot).toBe(15.56);

    expect(metrics.stepsDetected).toBe(42);
    expect(metrics.currentPIDs.roll.P).toBe(45);
    expect(metrics.summary).toBe('Good PID response.');
  });

  it('handles zero steps detected', () => {
    const result = makePIDResult({
      stepsDetected: 0,
      roll: {
        responses: [],
        meanOvershoot: 0,
        meanRiseTimeMs: 0,
        meanSettlingTimeMs: 0,
        meanLatencyMs: 0,
        meanTrackingErrorRMS: 0,
        meanSteadyStateError: 0,
      },
      pitch: {
        responses: [],
        meanOvershoot: 0,
        meanRiseTimeMs: 0,
        meanSettlingTimeMs: 0,
        meanLatencyMs: 0,
        meanTrackingErrorRMS: 0,
        meanSteadyStateError: 0,
      },
      yaw: {
        responses: [],
        meanOvershoot: 0,
        meanRiseTimeMs: 0,
        meanSettlingTimeMs: 0,
        meanLatencyMs: 0,
        meanTrackingErrorRMS: 0,
        meanSteadyStateError: 0,
      },
    });
    const metrics = extractPIDMetrics(result);
    expect(metrics.stepsDetected).toBe(0);
    expect(metrics.roll.meanOvershoot).toBe(0);
  });

  it('extracts meanTrackingErrorRMS per axis', () => {
    const result = makePIDResult();
    const metrics = extractPIDMetrics(result);
    expect(metrics.roll.meanTrackingErrorRMS).toBeDefined();
    expect(metrics.pitch.meanTrackingErrorRMS).toBeDefined();
    expect(metrics.yaw.meanTrackingErrorRMS).toBeDefined();
  });

  it('returns no stepResponse when responses have no traces', () => {
    const result = makePIDResult();
    const metrics = extractPIDMetrics(result);
    expect(metrics.stepResponse).toBeUndefined();
  });

  it('extracts stepResponse when traces are present', () => {
    const trace = {
      timeMs: [0, 10, 20, 30, 40, 50],
      setpoint: [0, 200, 200, 200, 200, 200],
      gyro: [0, 50, 180, 210, 200, 200],
    };
    const step = {
      step: {
        axis: 0 as const,
        startIndex: 0,
        endIndex: 100,
        magnitude: 200,
        direction: 'positive' as const,
      },
      riseTimeMs: 20,
      overshootPercent: 5,
      settlingTimeMs: 40,
      latencyMs: 5,
      ringingCount: 0,
      trace,
      trackingErrorRMS: 0.1,
      steadyStateErrorPercent: 0,
      leadingEdgeOvershootPercent: 0,
      peakValue: 210,
      steadyStateValue: 200,
    };
    const result = makePIDResult({
      roll: {
        responses: [step],
        meanOvershoot: 5,
        meanRiseTimeMs: 20,
        meanSettlingTimeMs: 40,
        meanLatencyMs: 5,
        meanTrackingErrorRMS: 0.1,
        meanSteadyStateError: 0,
      },
    });
    const metrics = extractPIDMetrics(result);
    expect(metrics.stepResponse).toBeDefined();
    expect(metrics.stepResponse!.timeMs.length).toBeGreaterThan(0);
    expect(metrics.stepResponse!.roll.length).toBe(metrics.stepResponse!.timeMs.length);
    // Normalized: gyro[5]=200 / magnitude=200 = 1.0
    expect(metrics.stepResponse!.roll[metrics.stepResponse!.roll.length - 1]).toBeCloseTo(1.0, 0);
  });

  it('handles negative step direction correctly', () => {
    const trace = {
      timeMs: [0, 10, 20, 30],
      setpoint: [0, -200, -200, -200],
      gyro: [0, -50, -190, -200],
    };
    const step = {
      step: {
        axis: 1 as const,
        startIndex: 0,
        endIndex: 100,
        magnitude: -200,
        direction: 'negative' as const,
      },
      riseTimeMs: 20,
      overshootPercent: 5,
      settlingTimeMs: 30,
      latencyMs: 5,
      ringingCount: 0,
      trace,
      trackingErrorRMS: 0.1,
      steadyStateErrorPercent: 0,
      leadingEdgeOvershootPercent: 0,
      peakValue: -210,
      steadyStateValue: -200,
    };
    const result = makePIDResult({
      pitch: {
        responses: [step],
        meanOvershoot: 5,
        meanRiseTimeMs: 20,
        meanSettlingTimeMs: 30,
        meanLatencyMs: 5,
        meanTrackingErrorRMS: 0.1,
        meanSteadyStateError: 0,
      },
    });
    const metrics = extractPIDMetrics(result);
    expect(metrics.stepResponse).toBeDefined();
    // Normalized: gyro=-200 / magnitude=-200 = +1.0 (direction handled)
    expect(metrics.stepResponse!.pitch[metrics.stepResponse!.pitch.length - 1]).toBeCloseTo(1.0, 0);
  });
});

describe('extractTransferFunctionMetrics', () => {
  const makeTFMetrics = () => ({
    roll: {
      bandwidthHz: 65.1234,
      phaseMarginDeg: 55.5678,
      gainMarginDb: 12.3456,
      overshootPercent: 8.7654,
      settlingTimeMs: 80.1234,
      riseTimeMs: 12.5678,
    },
    pitch: {
      bandwidthHz: 60.9876,
      phaseMarginDeg: 50.4321,
      gainMarginDb: 10.6789,
      overshootPercent: 10.1234,
      settlingTimeMs: 90.5678,
      riseTimeMs: 14.9012,
    },
    yaw: {
      bandwidthHz: 40.1111,
      phaseMarginDeg: 45.2222,
      gainMarginDb: 8.3333,
      overshootPercent: 12.4444,
      settlingTimeMs: 100.5555,
      riseTimeMs: 18.6666,
    },
  });

  it('extracts all per-axis fields', () => {
    const metrics = extractTransferFunctionMetrics(makeTFMetrics());
    expect(metrics.roll.bandwidthHz).toBe(65.12);
    expect(metrics.roll.phaseMarginDeg).toBe(55.57);
    expect(metrics.pitch.gainMarginDb).toBe(10.68);
    expect(metrics.yaw.overshootPercent).toBe(12.44);
    expect(metrics.yaw.settlingTimeMs).toBe(100.56);
    expect(metrics.yaw.riseTimeMs).toBe(18.67);
  });

  it('rounds all values to 2 decimal places', () => {
    const metrics = extractTransferFunctionMetrics(makeTFMetrics());
    for (const axis of ['roll', 'pitch', 'yaw'] as const) {
      for (const key of Object.keys(metrics[axis]) as (keyof typeof metrics.roll)[]) {
        const val = metrics[axis][key];
        if (typeof val !== 'number') continue; // phaseMarginCrossingFound is boolean
        expect(Math.round(val * 100) / 100).toBe(val);
      }
    }
  });

  it('includes dataQuality when provided', () => {
    const metrics = extractTransferFunctionMetrics(makeTFMetrics(), {
      overall: 85,
      tier: 'excellent',
    });
    expect(metrics.dataQuality).toEqual({ overall: 85, tier: 'excellent' });
  });

  it('omits dataQuality when not provided', () => {
    const metrics = extractTransferFunctionMetrics(makeTFMetrics());
    expect(metrics.dataQuality).toBeUndefined();
  });

  it('includes stepResponse when syntheticStepResponse provided', () => {
    const stepData = {
      roll: {
        timeMs: Array.from({ length: 100 }, (_, i) => i),
        response: Array.from({ length: 100 }, (_, i) =>
          i < 10 ? 0 : 1 + 0.1 * Math.exp(-i * 0.05)
        ),
      },
      pitch: {
        timeMs: Array.from({ length: 100 }, (_, i) => i),
        response: Array.from({ length: 100 }, (_, i) =>
          i < 10 ? 0 : 1 + 0.08 * Math.exp(-i * 0.05)
        ),
      },
      yaw: {
        timeMs: Array.from({ length: 100 }, (_, i) => i),
        response: Array.from({ length: 100 }, (_, i) =>
          i < 10 ? 0 : 1 + 0.12 * Math.exp(-i * 0.05)
        ),
      },
    };
    const metrics = extractTransferFunctionMetrics(makeTFMetrics(), undefined, stepData);
    expect(metrics.stepResponse).toBeDefined();
    expect(metrics.stepResponse!.timeMs).toHaveLength(64);
    expect(metrics.stepResponse!.roll).toHaveLength(64);
    expect(metrics.stepResponse!.pitch).toHaveLength(64);
    expect(metrics.stepResponse!.yaw).toHaveLength(64);
  });

  it('omits stepResponse when not provided', () => {
    const metrics = extractTransferFunctionMetrics(makeTFMetrics());
    expect(metrics.stepResponse).toBeUndefined();
  });

  it('includes throttleBands when throttleTF provided', () => {
    const throttleTF = {
      bandsWithData: 6,
      metricsVariance: {
        bandwidthHz: 12.3456,
        overshootPercent: 3.7891,
        phaseMarginDeg: 5.1234,
      },
      tpaWarning: 'TPA may be too aggressive',
    };
    const metrics = extractTransferFunctionMetrics(
      makeTFMetrics(),
      undefined,
      undefined,
      throttleTF
    );
    expect(metrics.throttleBands).toBeDefined();
    expect(metrics.throttleBands!.bandsWithData).toBe(6);
    expect(metrics.throttleBands!.metricsVariance.bandwidthHz).toBe(12.35);
    expect(metrics.throttleBands!.metricsVariance.overshootPercent).toBe(3.79);
    expect(metrics.throttleBands!.metricsVariance.phaseMarginDeg).toBe(5.12);
    expect(metrics.throttleBands!.tpaWarning).toBe('TPA may be too aggressive');
  });

  it('omits tpaWarning from throttleBands when not present', () => {
    const throttleTF = {
      bandsWithData: 4,
      metricsVariance: { bandwidthHz: 10, overshootPercent: 2, phaseMarginDeg: 4 },
    };
    const metrics = extractTransferFunctionMetrics(
      makeTFMetrics(),
      undefined,
      undefined,
      throttleTF
    );
    expect(metrics.throttleBands).toBeDefined();
    expect(metrics.throttleBands!.tpaWarning).toBeUndefined();
  });

  it('omits throttleBands when throttleTF not provided', () => {
    const metrics = extractTransferFunctionMetrics(makeTFMetrics());
    expect(metrics.throttleBands).toBeUndefined();
  });

  it('includes dcGain when dcGainDb present on input metrics', () => {
    const metricsWithDcGain = {
      roll: { ...makeTFMetrics().roll, dcGainDb: -1.2345 },
      pitch: { ...makeTFMetrics().pitch, dcGainDb: -0.5678 },
      yaw: { ...makeTFMetrics().yaw, dcGainDb: -2.9012 },
    };
    const result = extractTransferFunctionMetrics(metricsWithDcGain);
    expect(result.dcGain).toBeDefined();
    expect(result.dcGain!.roll).toBe(-1.23);
    expect(result.dcGain!.pitch).toBe(-0.57);
    expect(result.dcGain!.yaw).toBe(-2.9);
  });

  it('omits dcGain when dcGainDb not present on any axis', () => {
    const metrics = extractTransferFunctionMetrics(makeTFMetrics());
    expect(metrics.dcGain).toBeUndefined();
  });

  it('defaults missing dcGainDb to 0 when at least one axis has it', () => {
    const metricsPartial = {
      roll: { ...makeTFMetrics().roll, dcGainDb: -1.5 },
      pitch: makeTFMetrics().pitch, // no dcGainDb
      yaw: makeTFMetrics().yaw, // no dcGainDb
    };
    const result = extractTransferFunctionMetrics(metricsPartial);
    expect(result.dcGain).toBeDefined();
    expect(result.dcGain!.roll).toBe(-1.5);
    expect(result.dcGain!.pitch).toBe(0);
    expect(result.dcGain!.yaw).toBe(0);
  });
});

describe('downsampleStepResponse', () => {
  it('produces correct number of points', () => {
    const input = {
      roll: {
        timeMs: Array.from({ length: 200 }, (_, i) => i * 0.5),
        response: Array.from({ length: 200 }, (_, i) => Math.sin(i * 0.1)),
      },
      pitch: {
        timeMs: Array.from({ length: 200 }, (_, i) => i * 0.5),
        response: Array.from({ length: 200 }, (_, i) => Math.cos(i * 0.1)),
      },
      yaw: {
        timeMs: Array.from({ length: 200 }, (_, i) => i * 0.5),
        response: Array.from({ length: 200 }, () => 0.5),
      },
    };
    const result = downsampleStepResponse(input);
    expect(result.timeMs).toHaveLength(64);
    expect(result.roll).toHaveLength(64);
    expect(result.pitch).toHaveLength(64);
    expect(result.yaw).toHaveLength(64);
  });

  it('respects custom targetPoints parameter', () => {
    const input = {
      roll: {
        timeMs: Array.from({ length: 100 }, (_, i) => i),
        response: Array.from({ length: 100 }, () => 1),
      },
      pitch: {
        timeMs: Array.from({ length: 100 }, (_, i) => i),
        response: Array.from({ length: 100 }, () => 1),
      },
      yaw: {
        timeMs: Array.from({ length: 100 }, (_, i) => i),
        response: Array.from({ length: 100 }, () => 1),
      },
    };
    const result = downsampleStepResponse(input, 32);
    expect(result.timeMs).toHaveLength(32);
  });

  it('handles single point input', () => {
    const input = {
      roll: { timeMs: [5], response: [1.2] },
      pitch: { timeMs: [5], response: [1.1] },
      yaw: { timeMs: [5], response: [1.3] },
    };
    const result = downsampleStepResponse(input);
    expect(result.timeMs).toHaveLength(1);
    expect(result.roll).toEqual([1.2]);
    expect(result.pitch).toEqual([1.1]);
    expect(result.yaw).toEqual([1.3]);
  });

  it('handles empty input', () => {
    const input = {
      roll: { timeMs: [] as number[], response: [] as number[] },
      pitch: { timeMs: [] as number[], response: [] as number[] },
      yaw: { timeMs: [] as number[], response: [] as number[] },
    };
    const result = downsampleStepResponse(input);
    expect(result.timeMs).toHaveLength(0);
    expect(result.roll).toHaveLength(0);
  });

  it('rounds values to 2 decimal places', () => {
    const input = {
      roll: {
        timeMs: Array.from({ length: 100 }, (_, i) => i * 1.333),
        response: Array.from({ length: 100 }, (_, i) => 1 + i * 0.00123),
      },
      pitch: {
        timeMs: Array.from({ length: 100 }, (_, i) => i * 1.333),
        response: Array.from({ length: 100 }, () => 1),
      },
      yaw: {
        timeMs: Array.from({ length: 100 }, (_, i) => i * 1.333),
        response: Array.from({ length: 100 }, () => 1),
      },
    };
    const result = downsampleStepResponse(input);
    for (const t of result.timeMs) {
      expect(Math.round(t * 100) / 100).toBe(t);
    }
    for (const v of result.roll) {
      expect(Math.round(v * 100) / 100).toBe(v);
    }
  });
});
