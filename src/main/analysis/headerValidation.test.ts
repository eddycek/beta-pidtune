import { describe, it, expect } from 'vitest';
import { validateBBLHeader, enrichSettingsFromBBLHeaders } from './headerValidation';
import type { BBLLogHeader } from '@shared/types/blackbox.types';
import { DEFAULT_FILTER_SETTINGS } from '@shared/types/analysis.types';
import {
  extractDMinContext,
  extractTPAContext,
  extractItermRelaxMode,
  extractFlightPIDs,
} from './PIDRecommender';

function createHeader(overrides: Partial<BBLLogHeader> = {}): BBLLogHeader {
  const defaults: BBLLogHeader = {
    product: 'Blackbox flight data recorder',
    dataVersion: 2,
    firmwareType: 'Betaflight',
    firmwareRevision: '4.4.0',
    firmwareDate: '',
    boardInformation: 'S405',
    logStartDatetime: '',
    craftName: 'Test',
    iFieldDefs: [],
    pFieldDefs: [],
    sFieldDefs: [],
    gFieldDefs: [],
    iInterval: 32,
    // pInterval/pDenom = 1 → effective log rate equals gyro rate (1e6/looptime).
    // Tests that exercise the pInterval·pDenom division set these explicitly.
    pInterval: 1,
    pDenom: 1,
    minthrottle: 1070,
    maxthrottle: 2000,
    motorOutputRange: 0,
    vbatref: 420,
    looptime: 500, // 2000 Hz
    gyroScale: 1,
    rawHeaders: new Map<string, string>(),
  };
  return { ...defaults, ...overrides };
}

