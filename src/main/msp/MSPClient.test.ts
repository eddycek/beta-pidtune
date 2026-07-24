import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MSPClient } from './MSPClient';
import { MSPCommand } from './types';
import { TimeoutError } from '../utils/errors';
import {
  buildAPIVersionData,
  buildFCVariantData,
  buildFCVersionData,
  buildBoardInfoData,
  buildUIDData,
  buildPIDData,
  buildPIDAdvancedData,
  buildDataflashSummaryData,
} from './test/mspResponseFactory';
import {
  writeField,
  FILTER_CONFIG,
  PID_ADVANCED,
  ADVANCED_CONFIG,
  DATAFLASH_SUMMARY,
  STATUS_EX,
  SDCARD_SUMMARY,
} from './mspLayouts';

// Mock dependencies
vi.mock('serialport', () => ({
  SerialPort: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../utils/errors', () => ({
  ConnectionError: class extends Error {
    constructor(
      m: string,
      public details?: any
    ) {
      super(m);
      this.name = 'ConnectionError';
    }
  },
  MSPError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'MSPError';
    }
  },
  TimeoutError: class extends Error {
    constructor(m = 'Operation timed out') {
      super(m);
      this.name = 'TimeoutError';
    }
  },
  UnsupportedVersionError: class extends Error {
    constructor(
      m: string,
      public detectedVersion?: string,
      public detectedApi?: any
    ) {
      super(m);
      this.name = 'UnsupportedVersionError';
    }
  },
}));

vi.mock('@shared/constants', () => ({
  MSP: { DEFAULT_BAUD_RATE: 115200 },
  BETAFLIGHT: {
    VENDOR_IDS: ['0x0483', '0x2E8A'],
    MIN_VERSION: '4.3.0',
    MIN_API_VERSION: { major: 1, minor: 44 },
  },
}));

describe('MSPClient.extractFlashPayload', () => {
  it('strips 7-byte header (BF 4.1+ with compression flag)', () => {
    // [4B addr=0][2B size=5][1B comp=0][5 bytes data]
    const buf = Buffer.alloc(12);
    buf.writeUInt32LE(0, 0); // address
    buf.writeUInt16LE(5, 4); // dataSize = 5
    buf[6] = 0; // isCompressed = false
    buf[7] = 0x48; // 'H'
    buf[8] = 0x20; // ' '
    buf[9] = 0x50; // 'P'
    buf[10] = 0x72; // 'r'
    buf[11] = 0x6f; // 'o'

    const result = MSPClient.extractFlashPayload(buf);
    expect(result.data.length).toBe(5);
    expect(result.data[0]).toBe(0x48); // 'H'
    expect(result.data.toString()).toBe('H Pro');
    expect(result.isCompressed).toBe(false);
  });

  it('strips 6-byte header (no compression flag)', () => {
    // [4B addr=0][2B size=4][4 bytes data]
    const buf = Buffer.alloc(10);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt16LE(4, 4);
    buf[6] = 0x48;
    buf[7] = 0x20;
    buf[8] = 0x50;
    buf[9] = 0x72;

    const result = MSPClient.extractFlashPayload(buf);
    expect(result.data.length).toBe(4);
    expect(result.data[0]).toBe(0x48);
    expect(result.isCompressed).toBe(false);
  });

  it('detects compressed response and sets isCompressed flag', () => {
    // [4B addr][2B size=3][1B comp=1][3 bytes compressed data]
    const buf = Buffer.alloc(10);
    buf.writeUInt32LE(100, 0);
    buf.writeUInt16LE(3, 4);
    buf[6] = 1; // isCompressed = true
    buf[7] = 0xaa;
    buf[8] = 0xbb;
    buf[9] = 0xcc;

    const result = MSPClient.extractFlashPayload(buf);
    expect(result.data.length).toBe(3);
    expect(result.data[0]).toBe(0xaa);
    expect(result.isCompressed).toBe(true);
  });

  it('returns raw data for buffers shorter than 6 bytes', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    const result = MSPClient.extractFlashPayload(buf);
    expect(result.data).toBe(buf);
    expect(result.isCompressed).toBe(false);
  });

  it('correctly strips header for typical 180-byte chunk', () => {
    // Simulates a real download chunk: 7-byte header + 180 bytes flash data
    const flashData = Buffer.alloc(180);
    for (let i = 0; i < 180; i++) flashData[i] = i & 0xff;

    const response = Buffer.alloc(187);
    response.writeUInt32LE(0, 0);
    response.writeUInt16LE(180, 4);
    response[6] = 0; // no compression
    flashData.copy(response, 7);

    const result = MSPClient.extractFlashPayload(response);
    expect(result.data.length).toBe(180);
    expect(Buffer.compare(result.data, flashData)).toBe(0);
    expect(result.isCompressed).toBe(false);
  });
});

