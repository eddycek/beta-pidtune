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
} from 'recharts';
import { AxisTabs, type AxisSelection } from './AxisTabs';
import { AXIS_COLORS, type Axis } from './chartUtils';
import './BodePlot.css';

/** Accepts both Float64Array (from main process) and number[] (from IPC serialization) */
interface BodeData {
  frequencies: Float64Array | number[];
  magnitude: Float64Array | number[];
  phase: Float64Array | number[];
  /** Magnitude-squared coherence γ²(f), 0-1 (absent with a single Welch window) */
  coherence?: Float64Array | number[];
}

/** Recommendation gate — TF rules are skipped below this coherence (P3.1 display) */
const COHERENCE_GATE = 0.5;

interface BodePlotProps {
  bode: {
    roll: BodeData;
    pitch: BodeData;
    yaw: BodeData;
  };
}

interface BodeDataPoint {
  frequency: number;
  roll?: number;
  pitch?: number;
  yaw?: number;
}

const MAX_CHART_POINTS = 500;
const MIN_HEIGHT = 250;
const ASPECT_RATIO = 7 / 3;

/** Convert BodeResult per-axis data into Recharts format */
function bodeToRechartsData(
  bode: BodePlotProps['bode'],
  mode: 'magnitude' | 'phase' | 'coherence'
): BodeDataPoint[] {
  const rollFreq = bode.roll.frequencies;
  const points: BodeDataPoint[] = [];

  for (let i = 0; i < rollFreq.length; i++) {
    const freq = rollFreq[i];
    if (freq <= 0) continue;

    const point: BodeDataPoint = { frequency: Math.round(freq * 10) / 10 };
    if (mode === 'magnitude') {
      point.roll = bode.roll.magnitude[i];
      point.pitch = bode.pitch.magnitude[i];
      point.yaw = bode.yaw.magnitude[i];
    } else if (mode === 'phase') {
      point.roll = bode.roll.phase[i];
      point.pitch = bode.pitch.phase[i];
      point.yaw = bode.yaw.phase[i];
    } else {
      point.roll = bode.roll.coherence?.[i];
      point.pitch = bode.pitch.coherence?.[i];
      point.yaw = bode.yaw.coherence?.[i];
    }
    points.push(point);
  }

  // Downsample if too many points
  if (points.length > MAX_CHART_POINTS) {
    const step = Math.ceil(points.length / MAX_CHART_POINTS);
    return points.filter((_, i) => i % step === 0);
  }

  return points;
}

