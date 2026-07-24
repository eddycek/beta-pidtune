/** A single axis PID term (0-255 range) */
export interface PIDTerm {
  P: number;
  I: number;
  D: number;
}

/** PID term extended with feedforward gain */
export interface PIDFTerm extends PIDTerm {
  F: number;
}

/** PID configuration for all axes */
export interface PIDConfiguration {
  roll: PIDTerm;
  pitch: PIDTerm;
  yaw: PIDTerm;
}

/** Rate type as reported by Betaflight (MSP_RC_TUNING byte 22, BF 4.3+) */
export type RatesType = 'BETAFLIGHT' | 'RACEFLIGHT' | 'KISS' | 'ACTUAL' | 'QUICK';

/** Per-axis rate values */
export interface AxisRates {
  rcRate: number;
  rate: number;
  rcExpo: number;
  rateLimit: number;
}

/** RC rates configuration from MSP_RC_TUNING (BF 4.3+, API 1.44+) */
export interface RatesConfiguration {
  ratesType: RatesType;
  roll: AxisRates;
  pitch: AxisRates;
  yaw: AxisRates;
}

/** Feedforward configuration from MSP_PID_ADVANCED (BF 4.3+, API 1.44+) */
export interface FeedforwardConfiguration {
  /** Center-stick FF attenuation (0-100) */
  transition: number;
  /** Per-axis FF gains */
  rollGain: number;
  pitchGain: number;
  yawGain: number;
  /** Stick acceleration component (default 15) */
  boost: number;
  /** FF smoothing (default 37) */
  smoothFactor: number;
  /** Dynamic attenuation for slow inputs (default 7) */
  jitterFactor: number;
  /** Predictive overshoot prevention (default 100) */
  maxRateLimit: number;
  /** D-min per-axis values (0 = disabled) */
  dMinRoll?: number;
  dMinPitch?: number;
  dMinYaw?: number;
  /** D-min boost gain (how fast D ramps up during propwash/stick input) */
  dMinGain?: number;
  /** D-min advance (predictive D boost, 0 = best for most quads) */
  dMinAdvance?: number;
  /** I-term relax mode: 0=OFF, 1=RP, 2=RPY */
  itermRelax?: number;
  /** I-term relax type: 0=GYRO, 1=SETPOINT */
  itermRelaxType?: number;
  /** I-term relax cutoff frequency (Hz) */
  itermRelaxCutoff?: number;
  /** FF averaging mode: 0=OFF, 2=2_POINT, 3=3_POINT, 4=4_POINT (API >= 1.44) */
  averaging?: number;
  /** Dynamic idle minimum RPM (in 100-RPM units) */
  dynIdleMinRpm?: number;
  /** VBat sag compensation strength (0-150) */
  vbatSagCompensation?: number;
  /** Thrust linearization (0-150) */
  thrustLinear?: number;
  /** Anti-gravity gain (BF 4.4+ 0-250 scale; only reported on API >= 1.45 layouts) */
  antiGravityGain?: number;
  /** TPA mode: 0=D-only, 1=PD (API >= 1.45) */
  tpaMode?: number;
  /** TPA rate (0-250, API >= 1.45) */
  tpaRate?: number;
  /** TPA breakpoint (throttle 750-2000, API >= 1.45) */
  tpaBreakpoint?: number;
}
