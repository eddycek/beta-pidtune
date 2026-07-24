/**
 * MSP Response Factory — builds valid MSP binary response buffers for testing.
 *
 * Follows Betaflight Configurator's pattern of constructing raw DataView buffers
 * with push8/push16/push32 helpers for byte-exact MSP response simulation.
 */

import type { PIDConfiguration } from '@shared/types/pid.types';
import type { CurrentFilterSettings } from '@shared/types/analysis.types';
import type { BlackboxInfo } from '@shared/types/blackbox.types';
import { MSP_PROTOCOL } from '../types';
import {
  writeField,
  FILTER_CONFIG,
  PID_ADVANCED,
  ADVANCED_CONFIG,
  DATAFLASH_SUMMARY,
  SDCARD_SUMMARY,
} from '../mspLayouts';

// ─── Binary buffer helpers ───────────────────────────────────────────

export function push8(arr: number[], value: number): void {
  arr.push(value & 0xff);
}

export function push16LE(arr: number[], value: number): void {
  arr.push(value & 0xff, (value >> 8) & 0xff);
}

export function push32LE(arr: number[], value: number): void {
  arr.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
}

export function pushString(arr: number[], str: string, prefixLength = false): void {
  if (prefixLength) {
    push8(arr, str.length);
  }
  for (let i = 0; i < str.length; i++) {
    arr.push(str.charCodeAt(i));
  }
}

export function toBuffer(arr: number[]): Buffer {
  return Buffer.from(arr);
}

// ─── MSP frame builders ─────────────────────────────────────────────

/**
 * Build a complete MSP v1 response frame (direction: FC → host)
 */
export function buildMSPv1Response(command: number, data: Buffer | number[]): Buffer {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const size = payload.length;

  const frame = Buffer.alloc(6 + size);
  frame[0] = MSP_PROTOCOL.PREAMBLE1; // '$'
  frame[1] = MSP_PROTOCOL.PREAMBLE2; // 'M'
  frame[2] = MSP_PROTOCOL.DIRECTION_FROM_FC; // '>'
  frame[3] = size;
  frame[4] = command;

  if (size > 0) {
    payload.copy(frame, 5);
  }

  let checksum = size ^ command;
  for (let i = 0; i < size; i++) {
    checksum ^= payload[i];
  }
  frame[5 + size] = checksum;

  return frame;
}

/**
 * Build a complete MSP v1 error response frame (direction: '!')
 */
export function buildMSPv1ErrorResponse(command: number): Buffer {
  const frame = Buffer.alloc(6);
  frame[0] = MSP_PROTOCOL.PREAMBLE1;
  frame[1] = MSP_PROTOCOL.PREAMBLE2;
  frame[2] = MSP_PROTOCOL.ERROR; // '!'
  frame[3] = 0; // no data
  frame[4] = command;
  frame[5] = 0 ^ command; // checksum
  return frame;
}

/**
 * Build a complete MSP jumbo frame response
 */
export function buildMSPJumboResponse(command: number, data: Buffer | number[]): Buffer {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const size = payload.length;

  const frame = Buffer.alloc(8 + size);
  frame[0] = MSP_PROTOCOL.PREAMBLE1;
  frame[1] = MSP_PROTOCOL.PREAMBLE2;
  frame[2] = MSP_PROTOCOL.DIRECTION_FROM_FC;
  frame[3] = 0xff; // jumbo flag
  frame.writeUInt16LE(size, 4);
  frame[6] = command;

  if (size > 0) {
    payload.copy(frame, 7);
  }

  let checksum = (size & 0xff) ^ (size >> 8) ^ command;
  for (let i = 0; i < size; i++) {
    checksum ^= payload[i];
  }
  frame[7 + size] = checksum;

  return frame;
}

// ─── MSP response data builders (payload only, no frame wrapper) ────

/** MSP_API_VERSION (1) — 3 bytes: protocol, major, minor */
export function buildAPIVersionData(major: number, minor: number, protocol = 0): Buffer {
  return toBuffer([protocol, major, minor]);
}

