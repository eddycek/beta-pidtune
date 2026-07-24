/**
 * Betaflight version-capabilities layer (P2.5).
 *
 * Maps a firmware version string to feature availability and setting-name
 * differences, so recommenders can gate version-specific settings and the
 * apply/verify flow can translate renamed CLI settings.
 *
 * Version scheme: classic semver up to 4.5.x; calendar versions from 4.6
 * ("2025.12" is the 4.6 release). Calendar-versioned firmware is treated as
 * newer than every classic 4.x release.
 */

/** Parsed firmware version */
export interface BFVersion {
  major: number;
  minor: number;
  /** True for calendar-scheme versions (2025.12+, i.e. BF 4.6+) */
  calendar: boolean;
}

/** Feature availability for a firmware version */
export interface BFCapabilities {
  /** Low-throttle TPA (tpa_low_rate / tpa_low_breakpoint / tpa_low_always), BF 4.5+ */
  hasTpaLow: boolean;
  /** Dimmable per-harmonic RPM notch weights (rpm_filter_weights), BF 4.5+ */
  hasRpmWeights: boolean;
  /** anti_gravity_cutoff_hz / anti_gravity_p_gain, BF 4.5+ */
  hasAntiGravityCutoff: boolean;
  /** d_min → d_max rename (2025.12 / BF 4.6+): the PID D value became the
   * minimum, d_max_* the maximum; d_min_gain/advance → d_max_gain/advance */
  usesDMax: boolean;
  /** Chirp signal generator for transfer-function identification, BF 4.6+ */
  hasChirp: boolean;
}

/** Parse a Betaflight version string ("4.5.2", "2025.12.0"). Null if unparseable. */
export function parseBFVersion(version: string | undefined): BFVersion | null {
  if (!version) return null;
  const match = version.match(/(\d+)\.(\d+)/);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  if (isNaN(major) || isNaN(minor)) return null;
  return { major, minor, calendar: major >= 2000 };
}

/** True when the parsed version is at least the given classic major.minor.
 * Calendar versions (2025.12+) are newer than every classic 4.x release. */
function atLeast(v: BFVersion, major: number, minor: number): boolean {
  if (v.calendar) return true;
  return v.major > major || (v.major === major && v.minor >= minor);
}

/** Capabilities for a firmware version string. Unknown/unparseable versions
 * get the conservative BF 4.3 baseline (no 4.5+/4.6+ features). */
export function getBFCapabilities(version?: string): BFCapabilities {
  const v = parseBFVersion(version);
  if (!v) {
    return {
      hasTpaLow: false,
      hasRpmWeights: false,
      hasAntiGravityCutoff: false,
      usesDMax: false,
      hasChirp: false,
    };
  }
  return {
    hasTpaLow: atLeast(v, 4, 5),
    hasRpmWeights: atLeast(v, 4, 5),
    hasAntiGravityCutoff: atLeast(v, 4, 5),
    usesDMax: v.calendar,
    hasChirp: v.calendar,
  };
}

/** CLI setting renames applied by the d_min → d_max transition (BF 4.6+).
 * Name-level mapping only — the gain/advance semantics are unchanged. */
const D_MAX_RENAMES: Record<string, string> = {
  d_min_gain: 'd_max_gain',
  d_min_advance: 'd_max_advance',
  d_min_roll: 'd_max_roll',
  d_min_pitch: 'd_max_pitch',
  d_min_yaw: 'd_max_yaw',
};

/**
 * Translate a recommendation's CLI setting name for the target firmware.
 * Returns the name unchanged when no rename applies.
 */
export function translateSettingForVersion(setting: string, capabilities: BFCapabilities): string {
  if (capabilities.usesDMax && D_MAX_RENAMES[setting]) {
    return D_MAX_RENAMES[setting];
  }
  return setting;
}
