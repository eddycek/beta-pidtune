/**
 * Demo data generator for offline UX testing.
 *
 * Generates realistic BBL (Blackbox Log) binary data that:
 * - Parses successfully through the real BlackboxParser
 * - Produces meaningful results from FilterAnalyzer (FFT noise peaks)
 * - Produces meaningful results from PIDAnalyzer (step responses)
 *
 * Uses the same VB encoding functions as bf45-reference.ts fixture.
 *
 * IMPORTANT: iInterval must produce a sample rate matching the P interval header.
 * The parser computes sampleRateHz = 1e6 / (looptime * pInterval * pDenom).
 * With P interval:1/2 and looptime:125 → sampleRateHz = 4000 Hz → iInterval must be 2.
 * A mismatch causes StepDetector timing calculations to reject all steps.
 */

import { logger } from '../utils/logger';

// ── VB Encoding (matches bf45-reference.ts) ────────────────────────

/** Encode unsigned value as variable-byte */
function encodeUVB(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return bytes;
}

/** Encode signed value as zigzag VB */
function encodeSVB(value: number): number[] {
  const zigzag = (value << 1) ^ (value >> 31);
  return encodeUVB(zigzag >>> 0);
}

// ── Noise Generation ───────────────────────────────────────────────

/**
 * Generate Gaussian-distributed random noise using Box-Muller transform.
 */
