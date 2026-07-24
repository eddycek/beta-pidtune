# PID Tuning Knowledge Base

> Comprehensive FPV drone tuning reference. Sections 1-5 and 8-15 reflect **community consensus**
> from Betaflight docs, Oscar Liang, Joshua Bardwell, Plasmatree PID-Analyzer, PIDtoolbox, UAV Tech,
> and FPVSIM. Sections 6-7 document **FPVPIDlab-specific decision rules** and where they differ from
> community defaults, with rationale.
>
> This document serves as the single source of truth. FPVPIDlab's `constants.ts` should be validated
> against the values documented here — not the other way around.

---

## 1. PID Control Theory for FPV

### P-term (Proportional)

- Reacts to **current error** (setpoint - gyro)
- Higher P = faster response, sharper stick feel, but can cause oscillation
- Too high: high-frequency oscillation visible on bench, hot motors, audible buzz
- Too low: mushy/sluggish feel, slow to follow stick inputs, "floaty" sensation
- P is the primary "responsiveness" knob — most pilots notice P changes immediately

**Community starting values (5" freestyle):**
- Bardwell method: P=46 roll, P=50 pitch, P=65 yaw — then adjust by feel
- BF defaults: typically P=42-50 for roll/pitch
- FPVSIM: "35-45 should work for regular 5 inch"
- General practical range: **30-100** (BF internal units, firmware allows 0-250)

### I-term (Integral)

- Accumulates **past error** over time — eliminates steady-state offset
- Higher I = better hover stability, tighter attitude hold in wind
- Too high: I-term windup → bounce-back after flips/rolls, slow low-frequency wobble on hover
- Too low: drift on hover, poor wind rejection, attitude offset after aggressive maneuvers
- I-term works on a longer timescale than P or D — changes feel subtle compared to P/D adjustments
- Key metric: **steady-state error** — if gyro consistently undershoots setpoint by >3%, I is too low

**Community values:**
- BF defaults: I=45-50 for roll/pitch, I=45 for yaw
- Bardwell: I=45-50 starting point
- FPVSIM: "30-40 is good for normal 5 inch"
- General practical range: **30-120** (firmware allows 0-250)

### D-term (Derivative)

- Reacts to **rate of change** of error — dampens P oscillation, resists rapid changes
- Higher D = more damping, less overshoot, but amplifies high-frequency noise
- Too high: hot motors (noise amplification), vibration, potential motor desync
- Too low: overshoot after stick input, prop wash oscillation on descents, bounce-back
- D is the most noise-sensitive term: always ensure filters are properly tuned before raising D
- **Critical tradeoff**: D dampening vs noise amplification — BF wiki: "D magnifies noise by 10x to 100x"

**Community values:**
- Bardwell: D=25-27 starting for 5" (roll/pitch), D=0 for yaw
- BF defaults: D=25-35 for roll/pitch
- General practical range: **20-70** (firmware allows 0-250)
- Above ~60 typically only on very clean builds with RPM filter

### D/P Damping Ratio

- The ratio of D to P gain determines how damped the system is
- **Community consensus**: D/P ≈ 0.5-0.65 is typical BF default range
- FPVSIM recommends starting at D/P ≈ 0.6 for 5" quads
- Below ~0.5: under-damped → overshoot, oscillation, bounce-back
- Above ~0.8: over-damped → sluggish response, excessive noise amplification from D
- Bardwell method: "Find the ideal damping slider value, then lock the P/D ratio"
- Oscar Liang: "Maybe bump up P/D balance by 5-10% after finding ideal Damping value"
- **Yaw exception**: Yaw D is often 0 in BF defaults — D/P ratio applies primarily to roll/pitch

### Feedforward (FF)

- Predicts future error from **stick movement speed** (derivative of setpoint)
- Improves tracking during fast moves without affecting hover stability (zero contribution at rest)
- Unlike P/I/D which are reactive, FF is proactive — anticipates where the quad should be

**Key FF Parameters (BF 4.3+):**
- `feedforward_boost`: Amplifies FF on fast stick inputs (0-50, default 15)
- `feedforward_transition`: Blends FF between roll/pitch and yaw (0-100)
- `feedforward_smooth_factor`: Smooths FF to reduce jitter (0-75, default 25)
- `feedforward_jitter_factor`: Attenuates FF on slow/noisy stick inputs (0-20, default 7)
- `feedforward_averaging`: Averages consecutive stick deltas for smoother FF (0-4)

**FF 2.0 (BF 4.3+):**
- Replaced legacy `ff_interpolate_sp` with per-axis feedforward weight
- Smart feedforward: only acts on genuine stick movement, rejects RC link jitter
- `feedforward_jitter_factor` is the key anti-jitter control — higher values suppress more jitter but reduce response to subtle stick inputs

**Community values:**
- Bardwell starting: FF=100 all axes
- BF defaults: FF=100-120 for roll/pitch

**Gotcha**: High FF can look like P overshoot in step response analysis — check whether the leading-edge spike correlates with stick movement speed before reducing P.

**RC Link-Aware FF Profiles (Community Consensus):**

FF parameters must match RC link packet rate. High-rate links (ELRS 250Hz+) need
averaging to smooth discrete steps. Low-rate links (Crossfire 50Hz) must NOT average
or latency is unacceptable.

| RC Link Rate | feedforward_averaging | feedforward_smooth_factor | feedforward_jitter_factor | feedforward_boost |
|-------------|-------------|-----------------|-----------------|----------|
| ≤60 Hz (CRSF 50Hz) | OFF | 0 | 10 | 5 |
| 61-149 Hz (CRSF 150Hz) | OFF | 30 | 7 | — (default) |
| 150-249 Hz (CRSF Dynamic) | OFF | 15 | 10 | 10 |
| 250-499 Hz (ELRS/Tracer) | 2_POINT | 35 | 4-5 | 18 |
| ≥500 Hz (ELRS) | 2_POINT | 65 | 3-5 | 18 |

Sources: SupaflyFPV 4.5 presets, UAV Tech radio options, Karate race presets.

`rc_smoothing_auto_factor`: Most presets set 45 (BF default 30). Higher = smoother input
but slightly more latency. Racing presets use 25-35, freestyle/cinema 45-50.
FPVPIDlab's FF-RC-SMOOTH advisory (raise 30 → 45) is therefore **skipped for aggressive
style** — pushing a racer from 30 to 45 would contradict the racing 25-35 range.

---

## 2. Filter Architecture (Betaflight)

### Signal Chain

```
Gyro sensor (8 kHz sample rate)
  → RPM Filter (motor harmonic notches, 36 filters, requires bidirectional DSHOT)
  → Dynamic Notch filters (1-5 notches per axis, SDFT-based auto-tracking)
  → Gyro LPF1 (static or dynamic lowpass — main noise reduction)
  → Gyro LPF2 (static lowpass — secondary cleanup)
  → PID controller
    → D-term derivative computation
    → D-term LPF1 (static or dynamic lowpass)
    → D-term LPF2 (static lowpass)
  → Motor output mixing
```

**Note**: Filter order matters. RPM filter runs first (highest priority, removes known harmonics), then dynamic notch (tracks remaining peaks), then lowpass (catches everything else). This order maximizes noise removal while minimizing phase delay.

### Filter Types

| Type | Order | Rolloff | Delay | Use Case |
|------|-------|---------|-------|----------|
| **PT1** | 1st | -20 dB/decade | Lowest | Gyro/D-term LPF (default, preferred) |
| **PT2** | 2nd | -40 dB/decade | Low | Gyro LPF (BF 4.3+ replacement for biquad) |
| **PT3** | 3rd | -60 dB/decade | Medium | Aggressive noise situations |
| **Biquad LPF** | 2nd | -40 dB/decade | Higher (resonant peak) | D-term LPF (alternative) |
| **Notch (band-reject)** | 2nd | Narrow band | Low (away from center) | Motor harmonics, resonances |

**PT1** (First-Order Lowpass):
- Transfer function: H(s) = ωc / (s + ωc)
- -3 dB at cutoff frequency, gentle rolloff
- Minimal group delay — preferred for latency-sensitive paths

**Biquad LPF** (Second-Order):
- Transfer function: H(s) = ω₀² / (s² + (ω₀/Q)s + ω₀²)
- -6 dB at cutoff, steeper rolloff than PT1
- Can have slight gain peak near cutoff (depending on Q)
- More delay than PT1 — use when stronger filtering is needed

**Notch (Band-Reject)**:
- Transfer function: H(s) = (s² + ω₀²) / (s² + (ω₀/Q)s + ω₀²)
- Deep null at center frequency, passes everything else
- Q controls width: higher Q = narrower notch = less signal distortion
- Advantage over lowpass: less latency while giving strong reduction at target frequency (Oscar Liang)

### Key Filter Parameters & BF Defaults

| Parameter | BF Default | Description |
|-----------|-----------|-------------|
| `gyro_lpf1_static_hz` | 250 | Main gyro lowpass cutoff (0 = disabled) |
| `gyro_lpf1_dyn_min_hz` | 250 | Dynamic lowpass minimum (0 = static mode) |
| `gyro_lpf1_dyn_max_hz` | 500 | Dynamic lowpass maximum |
| `gyro_lpf2_static_hz` | 500 | Second gyro lowpass cutoff |
| `dterm_lpf1_static_hz` | 150 | Main D-term lowpass cutoff |
| `dterm_lpf2_static_hz` | 150 | Second D-term lowpass cutoff |
| `dyn_notch_min_hz` | 100 | Dynamic notch minimum tracking freq |
| `dyn_notch_max_hz` | 600 | Dynamic notch maximum tracking freq |
| `dyn_notch_count` | 3 | Number of dynamic notch filters per axis |
| `dyn_notch_q` | 300 | Dynamic notch Q factor (BF stores ×100 internally) |
| `rpm_filter_harmonics` | 3 | Motor harmonics to filter (0 = disabled) |
| `rpm_filter_min_hz` | 100 | Minimum RPM filter frequency |

### BF Official Filter Recommendations

From BF Tuning Guide and community consensus:

| Scenario | Gyro LPF1 | D-term LPF1 | Source |
|----------|-----------|-------------|--------|
| **Default/optimal** | 100 Hz | 110 Hz | BF Tuning Guide |
| **Slightly noisy** | 80 Hz | 100 Hz | BF Tuning Guide |
| **Very noisy** | 50 Hz | 100 Hz | BF Tuning Guide |
| **Clean + RPM filter** | 200-400 Hz | 150-200 Hz | Community consensus |

**Safety rule of thumb**: The BF docs' "avoid below 100 Hz" guidance strictly refers to **notch filters** (dyn_notch_min_hz), not the gyro lowpass. For gyro/D-term lowpasses, the community floor is lower — Oscar Liang puts the D-term floor around ~80 Hz. FPVPIDlab still applies a conservative 100 Hz gyro LPF1 floor (see Section 6) as a **house rule**: below it, phase delay degrades prop wash handling.

**D-term filter**: Oscar Liang notes "70-90 Hz may work, with 90 Hz offering best control and prop-wash handling at the cost of a little heat."

### Dynamic Lowpass (Throttle-Tracking)

- When `gyro_lpf1_dyn_min_hz > 0`, gyro LPF1 becomes dynamic
- When `dterm_lpf1_dyn_min_hz > 0`, D-term LPF1 becomes dynamic
- Cutoff frequency tracks throttle position: low throttle → min_hz, high throttle → max_hz
- **Purpose**: At low throttle, motor noise is low-frequency — filter must track down. At high throttle, noise shifts up — filter can relax
- **D-term dynamic lowpass**: D amplifies high-frequency noise (derivative operation). Dynamic D-term filtering reduces motor heating at high throttle while preserving stick feel at cruise. FPVPIDlab recommends D-term dynamic lowpass alongside gyro when throttle-dependent noise is detected
- BF dynamic ranges: Low 83-500 Hz, Medium 110-660 Hz, High 166-900 Hz
- Useful for quads without RPM filter (no bidirectional DSHOT)

### Dynamic Lowpass Preset Values (Community Consensus)

BF simplified tuning uses a consistent formula:
- `gyro_lpf1_dyn_min_hz = 250 × multiplier / 100`
- `gyro_lpf1_dyn_max_hz = 500 × multiplier / 100` (always 2× dyn_min)
- `gyro_lpf1_static_hz = dyn_min` (BF convention: static = dyn_min when dynamic enabled)
- D-term uses same pattern with base 75/150 Hz

When dynamic lowpass is enabled (dyn_min > 0), the **2:1 ratio** (max = 2 × min) is universal across all BF presets and simplified tuning modes.

#### Preset Multiplier Comparison

| Preset | Quad | Gyro Mult | Gyro LPF1 | DTerm Mult | DTerm min/max | RPM? |
|--------|------|-----------|-----------|-----------|--------------|------|
| BF Default | generic | 100 | 250/500 (dyn) | 100 | 75/150 | No |
| SupaflyFPV 4.4 EasyTune | 3-4" | 160 (slider) | **disabled** (RPM handles it) | 140 | 105/210 | Yes |
| SupaflyFPV 4.4 EasyTune | 5" | 160 (slider) | **disabled** (RPM handles it) | 140 | 105/210 | Yes |
| SupaflyFPV 4.4 EasyTune | 6" | 120 (slider) | **disabled** (RPM handles it) | 140 | 105/210 | Yes |
| SupaflyFPV 4.4 EasyTune | 7" | 80 (slider) | **disabled** (RPM handles it) | 140 | 105/210 | Yes |
| UAV Tech | 5" | 60 | 150/300 (dyn) | 120 | 90/180 | Optional |
| BF RPM Clean | 5" clean | 175 | 0(off)/875 | 105 | 78/157 | Yes |
| BF RPM Normal | 5" typical | 100 | 0(off)/500 | 100 | 75/150 | Yes |
| BF RPM Noisy | 5" worn | 50 | 0(off)/250 | 85 | 63/127 | Yes |

**Key observations:**
- With RPM filter active, current presets DISABLE gyro LPF1 entirely (static=0, dyn_min=0), relying on RPM+LPF2+notches. Current SupaflyFPV 4.4 EasyTune presets do this across all sizes (gyro slider multipliers 160/160/120/80 for 3-4"/5"/6"/7" only shape LPF2/notch behavior)
- D-term multiplier tends to be higher than gyro multiplier (SupaflyFPV: dterm=140 across all sizes)
- UAV Tech uses the most conservative gyro filtering (mult=60 → dyn_min=150 Hz)
- The simplified-tuning 2:1 ratio (dyn_max = 2 × dyn_min) is confirmed from BF Configurator source

**FPVPIDlab rule**: When enabling dynamic lowpass, use `dyn_min = current static_hz`, `dyn_max = static_hz × 2` (matching BF 2:1 convention). Source: betaflight/firmware-presets.

### Dynamic Notch (SDFT-Based)

- Uses Sliding Discrete Fourier Transform to track noise peaks in real-time
- Up to 5 notches per axis, each independently tracking a noise peak
- Responds to changing conditions (throttle, maneuvers) within ~50ms
- **Without RPM filter**: Needs 3-5 notches to track motor harmonics + frame resonance
- **With RPM filter**: Motor harmonics already handled → community recommends reducing to 1-2 notches, increasing Q (narrower, less signal distortion)

### RPM Filter (Bidirectional DSHOT)

- **Most effective filter** — removes exact motor harmonics with minimal latency
- Requires bidirectional DSHOT protocol (ESC sends RPM telemetry back to FC)
- **36 notches total**: 4 motors × 3 harmonics × 3 axes (roll/pitch/yaw)
- Each notch precisely tracks actual motor RPM → zero frequency estimation error
- With RPM filter active, other filters can be significantly relaxed (higher cutoffs, fewer notches)
- `rpm_filter_harmonics`: 1-3 (default 3). BF 4.5+ allows dimmable harmonics (adjustable notch depth per harmonic)
- `rpm_filter_min_hz`: Minimum frequency (100 Hz default) — prevents notches from tracking below useful range
- **Motor poles config**: `motor_poles` must match actual motor (typically 14 for standard FPV motors). Wrong value = RPM filter tracks wrong frequencies

### RPM Filter Q and Weights (Community Presets)

RPM filter Q controls notch bandwidth — lower Q = wider notch = catches more noise but adds delay.

**Community values by drone size (from SupaflyFPV, UAV Tech presets):**

| Size | rpm_filter_q | rpm_filter_weights | Reasoning |
|------|-------------|-------------------|-----------|
| 1-2.5" | 700-1000 | 100,50,100 | Small motors — narrow harmonics |
| 3-4" | 700-1000 | 100,50,100 | SupaflyFPV EasyTune sets Q=1000 for 3-4" (same as 5") |
| 5" | 700-1000 | 90,50,90 | Standard — narrow harmonics (SupaflyFPV: 1000) |
| 6" | 600-800 | 90,50,90 | Larger props — wider harmonic spread (SupaflyFPV: 800) |
| 7"+ | 500-700 | 90,60,90 | Widest spread, needs broad Q (SupaflyFPV: 700) |

**Preset philosophy differences**: SupaflyFPV scales Q by size (3-4"/5"=1000, 6"=800, 7"=700).
UAV Tech leaves Q at the BF default 500 for all sizes. The official BF basic presets scale Q by
build **cleanliness**, not size (clean 750 → noisy 350). FPVPIDlab follows the SupaflyFPV
size-based scaling.

`rpm_filter_weights` (BF 4.5+): Per-harmonic notch depth (1st, 2nd, 3rd). 100 = full depth.
Second harmonic (2nd value) typically lower (30-50) — less energy in 2nd harmonic for most props.

`rpm_filter_fade_range_hz`: Range below `rpm_filter_min_hz` where notch fades out (default 50, SupaflyFPV uses 50, Karate uses 100 on race builds).

### Group Delay

- Every filter adds latency (group delay) between stick input and motor response
- More aggressive filtering = more delay = worse handling feel
- BF community: "Even one millisecond difference in latency can have a significant impact"
- Normal D delay is about 5ms, motor time constant ~15ms (BF Tuning Notes)
- **Goal**: Minimize total filter delay while keeping noise under control
- PT1 < PT2 < Biquad in terms of delay at same cutoff frequency
- **BF doc delay rules of thumb**: PT1 ≈ 1 ms at 100 Hz cutoff, biquad ≈ 2 ms; PT2 adds ~60% over PT1, PT3 ~2× PT1
- Notch filters add delay primarily near their center frequency, minimal elsewhere. **Notch phase anchor** (BF filtering doc): 90° phase shift at the notch center, 45° at the −3 dB edges
- **BF 4.3+ defaults ALL gyro and D-term lowpasses (LPF1 and LPF2) to PT1** — biquad remains a CLI option only. Delay models should assume PT1 unless the filter type is explicitly set to biquad

### BF Version Filter Changes

- **BF 4.3**: Removed biquad option from gyro LPF (PT1/PT2/PT3 only) and defaulted all remaining lowpasses (gyro + D-term, LPF1 + LPF2) to PT1; introduced slider system for filter tuning
- **BF 4.5**: Dimmable RPM harmonics (per-harmonic notch depth), low-throttle TPA
- **BF 4.6 (2025.12)**: DEBUG_GYRO_SCALED removed, chirp signal generator for transfer function analysis

---

## 3. Noise Analysis

### Noise Sources

| Source | Frequency | Characteristics | Fix Strategy |
|--------|-----------|----------------|--------------|
| **Prop wash** | 20-90 Hz | Broadband burst during descents/deceleration | D-term, flying technique, I-term relax |
| **Frame resonance** | 80-200 Hz (5"; size-aware via `FRAME_RESONANCE_BY_SIZE`: 1"/2.5" 150-350, 3" 120-280, 4" 100-240, 6" 70-170, 7" 60-150) | Fixed frequency, constant at all throttle levels | Notch filter, structural reinforcement |
| **Motor noise** | 150-400 Hz | Tracks with throttle (RPM), harmonic pattern | RPM filter, lowpass cutoff |
| **Electrical noise** | >500 Hz | High frequency, ESC switching noise | Lowpass filter, capacitors |
| **Bearing noise** | Variable | Broadband, worsens with bearing wear | Replace bearings/motors |
| **Gyro noise** | >1000 Hz | Sensor self-noise, aliased content | Hardware (better gyro chip) |

Sources: BF wiki, Oscar Liang Filtering 101, UAV Tech

### Motor Noise Fundamentals

Motor noise frequency depends on RPM and magnet count:
```
fundamental_hz = (RPM / 60) × (motor_poles / 2)
```
For a typical 14-pole motor at 20,000 RPM: `(20000/60) × 7 = 2333 Hz` (mostly filtered by hardware anti-alias)

At lower throttle (5,000 RPM): `(5000/60) × 7 = 583 Hz` — this is where motor noise matters for PID loop

Harmonics appear at 2×, 3×, etc. of the fundamental — RPM filter places notches at each harmonic.

### Noise Floor Measurement

- Background noise level across the spectrum, measured in power spectral density (PSD)
- Measured per axis (roll, pitch, yaw)
- **Scale depends on tool and normalization** — different tools (BF Explorer, PIDtoolbox, BlackBox Mate) use different dB references
- BlackBox Mate (BBM): default scale -40 to +10 dBm, uses `10 × log10(PSD)`
- Oscar Liang: "For D-term, it's ideal to have the overall noise floor below -10 dB" (relative to D-term signal)
- Lower noise floor = cleaner quad = can use less aggressive filtering

**General noise floor interpretation** (qualitative, tool-independent):
- **Very clean**: Flat spectrum, no visible peaks, filtering can be relaxed
- **Normal**: Some motor harmonics visible, standard filtering adequate
- **Noisy**: Prominent peaks, broadband elevation — lower cutoffs needed
- **Very noisy**: High broadband noise, multiple resonances — aggressive filtering, check hardware

### Peak Detection

- Peaks above noise floor indicate specific noise sources
- Peak frequency + throttle correlation identifies source:
  - **Fixed frequency** across throttle bands = frame/prop resonance
  - **Throttle-tracking** frequency = motor harmonics
  - **Multiple equally-spaced peaks** (≥3) = motor harmonic series
- PIDtoolbox and BF Explorer both show peaks in spectral view

### Throttle Spectrogram

- FFT computed per throttle band (typically 10 bands from 0-100%)
- Reveals how noise changes with throttle position
- Motor harmonics appear as diagonal lines (frequency increases with throttle)
- Frame resonance appears as vertical line (constant frequency across all bands)
- Community recommendation: 2 kHz logging rate for spectrum analysis (BF dev team, Oscar Liang)

### Clean Spectrum Characteristics

A well-tuned quad's noise spectrum shows:
- Flat, low noise floor
- No prominent peaks (or only small frame resonance handled by notch)
- Minimal difference between axes (symmetric build)
- Noise doesn't increase dramatically with throttle (good motor/prop balance)

---

## 4. Step Response Analysis

### What Good Looks Like (Community Consensus)

| Metric | Typical Good Range | Description | Source |
|--------|-------------------|-------------|--------|
| **Rise time** | 20-50 ms | Time from 10% to 90% of final value | PIDtoolbox, FPVSIM |
| **Overshoot** | 5-15% | Peak above setpoint (% of step magnitude) | Oscar Liang, PIDtoolbox |
| **Settling time** | 50-200 ms | Time to stay within tolerance band | BF: "FF makes 150-200ms normal" |
| **Ringing** | < 2 oscillations | Oscillations after initial overshoot | BF wiki, PIDtoolbox |
| **Latency** | < 20 ms | Delay before response starts | General control theory |

**Note**: Exact "ideal" overshoot is debated. Oscar Liang suggests "a little overshoot (5-10%) might be acceptable or even favorable." PIDtoolbox emphasizes minimizing overshoot while maintaining fast rise time. FPVSIM focuses on visual P/D balance rather than specific percentages. Control theory standard for ≤10% maps to damping ratio ≥0.6.

### Standard Definitions

- **Rise time**: 10% to 90% of final value (standard control theory convention)
- **Settling time**: Within ±2% (strict) or ±5% (relaxed) of steady-state value
- **Overshoot**: `(peak - target) / |step_magnitude| × 100%`
- **Ringing**: Number of oscillation cycles after initial overshoot
- **Latency**: Time until response reaches 5% of step magnitude
- **Steady-state error**: Mean |setpoint - gyro| after settling

### Problem Signatures

| Symptom | Likely Cause | Primary Fix | Secondary Fix |
|---------|-------------|-------------|---------------|
| High overshoot (>20%) | P too high or D too low | Reduce P or increase D | Check D/P ratio |
| Slow rise time (>80ms) | P too low | Increase P | Check FF settings |
| Long settling (>200ms) | D too low, poor damping | Increase D | Check I-term |
| Excessive ringing (>2) | D too low for P level | Increase D, check D/P ratio | Reduce P |
| Steady-state offset (>5%) | I too low | Increase I | Check I-term relax |
| Bounce-back after flips | I too high (windup) | Reduce I | Increase I-term relax |
| Asymmetric response | Mechanical issue | Check hardware | Bent prop, loose motor |
| Leading-edge spike | FF too high | Reduce feedforward_boost | Check FF energy ratio |

Sources: BF PID Tuning Guide, Oscar Liang, Bardwell, PIDtoolbox

### Prop Wash

- Oscillation during descents (quad flies through own turbulence)
- Appears as 20-90 Hz noise burst after throttle-down events
- Primary fix: increase D-term (dampens oscillation)
- Secondary: adjust `iterm_relax`, increase dynamic idle, adjust flying style
- Severity varies: mild (barely noticeable) to severe (visible jello in video, audible oscillation)
- Community consensus: "D is the primary tool against prop wash, but too much D amplifies noise"

### Propwash Tuning Strategy (Community Consensus)

Propwash oscillation occurs during throttle transitions (descent → climb) when disturbed airflow causes 20-90 Hz gyro oscillation. The three key anti-propwash parameters:

**d_min (BF 4.0+)**
- Provides low D at rest (less noise amplification) and high D during propwash/flips
- `d_min` = minimum D value. `D` in PID config = maximum (d_max)
- `d_min_gain` controls how fast D ramps up (20 = default/racing, 30-35 = freestyle)
- During propwash, D typically climbs about halfway to d_max
- BF firmware defaults (4.4/4.5, `pid.h`): d_min_roll=30, d_min_pitch=34 with D(=d_max)=40/46; d_min_yaw=0, gain=20, advance=20
- **BF 2025.12 (4.6) rename**: `d_min` became the base `d` (defaults 30/34), the old `D` became `d_max` (defaults 40/46), and the `d_min` setting was removed. The rename shipped in 2025.12, NOT in 4.5
- Freestyle recommendation: d_min close to D, d_max 20-40% higher, gain=30-35

**iterm_relax (BF 3.4+)**
- Suppresses I accumulation during fast maneuvers, preventing bounce-back
- Lower cutoff = more suppression = less bounce-back
- Racing: cutoff 30-40 (BF wiki, "I Term Relax Explained": "30-40 is good for racing"; race whoop presets span 20-45), Freestyle: 10-15, Heavy/7" quads: 5-7
- BF default: mode=RP, type=SETPOINT, cutoff=15
- If bounce-back after flips: reduce cutoff from 15 → 10 → 7 → 5

**TPA and propwash interaction**
- High TPA rate + low breakpoint reduces effective D during climb after descent
- For propwash: prefer D-only mode (not PD), rate ≤ 65, breakpoint ≥ 1350
- Karate Race: rate=70, breakpoint=1250 (more aggressive, racing focus)
- BF defaults: rate=65, breakpoint=1350, mode=D

**Preset comparison:**

| Preset | d_min R/P | d_min gain | iterm_relax_cutoff | tpa_rate | tpa_breakpoint |
|--------|-----------|------------|-------------------|----------|---------------|
| BF tune defaults (simplified tuning) | 30/34 | 20 | 15 | 65 | 1350 |
| Karate Race | 22/22 | 20 | 20 | 70 | 1250 |
| Karate Race Spicy | 26/26 | 20 | 20 | 70 | 1250 |

**FPVPIDlab propwash rules:**
- PW-DMIN-GAIN: increase d_min_gain when propwash severe + gain below style-aware target. Targets vary by flight style and drone size (5": smooth=20, balanced=25, aggressive=30; 6": smooth=15, balanced=20, aggressive=25). Falls back to size default gain when style has no entry, or to DMIN_GAIN_FREESTYLE (35) when size unknown
- PW-DMIN-GAP: widen d_min/d_max gap when < 20% of d_max
- PW-DMIN-ENABLE: enable d_min when propwash severe + currently disabled
- PW-IRELAX-CUTOFF: lower cutoff by 5 per iteration (floor=7) when propwash severe (≥5×). Follows community guidance "reduce 15→10→7→5" — allows progressive reduction from BF default 15 down to floor 7 across multiple tuning sessions
- PW-IRELAX-CUTOFF-MOD: lower cutoff by 5 with floor=15 when propwash moderate (2-5×) — milder suppression, low confidence
- PW-IRELAX-ENABLE: enable iterm_relax when disabled + propwash detected
- PW-TPA-MODE: prefer D-only when propwash severe
- PW-TPA-BREAKPOINT: raise breakpoint to 1350 when < 1300
- PW-TPA-RATE: cap rate at 65 when propwash severe

---

## 5. Transfer Function Analysis (Wiener Deconvolution)

### Concept

Computes the closed-loop transfer function H(f) from setpoint → gyro using frequency-domain deconvolution:
```
H(f) = S_xy(f) / (S_xx(f) + ε)
```
Where:
- S_xy = cross-spectral density = **gyro × conjugate of setpoint** (Y·conj(X) — output times conjugated input, the correct orientation for H = output/input)
- S_xx = input auto-spectral density (setpoint power)
- ε = regularization term (prevents division by zero at low-energy frequencies)

Works from **any flight data** — no dedicated maneuvers needed. Pioneered by Plasmatree PID-Analyzer.

### Methodology (Plasmatree)

1. **Windowing**: Divide signal into overlapping windows (50% overlap, Hanning windowed)
   - Plasmatree default: 2s windows at sample rate
2. **FFT**: Compute complex spectra for setpoint (X) and gyro (Y)
3. **Accumulate**: S_xy += Y × conj(X), S_xx += |X|²
4. **Regularization**: Noise-floor-aware epsilon prevents division by zero
5. **Transfer function**: H(f) = S_xy / (S_xx + ε)
6. **Extract**: Magnitude (dB) and phase (degrees) from H(f)

### Key Metrics (General Control Theory)

**Bandwidth (-3 dB):**
- Highest frequency where |H(f)| ≥ DC_gain - 3 dB
- Higher bandwidth = more responsive system
- Typical for well-tuned 5" quad: 30-80 Hz

**Phase Margin:**
- Phase difference from -180° at the gain crossover frequency (where |H(f)| = 0 dB)
- Higher = more stable, lower = closer to oscillation
- Phase margin = 180° + phase_at_crossover
- General control theory: >45° = good stability, 30-45° = marginal, <30° = near instability

**DC Gain:**
- Low-frequency magnitude of H(f). FPVPIDlab computes it as the **average over the 1-5 Hz band**, not bin 0 — without detrending, the raw DC bin is dominated by signal offsets and is unreliable. The -3 dB bandwidth reference uses the same band average
- 0 dB = perfect 1:1 steady-state tracking
- Negative DC gain indicates I-term may be too low

**Gain Margin:**
- How much gain could increase before instability
- Measured at phase crossover frequency (where phase = -180°)
- General control theory: >6 dB = good, 3-6 dB = marginal, <3 dB = near instability

### Synthetic Step Response

- IFFT of H(f) → impulse response → cumulative sum → step response
- Allows step response estimation from any flight without dedicated stick snaps
- Less accurate than direct step measurement but works universally
- Plasmatree PID-Analyzer: "The step response should get to a value of 1 in lowest possible time"
- Overshoot and settling extracted same as time-domain step analysis

---

## 6. FPVPIDlab Decision Rules

> **This section documents FPVPIDlab-specific algorithms and thresholds.** Where FPVPIDlab values differ
> from community defaults, the rationale is explained. These rules are implemented in
> `src/main/analysis/` and thresholds live in `src/main/analysis/constants.ts`.

### Noise Floor Scale (FPVPIDlab-Specific)

FPVPIDlab uses a **calibrated one-sided power spectrum** (`SPECTRUM_SCALE_VERSION = 2` in `constants.ts`): segments are detrended (mean removed), Hanning-windowed, normalized by coherent window gain ((Σw)²), Welch-averaged in the power domain, and reported as `10·log10(power)` in dB re (deg/s)². Calibration: a sine of amplitude A reads exactly `10·log10(A²/2)` at its bin, independent of FFT size and sample rate; white-noise floors depend only on FFT size (per-bin power ≈ 2σ²·ENBW/N ≈ 3σ²/N for Hanning), not sample rate. The scale sits ≈10 dB above the legacy v1 amplitude-averaged scale and is still **not directly comparable** to BF Explorer or PIDtoolbox dB values — each tool normalizes differently. Metrics stored by v1 app versions are ≈10 dB lower than v2 values for the same flight.

| FPVPIDlab dB (v2) | Internal Classification | Mapping Rationale |
|-----------|----------------------|-------------------|
| < -40 dB | Very clean | Minimal filtering needed |
| -40 to -20 dB | Normal | Standard filtering |
| -20 to -10 dB | Noisy | Lower cutoffs needed |
| > -10 dB | Very noisy | Aggressive filtering, check hardware |

FPVPIDlab's noise-to-cutoff interpolation range: **-60 dB (cleanest) to 0 dB (noisiest)**. These are internal scale endpoints, not community-standard values.

**Size-aware noise classification (`NOISE_LEVEL_BY_SIZE`)**: The only community-anchored row is 5" — the PIDtoolbox convention of −30 dB (amplitude convention) for a "clean" 5" build, which maps to −20 dB on the v2 scale. All non-5" rows (1": −5/−20, 2.5": −10/−25, 3": −15/−30, 4": −17/−30, 6": −23/−40, 7": −25/−45 high/medium dB) are a **house extrapolation** of that standard — smaller/higher-KV builds get more lenient thresholds, larger/lower-KV builds stricter ones. No published community per-size table exists.

**Mechanical health extreme-noise threshold**: `MechanicalHealthChecker` flags "extreme noise / possible damaged prop" at `max(−10 dB, NOISE_LEVEL_BY_SIZE[size].highDb + 5 dB)` — size-aware so that a healthy 1"/2.5" build (inherently noisy) is not falsely flagged.

### Peak Detection (FPVPIDlab-Specific)

- **Prominence threshold**: 6 dB above local noise floor (within ±50 frequency bins) — classifies a peak as "detected"
- **Action threshold**: 12 dB above floor — triggers a filter recommendation
- **Noise floor estimation**: Lower quartile (25th percentile) of power spectrum
- These thresholds were tuned empirically against real-world BBL data

### Filter Recommendation Rules

5 sequential rules, deduplicated at the end:

**Rule 1: Noise-Floor-Based Lowpass Adjustment**
- Scope: Roll and pitch axes
- **High noise** (> -20 dB): full-confidence noise-to-cutoff interpolation
- **Medium noise** (-40 to -20 dB): 20 Hz deadzone, low confidence recommendations (avoids churn)
- **Low noise** (< -40 dB): recommend raising cutoffs toward latency-optimal values (medium confidence). Clean quads benefit from higher cutoffs that reduce group delay without meaningful noise penalty
- Linear interpolation from noise floor (dB, v2 scale) to cutoff (Hz):
  ```
  t = (noiseFloorDb - 0) / ((-60) - 0)
  target = minHz + t × (maxHz - minHz)
  ```
- **Safety bounds** (FPVPIDlab-specific, tighter than BF firmware limits):

  | Parameter | Without RPM | With RPM | BF Guide Reference |
  |-----------|-------------|----------|-------------------|
  | Gyro LPF1 min | 75 Hz | 75 Hz | 50 Hz (very noisy), 80 Hz (slightly noisy) |
  | Gyro LPF1 max | 300 Hz | 500 Hz | 250 Hz default |
  | D-term LPF1 min | 70 Hz | 70 Hz | 70-90 Hz range |
  | D-term LPF1 max | 200 Hz | 300 Hz | 150 Hz default |

  *Rationale*: Gyro LPF1 min of 75 Hz is between BF's "very noisy" (50) and "slightly noisy" (80) — a compromise that prevents excessive phase delay while still allowing aggressive filtering for noisy quads. With RPM filter, bounds widen because RPM handles motor harmonics.

- **Deadzone**: 5 Hz minimum change to trigger recommendation (prevents trivial adjustments)
- **Propwash safety floor**: If target gyro LPF1 < 100 Hz AND worst noise floor ≤ -5 dB (v2 scale), raise to 100 Hz. This is a **conservative FPVPIDlab house rule** — the BF docs' "avoid below 100 Hz" advice refers to notch filters, and the community D-term lowpass floor is ~80 Hz (Oscar Liang). Bypassed only when noise is extreme (> -5 dB) because filtering takes priority over propwash.

**Rule 2: Resonance Peak Mitigation** (notch-aware)
- Collect peaks ≥12 dB above noise floor on roll and pitch
- **Notch-aware filtering**: Peaks within dyn_notch_min–dyn_notch_max range are excluded **only when `dyn_notch_count > 0`** — with the notch disabled, in-range peaks still trigger LPF recommendations. Only peaks not covered by an active notch trigger LPF recommendations.
- If significant peak outside notch range AND below current cutoff or cutoff disabled:
  - Target cutoff = lowest_peak_freq - 20 Hz, clamped to safety bounds
  - Recommend lowering both gyro LPF1 and D-term LPF1

**Rule 3: Dynamic Notch Range Validation**
- Check if detected peaks fall outside dyn_notch_min/max range
- Peaks below min: recommend `new_min = lowest_peak - 20`, clamped ≥50 Hz
- Peaks above max: recommend `new_max = highest_peak + 20`, clamped ≤1000 Hz

**Rule 4: RPM-Aware Dynamic Notch Simplification** (when RPM filter active)
- **Size-aware count target**: sub-5" quads → 2 notches (more complex vibration coupling), 5"+ → 1 notch. If dyn_notch_count > target: step down toward the target, at most **2 per iteration** (`DYN_NOTCH_COUNT_MAX_STEP`) — dropping 5→1 at once can regress axes where removed notches tracked real peaks
- **Conditional Q recommendation**:
  - If strong frame resonance detected (≥12 dB peaks in 80-200 Hz): keep Q=300 (wider notch needed to catch broad resonance) — medium confidence
  - Otherwise: recommend Q=500 (narrower notch, less signal distortion)
- *Rationale*: With RPM handling motor harmonics, the dynamic notch only needs to catch frame resonance — 1 narrow notch suffices on 5"+; small builds keep 2. Community consensus supports simplification (UAV Tech, BF 4.3+ notes); the per-size split and max step are FPVPIDlab house choices.

**Rule 6: LPF2 Recommendations**
- **Disable gyro LPF2** (F-LPF2-DIS-GYRO): When RPM filter active AND noise floor < -35 dB (`GYRO_LPF2_DISABLE_THRESHOLD_DB`). Reduces filter delay.
- **Disable D-term LPF2** (F-LPF2-DIS-DTERM): When RPM filter active AND noise floor < -35 dB (`DTERM_LPF2_DISABLE_THRESHOLD_DB`). Reduces D-term latency. RPM filter required as safety net before removing LPF2.
- **Enable gyro LPF2** (F-LPF2-EN-GYRO): When no RPM filter AND noise floor ≥ -20 dB (noisy). Enables at **250 Hz** (house choice — conservative secondary cutoff below the BF default 500 Hz). Extra filtering protects motors.
- **Enable D-term LPF2** (F-LPF2-EN-DTERM): When noise floor ≥ -20 dB AND LPF2 currently disabled. Enables at **150 Hz**. Extra D-term protection.
- *Rationale*: LPF2 adds significant phase delay — only worth it when noise level justifies it. With RPM filter + clean noise, LPF2 is counterproductive.

**Dynamic Lowpass Rules (F-DLPF-*)** — `DynamicLowpassRecommender`:
- **Enable** (F-DLPF-GYRO / F-DLPF-DTERM): throttle-dependent noise detected — noise increase from low to high throttle ≥ **6 dB**, Pearson throttle-noise correlation ≥ **0.6**, and at least **3 throttle bands** with data. Recommends `dyn_min = current static cutoff`, `dyn_max = static × 2` (BF 2:1 convention). Only fires when dynamic mode is not already active — when it is, the FilterRecommender tunes dyn_min/max directly.
- **Disable** (F-DLPF-GYRO-OFF / F-DLPF-DTERM-OFF): dynamic is active but throttle-dependent noise is absent AND the delta is below **4 dB** (`DYNAMIC_LOWPASS_DISABLE_DB`). The 4–6 dB gray zone is a **hysteresis band** — no change either way, preventing enable/disable flip-flop across sessions. Low confidence.
- These thresholds (6 dB / 0.6 / 4 dB) are FPVPIDlab house values — no direct community equivalent.

**Rule 5: Motor Harmonic Diagnostic** (when RPM filter active)
- If motor harmonics still detected at ≥12 dB: emit warning about possible `motor_poles` misconfiguration or ESC telemetry issues

**Rule 7: Yaw-Only Resonance Observation (F-YAW-RES)** — informational
- Yaw is deliberately excluded from LPF cutoff decisions (inherently noisier; lowering a global LPF for a yaw-only peak taxes roll/pitch latency). But a yaw peak ≥12 dB that the dynamic notch does not cover and that has no roll/pitch counterpart (within 15 Hz) is surfaced as an informational observation — it often indicates a loose FC stack, uneven motor mounting, or yaw-axis frame flex.

**Deduplication**: For overlapping recommendations on same parameter — keep more aggressive value, upgrade confidence if either was 'high'.

### PID Recommendation Rules

Per-axis rules anchored to **flight PIDs from BBL header** (convergent design — re-analyzing same flight after applying yields no further changes):

**Rule 1: Severe Overshoot** (mean > overshootMax threshold)
- Severity scale: `severity = meanOvershoot / threshold`
- D increase: severity > 4 → +15, severity > 2 → +10, else → +5
- P reduction (only if severity > 2 OR D already near max): severity > 4 → -10, else → -5
- *Rationale for proportional steps*: Community (Oscar Liang, Bardwell) recommends "adjust by 5" increments. FPVPIDlab scales up for severe cases to avoid multi-round convergence.

**Rule 2: Moderate Overshoot** (between moderateOvershoot and overshootMax)
- D increase by 5 only

**Rule 3: Sluggish Response** (low overshoot + slow rise time, severity-scaled)
- Trigger: meanOvershoot < overshootIdeal AND meanRiseTime > sluggishRise threshold
- **Severity-scaled P increase**: `slugSeverity = meanRiseTime / sluggishRise`
  - If severity > 2× threshold: P increase by +10 (very sluggish)
  - Otherwise: P increase by +5 (per FPVSIM guidance: "if too sluggish, raise P")
- **P-too-high informational warning**: If P > pTypical × 1.3 for quad size, emit low-confidence warning with `informational: true` (no value change). Alerts the user that P is unusually high for their quad type without forcing a reduction.
- **P-too-low informational warning**: If P < pTypical × 0.7 for quad size, emit low-confidence warning with `informational: true` (no value change). Especially important for micro quads where P=20-25 is dangerously unresponsive.

**Rule 4: Excessive Ringing** (maxRinging > ringingMax)
- D increase by 5 (skipped if D already increased for overshoot)
- **Ringing SNR filter**: Zero-crossings with amplitude below `RINGING_MIN_AMPLITUDE_FRACTION` (5%) of step magnitude are excluded from the ringing count. This prevents gyro sensor noise from inflating the oscillation count on small steps, ensuring Rule 4 only fires for genuine mechanical ringing.

**Rule 5: Slow Settling** (meanSettlingTime > settlingMax, overshoot acceptable)
- D increase by 5 (skipped if D already recommended)

**Rule 6: I-Term Steady-State Tracking**
- High error (> steadyStateErrorMax): I increase by +10 (if error > 2× threshold) or +5
- Low error + slow settling + overshoot: I decrease by 5 (may be causing oscillation)

**Yaw relaxation**: All overshoot, ringing, and sluggish-rise thresholds × 1.5 for yaw axis (yaw is mechanically less responsive).

### PID Post-Processing Rules

**Damping Ratio Validation** (roll/pitch only):
- FPVPIDlab enforces D/P ratio within **0.45-0.85** (upper bound **1.0 for 1"/2.5" micros** via `DAMPING_RATIO_MAX_MICRO`)
- *Comparison to community*: BF defaults are ~0.55-0.65, FPVSIM recommends 0.6 start. FPVPIDlab's 0.45 lower bound is intentionally liberal — it's a safety floor, not a target. It allows slightly under-damped tunes for pilots who prefer snappy response. The 0.85 upper bound prevents excessive D-noise.
- *Micro exception rationale*: whoop presets legitimately run heavy damping — whoop_justice D/P ≈ 0.91-0.94, whoop_ayyykayyy ≈ 0.95. A 0.85 ceiling would fight stock micro tunes, so 1"/2.5" use a 1.0 ceiling.
- 3 correction rules:
  1. Under-damped (D/P < 0.45, no existing D rec): recommend D increase to P × 0.45
  2. Over-damped after D increase (D/P > 0.85, D rec exists, no P rec): recommend P increase to D / 0.85
  3. Over-damped with no recs (D/P > 0.85): recommend D decrease to P × 0.85
- Deadzone: ≥3-point change required (prevents rounding noise)

**D-Term Effectiveness Gating** (FPVPIDlab-specific, 3 tiers):
1. D effectiveness > 0.7: boost D-increase confidence to 'high' — D is clearly helping
2. D effectiveness 0.3-0.7: allow D increase, annotate noise cost warning
3. D effectiveness < 0.3: **block the D increase** and replace it with an informational "improve filters first" recommendation (`P-DTE-BLOCK`, low confidence, no value change) — the pilot is told to run a Filter Tune first instead of the D change silently disappearing
- *Rationale*: Community says "D amplifies noise by 10-100x." If D isn't actually reducing overshoot (low effectiveness), raising it just adds noise. This gating prevents blind D increases while keeping the pilot informed.

**Prop Wash Integration:**
- Minimum 3 events for reliable analysis
- Severe prop wash (severity ≥ 5×) + existing D rec → boost confidence to 'high'
- Severe prop wash + no D rec → suggest D+5 on worst axis
- Moderate prop wash (2-5×): annotate only

**FF Domination Detection:**
- If >50% of steps show FF-dominated leading edge on an axis: skip P/D rules, recommend reducing `feedforward_boost` by 3 (not 5) instead
- *Rationale*: What looks like P overshoot may be FF doing its job — misdiagnosing it would harm tune. Step size of 3 is finer than P/D steps because FF boost has a narrower useful range.

**Informational Recommendations:**
- Recommendations with `informational: true` flag have `recommendedValue === currentValue` (no change applied)
- Used for P-too-high and P-too-low warnings — advisory-only, displayed as notes in UI
- *Rationale*: These conditions may or may not be problems depending on the pilot's setup. Alerting without forcing action prevents unwanted changes while keeping the pilot informed.

**D-Min/D-Max Awareness** (FPVPIDlab-specific):
- `extractDMinContext(rawHeaders)` reads `d_min_roll`, `d_min_pitch`, `d_min_yaw` from BBL headers
- When D-min is active (d_min > 0), D recommendations annotate that the change targets d_max only
- Advisory note: "D-min may also need adjustment for consistent feel"
- *Rationale*: BF's D-min/D-max system means the configured D value is actually d_max. Pilots need to know that FPVPIDlab adjusts d_max, and that d_min may need manual tweaking for consistent hover-to-maneuver feel.

**TPA Awareness** (FPVPIDlab-specific):
- `extractTPAContext(rawHeaders)` reads `tpa_rate` and `tpa_breakpoint` from BBL headers
- When TPA is active (rate > 0), D *increase* recommendations are annotated with TPA context
- Advisory note: explains that effective D is reduced at high throttle, so step responses from high-throttle maneuvers may show less damping than configured
- D *decrease* recommendations are not annotated (TPA doesn't affect the reasoning)
- *Rationale*: TPA can explain why step response data from high-throttle maneuvers shows insufficient damping. Without this annotation, pilots might blame D tuning when TPA is the actual cause.

### Transfer Function Rules (Flash Tune)

**Rule TF-1: Low Phase Margin** (< 45°)
- If < 30° (critical): D increase +10
- If 30-45° (warning): D increase +5
- *Maps to*: General control theory — 45° is standard stability margin

**Rule TF-2: Synthetic Overshoot** (> overshootThreshold)
- Same severity scale as time-domain Rule 1

**Rule TF-3: Low Bandwidth** (per-style threshold)
- Threshold varies by flight style: smooth < 30 Hz, balanced < 40 Hz, aggressive < 60 Hz
- Only if overshoot is low (system just sluggish, not oscillating)
- P increase by 5

**Rule TF-4: DC Gain Deficit** (style-aware threshold)
- Threshold = `20·log10(1 − steadyStateErrorMax/100)` dB — the dB equivalent of each style's steady-state error limit (smooth 8% ≈ −0.72 dB, balanced 5% ≈ −0.45 dB, aggressive 3% ≈ −0.26 dB)
- System doesn't fully track setpoint at steady state
- If deficit > 2× the style threshold: I increase +10 (medium confidence), else +5 (low confidence)
- Flash Tune equivalent of steady-state error detection (no direct step measurement available)

### PID Safety Bounds (Quad-Size-Aware)

Default bounds (used when drone size is unknown) match standard 5" values. When drone size is known from the profile, per-size bounds apply:

| Size | P min | P max | D min | D max | I min | I max | P typical |
|------|-------|-------|-------|-------|-------|-------|-----------|
| 1" | 30 | 90 | 15 | 80 | 40 | 100 | 72 |
| 2" *(ref only)* | 30 | 90 | 15 | 80 | 40 | 100 | 72 |
| 2.5" | 25 | 90 | 15 | 55 | 40 | 110 | 42 |
| 3" | 20 | 100 | 15 | 60 | 40 | 110 | 45 |
| 4" | 20 | 110 | 15 | 70 | 40 | 120 | 46 |
| **5"** (default) | **20** | **120** | **15** | **80** | **40** | **120** | **48** |
| 6" | 20 | 120 | 15 | 90 | 40 | 120 | 50 |
| 7" | 20 | 120 | 15 | 100 | 40 | 120 | 50 |
| 10" *(ref only)* | 20 | 120 | 15 | 100 | 40 | 120 | 50 |

> **Note**: FPVPIDlab supports 1"/2.5"/3"/4"/5"/6"/7" sizes only. The 2" and 10" rows are community reference values and are not selectable in the app. If an unsupported size is requested in code, it falls back to the standard 5" bounds.

| Parameter | Rationale |
|-----------|-----------|
| P min = 20-30 | Micro quads (1-2"): pMin=30 because P<30 is dangerously unresponsive at their low inertia. Standard+ quads: pMin=20. |
| P max 90-120 | Whoop presets cluster P 63-83 roll/pitch (whoop_justice, whoop_ayyykayyy, UAV Tech Whoop, Air65 BNF) — 1" pMax=90 covers them with headroom. P>90 appears only on whoop **yaw** (up to 108). Standard/large quads tolerate higher P. |
| D min = 15 | Below 15 provides negligible damping |
| D max 55-100 | Whoop presets run D 57-79 on roll/pitch (D/P ≈ 0.9-0.95) — 1" dMax=80 accommodates them. 2.5": dMax=55. Large quads: high inertia needs more D damping (6"=90, 7"=100). |
| I min = 40 | I=30 causes poor wind rejection and attitude drift. BF defaults I=60-90. |
| I max 100-120 | Micro quads rarely need I > 100. Standard quads: community rarely above 110. |
| P typical | Size-specific P reference for informational warnings: "P too high" (triggers at 1.3×) and "P too low" (triggers at 0.7×) |

### Flight Style Thresholds (FPVPIDlab-Specific)

FPVPIDlab adjusts all PID thresholds based on the pilot's declared flight style. These are FPVPIDlab-specific values, not BF defaults:

| Metric | Smooth | Balanced | Aggressive | Community Reference |
|--------|--------|----------|-----------|-------------------|
| Ideal overshoot | 3% | 10% | 18% | Oscar Liang: "5-10% bump OK" |
| Max overshoot | 12% | 25% | 35% | BF: "bounce-back = problematic" |
| Max settling | 250 ms | 200 ms | 150 ms | BF: "FF makes 150-200ms normal" |
| Max ringing | 1 | 2 | 3 | PIDtoolbox: minimize |
| Moderate overshoot | 8% | 15% | 25% | — |
| Sluggish rise | 120 ms | 80 ms | 50 ms | FPVSIM: visual assessment |
| Steady-state error max | 8% | 5% | 3% | — |
| Steady-state error low | 2% | 1% | 1% | — |

| Bandwidth low (TF) | 30 Hz | 40 Hz | 60 Hz | Per-style TF-3 threshold |

*Rationale*: **Balanced** maps to typical community targets (10% overshoot, 200ms settling). **Smooth** is for cinematic/long-range where stability trumps response. **Aggressive** is for racing where pilots accept more overshoot for faster rise times. Bandwidth thresholds reflect that aggressive pilots need higher bandwidth for locked-in feel.

### Step Detection (FPVPIDlab-Specific)

- Derivative threshold: 500 deg/s/s
- Minimum magnitude: 150 deg/s (raised from 100 to reduce false positives in turbulent data)
- Hold validation: ≥50 ms at ±50% of step size
- Cooldown between steps: 100 ms
- Adaptive window: 2× median settling time, clamped [150, 500] ms
- Two-pass detection: first at 500ms window, then adaptive

### Cross-Axis Coupling Detection (FPVPIDlab-Specific)

- Pearson correlation (zero-lag) between step axis and non-step axes
- Thresholds: < 0.15 = none, 0.15-0.40 = mild, ≥ 0.40 = significant
- Identifies mechanical asymmetry, FC mounting angle, motor thrust differences

### Prop Wash Detection (FPVPIDlab-Specific)
 (Note: severities stored by app versions with the whole-flight baseline read systematically lower than clean-baseline values — cross-version comparisons of stored propwash severity are not meaningful.)
- Throttle-down detection: derivative < -0.3 (normalized) sustained ≥50 ms
- Analysis window: 400 ms post-drop, FFT in 20-90 Hz band
- Severity: event band energy ratio vs CLEAN baseline — band energy of contiguous runs outside every drop + post-drop window, weighted by run length; falls back to full flight when no clean run ≥ 1024 samples. A whole-flight baseline would include the prop-wash energy itself, saturating the ratio on aggressive flights
  - < 2× = minimal, 2-5× = moderate, ≥ 5× = severe
- Minimum 3 events for reliable analysis
- Dominant frequency: grouped into 5 Hz buckets, most common = dominant

### Group Delay Estimation (FPVPIDlab-Specific)

- Reference frequency: 80 Hz (typical control bandwidth)
- Per-filter delay computation using analytical formulas (PT1, biquad, notch)
- **All lowpasses (LPF1 + LPF2) modeled as PT1** — the BF 4.3+ default. Modeling LPF2 as biquad would overestimate its delay ~2× (BF doc: PT1 ≈ 1 ms @ 100 Hz, biquad ≈ 2 ms)
- **Notch group delay** uses the denominator-only derivation: for H(s) = (s² + w0²)/(s² + (w0/Q)s + w0²), the numerator is purely real on the jω axis, so `τ(ω) = bw·(w0²+ω²) / ((w0²−ω²)² + bw²ω²)` with bw = w0/Q. Sanity anchor: BF doc's 90°-at-center / 45°-at-edges phase rule → ≈1 ms for a wide notch near 250 Hz
- Dynamic notch Q handling: BF stores Q×100 internally → `actualQ = Q > 10 ? Q / 100 : Q`
- **Warning threshold: 2.0 ms** gyro chain total at 80 Hz
- *Rationale for 2ms*: BF notes "normal D delay is about 5ms, motor time constant ~15ms." Gyro filter delay beyond 2ms starts to meaningfully degrade PID response.

---

## 7. Data Quality & Flight Quality Scoring

> **FPVPIDlab-specific scoring system.** No direct community equivalent — most tools don't score data quality.

### Filter Data Quality (0-100)

Scored before generating filter recommendations:

| Component | Weight | 0 Score | 100 Score |
|-----------|--------|---------|-----------|
| Segment count | 0.20 | 0 segments | 3+ segments |
| Hover time | 0.35 | < 0.5s | 5+ seconds |
| Throttle coverage | 0.25 | < 10% range | 40%+ range |
| Segment type | 0.20 | Fallback only | Sweep segments present |

**Warnings**: `few_segments` (<2), `short_hover_time` (<2s), `narrow_throttle_coverage` (<20%)

### PID Data Quality (0-100)

| Component | Weight | 0 Score | 100 Score |
|-----------|--------|---------|-----------|
| Step count | 0.30 | 0 steps | 15+ steps |
| Axis coverage | 0.30 | 0 axes with 3+ steps | All 3 axes with 3+ |
| Magnitude variety | 0.20 | CV < 0.05 | CV ≥ 0.3 |
| Hold quality | 0.20 | No valid settling | All steps settled |

**Warnings**: `few_steps` (<5), `missing_axis_coverage`, `few_steps_per_axis` (<3), `low_step_magnitude` (mean <200 deg/s)

### Transfer Function Data Quality (0-100)

| Component | Weight | 0 Score | 100 Score |
|-----------|--------|---------|-----------|
| Signal duration | 0.30 | < 2s | 10+ seconds |
| Sample rate | 0.20 | < 1 kHz | 4 kHz |
| Stick activity | 0.30 | 0 deg/s RMS | 50+ deg/s |
| Axis coverage | 0.20 | 0 active axes | 3 active axes (coherence >0.3) |

**Warnings**: `short_hover_time` (<5s), `low_logging_rate` (<2kHz), `low_step_magnitude` (RMS <10 deg/s), `low_coherence` (per-axis coherence ≤0.3 — severity: <0.15 warning, 0.15-0.3 info)

> **Implementation note**: the Wiener estimator computes magnitude-squared coherence γ²(f) = |S_xy|²/(S_xx·S_yy) per axis and reports `coherenceMean` averaged over the 1-30 Hz stick-input band (requires ≥2 Welch windows — coherence over a single window is trivially 1 and is omitted). Coherence feeds (a) the axis-coverage sub-score and `low_coherence` warnings above, and (b) a **TF rule gate**: TF-1..TF-4 gain recommendations are skipped for any axis with `coherenceMean < 0.5` (`TF_COHERENCE_GATE`) — a low-coherence transfer function reflects noise/disturbance, not commanded motion, and must not drive gain changes.

### Quality Tiers & Confidence Adjustment

| Overall Score | Tier | Confidence Impact |
|--------------|------|-------------------|
| 80-100 | Excellent | No change |
| 60-79 | Good | No change |
| 40-59 | Fair | high → medium |
| 0-39 | Poor | high → medium, medium → low |

### Flight Quality Score (Post-Tuning)

Composite 0-100 score computed after tuning session completes. Components vary by mode:

| Component | Best Value | Worst Value | Available In |
|-----------|-----------|-------------|--------------|
| Noise floor | -50 dB | -10 dB (v2 scale) | All modes |
| Tracking RMS | 0 | 0.5 deg/s | PID Tune only |
| Overshoot | 0% | 50% | All modes |
| Settling time | 50 ms | 500 ms | PID Tune only |
| Phase margin | 60° | 20° | Flash Tune only |
| Bandwidth | 80 Hz | 20 Hz | Flash Tune only |
| Noise delta | -10 dB (improvement) | +5 dB (regression) | When verification present |

**Scoring**: 100 points redistributed evenly among available components. Each linearly interpolated. Sum = overall score.

---

## 8. Flight Style Descriptions

> Community-sourced descriptions of tuning goals per flight style.

**Smooth** (cinematic, long range):
- Prioritizes stability over responsiveness. Tolerates slower rise times.
- Pilots want jello-free video, gentle transitions, long straight-line stability.
- Lower P, moderate D, higher I for cruise stability.
- More filtering acceptable (latency less noticeable at cruise speeds).

**Balanced** (freestyle, general flying):
- Standard BF defaults. Good all-around response.
- Most pilots start here. Most community tuning content targets this style.
- Moderate P/D, standard I. Default filtering.

**Aggressive** (racing, acro):
- Demands fast response, tight settling. Lower tolerance for any sluggishness.
- Pilots accept more overshoot for faster rise times. Minimal filtering for lowest latency.
- Higher P, matched D, lower I (reduce bounce-back in rapid direction changes).
- Oscar Liang: "For racing, tighter tune with less filtering for minimum delay."

---

## 9. Quad Archetypes & Typical Values

> Community starting points. BF defaults and Bardwell/Oscar Liang recommendations.

### 5" Freestyle (650g, 2400KV, 4S)

- **PID starting point** (Bardwell): P=46, I=45, D=25, FF=100 (roll); P=50, I=50, D=27, FF=100 (pitch)
- **Community PID range**: P 45-65, I 45-100, D 25-55
- **Filters**: Gyro LPF1 200-300 Hz, D-term LPF1 120-170 Hz
- **Goal**: Balanced response, good prop wash handling, moderate filtering
- **Notes**: Most common setup, most tuning content applies to this archetype
- **D-max**: SupaflyFPV disabled (dmax_gain=0), UAV Tech disabled. Community trend: disable D-max for predictable feel on 5" and smaller.

### 5" Race (580g, 2650KV, 6S)

- **PID range**: P 50-80, I 40-90, D 25-50
- **Filters**: Gyro LPF1 250-400 Hz (cleaner builds), D-term LPF1 140-200 Hz
- **Goal**: Maximum response, minimal filtering, low latency
- **Notes**: Lower weight + higher power = cleaner gyro signal. Can use less aggressive filters. Higher P for snap response. Lower I to reduce bounce-back in rapid direction changes.

### 3" Cinewhoop (180g, 3000KV, 4S)

- **PID range**: P 55-85, I 85-110, D 40-65
- **Filters**: Gyro LPF1 180-250 Hz, D-term LPF1 100-150 Hz
- **Goal**: Smooth video, good prop wash management, more filtering acceptable
- **Notes**: Ducted props create more turbulence. Higher D helps smooth out prop wash. Higher I for stable hover during video shots.

### 7" Long Range (900g, 1800KV, 6S)

- **PID range**: P 35-55, I 70-90, D 25-40
- **Filters**: Gyro LPF1 150-250 Hz, D-term LPF1 100-140 Hz
- **Goal**: Efficiency, gentle response, cruise stability
- **Notes**: Larger props = lower noise frequencies. More frame flex = potential lower-frequency resonances. Lower P/D for gentle handling.
- **D-max**: SupaflyFPV enables (dmax_gain=100), UAV Tech disabled. Mixed — larger quads may benefit from adaptive D.

### Tiny Whoop (25g, 19000KV, 1S)

- **PID range**: P 60-90 roll/pitch (yaw up to ~110), I 80-110, D 50-80
- **Real preset cluster** (whoop_justice, whoop_ayyykayyy, UAV Tech Whoop, Air65 BNF): P 63-83 / D 57-79 on roll+pitch; P>90 only on yaw (up to 108). D/P ratio runs 0.9-0.95 — hence FPVPIDlab's 1.0 micro damping ceiling
- **Filters**: Gyro LPF1 200-350 Hz, D-term LPF1 130-180 Hz
- **Goal**: Aggressive for the size, high P needed for low-authority motors
- **Notes**: Very high KV motors have less authority → needs higher PID gains. Lightweight means quick response but also quick upset from air disturbance.
- **D-max**: Universally disabled (dmax_gain=0) across all preset authors. Whoops need consistent D.

### 10" Ultra Long Range (1500g, 1400KV, 6S)

- **PID range**: P 30-45, I 60-80, D 20-35
- **Filters**: Gyro LPF1 120-200 Hz, D-term LPF1 80-120 Hz
- **Goal**: Maximum efficiency, gentle handling, long flight times
- **Notes**: Large props produce low-frequency noise. Frame flex is significant — may need structural notch filter. Very low PID gains to prevent oscillation.

### Battery & Voltage Considerations

- **1S (3.7V)**: Tiny whoops. Very limited power, high KV compensates. PID gains must be high.
- **3S (11.1V)**: Toothpicks, micro quads. Moderate power, mid-range gains.
- **4S (14.8V)**: Standard freestyle. Good power-to-weight for 5" quads.
- **6S (22.2V)**: Race and long range. More headroom, potentially cleaner power delivery. BF TPA helps manage high-throttle gain.
- **VBat sag compensation**: BF can scale PID output based on battery voltage to maintain consistent feel as battery depletes.

---

## 10. Advanced Betaflight Settings

### TPA (Throttle PID Attenuation)

- Reduces PID gains at high throttle to prevent noise amplification
- `tpa_rate`: Amount of attenuation (0-250, BF default 65)
- `tpa_breakpoint`: Throttle level where attenuation begins (default 1350)
- `tpa_mode`: Which terms to attenuate — D (default), PD (SupaflyFPV preference on 5")

**Community preset values:**

| Author | tpa_mode | tpa_rate | tpa_breakpoint |
|--------|----------|----------|----------------|
| SupaflyFPV 5" | PD | 50 | 1250 |
| SupaflyFPV 6-7" | D | 80 | 1250 |
| Karate Race | D | 70 | 1250 |
| Whoop/tiny presets (whoop_justice, whoop_ayyykayyy, tiny_karate) | D | 50-70 (near default) | ~1250 |
| BF Default | D | 65 | 1350 |

**Low-throttle TPA (BF 4.5+):**
- `tpa_low_rate`: Low-throttle attenuation (0-100, default 20)
- `tpa_low_breakpoint`: Throttle below which attenuation applies (default 1050)
- `tpa_low_always`: ON in SupaflyFPV presets — always attenuate at low throttle
- **Pattern**: Most presets lower breakpoint to 1250 (from 1350). Larger quads use higher tpa_rate.

**FPVPIDlab `TPA_BY_SIZE`**: small (1-4"): rate 50, breakpoint **1250** (matches whoop/tiny presets); standard (5"): rate 65, breakpoint 1350; large (6-7"): rate 80, breakpoint 1250.

### Anti-Gravity

- Boosts I-term temporarily during rapid throttle changes (punch-outs, drops)
- `anti_gravity_gain`: Strength of I boost (BF 4.5: 0-250, **default 80**)
- Note: BF 4.3 used internal units (default 5000). BF 4.5+ changed to 0-250 scale.

**Community preset values (verified against betaflight/firmware-presets):**

| Scenario | anti_gravity_gain |
|----------|------------------|
| BF 4.5 default | 80 |
| SupaflyFPV 5" | 80 (default) |
| SupaflyFPV 7" | 120 |
| UAV Tech 8-9" cinelifter | 110 |
| UAV Tech Whoop | 90 |
| Race (Karate, ctzsnooze) | 80 (default) |

**Pattern**: Elevated anti-gravity (110-120) appears only on genuinely heavy 7-9" craft.
5" presets — including freestyle-with-GoPro — keep the default 80. Whoops go slightly
above default (90). **FPVPIDlab gate**: anti-gravity increase (110/120) is only recommended
above **700 g** drone weight (`ANTI_GRAVITY_WEIGHT_THRESHOLD_G`) — this excludes typical
5" freestyle builds (~650 g), matching the preset evidence.

### I-term Relax

- Prevents I-term windup during fast stick movements (flips, rolls)
- `iterm_relax`: Mode selection (OFF, RP for roll/pitch, RPY for all axes)
- `iterm_relax_type`: GYRO (reacts to actual movement) or SETPOINT (reacts to stick input)
- `iterm_relax_cutoff`: Frequency threshold (1-100, default 15)
  - **Racing**: 30-40 (BF wiki, "I Term Relax Explained": "30-40 is good for racing, 15 for freestyle, 10 or even lower for big heavier quads"; race whoop presets span 20-45 — FPVPIDlab's aggressive band is 20-40, typical 30)
  - **Freestyle**: 10-15 (more relaxation, smoother flip/roll recovery)
  - **Cinematic**: 5-10 (maximum relaxation, smoothest transitions)
- Lower cutoff = more relaxation = less bounce-back but potentially worse tracking

### D-Min / D-Max Architecture

- BF 4.3+ uses D-Min/D-Max system instead of fixed D gain
- `d_min_[roll/pitch/yaw]`: D value at rest/slow flight (lower = less noise)
- `d_max_gain`: Maximum D during active flying (higher = more damping when needed)
- `d_max_advance`: How quickly D ramps up during stick input (0-200)
- **Concept**: Low D during hover (less noise), high D during maneuvers (more damping)

### Dynamic Idle

- Maintains minimum motor RPM regardless of throttle position
- `dyn_idle_min_rpm`: Minimum motor RPM (0 to disable, typically 20-60)
- Prevents motor desync on rapid throttle cuts (zero-crossing)
- Improves prop wash handling (motors always spinning, faster recovery)
- Helps RPM filter accuracy at low throttle (minimum trackable RPM)

### VBat Sag Compensation

- Scales PID output based on measured battery voltage vs nominal
- `vbat_sag_compensation`: Amount (0-150, default 0 = off)
- Maintains consistent feel as battery depletes
- Recommended: 50-100 for freestyle, 0 for racing (predictable power curve preferred)

### RC Smoothing

- Smooths RC input signal to reduce jitter before PID computation
- `rc_smoothing`: AUTO (default, recommended), OFF, or manual values
- `rc_smoothing_auto_factor`: Auto-smoothing aggressiveness (1-250, default 30)
- Higher values = smoother sticks but slightly more latency
- Racing: lower values (10-20) for minimal latency
- Freestyle/cinematic: default (30) or higher for smooth video

### EzLanding (BF 4.5+)

- Simplifies landing by reducing PID authority at zero throttle
- `ez_landing_threshold`: Throttle below which EzLanding activates
- `ez_landing_limit`: How much to reduce PID gains
- Prevents tip-overs on landing (relaxes attitude hold)
- Not needed for experienced pilots, helpful for beginners

### Thrust Linearization

- Compensates for non-linear motor/ESC thrust curve
- `thrust_linear`: Linearization amount (0-150, BF default 0 = off)
- Higher value = more compensation for low-throttle non-linearity

**Community values by size (SupaflyFPV):**

| Size | thrust_linear |
|------|--------------|
| 3-4" | 40 |
| 5" | 30 |
| 6" | 20 |
| 7" | 10 |

UAV Tech: 0 for 24K PWM, 20 for 48K PWM (all sizes). QuadMcFly: 40.
Decreases with size — larger props have more linear thrust curves.

### PID Sum Limits

- `pidsum_limit`: Maximum combined PID output per axis (BF default 500 — confirmed in firmware)
- `pidsum_limit_yaw`: Same for yaw (BF default 400 — confirmed in firmware)
- UAV Tech universally sets both to 1000 — **on every size from whoop through 10"**, so the value itself is not weight-dependent in community practice
- Karate Race: yaw limit 1000 (default pidsum_limit)
- Higher limits allow full PID authority on heavy/powerful quads. Risk: motor desync/saturation on damaged or underpowered quads.
- **FPVPIDlab rule (P-PIDLIM)**: recommends 1000/1000 only above **800 g** drone weight (`PIDSUM_LIMIT_WEIGHT_THRESHOLD_G`). The weight gate is a **house rule with no community source** (community presets apply 1000 universally) — kept as a conservative safety filter. The recommendation is **informational-only** (`informational: true`): never auto-applied, the pilot applies it manually if the build has thrust headroom.

### D-term LPF Dynamic Expo (BF 4.5+)

- `dterm_lpf1_dyn_expo`: Controls how aggressively D-term dynamic LPF tracks throttle (0-10)
- Higher expo = LPF cutoff rises faster with throttle
- Karate Race: 7-10 (aggressive, less D filtering at high throttle)
- Default: 5
- Useful for race builds where minimal D-term latency at high throttle is critical
- **FPVPIDlab per-style ranges** (`DTERM_DYN_EXPO_BY_STYLE`): aggressive 7-10 (Karate presets), balanced 5 (BF default). The smooth 3-5 range is a **house choice** — no cinematic preset source exists

---

## 11. Hardware Factors

### Gyro Types

| Gyro | Max Rate | Noise | Notes |
|------|----------|-------|-------|
| **MPU6000** | 8 kHz | Higher | Legacy, still common. SPI interface. Known higher noise floor. |
| **BMI270** | 6.4 kHz | Medium | Bosch chip, common in budget FCs. Different noise profile. |
| **ICM-42688-P** | 32 kHz | Lowest | TDK InvenSense, premium FCs. Best noise performance, hardware anti-alias. |
| **ICM-20689** | 32 kHz | Low | Older InvenSense, still good. Found in mid-range FCs. |

- Gyro choice affects baseline noise floor significantly
- Some gyros have hardware lowpass (ICM-42688-P: programmable anti-alias at 1-4 kHz)
- **Soft mounting**: FC mounted with grommets/dampeners. Reduces mechanical vibration coupling but adds latency. Modern consensus: hard mount + good software filtering preferred.

### Motor Protocols

| Protocol | Speed | Bidirectional | Latency | RPM Filter |
|----------|-------|---------------|---------|------------|
| **DSHOT150** | 150 kbit/s | Optional | ~107 μs | Yes (if bidir) |
| **DSHOT300** | 300 kbit/s | Optional | ~53 μs | Yes (if bidir) |
| **DSHOT600** | 600 kbit/s | Optional | ~27 μs | Yes (if bidir) |
| **DSHOT1200** | 1200 kbit/s | No | ~13 μs | No |

- **Bidirectional DSHOT**: Motor sends RPM telemetry back to FC on the same signal wire
- Required for RPM filter (the single most effective filter)
- DSHOT300 bidirectional is the most common and recommended protocol
- DSHOT1200 doesn't support bidirectional (timing constraints)

### ESC Firmware

| Firmware | RPM Filter | PWM Freq | Notes |
|----------|-----------|----------|-------|
| **BLHeli_32** | Yes | 24-96 kHz | Commercial, most feature-complete. Bidirectional DSHOT native. |
| **AM32** | Yes | 24-96 kHz | Open-source BLHeli_32 alternative for ARM-based ESCs. |
| **Bluejay** | Yes | 24-96 kHz | Open-source for EFM8-based ESCs (Atmel/SiLabs). Good RPM telemetry. |
| **JESC** | Yes | 24-48 kHz | Legacy open-source. First to support bidirectional DSHOT. |
| **BLHeli_S** | No | 24 kHz | Legacy, no bidirectional support. Still common on budget builds. |

- BF Tuning Guide: PWM frequency 48 kHz for freestyle, motor timing 22 (freestyle) / 25+ (racing)
- ESC firmware quality affects RPM telemetry reliability → affects RPM filter effectiveness

### Frame Design Impact

- **Arm stiffness**: Stiffer arms = higher resonance frequency (easier to filter). Carbon fiber thickness matters.
- **Resonance frequency**: Typically 80-200 Hz for 5" frames. Appears as fixed peak in noise spectrum.
- **True-X vs Stretch-X**: Stretch-X has different roll/pitch moment of inertia → may need different R/P PID gains
- **Standoff height**: Taller stack = more vibration leverage. Keep FC/gyro close to center of mass.
- **Motor soft mount**: O-rings or rubber grommets between motor and arm. Reduces high-frequency vibration transmission.

### Prop Balance & Maintenance

- Unbalanced props create vibration at motor RPM (fundamental + harmonics)
- Even small imbalance (0.1g) is significant at 20,000+ RPM
- **Symptoms**: High noise floor on one motor, asymmetric axis noise
- Prop damage (nicks, bends) changes aerodynamic balance → always replace after crashes
- Motor bearing wear: increases broadband noise, eventually audible as grinding
- **Rule of thumb**: If noise suddenly increases between flights → check props and bearings first

---

## 12. Tuning Workflow Best Practices

### Order of Operations

1. **Always filters first, then PIDs** — PIDs can't work properly if noise is getting through unfiltered
2. **Start with hover analysis** — stable throttle reveals noise spectrum cleanly
3. **Then test with stick inputs** — step response needs deliberate stick movements
4. **Iterate if needed** — one round usually sufficient, verify with a check flight
5. **Alternative (Flash Tune)**: Single flight with mixed flying → transfer function analysis → combined filter + PID recommendations

Source: UAV Tech systematic methodology, BF Tuning Guide, Oscar Liang

### When NOT to Tune

- After a crash (check hardware first — props, arms, motors, bearings)
- With damaged props (noise data is meaningless)
- On a brand new build (fly 5-10 packs first for break-in: bearings seating, screws settling)
- In very windy conditions (wind adds noise that isn't representative of the quad)
- With an almost-dead battery (voltage sag changes motor behavior)
- With loose components (camera, battery strap, antennas — add vibration)

### Red Flags (Hardware, Not Software)

- Asymmetric noise between axes → bent prop, loose motor mount, frame crack
- Very high noise floor on one axis only → damaged gyro or FC mounting issue (Oscar Liang)
- Noise that doesn't respond to filter changes → mechanical resonance (needs physical fix)
- Sudden noise change between flights → prop damage, loose screw, bearing wear
- Motors significantly hotter on one side → motor or ESC issue, check prop balance

### Convergence

- Good tuning should converge: each iteration improves or maintains quality
- If metrics oscillate between sessions → possible mechanical issue or edge case
- **Expected progression**: 1-2 rounds of filter+PID tuning typically sufficient
- BF community: "If it flies well, stop tuning" — diminishing returns beyond "good enough"

### Logging Recommendations

| Sample Rate | Resolution | Use Case |
|-------------|-----------|----------|
| 1 kHz | Basic | Long flights, battery endurance testing |
| 2 kHz | Good | Standard tuning — BF dev team recommended sweet spot |
| 4 kHz | Best | Detailed noise analysis, resolves up to 2 kHz |

- `blackbox_sample_rate`: BF setting (1/1 = full rate, 1/2 = half, etc.)
- Logging rate = `8000 / pid_process_denom / 2^blackbox_sample_rate`
- From BBL headers, the effective log rate is `1e6 / (looptime × P interval × pid_process_denom)` — FPVPIDlab's low-logging-rate warning uses this, not the raw gyro rate
- Higher rate = more data = better FFT resolution but fills flash faster
- `debug_mode = GYRO_SCALED` required for noise analysis (shows unfiltered + filtered gyro)

---

## 13. BF Version-Specific Notes

### BF 4.3 (Minimum Supported by FPVPIDlab)

- Removed biquad from gyro lowpass options (PT1/PT2/PT3 only)
- Introduced slider system for simplified filter tuning
- FF 2.0: per-axis feedforward weight, smart feedforward with jitter reduction
- `feedforward_*` CLI naming (replaced `ff_*` from 4.2)
- MSP_FILTER_CONFIG 47-byte layout (stable through 4.5+)

### BF 4.5 (Recommended)

- Dimmable RPM filter harmonics (adjustable notch depth per harmonic)
- Low-throttle TPA: attenuates PID gains at very low throttle (non-linear motor region)
- EzLanding: simplified landing mode
- Improved dynamic notch tracking (faster convergence)

### BF 4.6 / 2025.12 (Latest Tested)

- DEBUG_GYRO_SCALED debug mode removed — gyro data available through other means
- Chirp signal generator for transfer function analysis (FC-generated test signal)
- **D-term rename**: `d_min` became the base `d` (defaults 30/34 roll/pitch), the former `D` became `d_max` (defaults 40/46), and the `d_min` setting was removed. This rename shipped in 2025.12 — NOT in 4.5

---

## 14. Community Tools & References

### Analysis Tools

| Tool | Purpose | Methodology |
|------|---------|-------------|
| **FPVPIDlab** | Automated tuning (this app) | FFT + step response + Wiener deconvolution |
| **Plasmatree PID-Analyzer** | Transfer function analysis | Wiener deconvolution, Bode plots |
| **PIDtoolbox** | MATLAB-based BBL analysis | Step response, noise spectra, FFT |
| **BF Blackbox Explorer** | Official log viewer | Time-domain traces, basic FFT |
| **BlackBox Mate (BBM)** | Web-based log analysis | PSD plots, throttle spectrograms |
| **FPVtune** | Mobile BBL analyzer | Neural network-based PID suggestions |

### Methodology Sources

- **Plasmatree PID-Analyzer**: Pioneer of frequency-domain PID analysis for FPV. FPVPIDlab's transfer function analysis is inspired by this approach.
- **PIDtoolbox** (Brian White, Queen's University): Established step response metric methodology. Standard reference for overshoot/settling analysis.
- **FPVSIM**: Multi-rotor dynamics simulator. Step response visualization for P/D balance.
- **UAV Tech (Mark Spatz)**: Systematic PID tuning methodology (RPM filter first, then lowpass, then PIDs).
- **Oscar Liang**: Comprehensive FPV tuning guides. Filter architecture explanations, beginner-friendly tips.
- **Joshua Bardwell**: Practical tuning approach ("start low, raise P until oscillation, back off 20%, match D").
- **Betaflight Tuning Notes** (official wiki): Authoritative source for BF-specific settings, defaults, and version changes.

### Key Community Principles

1. **"Tune the quad, not the numbers"** — PIDs interact; don't optimize one term in isolation
2. **"Filters are medicine, not vitamins"** — Only as much filtering as the noise requires
3. **"If it flies well, stop tuning"** — Diminishing returns beyond "good enough"
4. **"Noise is the enemy of D"** — D amplifies everything, including noise. Clean signal = higher D ceiling
5. **"The best tune is hardware"** — No amount of software tuning fixes bad props, loose motors, or cracked frames
6. **"The P:D ratio is more important than absolute values"** — Bardwell