describe('MSPClient.getFilterConfiguration', () => {
  let client: MSPClient;
  let mockSendCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new MSPClient();
    mockSendCommand = vi.fn();
    // Access the private connection and stub sendCommand
    (client as any).connection = {
      sendCommand: mockSendCommand,
      isOpen: vi.fn().mockReturnValue(true),
      on: vi.fn(),
    };
  });

  it('parses valid MSP_FILTER_CONFIG response into correct CurrentFilterSettings', async () => {
    // Build a 49-byte response buffer matching Betaflight 4.3+ layout
    // See mspLayouts.ts FILTER_CONFIG for full field map
    const buf = Buffer.alloc(49, 0);
    writeField(buf, FILTER_CONFIG.DTERM_LPF1_TYPE, 1); // dterm_lpf1_type (BIQUAD)
    writeField(buf, FILTER_CONFIG.GYRO_LPF1_HZ, 250); // gyro_lpf1_static_hz
    writeField(buf, FILTER_CONFIG.DTERM_LPF1_HZ, 150); // dterm_lpf1_static_hz
    writeField(buf, FILTER_CONFIG.GYRO_LPF2_HZ, 500); // gyro_lpf2_static_hz
    writeField(buf, FILTER_CONFIG.GYRO_LPF1_TYPE, 0); // gyro_lpf1_type (PT1)
    writeField(buf, FILTER_CONFIG.GYRO_LPF2_TYPE, 1); // gyro_lpf2_type (BIQUAD)
    writeField(buf, FILTER_CONFIG.DTERM_LPF2_HZ, 150); // dterm_lpf2_static_hz
    writeField(buf, FILTER_CONFIG.DTERM_LPF2_TYPE, 1); // dterm_lpf2_type (BIQUAD)
    writeField(buf, FILTER_CONFIG.GYRO_DYN_LPF_MIN, 200); // gyro_lpf1_dyn_min_hz
    writeField(buf, FILTER_CONFIG.GYRO_DYN_LPF_MAX, 500); // gyro_lpf1_dyn_max_hz
    writeField(buf, FILTER_CONFIG.DTERM_DYN_LPF_MIN, 100); // dterm_lpf1_dyn_min_hz
    writeField(buf, FILTER_CONFIG.DTERM_DYN_LPF_MAX, 250); // dterm_lpf1_dyn_max_hz
    writeField(buf, FILTER_CONFIG.DYN_NOTCH_Q, 300); // dyn_notch_q
    writeField(buf, FILTER_CONFIG.DYN_NOTCH_MIN_HZ, 100); // dyn_notch_min_hz
    writeField(buf, FILTER_CONFIG.RPM_HARMONICS, 3); // rpm_filter_harmonics
    writeField(buf, FILTER_CONFIG.RPM_MIN_HZ, 100); // rpm_filter_min_hz
    writeField(buf, FILTER_CONFIG.DYN_NOTCH_MAX_HZ, 600); // dyn_notch_max_hz
    writeField(buf, FILTER_CONFIG.DYN_LPF_CURVE_EXPO, 5); // dterm_lpf1_dyn_expo
    writeField(buf, FILTER_CONFIG.DYN_NOTCH_COUNT, 3); // dyn_notch_count

    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_FILTER_CONFIG, data: buf });

    const result = await client.getFilterConfiguration();

    expect(mockSendCommand).toHaveBeenCalledWith(MSPCommand.MSP_FILTER_CONFIG);
    expect(result).toEqual({
      gyro_lpf1_static_hz: 250,
      dterm_lpf1_static_hz: 150,
      gyro_lpf2_static_hz: 500,
      dterm_lpf2_static_hz: 150,
      dyn_notch_min_hz: 100,
      dyn_notch_max_hz: 600,
      dyn_notch_q: 300,
      rpm_filter_harmonics: 3,
      rpm_filter_min_hz: 100,
      dterm_lpf1_type: 1,
      gyro_lpf1_type: 0,
      gyro_lpf2_type: 1,
      dterm_lpf2_type: 1,
      gyro_lpf1_dyn_min_hz: 200,
      gyro_lpf1_dyn_max_hz: 500,
      dterm_lpf1_dyn_min_hz: 100,
      dterm_lpf1_dyn_max_hz: 250,
      dterm_lpf1_dyn_expo: 5,
      dyn_notch_count: 3,
    });
  });

  it('throws on response shorter than 47 bytes', async () => {
    const buf = Buffer.alloc(20, 0);
    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_FILTER_CONFIG, data: buf });

    await expect(client.getFilterConfiguration()).rejects.toThrow(
      'Invalid MSP_FILTER_CONFIG response - expected at least 47 bytes, got 20'
    );
  });

  it('handles zero values correctly (disabled filters)', async () => {
    const buf = Buffer.alloc(47, 0); // all zeros = all filters disabled
    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_FILTER_CONFIG, data: buf });

    const result = await client.getFilterConfiguration();

    expect(result).toEqual({
      gyro_lpf1_static_hz: 0,
      dterm_lpf1_static_hz: 0,
      gyro_lpf2_static_hz: 0,
      dterm_lpf2_static_hz: 0,
      dyn_notch_min_hz: 0,
      dyn_notch_max_hz: 0,
      dyn_notch_q: 0,
      rpm_filter_harmonics: 0,
      rpm_filter_min_hz: 0,
      dterm_lpf1_type: 0,
      gyro_lpf1_type: 0,
      gyro_lpf2_type: 0,
      dterm_lpf2_type: 0,
      gyro_lpf1_dyn_min_hz: 0,
      gyro_lpf1_dyn_max_hz: 0,
      dterm_lpf1_dyn_min_hz: 0,
      dterm_lpf1_dyn_max_hz: 0,
    });
  });

  it('reads dyn_lpf_curve_expo from byte 47 and dyn_notch_count from byte 48', async () => {
    const buf = Buffer.alloc(49, 0);
    writeField(buf, FILTER_CONFIG.GYRO_LPF1_HZ, 250); // gyro_lpf1_static_hz
    writeField(buf, FILTER_CONFIG.DTERM_LPF1_HZ, 150); // dterm_lpf1_static_hz
    writeField(buf, FILTER_CONFIG.GYRO_LPF2_HZ, 500); // gyro_lpf2_static_hz
    writeField(buf, FILTER_CONFIG.DTERM_LPF2_HZ, 150); // dterm_lpf2_static_hz
    writeField(buf, FILTER_CONFIG.DYN_NOTCH_Q, 300); // dyn_notch_q
    writeField(buf, FILTER_CONFIG.DYN_NOTCH_MIN_HZ, 100); // dyn_notch_min_hz
    writeField(buf, FILTER_CONFIG.RPM_HARMONICS, 3); // rpm_filter_harmonics
    writeField(buf, FILTER_CONFIG.RPM_MIN_HZ, 100); // rpm_filter_min_hz
    writeField(buf, FILTER_CONFIG.DYN_NOTCH_MAX_HZ, 600); // dyn_notch_max_hz
    writeField(buf, FILTER_CONFIG.DYN_LPF_CURVE_EXPO, 7); // dterm_lpf1_dyn_expo (NOT dyn_notch_count!)
    writeField(buf, FILTER_CONFIG.DYN_NOTCH_COUNT, 3); // dyn_notch_count (correct offset)

    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_FILTER_CONFIG, data: buf });

    const result = await client.getFilterConfiguration();

    expect(result.dterm_lpf1_dyn_expo).toBe(7);
    expect(result.dyn_notch_count).toBe(3);
    expect(result.rpm_filter_harmonics).toBe(3);
  });

  it('does not include dyn_notch_count for minimal 47-byte response', async () => {
    const buf = Buffer.alloc(47, 0);
    writeField(buf, FILTER_CONFIG.RPM_HARMONICS, 3); // rpm_filter_harmonics

    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_FILTER_CONFIG, data: buf });

    const result = await client.getFilterConfiguration();

    expect(result.rpm_filter_harmonics).toBe(3);
    expect(result.dyn_notch_count).toBeUndefined();
  });
});

describe('MSPClient.getFeedforwardConfiguration', () => {
  let client: MSPClient;
  let mockSendCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new MSPClient();
    mockSendCommand = vi.fn();
    (client as any).connection = {
      sendCommand: mockSendCommand,
      isOpen: vi.fn().mockReturnValue(true),
      on: vi.fn(),
    };
  });

  it('parses valid MSP_PID_ADVANCED response into FeedforwardConfiguration', async () => {
    // Build a 55-byte response buffer matching BF 4.3+ layout
    // See mspLayouts.ts PID_ADVANCED for full field map
    const buf = Buffer.alloc(55, 0);
    writeField(buf, PID_ADVANCED.FF_TRANSITION, 50); // feedforwardTransition
    writeField(buf, PID_ADVANCED.FF_ROLL, 120); // feedforwardRoll
    writeField(buf, PID_ADVANCED.FF_PITCH, 120); // feedforwardPitch
    writeField(buf, PID_ADVANCED.FF_YAW, 80); // feedforwardYaw
    writeField(buf, PID_ADVANCED.FF_SMOOTH_FACTOR, 37); // feedforwardSmoothFactor
    writeField(buf, PID_ADVANCED.FF_BOOST, 15); // feedforwardBoost
    writeField(buf, PID_ADVANCED.FF_MAX_RATE_LIMIT, 100); // feedforwardMaxRateLimit
    writeField(buf, PID_ADVANCED.FF_JITTER_FACTOR, 7); // feedforwardJitterFactor

    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_PID_ADVANCED, data: buf });

    const result = await client.getFeedforwardConfiguration();

    expect(mockSendCommand).toHaveBeenCalledWith(MSPCommand.MSP_PID_ADVANCED);
    expect(result).toEqual({
      transition: 50,
      rollGain: 120,
      pitchGain: 120,
      yawGain: 80,
      boost: 15,
      smoothFactor: 37,
      jitterFactor: 7,
      maxRateLimit: 100,
      dMinRoll: 0,
      dMinPitch: 0,
      dMinYaw: 0,
      dMinGain: 0,
      dMinAdvance: 0,
      itermRelax: 0,
      itermRelaxType: 0,
      itermRelaxCutoff: 0,
      averaging: 0,
      dynIdleMinRpm: 0,
    });
  });

  it('parses extended API 1.45+ fields from a 61-byte response', async () => {
    const buf = Buffer.alloc(61, 0);
    writeField(buf, PID_ADVANCED.FF_BOOST, 15);
    writeField(buf, PID_ADVANCED.FF_AVERAGING, 2);
    writeField(buf, PID_ADVANCED.IDLE_MIN_RPM, 30);
    writeField(buf, PID_ADVANCED.VBAT_SAG_COMPENSATION, 75);
    writeField(buf, PID_ADVANCED.THRUST_LINEARIZATION, 25);
    writeField(buf, PID_ADVANCED.ANTI_GRAVITY_GAIN, 110);
    writeField(buf, PID_ADVANCED.TPA_MODE, 1);
    writeField(buf, PID_ADVANCED.TPA_RATE, 65);
    writeField(buf, PID_ADVANCED.TPA_BREAKPOINT, 1350);

    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_PID_ADVANCED, data: buf });

    const result = await client.getFeedforwardConfiguration();

    expect(result.averaging).toBe(2);
    expect(result.dynIdleMinRpm).toBe(30);
    expect(result.vbatSagCompensation).toBe(75);
    expect(result.thrustLinear).toBe(25);
    expect(result.antiGravityGain).toBe(110);
    expect(result.tpaMode).toBe(1);
    expect(result.tpaRate).toBe(65);
    expect(result.tpaBreakpoint).toBe(1350);
  });

  it('omits extended fields on a 55-byte (API < 1.45) response', async () => {
    const buf = Buffer.alloc(55, 0);
    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_PID_ADVANCED, data: buf });

    const result = await client.getFeedforwardConfiguration();

    expect(result.vbatSagCompensation).toBeUndefined();
    expect(result.thrustLinear).toBeUndefined();
    expect(result.antiGravityGain).toBeUndefined();
    expect(result.tpaRate).toBeUndefined();
  });

  it('throws on response shorter than minimum length', async () => {
    const buf = Buffer.alloc(30, 0);
    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_PID_ADVANCED, data: buf });

    await expect(client.getFeedforwardConfiguration()).rejects.toThrow(
      `Invalid MSP_PID_ADVANCED response - expected at least ${PID_ADVANCED.MIN_RESPONSE_LENGTH} bytes, got 30`
    );
  });

  it('handles zero values (FF disabled)', async () => {
    const buf = Buffer.alloc(55, 0);
    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_PID_ADVANCED, data: buf });

    const result = await client.getFeedforwardConfiguration();

    expect(result.boost).toBe(0);
    expect(result.rollGain).toBe(0);
    expect(result.transition).toBe(0);
    expect(result.dMinRoll).toBe(0);
    expect(result.dMinGain).toBe(0);
    expect(result.itermRelax).toBe(0);
    expect(result.itermRelaxCutoff).toBe(0);
  });

  it('reads d_min and iterm_relax fields from MSP_PID_ADVANCED', async () => {
    const buf = buildPIDAdvancedData({
      ffTransition: 0,
      ffRoll: 120,
      ffPitch: 120,
      ffYaw: 80,
      ffBoost: 15,
      ffSmoothFactor: 37,
      ffJitterFactor: 7,
      ffMaxRateLimit: 100,
      dMinRoll: 30,
      dMinPitch: 34,
      dMinYaw: 0,
      dMinGain: 20,
      dMinAdvance: 20,
      itermRelax: 1,
      itermRelaxType: 1,
      itermRelaxCutoff: 15,
    });

    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_PID_ADVANCED, data: buf });

    const result = await client.getFeedforwardConfiguration();

    expect(result.dMinRoll).toBe(30);
    expect(result.dMinPitch).toBe(34);
    expect(result.dMinYaw).toBe(0);
    expect(result.dMinGain).toBe(20);
    expect(result.dMinAdvance).toBe(20);
    expect(result.itermRelax).toBe(1);
    expect(result.itermRelaxType).toBe(1);
    expect(result.itermRelaxCutoff).toBe(15);
  });
});