function gaussianNoise(stddev: number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return stddev * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Generate deterministic broadband setpoint signal for Wiener deconvolution.
 *
 * Uses summed sinusoids at incommensurate frequencies (no common harmonics)
 * to produce a quasi-random signal with energy across 0.5-40 Hz — the range
 * that matters for transfer function estimation. Deterministic (no Math.random)
 * for reproducible results.
 *
 * @param frameCount - Number of frames
 * @param sampleRateHz - Sample rate in Hz
 * @param amplitude - Peak amplitude in deg/s
 * @returns 3 Float64Arrays [roll, pitch, yaw] of setpoint values
 */
function generateBroadbandSetpoint(
  frameCount: number,
  sampleRateHz: number,
  amplitude: number
): [Float64Array, Float64Array, Float64Array] {
  // Frequencies chosen as primes / golden-ratio multiples → no common harmonics → broadband
  const freqSets = [
    [0.7, 1.3, 2.9, 5.3, 8.7, 13.1, 19.7, 29.3, 37.1], // roll
    [0.5, 1.7, 3.7, 6.1, 9.7, 14.9, 22.1, 31.7, 39.7], // pitch
    [0.9, 2.3, 4.3, 7.1, 11.3, 17.3, 26.3, 34.9, 41.3], // yaw (lower amplitude)
  ];
  // Per-frequency amplitudes: lower frequencies get more weight (realistic stick input)
  const ampWeights = [0.3, 0.25, 0.2, 0.15, 0.12, 0.1, 0.08, 0.06, 0.04];
  const yawScale = 0.5; // Yaw stick moves less than roll/pitch

  const result: [Float64Array, Float64Array, Float64Array] = [
    new Float64Array(frameCount),
    new Float64Array(frameCount),
    new Float64Array(frameCount),
  ];

  for (let f = 0; f < frameCount; f++) {
    const t = f / sampleRateHz;
    for (let axis = 0; axis < 3; axis++) {
      let value = 0;
      const axisScale = axis === 2 ? yawScale : 1.0;
      for (let s = 0; s < freqSets[axis].length; s++) {
        // Phase offset per axis+freq prevents correlation between axes
        const phase = axis * 2.1 + s * 0.7;
        value += ampWeights[s] * Math.sin(2 * Math.PI * freqSets[axis][s] * t + phase);
      }
      result[axis][f] = Math.round(value * amplitude * axisScale);
    }
  }

  return result;
}

// ── Demo BBL Builder ───────────────────────────────────────────────

interface DemoSessionConfig {
  /** Number of I-frames to generate */
  frameCount: number;
  /** Base gyro values [roll, pitch, yaw] in deg/s */
  gyroBase: [number, number, number];
  /** Noise RMS amplitude in deg/s */
  noiseAmplitude: number;
  /** Motor harmonic frequency in Hz (typically 120-200 Hz) */
  motorHarmonicHz: number;
  /** Motor harmonic amplitude in deg/s */
  motorHarmonicAmplitude: number;
  /** Electrical noise frequency in Hz (typically 500-800 Hz) */
  electricalNoiseHz: number;
  /** Electrical noise amplitude in deg/s */
  electricalNoiseAmplitude: number;
  /** Whether to inject step inputs into setpoint data (for PID analysis) */
  injectSteps: boolean;
  /** I-frame interval — must match P interval header for correct sample rate (default 2) */
  iInterval?: number;
  /** Per-axis step response parameters (overrides DEFAULT_RESPONSE_PARAMS) */
  responseParams?: [AxisResponseParams, AxisResponseParams, AxisResponseParams];
  /** Roll noise multiplier relative to pitch/yaw (for axis asymmetry simulation) */
  axisAsymmetry?: number;
  /** Enable continuous broadband setpoint movement (for Flash Tune / Wiener deconvolution).
   *  Simulates normal pilot stick input instead of discrete step maneuvers. */
  continuousSetpoint?: boolean;
  /** Amplitude of continuous setpoint movement in deg/s (default 150) */
  continuousSetpointAmplitude?: number;
}

/** Step event for gyro response simulation */
interface StepEvent {
  startFrame: number;
  endFrame: number;
  axis: 0 | 1 | 2; // roll, pitch, yaw
  magnitude: number; // deg/s
}

/**
 * Second-order system parameters per axis for realistic step response.
 *
 * Model: G(s) = ωn² / (s² + 2ζωn·s + ωn²)
 * Step response: y(t) = 1 - (e^(-ζωnt) / √(1-ζ²)) · sin(ωd·t + φ)
 * where ωd = ωn·√(1-ζ²), φ = arccos(ζ)
 */
interface AxisResponseParams {
  /** Damping ratio (0 < ζ < 1 for underdamped) */
  zeta: number;
  /** Natural frequency in rad/s */
  wn: number;
  /** Transport + computation latency in seconds */
  latencyS: number;
}

/** Default step response parameters (used when no cycle-specific params provided) */
const DEFAULT_RESPONSE_PARAMS: [AxisResponseParams, AxisResponseParams, AxisResponseParams] = [
  { zeta: 0.48, wn: 85, latencyS: 0.012 },
  { zeta: 0.5, wn: 80, latencyS: 0.012 },
  { zeta: 0.65, wn: 50, latencyS: 0.012 },
];

/**
 * Compute cycle-dependent step response parameters.
 *
 * Progression from poorly tuned (cycle 0) to well tuned (cycle 4+):
 *   Cycle 0: ζ≈0.32, ωn≈55 → ~35% overshoot, ~230ms settling (Poor)
 *   Cycle 1: ζ≈0.53, ωn≈82 → ~14% overshoot, ~92ms settling (Fair)
 *   Cycle 2: ζ≈0.63, ωn≈96 → ~8% overshoot, ~66ms settling (Good)
 *   Cycle 3: ζ≈0.70, ωn≈105 → ~5% overshoot, ~55ms settling (Excellent)
 *   Cycle 4: ζ≈0.74, ωn≈110 → ~3% overshoot, ~49ms settling (Excellent)
 *
 * Uses inverted progressiveFactor for consistent exponential improvement curve.
 */
function computeCycleResponseParams(
  cycle: number
): [AxisResponseParams, AxisResponseParams, AxisResponseParams] {
  // t: 0 (untuned) → ~0.85 (fully optimized) via inverted progressive curve
  const t = 1 - progressiveFactor(cycle);

  const lerp = (a: number, b: number): number => a + (b - a) * t;

  // Base (cycle 0): poorly tuned — high overshoot, slow settling
  // Target (cycle 4+): optimally tuned — minimal overshoot, fast settling
  return [
    // Roll
    { zeta: lerp(0.32, 0.78), wn: lerp(55, 115), latencyS: lerp(0.016, 0.006) },
    // Pitch
    { zeta: lerp(0.34, 0.8), wn: lerp(50, 110), latencyS: lerp(0.016, 0.006) },
    // Yaw
    { zeta: lerp(0.45, 0.88), wn: lerp(32, 75), latencyS: lerp(0.016, 0.006) },
  ];
}

/**
 * Prop wash throttle-cut events embedded in the throttle profile.
 *
 * Each event is a rapid throttle punch-down (1750→1200 in ~120ms) followed by
 * recovery back to cruise. The derivative exceeds -0.3 normalized/s for ≥50ms,
 * triggering PropWashDetector. 4 events at fixed normalized positions ensure
 * ≥3 detections regardless of flight duration.
 */
interface ThrottleCutEvent {
  /** Normalized time (0-1) of the cut start */
  tStart: number;
  /** Duration of the cut in normalized time */
  tCutDuration: number;
  /** Duration of the recovery in normalized time */
  tRecoveryDuration: number;
  /** Throttle value at which the cut starts */
  fromThrottle: number;
  /** Throttle value at the bottom of the cut */
  toThrottle: number;
}

/** 4 prop wash events during the high-throttle / descent phases.
 *
 * tCutDuration must produce >1 raw throttle unit change per frame after Math.round()
 * to guarantee every consecutive frame pair has non-zero derivative.
 * For 20s flight at 4000 Hz: 0.004 * 20 = 80ms = 320 frames → 600/320 = 1.875/frame ✓
 * For 10s flight at 4000 Hz: 0.004 * 10 = 40ms = 160 frames — below 50ms detection minimum,
 * so we use 0.005 (50ms at 10s, 100ms at 20s) to stay above PROPWASH_MIN_DROP_DURATION_MS.
 */
const THROTTLE_CUT_EVENTS: ThrottleCutEvent[] = [
  // During high hover phase (t=0.50-0.70): 2 punch-downs
  {
    tStart: 0.53,
    tCutDuration: 0.005,
    tRecoveryDuration: 0.015,
    fromThrottle: 1800,
    toThrottle: 1200,
  },
  {
    tStart: 0.6,
    tCutDuration: 0.005,
    tRecoveryDuration: 0.015,
    fromThrottle: 1800,
    toThrottle: 1200,
  },
  // During descent ramp (t=0.70-1.00): 2 punch-downs
  {
    tStart: 0.75,
    tCutDuration: 0.005,
    tRecoveryDuration: 0.015,
    fromThrottle: 1700,
    toThrottle: 1100,
  },
  {
    tStart: 0.85,
    tCutDuration: 0.005,
    tRecoveryDuration: 0.015,
    fromThrottle: 1600,
    toThrottle: 1050,
  },
];

/**
 * Multi-phase throttle profile for realistic segment detection.
 *
 * Profile (as proportion of total duration):
 *   0-20%:  Low hover at 1350 (35%)
 *  20-50%:  Linear ramp 1350→1800 (35%→80%) — sweep segment
 *  50-70%:  High hover at 1800 (80%)
 *  70-100%: Linear ramp 1800→1350 (80%→35%) — sweep segment
 *
 * Overlay: 4 rapid throttle punch-downs for prop wash detection.
 * Each cut drops ~550µs in ~120ms (derivative > -0.45 normalized/s).
 *
 * Result: 2 sweep segments + 2 hover segments = 4 segments, 45% throttle coverage.
 */
function computeThrottle(timeSec: number, durationSec: number): number {
  const t = timeSec / durationSec; // Normalized 0..1

  // Check for throttle-cut overlay events first
  for (const cut of THROTTLE_CUT_EVENTS) {
    const cutEnd = cut.tStart + cut.tCutDuration;
    const recoveryEnd = cutEnd + cut.tRecoveryDuration;
    if (t >= cut.tStart && t < recoveryEnd) {
      if (t < cutEnd) {
        // Rapid drop phase
        const progress = (t - cut.tStart) / cut.tCutDuration;
        return cut.fromThrottle - progress * (cut.fromThrottle - cut.toThrottle);
      } else {
        // Recovery phase
        const progress = (t - cutEnd) / cut.tRecoveryDuration;
        return cut.toThrottle + progress * (cut.fromThrottle - cut.toThrottle);
      }
    }
  }

  // Base throttle profile
  if (t < 0.2) {
    return 1350;
  } else if (t < 0.5) {
    // Ramp from 1350 to 1800
    const rampProgress = (t - 0.2) / 0.3;
    return 1350 + rampProgress * 450;
  } else if (t < 0.7) {
    return 1800;
  } else {
    // Ramp from 1800 to 1350
    const rampProgress = (t - 0.7) / 0.3;
    return 1800 - rampProgress * 450;
  }
}

/**
 * Build a single BBL session with realistic noise and optional step inputs.
 *
 * This generates only I-frames (no P-frames) for simplicity — the parser
 * handles I-only logs just fine, and the analysis engines work on the
 * extracted TimeSeries data regardless of frame type.
 *
 * The iInterval MUST match pDiv (pInterval * pDenom from the P interval header)
 * so that BlackboxParser.sampleRateHz equals the actual data rate.
 * Default: iInterval=2 with "P interval:1/2" → pDiv=2 → 4000 Hz.
 */
function buildDemoSession(config: DemoSessionConfig): Buffer {
  const {
    frameCount,
    gyroBase,
    noiseAmplitude,
    motorHarmonicHz,
    motorHarmonicAmplitude,
    electricalNoiseHz,
    electricalNoiseAmplitude,
    injectSteps,
    iInterval = 2,
    responseParams = DEFAULT_RESPONSE_PARAMS,
    axisAsymmetry = 1.0,
    continuousSetpoint = false,
    continuousSetpointAmplitude = 150,
  } = config;

  const parts: Buffer[] = [];
  const looptime = 125; // µs (8 kHz)
  const sampleRateHz = 1_000_000 / (looptime * iInterval);

  // ── Headers ─────────────────────────────────────────────────────
  const headers = [
    'H Product:Blackbox flight data recorder by Nicholas Sherlock',
    'H Data version:2',
    `H I interval:${iInterval}`,
    'H P interval:1/2',
    'H Firmware type:Betaflight',
    'H Firmware revision:4.5.1',
    'H Firmware date:Jan  1 2025 00:00:00',
    `H looptime:${looptime}`,
    'H gyro_scale:0x3f800000',
    'H minthrottle:1070',
    'H maxthrottle:2000',
    'H vbatref:420',
    'H Board information:OMNIBUSF4SD',
    'H Log start datetime:2026-02-24T10:00:00.000',
    'H Craft name:DemoQuad',
    // PID settings in headers (used by extractFlightPIDs)
    'H rollPID:50,88,45',
    'H pitchPID:52,92,48',
    'H yawPID:45,90,0',
    'H feedforward_weight:120,130,80',
    'H feedforward_boost:15',
    'H feedforward_smooth_factor:25',
    'H feedforward_jitter_factor:7',
    'H feedforward_averaging:0',
    'H rc_smoothing_input_hz:250',
    'H rc_smoothing_auto_factor:30',
    'H debug_mode:GYRO_SCALED',
    'H pid_process_denom:2',
    'H blackbox_high_resolution:0',
    // RPM filter info
    'H dshot_bidir:1',
    'H rpm_filter_harmonics:3',
    'H rpm_filter_min_hz:100',
    'H rpm_filter_q:500',
    // Dynamic notch
    'H dyn_notch_count:3',
    'H dyn_notch_q:300',
    'H dyn_notch_min_hz:100',
    'H dyn_notch_max_hz:600',
    // Dynamic lowpass (gyro + dterm)
    'H gyro_lowpass_dyn_min_hz:250',
    'H gyro_lowpass_dyn_max_hz:500',
    'H dterm_lpf1_dyn_min_hz:150',
    'H dterm_lpf1_dyn_max_hz:300',
    'H dterm_lpf1_dyn_expo:5',
    // D-min (propwash D boost)
    'H d_min_roll:30',
    'H d_min_pitch:34',
    'H d_min_yaw:0',
    'H d_min_gain:20',
    'H d_min_advance:20',
    // I-term relax
    'H iterm_relax:1',
    'H iterm_relax_type:1',
    'H iterm_relax_cutoff:15',
    // TPA
    'H tpa_rate:65',
    'H tpa_breakpoint:1350',
    'H tpa_mode:0',
    // Field definitions
    'H Field I name:loopIteration,time,gyroADC[0],gyroADC[1],gyroADC[2],setpoint[0],setpoint[1],setpoint[2],setpoint[3]',
    'H Field I signed:0,0,1,1,1,1,1,1,1',
    'H Field I predictor:0,0,0,0,0,0,0,0,0',
    'H Field I encoding:1,1,0,0,0,0,0,0,0',
    'H Field P name:loopIteration,time,gyroADC[0],gyroADC[1],gyroADC[2],setpoint[0],setpoint[1],setpoint[2],setpoint[3]',
    'H Field P signed:0,0,1,1,1,1,1,1,1',
    'H Field P predictor:1,1,1,1,1,1,1,1,1',
    'H Field P encoding:0,0,0,0,0,0,0,0,0',
  ];
  parts.push(Buffer.from(headers.join('\n') + '\n'));

  // ── Step input schedule ─────────────────────────────────────────
  // Generate step events spread across the session for PID analysis.
  // Each step: sudden setpoint change → hold for ~400ms → return to 0.
  // 400ms hold ensures StepMetrics tail measurement (last 20% of 300ms window)
  // falls within the hold period, producing correct overshoot values.
  // 18 steps total (6 per axis) for robust PID analysis.
  const steps: StepEvent[] = [];
  if (injectSteps) {
    const holdFrames = Math.round(0.7 * sampleRateHz); // 700ms hold — must exceed STEP_RESPONSE_WINDOW_MAX_MS (500ms) so steady-state measurement stays within hold
    const cooldownFrames = Math.round(0.3 * sampleRateHz); // 300ms between steps (well above 100ms detector threshold)
    const stepMagnitudes = [
      200,
      -300,
      250, // roll, pitch, yaw
      -250,
      300,
      -200, // roll, pitch, yaw
      350,
      -200,
      300, // roll, pitch, yaw
      -300,
      250,
      -350, // roll, pitch, yaw
      200,
      -350,
      250, // roll, pitch, yaw
      -250,
      300,
      -200, // roll, pitch, yaw
    ];
    let nextStart = Math.round(0.5 * sampleRateHz); // Start 0.5s into the session

    for (let i = 0; i < stepMagnitudes.length && nextStart + holdFrames < frameCount - 10; i++) {
      const axis = (i % 3) as 0 | 1 | 2; // Cycle through roll, pitch, yaw
      steps.push({
        startFrame: nextStart,
        endFrame: nextStart + holdFrames,
        axis,
        magnitude: stepMagnitudes[i],
      });
      nextStart += holdFrames + cooldownFrames;
    }
  }

  // ── Pre-generate continuous setpoint + gyro response (Flash Tune) ──
  // For continuous setpoint mode, pre-compute the entire setpoint and gyro
  // response using discrete-time second-order simulation. This avoids per-frame
  // convolution and produces accurate tracking response for Wiener deconvolution.
  let broadbandSetpoint: [Float64Array, Float64Array, Float64Array] | undefined;
  let broadbandGyroResponse: [Float64Array, Float64Array, Float64Array] | undefined;

  if (continuousSetpoint) {
    broadbandSetpoint = generateBroadbandSetpoint(
      frameCount,
      sampleRateHz,
      continuousSetpointAmplitude
    );

    // Simulate second-order system response to continuous setpoint (per-axis)
    broadbandGyroResponse = [
      new Float64Array(frameCount),
      new Float64Array(frameCount),
      new Float64Array(frameCount),
    ];
    for (let axis = 0; axis < 3; axis++) {
      const { zeta, wn, latencyS } = responseParams[axis];
      const latencyFrames = Math.round(latencyS * sampleRateHz);
      const dt = 1 / sampleRateHz;

      // Discrete-time state-space: x1 = position, x2 = velocity
      // dx1/dt = x2, dx2/dt = wn²·(u - x1) - 2·ζ·wn·x2
      let x1 = 0;
      let x2 = 0;
      for (let f = 0; f < frameCount; f++) {
        const u = f >= latencyFrames ? broadbandSetpoint[axis][f - latencyFrames] : 0;
        const dx1 = x2;
        const dx2 = wn * wn * (u - x1) - 2 * zeta * wn * x2;
        x1 += dx1 * dt;
        x2 += dx2 * dt;
        broadbandGyroResponse[axis][f] = x1;
      }
    }
  }

  // ── Frame generation ────────────────────────────────────────────
  const durationSec = frameCount / sampleRateHz;
  // Motor harmonic phase accumulator — the instantaneous frequency tracks
  // throttle (motor noise scales with RPM), so the phase must be integrated
  // to stay continuous. Real motor noise draws the diagonal-line signature
  // in throttle spectrograms; a fixed-frequency sinusoid would (correctly!)
  // be classified as stationary/frame noise by the throttle-track classifier.
  let motorPhase = 0;
  const dtSec = (looptime * iInterval) / 1_000_000;
  for (let f = 0; f < frameCount; f++) {
    const frame: number[] = [0x49]; // I-frame marker

    const loopIter = f * iInterval;
    const time = loopIter * looptime; // µs
    const timeSec = time / 1_000_000;

    // Instantaneous motor frequency: motorHarmonicHz at ~60% throttle,
    // scaling proportionally with normalized throttle (RPM-like)
    const throttleRaw = computeThrottle(timeSec, durationSec);
    const normThrottle = Math.max(0, Math.min(1, (throttleRaw - 1000) / 1000));
    const instMotorFreq = motorHarmonicHz * (0.4 + normThrottle);
    motorPhase += 2 * Math.PI * instMotorFreq * dtSec;

    frame.push(...encodeUVB(loopIter));
    frame.push(...encodeUVB(time));

    // --- Gyro values: base + broadband noise + harmonic noise ---
    const gyroValues: number[] = [];
    for (let axis = 0; axis < 3; axis++) {
      let value = gyroBase[axis];

      // Broadband gyro noise (simulates natural vibration)
      // axisAsymmetry multiplies roll (axis 0) noise to simulate bent prop / damaged motor
      const axisNoiseMult = axis === 0 ? axisAsymmetry : 1.0;
      value += gaussianNoise(noiseAmplitude * axisNoiseMult);

      // Motor harmonic (strong peak that tracks throttle/RPM)
      value += motorHarmonicAmplitude * Math.sin(motorPhase + axis);

      // Second motor harmonic (2x frequency, lower amplitude)
      value += motorHarmonicAmplitude * 0.4 * Math.sin(2 * motorPhase + axis * 0.5);

      // Electrical noise (high frequency)
      value +=
        electricalNoiseAmplitude * Math.sin(2 * Math.PI * electricalNoiseHz * timeSec + axis * 1.3);

      // Prop wash oscillation injection (30-60 Hz bursts after throttle cuts)
      // Roll gets strongest, pitch moderate, yaw minimal — matches real prop wash behavior
      // Amplitude scales with noise (noiseAmplitude) — well-tuned quads (cycle 4+) have
      // minimal prop wash because higher D-term dampens the oscillation.
      const propWashAxisScale = axis === 0 ? 1.0 : axis === 1 ? 0.7 : 0.15;
      const propWashBaseAmplitude = Math.max(20, noiseAmplitude * 5);
      for (const cut of THROTTLE_CUT_EVENTS) {
        const cutEndSec = (cut.tStart + cut.tCutDuration) * durationSec;
        const afterCut = timeSec - cutEndSec;
        // Inject oscillation for 400ms after the throttle cut bottom
        if (afterCut > 0 && afterCut < 0.4) {
          // Decaying 45 Hz oscillation — dominant prop wash frequency
          const decay = Math.exp(-afterCut * 6);
          const amplitude = propWashBaseAmplitude * propWashAxisScale * decay;
          value += amplitude * Math.sin(2 * Math.PI * 45 * afterCut + axis * 1.2);
          // Add secondary 28 Hz component for broader band energy
          value += amplitude * 0.4 * Math.sin(2 * Math.PI * 28 * afterCut + axis * 0.8);
        }
      }

      // Continuous setpoint tracking response (Flash Tune)
      if (broadbandGyroResponse) {
        value += broadbandGyroResponse[axis][f];
      }

      gyroValues.push(value);
    }

    // --- Simulated gyro response to step inputs ---
    // Second-order system model: y(t) = 1 - (e^(-ζωnt) / √(1-ζ²)) · sin(ωd·t + φ)
    if (injectSteps && !continuousSetpoint) {
      for (const step of steps) {
        const framesIn = f - step.startFrame;
        if (framesIn < 0) continue;
        // Stop contributing well after the step ends (decay is negligible)
        if (framesIn > step.endFrame - step.startFrame + Math.round(0.15 * sampleRateHz)) continue;

        const { zeta, wn, latencyS } = responseParams[step.axis];
        const latencyFrames = Math.round(latencyS * sampleRateHz);
        if (framesIn < latencyFrames) continue;

        const wd = wn * Math.sqrt(1 - zeta * zeta);
        const phi = Math.acos(zeta);
        const t = (framesIn - latencyFrames) / sampleRateHz; // seconds after latency
        const envelope = Math.exp(-zeta * wn * t) / Math.sqrt(1 - zeta * zeta);
        const response = 1 - envelope * Math.sin(wd * t + phi);

        if (f < step.endFrame) {
          // During step hold: tracking toward target via second-order dynamics
          gyroValues[step.axis] += step.magnitude * response;
        } else {
          // After step ends: decay back to 0
          const tAfterEnd = (f - step.endFrame) / sampleRateHz;
          const decayFactor = Math.exp(-tAfterEnd * 60);
          gyroValues[step.axis] += step.magnitude * decayFactor;
        }
      }
    }

    // Round gyro values after all contributions
    frame.push(...encodeSVB(Math.round(gyroValues[0])));
    frame.push(...encodeSVB(Math.round(gyroValues[1])));
    frame.push(...encodeSVB(Math.round(gyroValues[2])));

    // --- Setpoint ---
    if (broadbandSetpoint) {
      // Continuous broadband setpoint (Flash Tune — normal flying)
      frame.push(...encodeSVB(Math.round(broadbandSetpoint[0][f])));
      frame.push(...encodeSVB(Math.round(broadbandSetpoint[1][f])));
      frame.push(...encodeSVB(Math.round(broadbandSetpoint[2][f])));
    } else {
      // Discrete step inputs (PID Tune — specific maneuvers)
      const setpoints = [0, 0, 0]; // roll, pitch, yaw
      const activeStep = steps.find((s) => f >= s.startFrame && f < s.endFrame);
      if (activeStep) {
        setpoints[activeStep.axis] = activeStep.magnitude;
      }
      frame.push(...encodeSVB(setpoints[0]));
      frame.push(...encodeSVB(setpoints[1]));
      frame.push(...encodeSVB(setpoints[2]));
    }

    // Throttle: multi-phase profile for realistic segment detection
    frame.push(...encodeSVB(Math.round(computeThrottle(timeSec, durationSec))));

    parts.push(Buffer.from(frame));
  }

  // ── LOG_END event ───────────────────────────────────────────────
  parts.push(Buffer.from([0x45, 0xff, ...Buffer.from('End of log\0', 'ascii')]));

  return Buffer.concat(parts);
}

// ── Progressive noise reduction ────────────────────────────────────

/**
 * Compute a progressive attenuation factor based on tuning cycle.
 *
 * 5 discrete steps from noisy baseline to fully optimized:
 *   Cycle 0 → 1.000 (untuned baseline)
 *   Cycle 1 → 0.284 (first tuning pass — big improvement)
 *   Cycle 2 → 0.088 (second pass — dramatic noise reduction)
 *   Cycle 3 → 0.035 (fine-tuning — near-optimal)
 *   Cycle 4 → 0.021 (fully optimized)
 *   Cycle 5+ → 0.015 (minimal achievable noise)
 *
 * Steep exponential decay drives quality score from "poor" (~35) through
 * "fair" → "good" → "excellent" (~85) across the 5-cycle demo progression.
 * Noise floor improves ~35 dB, settling time drops from ~300ms to ~55ms.
 */
export function progressiveFactor(cycle: number): number {
  if (cycle <= 0) return 1.0;
  if (cycle >= 5) return 0.015;
  // Steep exponential: 1.0 → 0.28 → 0.09 → 0.04 → 0.02 → 0.015
  return 0.015 + 0.985 * Math.exp(-1.3 * cycle);
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Generate a demo BBL buffer for filter analysis (pre-tuning flight).
 *
 * Contains one session with:
 * - ~10 seconds of flight data at 4000 Hz (I-frame only, iInterval=2)
 * - Noise floor dependent on cycle (high on first, lower after tuning)
 * - Motor harmonic at ~160 Hz with 2nd harmonic at ~320 Hz
 * - Electrical noise at ~600 Hz
 * - Multi-phase throttle profile for segment detection (4 segments, 45% range)
 *
 * @param cycle - Tuning cycle number (0 = first, higher = progressively cleaner)
 */
export function generateFilterDemoBBL(cycle = 0): Buffer {
  const f = progressiveFactor(cycle);
  logger.info(
    `[DEMO] Generating filter analysis demo BBL (cycle ${cycle}, factor ${f.toFixed(2)})...`
  );
  return buildDemoSession({
    frameCount: 40000, // 10s at 4000 Hz
    gyroBase: [2, -1, 0],
    noiseAmplitude: 15 * f,
    motorHarmonicHz: 160,
    motorHarmonicAmplitude: 40 * f,
    electricalNoiseHz: 600,
    electricalNoiseAmplitude: 8 * f,
    injectSteps: false,
    iInterval: 2,
  });
}

/**
 * Generate a demo BBL buffer for PID analysis (post-filter flight).
 *
 * Contains one session with:
 * - ~14 seconds of flight data at 4000 Hz (I-frame only, iInterval=2)
 * - Reduced noise floor (simulates applied filter tuning)
 * - 18 step inputs across all 3 axes (for step response detection)
 * - Cycle-dependent second-order step response model (cycle 0: ~35% overshoot → cycle 4: ~3%)
 * - Cycle-dependent latency (16ms → 6ms)
 * - 700ms step hold ensures steady-state is measured within hold (exceeds 500ms analysis window)
 *
 * @param cycle - Tuning cycle number (0 = first, higher = progressively cleaner)
 */
export function generatePIDDemoBBL(cycle = 0): Buffer {
  const f = progressiveFactor(cycle);
  logger.info(
    `[DEMO] Generating PID analysis demo BBL (cycle ${cycle}, factor ${f.toFixed(2)})...`
  );
  return buildDemoSession({
    frameCount: 76000, // 19s at 4000 Hz — fits 18 steps × (700ms hold + 300ms cool) + 0.5s lead
    gyroBase: [0, 0, 0],
    noiseAmplitude: 5 * f,
    motorHarmonicHz: 160,
    motorHarmonicAmplitude: 8 * f,
    electricalNoiseHz: 600,
    electricalNoiseAmplitude: 2 * f,
    injectSteps: true,
    iInterval: 2,
    responseParams: computeCycleResponseParams(cycle),
  });
}

/**
 * Generate a demo BBL buffer for Filter/PID Tune verification flight (post-all tuning).
 *
 * Contains one session with:
 * - ~10 seconds of hover data at 4000 Hz (I-frame only, iInterval=2)
 * - Low noise floor (simulates effect of applied filters + PID tuning)
 * - No step inputs (hover only, same structure as filter flight)
 * - Multi-phase throttle profile for segment detection
 *
 * Verification noise is always significantly lower than the corresponding filter flight:
 * - Base: noiseAmplitude=3, motorHarmonicAmplitude=5, electricalNoise=0.8
 * - Progressive: further reduced with each cycle
 *
 * @param cycle - Tuning cycle number (0 = first, higher = progressively cleaner)
 */
export function generateVerificationDemoBBL(cycle = 0): Buffer {
  const f = progressiveFactor(cycle);
  logger.info(
    `[DEMO] Generating verification demo BBL (cycle ${cycle}, factor ${f.toFixed(2)})...`
  );
  return buildDemoSession({
    frameCount: 40000, // 10s at 4000 Hz
    gyroBase: [2, -1, 0],
    noiseAmplitude: 3 * f,
    motorHarmonicHz: 160,
    motorHarmonicAmplitude: 5 * f,
    electricalNoiseHz: 600,
    electricalNoiseAmplitude: 0.8 * f,
    injectSteps: false,
    iInterval: 2,
  });
}

/**
 * Generate a demo BBL buffer for Flash Tune verification flight (post-tune).
 *
 * Unlike Filter/PID Tune verification (hover-only), Flash Tune verification needs
 * broadband setpoint excitation for Wiener deconvolution to produce meaningful
 * transfer function / step response results.
 *
 * Uses the same continuous broadband setpoint as generateFlashDemoBBL but with:
 * - IMPROVED response params (higher damping, higher bandwidth, lower latency)
 *   simulating the effect of applied tuning recommendations
 * - Lower noise floor (post-tune improvement)
 * - Same amplitude and duration as the original flash flight
 *
 * The response improvement is computed by advancing one cycle ahead of the current
 * cycle's params, clamped to cycle+1 for realistic post-tune improvement.
 *
 * @param cycle - Tuning cycle number (0 = first, higher = progressively cleaner)
 */
export function generateFlashVerificationDemoBBL(cycle = 0): Buffer {
  const f = progressiveFactor(cycle);
  // Use cycle+1 response params to simulate post-tune improvement
  const improvedResponseParams = computeCycleResponseParams(cycle + 1);
  logger.info(
    `[DEMO] Generating Flash Tune verification demo BBL (cycle ${cycle}, factor ${f.toFixed(2)}, improved response from cycle ${cycle + 1})...`
  );
  return buildDemoSession({
    frameCount: 80000, // 20s at 4000 Hz (same as flash flight)
    gyroBase: [2, -1, 0],
    noiseAmplitude: 3 * f, // Low noise (post-tune)
    motorHarmonicHz: 160,
    motorHarmonicAmplitude: 5 * f, // Low harmonics (post-tune)
    electricalNoiseHz: 600,
    electricalNoiseAmplitude: 0.8 * f,
    injectSteps: false,
    iInterval: 2,
    responseParams: improvedResponseParams,
    continuousSetpoint: true,
    continuousSetpointAmplitude: 150, // Same as flash flight
  });
}

/**
 * Generate a demo BBL buffer for Flash Tune (single flight with normal flying).
 *
 * Uses continuous broadband setpoint (deterministic summed sinusoids) simulating
 * normal pilot stick movement. The gyro tracks this via a discrete-time second-order
 * system model, providing rich broadband excitation for Wiener deconvolution.
 *
 * Contains one session with:
 * - ~20 seconds of flight data at 4000 Hz (I-frame only, iInterval=2)
 * - Cycle-dependent noise floor (for filter analysis from hover segments)
 * - Continuous broadband setpoint (for transfer function estimation)
 * - Cycle-dependent tracking quality (damping, bandwidth, latency)
 * - Multi-phase throttle profile for segment detection
 *
 * @param cycle - Tuning cycle number (0 = first, higher = progressively cleaner)
 */
export function generateFlashDemoBBL(cycle = 0): Buffer {
  const f = progressiveFactor(cycle);
  logger.info(`[DEMO] Generating Flash Tune demo BBL (cycle ${cycle}, factor ${f.toFixed(2)})...`);
  return buildDemoSession({
    frameCount: 80000, // 20s at 4000 Hz
    gyroBase: [2, -1, 0],
    noiseAmplitude: 8 * f,
    motorHarmonicHz: 160,
    motorHarmonicAmplitude: 20 * f,
    electricalNoiseHz: 600,
    electricalNoiseAmplitude: 4 * f,
    injectSteps: false,
    iInterval: 2,
    responseParams: computeCycleResponseParams(cycle),
    continuousSetpoint: true,
    continuousSetpointAmplitude: 150,
  });
}

/**
 * Generate a combined demo BBL with both filter-suitable and PID-suitable sessions.
 * Session 1: hover + noise (for filter analysis)
 * Session 2: stick snaps (for PID analysis)
 *
 * @param cycle - Tuning cycle number (0 = first, higher = progressively cleaner)
 */
export function generateCombinedDemoBBL(cycle = 0): Buffer {
  const f = progressiveFactor(cycle);
  logger.info(`[DEMO] Generating combined demo BBL (cycle ${cycle}, factor ${f.toFixed(2)})...`);

  const filterSession = buildDemoSession({
    frameCount: 40000,
    gyroBase: [2, -1, 0],
    noiseAmplitude: 15 * f,
    motorHarmonicHz: 160,
    motorHarmonicAmplitude: 40 * f,
    electricalNoiseHz: 600,
    electricalNoiseAmplitude: 8 * f,
    injectSteps: false,
    iInterval: 2,
  });

  // 50 bytes of garbage between sessions (normal in multi-session BBL files)
  const garbage = Buffer.alloc(50);
  for (let i = 0; i < 50; i++) {
    garbage[i] = [0x00, 0x02, 0x04, 0xab, 0xcd][i % 5];
  }

  const pidSession = buildDemoSession({
    frameCount: 76000,
    gyroBase: [0, 0, 0],
    noiseAmplitude: 5 * f,
    motorHarmonicHz: 160,
    motorHarmonicAmplitude: 8 * f,
    electricalNoiseHz: 600,
    electricalNoiseAmplitude: 2 * f,
    injectSteps: true,
    iInterval: 2,
    responseParams: computeCycleResponseParams(cycle),
  });

  return Buffer.concat([filterSession, garbage, pidSession]);
}

// ── Stress-test BBL generators ──────────────────────────────────

/**
 * Generate a short, poor-quality BBL with few data points.
 * Triggers low data quality warnings (few_segments, short_hover_time, few_steps_per_axis).
 */
export function generatePoorQualityBBL(): Buffer {
  logger.info('[DEMO] Generating poor quality BBL (short, few steps)...');
  return buildDemoSession({
    frameCount: 8000, // 2s at 4000 Hz — very short
    gyroBase: [2, -1, 0],
    noiseAmplitude: 20,
    motorHarmonicHz: 160,
    motorHarmonicAmplitude: 50,
    electricalNoiseHz: 600,
    electricalNoiseAmplitude: 10,
    injectSteps: true,
    iInterval: 2,
    responseParams: computeCycleResponseParams(0),
  });
}

/**
 * Generate a BBL with extreme noise and asymmetric axes.
 * Triggers mechanical health warnings (extreme_noise, axis_asymmetry).
 */
export function generateMechanicalIssueBBL(): Buffer {
  logger.info('[DEMO] Generating mechanical issue BBL (extreme noise, asymmetry)...');
  return buildDemoSession({
    frameCount: 40000, // 10s
    gyroBase: [2, -1, 0],
    noiseAmplitude: 60, // Very high noise → extreme noise floor
    motorHarmonicHz: 140, // Lower motor harmonic (bent prop)
    motorHarmonicAmplitude: 120, // Massive harmonic
    electricalNoiseHz: 500,
    electricalNoiseAmplitude: 25,
    injectSteps: false,
    iInterval: 2,
    axisAsymmetry: 3.0, // Roll noise 3x higher than pitch
  });
}

/**
 * Generate a BBL with very high noise — simulates windy conditions.
 * High gyro variance during hover triggers wind disturbance detection.
 */
export function generateWindyFlightBBL(): Buffer {
  logger.info('[DEMO] Generating windy flight BBL (high hover variance)...');
  return buildDemoSession({
    frameCount: 40000, // 10s
    gyroBase: [2, -1, 0],
    noiseAmplitude: 35, // High noise in hover
    motorHarmonicHz: 160,
    motorHarmonicAmplitude: 30,
    electricalNoiseHz: 600,
    electricalNoiseAmplitude: 8,
    injectSteps: true,
    iInterval: 2,
    responseParams: computeCycleResponseParams(0),
  });
}
