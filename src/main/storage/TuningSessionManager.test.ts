import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TuningSessionManager } from './TuningSessionManager';
import type { TuningSession } from '@shared/types/tuning.types';
import { TUNING_TYPE, TUNING_PHASE } from '@shared/constants';

describe('TuningSessionManager', () => {
  let manager: TuningSessionManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'tuning-test-'));
    manager = new TuningSessionManager(tempDir);
    await manager.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('creates the tuning directory', async () => {
      const tuningDir = join(tempDir, 'tuning');
      const stat = await fs.stat(tuningDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('getSession', () => {
    it('returns null for non-existent session', async () => {
      const result = await manager.getSession('nonexistent-profile');
      expect(result).toBeNull();
    });

    it('returns session data for existing session', async () => {
      await manager.createSession('profile-1');
      const result = await manager.getSession('profile-1');
      expect(result).not.toBeNull();
      expect(result!.profileId).toBe('profile-1');
      expect(result!.phase).toBe(TUNING_PHASE.FILTER_FLIGHT_PENDING);
    });

    it('returns null for corrupted JSON file', async () => {
      const filePath = join(tempDir, 'tuning', 'corrupt.json');
      await fs.writeFile(filePath, '{invalid json!!!', 'utf-8');
      const result = await manager.getSession('corrupt');
      expect(result).toBeNull();
    });
  });

  describe('createSession', () => {
    it('creates session file in tuning directory', async () => {
      const session = await manager.createSession('profile-1');
      expect(session.profileId).toBe('profile-1');
      expect(session.phase).toBe(TUNING_PHASE.FILTER_FLIGHT_PENDING);
      expect(session.startedAt).toBeTruthy();
      expect(session.updatedAt).toBeTruthy();

      // Verify file exists
      const filePath = join(tempDir, 'tuning', 'profile-1.json');
      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);
    });

    it('stores valid JSON', async () => {
      await manager.createSession('profile-1');
      const filePath = join(tempDir, 'tuning', 'profile-1.json');
      const json = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(json) as TuningSession;
      expect(parsed.profileId).toBe('profile-1');
    });

    it('overwrites existing session when creating new', async () => {
      const first = await manager.createSession('profile-1');
      await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_ANALYSIS);

      const second = await manager.createSession('profile-1');
      expect(second.phase).toBe(TUNING_PHASE.FILTER_FLIGHT_PENDING);
      expect(new Date(second.startedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(first.startedAt).getTime()
      );
    });
  });

  describe('updatePhase', () => {
    it('updates phase and preserves existing data', async () => {
      const session = await manager.createSession('profile-1');
      const updated = await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_LOG_READY);

      expect(updated.profileId).toBe('profile-1');
      expect(updated.phase).toBe(TUNING_PHASE.FILTER_LOG_READY);
      expect(updated.startedAt).toBe(session.startedAt);
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(session.updatedAt).getTime()
      );
    });

    it('merges extra data into session', async () => {
      await manager.createSession('profile-1');
      const updated = await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_ANALYSIS, {
        filterLogId: 'log-123',
      });

      expect(updated.phase).toBe(TUNING_PHASE.FILTER_ANALYSIS);
      expect(updated.filterLogId).toBe('log-123');
    });

    it('preserves previous extra data across updates', async () => {
      await manager.createSession('profile-1');
      await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_LOG_READY, {
        filterLogId: 'log-123',
      });
      const updated = await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_ANALYSIS, {
        appliedFilterChanges: [
          { setting: 'gyro_lpf1_static_hz', previousValue: 250, newValue: 150 },
        ],
      });

      expect(updated.filterLogId).toBe('log-123');
      expect(updated.appliedFilterChanges).toHaveLength(1);
      expect(updated.phase).toBe(TUNING_PHASE.FILTER_ANALYSIS);
    });

    it('throws when session does not exist', async () => {
      await expect(
        manager.updatePhase('nonexistent', TUNING_PHASE.FILTER_LOG_READY)
      ).rejects.toThrow('No tuning session found');
    });
  });

  describe('deleteSession', () => {
    it('deletes session file', async () => {
      await manager.createSession('profile-1');
      await manager.deleteSession('profile-1');

      const result = await manager.getSession('profile-1');
      expect(result).toBeNull();
    });

    it('is a no-op for non-existent session', async () => {
      // Should not throw
      await manager.deleteSession('nonexistent');
    });
  });

  describe('flash tuning support', () => {
    it('creates flash session with flash_flight_pending phase', async () => {
      const session = await manager.createSession('profile-1', TUNING_TYPE.FLASH);
      expect(session.phase).toBe(TUNING_PHASE.FLASH_FLIGHT_PENDING);
      expect(session.tuningType).toBe(TUNING_TYPE.FLASH);
    });

    it('creates filter session by default', async () => {
      const session = await manager.createSession('profile-1');
      expect(session.phase).toBe(TUNING_PHASE.FILTER_FLIGHT_PENDING);
      expect(session.tuningType).toBe(TUNING_TYPE.FILTER);
    });

    it('creates filter session with explicit type', async () => {
      const session = await manager.createSession('profile-1', TUNING_TYPE.FILTER);
      expect(session.phase).toBe(TUNING_PHASE.FILTER_FLIGHT_PENDING);
      expect(session.tuningType).toBe(TUNING_TYPE.FILTER);
    });

    it('supports flash phase transitions', async () => {
      await manager.createSession('profile-1', TUNING_TYPE.FLASH);
      const updated = await manager.updatePhase('profile-1', TUNING_PHASE.FLASH_LOG_READY);
      expect(updated.phase).toBe(TUNING_PHASE.FLASH_LOG_READY);
      expect(updated.tuningType).toBe(TUNING_TYPE.FLASH);
    });

    it('preserves flashLogId across updates', async () => {
      await manager.createSession('profile-1', TUNING_TYPE.FLASH);
      await manager.updatePhase('profile-1', TUNING_PHASE.FLASH_ANALYSIS, {
        quickLogId: 'quick-log-123',
      });
      const session = await manager.getSession('profile-1');
      expect(session!.quickLogId).toBe('quick-log-123');
    });
  });

  describe('multiple profiles', () => {
    it('manages sessions independently per profile', async () => {
      await manager.createSession('profile-a');
      await manager.createSession('profile-b');

      await manager.updatePhase('profile-a', TUNING_PHASE.FILTER_LOG_READY);

      const sessionA = await manager.getSession('profile-a');
      const sessionB = await manager.getSession('profile-b');

      expect(sessionA!.phase).toBe(TUNING_PHASE.FILTER_LOG_READY);
      expect(sessionB!.phase).toBe(TUNING_PHASE.FILTER_FLIGHT_PENDING);
    });

    it('deleting one profile session does not affect another', async () => {
      await manager.createSession('profile-a');
      await manager.createSession('profile-b');

      await manager.deleteSession('profile-a');

      expect(await manager.getSession('profile-a')).toBeNull();
      expect(await manager.getSession('profile-b')).not.toBeNull();
    });
  });

  describe('phase transition validation', () => {
    it('allows valid forward transitions within same tuning type', async () => {
      await manager.createSession('profile-1'); // filter type
      const updated = await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_LOG_READY);
      expect(updated.phase).toBe(TUNING_PHASE.FILTER_LOG_READY);
    });

    it('rejects cross-mode transitions (filter → pid phase)', async () => {
      await manager.createSession('profile-1'); // filter type
      await expect(
        manager.updatePhase('profile-1', TUNING_PHASE.PID_FLIGHT_PENDING)
      ).rejects.toThrow('Invalid phase transition');
    });

    it('rejects backward transitions', async () => {
      await manager.createSession('profile-1');
      await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_LOG_READY);
      await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_ANALYSIS);
      await expect(manager.updatePhase('profile-1', TUNING_PHASE.FILTER_LOG_READY)).rejects.toThrow(
        'Invalid phase transition'
      );
    });

    it('allows same-phase updates (extraData only)', async () => {
      await manager.createSession('profile-1');
      const updated = await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_FLIGHT_PENDING, {
        filterLogId: 'log-123',
      });
      expect(updated.phase).toBe(TUNING_PHASE.FILTER_FLIGHT_PENDING);
      expect(updated.filterLogId).toBe('log-123');
    });

    it('allows skipping log_ready (flight_pending → analysis)', async () => {
      await manager.createSession('profile-1');
      const updated = await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_ANALYSIS);
      expect(updated.phase).toBe(TUNING_PHASE.FILTER_ANALYSIS);
    });

    it('validates PID session transitions', async () => {
      await manager.createSession('profile-1', TUNING_TYPE.PID);
      await manager.updatePhase('profile-1', TUNING_PHASE.PID_LOG_READY);
      await manager.updatePhase('profile-1', TUNING_PHASE.PID_ANALYSIS);
      await manager.updatePhase('profile-1', TUNING_PHASE.PID_APPLIED);
      await manager.updatePhase('profile-1', TUNING_PHASE.PID_VERIFICATION_PENDING);
      const completed = await manager.updatePhase('profile-1', TUNING_PHASE.COMPLETED);
      expect(completed.phase).toBe(TUNING_PHASE.COMPLETED);
    });

    it('validates Flash session transitions', async () => {
      await manager.createSession('profile-1', TUNING_TYPE.FLASH);
      await manager.updatePhase('profile-1', TUNING_PHASE.FLASH_LOG_READY);
      await manager.updatePhase('profile-1', TUNING_PHASE.FLASH_ANALYSIS);
      await manager.updatePhase('profile-1', TUNING_PHASE.FLASH_APPLIED);
      await manager.updatePhase('profile-1', TUNING_PHASE.FLASH_VERIFICATION_PENDING);
      const completed = await manager.updatePhase('profile-1', TUNING_PHASE.COMPLETED);
      expect(completed.phase).toBe(TUNING_PHASE.COMPLETED);
    });

    // Zero-change apply skips verification (PR #241) — *_analysis → completed is legal
    it('allows filter_analysis → completed (zero-change apply)', async () => {
      await manager.createSession('profile-1', TUNING_TYPE.FILTER);
      await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_ANALYSIS);
      const completed = await manager.updatePhase('profile-1', TUNING_PHASE.COMPLETED);
      expect(completed.phase).toBe(TUNING_PHASE.COMPLETED);
    });

    it('allows pid_analysis → completed (zero-change apply)', async () => {
      await manager.createSession('profile-1', TUNING_TYPE.PID);
      await manager.updatePhase('profile-1', TUNING_PHASE.PID_ANALYSIS);
      const completed = await manager.updatePhase('profile-1', TUNING_PHASE.COMPLETED);
      expect(completed.phase).toBe(TUNING_PHASE.COMPLETED);
    });

    it('allows flash_analysis → completed (zero-change apply)', async () => {
      await manager.createSession('profile-1', TUNING_TYPE.FLASH);
      await manager.updatePhase('profile-1', TUNING_PHASE.FLASH_ANALYSIS);
      const completed = await manager.updatePhase('profile-1', TUNING_PHASE.COMPLETED);
      expect(completed.phase).toBe(TUNING_PHASE.COMPLETED);
    });

    it('rejects filter_flight_pending → completed (no analysis skip)', async () => {
      await manager.createSession('profile-1', TUNING_TYPE.FILTER);
      await expect(manager.updatePhase('profile-1', TUNING_PHASE.COMPLETED)).rejects.toThrow(
        'Invalid phase transition'
      );
    });

    it('rejects pid_flight_pending → completed (no analysis skip)', async () => {
      await manager.createSession('profile-1', TUNING_TYPE.PID);
      await expect(manager.updatePhase('profile-1', TUNING_PHASE.COMPLETED)).rejects.toThrow(
        'Invalid phase transition'
      );
    });

    it('rejects flash_flight_pending → completed (no analysis skip)', async () => {
      await manager.createSession('profile-1', TUNING_TYPE.FLASH);
      await expect(manager.updatePhase('profile-1', TUNING_PHASE.COMPLETED)).rejects.toThrow(
        'Invalid phase transition'
      );
    });

    it('rejects cross-mode transition from analysis (pid session → filter_applied)', async () => {
      await manager.createSession('profile-1', TUNING_TYPE.PID);
      await manager.updatePhase('profile-1', TUNING_PHASE.PID_ANALYSIS);
      await expect(manager.updatePhase('profile-1', TUNING_PHASE.FILTER_APPLIED)).rejects.toThrow(
        'Invalid phase transition'
      );
    });

    it('rejects transitions from completed phase', async () => {
      await manager.createSession('profile-1');
      await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_LOG_READY);
      await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_ANALYSIS);
      await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_APPLIED);
      await manager.updatePhase('profile-1', TUNING_PHASE.FILTER_VERIFICATION_PENDING);
      await manager.updatePhase('profile-1', TUNING_PHASE.COMPLETED);
      await expect(
        manager.updatePhase('profile-1', TUNING_PHASE.FILTER_FLIGHT_PENDING)
      ).rejects.toThrow('Invalid phase transition');
    });
  });
});
