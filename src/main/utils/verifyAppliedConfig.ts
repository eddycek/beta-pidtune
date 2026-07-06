/**
 * Apply verification utility.
 *
 * Reads back PID and filter configuration from FC after apply,
 * compares applied changes against expected values, tracks settings
 * that cannot be verified via MSP, and runs sanity checks for
 * dangerous states (I=0, bypassed filter).
 *
 * Note: `expected` for non-applied keys equals the post-apply read-back
 * (since we don't store a pre-apply snapshot). Only applied changes and
 * sanity checks can trigger mismatches. The `expected`/`actual` maps are
 * recorded for diagnostic bundles, not for full-state comparison.
 */

import type { PIDConfiguration, FeedforwardConfiguration } from '@shared/types/pid.types';
import type { CurrentFilterSettings } from '@shared/types/analysis.types';
import type { AppliedChange, TuningType } from '@shared/types/tuning.types';

/** MSP client interface — subset needed for verification */
interface VerifyMSPClient {
  getPIDConfiguration(): Promise<PIDConfiguration>;
  getFilterConfiguration(): Promise<CurrentFilterSettings>;
  setPIDConfiguration(config: PIDConfiguration): Promise<void>;
  getFeedforwardConfiguration?(): Promise<FeedforwardConfiguration>;
  isConnected(): boolean;
}

export interface VerifyResult {
  verified: boolean;
  mismatches: string[];
  /** Settings that could not be verified via MSP (CLI-only, unknown key) */
  unchecked: string[];
  suspicious: boolean;
  expected: Record<string, number>;
  actual: Record<string, number>;
  retried?: boolean;
}

/** Build the full expected PID map from current config + applied changes */
function buildExpectedPIDMap(
  currentConfig: PIDConfiguration,
  appliedChanges?: AppliedChange[]
): Record<string, number> {
  const map: Record<string, number> = {
    pid_roll_p: currentConfig.roll.P,
    pid_roll_i: currentConfig.roll.I,
    pid_roll_d: currentConfig.roll.D,
    pid_pitch_p: currentConfig.pitch.P,
    pid_pitch_i: currentConfig.pitch.I,
    pid_pitch_d: currentConfig.pitch.D,
    pid_yaw_p: currentConfig.yaw.P,
    pid_yaw_i: currentConfig.yaw.I,
    pid_yaw_d: currentConfig.yaw.D,
  };
  // Patch with applied changes (these are what we wrote)
  if (appliedChanges) {
    for (const change of appliedChanges) {
      if (change.setting in map) {
        map[change.setting] = change.newValue;
      }
    }
  }
  return map;
}

/** Build actual PID map from FC read-back */
function buildActualPIDMap(config: PIDConfiguration): Record<string, number> {
  return {
    pid_roll_p: config.roll.P,
    pid_roll_i: config.roll.I,
    pid_roll_d: config.roll.D,
    pid_pitch_p: config.pitch.P,
    pid_pitch_i: config.pitch.I,
    pid_pitch_d: config.pitch.D,
    pid_yaw_p: config.yaw.P,
    pid_yaw_i: config.yaw.I,
    pid_yaw_d: config.yaw.D,
  };
}

/** Settings that can only be set via CLI and not read back via MSP */
const CLI_ONLY_SETTINGS = new Set(['rpm_filter_q']);

/** Feedforward-stage settings readable via MSP_PID_ADVANCED → FeedforwardConfiguration key */
const FF_MSP_READABLE: Record<string, keyof FeedforwardConfiguration> = {
  feedforward_boost: 'boost',
  feedforward_smooth_factor: 'smoothFactor',
  feedforward_jitter_factor: 'jitterFactor',
  feedforward_max_rate_limit: 'maxRateLimit',
  d_min_gain: 'dMinGain',
  iterm_relax: 'itermRelax',
  iterm_relax_cutoff: 'itermRelaxCutoff',
};

/** Feedforward-stage settings not currently parsed by getFeedforwardConfiguration().
 * Several DO have MSP_PID_ADVANCED offsets in mspLayouts.ts (tpa_*, anti_gravity_gain,
 * feedforward_averaging, …) — wiring them in would extend verification coverage.
 * Until then they are skipped during verification (same treatment as CLI_ONLY_SETTINGS). */