describe('getPidProcessDenom', () => {
  let client: any;
  let mockSendCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSendCommand = vi.fn();
    client = Object.create(MSPClient.prototype);
    client.connection = {
      sendCommand: mockSendCommand,
      isOpen: vi.fn().mockReturnValue(true),
      on: vi.fn(),
    };
  });

  it('reads pid_process_denom from MSP_ADVANCED_CONFIG', async () => {
    const buf = Buffer.alloc(8, 0);
    writeField(buf, ADVANCED_CONFIG.GYRO_SYNC_DENOM, 1); // gyro_sync_denom
    writeField(buf, ADVANCED_CONFIG.PID_PROCESS_DENOM, 2); // pid_process_denom
    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_ADVANCED_CONFIG, data: buf });

    const result = await client.getPidProcessDenom();

    expect(mockSendCommand).toHaveBeenCalledWith(MSPCommand.MSP_ADVANCED_CONFIG);
    expect(result).toBe(2);
  });

  it('returns 1 for default pid_process_denom', async () => {
    const buf = Buffer.alloc(8, 0);
    writeField(buf, ADVANCED_CONFIG.GYRO_SYNC_DENOM, 1); // gyro_sync_denom
    writeField(buf, ADVANCED_CONFIG.PID_PROCESS_DENOM, 1); // pid_process_denom = 1 (8kHz PID)
    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_ADVANCED_CONFIG, data: buf });

    const result = await client.getPidProcessDenom();
    expect(result).toBe(1);
  });

  it('throws on response shorter than 2 bytes', async () => {
    const buf = Buffer.alloc(1, 0);
    mockSendCommand.mockResolvedValue({ command: MSPCommand.MSP_ADVANCED_CONFIG, data: buf });

    await expect(client.getPidProcessDenom()).rejects.toThrow(
      'Invalid MSP_ADVANCED_CONFIG response - expected at least 2 bytes, got 1'
    );
  });
});

// ─── Helper: create MSPClient with stubbed connection ────────────────

function createClientWithStub() {
  const client = new MSPClient();
  const sendCommand = vi.fn();
  const mockConn = {
    sendCommand,
    sendCommandNoResponse: vi.fn().mockResolvedValue(undefined),
    isOpen: vi.fn().mockReturnValue(true),
    on: vi.fn(),
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    enterCLI: vi.fn().mockResolvedValue(undefined),
    exitCLI: vi.fn().mockResolvedValue(undefined),
    forceExitCLI: vi.fn().mockResolvedValue(undefined),
    isInCLI: vi.fn().mockReturnValue(false),
    sendCLICommand: vi.fn().mockResolvedValue(''),
    writeCLIRaw: vi.fn().mockResolvedValue(undefined),
    clearFCRebootedFromCLI: vi.fn(),
    resetProtocol: vi.fn(),
  };
  (client as any).connection = mockConn;
  return { client, sendCommand, mockConn };
}

// ─── getApiVersion ───────────────────────────────────────────────────

describe('MSPClient.getApiVersion', () => {
  it('parses 3-byte API version response', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_API_VERSION,
      data: buildAPIVersionData(1, 46),
    });

    const result = await client.getApiVersion();
    expect(result).toEqual({ protocol: 0, major: 1, minor: 46 });
  });

  it('throws on response shorter than 3 bytes', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_API_VERSION,
      data: Buffer.from([0, 1]),
    });

    await expect(client.getApiVersion()).rejects.toThrow('Invalid API_VERSION response');
  });
});

// ─── getFCVariant ────────────────────────────────────────────────────

describe('MSPClient.getFCVariant', () => {
  it('parses 4-byte BTFL variant string', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_FC_VARIANT,
      data: buildFCVariantData('BTFL'),
    });

    expect(await client.getFCVariant()).toBe('BTFL');
  });

  it('handles non-BTFL variant', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_FC_VARIANT,
      data: buildFCVariantData('INAV'),
    });

    expect(await client.getFCVariant()).toBe('INAV');
  });
});

// ─── getFCVersion ────────────────────────────────────────────────────

describe('MSPClient.getFCVersion', () => {
  it('parses version as "major.minor.patch" string', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_FC_VERSION,
      data: buildFCVersionData(4, 5, 1),
    });

    expect(await client.getFCVersion()).toBe('4.5.1');
  });

  it('throws on response shorter than 3 bytes', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_FC_VERSION,
      data: Buffer.from([4, 5]),
    });

    await expect(client.getFCVersion()).rejects.toThrow('Invalid FC_VERSION response');
  });
});

// ─── getBoardInfo ────────────────────────────────────────────────────

describe('MSPClient.getBoardInfo', () => {
  it('parses full board info with all fields', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_BOARD_INFO,
      data: buildBoardInfoData({
        boardId: 'S7X2',
        targetName: 'STM32F7X2',
        boardName: 'SPEEDYBEEF7V3',
        manufacturerId: 'SPBE',
      }),
    });

    const result = await client.getBoardInfo();
    expect(result.boardIdentifier).toBe('S7X2');
    expect(result.targetName).toBe('STM32F7X2');
    expect(result.boardName).toBe('SPEEDYBEEF7V3');
    expect(result.manufacturerId).toBe('SPBE');
  });

  it('falls back to targetName when boardName is empty', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_BOARD_INFO,
      data: buildBoardInfoData({
        boardId: 'S405',
        targetName: 'STM32F405',
        boardName: '',
      }),
    });

    const result = await client.getBoardInfo();
    expect(result.boardName).toBe('STM32F405');
  });

  it('sanitizes control characters from targetName', async () => {
    const { client, sendCommand } = createClientWithStub();
    // Build a response with control chars in targetName manually
    const arr: number[] = [];
    // boardId (4 bytes)
    for (const c of 'S7X2') arr.push(c.charCodeAt(0));
    // hwRevision (2 bytes LE)
    arr.push(0, 0);
    // boardType (1 byte)
    arr.push(0);
    // targetName with control chars: "STM32\t\x11\x04\x00F7X2"
    const rawTarget = 'STM32\t\x11\x04\x00F7X2';
    arr.push(rawTarget.length);
    for (let i = 0; i < rawTarget.length; i++) arr.push(rawTarget.charCodeAt(i));
    // boardName length 0
    arr.push(0);
    // manufacturerId length 0
    arr.push(0);
    // signature length 0
    arr.push(0);
    // mcuTypeId + configurationState
    arr.push(0, 0);

    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_BOARD_INFO,
      data: Buffer.from(arr),
    });

    const result = await client.getBoardInfo();
    expect(result.targetName).toBe('STM32F7X2');
    // boardName should fallback to cleaned targetName
    expect(result.boardName).toBe('STM32F7X2');
  });

  it('throws on response shorter than 9 bytes', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_BOARD_INFO,
      data: Buffer.alloc(5),
    });

    await expect(client.getBoardInfo()).rejects.toThrow('Invalid BOARD_INFO response');
  });
});

