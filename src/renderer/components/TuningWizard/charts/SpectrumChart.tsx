import React, { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
} from 'recharts';
import { AxisTabs, type AxisSelection } from './AxisTabs';
import { spectrumToRechartsData, downsampleData, AXIS_COLORS, type Axis } from './chartUtils';
import { computeFilterChainCurve, FILTER_RESPONSE_FLOOR_DB } from '@shared/utils/filterResponse';
import type {
  NoiseProfile,
  NoisePeak,
  CurrentFilterSettings,
  FilterRecommendation,
} from '@shared/types/analysis.types';
import './SpectrumChart.css';

interface SpectrumChartProps {
  noise: NoiseProfile;
  /** When provided, the configured gyro/D-term filter response is overlaid
   * (right axis, attenuation dB) together with the dynamic notch range. */
  filterSettings?: CurrentFilterSettings;
  /** When provided, peaks that triggered a rule (via evidence.anchorFrequencyHz)
   * are tagged with the rule ID — "this peak fired F-RES-GYRO" (P3.1) */
  recommendations?: FilterRecommendation[];
}

/** Frequency tolerance when matching a rule's evidence anchor to a peak */
const RULE_ANCHOR_TOLERANCE_HZ = 8;

const FILTER_CURVE_COLORS = { gyro: '#63e6be', dterm: '#e599f7' } as const;

const MAX_CHART_POINTS = 500;
const MIN_WIDTH = 700;
const MIN_HEIGHT = 300;
const ASPECT_RATIO = MIN_WIDTH / MIN_HEIGHT;

const PEAK_COLORS: Record<string, string> = {
  frame_resonance: '#ff8787',
  motor_harmonic: '#ffd43b',
  electrical: '#4dabf7',
  unknown: '#aaa',
};

const PEAK_LABELS: Record<string, string> = {
  frame_resonance: 'Frame',
  motor_harmonic: 'Motor',
  electrical: 'Electrical',
  unknown: 'Unknown',
};

/** dB floor threshold — values below this are considered "no signal" and hidden */
const DB_DISPLAY_FLOOR = -80;
/** Padding above the highest dB value */
const DB_TOP_PADDING = 5;
/** Padding beyond the last significant frequency as fraction of visible range */
const FREQ_PADDING_RATIO = 0.05;

