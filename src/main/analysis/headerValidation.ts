/**
 * BBL header validation for analysis quality warnings.
 *
 * Checks logging rate and debug mode from the parsed BBL header
 * and generates warnings when the configuration is suboptimal.
 *
 * Version-aware: BF 2025.12+ removed DEBUG_GYRO_SCALED (index 6) because
 * unfiltered gyro is logged by default. The debug mode check is skipped
 * for firmware versions that don't need it.
 */

import type { BBLLogHeader } from '@shared/types/blackbox.types';
import type { AnalysisWarning, CurrentFilterSettings } from '@shared/types/analysis.types';

/** Minimum recommended logging rate in Hz for meaningful FFT */
const MIN_LOGGING_RATE_HZ = 2000;

/** Debug mode value for GYRO_SCALED (unfiltered gyro for noise analysis) — BF 4.3–4.5 only */
const GYRO_SCALED_DEBUG_MODE = 6;

/**
 * Parse firmware version string (e.g. "4.5.1") into comparable numbers.
 * Returns [major, minor, patch] or null if unparseable.
 */
function parseFirmwareVersion(version: string): [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

/**
 * Check if firmware version is BF 2025.12+ (CalVer) where DEBUG_GYRO_SCALED was removed.
 * BF 2025.12 has version "4.6.0" in MSP_FC_VERSION (internal version kept incrementing).
 * In practice, any version >= 4.6.0 means 2025.12+.
 */
function isGyroScaledRemoved(firmwareVersion: string): boolean {
  const parsed = parseFirmwareVersion(firmwareVersion);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return major > 4 || (major === 4 && minor >= 6);
}

/**
 * Validate BBL header and return warnings about data quality.
 *
 * @param header - Parsed BBL log header
 * @returns Array of warnings (empty if all looks good)
 */
export function validateBBLHeader(header: BBLLogHeader): AnalysisWarning[] {
  const warnings: AnalysisWarning[] = [];

  // Check logging rate — the EFFECTIVE blackbox log rate, not the gyro rate.
  // looptime is the gyro loop period (µs); the log rate is further divided by
  // pid_process_denom and the blackbox P interval, exactly as BlackboxParser
  // computes its sampleRateHz. Using the bare gyro rate here overestimated the
  // rate by pDenom·pInterval (8× on typical 8k/2/4 configs) and the warning
  // never fired on genuinely undersampled 1 kHz logs.
  if (header.looptime > 0) {
    const pDiv = Math.max(1, header.pInterval || 1) * Math.max(1, header.pDenom || 1);
    const loggingRateHz = 1_000_000 / (header.looptime * pDiv);
    if (loggingRateHz < MIN_LOGGING_RATE_HZ) {
      const nyquist = Math.round(loggingRateHz / 2);
      warnings.push({
        code: 'low_logging_rate',
        message:
          `Logging rate is ${Math.round(loggingRateHz)} Hz (Nyquist: ${nyquist} Hz). ` +
          `Motor noise (200–600 Hz) may not be visible. Recommended: 2 kHz or higher.`,
        severity: 'warning',
      });
    }
  }

  // Check debug mode — only for BF 4.3–4.5.x
  // BF 2025.12+ (4.6+) logs unfiltered gyro by default, DEBUG_GYRO_SCALED was removed
  const firmwareVersion = header.firmwareRevision || '';
  if (!isGyroScaledRemoved(firmwareVersion)) {
    const debugModeStr = header.rawHeaders.get('debug_mode');
    if (debugModeStr !== undefined) {
      const debugMode = parseInt(debugModeStr, 10);
      if (!isNaN(debugMode) && debugMode !== GYRO_SCALED_DEBUG_MODE) {
        warnings.push({
          code: 'wrong_debug_mode',
          message:
            `Debug mode is not GYRO_SCALED (current: ${debugModeStr}). ` +
            `FFT may analyze filtered gyro data instead of raw noise. ` +
            `Set debug_mode = GYRO_SCALED in Betaflight for best filter analysis results.`,
          severity: 'warning',
        });
      }
    }
  }

  return warnings;
}

/**
 * Enrich CurrentFilterSettings with data from BBL raw headers.
 *
 * Used as a fallback when the FC is not connected or the MSP response
 * doesn't include all fields. BBL headers may contain `rpm_filter_harmonics`,
 * `dyn_notch_count`, `dyn_notch_q`, etc.
 *
 * Only overwrites fields that are currently undefined in the settings.
 *
 * @param settings - Current filter settings (may lack some fields)
 * @param rawHeaders - BBL raw header key-value pairs
 * @returns Enriched settings if any field was filled, null otherwise
 */
export function enrichSettingsFromBBLHeaders(
  settings: CurrentFilterSettings,
  rawHeaders: Map<string, string>
): CurrentFilterSettings | null {
  const enriched: CurrentFilterSettings = { ...settings };
  let changed = false;

  // Static cutoffs + dynamic notch range: the BBL header is the PRIMARY source
  // (flight-time config) and always wins when present. Without this, a
  // disconnected-FC analysis silently ran against DEFAULT_FILTER_SETTINGS
  // (e.g. gyro LPF1 250 Hz) instead of the flight's real values (e.g. 500 Hz),
  // because the defaults pre-populate these fields and the undefined-guard
  // below never fired for them.
  const bblPrimaryFields = [
    'gyro_lpf1_static_hz',
    'gyro_lpf2_static_hz',
    'dterm_lpf1_static_hz',
    'dterm_lpf2_static_hz',
    'dyn_notch_min_hz',
    'dyn_notch_max_hz',
  ] as const;
  for (const field of bblPrimaryFields) {
    const raw = rawHeaders.get(field);
    if (raw !== undefined) {
      const value = parseInt(raw, 10);
      if (!isNaN(value) && (enriched as any)[field] !== value) {
        (enriched as any)[field] = value;
        changed = true;
      }
    }
  }

  if (enriched.rpm_filter_harmonics === undefined) {
    const harmonicsStr = rawHeaders.get('rpm_filter_harmonics');
    if (harmonicsStr !== undefined) {
      const harmonics = parseInt(harmonicsStr, 10);
      if (!isNaN(harmonics)) {
        enriched.rpm_filter_harmonics = harmonics;
        changed = true;
      }
    }
  }

  if (enriched.rpm_filter_min_hz === undefined) {
    const minHzStr = rawHeaders.get('rpm_filter_min_hz');
    if (minHzStr !== undefined) {
      const minHz = parseInt(minHzStr, 10);
      if (!isNaN(minHz)) {
        enriched.rpm_filter_min_hz = minHz;
        changed = true;
      }
    }
  }

  if (enriched.dyn_notch_count === undefined) {
    const dynCountStr = rawHeaders.get('dyn_notch_count');
    if (dynCountStr !== undefined) {
      const dynCount = parseInt(dynCountStr, 10);
      if (!isNaN(dynCount)) {
        enriched.dyn_notch_count = dynCount;
        changed = true;
      }
    }
  }

  if (enriched.dyn_notch_q === undefined) {
    const dynQStr = rawHeaders.get('dyn_notch_q');
    if (dynQStr !== undefined) {
      const dynQ = parseInt(dynQStr, 10);
      if (!isNaN(dynQ)) {
        enriched.dyn_notch_q = dynQ;
        changed = true;
      }
    }
  }

  if (enriched.rpm_filter_q === undefined) {
    const rpmQStr = rawHeaders.get('rpm_filter_q');
    if (rpmQStr !== undefined) {
      const rpmQ = parseInt(rpmQStr, 10);
      if (!isNaN(rpmQ)) {
        enriched.rpm_filter_q = rpmQ;
        changed = true;
      }
    }
  }

  if (enriched.rpm_filter_fade_range_hz === undefined) {
    const fadeStr = rawHeaders.get('rpm_filter_fade_range_hz');
    if (fadeStr !== undefined) {
      const fade = parseInt(fadeStr, 10);
      if (!isNaN(fade)) {
        enriched.rpm_filter_fade_range_hz = fade;
        changed = true;
      }
    }
  }

  if (enriched.rpm_filter_weights === undefined) {
    const weightsStr = rawHeaders.get('rpm_filter_weights');
    if (weightsStr !== undefined) {
      const weights = weightsStr.split(',').map((w) => parseInt(w.trim(), 10));
      if (weights.length > 0 && weights.every((w) => !isNaN(w))) {
        enriched.rpm_filter_weights = weights;
        changed = true;
      }
    }
  }

  if (enriched.dyn_idle_min_rpm === undefined) {
    const dynIdleStr = rawHeaders.get('dyn_idle_min_rpm');
    if (dynIdleStr !== undefined) {
      const dynIdle = parseInt(dynIdleStr, 10);
      if (!isNaN(dynIdle)) {
        enriched.dyn_idle_min_rpm = dynIdle;
        changed = true;
      }
    }
  }

  if (enriched.gyro_lpf1_dyn_expo === undefined) {
    const gyroExpoStr = rawHeaders.get('gyro_lpf1_dyn_expo');
    if (gyroExpoStr !== undefined) {
      const gyroExpo = parseInt(gyroExpoStr, 10);
      if (!isNaN(gyroExpo)) {
        enriched.gyro_lpf1_dyn_expo = gyroExpo;
        changed = true;
      }
    }
  }

  if (enriched.dterm_lpf1_dyn_expo === undefined) {
    const expoStr = rawHeaders.get('dterm_lpf1_dyn_expo');
    if (expoStr !== undefined) {
      const expo = parseInt(expoStr, 10);
      if (!isNaN(expo)) {
        enriched.dterm_lpf1_dyn_expo = expo;
        changed = true;
      }
    }
  }

  if (enriched.dterm_lpf1_dyn_min_hz === undefined) {
    const dynMinStr = rawHeaders.get('dterm_lpf1_dyn_min_hz');
    if (dynMinStr !== undefined) {
      const dynMin = parseInt(dynMinStr, 10);
      if (!isNaN(dynMin)) {
        enriched.dterm_lpf1_dyn_min_hz = dynMin;
        changed = true;
      }
    }
  }

  // BF BBL writes dynamic lowpass as CSV: "gyro_lpf1_dyn_hz:250,500" (min,max)
  // and "dterm_lpf1_dyn_hz:75,150" (min,max)
  // BF BBL writes dynamic lowpass as CSV: "gyro_lpf1_dyn_hz:250,500" (min,max)
  // and "dterm_lpf1_dyn_hz:75,150" (min,max).
  // Enrich when value is missing (undefined) OR at default (0 = dynamic off).
  // MSP reads the real values; BBL enrichment is the fallback when FC is disconnected.
  const needsGyroDyn =
    enriched.gyro_lpf1_dyn_min_hz === undefined ||
    enriched.gyro_lpf1_dyn_min_hz === 0 ||
    enriched.gyro_lpf1_dyn_max_hz === undefined ||
    enriched.gyro_lpf1_dyn_max_hz === 0;
  if (needsGyroDyn) {
    const csv = rawHeaders.get('gyro_lpf1_dyn_hz');
    if (csv) {
      const parts = csv.split(',').map((s) => parseInt(s.trim(), 10));
      if (parts.length >= 2 && parts.every((n) => !isNaN(n))) {
        enriched.gyro_lpf1_dyn_min_hz = parts[0];
        enriched.gyro_lpf1_dyn_max_hz = parts[1];
        changed = true;
      }
    }
    // Fallback: individual headers (demo data / older formats)
    if (enriched.gyro_lpf1_dyn_min_hz === undefined || enriched.gyro_lpf1_dyn_min_hz === 0) {
      const val = rawHeaders.get('gyro_lowpass_dyn_min_hz');
      if (val !== undefined) {
        const n = parseInt(val, 10);
        if (!isNaN(n)) {
          enriched.gyro_lpf1_dyn_min_hz = n;
          changed = true;
        }
      }
    }
    if (enriched.gyro_lpf1_dyn_max_hz === undefined || enriched.gyro_lpf1_dyn_max_hz === 0) {
      const val = rawHeaders.get('gyro_lowpass_dyn_max_hz');
      if (val !== undefined) {
        const n = parseInt(val, 10);
        if (!isNaN(n)) {
          enriched.gyro_lpf1_dyn_max_hz = n;
          changed = true;
        }
      }
    }
  }

  const needsDtermDyn =
    enriched.dterm_lpf1_dyn_min_hz === undefined ||
    enriched.dterm_lpf1_dyn_min_hz === 0 ||
    enriched.dterm_lpf1_dyn_max_hz === undefined ||
    enriched.dterm_lpf1_dyn_max_hz === 0;
  if (needsDtermDyn) {
    const csv = rawHeaders.get('dterm_lpf1_dyn_hz');
    if (csv) {
      const parts = csv.split(',').map((s) => parseInt(s.trim(), 10));
      if (parts.length >= 2 && parts.every((n) => !isNaN(n))) {
        enriched.dterm_lpf1_dyn_min_hz = parts[0];
        enriched.dterm_lpf1_dyn_max_hz = parts[1];
        changed = true;
      }
    }
    if (enriched.dterm_lpf1_dyn_min_hz === undefined || enriched.dterm_lpf1_dyn_min_hz === 0) {
      const val = rawHeaders.get('dterm_lpf1_dyn_min_hz');
      if (val !== undefined) {
        const n = parseInt(val, 10);
        if (!isNaN(n)) {
          enriched.dterm_lpf1_dyn_min_hz = n;
          changed = true;
        }
      }
    }
    if (enriched.dterm_lpf1_dyn_max_hz === undefined || enriched.dterm_lpf1_dyn_max_hz === 0) {
      const val = rawHeaders.get('dterm_lpf1_dyn_max_hz');
      if (val !== undefined) {
        const n = parseInt(val, 10);
        if (!isNaN(n)) {
          enriched.dterm_lpf1_dyn_max_hz = n;
          changed = true;
        }
      }
    }
  }

  return changed ? enriched : null;
}