// ─── getUID ──────────────────────────────────────────────────────────

describe('MSPClient.getUID', () => {
  it('parses 12-byte UID to uppercase hex string', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_UID,
      data: buildUIDData([0x00360024, 0x32385106, 0x31383730]),
    });

    const uid = await client.getUID();
    // UID bytes in LE: 0x00360024 → [24,00,36,00], 0x32385106 → [06,51,38,32], 0x31383730 → [30,37,38,31]
    expect(uid).toBe('240036000651383230373831');
  });

  it('throws on response shorter than 12 bytes', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_UID,
      data: Buffer.alloc(8),
    });

    await expect(client.getUID()).rejects.toThrow('Invalid UID response');
  });
});

// ─── getFCInfo ───────────────────────────────────────────────────────

describe('MSPClient.getFCInfo', () => {
  it('combines API version, variant, version, and board info', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockImplementation(async (cmd: number) => {
      switch (cmd) {
        case MSPCommand.MSP_API_VERSION:
          return { command: cmd, data: buildAPIVersionData(1, 46) };
        case MSPCommand.MSP_FC_VARIANT:
          return { command: cmd, data: buildFCVariantData('BTFL') };
        case MSPCommand.MSP_FC_VERSION:
          return { command: cmd, data: buildFCVersionData(4, 5, 1) };
        case MSPCommand.MSP_BOARD_INFO:
          return {
            command: cmd,
            data: buildBoardInfoData({ targetName: 'STM32F7X2', boardName: 'SPEEDYBEEF7V3' }),
          };
        case MSPCommand.MSP_NAME:
          return { command: cmd, data: Buffer.from('My Racer\0') };
        default:
          throw new Error(`Unexpected command: ${cmd}`);
      }
    });

    const info = await client.getFCInfo();
    expect(info.variant).toBe('BTFL');
    expect(info.version).toBe('4.5.1');
    expect(info.target).toBe('STM32F7X2');
    expect(info.boardName).toBe('SPEEDYBEEF7V3');
    expect(info.craftName).toBe('My Racer');
    expect(info.apiVersion).toEqual({ protocol: 0, major: 1, minor: 46 });
  });

  it('omits craftName when MSP_NAME returns empty string', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockImplementation(async (cmd: number) => {
      switch (cmd) {
        case MSPCommand.MSP_API_VERSION:
          return { command: cmd, data: buildAPIVersionData(1, 46) };
        case MSPCommand.MSP_FC_VARIANT:
          return { command: cmd, data: buildFCVariantData('BTFL') };
        case MSPCommand.MSP_FC_VERSION:
          return { command: cmd, data: buildFCVersionData(4, 5, 1) };
        case MSPCommand.MSP_BOARD_INFO:
          return {
            command: cmd,
            data: buildBoardInfoData({ targetName: 'STM32F7X2', boardName: 'SPEEDYBEEF7V3' }),
          };
        case MSPCommand.MSP_NAME:
          return { command: cmd, data: Buffer.from('\0') };
        default:
          throw new Error(`Unexpected command: ${cmd}`);
      }
    });

    const info = await client.getFCInfo();
    expect(info.craftName).toBeUndefined();
  });
});

// ─── getPIDConfiguration ─────────────────────────────────────────────

describe('MSPClient.getPIDConfiguration', () => {
  it('parses roll/pitch/yaw P/I/D from first 9 bytes', async () => {
    const { client, sendCommand } = createClientWithStub();
    const pidConfig = {
      roll: { P: 45, I: 67, D: 23 },
      pitch: { P: 50, I: 72, D: 25 },
      yaw: { P: 35, I: 90, D: 0 },
    };
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_PID,
      data: buildPIDData(pidConfig),
    });

    const result = await client.getPIDConfiguration();
    expect(result).toEqual(pidConfig);
  });

  it('throws on response shorter than 9 bytes', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_PID,
      data: Buffer.alloc(6),
    });

    await expect(client.getPIDConfiguration()).rejects.toThrow('Invalid MSP_PID response');
  });
});

// ─── setPIDConfiguration ─────────────────────────────────────────────

describe('MSPClient.setPIDConfiguration', () => {
  it('sends correct 30-byte buffer with P/I/D values', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_SET_PID,
      data: Buffer.alloc(0),
      error: false,
    });

    await client.setPIDConfiguration({
      roll: { P: 45, I: 67, D: 23 },
      pitch: { P: 50, I: 72, D: 25 },
      yaw: { P: 35, I: 90, D: 0 },
    });

    expect(sendCommand).toHaveBeenCalledWith(MSPCommand.MSP_SET_PID, expect.any(Buffer));
    const sentBuf: Buffer = sendCommand.mock.calls[0][1];
    expect(sentBuf.length).toBe(30);
    expect(sentBuf[0]).toBe(45); // roll P
    expect(sentBuf[1]).toBe(67); // roll I
    expect(sentBuf[2]).toBe(23); // roll D
    expect(sentBuf[3]).toBe(50); // pitch P
    expect(sentBuf[6]).toBe(35); // yaw P
    expect(sentBuf[7]).toBe(90); // yaw I
    expect(sentBuf[8]).toBe(0); // yaw D
  });

  it('throws on error response from FC', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_SET_PID,
      data: Buffer.alloc(0),
      error: true,
    });

    await expect(
      client.setPIDConfiguration({
        roll: { P: 45, I: 67, D: 23 },
        pitch: { P: 50, I: 72, D: 25 },
        yaw: { P: 35, I: 90, D: 0 },
      })
    ).rejects.toThrow('Failed to set PID configuration');
  });
});

// ─── getBlackboxInfo ─────────────────────────────────────────────────

/** Build MSP_SDCARD_SUMMARY response (11 bytes) */
function buildSDCardSummaryData(
  opts: {
    supported?: boolean;
    state?: number;
    lastError?: number;
    freeSizeKB?: number;
    totalSizeKB?: number;
  } = {}
): Buffer {
  const buf = Buffer.alloc(11, 0);
  writeField(buf, SDCARD_SUMMARY.FLAGS, opts.supported !== false ? 0x01 : 0x00);
  writeField(buf, SDCARD_SUMMARY.STATE, opts.state ?? 4); // 4 = READY
  writeField(buf, SDCARD_SUMMARY.LAST_ERROR, opts.lastError ?? 0);
  writeField(buf, SDCARD_SUMMARY.FREE_SIZE_KB, opts.freeSizeKB ?? 0);
  writeField(buf, SDCARD_SUMMARY.TOTAL_SIZE_KB, opts.totalSizeKB ?? 0);
  return buf;
}

/** Mock sendCommand to return different responses per MSP command */
function mockByCommand(sendCommand: ReturnType<typeof vi.fn>, responses: Record<number, any>) {
  sendCommand.mockImplementation((cmd: number) => {
    const response = responses[cmd];
    if (response instanceof Error) return Promise.reject(response);
    if (response) return Promise.resolve(response);
    // Default: return error response for unknown commands
    return Promise.resolve({ command: cmd, data: Buffer.alloc(0), error: true });
  });
}