export function SpectrumChart({ noise, filterSettings, recommendations }: SpectrumChartProps) {
  const [selectedAxis, setSelectedAxis] = useState<AxisSelection>('all');

  // Compute data, domains, and filter to significant range in one pass
  const { data, yDomain, xDomain } = useMemo(() => {
    const raw = spectrumToRechartsData(
      { roll: noise.roll, pitch: noise.pitch, yaw: noise.yaw },
      20,
      1000
    );
    const downsampled = downsampleData(raw, MAX_CHART_POINTS);

    let yMin = 0;
    let yMax = -Infinity;
    let xMaxSignificant = 100; // minimum useful range

    for (const point of downsampled) {
      for (const axis of ['roll', 'pitch', 'yaw'] as const) {
        const val = point[axis];
        if (val !== undefined && val > DB_DISPLAY_FLOOR) {
          if (val < yMin) yMin = val;
          if (val > yMax) yMax = val;
          if (point.frequency > xMaxSignificant) xMaxSignificant = point.frequency;
        }
      }
    }

    // If no significant data found, fall back to full range
    if (yMax === -Infinity) {
      yMax = 0;
      yMin = -60;
      xMaxSignificant =
        downsampled.length > 0 ? downsampled[downsampled.length - 1].frequency : 500;
    }

    const dataMaxFreq =
      downsampled.length > 0 ? downsampled[downsampled.length - 1].frequency : 1000;
    const freqPadding = (xMaxSignificant - 20) * FREQ_PADDING_RATIO;
    const xMax = Math.min(xMaxSignificant + freqPadding, dataMaxFreq);

    // Filter data to last significant frequency only — padding is visual (empty space),
    // not data. This prevents -240 dB floor values from creating a cliff and stretching the Y-axis.
    const filtered = downsampled.filter((p) => p.frequency <= xMaxSignificant);

    return {
      data: filtered,
      yDomain: [Math.max(yMin - 10, DB_DISPLAY_FLOOR), yMax + DB_TOP_PADDING] as [number, number],
      xDomain: [20, xMax] as [number, number],
    };
  }, [noise]);

  // Filter-response overlay: configured gyro/D-term chain attenuation at each
  // chart frequency (right axis), evaluated at cruise throttle for dynamic LPFs
  const { chartData, hasGyroOverlay, hasDtermOverlay, notchRange } = useMemo(() => {
    if (!filterSettings || data.length === 0) {
      return { chartData: data, hasGyroOverlay: false, hasDtermOverlay: false, notchRange: null };
    }
    const frequencies = data.map((p) => p.frequency);
    const gyroCurve = computeFilterChainCurve(filterSettings, 'gyro', frequencies);
    const dtermCurve = computeFilterChainCurve(filterSettings, 'dterm', frequencies);
    if (!gyroCurve && !dtermCurve) {
      return { chartData: data, hasGyroOverlay: false, hasDtermOverlay: false, notchRange: null };
    }
    const merged = data.map((p, i) => ({
      ...p,
      ...(gyroCurve ? { gyroFilter: gyroCurve[i] } : {}),
      ...(dtermCurve ? { dtermFilter: dtermCurve[i] } : {}),
    }));
    const range =
      (filterSettings.dyn_notch_count ?? 0) !== 0 &&
      filterSettings.dyn_notch_min_hz > 0 &&
      filterSettings.dyn_notch_max_hz > filterSettings.dyn_notch_min_hz
        ? { min: filterSettings.dyn_notch_min_hz, max: filterSettings.dyn_notch_max_hz }
        : null;
    return {
      chartData: merged,
      hasGyroOverlay: gyroCurve !== null,
      hasDtermOverlay: dtermCurve !== null,
      notchRange: range,
    };
  }, [data, filterSettings]);
  const hasFilterOverlay = hasGyroOverlay || hasDtermOverlay;

  const visibleAxes: Axis[] = selectedAxis === 'all' ? ['roll', 'pitch', 'yaw'] : [selectedAxis];

  // Map rule anchors (evidence.anchorFrequencyHz) to peak frequencies so each
  // annotated peak shows WHICH rule it triggered
  const ruleForFrequency = (freq: number): string | undefined =>
    recommendations?.find(
      (r) =>
        r.ruleId &&
        r.evidence?.anchorFrequencyHz !== undefined &&
        Math.abs(r.evidence.anchorFrequencyHz - freq) <= RULE_ANCHOR_TOLERANCE_HZ
    )?.ruleId;

  // Collect peaks for visible axes
  const visiblePeaks: (NoisePeak & { axis: Axis })[] = [];
  for (const axis of visibleAxes) {
    for (const peak of noise[axis].peaks) {
      visiblePeaks.push({ ...peak, axis });
    }
  }

  // Noise floor for visible axes
  const noiseFloors = visibleAxes.map((axis) => ({
    axis,
    value: noise[axis].noiseFloorDb,
  }));

  if (data.length === 0) {
    return <div className="spectrum-chart-empty">No spectrum data available.</div>;
  }

  return (
    <div className="spectrum-chart">
      <AxisTabs selected={selectedAxis} onChange={setSelectedAxis} />
      <div className="spectrum-chart-container">
        <ResponsiveContainer width="100%" aspect={ASPECT_RATIO} minHeight={MIN_HEIGHT}>
          <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis
              dataKey="frequency"
              type="number"
              domain={xDomain}
              allowDataOverflow={true}
              tick={{ fontSize: 11, fill: '#aaa' }}
              label={{
                value: 'Frequency (Hz)',
                position: 'insideBottom',
                offset: -2,
                style: { fontSize: 11, fill: '#888' },
              }}
            />
            <YAxis
              yAxisId="noise"
              domain={yDomain}
              allowDataOverflow={true}
              tickFormatter={(v: number) => (Number.isFinite(v) ? v.toFixed(0) : '')}
              tick={{ fontSize: 11, fill: '#aaa' }}
              label={{
                value: 'Noise (dB)',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: 11, fill: '#888' },
              }}
            />
            {hasFilterOverlay && (
              <YAxis
                yAxisId="filter"
                orientation="right"
                domain={[FILTER_RESPONSE_FLOOR_DB, 3]}
                allowDataOverflow={true}
                tickFormatter={(v: number) => (Number.isFinite(v) ? v.toFixed(0) : '')}
                tick={{ fontSize: 11, fill: '#63e6be' }}
                label={{
                  value: 'Filter (dB)',
                  angle: 90,
                  position: 'insideRight',
                  style: { fontSize: 11, fill: '#63e6be' },
                }}
              />
            )}
            <Tooltip
              contentStyle={{
                background: '#1a1a1a',
                border: '1px solid #444',
                borderRadius: 4,
                fontSize: 12,
              }}
              labelFormatter={(val) => `${val} Hz`}
              formatter={
                ((value: number | undefined, name: string) => [
                  `${(value ?? 0).toFixed(1)} dB`,
                  name,
                ]) as any
              }
            />

            {/* Dynamic notch tracking range (shaded band) */}
            {notchRange && (
              <ReferenceArea
                yAxisId="noise"
                x1={notchRange.min}
                x2={notchRange.max}
                fill="#4dabf7"
                fillOpacity={0.06}
                stroke="#4dabf7"
                strokeOpacity={0.25}
                strokeDasharray="4 4"
                label={{
                  value: 'Dyn notch range',
                  position: 'insideTopRight',
                  style: { fontSize: 9, fill: '#4dabf7' },
                }}
              />
            )}

            {visibleAxes.map((axis) => (
              <Line
                key={axis}
                yAxisId="noise"
                dataKey={axis}
                stroke={AXIS_COLORS[axis]}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                name={axis}
              />
            ))}

            {/* Configured filter chain response (right axis, attenuation dB) —
                each curve renders only when its chain has an active stage */}
            {hasGyroOverlay && (
              <Line
                yAxisId="filter"
                dataKey="gyroFilter"
                stroke={FILTER_CURVE_COLORS.gyro}
                strokeWidth={1.5}
                strokeDasharray="6 3"
                dot={false}
                isAnimationActive={false}
                name="Gyro filters"
              />
            )}
            {hasDtermOverlay && (
              <Line
                yAxisId="filter"
                dataKey="dtermFilter"
                stroke={FILTER_CURVE_COLORS.dterm}
                strokeWidth={1.5}
                strokeDasharray="2 3"
                dot={false}
                isAnimationActive={false}
                name="D-term filters"
              />
            )}

            {/* Noise floor reference lines */}
            {noiseFloors.map(({ axis, value }) => (
              <ReferenceLine
                key={`floor-${axis}`}
                yAxisId="noise"
                y={value}
                stroke={AXIS_COLORS[axis]}
                strokeDasharray="5 5"
                strokeOpacity={0.4}
              />
            ))}

            {/* Peak markers as vertical reference lines (tagged with the rule they fired) */}
            {visiblePeaks.map((peak, i) => {
              const ruleId = ruleForFrequency(peak.frequency);
              const baseLabel = `${PEAK_LABELS[peak.type] || peak.type} ${peak.frequency.toFixed(0)}Hz`;
              return (
                <ReferenceLine
                  key={`peak-${peak.axis}-${i}`}
                  yAxisId="noise"
                  x={peak.frequency}
                  stroke={PEAK_COLORS[peak.type] || '#aaa'}
                  strokeDasharray="3 3"
                  strokeOpacity={0.6}
                  label={{
                    value: ruleId ? `${baseLabel} → ${ruleId}` : baseLabel,
                    position: 'top',
                    style: { fontSize: 9, fill: PEAK_COLORS[peak.type] || '#aaa' },
                  }}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {hasFilterOverlay && (
        <div className="spectrum-chart-filter-legend">
          {hasGyroOverlay && (
            <span style={{ color: FILTER_CURVE_COLORS.gyro }}>– – Gyro filters</span>
          )}
          {hasDtermOverlay && (
            <span style={{ color: FILTER_CURVE_COLORS.dterm }}>· · D-term filters</span>
          )}
          <span className="spectrum-chart-filter-legend-note">
            configured attenuation (right axis; dynamic LPF shown at 50% throttle)
          </span>
        </div>
      )}
    </div>
  );
}
