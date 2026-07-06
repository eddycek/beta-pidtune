/**
 * MSP binary response/request layouts — byte offsets for each MSP command.
 *
 * Source: betaflight-configurator MSPHelper.js (master branch)
 * https://github.com/betaflight/betaflight-configurator/blob/master/src/js/msp/MSPHelper.js
 *
 * Each field specifies its byte offset and data type.
 * Use readField(buf, LAYOUT.FIELD) / writeField(buf, LAYOUT.FIELD, value)
 * instead of raw Buffer.readUInt8(offset) / Buffer.writeUInt16LE(value, offset).
 */

// ---- Types ----

/** Data type of an MSP field — determines which Buffer read/write method to use */
export type MSPFieldType = 'U8' | 'U16' | 'U32' | 'S8';

/** A single field in an MSP response/request layout */
export interface MSPField {
  /** Byte offset in the response buffer */
  readonly offset: number;
  /** Data type */
  readonly type: MSPFieldType;
  /** Human-readable field name (for logging/debugging) */
  readonly name: string;
}

// ---- Field constructors ----

function u8(offset: number, name: string): MSPField {
  return { offset, type: 'U8', name };
}
function u16(offset: number, name: string): MSPField {
  return { offset, type: 'U16', name };
}
function u32(offset: number, name: string): MSPField {
  return { offset, type: 'U32', name };
}

// ---- Read/Write helpers ----

/** Read a field value from an MSP response buffer */
export function readField(buf: Buffer, field: MSPField): number {
  switch (field.type) {
    case 'U8':
      return buf.readUInt8(field.offset);
    case 'U16':
      return buf.readUInt16LE(field.offset);
    case 'U32':
      return buf.readUInt32LE(field.offset);
    case 'S8':
      return buf.readInt8(field.offset);
  }
}