describe('validateBBLHeader', () => {
  it('returns no warnings for good settings (2 kHz, GYRO_SCALED)', () => {
    const header = createHeader({ looptime: 500 }); // 2000 Hz
    header.rawHeaders.set('debug_mode', '6'); // GYRO_SCALED
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(0);
  });

  it('returns no warnings for 4 kHz logging rate', () => {
    const header = createHeader({ looptime: 250 }); // 4000 Hz
    header.rawHeaders.set('debug_mode', '6');
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(0);
  });

  it('warns about low logging rate (1 kHz)', () => {
    const header = createHeader({ looptime: 1000 }); // 1000 Hz
    header.rawHeaders.set('debug_mode', '6');
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('low_logging_rate');
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].message).toContain('1000 Hz');
    expect(warnings[0].message).toContain('500 Hz'); // Nyquist
  });

  it('warns about very low logging rate (500 Hz)', () => {
    const header = createHeader({ looptime: 2000 }); // 500 Hz
    header.rawHeaders.set('debug_mode', '6');
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('low_logging_rate');
    expect(warnings[0].message).toContain('250 Hz'); // Nyquist
  });

  it('warns about wrong debug mode (NONE)', () => {
    const header = createHeader({ looptime: 500 });
    header.rawHeaders.set('debug_mode', '0'); // NONE
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('wrong_debug_mode');
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].message).toContain('GYRO_SCALED');
  });

  it('warns about wrong debug mode (GYRO_FILTERED)', () => {
    const header = createHeader({ looptime: 500 });
    header.rawHeaders.set('debug_mode', '3'); // GYRO_FILTERED
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('wrong_debug_mode');
  });

  it('returns both warnings when both are bad', () => {
    const header = createHeader({ looptime: 2000 }); // 500 Hz
    header.rawHeaders.set('debug_mode', '0'); // NONE
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(2);
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain('low_logging_rate');
    expect(codes).toContain('wrong_debug_mode');
  });

  it('does not warn about debug mode when header has no debug_mode field', () => {
    const header = createHeader({ looptime: 500 });
    // rawHeaders has no debug_mode key
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(0);
  });

  it('handles looptime = 0 gracefully (no rate warning)', () => {
    const header = createHeader({ looptime: 0 });
    header.rawHeaders.set('debug_mode', '6');
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(0);
  });

  it('uses effective log rate (looptime × pInterval × pDenom), not bare gyro rate', () => {
    // 8 kHz gyro (looptime 125) but pDenom=2, pInterval=4 → 1e6/(125·4·2) = 1000 Hz log rate
    const header = createHeader({ looptime: 125, pInterval: 4, pDenom: 2 });
    header.rawHeaders.set('debug_mode', '6');
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('low_logging_rate');
    expect(warnings[0].message).toContain('1000 Hz');
    expect(warnings[0].message).toContain('500 Hz'); // Nyquist
  });

  it('does not warn when effective log rate meets 2 kHz despite division', () => {
    // 8 kHz gyro, pDenom=2, pInterval=2 → 1e6/(125·2·2) = 2000 Hz log rate
    const header = createHeader({ looptime: 125, pInterval: 2, pDenom: 2 });
    header.rawHeaders.set('debug_mode', '6');
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(0);
  });

  it('treats pInterval/pDenom of 0 as 1 (no division)', () => {
    const header = createHeader({ looptime: 500, pInterval: 0, pDenom: 0 }); // 2000 Hz
    header.rawHeaders.set('debug_mode', '6');
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(0);
  });

  // BF 2025.12+ (4.6+) version-aware tests
  it('skips debug mode check for BF 4.6+ (2025.12) where GYRO_SCALED was removed', () => {
    const header = createHeader({ firmwareRevision: '4.6.0', looptime: 500 });
    header.rawHeaders.set('debug_mode', '0'); // NONE — should be fine on 4.6+
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(0);
  });

  it('skips debug mode check for BF 4.6.1', () => {
    const header = createHeader({ firmwareRevision: '4.6.1', looptime: 500 });
    header.rawHeaders.set('debug_mode', '42'); // any value
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(0);
  });

  it('still warns about debug mode for BF 4.5.x', () => {
    const header = createHeader({ firmwareRevision: '4.5.1', looptime: 500 });
    header.rawHeaders.set('debug_mode', '0');
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('wrong_debug_mode');
  });

  it('still warns about debug mode for BF 4.4.0', () => {
    const header = createHeader({ firmwareRevision: '4.4.0', looptime: 500 });
    header.rawHeaders.set('debug_mode', '3');
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('wrong_debug_mode');
  });

  it('handles missing firmwareRevision gracefully (assumes pre-4.6)', () => {
    const header = createHeader({ firmwareRevision: '', looptime: 500 });
    header.rawHeaders.set('debug_mode', '0');
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('wrong_debug_mode');
  });

  it('parses BBL-format firmware revision with "Betaflight" prefix', () => {
    // BBL headers have: "Betaflight 4.6.0 (abc123) STM32F405" — not plain "4.6.0"
    const header = createHeader({
      firmwareRevision: 'Betaflight 4.6.0 (024f8e13d) STM32F405',
      looptime: 500,
    });
    header.rawHeaders.set('debug_mode', '0'); // Should be fine on 4.6+
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(0); // No debug_mode warning for 4.6+
  });

  it('parses BBL-format firmware revision for BF 4.5.2 (still warns)', () => {
    const header = createHeader({
      firmwareRevision: 'Betaflight 4.5.2 (024f8e13d) STM32F405',
      looptime: 500,
    });
    header.rawHeaders.set('debug_mode', '0');
    const warnings = validateBBLHeader(header);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('wrong_debug_mode');
  });
});

