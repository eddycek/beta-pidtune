import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IPCChannel } from '@shared/types/ipc.types';
import type { IPCResponse } from '@shared/types/ipc.types';
import type { PIDConfiguration } from '@shared/types/pid.types';
import { TUNING_TYPE, TUNING_PHASE } from '@shared/constants';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Map to capture registered IPC handlers
const registeredHandlers = new Map<string, (...args: any[]) => Promise<any>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: any) => {
      registeredHandlers.set(channel, handler);
    }),
  },
  BrowserWindow: vi.fn(),
  app: { getPath: () => '/tmp/test' },
  shell: { openPath: vi.fn().mockResolvedValue('') },
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let mockMainWindow: any = null;
vi.mock('../window', () => ({
  getMainWindow: () => mockMainWindow,
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

const mockParse = vi.fn();
vi.mock('../blackbox/BlackboxParser', () => ({
  BlackboxParser: { parse: (...args: any[]) => mockParse(...args) },
}));

const mockAnalyzeFilters = vi.fn();
vi.mock('../analysis/FilterAnalyzer', () => ({
  analyze: (...args: any[]) => mockAnalyzeFilters(...args),
}));

const mockAnalyzePID = vi.fn();
vi.mock('../analysis/PIDAnalyzer', () => ({
  analyzePID: (...args: any[]) => mockAnalyzePID(...args),
}));

const mockExtractFlightPIDs = vi.fn();
vi.mock('../analysis/PIDRecommender', () => ({
  extractFlightPIDs: (...args: any[]) => mockExtractFlightPIDs(...args),
}));

const mockValidateBBLHeader = vi.fn().mockReturnValue([]);
const mockEnrichSettings = vi.fn().mockReturnValue(null);
vi.mock('../analysis/headerValidation', () => ({
  validateBBLHeader: (...args: any[]) => mockValidateBBLHeader(...args),
  enrichSettingsFromBBLHeaders: (...args: any[]) => mockEnrichSettings(...args),
}));

vi.mock('@shared/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/constants')>();
  return {
    ...actual,
    PRESET_PROFILES: {
      '5inch-freestyle': {
        name: '5" Freestyle',
        description: 'Standard freestyle',
        size: '5"',
        battery: '4S',
      },
    },
  };
});

import {
  registerIPCHandlers,
  setMSPClient,
  setSnapshotManager,
  setProfileManager,
  setBlackboxManager,
  setTuningSessionManager,
  setTuningHistoryManager,
  consumePendingSettingsSnapshot,
} from './handlers';
import { shell } from 'electron';
import * as fsp from 'fs/promises';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockEvent() {
  const sentEvents: Array<{ channel: string; data: any }> = [];
  return {
    event: {
      sender: {
        send: vi.fn((channel: string, ...data: any[]) => {
          sentEvents.push({ channel, data: data.length === 1 ? data[0] : data });
        }),
      },
    },
    sentEvents,
  };
}

function createMockMSPClient(connected = true) {
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    listPorts: vi.fn().mockResolvedValue([{ path: '/dev/ttyUSB0' }]),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getConnectionStatus: vi.fn().mockReturnValue({ connected: true, port: '/dev/ttyUSB0' }),
    getFCInfo: vi.fn().mockResolvedValue({
      variant: 'BTFL',
      version: '4.5.1',
      firmwareVersion: '4.5.1',
      target: 'STM32F7X2',
      boardName: 'SPEEDY',
      apiVersion: { protocol: 0, major: 1, minor: 46 },
    }),
    getFCSerialNumber: vi.fn().mockResolvedValue('SN-001'),
    getPIDConfiguration: vi.fn().mockResolvedValue({
      roll: { P: 45, I: 80, D: 40 },
      pitch: { P: 47, I: 84, D: 43 },
      yaw: { P: 45, I: 80, D: 0 },
    }),
    setPIDConfiguration: vi.fn().mockResolvedValue(undefined),
    selectPidProfile: vi.fn().mockResolvedValue(undefined),
    saveToEEPROM: vi.fn().mockResolvedValue(undefined),
    getFilterConfiguration: vi.fn().mockResolvedValue({
      gyro_lpf1_static_hz: 250,
      gyro_lpf2_static_hz: 500,
      dterm_lpf1_static_hz: 150,
      dterm_lpf2_static_hz: 150,
      dyn_notch_min_hz: 100,
      dyn_notch_max_hz: 600,
    }),
    getFeedforwardConfiguration: vi
      .fn()
      .mockResolvedValue({ feedforwardTransition: 0, feedforwardAveraging: 0 }),
    getBlackboxInfo: vi.fn().mockResolvedValue({
      supported: true,
      totalSize: 2048000,
      usedSize: 1024000,
      hasLogs: true,
      freeSize: 1024000,
      usagePercent: 50,
    }),
    downloadBlackboxLog: vi.fn().mockResolvedValue(Buffer.from('fake-log-data')),
    eraseBlackboxFlash: vi.fn().mockResolvedValue(undefined),
    testBlackboxRead: vi.fn().mockResolvedValue({ success: true, message: 'OK' }),
    exportCLIDiff: vi.fn().mockResolvedValue('set gyro_lpf1_static_hz = 250'),
    exportCLIDump: vi.fn().mockResolvedValue('dump output'),
    getPidProcessDenom: vi.fn().mockResolvedValue(1),
    saveAndReboot: vi.fn().mockResolvedValue(undefined),
    setRebootPending: vi.fn(),
    clearRebootPending: vi.fn(),
    connection: (() => {
      const state = { inCLI: false };
      return {
        enterCLI: vi.fn().mockImplementation(async () => {
          state.inCLI = true;
        }),
        sendCLICommand: vi.fn().mockResolvedValue(''),
        isInCLI: vi.fn().mockImplementation(() => state.inCLI),
        _resetCLIState: () => {
          state.inCLI = false;
        },
      };
    })(),
  };
}