/** MSP_FC_VARIANT (2) — 4 bytes: variant string */
export function buildFCVariantData(variant = 'BTFL'): Buffer {
  return Buffer.from(variant.slice(0, 4).padEnd(4, '\0'));
}

/** MSP_FC_VERSION (3) — 3 bytes: major, minor, patch */
export function buildFCVersionData(major: number, minor: number, patch: number): Buffer {
  return toBuffer([major, minor, patch]);
}

/** MSP_BOARD_INFO (4) — variable length board info */
export function buildBoardInfoData(
  opts: {
    boardId?: string;
    hwRevision?: number;
    boardType?: number;
    targetName?: string;
    boardName?: string;
    manufacturerId?: string;
  } = {}
): Buffer {
  const {
    boardId = 'S405',
    hwRevision = 0,
    boardType = 0,
    targetName = 'STM32F405',
    boardName = '',
    manufacturerId = '',
  } = opts;

  const arr: number[] = [];
  pushString(arr, boardId.slice(0, 4).padEnd(4, '\0'));
  push16LE(arr, hwRevision);
  push8(arr, boardType);
  push8(arr, targetName.length);
  pushString(arr, targetName);
  push8(arr, boardName.length);
  if (boardName.length > 0) pushString(arr, boardName);
  push8(arr, manufacturerId.length);
  if (manufacturerId.length > 0) pushString(arr, manufacturerId);
  push8(arr, 0); // signature length
  push8(arr, 0); // mcuTypeId
  push8(arr, 0); // configurationState

  return toBuffer(arr);
}

/** MSP_UID (160) — 12 bytes: 3× uint32 LE */
export function buildUIDData(uid: [number, number, number]): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt32LE(uid[0], 0);
  buf.writeUInt32LE(uid[1], 4);
  buf.writeUInt32LE(uid[2], 8);
  return buf;
}

/** MSP_PID (112) — 30 bytes (first 9 are R/P/Y P/I/D) */
export function buildPIDData(config: PIDConfiguration): Buffer {
  const buf = Buffer.alloc(30, 0);
  buf[0] = config.roll.P;
  buf[1] = config.roll.I;
  buf[2] = config.roll.D;
  buf[3] = config.pitch.P;
  buf[4] = config.pitch.I;
  buf[5] = config.pitch.D;
  buf[6] = config.yaw.P;
  buf[7] = config.yaw.I;
  buf[8] = config.yaw.D;
  return buf;
}

/** MSP_FILTER_CONFIG (92) — 49 bytes (full BF 4.3+ response) */
export function buildFilterConfigData(settings: Partial<CurrentFilterSettings> = {}): Buffer {
  const buf = Buffer.alloc(FILTER_CONFIG.FULL_RESPONSE_LENGTH, 0);
  if (settings.dterm_lpf1_static_hz !== undefined)
    writeField(buf, FILTER_CONFIG.DTERM_LPF1_HZ, settings.dterm_lpf1_static_hz);
  if (settings.gyro_lpf1_static_hz !== undefined)
    writeField(buf, FILTER_CONFIG.GYRO_LPF1_HZ, settings.gyro_lpf1_static_hz);
  if (settings.gyro_lpf2_static_hz !== undefined)
    writeField(buf, FILTER_CONFIG.GYRO_LPF2_HZ, settings.gyro_lpf2_static_hz);
  if (settings.dterm_lpf2_static_hz !== undefined)
    writeField(buf, FILTER_CONFIG.DTERM_LPF2_HZ, settings.dterm_lpf2_static_hz);
  if (settings.dyn_notch_q !== undefined)
    writeField(buf, FILTER_CONFIG.DYN_NOTCH_Q, settings.dyn_notch_q);
  if (settings.dyn_notch_min_hz !== undefined)
    writeField(buf, FILTER_CONFIG.DYN_NOTCH_MIN_HZ, settings.dyn_notch_min_hz);
  if (settings.rpm_filter_harmonics !== undefined)
    writeField(buf, FILTER_CONFIG.RPM_HARMONICS, settings.rpm_filter_harmonics);
  if (settings.rpm_filter_min_hz !== undefined)
    writeField(buf, FILTER_CONFIG.RPM_MIN_HZ, settings.rpm_filter_min_hz);
  if (settings.dyn_notch_max_hz !== undefined)
    writeField(buf, FILTER_CONFIG.DYN_NOTCH_MAX_HZ, settings.dyn_notch_max_hz);
  if (settings.dyn_notch_count !== undefined)
    writeField(buf, FILTER_CONFIG.DYN_NOTCH_COUNT, settings.dyn_notch_count);
  return buf;
}