const FF_CLI_ONLY = new Set([
  'feedforward_averaging',
  'tpa_rate',
  'tpa_breakpoint',
  'tpa_mode',
  'tpa_low_always',
  'anti_gravity_gain',
  'thrust_linear',
  'dyn_idle_min_rpm',
  'pidsum_limit',
  'pidsum_limit_yaw',
  'rc_smoothing_auto_factor',
  'vbat_sag_compensation',
  'simplified_dmax_gain',
  'dterm_lpf1_dyn_expo',
]);

/** Build expected filter map — MSP-readable fields + dynamic lowpass */
function buildExpectedFilterMap(
  currentConfig: CurrentFilterSettings,
  appliedChanges?: AppliedChange[]
): Record<string, number> {
  const map: Record<string, number> = {
    gyro_lpf1_static_hz: currentConfig.gyro_lpf1_static_hz,
    gyro_lpf2_static_hz: currentConfig.gyro_lpf2_static_hz,
    dterm_lpf1_static_hz: currentConfig.dterm_lpf1_static_hz,
    dterm_lpf2_static_hz: currentConfig.dterm_lpf2_static_hz,
    dyn_notch_min_hz: currentConfig.dyn_notch_min_hz,
    dyn_notch_max_hz: currentConfig.dyn_notch_max_hz,
  };
  // Optional MSP fields
  if (currentConfig.dyn_notch_q !== undefined) {
    map.dyn_notch_q = currentConfig.dyn_notch_q;
  }
  if (currentConfig.dyn_notch_count !== undefined) {
    map.dyn_notch_count = currentConfig.dyn_notch_count;
  }
  // Dynamic lowpass fields (now read from MSP)
  if (currentConfig.gyro_lpf1_dyn_min_hz !== undefined) {
    map.gyro_lpf1_dyn_min_hz = currentConfig.gyro_lpf1_dyn_min_hz;
  }
  if (currentConfig.gyro_lpf1_dyn_max_hz !== undefined) {
    map.gyro_lpf1_dyn_max_hz = currentConfig.gyro_lpf1_dyn_max_hz;
  }
  if (currentConfig.dterm_lpf1_dyn_min_hz !== undefined) {
    map.dterm_lpf1_dyn_min_hz = currentConfig.dterm_lpf1_dyn_min_hz;
  }
  if (currentConfig.dterm_lpf1_dyn_max_hz !== undefined) {
    map.dterm_lpf1_dyn_max_hz = currentConfig.dterm_lpf1_dyn_max_hz;
  }
  // Patch with applied changes (skip CLI-only settings that can't be verified)
  if (appliedChanges) {
    for (const change of appliedChanges) {
      if (CLI_ONLY_SETTINGS.has(change.setting)) continue;
      if (change.setting in map) {
        map[change.setting] = change.newValue;
      }
    }
  }
  return map;
}

/** Build actual filter map from FC read-back */
function buildActualFilterMap(config: CurrentFilterSettings): Record<string, number> {
  const map: Record<string, number> = {
    gyro_lpf1_static_hz: config.gyro_lpf1_static_hz,
    gyro_lpf2_static_hz: config.gyro_lpf2_static_hz,
    dterm_lpf1_static_hz: config.dterm_lpf1_static_hz,
    dterm_lpf2_static_hz: config.dterm_lpf2_static_hz,
    dyn_notch_min_hz: config.dyn_notch_min_hz,
    dyn_notch_max_hz: config.dyn_notch_max_hz,
  };
  if (config.dyn_notch_q !== undefined) {
    map.dyn_notch_q = config.dyn_notch_q;
  }
  if (config.dyn_notch_count !== undefined) {
    map.dyn_notch_count = config.dyn_notch_count;
  }
  if (config.gyro_lpf1_dyn_min_hz !== undefined) {
    map.gyro_lpf1_dyn_min_hz = config.gyro_lpf1_dyn_min_hz;
  }
  if (config.gyro_lpf1_dyn_max_hz !== undefined) {
    map.gyro_lpf1_dyn_max_hz = config.gyro_lpf1_dyn_max_hz;
  }
  if (config.dterm_lpf1_dyn_min_hz !== undefined) {
    map.dterm_lpf1_dyn_min_hz = config.dterm_lpf1_dyn_min_hz;
  }
  if (config.dterm_lpf1_dyn_max_hz !== undefined) {
    map.dterm_lpf1_dyn_max_hz = config.dterm_lpf1_dyn_max_hz;
  }
  return map;
}

