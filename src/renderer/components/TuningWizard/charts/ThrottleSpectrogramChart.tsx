import React, { useMemo, useState, useCallback, useId } from 'react';
import { AxisTabs, type AxisSelection } from './AxisTabs';
import {
  prepareHeatmapData,
  prepareHeatmapDataFromCompact,
  dbToColor,
  type Axis,
  type HeatmapCell,
} from '../../../utils/spectrogramUtils';
import type {
  ThrottleSpectrogramResult,
  CurrentFilterSettings,
} from '@shared/types/analysis.types';
import type { CompactThrottleSpectrogram } from '@shared/types/tuning-history.types';
import { gyroLpf1CutoffAtThrottle } from '@shared/utils/filterResponse';
import './ThrottleSpectrogramChart.css';

interface ThrottleSpectrogramChartProps {
  /** Full spectrogram result (from live analysis) */
  data?: ThrottleSpectrogramResult;
  /** Compact spectrogram (from history/archived metrics) */
  compactData?: CompactThrottleSpectrogram;
  /** When set, axis is controlled externally and local AxisTabs are hidden */
  sharedAxis?: 'roll' | 'pitch' | 'yaw';
  /** When provided, the gyro LPF1 cutoff is overlaid as a line across throttle
   * bands (dynamic LPF follows its throttle curve; static is a vertical line) */
  filterSettings?: CurrentFilterSettings;
}

const CHART_HEIGHT = 300;
const MARGIN = { top: 10, right: 80, bottom: 40, left: 70 };
const COLORBAR_WIDTH = 14;
const COLORBAR_GAP = 12;

/** Format throttle value (0.0–1.0) as percentage string */
function fmtThrottle(value: number): string {
  return `${Math.round(value * 100)}`;
}