describe('MSPClient.getBlackboxInfo', () => {
  it('parses valid dataflash summary (supported, with data)', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_DATAFLASH_SUMMARY,
      data: buildDataflashSummaryData({
        ready: 0x03,
        totalSize: 2 * 1024 * 1024,
        usedSize: 512 * 1024,
      }),
    });

    const info = await client.getBlackboxInfo();
    expect(info.supported).toBe(true);
    expect(info.storageType).toBe('flash');
    expect(info.totalSize).toBe(2 * 1024 * 1024);
    expect(info.usedSize).toBe(512 * 1024);
    expect(info.hasLogs).toBe(true);
    expect(info.freeSize).toBe(2 * 1024 * 1024 - 512 * 1024);
    expect(info.usagePercent).toBe(25);
  });

  it('falls back to SD card when flash not supported', async () => {
    const { client, sendCommand } = createClientWithStub();
    mockByCommand(sendCommand, {
      [MSPCommand.MSP_DATAFLASH_SUMMARY]: {
        command: MSPCommand.MSP_DATAFLASH_SUMMARY,
        data: buildDataflashSummaryData({ ready: 0x01 }), // not supported
      },
      [MSPCommand.MSP_SDCARD_SUMMARY]: {
        command: MSPCommand.MSP_SDCARD_SUMMARY,
        data: buildSDCardSummaryData({
          supported: true,
          state: 4, // READY
          freeSizeKB: 2 * 1024 * 1024, // 2 GB free
          totalSizeKB: 32 * 1024 * 1024, // 32 GB total
        }),
      },
    });

    const info = await client.getBlackboxInfo();
    expect(info.supported).toBe(true);
    expect(info.storageType).toBe('sdcard');
    expect(info.totalSize).toBe(32 * 1024 * 1024 * 1024);
    expect(info.freeSize).toBe(2 * 1024 * 1024 * 1024);
    expect(info.hasLogs).toBe(true);
    expect(info.usagePercent).toBe(94);
  });

  it('returns SD card not ready when state is not READY', async () => {
    const { client, sendCommand } = createClientWithStub();
    mockByCommand(sendCommand, {
      [MSPCommand.MSP_DATAFLASH_SUMMARY]: {
        command: MSPCommand.MSP_DATAFLASH_SUMMARY,
        data: buildDataflashSummaryData({ ready: 0x01 }), // not supported
      },
      [MSPCommand.MSP_SDCARD_SUMMARY]: {
        command: MSPCommand.MSP_SDCARD_SUMMARY,
        data: buildSDCardSummaryData({
          supported: true,
          state: 0, // NOT_PRESENT
        }),
      },
    });

    const info = await client.getBlackboxInfo();
    expect(info.supported).toBe(true);
    expect(info.storageType).toBe('sdcard');
    expect(info.totalSize).toBe(0);
    expect(info.hasLogs).toBe(false);
  });

  it('returns unsupported when both flash and SD card not available', async () => {
    const { client, sendCommand } = createClientWithStub();
    mockByCommand(sendCommand, {
      [MSPCommand.MSP_DATAFLASH_SUMMARY]: {
        command: MSPCommand.MSP_DATAFLASH_SUMMARY,
        data: buildDataflashSummaryData({ ready: 0x01 }),
      },
      [MSPCommand.MSP_SDCARD_SUMMARY]: {
        command: MSPCommand.MSP_SDCARD_SUMMARY,
        data: buildSDCardSummaryData({ supported: false }),
      },
    });

    const info = await client.getBlackboxInfo();
    expect(info.supported).toBe(false);
    expect(info.storageType).toBe('none');
  });

  it('returns unsupported for dataflash error response (no SD card)', async () => {
    const { client, sendCommand } = createClientWithStub();
    mockByCommand(sendCommand, {
      [MSPCommand.MSP_DATAFLASH_SUMMARY]: {
        command: MSPCommand.MSP_DATAFLASH_SUMMARY,
        data: Buffer.alloc(0),
        error: true,
      },
    });

    const info = await client.getBlackboxInfo();
    expect(info.supported).toBe(false);
  });

  it('handles invalid size 0x80000000 — falls through to SD card', async () => {
    const { client, sendCommand } = createClientWithStub();
    const buf = Buffer.alloc(13, 0);
    writeField(buf, DATAFLASH_SUMMARY.FLAGS, 0x03);
    writeField(buf, DATAFLASH_SUMMARY.TOTAL_SIZE, 0x80000000);
    writeField(buf, DATAFLASH_SUMMARY.USED_SIZE, 0x80000000);
    mockByCommand(sendCommand, {
      [MSPCommand.MSP_DATAFLASH_SUMMARY]: {
        command: MSPCommand.MSP_DATAFLASH_SUMMARY,
        data: buf,
      },
      [MSPCommand.MSP_SDCARD_SUMMARY]: {
        command: MSPCommand.MSP_SDCARD_SUMMARY,
        data: buildSDCardSummaryData({
          supported: true,
          state: 4,
          freeSizeKB: 1024,
          totalSizeKB: 4096,
        }),
      },
    });

    const info = await client.getBlackboxInfo();
    // Flash returns supported:true but totalSize=0 → doesn't pass check
    // Falls to SD card which is supported and ready
    expect(info.supported).toBe(true);
    expect(info.storageType).toBe('sdcard');
  });

  it('handles supported but empty flash (totalSize = 0) — falls to SD card', async () => {
    const { client, sendCommand } = createClientWithStub();
    mockByCommand(sendCommand, {
      [MSPCommand.MSP_DATAFLASH_SUMMARY]: {
        command: MSPCommand.MSP_DATAFLASH_SUMMARY,
        data: buildDataflashSummaryData({ ready: 0x03, totalSize: 0 }),
      },
      [MSPCommand.MSP_SDCARD_SUMMARY]: {
        command: MSPCommand.MSP_SDCARD_SUMMARY,
        data: buildSDCardSummaryData({ supported: false }),
      },
    });

    const info = await client.getBlackboxInfo();
    // Flash returns supported:true but totalSize=0 → doesn't pass totalSize>0 check
    // Falls to SD card which is not supported → returns none
    expect(info.supported).toBe(false);
  });

  it('catches sendCommand exceptions and returns unsupported', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockRejectedValue(new Error('Timeout'));

    const info = await client.getBlackboxInfo();
    expect(info.supported).toBe(false);
  });

  it('throws when not connected', async () => {
    const { client, mockConn } = createClientWithStub();
    mockConn.isOpen.mockReturnValue(false);

    await expect(client.getBlackboxInfo()).rejects.toThrow('Flight controller not connected');
  });
});

// ─── getSDCardInfo ──────────────────────────────────────────────────

describe('MSPClient.getSDCardInfo', () => {
  it('parses valid SD card summary (ready)', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_SDCARD_SUMMARY,
      data: buildSDCardSummaryData({
        supported: true,
        state: 4,
        freeSizeKB: 1024 * 1024, // 1 GB
        totalSizeKB: 4 * 1024 * 1024, // 4 GB
      }),
    });

    const info = await client.getSDCardInfo();
    expect(info).not.toBeNull();
    expect(info!.supported).toBe(true);
    expect(info!.state).toBe(4);
    expect(info!.freeSizeKB).toBe(1024 * 1024);
    expect(info!.totalSizeKB).toBe(4 * 1024 * 1024);
  });

  it('returns null for error response', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_SDCARD_SUMMARY,
      data: Buffer.alloc(0),
      error: true,
    });

    const info = await client.getSDCardInfo();
    expect(info).toBeNull();
  });

  it('returns null for short response', async () => {
    const { client, sendCommand } = createClientWithStub();
    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_SDCARD_SUMMARY,
      data: Buffer.alloc(5),
    });

    const info = await client.getSDCardInfo();
    expect(info).toBeNull();
  });
});

// ─── rebootToMSC ────────────────────────────────────────────────────