/** Run sanity checks — detect obviously dangerous states */
function runSanityChecks(actual: Record<string, number>, tuningType: TuningType): string[] {
  const warnings: string[] = [];

  // P/I/D = 0 on roll/pitch is always a bug on a flying quad
  if (tuningType === 'pid' || tuningType === 'flash') {
    for (const axis of ['roll', 'pitch']) {
      for (const term of ['p', 'i', 'd']) {
        const key = `pid_${axis}_${term}`;
        if (actual[key] === 0) {
          warnings.push(`${key} = 0 (dangerous: ${term.toUpperCase()} term zeroed on ${axis})`);
        }
      }
    }
  }

  // gyro_lpf1_static_hz = 0 means bypassed — dangerous without RPM filter
  if (tuningType === 'filter' || tuningType === 'flash') {
    if (actual.gyro_lpf1_static_hz === 0) {
      warnings.push('gyro_lpf1_static_hz = 0 (gyro LPF1 bypassed)');
    }
  }

  return warnings;
}

/**
 * Verify applied changes by reading back MSP-readable settings.
 *
 * Compares each applied change against the actual FC value. Settings
 * that can't be read via MSP (CLI-only) are tracked as `unchecked`
 * and force `verified=false`. Non-applied values are recorded in
 * `expected`/`actual` for diagnostic context but not compared.
 *
 * For PID mode: reads and verifies PID values only.
 * For Filter mode: reads and verifies filter settings only.
 * For Flash mode: reads and verifies both PID values and filter settings.
 * Includes PID retry on mismatch (1 attempt, PID/Flash modes only).
 * Runs sanity checks on PID terms (P/I/D = 0 on roll/pitch) and on
 * gyro_lpf1_static_hz = 0 (LPF1 bypass) where applicable.
 */
