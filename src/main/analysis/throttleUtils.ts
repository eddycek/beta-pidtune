/**
 * Throttle value normalization shared by all analysis modules.
 *
 * BBL logs carry throttle in different units depending on firmware/field:
 * RC pulse width (1000-2000), permille (0-1000), percent (0-100), or an
 * already-normalized 0-1 value. Detection is heuristic by magnitude.
 */

/** Normalize a raw throttle value to the 0-1 range. */
export function normalizeThrottle(value: number): number {
  if (value > 1000) {
    // 1000-2000 range (RC pulse width)
    return (value - 1000) / 1000;
  }
  if (value > 100) {
    // 0-1000 range (permille)
    return value / 1000;
  }
  if (value > 1) {
    // 0-100 range (percent)
    return value / 100;
  }
  return value;
}