describe('MSPClient.rebootToMSC', () => {
  it('sends MSP_REBOOT fire-and-forget and sets mscModeActive', async () => {
    const { client, mockConn } = createClientWithStub();

    const result = await client.rebootToMSC();

    expect(result).toBe(true);
    expect(client.mscModeActive).toBe(true);
    expect(mockConn.sendCommandNoResponse).toHaveBeenCalledWith(
      MSPCommand.MSP_REBOOT,
      expect.any(Buffer)
    );
    // Verify reboot type payload (3 on Linux, 2 on macOS/Windows)
    const payload = mockConn.sendCommandNoResponse.mock.calls[0][1];
    const expectedType = process.platform === 'linux' ? 3 : 2;
    expect(payload.readUInt8(0)).toBe(expectedType);
  });

  it('sets mscModeActive before sending command', async () => {
    const { client, mockConn } = createClientWithStub();
    let flagDuringSend = false;
    mockConn.sendCommandNoResponse.mockImplementation(async () => {
      flagDuringSend = client.mscModeActive;
    });

    await client.rebootToMSC();

    expect(flagDuringSend).toBe(true);
  });

  it('returns true even if write fails (FC may have already rebooted)', async () => {
    const { client, mockConn } = createClientWithStub();
    mockConn.sendCommandNoResponse.mockRejectedValue(new Error('Write failed'));

    const result = await client.rebootToMSC();

    expect(result).toBe(true);
    expect(client.mscModeActive).toBe(true);
  });

  it('clearMSCMode resets the flag', async () => {
    const { client } = createClientWithStub();

    await client.rebootToMSC();
    expect(client.mscModeActive).toBe(true);

    client.clearMSCMode();
    expect(client.mscModeActive).toBe(false);
  });
});

// ─── exportCLIDiff ───────────────────────────────────────────────────

describe('MSPClient.exportCLIDiff', () => {
  it('enters CLI, sends diff, exits CLI (reboot), and returns cleaned output', async () => {
    const { client, mockConn } = createClientWithStub();
    mockConn.sendCLICommand.mockResolvedValue(
      '# diff all\nset gyro_lpf1_static_hz = 250\nset dterm_lpf1_static_hz = 150\n#'
    );

    const result = await client.exportCLIDiff();
    expect(mockConn.enterCLI).toHaveBeenCalled();
    expect(mockConn.sendCLICommand).toHaveBeenCalledWith('diff all', 10000);
    // Exits CLI after reading diff (triggers FC reboot)
    expect(mockConn.writeCLIRaw).toHaveBeenCalledWith('exit');
    expect(mockConn.resetProtocol).toHaveBeenCalled();
    expect(mockConn.clearFCRebootedFromCLI).toHaveBeenCalled();
    // cleanCLIOutput removes lines starting with # and empty lines
    expect(result).toBe('set gyro_lpf1_static_hz = 250\nset dterm_lpf1_static_hz = 150');
  });

  it('calls writeCLIRaw(exit) BEFORE resetProtocol and clearFCRebootedFromCLI', async () => {
    const { client, mockConn } = createClientWithStub();
    mockConn.sendCLICommand.mockResolvedValue('set foo = 1\n#');
    const callOrder: string[] = [];
    mockConn.writeCLIRaw.mockImplementation(async () => {
      callOrder.push('writeCLIRaw');
    });
    mockConn.resetProtocol.mockImplementation(() => {
      callOrder.push('resetProtocol');
    });
    mockConn.forceExitCLI.mockImplementation(async () => {
      callOrder.push('forceExitCLI');
    });
    mockConn.clearFCRebootedFromCLI.mockImplementation(() => {
      callOrder.push('clearFCRebootedFromCLI');
    });

    await client.exportCLIDiff();

    // Critical ordering: exit sent while cliMode=true, then cleanup after reboot settle
    expect(callOrder).toEqual([
      'writeCLIRaw',
      'resetProtocol',
      'forceExitCLI',
      'clearFCRebootedFromCLI',
    ]);
  });

  it('skips enterCLI and exit if already in CLI mode', async () => {
    const { client, mockConn } = createClientWithStub();
    mockConn.isInCLI.mockReturnValue(true);
    mockConn.sendCLICommand.mockResolvedValue('set motor_pwm_rate = 480\n#');

    await client.exportCLIDiff();
    expect(mockConn.enterCLI).not.toHaveBeenCalled();
    // Should NOT exit CLI — caller was already in CLI and will handle exit
    expect(mockConn.writeCLIRaw).not.toHaveBeenCalledWith('exit');
  });
});

// ─── saveAndReboot ───────────────────────────────────────────────────

describe('MSPClient.saveAndReboot', () => {
  it('enters CLI, writes save, clears CLI flag, emits disconnected', async () => {
    const { client, mockConn } = createClientWithStub();
    const emitSpy = vi.spyOn(client, 'emit');

    await client.saveAndReboot();

    expect(mockConn.enterCLI).toHaveBeenCalled();
    expect(mockConn.writeCLIRaw).toHaveBeenCalledWith('save');
    expect(mockConn.clearFCRebootedFromCLI).toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith(
      'connection-changed',
      expect.objectContaining({ connected: false })
    );
  });

  it('sets rebootPending before save and clears after', async () => {
    const { client, mockConn } = createClientWithStub();
    let flagDuringSave = false;
    mockConn.enterCLI.mockImplementation(async () => {
      flagDuringSave = client.rebootPending;
    });

    await client.saveAndReboot();

    expect(flagDuringSave).toBe(true);
    // saveAndReboot() now clears rebootPending after reconnect attempt completes
    expect(client.rebootPending).toBe(false);
  });

  it('skips enterCLI when already in CLI mode', async () => {
    const { client, mockConn } = createClientWithStub();
    mockConn.isInCLI.mockReturnValue(true);

    await client.saveAndReboot();

    expect(mockConn.enterCLI).not.toHaveBeenCalled();
    expect(mockConn.writeCLIRaw).toHaveBeenCalledWith('save');
    expect(mockConn.clearFCRebootedFromCLI).toHaveBeenCalled();
  });

  it('clears rebootPending on error', async () => {
    const { client, mockConn } = createClientWithStub();
    mockConn.enterCLI.mockRejectedValue(new Error('CLI entry failed'));

    await expect(client.saveAndReboot()).rejects.toThrow('CLI entry failed');
    expect(client.rebootPending).toBe(false);
  });
});

// ─── rebootPending flag ──────────────────────────────────────────────

describe('MSPClient.rebootPending', () => {
  it('clearRebootPending clears the flag', () => {
    const { client } = createClientWithStub();

    client.setRebootPending();
    expect(client.rebootPending).toBe(true);

    client.clearRebootPending();
    expect(client.rebootPending).toBe(false);
  });

  it('setRebootPending sets the flag', () => {
    const { client } = createClientWithStub();

    expect(client.rebootPending).toBe(false);
    client.setRebootPending();
    expect(client.rebootPending).toBe(true);
  });
});

// ─── disconnect ──────────────────────────────────────────────────────

describe('MSPClient.disconnect', () => {
  it('closes connection and emits connection-changed', async () => {
    const { client, mockConn } = createClientWithStub();
    const emitSpy = vi.spyOn(client, 'emit');

    await client.disconnect();

    expect(mockConn.close).toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith(
      'connection-changed',
      expect.objectContaining({ connected: false })
    );
  });

  it('handles already-closed port gracefully', async () => {
    const { client, mockConn } = createClientWithStub();
    mockConn.isOpen.mockReturnValue(false);
    const emitSpy = vi.spyOn(client, 'emit');

    await client.disconnect();

    expect(mockConn.close).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith(
      'connection-changed',
      expect.objectContaining({ connected: false })
    );
  });

  it('emits disconnected even if close() throws', async () => {
    const { client, mockConn } = createClientWithStub();
    mockConn.close.mockRejectedValue(new Error('Close failed'));
    const emitSpy = vi.spyOn(client, 'emit');

    await expect(client.disconnect()).rejects.toThrow('Close failed');
    expect(emitSpy).toHaveBeenCalledWith(
      'connection-changed',
      expect.objectContaining({ connected: false })
    );
  });
});

// ─── listPorts ───────────────────────────────────────────────────────

describe('MSPClient.listPorts', () => {
  it('filters ports by Betaflight vendor IDs', async () => {
    const { SerialPort } = await import('serialport');
    (SerialPort.list as any).mockResolvedValue([
      { path: '/dev/ttyUSB0', vendorId: '0483', manufacturer: 'STM' },
      { path: '/dev/ttyUSB1', vendorId: '1234', manufacturer: 'Other' },
    ]);

    const { client } = createClientWithStub();
    const ports = await client.listPorts();

    expect(ports.length).toBe(1);
    expect(ports[0].path).toBe('/dev/ttyUSB0');
  });

  it('falls back to all ports with vendorId when no BF match', async () => {
    const { SerialPort } = await import('serialport');
    (SerialPort.list as any).mockResolvedValue([
      { path: '/dev/ttyUSB0', vendorId: '9999', manufacturer: 'Unknown' },
      { path: '/dev/ttyUSB1' }, // no vendorId
    ]);

    const { client } = createClientWithStub();
    const ports = await client.listPorts();

    // No BF vendor match → fallback to all ports with vendorId
    expect(ports.length).toBe(1);
    expect(ports[0].path).toBe('/dev/ttyUSB0');
  });
});

