import { describe, it, expect } from 'vitest';
import { normalizeThrottle } from './throttleUtils';

describe('normalizeThrottle', () => {
  it('normalizes RC pulse width (1000-2000)', () => {
    expect(normalizeThrottle(1000.5)).toBeCloseTo(0.0005, 4);
    expect(normalizeThrottle(1500)).toBeCloseTo(0.5, 6);
    expect(normalizeThrottle(2000)).toBeCloseTo(1.0, 6);
  });

  it('normalizes permille (0-1000)', () => {
    expect(normalizeThrottle(500)).toBeCloseTo(0.5, 6);
    expect(normalizeThrottle(1000)).toBeCloseTo(1.0, 6);
  });

  it('normalizes percent (0-100)', () => {
    expect(normalizeThrottle(50)).toBeCloseTo(0.5, 6);
    expect(normalizeThrottle(100)).toBeCloseTo(1.0, 6);
  });

  it('passes through already-normalized values', () => {
    expect(normalizeThrottle(0)).toBe(0);
    expect(normalizeThrottle(0.42)).toBe(0.42);
    expect(normalizeThrottle(1)).toBe(1);
  });
});
