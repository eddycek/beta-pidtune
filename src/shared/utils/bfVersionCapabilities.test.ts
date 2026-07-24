import { describe, it, expect } from 'vitest';
import {
  parseBFVersion,
  getBFCapabilities,
  translateSettingForVersion,
} from './bfVersionCapabilities';

describe('parseBFVersion', () => {
  it('parses classic semver versions', () => {
    expect(parseBFVersion('4.5.2')).toEqual({ major: 4, minor: 5, calendar: false });
    expect(parseBFVersion('4.3.0')).toEqual({ major: 4, minor: 3, calendar: false });
  });

  it('parses calendar versions as BF 4.6+', () => {
    expect(parseBFVersion('2025.12.0')).toEqual({ major: 2025, minor: 12, calendar: true });
  });

  it('returns null for garbage or missing input', () => {
    expect(parseBFVersion(undefined)).toBeNull();
    expect(parseBFVersion('')).toBeNull();
    expect(parseBFVersion('unknown')).toBeNull();
  });
});

describe('getBFCapabilities', () => {
  it('gives the conservative 4.3 baseline for unknown versions', () => {
    const caps = getBFCapabilities(undefined);
    expect(caps.hasTpaLow).toBe(false);
    expect(caps.hasRpmWeights).toBe(false);
    expect(caps.usesDMax).toBe(false);
  });

  it('BF 4.4 has no 4.5+ features', () => {
    const caps = getBFCapabilities('4.4.3');
    expect(caps.hasTpaLow).toBe(false);
    expect(caps.hasRpmWeights).toBe(false);
    expect(caps.hasAntiGravityCutoff).toBe(false);
    expect(caps.usesDMax).toBe(false);
  });

  it('BF 4.5 gains tpa_low, RPM weights and anti-gravity cutoff', () => {
    const caps = getBFCapabilities('4.5.1');
    expect(caps.hasTpaLow).toBe(true);
    expect(caps.hasRpmWeights).toBe(true);
    expect(caps.hasAntiGravityCutoff).toBe(true);
    expect(caps.usesDMax).toBe(false);
    expect(caps.hasChirp).toBe(false);
  });

  it('calendar versions (2025.12 = BF 4.6) gain d_max rename and chirp', () => {
    const caps = getBFCapabilities('2025.12.0');
    expect(caps.hasTpaLow).toBe(true);
    expect(caps.usesDMax).toBe(true);
    expect(caps.hasChirp).toBe(true);
  });

  it('classic "4.6.0" (what real 2025.12 firmware reports via MSP) also gains d_max + chirp', () => {
    // BF 2025.12 still reports "4.6.0" in MSP_FC_VERSION — the 4.6 features
    // must key off the classic version, not the calendar naming
    const caps = getBFCapabilities('4.6.0');
    expect(caps.usesDMax).toBe(true);
    expect(caps.hasChirp).toBe(true);
    expect(caps.hasTpaLow).toBe(true);
  });
});

describe('translateSettingForVersion', () => {
  it('renames d_min settings to d_max on 4.6+', () => {
    const caps = getBFCapabilities('2025.12.0');
    expect(translateSettingForVersion('d_min_gain', caps)).toBe('d_max_gain');
    expect(translateSettingForVersion('d_min_advance', caps)).toBe('d_max_advance');
    expect(translateSettingForVersion('d_min_roll', caps)).toBe('d_max_roll');
  });

  it('leaves names unchanged on 4.5 and below', () => {
    const caps = getBFCapabilities('4.5.2');
    expect(translateSettingForVersion('d_min_gain', caps)).toBe('d_min_gain');
  });

  it('leaves unrelated settings unchanged on every version', () => {
    const caps = getBFCapabilities('2025.12.0');
    expect(translateSettingForVersion('gyro_lpf1_static_hz', caps)).toBe('gyro_lpf1_static_hz');
    expect(translateSettingForVersion('tpa_rate', caps)).toBe('tpa_rate');
  });
});
