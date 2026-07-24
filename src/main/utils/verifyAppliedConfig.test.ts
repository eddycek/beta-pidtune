import { describe, it, expect, vi } from 'vitest';
import { verifyAppliedConfig } from './verifyAppliedConfig';
import type { PIDConfiguration } from '@shared/types/pid.types';
import type { CurrentFilterSettings } from '@shared/types/analysis.types';
import type { AppliedChange } from '@shared/types/tuning.types';

function makePIDConfig(overrides?: Partial<Record<string, number>>): PIDConfiguration {
  const base: PIDConfiguration = {
    roll: { P: 45, I: 85, D: 30 },
    pitch: { P: 47, I: 89, D: 33 },
    yaw: { P: 35, I: 90, D: 0 },
  };
  if (overrides) {
    for (const [key, val] of Object.entries(overrides)) {
      const match = key.match(/^pid_(roll|pitch|yaw)_(p|i|d)$/i);
      if (match && val !== undefined) {
        const axis = match[1] as 'roll' | 'pitch' | 'yaw';
        const term = match[2].toUpperCase() as 'P' | 'I' | 'D';
        base[axis][term] = val;
      }
    }
  }
  return base;
}

function makeFilterConfig(overrides?: Partial<CurrentFilterSettings>): CurrentFilterSettings {
  return {
    gyro_lpf1_static_hz: 250,
    gyro_lpf2_static_hz: 500,
    dterm_lpf1_static_hz: 150,
    dterm_lpf2_static_hz: 250,
    dyn_notch_min_hz: 100,
    dyn_notch_max_hz: 600,
    dyn_notch_q: 300,
    dyn_notch_count: 3,
    ...overrides,
  };
}

function createMockMSPClient(pidConfig: PIDConfiguration, filterConfig: CurrentFilterSettings) {
  return {
    getPIDConfiguration: vi.fn().mockResolvedValue(pidConfig),
    getFilterConfiguration: vi.fn().mockResolvedValue(filterConfig),
    setPIDConfiguration: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
  };
}