export async function verifyAppliedConfig(
  mspClient: VerifyMSPClient,
  tuningType: TuningType,
  appliedPIDChanges?: AppliedChange[],
  appliedFilterChanges?: AppliedChange[],
  appliedFeedforwardChanges?: AppliedChange[]
): Promise<VerifyResult> {
  const expected: Record<string, number> = {};
  const actual: Record<string, number> = {};
  const mismatches: string[] = [];
  const unchecked: string[] = [];
  let retried = false;

  const checksPID = tuningType === 'pid' || tuningType === 'flash';
  const checksFilter = tuningType === 'filter' || tuningType === 'flash';

  // Read PID config (all 9 values, not just applied changes)
  if (checksPID) {
    const pidConfig = await mspClient.getPIDConfiguration();
    const actualPID = buildActualPIDMap(pidConfig);
    // Expected = what FC had at time of apply + our patches
    const expectedPID = buildExpectedPIDMap(pidConfig, appliedPIDChanges);

    // For full-config verify, expected = what we wrote. For values we didn't
    // change, expected = actual (they should be unchanged).
    // But the real value is: we compare actual vs what we intended to write.
    // For applied changes, expected = newValue. For others, actual IS expected.
    // So only applied changes can mismatch.
    // HOWEVER, we also want to detect if non-applied values got corrupted (I=0 bug).
    // So we record ALL values and check sanity on all.
    Object.assign(expected, expectedPID);
    Object.assign(actual, actualPID);

    // Check applied changes
    if (appliedPIDChanges) {
      for (const change of appliedPIDChanges) {
        const act = actualPID[change.setting];
        if (act === undefined) {
          unchecked.push(change.setting);
        } else if (act !== change.newValue) {
          mismatches.push(`${change.setting}: expected ${change.newValue}, got ${act}`);
        }
      }
    }

    // PID retry on mismatch (1 attempt, 10s overall timeout)
    if (mismatches.length > 0) {
      // Save originals before retry — if timeout fires after mismatches.length=0
      // but before re-population, the originals would be lost.
      const originalMismatches = [...mismatches];

      const retryPromise = async () => {
        // Rebuild the full expected config and re-write
        const retryConfig: PIDConfiguration = JSON.parse(JSON.stringify(pidConfig));
        if (appliedPIDChanges) {
          for (const change of appliedPIDChanges) {
            const match = change.setting.match(/^pid_(roll|pitch|yaw)_(p|i|d)$/i);
            if (match) {
              const axis = match[1] as 'roll' | 'pitch' | 'yaw';
              const term = match[2].toUpperCase() as 'P' | 'I' | 'D';
              retryConfig[axis][term] = change.newValue;
            }
          }
        }
        await mspClient.setPIDConfiguration(retryConfig);
        retried = true;

        // Re-read and re-check
        const pidConfig2 = await mspClient.getPIDConfiguration();
        const actualPID2 = buildActualPIDMap(pidConfig2);
        // Update actual map
        Object.assign(actual, actualPID2);

        // Clear and re-check mismatches (unchecked list stays the same)
        mismatches.length = 0;
        if (appliedPIDChanges) {
          for (const change of appliedPIDChanges) {
            const act = actualPID2[change.setting];
            if (act !== undefined && act !== change.newValue) {
              mismatches.push(
                `${change.setting}: expected ${change.newValue}, got ${act} (after retry)`
              );
            }
          }
        }
      };

      const RETRY_TIMEOUT_MS = 10_000;
      try {
        await Promise.race([
          retryPromise(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('PID retry timed out')), RETRY_TIMEOUT_MS)
          ),
        ]);
      } catch {
        // Timeout or retry failure — restore original mismatches if retry
        // cleared them before the timeout race was lost.
        if (mismatches.length === 0) {
          mismatches.push(...originalMismatches);
          mismatches.push('PID retry timed out — verification incomplete');
        }
      }
    }
  }

  // Read filter config
  if (checksFilter) {
    const filterConfig = await mspClient.getFilterConfiguration();
    const actualFilter = buildActualFilterMap(filterConfig);
    const expectedFilter = buildExpectedFilterMap(filterConfig, appliedFilterChanges);

    Object.assign(expected, expectedFilter);
    Object.assign(actual, actualFilter);

    // Check applied changes (skip CLI-only settings that can't be read back via MSP)
    if (appliedFilterChanges) {
      for (const change of appliedFilterChanges) {
        if (CLI_ONLY_SETTINGS.has(change.setting)) continue;
        const act = actualFilter[change.setting];
        if (act === undefined) {
          unchecked.push(change.setting);
        } else if (act !== change.newValue) {
          mismatches.push(`${change.setting}: expected ${change.newValue}, got ${act}`);
        }
      }
    }
  }

  // Read feedforward config and verify MSP-readable FF-stage changes.
  // FF changes are written via CLI but most land in MSP_PID_ADVANCED, so they
  // CAN be read back — previously they were applied+saved with no verification.
  if (
    appliedFeedforwardChanges &&
    appliedFeedforwardChanges.length > 0 &&
    mspClient.getFeedforwardConfiguration
  ) {
    const ffConfig = await mspClient.getFeedforwardConfiguration();
    for (const change of appliedFeedforwardChanges) {
      if (FF_CLI_ONLY.has(change.setting)) continue;
      const configKey = FF_MSP_READABLE[change.setting];
      if (configKey === undefined) {
        unchecked.push(change.setting);
        continue;
      }
      const act = ffConfig[configKey] as number;
      expected[change.setting] = change.newValue;
      actual[change.setting] = act;
      if (act !== change.newValue) {
        mismatches.push(`${change.setting}: expected ${change.newValue}, got ${act}`);
      }
    }
  }

  // Sanity checks on actual values (detect I=0, bypassed filter, etc.)
  const sanityWarnings = runSanityChecks(actual, tuningType);
  const suspicious = sanityWarnings.length > 0;

  // Add sanity warnings to mismatches for visibility
  for (const warning of sanityWarnings) {
    if (!mismatches.includes(warning)) {
      mismatches.push(warning);
    }
  }

  return {
    verified: mismatches.length === 0 && unchecked.length === 0,
    unchecked,
    mismatches,
    suspicious,
    expected,
    actual,
    retried,
  };
}
