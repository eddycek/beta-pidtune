import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecommendationCard, SETTING_LABELS } from './RecommendationCard';

describe('RecommendationCard', () => {
  it('renders setting label from SETTING_LABELS', () => {
    render(
      <RecommendationCard
        setting="gyro_lpf1_static_hz"
        currentValue={250}
        recommendedValue={200}
        reason="Reduce noise"
        impact="noise"
        confidence="high"
      />
    );

    expect(screen.getByText('Gyro Lowpass 1')).toBeInTheDocument();
  });

  it('falls back to raw setting name for unknown keys', () => {
    render(
      <RecommendationCard
        setting="unknown_setting"
        currentValue={100}
        recommendedValue={90}
        reason="Test"
        impact="test"
        confidence="medium"
      />
    );

    // Both label and setting show the same value, so check for multiple
    expect(screen.getAllByText('unknown_setting')).toHaveLength(2);
  });

  it('shows current and recommended values', () => {
    render(
      <RecommendationCard
        setting="gyro_lpf1_static_hz"
        currentValue={250}
        recommendedValue={200}
        reason="Reduce noise"
        impact="noise"
        confidence="high"
      />
    );

    expect(screen.getByText('250')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
  });

  it('shows unit suffix when provided', () => {
    render(
      <RecommendationCard
        setting="gyro_lpf1_static_hz"
        currentValue={250}
        recommendedValue={200}
        reason="Reduce noise"
        impact="noise"
        confidence="high"
        unit="Hz"
      />
    );

    expect(screen.getByText('250 Hz')).toBeInTheDocument();
    expect(screen.getByText('200 Hz')).toBeInTheDocument();
  });

  it('shows increase percentage for value going up', () => {
    render(
      <RecommendationCard
        setting="pid_roll_p"
        currentValue={40}
        recommendedValue={50}
        reason="Increase P gain"
        impact="stability"
        confidence="high"
      />
    );

    expect(screen.getByText('+25%')).toBeInTheDocument();
  });

  it('shows decrease percentage for value going down', () => {
    render(
      <RecommendationCard
        setting="gyro_lpf1_static_hz"
        currentValue={250}
        recommendedValue={200}
        reason="Reduce noise"
        impact="noise"
        confidence="high"
      />
    );

    expect(screen.getByText('-20%')).toBeInTheDocument();
  });

  it('hides change badge when values are equal', () => {
    render(
      <RecommendationCard
        setting="pid_roll_p"
        currentValue={50}
        recommendedValue={50}
        reason="No change needed"
        impact="stability"
        confidence="high"
      />
    );

    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('shows confidence level', () => {
    render(
      <RecommendationCard
        setting="gyro_lpf1_static_hz"
        currentValue={250}
        recommendedValue={200}
        reason="Reduce noise"
        impact="noise"
        confidence="high"
      />
    );

    expect(screen.getByText('HIGH')).toBeInTheDocument();
  });

  it('renders feedforward labels from SETTING_LABELS', () => {
    expect(SETTING_LABELS['feedforward_boost']).toBe('Feedforward Boost');
    expect(SETTING_LABELS['feedforward_smooth_factor']).toBe('FF Smoothing');
    expect(SETTING_LABELS['feedforward_jitter_factor']).toBe('FF Jitter Factor');
    expect(SETTING_LABELS['feedforward_transition']).toBe('FF Transition');
    expect(SETTING_LABELS['feedforward_max_rate_limit']).toBe('FF Max Rate Limit');
  });

  it('renders feedforward_boost with correct label', () => {
    render(
      <RecommendationCard
        setting="feedforward_boost"
        currentValue={15}
        recommendedValue={10}
        reason="Reduce FF boost to lower overshoot"
        impact="overshoot"
        confidence="medium"
      />
    );

    expect(screen.getByText('Feedforward Boost')).toBeInTheDocument();
    expect(screen.getByText('feedforward_boost')).toBeInTheDocument();
  });

  it('shows special text for increase from zero', () => {
    render(
      <RecommendationCard
        setting="pid_yaw_d"
        currentValue={0}
        recommendedValue={15}
        reason="Add D gain"
        impact="stability"
        confidence="medium"
      />
    );

    expect(screen.getByText('+15')).toBeInTheDocument();
  });
});

describe('RecommendationCard evidence (P3.1)', () => {
  it('renders the measured-evidence block when evidence is provided', () => {
    render(
      <RecommendationCard
        setting="gyro_lpf1_static_hz"
        currentValue={250}
        recommendedValue={120}
        reason="Strong resonance detected"
        impact="both"
        confidence="high"
        evidence={{
          measurements: [
            { label: 'Peak frequency', value: '160 Hz' },
            { label: 'Peak amplitude', value: '25 dB above floor' },
          ],
          trigger: 'Peak ≥ 12 dB below the effective cutoff',
          anchorFrequencyHz: 160,
        }}
      />
    );

    expect(screen.getByText('Why? Measured evidence')).toBeInTheDocument();
    expect(screen.getByText('Peak frequency:')).toBeInTheDocument();
    expect(screen.getByText(/160 Hz/)).toBeInTheDocument();
    expect(screen.getByText('Peak ≥ 12 dB below the effective cutoff')).toBeInTheDocument();
  });

  it('omits the evidence block when no evidence is provided', () => {
    render(
      <RecommendationCard
        setting="gyro_lpf1_static_hz"
        currentValue={250}
        recommendedValue={120}
        reason="Strong resonance detected"
        impact="both"
        confidence="high"
      />
    );

    expect(screen.queryByText('Why? Measured evidence')).not.toBeInTheDocument();
  });
});
