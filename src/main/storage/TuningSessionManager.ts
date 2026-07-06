/**
 * TuningSessionManager
 *
 * CRUD operations for persistent tuning session files.
 * One file per profile: {dataDir}/tuning/{profileId}.json
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import type { TuningSession, TuningPhase, TuningType } from '@shared/types/tuning.types';
import { TUNING_TYPE, TUNING_PHASE } from '@shared/constants';
import { logger } from '../utils/logger';

/**
 * Valid phase transitions per tuning type.
 * Each phase maps to the set of phases it can transition TO.
 * 'completed' is a terminal phase with no outgoing transitions.
 */
const VALID_TRANSITIONS: Record<TuningType, Record<string, readonly TuningPhase[]>> = {
  filter: {
    [TUNING_PHASE.FILTER_FLIGHT_PENDING]: [
      TUNING_PHASE.FILTER_LOG_READY,
      TUNING_PHASE.FILTER_ANALYSIS,
    ],
    [TUNING_PHASE.FILTER_LOG_READY]: [TUNING_PHASE.FILTER_ANALYSIS],
    // COMPLETED allowed directly from analysis: zero-change apply skips verification (PR #241)
    [TUNING_PHASE.FILTER_ANALYSIS]: [TUNING_PHASE.FILTER_APPLIED, TUNING_PHASE.COMPLETED],
    [TUNING_PHASE.FILTER_APPLIED]: [TUNING_PHASE.FILTER_VERIFICATION_PENDING],
    [TUNING_PHASE.FILTER_VERIFICATION_PENDING]: [TUNING_PHASE.COMPLETED],
  },
  pid: {
    [TUNING_PHASE.PID_FLIGHT_PENDING]: [TUNING_PHASE.PID_LOG_READY, TUNING_PHASE.PID_ANALYSIS],
    [TUNING_PHASE.PID_LOG_READY]: [TUNING_PHASE.PID_ANALYSIS],
    [TUNING_PHASE.PID_ANALYSIS]: [TUNING_PHASE.PID_APPLIED, TUNING_PHASE.COMPLETED],
    [TUNING_PHASE.PID_APPLIED]: [TUNING_PHASE.PID_VERIFICATION_PENDING],
    [TUNING_PHASE.PID_VERIFICATION_PENDING]: [TUNING_PHASE.COMPLETED],
  },
  flash: {
    [TUNING_PHASE.FLASH_FLIGHT_PENDING]: [
      TUNING_PHASE.FLASH_LOG_READY,
      TUNING_PHASE.FLASH_ANALYSIS,
    ],
    [TUNING_PHASE.FLASH_LOG_READY]: [TUNING_PHASE.FLASH_ANALYSIS],
    [TUNING_PHASE.FLASH_ANALYSIS]: [TUNING_PHASE.FLASH_APPLIED, TUNING_PHASE.COMPLETED],
    [TUNING_PHASE.FLASH_APPLIED]: [TUNING_PHASE.FLASH_VERIFICATION_PENDING],
    [TUNING_PHASE.FLASH_VERIFICATION_PENDING]: [TUNING_PHASE.COMPLETED],
  },
};

export class TuningSessionManager {
  private dataDir: string;

  constructor(basePath: string) {
    this.dataDir = join(basePath, 'tuning');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    logger.info('TuningSessionManager initialized');
  }

  async getSession(profileId: string): Promise<TuningSession | null> {
    const filePath = this.sessionPath(profileId);
    try {
      const json = await fs.readFile(filePath, 'utf-8');
      const session = JSON.parse(json) as TuningSession;
      return session;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      // Corrupted file — treat as no session
      logger.warn(
        `Failed to load tuning session for profile ${profileId}, treating as no session`,
        error
      );
      return null;
    }
  }

  async createSession(
    profileId: string,
    tuningType: TuningType = TUNING_TYPE.FILTER
  ): Promise<TuningSession> {
    const now = new Date().toISOString();

    let initialPhase: TuningPhase;
    switch (tuningType) {
      case TUNING_TYPE.FLASH:
        initialPhase = TUNING_PHASE.FLASH_FLIGHT_PENDING;
        break;
      case TUNING_TYPE.PID:
        initialPhase = TUNING_PHASE.PID_FLIGHT_PENDING;
        break;
      default:
        initialPhase = TUNING_PHASE.FILTER_FLIGHT_PENDING;
        break;
    }

    const session: TuningSession = {
      profileId,
      phase: initialPhase,
      tuningType,
      startedAt: now,
      updatedAt: now,
    };

    await this.saveSession(session);
    logger.info(`Tuning session created for profile ${profileId}`);
    return session;
  }

  async updatePhase(
    profileId: string,
    phase: TuningPhase,
    extraData?: Partial<TuningSession>
  ): Promise<TuningSession> {
    const existing = await this.getSession(profileId);
    if (!existing) {
      throw new Error(`No tuning session found for profile ${profileId}`);
    }

    // Validate transition: allow same-phase updates (extraData only) and legal forward transitions
    if (phase !== existing.phase) {
      const transitions = VALID_TRANSITIONS[existing.tuningType];
      const allowed = transitions?.[existing.phase];
      if (!allowed || !allowed.includes(phase)) {
        throw new Error(
          `Invalid phase transition: ${existing.tuningType} session cannot go from '${existing.phase}' to '${phase}'`
        );
      }
    }

    const updated: TuningSession = {
      ...existing,
      ...extraData,
      phase,
      updatedAt: new Date().toISOString(),
    };

    await this.saveSession(updated);
    logger.info(`Tuning session phase updated: ${profileId} → ${phase}`);
    return updated;
  }

  async deleteSession(profileId: string): Promise<void> {
    const filePath = this.sessionPath(profileId);
    try {
      await fs.unlink(filePath);
      logger.info(`Tuning session deleted for profile ${profileId}`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return; // Already deleted, no-op
      }
      throw error;
    }
  }

  private sessionPath(profileId: string): string {
    return join(this.dataDir, `${profileId}.json`);
  }

  private async saveSession(session: TuningSession): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const filePath = this.sessionPath(session.profileId);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }
}