// ─── validateFirmwareVersion ─────────────────────────────────────────

describe('MSPClient.validateFirmwareVersion', () => {
  it('passes for BF 4.5 (API 1.46)', () => {
    const { client } = createClientWithStub();
    const fcInfo = {
      variant: 'BTFL',
      version: '4.5.1',
      target: 'STM32F7X2',
      boardName: 'SPEEDYBEEF7V3',
      apiVersion: { protocol: 0, major: 1, minor: 46 },
    };

    // Should not throw
    expect(() => (client as any).validateFirmwareVersion(fcInfo)).not.toThrow();
  });

  it('passes for BF 4.3 (API 1.44) — minimum supported', () => {
    const { client } = createClientWithStub();
    const fcInfo = {
      variant: 'BTFL',
      version: '4.3.0',
      target: 'STM32F405',
      boardName: 'MAMBAF405',
      apiVersion: { protocol: 0, major: 1, minor: 44 },
    };

    expect(() => (client as any).validateFirmwareVersion(fcInfo)).not.toThrow();
  });

  it('throws UnsupportedVersionError for BF 4.2 (API 1.43)', () => {
    const { client } = createClientWithStub();
    const fcInfo = {
      variant: 'BTFL',
      version: '4.2.11',
      target: 'STM32F405',
      boardName: 'MAMBAF405',
      apiVersion: { protocol: 0, major: 1, minor: 43 },
    };

    expect(() => (client as any).validateFirmwareVersion(fcInfo)).toThrow(/not supported/);
  });
});

// ─── connect lifecycle ───────────────────────────────────────────────

describe('MSPClient.connect', () => {
  function mockFCResponses(sendCommand: ReturnType<typeof vi.fn>) {
    sendCommand.mockImplementation(async (cmd: number) => {
      switch (cmd) {
        case MSPCommand.MSP_API_VERSION:
          return { command: cmd, data: buildAPIVersionData(1, 46) };
        case MSPCommand.MSP_FC_VARIANT:
          return { command: cmd, data: buildFCVariantData('BTFL') };
        case MSPCommand.MSP_FC_VERSION:
          return { command: cmd, data: buildFCVersionData(4, 5, 1) };
        case MSPCommand.MSP_BOARD_INFO:
          return {
            command: cmd,
            data: buildBoardInfoData({ targetName: 'STM32F7X2', boardName: 'SPEEDYBEEF7V3' }),
          };
        default:
          return { command: cmd, data: Buffer.alloc(0) };
      }
    });
  }

  it('opens port, reads FC info, and emits connection-changed', async () => {
    const { client, sendCommand, mockConn } = createClientWithStub();
    mockConn.isOpen.mockReturnValue(false); // Not yet connected
    mockFCResponses(sendCommand);
    const emitSpy = vi.spyOn(client, 'emit');
    // Bypass delays
    (client as any).delay = vi.fn().mockResolvedValue(undefined);

    await client.connect('/dev/ttyUSB0');

    expect(mockConn.open).toHaveBeenCalledWith('/dev/ttyUSB0', 115200);
    expect(emitSpy).toHaveBeenCalledWith(
      'connection-changed',
      expect.objectContaining({
        connected: true,
        portPath: '/dev/ttyUSB0',
      })
    );
  });

  it('throws when already connected', async () => {
    const { client, mockConn } = createClientWithStub();
    // isOpen returns true → already connected
    mockConn.isOpen.mockReturnValue(true);

    await expect(client.connect('/dev/ttyUSB0')).rejects.toThrow('Already connected');
  });

  it('emits connected event only after initialization completes', async () => {
    const { client, sendCommand, mockConn } = createClientWithStub();
    mockConn.isOpen.mockReturnValue(false);
    mockFCResponses(sendCommand);
    (client as any).delay = vi.fn().mockResolvedValue(undefined);

    const eventOrder: string[] = [];
    client.on('connection-changed', () => eventOrder.push('connection-changed'));
    client.on('connected', () => eventOrder.push('connected'));

    // Verify that connection.open does NOT trigger 'connected' on the client
    mockConn.open.mockImplementation(async () => {
      // At this point, no 'connected' should have been emitted yet
      expect(eventOrder).toEqual([]);
    });

    await client.connect('/dev/ttyUSB0');

    // Both events should fire, connected AFTER connection-changed
    expect(eventOrder).toEqual(['connection-changed', 'connected']);
  });

  it('rejects old firmware and closes port', async () => {
    const { client, sendCommand, mockConn } = createClientWithStub();
    mockConn.isOpen.mockReturnValue(false);
    (client as any).delay = vi.fn().mockResolvedValue(undefined);

    // Simulate BF 4.2 (API 1.43) — below minimum
    sendCommand.mockImplementation(async (cmd: number) => {
      switch (cmd) {
        case MSPCommand.MSP_API_VERSION:
          return { command: cmd, data: buildAPIVersionData(1, 43) };
        case MSPCommand.MSP_FC_VARIANT:
          return { command: cmd, data: buildFCVariantData('BTFL') };
        case MSPCommand.MSP_FC_VERSION:
          return { command: cmd, data: buildFCVersionData(4, 2, 11) };
        case MSPCommand.MSP_BOARD_INFO:
          return { command: cmd, data: buildBoardInfoData({}) };
        default:
          return { command: cmd, data: Buffer.alloc(0) };
      }
    });

    await expect(client.connect('/dev/ttyUSB0')).rejects.toThrow(/not supported/);
    expect(mockConn.close).toHaveBeenCalled();
  });
});

// ─── downloadBlackboxLog: chunk ceiling ──────────────────────────────

describe('MSPClient.downloadBlackboxLog — chunk ceiling after failure', () => {
  it('caps maxChunkSize after failure to prevent thrashing', async () => {
    const { client, sendCommand, mockConn } = createClientWithStub();

    // Mock getBlackboxInfo to return a log with enough data for many chunks
    const totalSize = 50000;
    const bbInfoData = buildDataflashSummaryData({
      ready: 0x03,
      totalSize: totalSize * 2,
      usedSize: totalSize,
    });

    let chunkCallCount = 0;
    const chunkSizesRequested: number[] = [];

    sendCommand.mockImplementation(async (cmd: number, payload?: Buffer) => {
      if (cmd === MSPCommand.MSP_DATAFLASH_SUMMARY) {
        return { command: cmd, data: bbInfoData };
      }
      if (cmd === MSPCommand.MSP_DATAFLASH_READ) {
        chunkCallCount++;
        const requestSize = payload ? payload.readUInt16LE(4) : 180;
        chunkSizesRequested.push(requestSize);

        // Fail on the 3rd chunk (while at initial size 180)
        // to trigger size reduction to floor(180*0.8)=144, ceiling set to 144
        if (chunkCallCount === 3) {
          throw new Error('Timeout');
        }

        // Build a valid MSP_DATAFLASH_READ response (7-byte header + data)
        const dataSize = Math.min(requestSize, 180);
        const response = Buffer.alloc(7 + dataSize);
        response.writeUInt32LE(0, 0); // readAddress
        response.writeUInt16LE(dataSize, 4); // dataSize
        response.writeUInt8(0, 6); // not compressed
        return { command: cmd, data: response };
      }
      return { command: cmd, data: Buffer.alloc(0) };
    });

    await client.downloadBlackboxLog();

    // After the failure at size 180, chunk size drops to floor(180*0.8)=144
    // maxChunkSize is capped at 144, so even after 50+ successes,
    // no requested size should exceed 144
    const sizesAfterFailure = chunkSizesRequested.slice(3); // everything after the failed chunk
    const maxObserved = Math.max(...sizesAfterFailure);
    // The ceiling should be 144 (floor(180 * 0.8))
    expect(maxObserved).toBeLessThanOrEqual(144);
    // Verify we actually had enough chunks for growth attempts
    expect(sizesAfterFailure.length).toBeGreaterThan(50);
  });
});

