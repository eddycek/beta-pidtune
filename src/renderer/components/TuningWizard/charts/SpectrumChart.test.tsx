import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SpectrumChart } from './SpectrumChart';
import type { NoiseProfile } from '@shared/types/analysis.types';

// ResponsiveContainer needs a real layout engine — mock it for JSDOM
vi.mock('recharts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('recharts')>();
  const { cloneElement } = await import('react');
  return {
    ...mod,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      cloneElement(children, { width: 700, height: 300 }),
  };
});

function makeSpectrum(count: number) {
  const frequencies = new Float64Array(count);
  const magnitudes = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    frequencies[i] = 20 + (i * 980) / Math.max(count - 1, 1);
    magnitudes[i] = -40 + Math.random() * 20;
  }
  return { frequencies, magnitudes };
}

const mockNoise: NoiseProfile = {
  roll: {
    spectrum: makeSpectrum(50),
    noiseFloorDb: -35,
    peaks: [{ frequency: 150, amplitude: 15, type: 'frame_resonance' }],
  },
  pitch: {
    spectrum: makeSpectrum(50),
    noiseFloorDb: -38,
    peaks: [{ frequency: 350, amplitude: 10, type: 'motor_harmonic' }],
  },
  yaw: {
    spectrum: makeSpectrum(50),
    noiseFloorDb: -42,
    peaks: [],
  },
  overallLevel: 'low',
};

const emptyNoise: NoiseProfile = {
  roll: {
    spectrum: { frequencies: new Float64Array([]), magnitudes: new Float64Array([]) },
    noiseFloorDb: -40,
    peaks: [],
  },
  pitch: {
    spectrum: { frequencies: new Float64Array([]), magnitudes: new Float64Array([]) },
    noiseFloorDb: -40,
    peaks: [],
  },
  yaw: {
    spectrum: { frequencies: new Float64Array([]), magnitudes: new Float64Array([]) },
    noiseFloorDb: -40,
    peaks: [],
  },
  overallLevel: 'low',
};

describe('SpectrumChart', () => {
  it('renders SVG chart with axis tabs', () => {
    const { container } = render(<SpectrumChart noise={mockNoise} />);

    // Axis tabs
    expect(screen.getByRole('tab', { name: 'Roll' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pitch' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Yaw' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument();

    // SVG chart
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  it('shows empty state for empty spectrum data', () => {
    render(<SpectrumChart noise={emptyNoise} />);
    expect(screen.getByText('No spectrum data available.')).toBeInTheDocument();
  });

  it('renders chart lines in SVG', () => {
    const { container } = render(<SpectrumChart noise={mockNoise} />);

    // Recharts renders Line components as paths with class recharts-line
    const lines = container.querySelectorAll('.recharts-line');
    // Default "all" mode shows 3 lines
    expect(lines.length).toBe(3);
  });

  it('switches to single axis when tab clicked', async () => {
    const user = userEvent.setup();
    const { container } = render(<SpectrumChart noise={mockNoise} />);

    await user.click(screen.getByRole('tab', { name: 'Roll' }));

    // Only 1 line visible
    const lines = container.querySelectorAll('.recharts-line');
    expect(lines.length).toBe(1);
  });

  it('renders peak markers as reference lines', () => {
    const { container } = render(<SpectrumChart noise={mockNoise} />);

    // Recharts renders ReferenceLine with class recharts-reference-line
    const refLines = container.querySelectorAll('.recharts-reference-line');
    // 3 noise floors (all mode) + 2 peaks = 5
    expect(refLines.length).toBeGreaterThanOrEqual(2);
  });

  it('overlays filter response curves when filterSettings provided', () => {
    const { container } = render(
      <SpectrumChart
        noise={mockNoise}
        filterSettings={{
          gyro_lpf1_static_hz: 250,
          gyro_lpf2_static_hz: 500,
          dterm_lpf1_static_hz: 150,
          dterm_lpf2_static_hz: 150,
          dyn_notch_min_hz: 100,
          dyn_notch_max_hz: 600,
          dyn_notch_count: 3,
        }}
      />
    );

    // 3 noise lines + gyro filter curve + dterm filter curve
    const lines = container.querySelectorAll('.recharts-line');
    expect(lines.length).toBe(5);
    // Legend describing the overlay
    expect(screen.getByText(/Gyro filters/)).toBeInTheDocument();
    expect(screen.getByText(/D-term filters/)).toBeInTheDocument();
    // Dynamic notch range shading
    expect(container.querySelector('.recharts-reference-area')).toBeTruthy();
  });

  it('renders no overlay when all filters are disabled', () => {
    const { container } = render(
      <SpectrumChart
        noise={mockNoise}
        filterSettings={{
          gyro_lpf1_static_hz: 0,
          gyro_lpf2_static_hz: 0,
          dterm_lpf1_static_hz: 0,
          dterm_lpf2_static_hz: 0,
          dyn_notch_min_hz: 0,
          dyn_notch_max_hz: 0,
        }}
      />
    );

    const lines = container.querySelectorAll('.recharts-line');
    expect(lines.length).toBe(3);
    expect(screen.queryByText(/Gyro filters/)).not.toBeInTheDocument();
  });

  it('skips the notch shading when dyn_notch_count is 0', () => {
    const { container } = render(
      <SpectrumChart
        noise={mockNoise}
        filterSettings={{
          gyro_lpf1_static_hz: 250,
          gyro_lpf2_static_hz: 0,
          dterm_lpf1_static_hz: 150,
          dterm_lpf2_static_hz: 0,
          dyn_notch_min_hz: 100,
          dyn_notch_max_hz: 600,
          dyn_notch_count: 0,
        }}
      />
    );

    expect(container.querySelector('.recharts-reference-area')).toBeFalsy();
    // Filter curves still render
    expect(screen.getByText(/Gyro filters/)).toBeInTheDocument();
  });
});

describe('SpectrumChart rule annotations (P3.1)', () => {
  it('tags peaks with the rule they triggered via evidence anchors', () => {
    const { container } = render(
      <SpectrumChart
        noise={mockNoise}
        recommendations={[
          {
            setting: 'gyro_lpf1_static_hz',
            currentValue: 250,
            recommendedValue: 130,
            reason: 'Resonance detected',
            impact: 'both',
            confidence: 'high',
            ruleId: 'F-RES-GYRO',
            evidence: {
              measurements: [{ label: 'Peak frequency', value: '150 Hz' }],
              anchorFrequencyHz: 150,
            },
          },
        ]}
      />
    );

    expect(container.textContent).toContain('F-RES-GYRO');
  });

  it('leaves peaks untagged when no evidence anchor matches', () => {
    const { container } = render(
      <SpectrumChart
        noise={mockNoise}
        recommendations={[
          {
            setting: 'gyro_lpf1_static_hz',
            currentValue: 250,
            recommendedValue: 130,
            reason: 'Noise floor',
            impact: 'both',
            confidence: 'high',
            ruleId: 'F-NF-H-GYRO',
            evidence: { measurements: [] },
          },
        ]}
      />
    );

    expect(container.textContent).not.toContain('F-NF-H-GYRO');
  });
});