function createMockProfileManager() {
  return {
    createProfile: vi.fn().mockResolvedValue({
      id: 'prof-1',
      fcSerialNumber: 'SN-001',
      name: 'Test',
      snapshotIds: [],
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      connectionCount: 1,
    }),
    createProfileFromPreset: vi.fn().mockResolvedValue({
      id: 'prof-preset',
      fcSerialNumber: 'SN-001',
      name: '5" Freestyle',
      snapshotIds: [],
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      connectionCount: 1,
    }),
    updateProfile: vi.fn().mockResolvedValue({ id: 'prof-1', name: 'Updated' }),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
    getProfile: vi.fn().mockResolvedValue({
      id: 'prof-1',
      fcSerialNumber: 'SN-001',
      name: 'Test',
      snapshotIds: ['snap-1', 'snap-2'],
      baselineSnapshotId: 'snap-1',
    }),
    getCurrentProfile: vi.fn().mockResolvedValue({
      id: 'prof-1',
      fcSerialNumber: 'SN-001',
      fcSerial: 'SN-001',
      name: 'Test',
      snapshotIds: ['snap-1'],
      baselineSnapshotId: 'snap-1',
    }),
    getCurrentProfileId: vi.fn().mockReturnValue('prof-1'),
    clearCurrentProfile: vi.fn(),
    setCurrentProfile: vi.fn().mockResolvedValue({ id: 'prof-1', name: 'Test' }),
    listProfiles: vi.fn().mockResolvedValue([{ id: 'prof-1', name: 'Test' }]),
    exportProfile: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSnapshotManager() {
  return {
    createSnapshot: vi.fn().mockResolvedValue({
      id: 'snap-new',
      label: 'Test',
      type: 'manual',
      configuration: { cliDiff: 'set gyro_lpf1_static_hz = 250' },
      fcInfo: { variant: 'BTFL', version: '4.5.1' },
    }),
    createBaselineIfMissing: vi.fn().mockResolvedValue(undefined),
    loadSnapshot: vi.fn().mockResolvedValue({
      id: 'snap-1',
      label: 'Baseline',
      type: 'baseline',
      configuration: {
        cliDiff:
          'set debug_mode = GYRO_SCALED\nset blackbox_sample_rate = 1\nset gyro_lpf1_static_hz = 250',
      },
      fcInfo: { variant: 'BTFL', version: '4.5.1' },
    }),
    deleteSnapshot: vi.fn().mockResolvedValue(undefined),
    listSnapshots: vi.fn().mockResolvedValue([
      { id: 'snap-1', label: 'Baseline', type: 'baseline', timestamp: '2026-01-01' },
      { id: 'snap-2', label: 'Manual', type: 'manual', timestamp: '2026-01-02' },
    ]),
    exportSnapshot: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockBlackboxManager() {
  return {
    saveLog: vi.fn().mockResolvedValue({
      id: 'log-1',
      profileId: 'prof-1',
      fcSerial: 'SN-001',
      timestamp: '2026-01-01',
      filename: 'blackbox_001.bbl',
      filepath: '/tmp/logs/blackbox_001.bbl',
      size: 1024,
    }),
    getLog: vi.fn().mockResolvedValue({
      id: 'log-1',
      profileId: 'prof-1',
      filename: 'blackbox_001.bbl',
      filepath: '/tmp/logs/blackbox_001.bbl',
      size: 1024,
    }),
    listLogs: vi.fn().mockResolvedValue([]),
    deleteLog: vi.fn().mockResolvedValue(undefined),
    deleteLogsForProfile: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockTuningSessionManager() {
  return {
    getSession: vi.fn().mockResolvedValue(null),
    createSession: vi.fn().mockResolvedValue({
      profileId: 'prof-1',
      phase: TUNING_PHASE.FILTER_FLIGHT_PENDING,
      startedAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }),
    updatePhase: vi.fn().mockResolvedValue({
      profileId: 'prof-1',
      phase: TUNING_PHASE.FILTER_FLIGHT_PENDING,
      startedAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockTuningHistoryManager() {
  return {
    getHistory: vi.fn().mockResolvedValue([]),
    archiveSession: vi.fn().mockResolvedValue(undefined),
    updateLatestVerification: vi.fn().mockResolvedValue(undefined),
    updateRecordVerification: vi.fn().mockResolvedValue(undefined),
  };
}

/** Invoke a registered IPC handler by channel name */
async function invoke(channel: string, ...args: any[]): Promise<IPCResponse<any>> {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  const { event } = createMockEvent();
  return handler(event, ...args);
}

/** Invoke a handler with a custom event (for progress tracking) */
async function invokeWithEvent(
  channel: string,
  event: any,
  ...args: any[]
): Promise<IPCResponse<any>> {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(event, ...args);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('IPC Handlers', () => {
  let mockMSP: ReturnType<typeof createMockMSPClient>;
  let mockProfileMgr: ReturnType<typeof createMockProfileManager>;
  let mockSnapshotMgr: ReturnType<typeof createMockSnapshotManager>;
  let mockBBMgr: ReturnType<typeof createMockBlackboxManager>;
  let mockTuningMgr: ReturnType<typeof createMockTuningSessionManager>;
  let mockTuningHistoryMgr: ReturnType<typeof createMockTuningHistoryManager>;

  beforeEach(() => {
    registeredHandlers.clear();

    mockMSP = createMockMSPClient();
    mockProfileMgr = createMockProfileManager();
    mockSnapshotMgr = createMockSnapshotManager();
    mockBBMgr = createMockBlackboxManager();
    mockTuningMgr = createMockTuningSessionManager();
    mockTuningHistoryMgr = createMockTuningHistoryManager();

    setMSPClient(mockMSP);
    setProfileManager(mockProfileMgr);
    setSnapshotManager(mockSnapshotMgr);
    setBlackboxManager(mockBBMgr);
    setTuningSessionManager(mockTuningMgr);
    setTuningHistoryManager(mockTuningHistoryMgr);

    mockMainWindow = {
      webContents: { send: vi.fn() },
    };

    registerIPCHandlers();
  });

  afterEach(() => {
    setMSPClient(null);
    setProfileManager(null);
    setSnapshotManager(null);
    setBlackboxManager(null);
    setTuningSessionManager(null);
    mockMainWindow = null;
    vi.restoreAllMocks();
  });

  // ─── Connection Handlers ────────────────────────────────────────────────

  describe('CONNECTION_LIST_PORTS', () => {
    it('returns port list', async () => {
      const res = await invoke(IPCChannel.CONNECTION_LIST_PORTS);
      expect(res.success).toBe(true);
      expect(res.data).toEqual([{ path: '/dev/ttyUSB0' }]);
    });

    it('returns error when MSP client not set', async () => {
      setMSPClient(null);
      const res = await invoke(IPCChannel.CONNECTION_LIST_PORTS);
      expect(res.success).toBe(false);
      expect(res.error).toContain('not initialized');
    });
  });

  describe('CONNECTION_CONNECT', () => {
    it('connects to port', async () => {
      const res = await invoke(IPCChannel.CONNECTION_CONNECT, '/dev/ttyUSB0');
      expect(res.success).toBe(true);
      expect(mockMSP.connect).toHaveBeenCalledWith('/dev/ttyUSB0');
    });

    it('returns error on failure', async () => {
      mockMSP.connect.mockRejectedValue(new Error('Port busy'));
      const res = await invoke(IPCChannel.CONNECTION_CONNECT, '/dev/ttyUSB0');
      expect(res.success).toBe(false);
      expect(res.error).toBe('Port busy');
    });
  });

  describe('CONNECTION_DISCONNECT', () => {
    it('disconnects', async () => {
      const res = await invoke(IPCChannel.CONNECTION_DISCONNECT);
      expect(res.success).toBe(true);
      expect(mockMSP.disconnect).toHaveBeenCalled();
    });
  });

  describe('CONNECTION_GET_STATUS', () => {
    it('returns connection status', async () => {
      const res = await invoke(IPCChannel.CONNECTION_GET_STATUS);
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ connected: true, port: '/dev/ttyUSB0' });
    });
  });

  // ─── FC Info Handlers ───────────────────────────────────────────────────

  describe('FC_GET_INFO', () => {
    it('returns FC info', async () => {
      const res = await invoke(IPCChannel.FC_GET_INFO);
      expect(res.success).toBe(true);
      expect(res.data.variant).toBe('BTFL');
      expect(res.data.version).toBe('4.5.1');
    });
  });

  describe('FC_EXPORT_CLI', () => {
    it('exports diff format', async () => {
      const res = await invoke(IPCChannel.FC_EXPORT_CLI, 'diff');
      expect(res.success).toBe(true);
      expect(mockMSP.exportCLIDiff).toHaveBeenCalled();
      expect(res.data).toContain('gyro_lpf1_static_hz');
    });

    it('exports dump format', async () => {
      const res = await invoke(IPCChannel.FC_EXPORT_CLI, 'dump');
      expect(res.success).toBe(true);
      expect(mockMSP.exportCLIDump).toHaveBeenCalled();
      expect(res.data).toBe('dump output');
    });
  });

  describe('FC_GET_BLACKBOX_SETTINGS', () => {
    it('parses settings from snapshot CLI diff', async () => {
      const res = await invoke(IPCChannel.FC_GET_BLACKBOX_SETTINGS);
      expect(res.success).toBe(true);
      expect(res.data.debugMode).toBe('GYRO_SCALED');
      expect(res.data.sampleRate).toBe(1);
      expect(res.data.loggingRateHz).toBe(4000); // 8000/1/2^1
    });

    it('returns defaults when settings not in diff', async () => {
      mockSnapshotMgr.loadSnapshot.mockResolvedValue({
        id: 'snap-1',
        configuration: { cliDiff: '' },
      });
      const res = await invoke(IPCChannel.FC_GET_BLACKBOX_SETTINGS);
      expect(res.success).toBe(true);
      expect(res.data.debugMode).toBe('NONE');
      expect(res.data.sampleRate).toBe(1);
    });

    it('reads pid_process_denom from MSP when connected', async () => {
      mockMSP.getPidProcessDenom.mockResolvedValue(2);
      const res = await invoke(IPCChannel.FC_GET_BLACKBOX_SETTINGS);
      expect(res.success).toBe(true);
      expect(res.data.loggingRateHz).toBe(2000); // 8000/2/2^1
    });

    it('falls back to CLI diff when MSP getPidProcessDenom fails', async () => {
      mockMSP.getPidProcessDenom.mockRejectedValue(new Error('timeout'));
      mockSnapshotMgr.loadSnapshot.mockResolvedValue({
        id: 'snap-1',
        configuration: {
          cliDiff:
            'set debug_mode = GYRO_SCALED\nset blackbox_sample_rate = 1\nset pid_process_denom = 4',
        },
      });
      const res = await invoke(IPCChannel.FC_GET_BLACKBOX_SETTINGS);
      expect(res.success).toBe(true);
      expect(res.data.loggingRateHz).toBe(1000); // 8000/4/2^1
    });

    it('returns error when no active profile', async () => {
      mockProfileMgr.getCurrentProfile.mockResolvedValue(null);
      const res = await invoke(IPCChannel.FC_GET_BLACKBOX_SETTINGS);
      expect(res.success).toBe(false);
      expect(res.error).toContain('No active profile');
    });
  });

  describe('FC_GET_FEEDFORWARD_CONFIG', () => {
    it('returns feedforward configuration', async () => {
      const res = await invoke(IPCChannel.FC_GET_FEEDFORWARD_CONFIG);
      expect(res.success).toBe(true);
      expect(mockMSP.getFeedforwardConfiguration).toHaveBeenCalled();
    });

    it('returns error when not connected', async () => {
      mockMSP.isConnected.mockReturnValue(false);
      const res = await invoke(IPCChannel.FC_GET_FEEDFORWARD_CONFIG);
      expect(res.success).toBe(false);
      expect(res.error).toContain('not connected');
    });
  });

  describe('FC_FIX_BLACKBOX_SETTINGS', () => {
    it('applies CLI commands and reboots', async () => {
      const res = await invoke(IPCChannel.FC_FIX_BLACKBOX_SETTINGS, {
        commands: ['set debug_mode = GYRO_SCALED', 'set blackbox_sample_rate = 0'],
      });
      expect(res.success).toBe(true);
      expect(res.data.appliedCommands).toBe(2);
      expect(res.data.rebooted).toBe(true);
      expect(mockMSP.connection.enterCLI).toHaveBeenCalled();
      expect(mockMSP.connection.sendCLICommand).toHaveBeenCalledTimes(2);
      expect(mockMSP.saveAndReboot).toHaveBeenCalled();
    });

    it('sets pendingSettingsSnapshot flag', async () => {
      // Consume any prior state
      consumePendingSettingsSnapshot();
      expect(consumePendingSettingsSnapshot()).toBe(false);

      await invoke(IPCChannel.FC_FIX_BLACKBOX_SETTINGS, {
        commands: ['set debug_mode = GYRO_SCALED'],
      });

      expect(consumePendingSettingsSnapshot()).toBe(true);
      expect(consumePendingSettingsSnapshot()).toBe(false); // consumed
    });

    it('rejects empty commands', async () => {
      const res = await invoke(IPCChannel.FC_FIX_BLACKBOX_SETTINGS, { commands: [] });
      expect(res.success).toBe(false);
      expect(res.error).toContain('No commands');
    });

    it('rejects when not connected', async () => {
      mockMSP.isConnected.mockReturnValue(false);
      const res = await invoke(IPCChannel.FC_FIX_BLACKBOX_SETTINGS, {
        commands: ['set debug_mode = GYRO_SCALED'],
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('not connected');
    });

    it('returns error when CLI command is rejected', async () => {
      mockMSP.connection.sendCLICommand.mockResolvedValue(
        'set debug_mode = INVALID\r\nInvalid value\r\n# '
      );
      const res = await invoke(IPCChannel.FC_FIX_BLACKBOX_SETTINGS, {
        commands: ['set debug_mode = INVALID'],
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('CLI command rejected');
    });
  });

  // ─── Snapshot Handlers ──────────────────────────────────────────────────

  describe('SNAPSHOT_CREATE', () => {
    it('creates snapshot with label', async () => {
      const res = await invoke(IPCChannel.SNAPSHOT_CREATE, 'My Backup');
      expect(res.success).toBe(true);
      expect(mockSnapshotMgr.createSnapshot).toHaveBeenCalledWith('My Backup');
      expect(res.data.id).toBe('snap-new');
    });
  });

  describe('SNAPSHOT_LIST', () => {
    it('returns snapshots filtered by current profile', async () => {
      // Profile has snap-1 in snapshotIds
      const res = await invoke(IPCChannel.SNAPSHOT_LIST);
      expect(res.success).toBe(true);
      // Only snap-1 matches the profile's snapshotIds
      expect(res.data.map((s: any) => s.id)).toContain('snap-1');
    });

    it('returns empty array when no profile selected', async () => {
      mockProfileMgr.getCurrentProfile.mockResolvedValue(null);
      const res = await invoke(IPCChannel.SNAPSHOT_LIST);
      expect(res.success).toBe(true);
      expect(res.data).toEqual([]);
    });
  });

  describe('SNAPSHOT_DELETE', () => {
    it('deletes snapshot', async () => {
      const res = await invoke(IPCChannel.SNAPSHOT_DELETE, 'snap-2');
      expect(res.success).toBe(true);
      expect(mockSnapshotMgr.deleteSnapshot).toHaveBeenCalledWith('snap-2');
    });
  });

  describe('SNAPSHOT_EXPORT', () => {
    it('exports snapshot to file', async () => {
      const res = await invoke(IPCChannel.SNAPSHOT_EXPORT, 'snap-1', '/tmp/export.json');
      expect(res.success).toBe(true);
      expect(mockSnapshotMgr.exportSnapshot).toHaveBeenCalledWith('snap-1', '/tmp/export.json');
    });
  });

  describe('SNAPSHOT_LOAD', () => {
    it('loads snapshot data', async () => {
      const res = await invoke(IPCChannel.SNAPSHOT_LOAD, 'snap-1');
      expect(res.success).toBe(true);
      expect(res.data.id).toBe('snap-1');
    });
  });

  // ─── Profile Handlers ──────────────────────────────────────────────────

  describe('PROFILE_CREATE', () => {
    it('creates profile and sends profileChanged event', async () => {
      const input = {
        fcSerialNumber: 'SN-001',
        fcInfo: {},
        name: 'Test',
        size: '5"',
        battery: '4S',
      };
      const res = await invoke(IPCChannel.PROFILE_CREATE, input);
      expect(res.success).toBe(true);
      expect(mockProfileMgr.createProfile).toHaveBeenCalledWith(input);
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPCChannel.EVENT_PROFILE_CHANGED,
        expect.objectContaining({ id: 'prof-1' })
      );
    });

    it('auto-creates baseline snapshot', async () => {
      await invoke(IPCChannel.PROFILE_CREATE, { fcSerialNumber: 'SN-001' });
      expect(mockSnapshotMgr.createBaselineIfMissing).toHaveBeenCalled();
    });

    it('succeeds even if baseline creation fails', async () => {
      mockSnapshotMgr.createBaselineIfMissing.mockRejectedValue(new Error('CLI error'));
      const res = await invoke(IPCChannel.PROFILE_CREATE, { fcSerialNumber: 'SN-001' });
      expect(res.success).toBe(true);
    });
  });

  describe('PROFILE_CREATE_FROM_PRESET', () => {
    it('creates profile from preset ID', async () => {
      const res = await invoke(IPCChannel.PROFILE_CREATE_FROM_PRESET, '5inch-freestyle');
      expect(res.success).toBe(true);
      expect(mockMSP.getFCSerialNumber).toHaveBeenCalled();
      expect(mockMSP.getFCInfo).toHaveBeenCalled();
      expect(mockProfileMgr.createProfileFromPreset).toHaveBeenCalled();
    });

    it('uses custom name when provided', async () => {
      await invoke(IPCChannel.PROFILE_CREATE_FROM_PRESET, '5inch-freestyle', 'My Quad');
      expect(mockProfileMgr.createProfileFromPreset).toHaveBeenCalledWith(
        expect.anything(),
        'SN-001',
        expect.anything(),
        'My Quad'
      );
    });

    it('returns error for unknown preset', async () => {
      const res = await invoke(IPCChannel.PROFILE_CREATE_FROM_PRESET, 'nonexistent-preset');
      expect(res.success).toBe(false);
      expect(res.error).toContain('not found');
    });
  });

  describe('PROFILE_UPDATE', () => {
    it('updates profile', async () => {
      const res = await invoke(IPCChannel.PROFILE_UPDATE, 'prof-1', { name: 'Updated' });
      expect(res.success).toBe(true);
      expect(mockProfileMgr.updateProfile).toHaveBeenCalledWith('prof-1', { name: 'Updated' });
    });
  });

  describe('PROFILE_DELETE', () => {
    it('deletes profile with cascading snapshot + log cleanup', async () => {
      const res = await invoke(IPCChannel.PROFILE_DELETE, 'prof-1');
      expect(res.success).toBe(true);
      // Deletes all snapshots from the profile
      expect(mockSnapshotMgr.deleteSnapshot).toHaveBeenCalledWith('snap-1');
      expect(mockSnapshotMgr.deleteSnapshot).toHaveBeenCalledWith('snap-2');
      // Deletes all BB logs for the profile
      expect(mockBBMgr.deleteLogsForProfile).toHaveBeenCalledWith('prof-1');
      // Deletes the profile itself
      expect(mockProfileMgr.deleteProfile).toHaveBeenCalledWith('prof-1');
    });

    it('sends profileChanged(null) when deleting active profile', async () => {
      const res = await invoke(IPCChannel.PROFILE_DELETE, 'prof-1');
      expect(res.success).toBe(true);
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPCChannel.EVENT_PROFILE_CHANGED,
        null
      );
    });

    it('disconnects when deleting active profile', async () => {
      await invoke(IPCChannel.PROFILE_DELETE, 'prof-1');
      expect(mockMSP.disconnect).toHaveBeenCalled();
    });

    it('does not disconnect when deleting non-active profile', async () => {
      mockProfileMgr.getCurrentProfileId.mockReturnValue('prof-other');
      await invoke(IPCChannel.PROFILE_DELETE, 'prof-1');
      expect(mockMSP.disconnect).not.toHaveBeenCalled();
    });

    it('returns error for non-existent profile', async () => {
      mockProfileMgr.getProfile.mockResolvedValue(null);
      const res = await invoke(IPCChannel.PROFILE_DELETE, 'ghost');
      expect(res.success).toBe(false);
      expect(res.error).toContain('not found');
    });

    it('continues deletion even if snapshot cleanup fails', async () => {
      mockSnapshotMgr.deleteSnapshot.mockRejectedValue(new Error('file locked'));
      const res = await invoke(IPCChannel.PROFILE_DELETE, 'prof-1');
      expect(res.success).toBe(true);
      expect(mockProfileMgr.deleteProfile).toHaveBeenCalled();
    });
  });

  describe('PROFILE_LIST', () => {
    it('returns profile metadata', async () => {
      const res = await invoke(IPCChannel.PROFILE_LIST);
      expect(res.success).toBe(true);
      expect(res.data).toHaveLength(1);
    });
  });

  describe('PROFILE_GET', () => {
    it('returns profile by ID', async () => {
      const res = await invoke(IPCChannel.PROFILE_GET, 'prof-1');
      expect(res.success).toBe(true);
      expect(res.data.id).toBe('prof-1');
    });
  });

  describe('PROFILE_GET_CURRENT', () => {
    it('returns current profile', async () => {
      const res = await invoke(IPCChannel.PROFILE_GET_CURRENT);
      expect(res.success).toBe(true);
      expect(res.data.id).toBe('prof-1');
    });

    it('returns null when no current profile', async () => {
      mockProfileMgr.getCurrentProfile.mockResolvedValue(null);
      const res = await invoke(IPCChannel.PROFILE_GET_CURRENT);
      expect(res.success).toBe(true);
      expect(res.data).toBeNull();
    });
  });

  describe('PROFILE_SET_CURRENT', () => {
    it('switches active profile', async () => {
      const res = await invoke(IPCChannel.PROFILE_SET_CURRENT, 'prof-1');
      expect(res.success).toBe(true);
      expect(mockProfileMgr.setCurrentProfile).toHaveBeenCalledWith('prof-1');
    });
  });

  describe('PROFILE_EXPORT', () => {
    it('exports profile to file', async () => {
      const res = await invoke(IPCChannel.PROFILE_EXPORT, 'prof-1', '/tmp/profile.json');
      expect(res.success).toBe(true);
      expect(mockProfileMgr.exportProfile).toHaveBeenCalledWith('prof-1', '/tmp/profile.json');
    });
  });

  describe('PROFILE_GET_FC_SERIAL', () => {
    it('returns FC serial number', async () => {
      const res = await invoke(IPCChannel.PROFILE_GET_FC_SERIAL);
      expect(res.success).toBe(true);
      expect(res.data).toBe('SN-001');
    });
  });

  // ─── PID Configuration Handlers ────────────────────────────────────────

  describe('PID_GET_CONFIG', () => {
    it('returns PID configuration from FC', async () => {
      const res = await invoke(IPCChannel.PID_GET_CONFIG);
      expect(res.success).toBe(true);
      expect(res.data.roll.P).toBe(45);
    });

    it('returns error when not connected', async () => {
      mockMSP.isConnected.mockReturnValue(false);
      const res = await invoke(IPCChannel.PID_GET_CONFIG);
      expect(res.success).toBe(false);
      expect(res.error).toContain('not connected');
    });
  });

  describe('PID_UPDATE_CONFIG', () => {
    it('validates and sends PID config to FC', async () => {
      const config: PIDConfiguration = {
        roll: { P: 50, I: 80, D: 40 },
        pitch: { P: 52, I: 84, D: 43 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const res = await invoke(IPCChannel.PID_UPDATE_CONFIG, config);
      expect(res.success).toBe(true);
      expect(mockMSP.setPIDConfiguration).toHaveBeenCalledWith(config);
    });

    it('sends pidChanged event', async () => {
      const config: PIDConfiguration = {
        roll: { P: 50, I: 80, D: 40 },
        pitch: { P: 52, I: 84, D: 43 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      await invoke(IPCChannel.PID_UPDATE_CONFIG, config);
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPCChannel.EVENT_PID_CHANGED,
        config
      );
    });

    it('rejects out-of-range PID values', async () => {
      const config: PIDConfiguration = {
        roll: { P: 300, I: 80, D: 40 }, // P > 255
        pitch: { P: 52, I: 84, D: 43 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const res = await invoke(IPCChannel.PID_UPDATE_CONFIG, config);
      expect(res.success).toBe(false);
      expect(res.error).toContain('out of range');
    });

    it('rejects NaN PID values', async () => {
      const config: PIDConfiguration = {
        roll: { P: NaN, I: 80, D: 40 },
        pitch: { P: 52, I: 84, D: 43 },
        yaw: { P: 45, I: 80, D: 0 },
      };
      const res = await invoke(IPCChannel.PID_UPDATE_CONFIG, config);
      expect(res.success).toBe(false);
      expect(res.error).toContain('Invalid');
    });
  });

  describe('PID_SAVE_CONFIG', () => {
    it('saves and reboots', async () => {
      const res = await invoke(IPCChannel.PID_SAVE_CONFIG);
      expect(res.success).toBe(true);
      expect(mockMSP.saveAndReboot).toHaveBeenCalled();
    });
  });

  // ─── Blackbox Handlers ─────────────────────────────────────────────────

  describe('BLACKBOX_GET_INFO', () => {
    it('returns blackbox info', async () => {
      const res = await invoke(IPCChannel.BLACKBOX_GET_INFO);
      expect(res.success).toBe(true);
      expect(res.data.supported).toBe(true);
      expect(res.data.usedSize).toBe(1024000);
    });

    it('returns error when MSP client not set', async () => {
      setMSPClient(null);
      const res = await invoke(IPCChannel.BLACKBOX_GET_INFO);
      expect(res.success).toBe(false);
    });
  });

  describe('BLACKBOX_DOWNLOAD_LOG', () => {
    it('downloads log with progress and saves metadata', async () => {
      const { event } = createMockEvent();
      mockMSP.downloadBlackboxLog.mockImplementation(async (onProgress: any) => {
        onProgress(50);
        onProgress(100);
        return Buffer.from('log-data');
      });

      const res = await invokeWithEvent(IPCChannel.BLACKBOX_DOWNLOAD_LOG, event);
      expect(res.success).toBe(true);
      expect(res.data.id).toBe('log-1');
      // Progress events sent
      expect(event.sender.send).toHaveBeenCalledWith(
        IPCChannel.EVENT_BLACKBOX_DOWNLOAD_PROGRESS,
        50
      );
    });

    it('rejects concurrent downloads', async () => {
      // Simulate a download in progress by making the first one hang
      let resolveDownload: any;
      mockMSP.downloadBlackboxLog.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveDownload = resolve;
          })
      );

      const { event: e1 } = createMockEvent();
      const { event: e2 } = createMockEvent();

      const promise1 = invokeWithEvent(IPCChannel.BLACKBOX_DOWNLOAD_LOG, e1);
      // Wait a tick for the flag to be set
      await new Promise((r) => setTimeout(r, 10));

      const res2 = await invokeWithEvent(IPCChannel.BLACKBOX_DOWNLOAD_LOG, e2);
      expect(res2.success).toBe(false);
      expect(res2.error).toContain('already in progress');

      // Resolve first download
      resolveDownload(Buffer.from('data'));
      await promise1;
    });

    it('requires active profile', async () => {
      mockProfileMgr.getCurrentProfile.mockResolvedValue(null);
      const res = await invoke(IPCChannel.BLACKBOX_DOWNLOAD_LOG);
      expect(res.success).toBe(false);
      expect(res.error).toContain('No active profile');
    });

    it('clears download flag on error', async () => {
      mockMSP.downloadBlackboxLog.mockRejectedValue(new Error('read timeout'));
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.BLACKBOX_DOWNLOAD_LOG, event);
      expect(res.success).toBe(false);

      // Second download should NOT say "already in progress"
      mockMSP.downloadBlackboxLog.mockResolvedValue(Buffer.from('data'));
      const res2 = await invoke(IPCChannel.BLACKBOX_DOWNLOAD_LOG);
      expect(res2.success).toBe(true);
    });
  });

  describe('BLACKBOX_LIST_LOGS', () => {
    it('returns logs for current profile', async () => {
      const res = await invoke(IPCChannel.BLACKBOX_LIST_LOGS);
      expect(res.success).toBe(true);
      expect(mockBBMgr.listLogs).toHaveBeenCalledWith('prof-1');
    });

    it('returns empty array when no profile', async () => {
      mockProfileMgr.getCurrentProfile.mockResolvedValue(null);
      const res = await invoke(IPCChannel.BLACKBOX_LIST_LOGS);
      expect(res.success).toBe(true);
      expect(res.data).toEqual([]);
    });
  });

  describe('BLACKBOX_DELETE_LOG', () => {
    it('deletes log by ID', async () => {
      const res = await invoke(IPCChannel.BLACKBOX_DELETE_LOG, 'log-1');
      expect(res.success).toBe(true);
      expect(mockBBMgr.deleteLog).toHaveBeenCalledWith('log-1');
    });
  });

  describe('BLACKBOX_ERASE_FLASH', () => {
    it('erases flash', async () => {
      const res = await invoke(IPCChannel.BLACKBOX_ERASE_FLASH);
      expect(res.success).toBe(true);
      expect(mockMSP.eraseBlackboxFlash).toHaveBeenCalled();
    });
  });

  describe('BLACKBOX_TEST_READ', () => {
    it('returns test read result', async () => {
      const res = await invoke(IPCChannel.BLACKBOX_TEST_READ);
      expect(res.success).toBe(true);
      expect(res.data.success).toBe(true);
    });
  });

  describe('BLACKBOX_OPEN_FOLDER', () => {
    it('opens containing directory', async () => {
      const res = await invoke(IPCChannel.BLACKBOX_OPEN_FOLDER, '/tmp/logs/file.bbl');
      expect(res.success).toBe(true);
      expect(shell.openPath).toHaveBeenCalledWith('/tmp/logs');
    });

    it('returns error when shell.openPath returns error string', async () => {
      vi.mocked(shell.openPath).mockResolvedValue('No such directory');
      const res = await invoke(IPCChannel.BLACKBOX_OPEN_FOLDER, '/nonexistent/file.bbl');
      expect(res.success).toBe(false);
      expect(res.error).toContain('Failed to open folder');
    });
  });

  describe('BLACKBOX_PARSE_LOG', () => {
    it('parses log and returns result', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(Buffer.from('fake-bbl-data'));
      mockParse.mockResolvedValue({
        sessions: [{ index: 0, header: {}, flightData: {} }],
        success: true,
        parseTimeMs: 100,
      });

      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.BLACKBOX_PARSE_LOG, event, 'log-1');
      expect(res.success).toBe(true);
      expect(res.data.sessions).toHaveLength(1);
    });

    it('returns error for non-existent log', async () => {
      mockBBMgr.getLog.mockResolvedValue(null);
      const res = await invoke(IPCChannel.BLACKBOX_PARSE_LOG, 'ghost');
      expect(res.success).toBe(false);
      expect(res.error).toContain('not found');
    });

    it('sends parse progress events', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(Buffer.from('data'));
      mockParse.mockImplementation(async (_data: any, onProgress: any) => {
        if (onProgress)
          onProgress({ percent: 50, bytesProcessed: 500, totalBytes: 1000, currentSession: 0 });
        return { sessions: [{ index: 0 }], success: true, parseTimeMs: 50 };
      });

      const { event } = createMockEvent();
      await invokeWithEvent(IPCChannel.BLACKBOX_PARSE_LOG, event, 'log-1');
      expect(event.sender.send).toHaveBeenCalledWith(
        IPCChannel.EVENT_BLACKBOX_PARSE_PROGRESS,
        expect.objectContaining({ percent: 50 })
      );
    });
  });

  // ─── Analysis Handlers ─────────────────────────────────────────────────

  describe('ANALYSIS_RUN_FILTER', () => {
    beforeEach(() => {
      vi.mocked(fsp.readFile).mockResolvedValue(Buffer.from('bbl-data'));
      mockParse.mockResolvedValue({
        sessions: [
          {
            index: 0,
            header: { rawHeaders: new Map() },
            flightData: {},
          },
        ],
        success: true,
        parseTimeMs: 100,
      });
      mockAnalyzeFilters.mockResolvedValue({
        noise: { overallLevel: 'medium' },
        recommendations: [
          { setting: 'gyro_lpf1_static_hz', currentValue: 250, recommendedValue: 200 },
        ],
        summary: 'Test',
        analysisTimeMs: 500,
        sessionIndex: 0,
        segmentsUsed: 3,
      });
    });

    it('runs filter analysis and returns results', async () => {
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.ANALYSIS_RUN_FILTER, event, 'log-1', 0);
      expect(res.success).toBe(true);
      expect(res.data.recommendations).toHaveLength(1);
    });

    it('auto-reads filter settings from FC when not provided', async () => {
      const { event } = createMockEvent();
      await invokeWithEvent(IPCChannel.ANALYSIS_RUN_FILTER, event, 'log-1');
      expect(mockMSP.getFilterConfiguration).toHaveBeenCalled();
    });

    it('validates session index range', async () => {
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.ANALYSIS_RUN_FILTER, event, 'log-1', 5);
      expect(res.success).toBe(false);
      expect(res.error).toContain('out of range');
    });

    it('returns error for non-existent log', async () => {
      mockBBMgr.getLog.mockResolvedValue(null);
      const res = await invoke(IPCChannel.ANALYSIS_RUN_FILTER, 'ghost');
      expect(res.success).toBe(false);
      expect(res.error).toContain('not found');
    });

    it('attaches header validation warnings', async () => {
      mockValidateBBLHeader.mockReturnValue([
        {
          code: 'wrong_debug_mode',
          message: 'Debug mode should be GYRO_SCALED',
          severity: 'warning',
        },
      ]);
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.ANALYSIS_RUN_FILTER, event, 'log-1');
      expect(res.success).toBe(true);
      expect(res.data.warnings).toHaveLength(1);
      expect(res.data.warnings[0].code).toBe('wrong_debug_mode');
    });

    it('reports progress via events', async () => {
      mockAnalyzeFilters.mockImplementation(
        async (_data: any, _idx: any, _settings: any, onProgress: any) => {
          if (onProgress) onProgress({ step: 'fft', percent: 50 });
          return {
            noise: { overallLevel: 'low' },
            recommendations: [],
            summary: '',
            analysisTimeMs: 100,
            sessionIndex: 0,
            segmentsUsed: 1,
          };
        }
      );

      const { event } = createMockEvent();
      await invokeWithEvent(IPCChannel.ANALYSIS_RUN_FILTER, event, 'log-1');
      expect(event.sender.send).toHaveBeenCalledWith(
        IPCChannel.EVENT_ANALYSIS_PROGRESS,
        expect.objectContaining({ step: 'fft', percent: 50 })
      );
    });
  });

  describe('ANALYSIS_RUN_PID', () => {
    beforeEach(() => {
      vi.mocked(fsp.readFile).mockResolvedValue(Buffer.from('bbl-data'));
      mockParse.mockResolvedValue({
        sessions: [
          {
            index: 0,
            header: { rawHeaders: new Map() },
            flightData: {},
          },
        ],
        success: true,
        parseTimeMs: 100,
      });
      mockExtractFlightPIDs.mockReturnValue(null);
      mockAnalyzePID.mockResolvedValue({
        roll: { responses: [], meanOvershoot: 10 },
        pitch: { responses: [], meanOvershoot: 12 },
        yaw: { responses: [], meanOvershoot: 8 },
        recommendations: [{ setting: 'pid_roll_d', currentValue: 40, recommendedValue: 35 }],
        summary: 'Test PID',
        analysisTimeMs: 300,
        sessionIndex: 0,
        stepsDetected: 15,
        currentPIDs: {
          roll: { P: 45, I: 80, D: 40 },
          pitch: { P: 47, I: 84, D: 43 },
          yaw: { P: 45, I: 80, D: 0 },
        },
      });
    });

    it('runs PID analysis and returns results', async () => {
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.ANALYSIS_RUN_PID, event, 'log-1', 0);
      expect(res.success).toBe(true);
      expect(res.data.stepsDetected).toBe(15);
    });

    it('auto-reads PID config from FC when not provided', async () => {
      const { event } = createMockEvent();
      await invokeWithEvent(IPCChannel.ANALYSIS_RUN_PID, event, 'log-1');
      expect(mockMSP.getPIDConfiguration).toHaveBeenCalled();
    });

    it('reads flight style from current profile', async () => {
      mockProfileMgr.getCurrentProfile.mockResolvedValue({
        id: 'prof-1',
        flightStyle: 'aggressive',
      });
      const { event } = createMockEvent();
      await invokeWithEvent(IPCChannel.ANALYSIS_RUN_PID, event, 'log-1');
      expect(mockAnalyzePID).toHaveBeenCalledWith(
        expect.anything(),
        0,
        expect.anything(),
        expect.anything(),
        null, // flightPIDs
        expect.anything(), // rawHeaders
        'aggressive', // flightStyle
        undefined, // historyObservations
        undefined, // droneSize (mock profile has no size)
        undefined // droneWeight (mock profile has no weight)
      );
    });

    it('validates session index range', async () => {
      const res = await invoke(IPCChannel.ANALYSIS_RUN_PID, 'log-1', 99);
      expect(res.success).toBe(false);
      expect(res.error).toContain('out of range');
    });
  });

  // ─── Tuning Apply Recommendations ──────────────────────────────────────

  describe('TUNING_APPLY_RECOMMENDATIONS', () => {
    const baseInput = {
      filterRecommendations: [
        {
          setting: 'gyro_lpf1_static_hz',
          currentValue: 250,
          recommendedValue: 200,
          reason: '',
          impact: 'noise' as const,
          confidence: 'high' as const,
        },
      ],
      pidRecommendations: [
        {
          setting: 'pid_roll_p',
          currentValue: 45,
          recommendedValue: 50,
          reason: '',
          impact: 'response' as const,
          confidence: 'high' as const,
        },
      ],
      feedforwardRecommendations: [],
    };

    it('applies PID via MSP then filters via CLI in correct order', async () => {
      const { event } = createMockEvent();
      const callOrder: string[] = [];
      mockMSP.setPIDConfiguration.mockImplementation(async () => {
        callOrder.push('setPID');
      });
      mockMSP.connection.enterCLI.mockImplementation(async () => {
        callOrder.push('enterCLI');
        (mockMSP.connection as any)._resetCLIState?.();
        mockMSP.connection.isInCLI.mockReturnValue(true);
      });
      mockMSP.connection.sendCLICommand.mockImplementation(async () => {
        callOrder.push('sendCLI');
        return '';
      });
      mockMSP.saveAndReboot.mockImplementation(async () => {
        callOrder.push('save');
      });

      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, baseInput);
      expect(res.success).toBe(true);

      // Order: PID via MSP → enter CLI → filter CLI → profile name CLI → save
      // (profile name guard sees isInCLI=true, skips extra enterCLI)
      expect(callOrder).toEqual(['setPID', 'enterCLI', 'sendCLI', 'sendCLI', 'save']);
    });

    it('rejects PID values outside safety bounds', async () => {
      const input = {
        ...baseInput,
        pidRecommendations: [
          {
            setting: 'pid_roll_p',
            currentValue: 45,
            recommendedValue: 300, // Exceeds pMax (120)
            reason: '',
            impact: 'response' as const,
            confidence: 'high' as const,
          },
        ],
      };
      const { event } = createMockEvent();
      const result = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);

      expect(result.success).toBe(false);
      expect(result.error).toContain('PID validation failed');
      expect(result.error).toContain('pid_roll_p');
    });

    it('accepts pid_roll_d = 100 (cross-size envelope allows 7" dMax)', async () => {
      // Regression: the gate used to hardcode the 5" dMax=80, aborting the whole
      // apply for legal 6"/7" D recommendations (81-100).
      const input = {
        ...baseInput,
        pidRecommendations: [
          {
            setting: 'pid_roll_d',
            currentValue: 95,
            recommendedValue: 100, // 7" dMax — must pass the envelope gate
            reason: '',
            impact: 'response' as const,
            confidence: 'high' as const,
          },
        ],
      };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);
      expect(res.success).toBe(true);
      expect(res.data.appliedPIDs).toBe(1);
    });

    it('rejects pid_roll_d above the cross-size envelope (101+)', async () => {
      const input = {
        ...baseInput,
        pidRecommendations: [
          {
            setting: 'pid_roll_d',
            currentValue: 95,
            recommendedValue: 130, // Above 7" dMax=100 envelope
            reason: '',
            impact: 'response' as const,
            confidence: 'high' as const,
          },
        ],
      };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);
      expect(res.success).toBe(false);
      expect(res.error).toContain('PID validation failed');
      expect(res.error).toContain('pid_roll_d');
    });

    it('never applies informational recommendations (P-PIDLIM, P-HI-P, …)', async () => {
      // Informational recs are advisory-only. Even if a client forgets to filter
      // them (the wizard used to), the handler must drop them — an unfiltered
      // pidsum_limit_yaw 400→1000 jump was silently auto-applied before this guard.
      const input = {
        filterRecommendations: [],
        pidRecommendations: [
          {
            setting: 'pid_roll_p',
            currentValue: 45,
            recommendedValue: 45,
            reason: 'P higher than typical',
            impact: 'both' as const,
            confidence: 'low' as const,
            informational: true,
          },
        ],
        feedforwardRecommendations: [
          {
            setting: 'pidsum_limit_yaw',
            currentValue: 400,
            recommendedValue: 1000,
            reason: 'heavy build',
            impact: 'response' as const,
            confidence: 'low' as const,
            informational: true,
          },
        ],
      };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);

      // All-informational input → zero-change success, nothing written, no reboot
      expect(res.success).toBe(true);
      expect(res.data.appliedPIDs).toBe(0);
      expect(res.data.appliedFeedforward).toBe(0);
      expect(res.data.rebooted).toBe(false);
      expect(mockMSP.setPIDConfiguration).not.toHaveBeenCalled();
      expect(mockMSP.connection.sendCLICommand).not.toHaveBeenCalled();
    });

    it('applies actionable recs while dropping informational ones from the same batch', async () => {
      const input = {
        ...baseInput,
        feedforwardRecommendations: [
          {
            setting: 'pidsum_limit',
            currentValue: 500,
            recommendedValue: 1000,
            reason: 'heavy build',
            impact: 'response' as const,
            confidence: 'low' as const,
            informational: true,
          },
        ],
      };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);

      expect(res.success).toBe(true);
      expect(res.data.appliedPIDs).toBe(1);
      expect(res.data.appliedFeedforward).toBe(0);
      const cliCalls = mockMSP.connection.sendCLICommand.mock.calls.map((c: any[]) => c[0]);
      expect(cliCalls.some((cmd: string) => cmd.includes('pidsum_limit'))).toBe(false);
    });

    it('rejects d_min_gain above firmware max (100)', async () => {
      const input = {
        ...baseInput,
        pidRecommendations: [],
        feedforwardRecommendations: [
          {
            setting: 'd_min_gain',
            currentValue: 37,
            recommendedValue: 150, // Firmware range is 0-100
            reason: '',
            impact: 'stability' as const,
            confidence: 'medium' as const,
          },
        ],
      };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);
      expect(res.success).toBe(false);
      expect(res.error).toContain('Feedforward validation failed');
      expect(res.error).toContain('d_min_gain');
    });

    it('rejects tpa_rate above firmware max (100)', async () => {
      const input = {
        ...baseInput,
        pidRecommendations: [],
        feedforwardRecommendations: [
          {
            setting: 'tpa_rate',
            currentValue: 65,
            recommendedValue: 120, // Firmware range is 0-100
            reason: '',
            impact: 'stability' as const,
            confidence: 'medium' as const,
          },
        ],
      };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);
      expect(res.success).toBe(false);
      expect(res.error).toContain('Feedforward validation failed');
      expect(res.error).toContain('tpa_rate');
    });

    it('accepts new firmware-exact FF gates at their maxima', async () => {
      const input = {
        ...baseInput,
        pidRecommendations: [],
        feedforwardRecommendations: [
          { setting: 'feedforward_smooth_factor', currentValue: 25, recommendedValue: 75 },
          { setting: 'feedforward_jitter_factor', currentValue: 7, recommendedValue: 20 },
          { setting: 'feedforward_averaging', currentValue: 0, recommendedValue: 4 },
        ],
      };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);
      expect(res.success).toBe(true);
      expect(res.data.appliedFeedforward).toBe(3);
    });

    it('rejects dyn_notch_min_hz outside firmware range (20-250)', async () => {
      const input = {
        ...baseInput,
        filterRecommendations: [
          {
            setting: 'dyn_notch_min_hz',
            currentValue: 100,
            recommendedValue: 300, // Firmware max is 250
            reason: '',
            impact: 'noise' as const,
            confidence: 'medium' as const,
          },
        ],
        pidRecommendations: [],
      };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);
      expect(res.success).toBe(false);
      expect(res.error).toContain('Filter validation failed');
      expect(res.error).toContain('dyn_notch_min_hz');
    });

    it('clamps PID values within bounds to integer range 0-255', async () => {
      const input = {
        ...baseInput,
        pidRecommendations: [
          {
            setting: 'pid_roll_p',
            currentValue: 45,
            recommendedValue: 50.7, // Within bounds, fractional
            reason: '',
            impact: 'response' as const,
            confidence: 'high' as const,
          },
        ],
      };
      const { event } = createMockEvent();
      await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);

      const setCall = mockMSP.setPIDConfiguration.mock.calls[0][0];
      expect(setCall.roll.P).toBe(51); // Rounded
    });

    it('reports progress per stage', async () => {
      const { event } = createMockEvent();
      await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, baseInput);

      const progressCalls = event.sender.send.mock.calls.filter(
        (c: any[]) => c[0] === IPCChannel.EVENT_TUNING_APPLY_PROGRESS
      );
      expect(progressCalls.length).toBeGreaterThanOrEqual(4);
      // Verify stages appear in order
      const stages = progressCalls.map((c: any[]) => c[1].stage);
      expect(stages).toContain('pid');
      expect(stages).toContain('filter');
      expect(stages).toContain('feedforward');
      expect(stages).toContain('save');
    });

    it('handles filter-only (no PIDs)', async () => {
      const input = { ...baseInput, pidRecommendations: [] };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);
      expect(res.success).toBe(true);
      expect(res.data.appliedPIDs).toBe(0);
      expect(res.data.appliedFilters).toBe(1);
      expect(mockMSP.setPIDConfiguration).not.toHaveBeenCalled();
    });

    it('handles PID-only (no filters) — enters CLI for profile name', async () => {
      const input = { ...baseInput, filterRecommendations: [] };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);
      expect(res.success).toBe(true);
      expect(res.data.appliedPIDs).toBe(1);
      expect(res.data.appliedFilters).toBe(0);
      // CLI entered for profile_name write even without filter/FF recs
      expect(mockMSP.connection.enterCLI).toHaveBeenCalled();
    });

    it('returns success without reboot when no recommendations', async () => {
      const input = {
        filterRecommendations: [],
        pidRecommendations: [],
        feedforwardRecommendations: [],
      };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);
      expect(res.success).toBe(true);
      expect(res.data.appliedPIDs).toBe(0);
      expect(res.data.appliedFilters).toBe(0);
      expect(res.data.rebooted).toBe(false);
    });

    it('creates post-tuning snapshot during apply after saveAndReboot', async () => {
      // saveAndReboot() now blocks until FC reconnects, so post-tuning snapshot
      // is created inline in the apply handler (not deferred to connected handler).
      mockTuningMgr.getSession.mockResolvedValue({
        profileId: 'prof-1',
        phase: TUNING_PHASE.PID_APPLIED,
        tuningType: 'filter',
        startedAt: '2026-01-01',
        updatedAt: '2026-01-01',
      });

      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, baseInput);
      expect(res.success).toBe(true);
      // Post-tuning snapshot created during apply
      expect(mockSnapshotMgr.createSnapshot).toHaveBeenCalledWith(
        expect.stringContaining('Post-tuning'),
        'auto',
        expect.objectContaining({ snapshotRole: 'post-tuning' })
      );
    });

    it('applies feedforward recommendations via CLI', async () => {
      const input = {
        filterRecommendations: [],
        pidRecommendations: [],
        feedforwardRecommendations: [
          {
            setting: 'feedforward_boost',
            currentValue: 15,
            recommendedValue: 10,
            reason: '',
            impact: 'overshoot' as const,
            confidence: 'medium' as const,
          },
        ],
      };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);
      expect(res.success).toBe(true);
      expect(res.data.appliedFeedforward).toBe(1);
      expect(res.data.appliedFilters).toBe(0);
      expect(res.data.appliedPIDs).toBe(0);
      expect(mockMSP.connection.enterCLI).toHaveBeenCalled();
      expect(mockMSP.connection.sendCLICommand).toHaveBeenCalledWith('set feedforward_boost = 10');
    });

    it('applies filters and feedforward in single CLI session', async () => {
      const input = {
        ...baseInput,
        pidRecommendations: [],
        feedforwardRecommendations: [
          {
            setting: 'feedforward_boost',
            currentValue: 15,
            recommendedValue: 10,
            reason: '',
            impact: 'overshoot' as const,
            confidence: 'medium' as const,
          },
        ],
      };
      const { event } = createMockEvent();
      const callOrder: string[] = [];
      mockMSP.connection.enterCLI.mockImplementation(async () => {
        callOrder.push('enterCLI');
        mockMSP.connection.isInCLI.mockReturnValue(true);
      });
      mockMSP.connection.sendCLICommand.mockImplementation(async (cmd: string) => {
        callOrder.push(`cli:${cmd}`);
        return '';
      });
      mockMSP.saveAndReboot.mockImplementation(async () => {
        callOrder.push('save');
      });

      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);
      expect(res.success).toBe(true);
      expect(res.data.appliedFilters).toBe(1);
      expect(res.data.appliedFeedforward).toBe(1);
      // Only one enterCLI — profile name guard sees isInCLI=true, skips extra enter
      expect(callOrder.filter((c) => c === 'enterCLI')).toHaveLength(1);
    });

    it('returns error when not connected', async () => {
      mockMSP.isConnected.mockReturnValue(false);
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, baseInput);
      expect(res.success).toBe(false);
      expect(res.error).toContain('not connected');
    });

    it('returns error when CLI command is rejected (Invalid name)', async () => {
      mockMSP.connection.sendCLICommand.mockResolvedValue(
        'set bad_setting = 200\r\nInvalid name\r\n# '
      );
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, baseInput);
      expect(res.success).toBe(false);
      expect(res.error).toContain('Filter changes failed');
    });

    it('returns error when FF CLI command is rejected', async () => {
      // Filter commands succeed, FF command fails
      let callCount = 0;
      mockMSP.connection.sendCLICommand.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) return 'set bad_ff = 10\r\nInvalid name\r\n# ';
        return '# ';
      });
      const input = {
        ...baseInput,
        feedforwardRecommendations: [
          { setting: 'feedforward_boost', currentValue: 15, recommendedValue: 10 },
        ],
      };
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.TUNING_APPLY_RECOMMENDATIONS, event, input);
      expect(res.success).toBe(false);
      expect(res.error).toContain('Feedforward changes failed');
    });
  });

  // ─── Snapshot Restore ──────────────────────────────────────────────────

  describe('SNAPSHOT_RESTORE', () => {
    it('restores snapshot with backup → CLI commands → save', async () => {
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.SNAPSHOT_RESTORE, event, 'snap-1', true);
      expect(res.success).toBe(true);
      expect(res.data.appliedCommands).toBeGreaterThan(0);
      expect(res.data.rebooted).toBe(true);
      expect(res.data.backupSnapshotId).toBe('snap-new');
    });

    it('creates backup when requested', async () => {
      const { event } = createMockEvent();
      await invokeWithEvent(IPCChannel.SNAPSHOT_RESTORE, event, 'snap-1', true);
      expect(mockSnapshotMgr.createSnapshot).toHaveBeenCalledWith('Pre-restore (auto)');
    });

    it('skips backup when not requested', async () => {
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.SNAPSHOT_RESTORE, event, 'snap-1', false);
      expect(res.success).toBe(true);
      expect(res.data.backupSnapshotId).toBeUndefined();
    });

    it('filters out non-restorable commands', async () => {
      mockSnapshotMgr.loadSnapshot.mockResolvedValue({
        id: 'snap-1',
        configuration: {
          cliDiff: [
            '# comment',
            'diff all',
            'batch start',
            'defaults nosave',
            'board_name SPEEDY',
            'manufacturer_id SPBE',
            'mcu_id 12345',
            'signature abc',
            'profile 0',
            'rateprofile 0',
            'set gyro_lpf1_static_hz = 250',
            'set dterm_lpf1_static_hz = 150',
            'feature TELEMETRY',
            'serial 0 64 115200',
            'save',
          ].join('\n'),
        },
      });

      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.SNAPSHOT_RESTORE, event, 'snap-1', false);
      expect(res.success).toBe(true);
      // profile/rateprofile context switches + set/feature/serial commands
      expect(res.data.appliedCommands).toBe(6);
      expect(mockMSP.connection.sendCLICommand).toHaveBeenCalledWith('profile 0');
      expect(mockMSP.connection.sendCLICommand).toHaveBeenCalledWith('rateprofile 0');
      expect(mockMSP.connection.sendCLICommand).toHaveBeenCalledWith(
        'set gyro_lpf1_static_hz = 250'
      );
      expect(mockMSP.connection.sendCLICommand).toHaveBeenCalledWith('feature TELEMETRY');
      expect(mockMSP.connection.sendCLICommand).toHaveBeenCalledWith('serial 0 64 115200');
    });

    it('rejects snapshot with no restorable commands', async () => {
      mockSnapshotMgr.loadSnapshot.mockResolvedValue({
        id: 'snap-empty',
        configuration: { cliDiff: '# just a comment\ndiff all\nsave' },
      });

      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.SNAPSHOT_RESTORE, event, 'snap-empty', false);
      expect(res.success).toBe(false);
      expect(res.error).toContain('no restorable settings');
    });

    it('reports progress events', async () => {
      const { event } = createMockEvent();
      await invokeWithEvent(IPCChannel.SNAPSHOT_RESTORE, event, 'snap-1', true);

      const progressCalls = event.sender.send.mock.calls.filter(
        (c: any[]) => c[0] === IPCChannel.EVENT_SNAPSHOT_RESTORE_PROGRESS
      );
      expect(progressCalls.length).toBeGreaterThanOrEqual(3);
      const stages = progressCalls.map((c: any[]) => c[1].stage);
      expect(stages).toContain('backup');
      expect(stages).toContain('cli');
      expect(stages).toContain('save');
    });

    it('continues restore when CLI command is rejected, reports failed commands', async () => {
      mockMSP.connection.sendCLICommand.mockResolvedValue(
        'set bad_setting = 200\r\nInvalid name\r\n# '
      );
      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.SNAPSHOT_RESTORE, event, 'snap-1', false);
      expect(res.success).toBe(true);
      expect(res.data.appliedCommands).toBe(0);
      expect(res.data.failedCommands).toBeDefined();
      expect(res.data.failedCommands.length).toBeGreaterThan(0);
    });

    it('dump-based restore sends defaults nosave before commands', async () => {
      mockSnapshotMgr.loadSnapshot.mockResolvedValue({
        id: 'snap-dump',
        configuration: {
          cliDiff: 'set gyro_lpf1_static_hz = 250',
          cliDump: [
            'defaults nosave',
            '# master',
            'set gyro_lpf1_static_hz = 250',
            'set p_roll = 45',
            'profile 1',
            'set p_pitch = 47',
            'save',
          ].join('\n'),
        },
      });

      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.SNAPSHOT_RESTORE, event, 'snap-dump', false);
      expect(res.success).toBe(true);

      const cliCalls = mockMSP.connection.sendCLICommand.mock.calls.map((c: any[]) => c[0]);
      expect(cliCalls[0]).toBe('defaults nosave');
      expect(cliCalls).toContain('set gyro_lpf1_static_hz = 250');
      expect(cliCalls).toContain('set p_roll = 45');
      expect(cliCalls).toContain('profile 1');
      expect(cliCalls).toContain('set p_pitch = 47');
      // Identity and control commands should be filtered
      expect(cliCalls).not.toContain('save');
    });

    it('dump-based restore filters identity commands from dump', async () => {
      mockSnapshotMgr.loadSnapshot.mockResolvedValue({
        id: 'snap-dump-id',
        configuration: {
          cliDiff: 'set gyro_lpf1_static_hz = 250',
          cliDump: [
            'defaults nosave',
            'board_name SPEEDYBEEF405MINI',
            'manufacturer_id SPBE',
            'mcu_id 12345',
            'signature abc',
            'set gyro_lpf1_static_hz = 250',
            'save',
          ].join('\n'),
        },
      });

      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.SNAPSHOT_RESTORE, event, 'snap-dump-id', false);
      expect(res.success).toBe(true);

      const cliCalls = mockMSP.connection.sendCLICommand.mock.calls.map((c: any[]) => c[0]);
      expect(cliCalls).not.toContain('board_name SPEEDYBEEF405MINI');
      expect(cliCalls).not.toContain('manufacturer_id SPBE');
      expect(cliCalls).not.toContain('signature abc');
    });

    it('falls back to diff-based restore when cliDump is missing', async () => {
      mockSnapshotMgr.loadSnapshot.mockResolvedValue({
        id: 'snap-legacy',
        configuration: {
          cliDiff: 'set gyro_lpf1_static_hz = 250\nset p_roll = 45',
        },
      });

      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.SNAPSHOT_RESTORE, event, 'snap-legacy', false);
      expect(res.success).toBe(true);

      const cliCalls = mockMSP.connection.sendCLICommand.mock.calls.map((c: any[]) => c[0]);
      // Should NOT send defaults nosave for legacy diff-based restore
      expect(cliCalls).not.toContain('defaults nosave');
      expect(cliCalls).toContain('set gyro_lpf1_static_hz = 250');
    });

    it('dump-based restore still applies MSP PIDs', async () => {
      mockSnapshotMgr.loadSnapshot.mockResolvedValue({
        id: 'snap-dump-pid',
        configuration: {
          cliDiff: 'set gyro_lpf1_static_hz = 250',
          cliDump: 'set gyro_lpf1_static_hz = 250\nset p_roll = 45',
          pidConfig: {
            roll: { P: 45, I: 80, D: 40 },
            pitch: { P: 47, I: 84, D: 46 },
            yaw: { P: 45, I: 80, D: 0 },
          },
        },
        metadata: { bfPidProfileIndex: 1 },
      });

      const { event } = createMockEvent();
      const res = await invokeWithEvent(IPCChannel.SNAPSHOT_RESTORE, event, 'snap-dump-pid', false);
      expect(res.success).toBe(true);
      expect(mockMSP.setPIDConfiguration).toHaveBeenCalled();
      expect(mockMSP.selectPidProfile).toHaveBeenCalledWith(1);
    });
  });

  // ─── Tuning Session Handlers ───────────────────────────────────────────

  describe('TUNING_GET_SESSION', () => {
    it('returns session for current profile', async () => {
      mockTuningMgr.getSession.mockResolvedValue({
        profileId: 'prof-1',
        phase: TUNING_PHASE.FILTER_FLIGHT_PENDING,
      });
      const res = await invoke(IPCChannel.TUNING_GET_SESSION);
      expect(res.success).toBe(true);
      expect(res.data.phase).toBe(TUNING_PHASE.FILTER_FLIGHT_PENDING);
    });

    it('returns null when no profile', async () => {
      mockProfileMgr.getCurrentProfileId.mockReturnValue(null);
      const res = await invoke(IPCChannel.TUNING_GET_SESSION);
      expect(res.success).toBe(true);
      expect(res.data).toBeNull();
    });

    it('returns null when no session exists', async () => {
      const res = await invoke(IPCChannel.TUNING_GET_SESSION);
      expect(res.success).toBe(true);
      expect(res.data).toBeNull();
    });
  });

  describe('TUNING_START_SESSION', () => {
    it('creates session and sends event', async () => {
      mockTuningMgr.getSession.mockResolvedValue({
        profileId: 'prof-1',
        phase: TUNING_PHASE.FILTER_FLIGHT_PENDING,
        startedAt: '2026-01-01',
        updatedAt: '2026-01-01',
        baselineSnapshotId: 'snap-new',
      });

      const res = await invoke(IPCChannel.TUNING_START_SESSION);
      expect(res.success).toBe(true);
      expect(mockTuningMgr.createSession).toHaveBeenCalledWith('prof-1', TUNING_TYPE.FILTER);
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPCChannel.EVENT_TUNING_SESSION_CHANGED,
        expect.objectContaining({ phase: TUNING_PHASE.FILTER_FLIGHT_PENDING })
      );
    });

    it('creates pre-tuning backup snapshot with session context', async () => {
      await invoke(IPCChannel.TUNING_START_SESSION);
      expect(mockSnapshotMgr.createSnapshot).toHaveBeenCalledWith(
        'Pre-tuning #1 (Filter Tune)',
        'auto',
        { tuningSessionNumber: 1, tuningType: 'filter', snapshotRole: 'pre-tuning' }
      );
    });

    it('returns error when no profile', async () => {
      mockProfileMgr.getCurrentProfileId.mockReturnValue(null);
      const res = await invoke(IPCChannel.TUNING_START_SESSION);
      expect(res.success).toBe(false);
      expect(res.error).toContain('No active profile');
    });

    it('auto-advances to *_analysis when reuseLogId provided', async () => {
      mockTuningMgr.getSession.mockResolvedValue({
        profileId: 'prof-1',
        phase: TUNING_PHASE.FILTER_ANALYSIS,
        filterLogId: 'reused-log-123',
        startedAt: '2026-01-01',
        updatedAt: '2026-01-01',
      });

      const res = await invoke(
        IPCChannel.TUNING_START_SESSION,
        TUNING_TYPE.FILTER,
        undefined,
        'reused-log-123'
      );
      expect(res.success).toBe(true);

      // Should have called updatePhase to advance to filter_analysis with the reused log
      expect(mockTuningMgr.updatePhase).toHaveBeenCalledWith(
        'prof-1',
        TUNING_PHASE.FILTER_ANALYSIS,
        expect.objectContaining({ filterLogId: 'reused-log-123' })
      );
    });

    it('auto-advances PID session with reuseLogId', async () => {
      mockTuningMgr.getSession.mockResolvedValue({
        profileId: 'prof-1',
        phase: TUNING_PHASE.PID_ANALYSIS,
        pidLogId: 'reused-pid-log',
        startedAt: '2026-01-01',
        updatedAt: '2026-01-01',
      });

      await invoke(IPCChannel.TUNING_START_SESSION, TUNING_TYPE.PID, undefined, 'reused-pid-log');
      expect(mockTuningMgr.updatePhase).toHaveBeenCalledWith(
        'prof-1',
        TUNING_PHASE.PID_ANALYSIS,
        expect.objectContaining({ pidLogId: 'reused-pid-log' })
      );
    });

    it('starts normal session without reuseLogId', async () => {
      mockTuningMgr.getSession.mockResolvedValue({
        profileId: 'prof-1',
        phase: TUNING_PHASE.FILTER_FLIGHT_PENDING,
        startedAt: '2026-01-01',
        updatedAt: '2026-01-01',
      });

      await invoke(IPCChannel.TUNING_START_SESSION);
      // updatePhase called for initial metadata but NOT for analysis phase advance
      const analysisCalls = mockTuningMgr.updatePhase.mock.calls.filter(
        (c: any[]) => c[1] === TUNING_PHASE.FILTER_ANALYSIS
      );
      expect(analysisCalls).toHaveLength(0);
    });
  });

  describe('TUNING_UPDATE_PHASE', () => {
    it('updates phase and sends event', async () => {
      mockTuningMgr.updatePhase.mockResolvedValue({
        profileId: 'prof-1',
        phase: TUNING_PHASE.FILTER_LOG_READY,
      });

      const res = await invoke(IPCChannel.TUNING_UPDATE_PHASE, TUNING_PHASE.FILTER_LOG_READY, {
        filterLogId: 'log-1',
      });
      expect(res.success).toBe(true);
      expect(mockTuningMgr.updatePhase).toHaveBeenCalledWith(
        'prof-1',
        TUNING_PHASE.FILTER_LOG_READY,
        {
          filterLogId: 'log-1',
        }
      );
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPCChannel.EVENT_TUNING_SESSION_CHANGED,
        expect.objectContaining({ phase: TUNING_PHASE.FILTER_LOG_READY })
      );
    });
  });

  describe('TUNING_RESET_SESSION', () => {
    it('deletes session and sends null event', async () => {
      const res = await invoke(IPCChannel.TUNING_RESET_SESSION);
      expect(res.success).toBe(true);
      expect(mockTuningMgr.deleteSession).toHaveBeenCalledWith('prof-1');
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
        IPCChannel.EVENT_TUNING_SESSION_CHANGED,
        null
      );
    });
  });

  // ─── consumePendingSettingsSnapshot ─────────────────────────────────────

  describe('consumePendingSettingsSnapshot', () => {
    it('returns true once after fix, then false', async () => {
      // Reset state
      consumePendingSettingsSnapshot();

      await invoke(IPCChannel.FC_FIX_BLACKBOX_SETTINGS, {
        commands: ['set debug_mode = GYRO_SCALED'],
      });

      expect(consumePendingSettingsSnapshot()).toBe(true);
      expect(consumePendingSettingsSnapshot()).toBe(false);
    });
  });

  // ─── Handler Registration ──────────────────────────────────────────────

  describe('handler registration', () => {
    it('registers all expected IPC channels', () => {
      const expectedChannels = [
        IPCChannel.CONNECTION_LIST_PORTS,
        IPCChannel.CONNECTION_CONNECT,
        IPCChannel.CONNECTION_DISCONNECT,
        IPCChannel.CONNECTION_GET_STATUS,
        IPCChannel.FC_GET_INFO,
        IPCChannel.FC_EXPORT_CLI,
        IPCChannel.FC_GET_BLACKBOX_SETTINGS,
        IPCChannel.FC_GET_FEEDFORWARD_CONFIG,
        IPCChannel.FC_FIX_BLACKBOX_SETTINGS,
        IPCChannel.SNAPSHOT_CREATE,
        IPCChannel.SNAPSHOT_LIST,
        IPCChannel.SNAPSHOT_DELETE,
        IPCChannel.SNAPSHOT_EXPORT,
        IPCChannel.SNAPSHOT_LOAD,
        IPCChannel.PROFILE_CREATE,
        IPCChannel.PROFILE_CREATE_FROM_PRESET,
        IPCChannel.PROFILE_UPDATE,
        IPCChannel.PROFILE_DELETE,
        IPCChannel.PROFILE_LIST,
        IPCChannel.PROFILE_GET,
        IPCChannel.PROFILE_GET_CURRENT,
        IPCChannel.PROFILE_SET_CURRENT,
        IPCChannel.PROFILE_EXPORT,
        IPCChannel.PROFILE_GET_FC_SERIAL,
        IPCChannel.PID_GET_CONFIG,
        IPCChannel.PID_UPDATE_CONFIG,
        IPCChannel.PID_SAVE_CONFIG,
        IPCChannel.BLACKBOX_GET_INFO,
        IPCChannel.BLACKBOX_DOWNLOAD_LOG,
        IPCChannel.BLACKBOX_LIST_LOGS,
        IPCChannel.BLACKBOX_DELETE_LOG,
        IPCChannel.BLACKBOX_ERASE_FLASH,
        IPCChannel.BLACKBOX_OPEN_FOLDER,
        IPCChannel.BLACKBOX_TEST_READ,
        IPCChannel.BLACKBOX_PARSE_LOG,
        IPCChannel.ANALYSIS_RUN_FILTER,
        IPCChannel.ANALYSIS_RUN_PID,
        IPCChannel.TUNING_APPLY_RECOMMENDATIONS,
        IPCChannel.SNAPSHOT_RESTORE,
        IPCChannel.TUNING_GET_SESSION,
        IPCChannel.TUNING_START_SESSION,
        IPCChannel.TUNING_UPDATE_PHASE,
        IPCChannel.TUNING_RESET_SESSION,
      ];

      for (const channel of expectedChannels) {
        expect(registeredHandlers.has(channel), `Handler missing for ${channel}`).toBe(true);
      }
    });
  });
});