describe('verifyAppliedConfig', () => {
  describe('PID mode', () => {
    it('returns verified=true when all PID values match', async () => {
      const pidConfig = makePIDConfig({ pid_roll_p: 50 });
      const msp = createMockMSPClient(pidConfig, makeFilterConfig());
      const applied: AppliedChange[] = [{ setting: 'pid_roll_p', previousValue: 45, newValue: 50 }];

      const result = await verifyAppliedConfig(msp, 'pid', applied);

      expect(result.verified).toBe(true);
      expect(result.mismatches).toHaveLength(0);
      expect(result.suspicious).toBe(false);
    });

    it('detects PID mismatch and retries', async () => {
      const badConfig = makePIDConfig({ pid_roll_p: 40 }); // Wrong value
      const goodConfig = makePIDConfig({ pid_roll_p: 50 }); // Correct after retry
      const msp = createMockMSPClient(badConfig, makeFilterConfig());
      // After setPIDConfiguration (retry), return correct config
      msp.getPIDConfiguration.mockResolvedValueOnce(badConfig).mockResolvedValueOnce(goodConfig);
      const applied: AppliedChange[] = [{ setting: 'pid_roll_p', previousValue: 45, newValue: 50 }];

      const result = await verifyAppliedConfig(msp, 'pid', applied);

      expect(result.verified).toBe(true);
      expect(result.retried).toBe(true);
      expect(msp.setPIDConfiguration).toHaveBeenCalled();
    });

    it('reports mismatch after failed retry', async () => {
      const badConfig = makePIDConfig({ pid_roll_p: 40 });
      const msp = createMockMSPClient(badConfig, makeFilterConfig());
      // Both reads return wrong value
      msp.getPIDConfiguration.mockResolvedValue(badConfig);
      const applied: AppliedChange[] = [{ setting: 'pid_roll_p', previousValue: 45, newValue: 50 }];

      const result = await verifyAppliedConfig(msp, 'pid', applied);

      expect(result.verified).toBe(false);
      expect(result.mismatches.some((m) => m.includes('pid_roll_p'))).toBe(true);
      expect(result.retried).toBe(true);
    });

    it('flags suspicious when I=0 on roll', async () => {
      const config = makePIDConfig({ pid_roll_i: 0 });
      const msp = createMockMSPClient(config, makeFilterConfig());

      const result = await verifyAppliedConfig(msp, 'pid');

      expect(result.suspicious).toBe(true);
      expect(result.mismatches.some((m) => m.includes('pid_roll_i = 0'))).toBe(true);
    });

    it('flags suspicious when P=0 on pitch', async () => {
      const config = makePIDConfig({ pid_pitch_p: 0 });
      const msp = createMockMSPClient(config, makeFilterConfig());

      const result = await verifyAppliedConfig(msp, 'pid');

      expect(result.suspicious).toBe(true);
    });

    it('does not check filter settings in PID mode', async () => {
      const msp = createMockMSPClient(makePIDConfig(), makeFilterConfig());

      await verifyAppliedConfig(msp, 'pid');

      expect(msp.getFilterConfiguration).not.toHaveBeenCalled();
    });

    it('marks unverifiable settings as unchecked and verified=false', async () => {
      const msp = createMockMSPClient(makePIDConfig(), makeFilterConfig());
      const applied: AppliedChange[] = [
        { setting: 'unknown_pid_setting', previousValue: 10, newValue: 20 },
      ];

      const result = await verifyAppliedConfig(msp, 'pid', applied);

      expect(result.verified).toBe(false);
      expect(result.unchecked).toContain('unknown_pid_setting');
      expect(result.mismatches).toHaveLength(0);
    });
  });

  describe('Filter mode', () => {
    it('skips CLI-only filter settings during verification (rpm_filter_q)', async () => {
      const msp = createMockMSPClient(makePIDConfig(), makeFilterConfig());
      const applied: AppliedChange[] = [
        { setting: 'rpm_filter_q', previousValue: 500, newValue: 600 },
      ];

      const result = await verifyAppliedConfig(msp, 'filter', undefined, applied);

      // CLI-only settings are silently skipped — they don't fail verification
      expect(result.verified).toBe(true);
      expect(result.unchecked).not.toContain('rpm_filter_q');
    });

    it('returns verified=true when all filter values match', async () => {
      const filterConfig = makeFilterConfig({ gyro_lpf1_static_hz: 200 });
      const msp = createMockMSPClient(makePIDConfig(), filterConfig);
      const applied: AppliedChange[] = [
        { setting: 'gyro_lpf1_static_hz', previousValue: 250, newValue: 200 },
      ];

      const result = await verifyAppliedConfig(msp, 'filter', undefined, applied);

      expect(result.verified).toBe(true);
    });

    it('detects filter mismatch', async () => {
      const filterConfig = makeFilterConfig({ gyro_lpf1_static_hz: 300 }); // Wrong
      const msp = createMockMSPClient(makePIDConfig(), filterConfig);
      const applied: AppliedChange[] = [
        { setting: 'gyro_lpf1_static_hz', previousValue: 250, newValue: 200 },
      ];

      const result = await verifyAppliedConfig(msp, 'filter', undefined, applied);

      expect(result.verified).toBe(false);
      expect(result.mismatches.some((m) => m.includes('gyro_lpf1_static_hz'))).toBe(true);
    });

    it('flags suspicious when gyro_lpf1_static_hz=0', async () => {
      const filterConfig = makeFilterConfig({ gyro_lpf1_static_hz: 0 });
      const msp = createMockMSPClient(makePIDConfig(), filterConfig);

      const result = await verifyAppliedConfig(msp, 'filter');

      expect(result.suspicious).toBe(true);
      expect(result.mismatches.some((m) => m.includes('gyro_lpf1_static_hz = 0'))).toBe(true);
    });

    it('does not check PID settings in filter mode', async () => {
      const msp = createMockMSPClient(makePIDConfig(), makeFilterConfig());

      await verifyAppliedConfig(msp, 'filter');

      expect(msp.getPIDConfiguration).not.toHaveBeenCalled();
    });

    it('does not retry filter mismatches (no MSP re-write for CLI settings)', async () => {
      const filterConfig = makeFilterConfig({ gyro_lpf1_static_hz: 300 });
      const msp = createMockMSPClient(makePIDConfig(), filterConfig);
      const applied: AppliedChange[] = [
        { setting: 'gyro_lpf1_static_hz', previousValue: 250, newValue: 200 },
      ];

      const result = await verifyAppliedConfig(msp, 'filter', undefined, applied);

      expect(result.retried).toBe(false);
      expect(msp.setPIDConfiguration).not.toHaveBeenCalled();
    });
  });

  describe('Flash mode (combined)', () => {
    it('checks both PID and filter settings', async () => {
      const msp = createMockMSPClient(makePIDConfig(), makeFilterConfig());

      await verifyAppliedConfig(msp, 'flash');

      expect(msp.getPIDConfiguration).toHaveBeenCalled();
      expect(msp.getFilterConfiguration).toHaveBeenCalled();
    });

    it('flags suspicious I=0 in flash mode', async () => {
      const config = makePIDConfig({ pid_pitch_i: 0 });
      const msp = createMockMSPClient(config, makeFilterConfig());

      const result = await verifyAppliedConfig(msp, 'flash');

      expect(result.suspicious).toBe(true);
    });

    it('flags suspicious gyro_lpf1=0 in flash mode', async () => {
      const filterConfig = makeFilterConfig({ gyro_lpf1_static_hz: 0 });
      const msp = createMockMSPClient(makePIDConfig(), filterConfig);

      const result = await verifyAppliedConfig(msp, 'flash');

      expect(result.suspicious).toBe(true);
    });

    it('records expected and actual values', async () => {
      const pidConfig = makePIDConfig({ pid_roll_p: 50 });
      const filterConfig = makeFilterConfig({ gyro_lpf1_static_hz: 200 });
      const msp = createMockMSPClient(pidConfig, filterConfig);

      const result = await verifyAppliedConfig(msp, 'flash');

      expect(result.expected.pid_roll_p).toBe(50);
      expect(result.actual.pid_roll_p).toBe(50);
      expect(result.expected.gyro_lpf1_static_hz).toBe(200);
      expect(result.actual.gyro_lpf1_static_hz).toBe(200);
    });
  });

  describe('Feedforward verification', () => {
    function makeFFConfig(overrides?: Partial<Record<string, number>>) {
      return {
        transition: 0,
        rollGain: 100,
        pitchGain: 105,
        yawGain: 100,
        boost: 15,
        smoothFactor: 25,
        jitterFactor: 7,
        maxRateLimit: 90,
        dMinGain: 37,
        itermRelax: 1,
        itermRelaxCutoff: 15,
        ...overrides,
      };
    }

    function createFFMockMSPClient(ffOverrides?: Partial<Record<string, number>>) {
      return {
        ...createMockMSPClient(makePIDConfig(), makeFilterConfig()),
        getFeedforwardConfiguration: vi.fn().mockResolvedValue(makeFFConfig(ffOverrides)),
      };
    }

    it('verifies matching MSP-readable FF changes (read-back matches)', async () => {
      const msp = createFFMockMSPClient({ boost: 10, smoothFactor: 40 });
      const applied: AppliedChange[] = [
        { setting: 'feedforward_boost', previousValue: 15, newValue: 10 },
        { setting: 'feedforward_smooth_factor', previousValue: 25, newValue: 40 },
      ];

      const result = await verifyAppliedConfig(msp, 'pid', undefined, undefined, applied);

      expect(msp.getFeedforwardConfiguration).toHaveBeenCalled();
      expect(result.verified).toBe(true);
      expect(result.mismatches).toHaveLength(0);
      expect(result.expected.feedforward_boost).toBe(10);
      expect(result.actual.feedforward_boost).toBe(10);
    });

    it('reports mismatch when FF read-back differs from applied value', async () => {
      const msp = createFFMockMSPClient({ boost: 15 }); // Apply said 10, FC says 15
      const applied: AppliedChange[] = [
        { setting: 'feedforward_boost', previousValue: 15, newValue: 10 },
      ];

      const result = await verifyAppliedConfig(msp, 'pid', undefined, undefined, applied);

      expect(result.verified).toBe(false);
      expect(result.mismatches.some((m) => m.includes('feedforward_boost'))).toBe(true);
      expect(result.expected.feedforward_boost).toBe(10);
      expect(result.actual.feedforward_boost).toBe(15);
    });

    it('verifies d_min_gain and iterm_relax_cutoff via FF read-back', async () => {
      const msp = createFFMockMSPClient({ dMinGain: 40, itermRelaxCutoff: 12 });
      const applied: AppliedChange[] = [
        { setting: 'd_min_gain', previousValue: 37, newValue: 40 },
        { setting: 'iterm_relax_cutoff', previousValue: 15, newValue: 12 },
      ];

      const result = await verifyAppliedConfig(msp, 'pid', undefined, undefined, applied);

      expect(result.verified).toBe(true);
      expect(result.actual.d_min_gain).toBe(40);
      expect(result.actual.iterm_relax_cutoff).toBe(12);
    });

    it('verifies advanced settings via the extended MSP_PID_ADVANCED read-back', async () => {
      const msp = createFFMockMSPClient({
        tpaRate: 55,
        antiGravityGain: 110,
        averaging: 2,
        thrustLinear: 25,
        vbatSagCompensation: 75,
        dynIdleMinRpm: 30,
      });
      const applied: AppliedChange[] = [
        { setting: 'tpa_rate', previousValue: 65, newValue: 55 },
        { setting: 'anti_gravity_gain', previousValue: 80, newValue: 110 },
        { setting: 'feedforward_averaging', previousValue: 0, newValue: 2 },
        { setting: 'thrust_linear', previousValue: 0, newValue: 25 },
        { setting: 'vbat_sag_compensation', previousValue: 0, newValue: 75 },
        { setting: 'dyn_idle_min_rpm', previousValue: 0, newValue: 30 },
        { setting: 'simplified_dmax_gain', previousValue: 37, newValue: 0 }, // genuinely CLI-only
      ];

      const result = await verifyAppliedConfig(msp, 'pid', undefined, undefined, applied);

      expect(result.verified).toBe(true);
      expect(result.mismatches).toHaveLength(0);
      expect(result.actual.tpa_rate).toBe(55);
      expect(result.actual.anti_gravity_gain).toBe(110);
      expect(result.unchecked).not.toContain('tpa_rate');
      expect(result.unchecked).not.toContain('simplified_dmax_gain');
    });

    it('reports mismatch when an advanced setting read-back differs', async () => {
      const msp = createFFMockMSPClient({ tpaRate: 65 }); // Apply said 55, FC says 65
      const applied: AppliedChange[] = [{ setting: 'tpa_rate', previousValue: 65, newValue: 55 }];

      const result = await verifyAppliedConfig(msp, 'pid', undefined, undefined, applied);

      expect(result.verified).toBe(false);
      expect(result.mismatches.some((m) => m.includes('tpa_rate'))).toBe(true);
    });

    it('silently skips advanced settings on old firmware (short MSP layout)', async () => {
      // Mock reports no tpaRate/antiGravityGain — API < 1.45 response.
      // These must NOT fail verification (would fire false-positive auto
      // diagnostic reports on every apply on BF 4.3/4.4).
      const msp = createFFMockMSPClient();
      const applied: AppliedChange[] = [
        { setting: 'tpa_rate', previousValue: 65, newValue: 55 },
        { setting: 'anti_gravity_gain', previousValue: 80, newValue: 110 },
      ];

      const result = await verifyAppliedConfig(msp, 'pid', undefined, undefined, applied);

      expect(result.verified).toBe(true);
      expect(result.unchecked).not.toContain('tpa_rate');
      expect(result.unchecked).not.toContain('anti_gravity_gain');
      expect(result.mismatches).toHaveLength(0);
    });

    it('marks unknown FF settings as unchecked (verified=false)', async () => {
      const msp = createFFMockMSPClient();
      const applied: AppliedChange[] = [
        { setting: 'some_future_ff_setting', previousValue: 1, newValue: 2 },
      ];

      const result = await verifyAppliedConfig(msp, 'pid', undefined, undefined, applied);

      expect(result.verified).toBe(false);
      expect(result.unchecked).toContain('some_future_ff_setting');
      expect(result.mismatches).toHaveLength(0);
    });

    it('does not crash when getFeedforwardConfiguration is not implemented', async () => {
      // Legacy/mock MSP clients may not expose the optional FF read-back
      const msp = createMockMSPClient(makePIDConfig(), makeFilterConfig());
      const applied: AppliedChange[] = [
        { setting: 'feedforward_boost', previousValue: 15, newValue: 10 },
      ];

      const result = await verifyAppliedConfig(msp, 'pid', undefined, undefined, applied);

      // FF block is skipped entirely — no crash, no FF mismatches recorded
      expect(result.verified).toBe(true);
      expect(result.mismatches).toHaveLength(0);
    });

    it('does not call getFeedforwardConfiguration when no FF changes were applied', async () => {
      const msp = createFFMockMSPClient();

      const result = await verifyAppliedConfig(msp, 'pid', undefined, undefined, []);

      expect(msp.getFeedforwardConfiguration).not.toHaveBeenCalled();
      expect(result.verified).toBe(true);
    });
  });
});