/** MSP_DATAFLASH_SUMMARY (70) — 13 bytes */
export function buildDataflashSummaryData(
  info: Partial<BlackboxInfo> & { ready?: number; sectors?: number } = {}
): Buffer {
  const buf = Buffer.alloc(13, 0);
  const ready = info.ready ?? (info.supported !== false ? 0x03 : 0x01);
  writeField(buf, DATAFLASH_SUMMARY.FLAGS, ready);
  writeField(buf, DATAFLASH_SUMMARY.SECTORS, info.sectors ?? 0);
  writeField(buf, DATAFLASH_SUMMARY.TOTAL_SIZE, info.totalSize ?? 0);
  writeField(buf, DATAFLASH_SUMMARY.USED_SIZE, info.usedSize ?? 0);
  return buf;
}

/** MSP_ADVANCED_CONFIG (90) — 8+ bytes (byte 1 = pid_process_denom) */
export function buildAdvancedConfigData(pidProcessDenom: number, gyroSyncDenom = 1): Buffer {
  const buf = Buffer.alloc(8, 0);
  writeField(buf, ADVANCED_CONFIG.GYRO_SYNC_DENOM, gyroSyncDenom);
  writeField(buf, ADVANCED_CONFIG.PID_PROCESS_DENOM, pidProcessDenom);
  return buf;
}

/** MSP_PID_ADVANCED (94) — 55+ bytes (feedforward configuration, BF 4.3+).
 * Pass `fullLayout: true` for the API 1.45+ 61-byte layout that carries
 * vbat sag / thrust linearization / anti-gravity gain / TPA fields. */