describe('enrichSettingsFromBBLHeaders', () => {
  it('enriches settings with RPM harmonics from BBL headers', () => {
    const headers = new Map<string, string>([
      ['rpm_filter_harmonics', '3'],
      ['rpm_filter_min_hz', '100'],
    ]);

    const result = enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, headers);
    expect(result).not.toBeNull();
    expect(result!.rpm_filter_harmonics).toBe(3);
    expect(result!.rpm_filter_min_hz).toBe(100);
  });

  it('enriches settings with dynamic notch count and Q', () => {
    const headers = new Map<string, string>([
      ['rpm_filter_harmonics', '3'],
      ['dyn_notch_count', '1'],
      ['dyn_notch_q', '500'],
    ]);

    const result = enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, headers);
    expect(result).not.toBeNull();
    expect(result!.dyn_notch_count).toBe(1);
    expect(result!.dyn_notch_q).toBe(500);
  });

  it('returns null when rpm_filter_harmonics not in headers', () => {
    const headers = new Map<string, string>([['dshot_bidir', '1']]);

    const result = enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, headers);
    expect(result).toBeNull();
  });

  it('returns null when rpm_filter_harmonics is not a number', () => {
    const headers = new Map<string, string>([['rpm_filter_harmonics', 'invalid']]);

    const result = enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, headers);
    expect(result).toBeNull();
  });

  it('preserves existing settings while adding RPM data', () => {
    const headers = new Map<string, string>([['rpm_filter_harmonics', '2']]);

    const settings = { ...DEFAULT_FILTER_SETTINGS, gyro_lpf1_static_hz: 100 };
    const result = enrichSettingsFromBBLHeaders(settings, headers);
    expect(result).not.toBeNull();
    expect(result!.gyro_lpf1_static_hz).toBe(100);
    expect(result!.rpm_filter_harmonics).toBe(2);
  });

  it('handles rpm_filter_harmonics = 0 (RPM disabled)', () => {
    const headers = new Map<string, string>([['rpm_filter_harmonics', '0']]);

    const result = enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, headers);
    expect(result).not.toBeNull();
    expect(result!.rpm_filter_harmonics).toBe(0);
  });

  it('enriches only dyn_notch_count when RPM is already set from MSP', () => {
    const headers = new Map<string, string>([['dyn_notch_count', '3']]);
    const settings = { ...DEFAULT_FILTER_SETTINGS, rpm_filter_harmonics: 3 };

    const result = enrichSettingsFromBBLHeaders(settings, headers);
    expect(result).not.toBeNull();
    expect(result!.rpm_filter_harmonics).toBe(3); // preserved
    expect(result!.dyn_notch_count).toBe(3);
  });

  it('does not overwrite existing dyn_notch_count from MSP', () => {
    const headers = new Map<string, string>([['dyn_notch_count', '5']]);
    const settings = { ...DEFAULT_FILTER_SETTINGS, rpm_filter_harmonics: 3, dyn_notch_count: 1 };

    const result = enrichSettingsFromBBLHeaders(settings, headers);
    // dyn_notch_count already defined → not overwritten → no change → null
    expect(result).toBeNull();
  });

  it('enriches dyn_notch_q from headers when missing from MSP', () => {
    const headers = new Map<string, string>([['dyn_notch_q', '400']]);
    const settings = { ...DEFAULT_FILTER_SETTINGS, rpm_filter_harmonics: 3, dyn_notch_count: 1 };

    const result = enrichSettingsFromBBLHeaders(settings, headers);
    expect(result).not.toBeNull();
    expect(result!.dyn_notch_q).toBe(400);
  });

  it('returns null when all fields already defined (nothing to enrich)', () => {
    const headers = new Map<string, string>([
      ['rpm_filter_harmonics', '99'],
      ['dyn_notch_count', '99'],
    ]);
    const settings = {
      ...DEFAULT_FILTER_SETTINGS,
      rpm_filter_harmonics: 3,
      rpm_filter_min_hz: 100,
      dyn_notch_count: 1,
      dyn_notch_q: 500,
    };

    const result = enrichSettingsFromBBLHeaders(settings, headers);
    expect(result).toBeNull(); // nothing to fill
  });

  it('should extract rpm_filter_q from headers', () => {
    const headers = new Map([['rpm_filter_q', '850']]);
    const result = enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, headers);
    expect(result).not.toBeNull();
    expect(result!.rpm_filter_q).toBe(850);
  });

  it('should extract dterm_lpf1_dyn_expo from headers', () => {
    const headers = new Map([['dterm_lpf1_dyn_expo', '7']]);
    const result = enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, headers);
    expect(result).not.toBeNull();
    expect(result!.dterm_lpf1_dyn_expo).toBe(7);
  });

  it('should not overwrite existing rpm_filter_q', () => {
    const headers = new Map([['rpm_filter_q', '999']]);
    const settings = { ...DEFAULT_FILTER_SETTINGS, rpm_filter_q: 500 };
    const result = enrichSettingsFromBBLHeaders(settings, headers);
    // rpm_filter_q already set → no change (other fields may still be enriched)
    if (result) {
      expect(result.rpm_filter_q).toBe(500);
    }
  });

  it('should not overwrite existing dterm_lpf1_dyn_expo', () => {
    const headers = new Map([['dterm_lpf1_dyn_expo', '10']]);
    const settings = { ...DEFAULT_FILTER_SETTINGS, dterm_lpf1_dyn_expo: 5 };
    const result = enrichSettingsFromBBLHeaders(settings, headers);
    if (result) {
      expect(result.dterm_lpf1_dyn_expo).toBe(5);
    }
  });

  it('should parse gyro dynamic lowpass CSV format (gyro_lpf1_dyn_hz:250,500)', () => {
    const headers = new Map([['gyro_lpf1_dyn_hz', '250,500']]);
    const result = enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, headers);
    expect(result).not.toBeNull();
    expect(result!.gyro_lpf1_dyn_min_hz).toBe(250);
    expect(result!.gyro_lpf1_dyn_max_hz).toBe(500);
  });

  it('should parse dterm dynamic lowpass CSV format (dterm_lpf1_dyn_hz:75,150)', () => {
    const headers = new Map([['dterm_lpf1_dyn_hz', '75,150']]);
    const result = enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, headers);
    expect(result).not.toBeNull();
    expect(result!.dterm_lpf1_dyn_min_hz).toBe(75);
    expect(result!.dterm_lpf1_dyn_max_hz).toBe(150);
  });

  // BBL headers are the PRIMARY source for static cutoffs + dyn notch range —
  // they always override values pre-populated from DEFAULT_FILTER_SETTINGS or MSP.
  describe('BBL-primary static cutoff overrides', () => {
    const staticHeaders = new Map([
      ['gyro_lpf1_static_hz', '500'],
      ['gyro_lpf2_static_hz', '500'],
      ['dterm_lpf1_static_hz', '75'],
      ['dterm_lpf2_static_hz', '150'],
      ['dyn_notch_min_hz', '100'],
      ['dyn_notch_max_hz', '600'],
    ]);

    it('overrides default static LPF cutoffs with BBL header values', () => {
      // Defaults: gyro_lpf1 250, dterm_lpf1 150 — BBL says 500/75 (flight-time truth)
      const result = enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, staticHeaders);
      expect(result).not.toBeNull();
      expect(result!.gyro_lpf1_static_hz).toBe(500);
      expect(result!.gyro_lpf2_static_hz).toBe(500);
      expect(result!.dterm_lpf1_static_hz).toBe(75);
      expect(result!.dterm_lpf2_static_hz).toBe(150);
    });

    it('overrides dyn notch min/max with BBL header values', () => {
      const settings = { ...DEFAULT_FILTER_SETTINGS, dyn_notch_min_hz: 150, dyn_notch_max_hz: 500 };
      const result = enrichSettingsFromBBLHeaders(settings, staticHeaders);
      expect(result).not.toBeNull();
      expect(result!.dyn_notch_min_hz).toBe(100);
      expect(result!.dyn_notch_max_hz).toBe(600);
    });

    it('overrides even values already set from MSP (BBL wins)', () => {
      const mspSettings = { ...DEFAULT_FILTER_SETTINGS, gyro_lpf1_static_hz: 300 };
      const result = enrichSettingsFromBBLHeaders(mspSettings, staticHeaders);
      expect(result).not.toBeNull();
      expect(result!.gyro_lpf1_static_hz).toBe(500);
    });

    it('returns null when BBL statics match current settings (no change)', () => {
      const matching = {
        ...DEFAULT_FILTER_SETTINGS,
        gyro_lpf1_static_hz: 500,
        gyro_lpf2_static_hz: 500,
        dterm_lpf1_static_hz: 75,
        dterm_lpf2_static_hz: 150,
        dyn_notch_min_hz: 100,
        dyn_notch_max_hz: 600,
      };
      expect(enrichSettingsFromBBLHeaders(matching, staticHeaders)).toBeNull();
    });

    it('ignores non-numeric static header values', () => {
      const headers = new Map([['gyro_lpf1_static_hz', 'garbage']]);
      expect(enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, headers)).toBeNull();
    });
  });
});