export function ThrottleSpectrogramChart({
  data,
  compactData,
  sharedAxis,
  filterSettings,
}: ThrottleSpectrogramChartProps) {
  const [localAxis, setLocalAxis] = useState<AxisSelection>('roll');
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    cell: HeatmapCell;
  } | null>(null);

  const selectedAxis = sharedAxis ?? localAxis;
  const axis: Axis = selectedAxis === 'all' ? 'roll' : (selectedAxis as Axis);

  const heatmap = useMemo(() => {
    if (data) return prepareHeatmapData(data, axis);
    if (compactData) return prepareHeatmapDataFromCompact(compactData, axis);
    return null;
  }, [data, compactData, axis]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGRectElement>, cell: HeatmapCell) => {
    const svg = (e.target as SVGElement).closest('svg');
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      cell,
    });
  }, []);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  const uniqueId = useId();
  const gradientId = `spectrogram-colorbar-${uniqueId.replace(/:/g, '')}`;

  if (!heatmap || heatmap.cells.length === 0) {
    return null;
  }

  const numFreqs = heatmap.frequencies.length;
  const numBands = heatmap.bands.length;

  // Use viewBox for responsive scaling — SVG fills container width
  const plotWidth = 900;
  const svgWidth = plotWidth + MARGIN.left + MARGIN.right;
  const svgHeight = CHART_HEIGHT + MARGIN.top + MARGIN.bottom;

  const cellWidth = (plotWidth - COLORBAR_WIDTH - COLORBAR_GAP) / numFreqs;
  const cellHeight = CHART_HEIGHT / numBands;
  const heatmapWidth = plotWidth - COLORBAR_WIDTH - COLORBAR_GAP;

  // X-axis tick values
  const maxFreq = heatmap.frequencies[numFreqs - 1];
  const xTicks: number[] = [];
  const xStep = maxFreq > 500 ? 200 : 100;
  for (let f = 0; f <= maxFreq; f += xStep) xTicks.push(f);

  // Color bar gradient stops
  const colorStops = Array.from({ length: 10 }, (_, i) => {
    const t = i / 9;
    const db = heatmap.minDb + t * (heatmap.maxDb - heatmap.minDb);
    return { offset: `${(1 - t) * 100}%`, color: dbToColor(db, heatmap.minDb, heatmap.maxDb) };
  });

  return (
    <div className="spectrogram-chart">
      {!sharedAxis && <AxisTabs selected={selectedAxis} onChange={setLocalAxis} showAll={false} />}
      <div className="spectrogram-chart-container">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          preserveAspectRatio="xMidYMid meet"
          className="spectrogram-svg"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
              {colorStops.map((stop, i) => (
                <stop key={i} offset={stop.offset} stopColor={stop.color} />
              ))}
            </linearGradient>
          </defs>

          <g transform={`translate(${MARGIN.left}, ${MARGIN.top})`}>
            {/* Heatmap cells */}
            {heatmap.cells.map((cell, i) => (
              <rect
                key={i}
                x={cell.freqIndex * cellWidth}
                y={(numBands - 1 - cell.bandIndex) * cellHeight}
                width={cellWidth + 0.5}
                height={cellHeight + 0.5}
                fill={dbToColor(cell.db, heatmap.minDb, heatmap.maxDb)}
                onMouseMove={(e) => handleMouseMove(e, cell)}
                onMouseLeave={handleMouseLeave}
              />
            ))}

            {/* X-axis (frequency) */}
            <line x1={0} y1={CHART_HEIGHT} x2={heatmapWidth} y2={CHART_HEIGHT} stroke="#666" />
            {xTicks.map((freq) => {
              const x = (freq / maxFreq) * heatmapWidth;
              return (
                <g key={freq}>
                  <line x1={x} y1={CHART_HEIGHT} x2={x} y2={CHART_HEIGHT + 5} stroke="#666" />
                  <text x={x} y={CHART_HEIGHT + 18} textAnchor="middle" fontSize={10} fill="#aaa">
                    {freq}
                  </text>
                </g>
              );
            })}
            <text
              x={heatmapWidth / 2}
              y={CHART_HEIGHT + 34}
              textAnchor="middle"
              fontSize={11}
              fill="#888"
            >
              Frequency (Hz)
            </text>

            {/* Y-axis (throttle) */}
            <line x1={0} y1={0} x2={0} y2={CHART_HEIGHT} stroke="#666" />
            {heatmap.bands.map((band, i) => {
              const y = (numBands - 1 - i) * cellHeight + cellHeight / 2;
              return (
                <text
                  key={i}
                  x={-6}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={10}
                  fill="#aaa"
                >
                  {fmtThrottle(band.min)}-{fmtThrottle(band.max)}%
                </text>
              );
            })}
            <text
              x={-50}
              y={CHART_HEIGHT / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={11}
              fill="#888"
              transform={`rotate(-90, -50, ${CHART_HEIGHT / 2})`}
            >
              Throttle
            </text>

            {/* Gyro LPF1 cutoff overlay — dynamic LPF traces its throttle curve */}
            {filterSettings &&
              (() => {
                const points: string[] = [];
                for (let i = 0; i < numBands; i++) {
                  const band = heatmap.bands[i];
                  const cutoff = gyroLpf1CutoffAtThrottle(
                    filterSettings,
                    (band.min + band.max) / 2
                  );
                  if (cutoff === null || cutoff > maxFreq) continue;
                  const x = (cutoff / maxFreq) * heatmapWidth;
                  const y = (numBands - 1 - i) * cellHeight + cellHeight / 2;
                  points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
                }
                if (points.length < 2) return null;
                const [labelX, labelY] = points[points.length - 1].split(',').map(Number);
                return (
                  <g pointerEvents="none">
                    <polyline
                      points={points.join(' ')}
                      fill="none"
                      stroke="#63e6be"
                      strokeWidth={2}
                      strokeDasharray="6 3"
                      opacity={0.9}
                    />
                    <text x={labelX + 6} y={labelY} fontSize={10} fill="#63e6be">
                      Gyro LPF1
                    </text>
                  </g>
                );
              })()}

            {/* Colorbar */}
            <rect
              x={heatmapWidth + COLORBAR_GAP}
              y={0}
              width={COLORBAR_WIDTH}
              height={CHART_HEIGHT}
              fill={`url(#${gradientId})`}
              stroke="#666"
              strokeWidth={0.5}
            />
            <text
              x={heatmapWidth + COLORBAR_GAP + COLORBAR_WIDTH + 4}
              y={8}
              fontSize={9}
              fill="#aaa"
            >
              {heatmap.maxDb.toFixed(0)} dB
            </text>
            <text
              x={heatmapWidth + COLORBAR_GAP + COLORBAR_WIDTH + 4}
              y={CHART_HEIGHT}
              fontSize={9}
              fill="#aaa"
            >
              {heatmap.minDb.toFixed(0)} dB
            </text>
          </g>

          {/* Tooltip */}
          {tooltip && (
            <g transform={`translate(${tooltip.x + 12}, ${tooltip.y - 10})`} pointerEvents="none">
              <rect
                x={0}
                y={-18}
                width={240}
                height={52}
                rx={4}
                fill="#1a1a1a"
                stroke="#444"
                strokeWidth={1}
              />
              <text x={10} y={2} fontSize={13} fill="#ddd">
                Throttle {fmtThrottle(tooltip.cell.throttleMin)}-
                {fmtThrottle(tooltip.cell.throttleMax)}%
              </text>
              <text x={10} y={22} fontSize={13} fill="#ddd">
                {tooltip.cell.frequency.toFixed(0)} Hz, {tooltip.cell.db.toFixed(1)} dB
              </text>
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