/** Write a field value to an MSP request buffer */
export function writeField(buf: Buffer, field: MSPField, value: number): void {
  switch (field.type) {
    case 'U8':
      buf.writeUInt8(value, field.offset);
      break;
    case 'U16':
      buf.writeUInt16LE(value, field.offset);
      break;
    case 'U32':
      buf.writeUInt32LE(value, field.offset);
      break;
    case 'S8':
      buf.writeInt8(value, field.offset);
      break;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MSP_FILTER_CONFIG (92) / MSP_SET_FILTER_CONFIG (93)
// 49 bytes, stable from API 1.44+ (BF 4.3+)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const FILTER_CONFIG = {
  GYRO_LPF1_HZ_LEGACY: u8(0, 'gyro_lpf1_hz_legacy'),
  DTERM_LPF1_HZ: u16(1, 'dterm_lpf1_static_hz'),
  YAW_LOWPASS_HZ: u16(3, 'yaw_lowpass_hz'),
  GYRO_NOTCH_HZ: u16(5, 'gyro_notch_hz'),
  GYRO_NOTCH_CUTOFF: u16(7, 'gyro_notch_cutoff'),
  DTERM_NOTCH_HZ: u16(9, 'dterm_notch_hz'),
  DTERM_NOTCH_CUTOFF: u16(11, 'dterm_notch_cutoff'),
  GYRO_NOTCH2_HZ: u16(13, 'gyro_notch2_hz'),
  GYRO_NOTCH2_CUTOFF: u16(15, 'gyro_notch2_cutoff'),
  DTERM_LPF1_TYPE: u8(17, 'dterm_lpf1_type'),
  GYRO_HARDWARE_LPF: u8(18, 'gyro_hardware_lpf'),
  // Offset 19: unused (gyro_32khz_hardware_lpf, always 0)
  GYRO_LPF1_HZ: u16(20, 'gyro_lpf1_static_hz'),
  GYRO_LPF2_HZ: u16(22, 'gyro_lpf2_static_hz'),
  GYRO_LPF1_TYPE: u8(24, 'gyro_lpf1_type'),
  GYRO_LPF2_TYPE: u8(25, 'gyro_lpf2_type'),
  DTERM_LPF2_HZ: u16(26, 'dterm_lpf2_static_hz'),
  DTERM_LPF2_TYPE: u8(28, 'dterm_lpf2_type'),
  GYRO_DYN_LPF_MIN: u16(29, 'gyro_lpf1_dyn_min_hz'),
  GYRO_DYN_LPF_MAX: u16(31, 'gyro_lpf1_dyn_max_hz'),
  DTERM_DYN_LPF_MIN: u16(33, 'dterm_lpf1_dyn_min_hz'),
  DTERM_DYN_LPF_MAX: u16(35, 'dterm_lpf1_dyn_max_hz'),
  DYN_NOTCH_RANGE: u8(37, 'dyn_notch_range'), // deprecated
  DYN_NOTCH_WIDTH_PERCENT: u8(38, 'dyn_notch_width_percent'), // deprecated
  DYN_NOTCH_Q: u16(39, 'dyn_notch_q'),
  DYN_NOTCH_MIN_HZ: u16(41, 'dyn_notch_min_hz'),
  RPM_HARMONICS: u8(43, 'rpm_filter_harmonics'),
  RPM_MIN_HZ: u8(44, 'rpm_filter_min_hz'),
  DYN_NOTCH_MAX_HZ: u16(45, 'dyn_notch_max_hz'),
  DYN_LPF_CURVE_EXPO: u8(47, 'dterm_lpf1_dyn_expo'),
  DYN_NOTCH_COUNT: u8(48, 'dyn_notch_count'),
  /** Minimum valid response length (47 bytes base, 49 with expo+count) */
  MIN_RESPONSE_LENGTH: 47,
  FULL_RESPONSE_LENGTH: 49,
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MSP_PID_ADVANCED (94) / MSP_SET_PID_ADVANCED (95)
// ~61 bytes, BF 4.3+ (API 1.44+)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const PID_ADVANCED = {
  FF_TRANSITION: u8(8, 'feedforward_transition'),
  ANTI_GRAVITY_GAIN: u16(21, 'anti_gravity_gain'), // API >= 1.45
  ITERM_ROTATION: u8(25, 'iterm_rotation'),
  ITERM_RELAX: u8(27, 'iterm_relax'),
  ITERM_RELAX_TYPE: u8(28, 'iterm_relax_type'),
  THROTTLE_BOOST: u8(30, 'throttle_boost'),
  FF_ROLL: u16(32, 'feedforward_roll'),
  FF_PITCH: u16(34, 'feedforward_pitch'),
  FF_YAW: u16(36, 'feedforward_yaw'),
  ANTI_GRAVITY_MODE: u8(38, 'anti_gravity_mode'),
  DMIN_ROLL: u8(39, 'd_min_roll'),
  DMIN_PITCH: u8(40, 'd_min_pitch'),
  DMIN_YAW: u8(41, 'd_min_yaw'),
  DMIN_GAIN: u8(42, 'd_min_gain'),
  DMIN_ADVANCE: u8(43, 'd_min_advance'),
  USE_INTEGRATED_YAW: u8(44, 'use_integrated_yaw'),
  INTEGRATED_YAW_RELAX: u8(45, 'integrated_yaw_relax'),
  ITERM_RELAX_CUTOFF: u8(46, 'iterm_relax_cutoff'), // API >= 1.42
  MOTOR_OUTPUT_LIMIT: u8(47, 'motor_output_limit'), // API >= 1.43
  IDLE_MIN_RPM: u8(49, 'idle_min_rpm'),
  FF_AVERAGING: u8(50, 'feedforward_averaging'), // API >= 1.44
  FF_SMOOTH_FACTOR: u8(51, 'feedforward_smooth_factor'),
  FF_BOOST: u8(52, 'feedforward_boost'),
  FF_MAX_RATE_LIMIT: u8(53, 'feedforward_max_rate_limit'),
  FF_JITTER_FACTOR: u8(54, 'feedforward_jitter_factor'),
  VBAT_SAG_COMPENSATION: u8(55, 'vbat_sag_compensation'),
  THRUST_LINEARIZATION: u8(56, 'thrust_linearization'),
  TPA_MODE: u8(57, 'tpa_mode'), // API >= 1.45
  TPA_RATE: u8(58, 'tpa_rate'),
  TPA_BREAKPOINT: u16(59, 'tpa_breakpoint'),
  /** Minimum length needed to read feedforward fields (up to offset 54) */
  MIN_RESPONSE_LENGTH: 55,
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MSP_RC_TUNING (111) / MSP_SET_RC_TUNING (204)
// ~24 bytes, BF 4.3+
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const RC_TUNING = {
  RC_RATE_ROLL: u8(0, 'rc_rate_roll'),
  RC_EXPO_ROLL: u8(1, 'rc_expo_roll'),
  ROLL_RATE: u8(2, 'roll_rate'),
  PITCH_RATE: u8(3, 'pitch_rate'),
  YAW_RATE: u8(4, 'yaw_rate'),
  RC_YAW_EXPO: u8(10, 'rc_yaw_expo'),
  RC_YAW_RATE: u8(11, 'rc_yaw_rate'),
  RC_PITCH_RATE: u8(12, 'rc_pitch_rate'),
  RC_PITCH_EXPO: u8(13, 'rc_pitch_expo'),
  ROLL_RATE_LIMIT: u16(16, 'roll_rate_limit'),
  PITCH_RATE_LIMIT: u16(18, 'pitch_rate_limit'),
  YAW_RATE_LIMIT: u16(20, 'yaw_rate_limit'),
  RATES_TYPE: u8(22, 'rates_type'),
  MIN_RESPONSE_LENGTH: 23,
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MSP_ADVANCED_CONFIG (90) / MSP_SET_ADVANCED_CONFIG (91)
// 20 bytes read, 19 bytes write
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const ADVANCED_CONFIG = {
  GYRO_SYNC_DENOM: u8(0, 'gyro_sync_denom'),
  PID_PROCESS_DENOM: u8(1, 'pid_process_denom'),
  // debug_mode (offset 18) intentionally not mapped — analysis reads it from
  // the BBL header (flight-time value), never via MSP.
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MSP_DATAFLASH_SUMMARY (70)
// 13 bytes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const DATAFLASH_SUMMARY = {
  FLAGS: u8(0, 'flags'), // bit0=ready, bit1=supported
  SECTORS: u32(1, 'sectors'),
  TOTAL_SIZE: u32(5, 'totalSize'),
  USED_SIZE: u32(9, 'usedSize'),
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MSP_SDCARD_SUMMARY (79)
// 11 bytes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const SDCARD_SUMMARY = {
  FLAGS: u8(0, 'flags'), // bit0=supported
  STATE: u8(1, 'state'),
  LAST_ERROR: u8(2, 'filesystemLastError'),
  FREE_SIZE_KB: u32(3, 'freeSizeKB'),
  TOTAL_SIZE_KB: u32(7, 'totalSizeKB'),
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MSP_STATUS_EX (150)
// Variable length
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const STATUS_EX = {
  CYCLE_TIME: u16(0, 'cycleTime'),
  I2C_ERROR: u16(2, 'i2cError'),
  ACTIVE_SENSORS: u16(4, 'activeSensors'),
  MODE: u32(6, 'mode'),
  PID_PROFILE_INDEX: u8(10, 'pidProfileIndex'),
  CPU_LOAD: u16(11, 'cpuload'),
  /** @deprecated Offsets of PID_PROFILE_COUNT and RATE_PROFILE differ between BF/MSP versions.
   *  In some versions byte 13 is rateProfile and byte 14 is unused; in others the layout differs.
   *  MSPClient derives profile/rate information from API version instead, so these fields are
   *  intentionally unused and unsafe to read. */
  PID_PROFILE_COUNT: u8(13, 'numProfiles'),
  /** @deprecated See PID_PROFILE_COUNT — offset is not reliable across BF/MSP versions. */
  RATE_PROFILE: u8(14, 'rateProfile'),
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MSP_BOARD_INFO (4)
// Variable length
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const BOARD_INFO = {
  BOARD_VERSION: u16(4, 'boardVersion'),
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MSP_DATAFLASH_READ (71)
// Request: 6 bytes. Response header: 6-7 bytes.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const DATAFLASH_READ_REQUEST = {
  ADDRESS: u32(0, 'address'),
  SIZE: u16(4, 'chunkSize'),
} as const;

export const DATAFLASH_READ_RESPONSE = {
  DATA_SIZE: u16(4, 'dataSize'),
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MSP_SELECT_SETTING (210) / MSP_REBOOT (68)
// 1-byte payloads
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const SELECT_SETTING = {
  PROFILE_INDEX: u8(0, 'profileIndex'),
} as const;

export const REBOOT = {
  REBOOT_TYPE: u8(0, 'rebootType'),
} as const;