/**
 * Comprehensive test against real BBL headers from VX3.5 (SpeedyBee F405 Mini, BF 4.5.2).
 * Headers extracted from: test-fixtures/bbl/blackbox_2026-03-29T11-09-44-682Z.bbl
 *
 * Validates ALL tuning-relevant headers are parsed correctly by enrichSettingsFromBBLHeaders,
 * extractFlightPIDs, extractDMinContext, extractItermRelaxMode, extractTPAContext.
 */
describe('real BBL header parsing (VX3.5 BF 4.5.2)', () => {
  // Exact headers from the real BBL file
  const realHeaders = new Map([
    ['rollPID', '45,80,40'],
    ['pitchPID', '47,84,46'],
    ['yawPID', '45,80,0'],
    ['d_min', '30,34,0'],
    ['d_max_gain', '37'],
    ['d_max_advance', '20'],
    ['iterm_relax', '1'],
    ['iterm_relax_type', '1'],
    ['iterm_relax_cutoff', '15'],
    ['tpa_mode', '1'],
    ['tpa_rate', '65'],
    ['tpa_breakpoint', '1350'],
    ['tpa_low_rate', '20'],
    ['tpa_low_breakpoint', '1050'],
    ['tpa_low_always', '0'],
    ['gyro_lpf1_static_hz', '500'],
    ['gyro_lpf1_dyn_hz', '250,500'],
    ['gyro_lpf1_type', '0'],
    ['gyro_lpf2_static_hz', '500'],
    ['gyro_lpf2_type', '0'],
    ['dterm_lpf1_static_hz', '75'],
    ['dterm_lpf1_dyn_hz', '75,150'],
    ['dterm_lpf1_dyn_expo', '5'],
    ['dterm_lpf1_type', '0'],
    ['dterm_lpf2_static_hz', '150'],
    ['dterm_lpf2_type', '0'],
    ['dyn_notch_count', '1'],
    ['dyn_notch_q', '500'],
    ['dyn_notch_min_hz', '100'],
    ['dyn_notch_max_hz', '600'],
    ['rpm_filter_harmonics', '3'],
    ['rpm_filter_min_hz', '100'],
    ['rpm_filter_q', '500'],
    ['dshot_bidir', '1'],
    ['feedforward_transition', '0'],
    ['feedforward_boost', '15'],
    ['feedforward_smooth_factor', '25'],
    ['feedforward_jitter_factor', '7'],
    ['feedforward_averaging', '0'],
    ['feedforward_max_rate_limit', '90'],
    ['pid_process_denom', '2'],
    ['looptime', '125'],
    ['debug_mode', '6'],
    ['rc_smoothing_auto_factor', '30'],
  ]);

  it('should enrich filter settings from real BBL headers', () => {
    const result = enrichSettingsFromBBLHeaders(DEFAULT_FILTER_SETTINGS, realHeaders);
    expect(result).not.toBeNull();

    // Static cutoffs + dyn notch range: BBL is primary source and overrides
    // the DEFAULT_FILTER_SETTINGS pre-population (250/150 defaults)
    expect(result!.gyro_lpf1_static_hz).toBe(500);
    expect(result!.gyro_lpf2_static_hz).toBe(500);
    expect(result!.dterm_lpf1_static_hz).toBe(75);
    expect(result!.dterm_lpf2_static_hz).toBe(150);
    expect(result!.dyn_notch_min_hz).toBe(100);
    expect(result!.dyn_notch_max_hz).toBe(600);

    // Dynamic lowpass (CSV format)
    expect(result!.gyro_lpf1_dyn_min_hz).toBe(250);
    expect(result!.gyro_lpf1_dyn_max_hz).toBe(500);
    expect(result!.dterm_lpf1_dyn_min_hz).toBe(75);
    expect(result!.dterm_lpf1_dyn_max_hz).toBe(150);
    expect(result!.dterm_lpf1_dyn_expo).toBe(5);

    // RPM filter
    expect(result!.rpm_filter_harmonics).toBe(3);
    expect(result!.rpm_filter_min_hz).toBe(100);
    expect(result!.rpm_filter_q).toBe(500);

    // Dynamic notch
    expect(result!.dyn_notch_count).toBe(1);
    expect(result!.dyn_notch_q).toBe(500);
  });

  it('should extract d_min context from real BBL CSV format', () => {
    const ctx = extractDMinContext(realHeaders);
    expect(ctx.active).toBe(true);
    expect(ctx.roll).toBe(30);
    expect(ctx.pitch).toBe(34);
    expect(ctx.yaw).toBe(0);
    expect(ctx.gain).toBe(37); // d_max_gain, not d_min_gain
  });

  it('should extract iterm_relax mode from real BBL', () => {
    const mode = extractItermRelaxMode(realHeaders);
    expect(mode).toBe(1); // 1 = RP mode
  });

  it('should extract TPA context from real BBL', () => {
    const ctx = extractTPAContext(realHeaders);
    expect(ctx.active).toBe(true);
    expect(ctx.rate).toBe(65);
    expect(ctx.breakpoint).toBe(1350);
    expect(ctx.mode).toBe(1); // PD mode
  });

  it('should extract flight PIDs from real BBL CSV format', () => {
    const pids = extractFlightPIDs(realHeaders);
    expect(pids).toBeDefined();
    expect(pids!.roll).toEqual({ P: 45, I: 80, D: 40 });
    expect(pids!.pitch).toEqual({ P: 47, I: 84, D: 46 });
    expect(pids!.yaw).toEqual({ P: 45, I: 80, D: 0 });
  });
});