export function buildPIDAdvancedData(
  opts: {
    ffTransition?: number;
    ffRoll?: number;
    ffPitch?: number;
    ffYaw?: number;
    ffSmoothFactor?: number;
    ffBoost?: number;
    ffMaxRateLimit?: number;
    ffJitterFactor?: number;
    dMinRoll?: number;
    dMinPitch?: number;
    dMinYaw?: number;
    dMinGain?: number;
    dMinAdvance?: number;
    itermRelax?: number;
    itermRelaxType?: number;
    itermRelaxCutoff?: number;
    ffAveraging?: number;
    dynIdleMinRpm?: number;
    fullLayout?: boolean;
    vbatSagCompensation?: number;
    thrustLinear?: number;
    antiGravityGain?: number;
    tpaMode?: number;
    tpaRate?: number;
    tpaBreakpoint?: number;
  } = {}
): Buffer {
  const buf = Buffer.alloc(opts.fullLayout ? 61 : 55, 0);
  if (opts.ffAveraging !== undefined) writeField(buf, PID_ADVANCED.FF_AVERAGING, opts.ffAveraging);
  if (opts.dynIdleMinRpm !== undefined)
    writeField(buf, PID_ADVANCED.IDLE_MIN_RPM, opts.dynIdleMinRpm);
  if (opts.fullLayout) {
    if (opts.vbatSagCompensation !== undefined)
      writeField(buf, PID_ADVANCED.VBAT_SAG_COMPENSATION, opts.vbatSagCompensation);
    if (opts.thrustLinear !== undefined)
      writeField(buf, PID_ADVANCED.THRUST_LINEARIZATION, opts.thrustLinear);
    if (opts.antiGravityGain !== undefined)
      writeField(buf, PID_ADVANCED.ANTI_GRAVITY_GAIN, opts.antiGravityGain);
    if (opts.tpaMode !== undefined) writeField(buf, PID_ADVANCED.TPA_MODE, opts.tpaMode);
    if (opts.tpaRate !== undefined) writeField(buf, PID_ADVANCED.TPA_RATE, opts.tpaRate);
    if (opts.tpaBreakpoint !== undefined)
      writeField(buf, PID_ADVANCED.TPA_BREAKPOINT, opts.tpaBreakpoint);
  }
  if (opts.ffTransition !== undefined)
    writeField(buf, PID_ADVANCED.FF_TRANSITION, opts.ffTransition);
  if (opts.ffRoll !== undefined) writeField(buf, PID_ADVANCED.FF_ROLL, opts.ffRoll);
  if (opts.ffPitch !== undefined) writeField(buf, PID_ADVANCED.FF_PITCH, opts.ffPitch);
  if (opts.ffYaw !== undefined) writeField(buf, PID_ADVANCED.FF_YAW, opts.ffYaw);
  if (opts.ffSmoothFactor !== undefined)
    writeField(buf, PID_ADVANCED.FF_SMOOTH_FACTOR, opts.ffSmoothFactor);
  if (opts.ffBoost !== undefined) writeField(buf, PID_ADVANCED.FF_BOOST, opts.ffBoost);
  if (opts.ffMaxRateLimit !== undefined)
    writeField(buf, PID_ADVANCED.FF_MAX_RATE_LIMIT, opts.ffMaxRateLimit);
  if (opts.ffJitterFactor !== undefined)
    writeField(buf, PID_ADVANCED.FF_JITTER_FACTOR, opts.ffJitterFactor);
  if (opts.dMinRoll !== undefined) writeField(buf, PID_ADVANCED.DMIN_ROLL, opts.dMinRoll);
  if (opts.dMinPitch !== undefined) writeField(buf, PID_ADVANCED.DMIN_PITCH, opts.dMinPitch);
  if (opts.dMinYaw !== undefined) writeField(buf, PID_ADVANCED.DMIN_YAW, opts.dMinYaw);
  if (opts.dMinGain !== undefined) writeField(buf, PID_ADVANCED.DMIN_GAIN, opts.dMinGain);
  if (opts.dMinAdvance !== undefined) writeField(buf, PID_ADVANCED.DMIN_ADVANCE, opts.dMinAdvance);
  if (opts.itermRelax !== undefined) writeField(buf, PID_ADVANCED.ITERM_RELAX, opts.itermRelax);
  if (opts.itermRelaxType !== undefined)
    writeField(buf, PID_ADVANCED.ITERM_RELAX_TYPE, opts.itermRelaxType);
  if (opts.itermRelaxCutoff !== undefined)
    writeField(buf, PID_ADVANCED.ITERM_RELAX_CUTOFF, opts.itermRelaxCutoff);
  return buf;
}

// ─── Preset FC states ───────────────────────────────────────────────

export interface MockFCState {
  variant: string;
  version: { major: number; minor: number; patch: number };
  api: { protocol: number; major: number; minor: number };
  board: { boardId: string; targetName: string; boardName: string };
  uid: [number, number, number];
}

export const FC_STATES: Record<string, MockFCState> = {
  BF_4_3: {
    variant: 'BTFL',
    version: { major: 4, minor: 3, patch: 0 },
    api: { protocol: 0, major: 1, minor: 44 },
    board: { boardId: 'S405', targetName: 'STM32F405', boardName: 'MAMBAF405' },
    uid: [0x00360024, 0x32385106, 0x31383730],
  },
  BF_4_5: {
    variant: 'BTFL',
    version: { major: 4, minor: 5, patch: 1 },
    api: { protocol: 0, major: 1, minor: 46 },
    board: { boardId: 'S7X2', targetName: 'STM32F7X2', boardName: 'SPEEDYBEEF7V3' },
    uid: [0x00440032, 0x42385206, 0x41383830],
  },
  BF_2025_12: {
    variant: 'BTFL',
    version: { major: 4, minor: 6, patch: 0 },
    api: { protocol: 0, major: 1, minor: 47 },
    board: { boardId: 'SH74', targetName: 'STM32H743', boardName: 'SPEEDYBEEH7V2' },
    uid: [0x00550043, 0x52385306, 0x51383930],
  },
};