export function BodePlot({ bode }: BodePlotProps) {
  const [selectedAxis, setSelectedAxis] = useState<AxisSelection>('all');

  const magnitudeData = useMemo(() => bodeToRechartsData(bode, 'magnitude'), [bode]);
  const phaseData = useMemo(() => bodeToRechartsData(bode, 'phase'), [bode]);
  const hasCoherence =
    (bode.roll.coherence?.length ?? 0) > 0 ||
    (bode.pitch.coherence?.length ?? 0) > 0 ||
    (bode.yaw.coherence?.length ?? 0) > 0;
  const coherenceData = useMemo(
    () => (hasCoherence ? bodeToRechartsData(bode, 'coherence') : []),
    [bode, hasCoherence]
  );

  const visibleAxes: Axis[] = selectedAxis === 'all' ? ['roll', 'pitch', 'yaw'] : [selectedAxis];

  if (magnitudeData.length === 0) {
    return <div className="bode-plot-empty">No transfer function data available.</div>;
  }

  return (
    <div className="bode-plot">
      <AxisTabs selected={selectedAxis} onChange={setSelectedAxis} />

      <div className="bode-plot-section">
        <h5 className="bode-plot-label">Magnitude (dB)</h5>
        <div className="bode-plot-container">
          <ResponsiveContainer width="100%" aspect={ASPECT_RATIO} minHeight={MIN_HEIGHT}>
            <LineChart data={magnitudeData} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis
                dataKey="frequency"
                type="number"
                tick={{ fontSize: 11, fill: '#aaa' }}
                label={{
                  value: 'Frequency (Hz)',
                  position: 'insideBottom',
                  offset: -2,
                  style: { fontSize: 11, fill: '#888' },
                }}
              />
              <YAxis
                tickFormatter={(v: number) => (Number.isFinite(v) ? v.toFixed(0) : '')}
                tick={{ fontSize: 11, fill: '#aaa' }}
                label={{
                  value: 'dB',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 11, fill: '#888' },
                }}
              />
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
              <ReferenceLine y={0} stroke="#666" strokeDasharray="5 5" />
              <ReferenceLine y={-3} stroke="#ff8787" strokeDasharray="3 3" strokeOpacity={0.5} />
              {visibleAxes.map((axis) => (
                <Line
                  key={axis}
                  dataKey={axis}
                  stroke={AXIS_COLORS[axis]}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  name={axis}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bode-plot-section">
        <h5 className="bode-plot-label">Phase (degrees)</h5>
        <div className="bode-plot-container">
          <ResponsiveContainer width="100%" aspect={ASPECT_RATIO} minHeight={MIN_HEIGHT}>
            <LineChart data={phaseData} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis
                dataKey="frequency"
                type="number"
                tick={{ fontSize: 11, fill: '#aaa' }}
                label={{
                  value: 'Frequency (Hz)',
                  position: 'insideBottom',
                  offset: -2,
                  style: { fontSize: 11, fill: '#888' },
                }}
              />
              <YAxis
                tickFormatter={(v: number) => (Number.isFinite(v) ? v.toFixed(0) : '')}
                tick={{ fontSize: 11, fill: '#aaa' }}
                label={{
                  value: 'deg',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 11, fill: '#888' },
                }}
              />
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
                    `${(value ?? 0).toFixed(1)}\u00B0`,
                    name,
                  ]) as any
                }
              />
              <ReferenceLine y={0} stroke="#666" strokeDasharray="5 5" />
              <ReferenceLine y={-180} stroke="#ff8787" strokeDasharray="3 3" strokeOpacity={0.5} />
              {visibleAxes.map((axis) => (
                <Line
                  key={axis}
                  dataKey={axis}
                  stroke={AXIS_COLORS[axis]}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  name={axis}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {hasCoherence && coherenceData.length > 0 && (
        <div className="bode-plot-section">
          <h5 className="bode-plot-label">Coherence γ² (measurement quality, 0–1)</h5>
          <div className="bode-plot-container">
            <ResponsiveContainer width="100%" aspect={ASPECT_RATIO} minHeight={MIN_HEIGHT}>
              <LineChart data={coherenceData} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis
                  dataKey="frequency"
                  type="number"
                  tick={{ fontSize: 11, fill: '#aaa' }}
                  label={{
                    value: 'Frequency (Hz)',
                    position: 'insideBottom',
                    offset: -2,
                    style: { fontSize: 11, fill: '#888' },
                  }}
                />
                <YAxis
                  domain={[0, 1]}
                  tickFormatter={(v: number) => (Number.isFinite(v) ? v.toFixed(1) : '')}
                  tick={{ fontSize: 11, fill: '#aaa' }}
                  label={{
                    value: 'γ²',
                    angle: -90,
                    position: 'insideLeft',
                    style: { fontSize: 11, fill: '#888' },
                  }}
                />
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
                      `${(value ?? 0).toFixed(2)}`,
                      name,
                    ]) as any
                  }
                />
                <ReferenceLine
                  y={COHERENCE_GATE}
                  stroke="#ffd43b"
                  strokeDasharray="5 5"
                  strokeOpacity={0.6}
                  label={{
                    value: 'recommendation gate (0.5)',
                    position: 'insideBottomRight',
                    style: { fontSize: 9, fill: '#ffd43b' },
                  }}
                />
                {visibleAxes.map((axis) => (
                  <Line
                    key={axis}
                    dataKey={axis}
                    stroke={AXIS_COLORS[axis]}
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                    name={axis}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="bode-plot-coherence-note">
            Coherence shows how much of the gyro response is explained by stick input at each
            frequency. Transfer-function recommendations are only generated where the mean coherence
            over the 1–30 Hz stick band is at least 0.5.
          </p>
        </div>
      )}
    </div>
  );
}
