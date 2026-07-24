import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThrottleSpectrogramChart } from './ThrottleSpectrogramChart';
import type {
  ThrottleSpectrogramResult,
  PowerSpectrum,
  ThrottleBand,
} from '@shared/types/analysis.types';
import type { CompactThrottleSpectrogram } from '@shared/types/tuning-history.types';

function makeSpectrum(length: number, fillDb: number): PowerSpectrum {
  const frequencies = new Float64Array(length);
  const magnitudes = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    frequencies[i] = i * 5;
    magnitudes[i] = fillDb + Math.sin(i * 0.1) * 5;
  }
  return { frequencies, magnitudes };
}

function makeResult(bandsWithData: number): ThrottleSpectrogramResult {
  const bands: ThrottleBand[] = [];
  for (let i = 0; i < 10; i++) {
    if (i < bandsWithData) {
      bands.push({
        throttleMin: i * 10,
        throttleMax: (i + 1) * 10,
        sampleCount: 1000,
        spectra: [makeSpectrum(100, -40), makeSpectrum(100, -35), makeSpectrum(100, -45)],
        noiseFloorDb: [-40, -35, -45],
      });
    } else {
      bands.push({
        throttleMin: i * 10,
        throttleMax: (i + 1) * 10,
        sampleCount: 0,
      });
    }
  }
  return {
    bands,
    numBands: 10,
    minSamplesPerBand: 512,
    bandsWithData,
  };
}

describe('ThrottleSpectrogramChart', () => {
  it('renders nothing when no bands have data', () => {
    const { container } = render(<ThrottleSpectrogramChart data={makeResult(0)} />);
    expect(container.querySelector('.spectrogram-chart')).toBeNull();
  });

  it('renders SVG heatmap when data is available', () => {
    const { container } = render(<ThrottleSpectrogramChart data={makeResult(5)} />);
    expect(container.querySelector('.spectrogram-svg')).toBeInTheDocument();
    // Should have rect elements for heatmap cells
    const rects = container.querySelectorAll('.spectrogram-svg rect');
    expect(rects.length).toBeGreaterThan(0);
  });

  it('shows axis tabs without All option', () => {
    render(<ThrottleSpectrogramChart data={makeResult(5)} />);
    expect(screen.getByRole('tab', { name: 'Roll' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pitch' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Yaw' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'All' })).not.toBeInTheDocument();
  });

  it('switches axis when tab clicked', async () => {
    const user = userEvent.setup();
    const { container } = render(<ThrottleSpectrogramChart data={makeResult(5)} />);

    const pitchTab = screen.getByRole('tab', { name: 'Pitch' });
    await user.click(pitchTab);

    // Chart should still render
    expect(container.querySelector('.spectrogram-svg')).toBeInTheDocument();
  });

  it('renders frequency axis labels', () => {
    const { container } = render(<ThrottleSpectrogramChart data={makeResult(5)} />);
    const texts = container.querySelectorAll('text');
    const textContents = Array.from(texts).map((t) => t.textContent);
    expect(textContents).toContain('Frequency (Hz)');
    expect(textContents).toContain('Throttle');
  });

  it('renders colorbar with dB labels', () => {
    const { container } = render(<ThrottleSpectrogramChart data={makeResult(5)} />);
    const texts = Array.from(container.querySelectorAll('text')).map((t) => t.textContent || '');
    const dbLabels = texts.filter((t) => t.includes('dB'));
    expect(dbLabels.length).toBeGreaterThanOrEqual(2);
  });

  it('overlays the gyro LPF1 cutoff line when filterSettings provided', () => {
    const { container } = render(
      <ThrottleSpectrogramChart
        data={makeResult(5)}
        filterSettings={{
          gyro_lpf1_static_hz: 250,
          gyro_lpf2_static_hz: 500,
          dterm_lpf1_static_hz: 150,
          dterm_lpf2_static_hz: 150,
          dyn_notch_min_hz: 100,
          dyn_notch_max_hz: 600,
        }}
      />
    );
    expect(container.querySelector('.spectrogram-svg polyline')).toBeInTheDocument();
    expect(screen.getByText('Gyro LPF1')).toBeInTheDocument();
  });

  it('skips the cutoff overlay when LPF1 is disabled or out of range', () => {
    const disabled = render(
      <ThrottleSpectrogramChart
        data={makeResult(5)}
        filterSettings={{
          gyro_lpf1_static_hz: 0,
          gyro_lpf2_static_hz: 0,
          dterm_lpf1_static_hz: 150,
          dterm_lpf2_static_hz: 150,
          dyn_notch_min_hz: 100,
          dyn_notch_max_hz: 600,
        }}
      />
    );
    expect(disabled.container.querySelector('.spectrogram-svg polyline')).toBeNull();
    disabled.unmount();

    // Cutoff far beyond the spectrogram's max frequency (495 Hz here)
    const outOfRange = render(
      <ThrottleSpectrogramChart
        data={makeResult(5)}
        filterSettings={{
          gyro_lpf1_static_hz: 800,
          gyro_lpf2_static_hz: 0,
          dterm_lpf1_static_hz: 150,
          dterm_lpf2_static_hz: 150,
          dyn_notch_min_hz: 100,
          dyn_notch_max_hz: 600,
        }}
      />
    );
    expect(outOfRange.container.querySelector('.spectrogram-svg polyline')).toBeNull();
  });

  it('renders nothing when neither data nor compactData provided', () => {
    const { container } = render(<ThrottleSpectrogramChart />);
    expect(container.querySelector('.spectrogram-chart')).toBeNull();
  });
});

function makeCompactData(bandCount: number): CompactThrottleSpectrogram {
  const frequencies = Array.from({ length: 50 }, (_, i) => i * 20);
  const bands = [];
  for (let i = 0; i < bandCount; i++) {
    bands.push({
      throttleMin: i * 0.1,
      throttleMax: (i + 1) * 0.1,
      roll: Array.from({ length: 50 }, (_, j) => -40 + j * 0.1),
      pitch: Array.from({ length: 50 }, (_, j) => -35 + j * 0.1),
      yaw: Array.from({ length: 50 }, (_, j) => -45 + j * 0.1),
    });
  }
  return { frequencies, bands, bandsWithData: bandCount };
}

describe('ThrottleSpectrogramChart with compactData', () => {
  it('renders SVG heatmap from compact data', () => {
    const { container } = render(<ThrottleSpectrogramChart compactData={makeCompactData(5)} />);
    expect(container.querySelector('.spectrogram-svg')).toBeInTheDocument();
    const rects = container.querySelectorAll('.spectrogram-svg rect');
    expect(rects.length).toBeGreaterThan(0);
  });

  it('renders nothing for empty compact data', () => {
    const { container } = render(<ThrottleSpectrogramChart compactData={makeCompactData(0)} />);
    expect(container.querySelector('.spectrogram-chart')).toBeNull();
  });

  it('shows axis tabs for compact data', () => {
    render(<ThrottleSpectrogramChart compactData={makeCompactData(3)} />);
    expect(screen.getByRole('tab', { name: 'Roll' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pitch' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Yaw' })).toBeInTheDocument();
  });
});