// ─── eraseBlackboxFlash: disconnect detection ────────────────────────

describe('MSPClient.eraseBlackboxFlash — disconnect detection', () => {
  it('throws ConnectionError immediately when FC disconnects during erase polling', async () => {
    const { client, sendCommand, mockConn } = createClientWithStub();

    let pollCount = 0;

    sendCommand.mockImplementation(async (cmd: number, _payload?: Buffer, timeout?: number) => {
      if (cmd === MSPCommand.MSP_DATAFLASH_ERASE) {
        // Simulate FC ACK for erase command
        return { command: cmd, data: Buffer.alloc(0), error: false };
      }
      if (cmd === MSPCommand.MSP_DATAFLASH_SUMMARY) {
        pollCount++;
        // On the 2nd poll, simulate FC disconnect
        if (pollCount >= 2) {
          mockConn.isOpen.mockReturnValue(false);
        }
        // Return non-zero usedSize (erase still in progress)
        return {
          command: cmd,
          data: buildDataflashSummaryData({
            ready: 0x03,
            totalSize: 2 * 1024 * 1024,
            usedSize: 512 * 1024,
          }),
        };
      }
      return { command: cmd, data: Buffer.alloc(0) };
    });

    const start = Date.now();

    await expect(client.eraseBlackboxFlash()).rejects.toThrow('FC disconnected during erase');

    const elapsed = Date.now() - start;

    // Should fail quickly (a few poll intervals), NOT wait the full 60s
    // With 1s poll interval, 2 polls = ~2s plus some overhead
    expect(elapsed).toBeLessThan(10000);
    // Verify the error is a ConnectionError (name set by mock)
    try {
      await client.eraseBlackboxFlash();
    } catch (err) {
      expect((err as Error).name).toBe('ConnectionError');
    }
  });
});

describe('MSPClient.eraseBlackboxFlash — poll uses getDataflashInfo not getBlackboxInfo', () => {
  it('does not false-positive on timeout (usedSize=0 from fallback)', async () => {
    const { client, sendCommand, mockConn } = createClientWithStub();

    let eraseCommandSent = false;
    let pollCount = 0;

    sendCommand.mockImplementation(async (cmd: number) => {
      if (cmd === MSPCommand.MSP_DATAFLASH_ERASE) {
        eraseCommandSent = true;
        return { command: cmd, data: Buffer.alloc(0), error: false };
      }
      if (cmd === MSPCommand.MSP_DATAFLASH_SUMMARY) {
        pollCount++;
        // Simulate timeout on dataflash summary (FC busy erasing)
        // This should NOT be treated as erase success
        if (pollCount <= 2) {
          throw new TimeoutError(`MSP command ${cmd} timed out`);
        }
        // After 2 retries, return erased state
        return {
          command: cmd,
          data: buildDataflashSummaryData({
            ready: 0x03,
            totalSize: 2 * 1024 * 1024,
            usedSize: 0,
          }),
        };
      }
      return { command: cmd, data: Buffer.alloc(0) };
    });

    await client.eraseBlackboxFlash();

    expect(eraseCommandSent).toBe(true);
    // Should have polled at least 3 times (2 timeouts + 1 success)
    expect(pollCount).toBeGreaterThanOrEqual(3);
  });
});

describe('MSPClient.eraseBlackboxFlash — pre-erase MSP readiness check', () => {
  it('waits for FC to become responsive before sending erase', async () => {
    const { client, sendCommand } = createClientWithStub();

    let apiPingCount = 0;

    sendCommand.mockImplementation(async (cmd: number) => {
      if (cmd === MSPCommand.MSP_API_VERSION) {
        apiPingCount++;
        // First 2 pings timeout (FC rebooting after snapshot), 3rd succeeds
        if (apiPingCount <= 2) {
          throw new TimeoutError(`MSP command ${cmd} timed out`);
        }
        return { command: cmd, data: Buffer.alloc(4) };
      }
      if (cmd === MSPCommand.MSP_DATAFLASH_ERASE) {
        return { command: cmd, data: Buffer.alloc(0), error: false };
      }
      if (cmd === MSPCommand.MSP_DATAFLASH_SUMMARY) {
        return {
          command: cmd,
          data: buildDataflashSummaryData({ ready: 0x03, totalSize: 2 * 1024 * 1024, usedSize: 0 }),
        };
      }
      return { command: cmd, data: Buffer.alloc(0) };
    });

    await client.eraseBlackboxFlash();

    // Should have retried pings before proceeding to erase
    expect(apiPingCount).toBeGreaterThanOrEqual(3);
  });

  it('throws MSPError if FC never becomes responsive within timeout', async () => {
    const { client, sendCommand, mockConn } = createClientWithStub();

    mockConn.isInCLI = vi.fn().mockReturnValue(false);

    sendCommand.mockImplementation(async (cmd: number) => {
      if (cmd === MSPCommand.MSP_API_VERSION) {
        throw new TimeoutError(`MSP command ${cmd} timed out`);
      }
      return { command: cmd, data: Buffer.alloc(0) };
    });

    await expect(client.eraseBlackboxFlash()).rejects.toThrow(
      'FC not responding to MSP commands — it may still be rebooting'
    );
  }, 20000);
});

// ─── getStatusEx ─────────────────────────────────────────────────────

describe('MSPClient.getStatusEx', () => {
  it('parses PID profile index from MSP_STATUS_EX and derives count=4 for API 1.45+', async () => {
    const { client, sendCommand } = createClientWithStub();

    const data = Buffer.alloc(16);
    writeField(data, STATUS_EX.PID_PROFILE_INDEX, 1); // profile index

    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_STATUS_EX,
      data,
    });

    const result = await client.getStatusEx({ protocol: 0, major: 1, minor: 45 });
    expect(result.pidProfileIndex).toBe(1);
    expect(result.pidProfileCount).toBe(4);
  });

  it('derives pidProfileCount=3 for API 1.44 (BF 4.3)', async () => {
    const { client, sendCommand } = createClientWithStub();

    const data = Buffer.alloc(16);
    writeField(data, STATUS_EX.PID_PROFILE_INDEX, 0);

    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_STATUS_EX,
      data,
    });

    const result = await client.getStatusEx({ protocol: 0, major: 1, minor: 44 });
    expect(result.pidProfileIndex).toBe(0);
    expect(result.pidProfileCount).toBe(3);
  });

  it('defaults to pidProfileCount=3 when no apiVersion provided', async () => {
    const { client, sendCommand } = createClientWithStub();

    const data = Buffer.alloc(16);
    writeField(data, STATUS_EX.PID_PROFILE_INDEX, 2);

    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_STATUS_EX,
      data,
    });

    const result = await client.getStatusEx();
    expect(result.pidProfileIndex).toBe(2);
    expect(result.pidProfileCount).toBe(3);
  });

  it('throws on response shorter than 11 bytes', async () => {
    const { client, sendCommand } = createClientWithStub();

    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_STATUS_EX,
      data: Buffer.alloc(5),
    });

    await expect(client.getStatusEx()).rejects.toThrow('Invalid MSP_STATUS_EX response');
  });
});

// ─── selectPidProfile ────────────────────────────────────────────────

describe('MSPClient.selectPidProfile', () => {
  it('sends MSP_SELECT_SETTING with correct payload', async () => {
    const { client, sendCommand } = createClientWithStub();

    sendCommand.mockResolvedValue({
      command: MSPCommand.MSP_SELECT_SETTING,
      data: Buffer.alloc(0),
    });

    await client.selectPidProfile(2);

    expect(sendCommand).toHaveBeenCalledWith(MSPCommand.MSP_SELECT_SETTING, expect.any(Buffer));
    const payload = sendCommand.mock.calls[0][1] as Buffer;
    expect(payload[0]).toBe(2);
  });

  it('rejects invalid profile index < 0', async () => {
    const { client } = createClientWithStub();
    await expect(client.selectPidProfile(-1)).rejects.toThrow('Invalid PID profile index');
  });

  it('rejects invalid profile index > 3', async () => {
    const { client } = createClientWithStub();
    await expect(client.selectPidProfile(4)).rejects.toThrow('Invalid PID profile index');
  });
});
