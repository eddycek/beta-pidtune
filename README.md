# FPVPIDlab

**Data-driven Betaflight autotuning. Fly → Analyze → Apply.**

FPVPIDlab reads your Blackbox log, analyzes the data (FFT noise spectrum, step response, transfer function), and computes optimal filter cutoffs and PID values — not from presets or guesswork, but from your quad's actual flight characteristics. The result: concrete Betaflight CLI commands with plain-English explanations, applied with one click.

**What makes it different:**
- **Computed recommendations** — filter cutoffs and PID values derived from measured flight data, not just graphs
- **Three tuning modes** — Filter Tune (2 flights, filter analysis + verification), PID Tune (2 flights, PID analysis + verification), or Flash Tune (2 flights, Wiener deconvolution + verification, à la [Plasmatree](https://github.com/Plasmatree/PID-Analyzer))
- **Convergent** — re-analyzing the same log always produces the same result, no recommendation drift
- **Safety-first** — automatic pre/post-tuning snapshots, all values clamped to proven safe bounds
- **Multi-quad profiles** — auto-detects each FC by serial number, stores configs and history per quad
- **Flight style adaptation** — Smooth (cinematic), Balanced (freestyle), Aggressive (racing) thresholds
- **27 analysis modules** — FFT, step response, Wiener deconvolution, setpoint→gyro coherence, prop wash, D-term effectiveness, cross-axis coupling, throttle spectrograms, group delay, feedforward, dynamic lowpass, Bayesian optimizer, convergence detection, verification matching, and more
- **Works offline** — demo mode with simulated FC for testing without hardware
- **Anonymous telemetry** — opt-in usage telemetry with per-session analytics (tuning mode usage, drone sizes, quality scores, recommendation rule tracing, verification deltas; no flight data or PIDs ever sent)
- **Freemium license system** — free tier (1 profile), Pro tier (unlimited profiles). Ed25519-signed offline-first license validation
- **Auto-updater** — silent background download from GitHub Releases, install on quit. Changelog modal with "What's new" details
- **Settings with log viewer** — tabbed settings modal (Telemetry + Logs). Color-coded log viewer with export-to-file

**How it works:** Connect FC via USB → Erase flash → Fly → Download log → FPVPIDlab analyzes and applies optimized settings → Done.

## Download

Pre-built binaries are available on the [Releases](https://github.com/eddycek/pidlab/releases) page:

| Platform | Format | File |
|----------|--------|------|
| **macOS** | Disk Image | `FPVPIDlab-*.dmg` |
| **Windows** | Installer | `FPVPIDlab-Setup-*.exe` |
| **Linux** | AppImage | `FPVPIDlab-*.AppImage` |

> **Note:** Builds are code-signed (macOS notarization + Windows Authenticode). Auto-updates are delivered via GitHub Releases.

## Supported Betaflight Versions

| Tier | Version | Notes |
|------|---------|-------|
| **Minimum** | BF 4.3 (API 1.44) | Oldest supported — connects and works |
| **Recommended** | BF 4.5+ (API 1.46) | Best feature coverage |
| **Actively tested** | BF 4.5.x, 2025.12.x | User's fleet |

Connecting with BF 4.2 or earlier will show an error and auto-disconnect. See [BF Version Policy](./docs/complete/BF_VERSION_POLICY.md) for detailed rationale and version-specific notes.

## Current Status

- **Phase 1:** ✅ Complete - MSP connection, profile management, snapshots
- **Phase 2:** ✅ Complete - Blackbox analysis, automated tuning, rollback
- **Phase 2.5:** ✅ Complete - Profile simplification, interactive analysis charts
- **Phase 3:** ✅ Complete - Mode-aware wizard, read-only analysis, flight guides
- **Phase 4:** ✅ Complete - Stateful tuning workflow (Filter Tune, PID Tune, Flash Tune)
- **Phase 6:** ✅ Complete - CI/CD with GitHub Actions (tests on PR, cross-platform releases on tag)

## Features

### Connection & Profiles
- USB serial connection to Betaflight flight controllers (MSP protocol)
- Multi-quad profile management with automatic FC detection by serial number
- Profile auto-selection on connect, profile locking while FC is connected
- BF PID profile selection — choose which Betaflight PID profile slot (1–4) to tune into
- 8 preset profiles (Tiny Whoop, 5" Freestyle, 7" Long Range, etc.)
- Cross-platform (Windows, macOS, Linux)

### Configuration Management
- CLI export (diff/dump) for full configuration backup
- Configuration snapshots with versioning and comparison
- Snapshot restore/rollback via CLI command replay
- GitHub-style diff view for snapshot comparison

### Blackbox Storage
- **Flash storage**: Download via MSP with adaptive chunking
- **SD card storage**: Download via MSC (Mass Storage Class) mode — FC re-enumerates as USB drive, app copies `.bbl` files automatically
- Binary BBL log parser (validated against BF Explorer, 245 tests)
- Multi-session support (multiple flights per file)
- FC diagnostics: debug_mode, logging rate, and feedforward configuration display with warnings + one-click fix

### Automated Filter Tuning
- FFT noise analysis (Welch's method, detrended Hanning windows, power-domain averaging, calibrated one-sided power spectrum — spectrum scale v2)
- Peak detection with plateau handling, 15 Hz minimum peak spacing, and parabolic sub-bin frequency interpolation
- Noise source classification (frame resonance via size-aware bands, motor harmonics, electrical)
- Noise-floor-based filter cutoff targeting with linear interpolation
- Medium noise handling: 20 Hz deadzone with low-confidence recommendations (avoids churn in the size-aware MEDIUM band — 5": -40 to -20 dB)
- Notch-aware resonance filtering: peaks within dyn_notch range are excluded from LPF recommendations (notch already handles them)
- RPM filter awareness: widens safety bounds (gyro LPF1 up to 500 Hz), optimizes dynamic notch count and Q
- Dynamic lowpass awareness: when `dyn_min_hz > 0`, tunes `dyn_min`/`dyn_max` instead of static cutoff; targets BF 2:1 ratio (dyn_max ≈ 2 × dyn_min), capped by safety bounds; enforces BF constraint `static_hz <= dyn_min_hz`
- Conditional dynamic notch Q: Q=300 (wide) when strong frame resonance detected, Q=500 (narrow) otherwise
- LPF2 recommendations: disable when RPM active + clean signal (< -35 dB), enable when overall noise level is HIGH (size-aware) without RPM
- Propwash floor protection (never pushes gyro LPF1 below 100 Hz)
- Group delay estimation for filter chain latency visualization (uses `dyn_min_hz` when dynamic active for worst-case delay)

### Automated PID Tuning
- Step response analysis (rise time, overshoot, settling time, latency, ringing)
- Quad-size-aware PID safety bounds for 7 drone sizes (1"–7") — prevents dangerous values on micros, allows higher D on large quads
- Severity-scaled P increase: P+5 for mild sluggishness, P+10 for very sluggish (rise time > 2× threshold)
- P informational warnings when P is unusually high (>1.3× typical) or low (<0.7× typical) for the quad size
- I-term rules: steady-state error detection with I increase/decrease recommendations (I min = 40)
- Damping ratio validation: D/P ratio check (0.45–0.85 range; ceiling 1.0 on 1"/2.5" micros) with automatic correction
- D-term effectiveness gating: measures D dampening vs noise ratio — redirects to filter tuning when D is mostly noise
- Prop wash detection: throttle-down event analysis with severity scoring per axis, measured against a clean-segment baseline (band energy outside drop windows)
- Cross-axis coupling detection: measures roll↔pitch interference
- Feedforward awareness: detects FF-dominated overshoot, recommends `feedforward_boost` reduction (step size 3) instead of P/D changes
- FF energy ratio: downgrades P-decrease confidence when feedforward contributes >60% of overshoot energy
- Proportional D step sizing: +5/+10/+15 based on overshoot severity
- D-min/TPA advisory notes on D recommendations when these features are active

### Transfer Function Analysis (Wiener Deconvolution)

Inspired by [Plasmatree PID-Analyzer](https://github.com/Plasmatree/PID-Analyzer) by Florian Melsheimer — the first tool to bring frequency-domain system identification to FPV tuning (2018). FPVPIDlab reimplements the technique in TypeScript with `fft.js`, extended with automatic PID recommendations.

- Computes closed-loop transfer function H(f) = S_xy(f) / (S_xx(f) + ε) from any flight data — no dedicated maneuvers needed
- 2-second Hanning windows with 50% Welch overlap, noise-floor-based regularization
- Synthetic step response via IFFT cumulative integration
- Bode plot visualization (magnitude + phase) with bandwidth, phase margin, and gain margin markers
- Frequency-domain PID rules: low phase margin (<45°) → D increase, low bandwidth → P increase (per-style thresholds)
- Per-axis magnitude-squared coherence γ²(f) with mean over the 1–30 Hz stick band; TF rules are gated per axis on coherence ≥ 0.5, and low-coherence axes get data quality warnings
- Gain/phase margins carry measured-crossing flags — axes without a measurable crossover are excluded from margin-based scoring instead of reporting the 60 dB / 90° caps as real
- Shares the same unified recommendation pipeline with Filter Tune and PID Tune (same gating logic, same safety bounds)
- DC gain analysis: detects poor steady-state tracking (< -1 dB → I increase)
- Per-band transfer function across 5 throttle levels — detects TPA tuning problems

### Bayesian PID Optimizer (Framework)
- Gaussian Process surrogate with RBF kernel
- Expected Improvement acquisition function
- Latin Hypercube Sampling for initial exploration
- Multi-session history-based optimization (available for future integration)

### Throttle Spectrogram Analysis
- Per-throttle-bin FFT computation (10 bins across 0–100% throttle range), computed from contiguous sample runs only (min 512 samples) to avoid splice artifacts
- Reveals how noise changes with motor speed (motor harmonics, frame resonance, electrical patterns)
- Used by the dynamic lowpass recommender; visualized in FilterAnalysisStep, AnalysisOverview, TuningCompletionSummary, and TuningSessionDetail

### Flight Style Preferences
- Smooth (cinematic), Balanced (freestyle), or Aggressive (racing)
- PID thresholds adapt to pilot preference (overshoot tolerances, rise time targets, settling limits)
- Style set per-profile, preset profiles include sensible defaults

### Data Quality Scoring
- Rates input flight data 0-100 (excellent/good/fair/poor)
- Adjusts recommendation confidence based on data quality
- Warns about insufficient hover time, missing axes, too few steps
- Flight quality score: composite 0-100 metric with type-aware components (Filter Tune: noise floor; PID Tune: tracking RMS, overshoot, settling time; Flash Tune: noise floor, overshoot, phase margin, bandwidth)

### Filter Tune

Filter-only tuning — 2 flights: analysis + mandatory verification.

**Flight (Filters):** Hover + throttle sweeps. FFT identifies noise sources (frame resonance, motor harmonics, electrical noise) and computes optimal filter cutoffs. RPM-filter-aware quads get wider safety bounds.

- 6-phase state machine (filter_flight_pending → filter_log_ready → filter_analysis → filter_applied → filter_verification_pending → completed) with per-profile persistence
- Smart reconnect: auto-advances to log_ready when flash data detected after FC reboot
- Post-erase flight guide with throttle sweep instructions
- Mandatory verification throttle sweep flight — before/after spectrogram comparison
- Tuning completion summary with applied changes and noise metrics

### PID Tune

PID-only tuning — 2 flights: analysis + mandatory verification.

**Flight (PIDs):** Sharp stick snaps on each axis with 500 ms holds. The step detector measures each response: rise time, overshoot, settling time, latency, ringing, and steady-state error. Time-domain measurement gives the most precise results.

- 6-phase state machine (pid_flight_pending → pid_log_ready → pid_analysis → pid_applied → pid_verification_pending → completed) with per-profile persistence
- Smart reconnect: auto-advances to log_ready when flash data detected after FC reboot
- Post-erase flight guide with stick snap instructions
- Mandatory verification stick snap flight — before/after step response comparison
- Tuning completion summary with applied changes and PID response data

### Flash Tune (Single Flight)

The fast approach — analyzes any single flight (freestyle, cruise, hover) using frequency-domain system identification. Based on the [Plasmatree PID-Analyzer](https://github.com/Plasmatree/PID-Analyzer) technique pioneered by Florian Melsheimer.

**How it works:** Normal stick inputs contain broadband energy that excites the PID loop. Wiener deconvolution recovers the transfer function from setpoint→gyro data, then synthesizes a step response. Filter analysis runs the same FFT pipeline as Filter Tune. Both analyses run in parallel from the same log.

**Trade-off:** No dedicated maneuvers needed, but frequency-domain estimates are noisier than direct step measurements. Filter Tune + PID Tune remain more precise for initial setup or major changes.

- Parallel filter + transfer function analysis with combined one-click apply
- Bode plot (magnitude + phase) with bandwidth, gain margin, and phase margin markers
- Synthetic step response metrics: overshoot, rise time, settling time derived from H(f)
- 6-phase state machine (flash_flight_pending → ... → completed)
- Best for experienced pilots iterating on an existing tune

### Tuning History
- Archived tuning records per profile (persistent across sessions)
- Mode-aware verification rendering: spectrogram comparison for Filter Tune, step response comparison for PID Tune, noise spectrum overlay for Flash Tune
- Applied filter and PID changes table with old → new values
- Flight quality score badge and trend chart across sessions
- Expandable history cards on the dashboard

### Interactive Charts
- FFT spectrum chart (noise per axis, floor lines, peak markers)
- Step response chart (setpoint vs gyro trace, metrics overlay)
- Bode plot chart (magnitude + phase, bandwidth/margin markers)
- Spectrogram comparison chart (side-by-side before/after throttle spectrograms for Filter Tune verification)
- Step response comparison (before/after PID metrics for PID Tune verification)
- Axis tabs (Roll/Pitch/Yaw/All) for all chart types
- Chart titles with descriptive subtitles explaining what each visualization shows
- Metric tooltips on hover for all analysis values (noise floor, overshoot, rise time, bandwidth, etc.)

## Tech Stack

- **Electron** - Desktop application framework
- **TypeScript** - Type-safe development
- **React** - UI framework
- **Vite** - Fast build tool
- **serialport** - USB serial communication
- **MSP Protocol** - Betaflight communication protocol
- **fft.js** - FFT computation for noise analysis
- **Recharts** - SVG-based interactive analysis charts
- **ESLint** + **Prettier** - Code linting and formatting (lint-staged pre-commit)

## Development

See [QUICK_START.md](./QUICK_START.md) for installation, setup, all available commands, and troubleshooting.

### Testing

All UI changes must include tests. Tests automatically run before commits. Coverage thresholds enforced: 80% lines/functions/statements, 75% branches.

**Unit tests:** 3333 tests across 153 files (plus 23 skipped fixture-gated tests) — MSP protocol, storage managers, IPC handlers, UI components, hooks, BBL parser fuzz, analysis pipeline validation, golden-output regression, telemetry, diagnostic, license, auto-updater.

**Playwright E2E:** 37 tests across 7 spec files — launches real Electron app in demo mode, walks through complete tuning cycles (Filter Tune, PID Tune, Flash Tune, diagnostic reports, and stress-test edge cases).

See [TESTING.md](./TESTING.md) for complete testing guidelines, test inventory, and best practices.

### Releasing

Releases are automated via GitHub Actions. To create a new release:

```bash
# Update version in package.json, then:
git tag v0.2.0
git push origin v0.2.0
```

This triggers the release workflow which builds native installers for macOS (`.dmg`), Windows (`.exe`), and Linux (`.AppImage`), then uploads them as a draft GitHub Release. Review the draft and publish it manually.

## Project Structure

```
pidlab/
├── src/
│   ├── main/                    # Main process (Node.js)
│   │   ├── index.ts             # Entry point, event wiring
│   │   ├── window.ts            # Window management
│   │   ├── msp/                 # MSP communication
│   │   │   ├── MSPClient.ts     # High-level MSP API (connect, read/write, download)
│   │   │   ├── MSPConnection.ts # Serial port + CLI mode + reboot handling
│   │   │   ├── MSPProtocol.ts   # Protocol encoding/decoding (MSP v1)
│   │   │   ├── cliUtils.ts      # CLI diff parsing, command extraction
│   │   │   ├── commands.ts      # MSP command definitions
│   │   │   └── types.ts         # MSP type definitions
│   │   ├── blackbox/            # BBL binary log parser (6 modules, 245 tests)
│   │   ├── analysis/            # Signal processing & tuning engine (27 modules)
│   │   │   ├── FFTCompute.ts              # Welch's method, Hanning window
│   │   │   ├── SegmentSelector.ts         # Hover/sweep segment detection
│   │   │   ├── NoiseAnalyzer.ts           # Peak detection, noise classification
│   │   │   ├── FilterRecommender.ts       # Noise-based filter targets
│   │   │   ├── DynamicLowpassRecommender.ts # Dynamic lowpass cutoff optimization
│   │   │   ├── FilterAnalyzer.ts          # Filter analysis orchestrator
│   │   │   ├── StepDetector.ts            # Step input detection in setpoint
│   │   │   ├── StepMetrics.ts             # Rise time, overshoot, settling, FF classification
│   │   │   ├── PIDRecommender.ts          # Rule-based P/I/D recommendations
│   │   │   ├── PIDAnalyzer.ts             # Unified PID analysis orchestrator (Deep + Flash)
│   │   │   ├── TransferFunctionEstimator.ts # Wiener deconvolution engine
│   │   │   ├── ThrottleTFAnalyzer.ts      # Per-band TF across throttle levels
│   │   │   ├── DataQualityScorer.ts       # Flight data quality scoring (0-100)
│   │   │   ├── PropWashDetector.ts        # Throttle-down event detection + severity
│   │   │   ├── DTermAnalyzer.ts           # D-term effectiveness ratio analysis
│   │   │   ├── CrossAxisDetector.ts       # Roll↔pitch coupling detection
│   │   │   ├── FeedforwardAnalyzer.ts     # Extended FF analysis (leading-edge, jitter)
│   │   │   ├── SliderMapper.ts            # BF Configurator slider mapping
│   │   │   ├── ThrottleSpectrogramAnalyzer.ts # Per-throttle-bin FFT
│   │   │   ├── GroupDelayEstimator.ts     # Filter chain latency estimation
│   │   │   ├── BayesianPIDOptimizer.ts    # GP-based multi-session optimizer
│   │   │   ├── ConvergenceDetector.ts     # Cross-session convergence detection
│   │   │   ├── VerificationMatcher.ts     # Verification flight similarity matching
│   │   │   ├── MechanicalHealthChecker.ts # Frame/motor health diagnostics
│   │   │   ├── WindDisturbanceDetector.ts # Wind/disturbance detection
│   │   │   ├── headerValidation.ts        # BB header diagnostics
│   │   │   ├── throttleUtils.ts           # Shared throttle normalization (contiguous-run finder lives in ThrottleSpectrogramAnalyzer)
│   │   │   └── constants.ts               # Tunable thresholds
│   │   ├── storage/             # Data managers
│   │   │   ├── ProfileManager.ts        # Multi-quad profile CRUD
│   │   │   ├── ProfileStorage.ts        # File-based profile storage
│   │   │   ├── SnapshotManager.ts       # Configuration snapshots
│   │   │   ├── BlackboxManager.ts       # BB log file management
│   │   │   ├── TuningSessionManager.ts  # Tuning session state machine
│   │   │   ├── TuningHistoryManager.ts  # Tuning history archive
│   │   │   └── FileStorage.ts           # Generic file storage utilities
│   │   ├── msc/                 # SD card Mass Storage Class support
│   │   │   ├── MSCManager.ts          # MSC download/erase orchestration
│   │   │   └── driveDetector.ts       # Cross-platform drive mount detection
│   │   ├── debug/              # Debug HTTP server (dev-only, port 9300)
│   │   │   └── DebugServer.ts         # 10 endpoints: /state, /screenshot, /logs, /console, /msp, /tuning-history, /tuning-session, /snapshots, /blackbox-logs, /health
│   │   ├── telemetry/           # Anonymous usage telemetry
│   │   │   └── TelemetryManager.ts    # Opt-in telemetry collection + upload
│   │   ├── license/            # License key system (freemium)
│   │   │   └── LicenseManager.ts      # Ed25519 offline verification, activate/remove
│   │   ├── updater.ts          # Auto-updater (electron-updater, GitHub Releases)
│   │   ├── demo/               # Demo mode (offline UX testing)
│   │   │   ├── MockMSPClient.ts       # Simulated FC (47 tests)
│   │   │   └── DemoDataGenerator.ts   # Realistic BBL generation (26 tests)
│   │   ├── cache/              # FC state cache (centralized MSP data)
│   │   │   └── FCStateCache.ts        # Hydrate/invalidate/clear, event push
│   │   ├── ipc/                 # IPC handlers (67 handlers across 13 modules)
│   │   │   ├── handlers/       # Domain-split handler modules
│   │   │   │   ├── index.ts            # DI container, registerIPCHandlers
│   │   │   │   ├── types.ts            # HandlerDependencies interface
│   │   │   │   ├── events.ts           # Event broadcast functions
│   │   │   │   ├── connectionHandlers.ts   # 8 handlers
│   │   │   │   ├── fcInfoHandlers.ts       # 7 handlers
│   │   │   │   ├── snapshotHandlers.ts     # 6 handlers
│   │   │   │   ├── profileHandlers.ts      # 11 handlers
│   │   │   │   ├── pidHandlers.ts          # 3 handlers
│   │   │   │   ├── blackboxHandlers.ts     # 9 handlers
│   │   │   │   ├── analysisHandlers.ts     # 3 handlers
│   │   │   │   ├── tuningHandlers.ts       # 8 handlers
│   │   │   │   ├── telemetryHandlers.ts    # 3 handlers
│   │   │   │   ├── licenseHandlers.ts      # 4 handlers
│   │   │   │   └── updateHandlers.ts       # 2 handlers
│   │   │   └── channels.ts     # Channel definitions
│   │   └── utils/               # Logger, error types
│   │
│   ├── preload/                 # Preload script
│   │   └── index.ts             # window.betaflight API bridge
│   │
│   ├── renderer/                # Renderer process (React)
│   │   ├── App.tsx              # Main layout, session routing
│   │   ├── components/
│   │   │   ├── ConnectionPanel/       # Port selection, connect/disconnect
│   │   │   ├── FCInfo/                # FC details + BB diagnostics + FixSettingsConfirmModal
│   │   │   ├── BlackboxStatus/        # Flash/SD card storage, download, erase
│   │   │   ├── SnapshotManager/       # Snapshot CRUD, diff view, restore
│   │   │   ├── TuningWizard/          # Multi-step tuning wizard
│   │   │   │   ├── charts/            # SpectrumChart, StepResponseChart, BodePlot, AxisTabs
│   │   │   │   ├── FilterAnalysisStep, PIDAnalysisStep  # Analysis result views
│   │   │   │   ├── QuickAnalysisStep  # Combined filter+PID for Flash Tune
│   │   │   │   ├── SessionSelectStep, TestFlightGuideStep # Pre-analysis steps
│   │   │   │   ├── TuningSummaryStep, WizardProgress     # Summary + progress
│   │   │   │   ├── RecommendationCard, ApplyConfirmationModal
│   │   │   │   └── FlightGuideContent # Flight phase instructions
│   │   │   ├── TuningStatusBanner/    # Workflow progress banner
│   │   │   ├── AnalysisOverview/      # Read-only analysis view (+ Bode plot fallback)
│   │   │   ├── TuningHistory/         # History panel + completion summary
│   │   │   │   ├── TuningHistoryPanel, TuningSessionDetail
│   │   │   │   ├── TuningCompletionSummary  # Replaces banner on completion
│   │   │   │   ├── NoiseComparisonChart     # Before/after spectrum overlay
│   │   │   │   ├── SpectrogramComparisonChart  # Side-by-side spectrogram comparison
│   │   │   │   ├── StepResponseComparison      # Before/after PID metrics comparison
│   │   │   │   ├── QualityTrendChart        # Flight quality score progression
│   │   │   │   └── AppliedChangesTable      # Setting changes with % diff
│   │   │   ├── TuningWorkflowModal/   # 3-tab workflow help (Filter, PID, Flash)
│   │   │   ├── StartTuningModal.tsx   # Filter Tune / PID Tune / Flash Tune mode selector
│   │   │   ├── TelemetrySettings/     # Telemetry opt-in/out settings modal (tabbed: Telemetry + Logs)
│   │   │   ├── LicenseSettings/      # License activation modal (free/Pro comparison)
│   │   │   ├── UpdateNotification/   # Auto-update pill + changelog modal
│   │   │   ├── Toast/                 # Toast notification system
│   │   │   ├── ProfileWizard.tsx      # New FC profile creation wizard
│   │   │   ├── PresetSelector.tsx     # Preset profile picker
│   │   │   ├── ProfileSelector.tsx    # Profile switching dropdown
│   │   │   ├── ErrorBoundary.tsx      # React error boundary (crash recovery)
│   │   │   ├── ProfileCard.tsx        # Individual profile display
│   │   │   ├── ProfileEditModal.tsx   # Profile editing dialog
│   │   │   └── ProfileDeleteModal.tsx # Profile deletion confirmation
│   │   ├── hooks/               # React hooks (16)
│   │   │   ├── useConnection.ts       # Connection state management
│   │   │   ├── useProfiles.ts         # Profile CRUD operations
│   │   │   ├── useSnapshots.ts        # Snapshot management
│   │   │   ├── useTuningSession.ts    # Tuning session lifecycle
│   │   │   ├── useTuningWizard.ts     # Wizard state (parse/analyze/apply)
│   │   │   ├── useAnalysisOverview.ts # Read-only analysis state
│   │   │   ├── useTuningHistory.ts    # Tuning history loading
│   │   │   ├── useBlackboxInfo.ts     # BB flash info
│   │   │   ├── useBlackboxLogs.ts     # BB log list
│   │   │   ├── useFCState.ts          # Centralized FC state from cache
│   │   │   ├── useFCInfo.ts           # FC info polling
│   │   │   ├── useTelemetrySettings.ts # Telemetry settings + manual upload
│   │   │   ├── useLicense.ts          # License activation + status
│   │   │   ├── useAutoUpdate.ts       # Auto-update state + events
│   │   │   ├── useDemoMode.ts         # Demo mode detection
│   │   │   └── useToast.ts            # Toast context consumer
│   │   ├── utils/               # Renderer utilities
│   │   │   └── bbSettingsUtils.ts     # BB settings status computation
│   │   ├── contexts/            # React contexts
│   │   │   └── ToastContext.tsx
│   │   └── test/                # Test setup
│   │       └── setup.ts         # window.betaflight mock
│   │
│   └── shared/                  # Shared types & constants
│       ├── types/               # TypeScript interfaces (11 type files)
│       ├── utils/               # Shared utilities
│       │   ├── metricsExtract.ts      # Metrics extraction, spectrum downsampling
│       │   └── tuneQualityScore.ts    # Composite flight quality score (0-100)
│       └── constants/           # MSP codes, presets, flight guides
│
├── e2e/                         # Playwright E2E tests (demo mode)
│   ├── electron-app.ts                # Shared fixture (launchDemoApp, helpers)
│   ├── demo-smoke.spec.ts             # 4 smoke tests
│   ├── demo-tuning-cycle.spec.ts      # 7 Filter Tune cycle tests
│   ├── demo-pid-tune-cycle.spec.ts   # 7 PID Tune cycle tests
│   ├── demo-quick-tune-cycle.spec.ts  # 7 Flash Tune cycle tests
│   ├── demo-generate-history.spec.ts  # Mixed history generator
│   └── demo-generate-stress.spec.ts   # Stress test (edge cases)
│
├── infrastructure/              # Cloud infrastructure (Cloudflare Workers, R2, D1)
│   └── README.md                      # Infrastructure overview
│
├── .claude/                     # Claude Code configuration
│   ├── settings.json                    # Permissions + PostToolUse hook registration
│   ├── skills/tuning-advisor/SKILL.md   # /tuning-advisor skill (4 modes: consult, review, audit, analyze)
│   └── hooks/tuning-logic-check.sh      # PostToolUse hook for analysis file edits
│
└── docs/                        # Design documents (see docs/README.md for index)
    ├── README.md                          # Document index
    ├── PID_TUNING_KNOWLEDGE.md            # FPV tuning knowledge base (for /tuning-advisor skill)
    ├── TUNING_PRECISION_IMPROVEMENTS.md   # Active — research-based tuning improvements
    ├── UX_IMPROVEMENT_IDEAS.md            # Active — UX improvement backlog
    └── complete/                          # Completed design docs (15 historical records)
```

## Usage

### 1. First Connection & Profile Setup

1. Connect your flight controller via USB
2. Click **Scan** to detect available serial ports
3. Select your FC from the dropdown and click **Connect**
4. On first connection with a new FC, the **Profile Wizard** opens automatically:
   - Choose a preset profile (e.g., "5 inch Freestyle") or create a custom one
   - Enter quad name, size, weight, motor KV, battery config
   - Profile is linked to the FC's unique serial number
5. A **baseline snapshot** is created automatically, capturing the FC's current configuration

On subsequent connections, the app recognizes the FC by serial number and auto-selects the correct profile.

### 2. Pre-Flight Setup

Before flying, check the **Flight Controller Information** panel:

- **Debug Mode** should be `GYRO_SCALED` for noise analysis — **BF 4.3–4.5 only** (not needed on BF 2025.12+, hidden automatically)
- **Logging Rate** should be at least 2 kHz (shown with green checkmark or amber warning)
- **Feedforward** section shows current FF configuration read from FC (boost, per-axis gains, smoothing, jitter factor, transition, max rate limit)

If settings are wrong, click **Fix Settings** in the FC info panel — the app sends the CLI commands and reboots the FC automatically. During an active tuning session, the **TuningStatusBanner** also shows an amber pre-flight warning with a one-click fix button.

### 3. Filter Tune

Click **Start Tuning Session** and select **Filter Tune** (recommended starting point). The status banner tracks your progress through 4 steps: Prepare → Flight → Tune → Verify.

1. **Erase Flash** — Clear old Blackbox data before flying
2. **Fly filter test flight** — Hover with gentle throttle sweeps (30-60 seconds)
3. **Reconnect** — App auto-detects new flight data on reconnect
4. **Download log** — Download Blackbox data from FC
5. **Analyze** — Click Analyze to open the filter wizard:
   - Auto-parses the log and runs FFT noise analysis
   - Shows noise spectrum, detected peaks, and filter recommendations
   - Review recommendations, then click **Apply Filters** (applies via CLI + reboots FC)
6. **Verification flight** — Click "Erase & Verify", fly another throttle sweep, download and analyze; the app compares before/after spectrograms side-by-side

### 3b. PID Tune

Click **Start Tuning Session** and select **PID Tune**. Same 4-step layout: Prepare → Flight → Tune → Verify.

1. **Erase Flash** — Clear flash for the PID test flight
2. **Fly PID test flight** — Sharp stick snaps on all axes (roll, pitch, yaw)
3. **Reconnect & download** — Same as Filter Tune
4. **Analyze** — Opens the PID wizard:
   - Detects step inputs, measures response metrics (overshoot, rise time, settling)
   - Shows step response charts and PID recommendations
   - Click **Apply PIDs** to apply changes
5. **Verification flight** — Click "Erase & Verify", fly another stick snap flight, download and analyze; the app compares before/after step response metrics

The session shows a **completion summary** with all applied changes and tuning metrics. You can start a new tuning cycle to iterate further. Past sessions are archived in the **Tuning History** panel on the dashboard.

### 4. Flash Tune (Single Flight)

Click **Start Tuning Session** and select **Flash Tune**:

1. **Erase Flash** — Clear old data
2. **Fly any flight** — Freestyle, cruise, stick snaps — any 30+ second flight works
3. **Download & analyze** — App runs two analyses in parallel:
   - **FFT noise analysis** (same as Filter Tune) for filter recommendations
   - **Wiener deconvolution** for PID recommendations — estimates the transfer function from setpoint→gyro data and synthesizes a step response
4. **Review Bode plot** — Magnitude + phase curves with bandwidth, gain margin, and phase margin markers
5. **Apply all** — Combined filter + PID changes in one click
6. **Verification flight** — Click "Erase & Verify", hover flight, download and analyze for before/after noise comparison

Based on the [Plasmatree PID-Analyzer](https://github.com/Plasmatree/PID-Analyzer) technique by Florian Melsheimer (2018). Normal stick inputs contain enough broadband energy to recover the transfer function from any flight.

**Trade-off:** Wiener deconvolution assumes a linear time-invariant system — real quads are nonlinear (TPA, anti-gravity, motor saturation). PID Tune provides more precise step measurements; Flash Tune is faster for iterating on an existing tune.

### 5. Standalone Analysis (No Tuning Session)

If you just want to analyze a log without applying changes:

1. Connect FC and download a Blackbox log
2. Click **Analyze** on any downloaded log (without starting a tuning session)
3. Opens a **read-only Analysis Overview** — shows filter analysis (noise spectrum), PID analysis (step response or Bode plot), and diagnostic data on a single page
4. No Apply buttons — purely informational, great for reviewing flight data

### 6. Managing Snapshots

Snapshots capture the FC's full CLI configuration at a point in time.

- **Baseline** — Auto-created on first connection, cannot be deleted
- **Manual** — Create anytime via "Create Snapshot" button with optional label
- **Pre-tuning** — Auto-created when starting a tuning session (rollback safety net), labeled with session number and type
- **Post-tuning** — Auto-created on reconnect after applying tuning changes, labeled with session number and type
- **Compare** — Smart matching: auto-selects pre/post-tuning snapshots from the same session for comparison
- **Restore** — Roll back to any snapshot (creates a safety backup first, sends CLI commands, reboots FC)
- **Export** — Download as `.txt` file

### 7. Exporting Configuration

The FC Info panel provides two export options:

- **Export CLI Diff** — Only changed settings (recommended for sharing/backup)
- **Export CLI Dump** — Full configuration dump

### 8. Blackbox Storage Management

The Blackbox Storage panel shows flash/SD card usage and downloaded logs:

- **Download** — Downloads flight data from FC flash or SD card (MSC mode for SD)
- **Erase** — Permanently deletes all data from FC storage (required before each test flight)
- **Test Read** — Diagnostic tool to verify FC flash communication
- **Open Folder** — Opens the local log storage directory

During an active tuning session, Blackbox actions are driven by the status banner (single point of action).

## Troubleshooting

### Port Access Issues

**macOS/Linux:**
```bash
sudo chmod 666 /dev/ttyUSB0  # or your port
```

**Windows:**
- Install STM32 VCP drivers
- Check Device Manager for COM port

### Rebuild Native Modules

If serialport doesn't work after installation:
```bash
npm run rebuild
```

### Connection Timeout

- Ensure FC is powered on
- Check USB cable (data cable, not charge-only)
- Try different USB port
- Restart the application

### FC Not Detected

- Verify FC is in MSP mode (not CLI or DFU)
- Check Betaflight Configurator can connect
- Install proper USB drivers

### "FC not responding to MSP commands"

- Caused by reconnecting too quickly after disconnect
- Wait for the 3-second cooldown timer, then retry
- If persistent, physically unplug and replug the USB cable

## MSP Protocol

The app uses the MultiWii Serial Protocol (MSP) v1 to communicate with Betaflight:

- **MSP_API_VERSION** - Get API version
- **MSP_FC_VARIANT** / **MSP_FC_VERSION** - Firmware identification
- **MSP_BOARD_INFO** - Board and target information
- **MSP_UID** - Unique FC serial number (for profile matching)
- **MSP_PID** / **MSP_SET_PID** - Read/write PID configuration
- **MSP_FILTER_CONFIG** - Read current filter settings
- **MSP_PID_ADVANCED** - Read feedforward configuration (boost, gains, smoothing, jitter, transition)
- **MSP_DATAFLASH_SUMMARY** - Flash storage information
- **MSP_DATAFLASH_READ** - Download Blackbox data
- **MSP_DATAFLASH_ERASE** - Erase flash storage
- **MSP_SDCARD_SUMMARY** - SD card storage information
- **MSP_REBOOT** - Reboot FC (type=2 for MSC mode — SD card as USB drive)
- **CLI Mode** - For configuration export, snapshot restore, and filter tuning

## Configuration Storage

All data is stored locally per platform:

- **macOS**: `~/Library/Application Support/fpvpidlab/data/`
- **Windows**: `%APPDATA%/fpvpidlab/data/`
- **Linux**: `~/.config/fpvpidlab/data/`

Subdirectories:
- `profiles/` — Quad profile JSON files + metadata index
- `snapshots/` — Configuration snapshot JSON files
- `blackbox/` — Downloaded Blackbox log files (`.bbl`)
- `tuning/` — Tuning session state files (per profile)
- `tuning-history/` — Archived tuning records (per profile)
- `telemetry-settings.json` — Telemetry opt-in settings and anonymous installation ID

## How Autotuning Works

This section documents the signal processing and decision logic behind FPVPIDlab's recommendations. All recommendations are computed from measured flight data — not from presets or lookup tables. The system is **convergent**: re-analyzing the same Blackbox log always produces identical recommendations regardless of current FC settings.

| | Filter Tune | PID Tune | Flash Tune |
|---|---|---|---|
| **Flights** | 1 dedicated flight | 1 dedicated flight | 1 normal flight |
| **Focus** | Filters only | PIDs only | Filters + PIDs combined |
| **Flight data** | Hover + throttle sweeps | Stick snaps on each axis | Any flight (freestyle, cruise, hover) |
| **Analysis** | FFT noise analysis | Step response metrics | FFT + Wiener deconvolution (parallel) |
| **Verification** | Throttle sweep → spectrogram comparison | Stick snaps → step response comparison | Optional hover → noise comparison |
| **Post-processing** | Shared unified pipeline | Shared unified pipeline | Shared unified pipeline |

### Filter Tuning (FFT Analysis)

Analyzes gyro noise to compute optimal lowpass cutoffs. The analysis code (`FilterAnalyzer.analyze()`) is identical for all modes — only the input flight data differs:

- **Filter Tune** — Dedicated filter flight (hover + throttle sweeps, ~30s). `SegmentSelector` finds clean hover and sweep segments easily.
- **Flash Tune** — Same flight as PID analysis. `SegmentSelector` extracts any hover/sweep segments from normal flying. If none found (aggressive acro), falls back to entire-flight analysis with accuracy warning and lower data quality score.

**Core pipeline:** `SegmentSelector` → `FFTCompute` → `NoiseAnalyzer` → `FilterRecommender`
**Supplementary:** `DataQualityScorer`, `ThrottleSpectrogramAnalyzer`, `GroupDelayEstimator`, `WindDisturbanceDetector`, `MechanicalHealthChecker`, `DynamicLowpassRecommender`

1. **Segment selection** — Finds stable hover segments from throttle and gyro data (excludes takeoff, landing, aggressive maneuvers). Prefers throttle sweeps, falls back to steady hovers (up to 5 segments). If none found (e.g., aggressive Flash Tune flight), uses the entire flight with an accuracy warning.
2. **Data quality scoring** — Rates flight data 0–100. Sub-scores: segment count (0.20), hover time (0.35), throttle coverage (0.25), segment type (0.20). Tiers: excellent (80+), good (60–79), fair (40–59), poor (<40). Fair/poor downgrades recommendation confidence.
3. **FFT computation** — Welch's method (detrended Hanning windows, 50% overlap, 4096-sample windows, power-domain averaging) → calibrated one-sided power spectrum per axis (spectrum scale v2: a sine of amplitude A reads 10·log10(A²/2)), trimmed to 20–1000 Hz. All absolute dB thresholds below are calibrated to this scale (≈10 dB above the legacy amplitude-averaged scale).
4. **Noise analysis** — Estimates noise floor (lower quartile), detects peaks (>6 dB above local floor, plateau-aware, 15 Hz minimum spacing, parabolic sub-bin interpolation), classifies sources:
   - Frame resonance (size-aware band: 5" 80–200 Hz, 1"/2.5" 150–350 Hz, 7" 60–150 Hz)
   - Motor harmonics (equally-spaced peaks)
   - Electrical noise (>500 Hz)
5. **Throttle spectrogram** — Bins gyro data by throttle (10 bands), computes per-band FFT from contiguous runs only (min 512 samples per run, length-weighted power average). Feeds the dynamic lowpass recommender.
6. **Filter recommendation** — Maps measured noise floor (dB) to target cutoff (Hz) via linear interpolation between safety bounds.
7. **Dynamic lowpass** — When noise increases ≥ 6 dB from low to high throttle (Pearson ≥ 0.6), recommends dynamic lowpass for gyro LPF1 and D-term LPF1. D-term benefits more because the derivative amplifies high-frequency noise.
8. **Group delay estimation** — Estimates total filter chain latency (gyro + D-term). Warns when delay exceeds 2 ms.
9. **Wind detection** — Analyzes gyro variance during hover. High variance reduces recommendation confidence.
10. **Mechanical health** — Flags extreme noise (size-aware threshold: max(-10 dB, size HIGH threshold + 5 dB) — e.g. -10 dB for 5", 0 dB for 1"), asymmetric roll/pitch noise (> 8 dB), motor imbalance (> 3× ratio) before tuning proceeds.

#### Filter Safety Bounds

| Filter | Min Cutoff | Max Cutoff (no RPM) | Max Cutoff (with RPM) | Source |
|--------|-----------|--------------------|-----------------------|--------|
| Gyro LPF1 | 75 Hz | 300 Hz | 500 Hz | [BF Tuning Guide](https://www.betaflight.com/docs/wiki/guides/current/PID-Tuning-Guide): 50 Hz = "very noisy", 80 Hz = "slightly noisy"; 75 Hz is a conservative midpoint |
| D-term LPF1 | 70 Hz | 200 Hz | 300 Hz | [BF Filtering Wiki](https://github.com/betaflight/betaflight/wiki/Gyro-&-Dterm-filtering-recommendations): "70–90 Hz range" for D-term |

The **minimum cutoffs** are derived from the official Betaflight guides. The **maximum cutoffs** represent the point where further relaxation provides negligible latency benefit. With RPM filter active, maximums are raised because 36 per-motor notch filters already handle motor noise, so the lowpass can afford to be more relaxed.

**Propwash floor:** Gyro LPF1 is never pushed below 100 Hz to preserve responsiveness in the 20–90 Hz prop wash band; the floor is bypassed only when the noise floor is extreme (> -5 dB on the v2 scale). This is a conservative FPVPIDlab house rule — the BF wiki's "avoid below 100 Hz" guidance concerns notch filters, and the community D-term floor is ~80 Hz (Oscar Liang).

#### Noise-Based Targeting (Linear Interpolation)

The cutoff target is computed from the **worst-case noise floor** across roll and pitch axes (dB), mapped linearly to the cutoff range:

```
t = (noiseFloorDb - 0) / ((-60) - 0)
targetHz = minHz + t × (maxHz - minHz)
```

| Noise Floor (dB, v2 scale) | Meaning | Gyro LPF1 Target | D-term LPF1 Target |
|-------------------|---------|-------------------|---------------------|
| **0 dB** (very noisy) | Extreme vibration/noise | 75 Hz (min) | 70 Hz (min) |
| **-30 dB** (moderate) | Typical mid-range quad | ~188 Hz | ~135 Hz |
| **-60 dB** (very clean) | Pristine signal | 300 Hz (max) | 200 Hz (max) |

The 0 dB and -60 dB anchor points are calibrated from real Blackbox logs across various frame sizes (3"–7") on the v2 power-spectrum scale. Same noise data always produces the same target, regardless of current settings.

#### Filter Decision Table

| Rule | Trigger Condition | Action | Confidence | Source / Rationale |
|------|-------------------|--------|------------|---------------------|
| **Noise floor → lowpass (high)** | Overall noise level HIGH (size-aware; 5": > -20 dB) | Set gyro/D-term LPF1 to noise-based target | High | Linear interpolation from BF guide bounds (see above) |
| **Noise floor → lowpass (medium)** | Overall noise level MEDIUM (size-aware; 5": -40 to -20 dB), \|target − current\| > 20 Hz | Set gyro/D-term LPF1 to noise-based target | Low | Medium noise: wider deadzone (20 Hz), low confidence to avoid churn |
| **Dead zone** | \|target − current\| ≤ 5 Hz (high noise) or ≤ 20 Hz (medium noise) | No change recommended | — | Prevents micro-adjustments that add no real benefit |
| **Dynamic mode targeting** | Any noise-floor rule fires AND `dyn_min_hz > 0` | Target `dyn_min_hz` instead of `static_hz`; proportionally adjust `dyn_max_hz` to maintain ratio; lower `static_hz` to ≤ `dyn_min` (BF constraint) | Same as base rule | When dynamic lowpass is active, the tightest cutoff is `dyn_min` — tuning static would have no effect |
| **Resonance peak → cutoff** | Peak ≥ 12 dB above floor AND outside dyn_notch coverage AND below current cutoff | Lower cutoff to peakFreq − 20 Hz (clamped to bounds). When dynamic active, targets `dyn_min_hz` | High | Notch-aware: peaks within dyn_notch_min–max count as covered only when `dyn_notch_count > 0` — with notches disabled, the LPF rule handles them |
| **Disabled gyro LPF + resonance** | gyro_lpf1 = 0 (disabled) AND resonance peak outside notch range | Enable gyro LPF1 at peakFreq − 20 Hz | High | Common BF 4.4+ config with RPM filter; re-enable when needed |
| **Dynamic notch range** | Peak below `dyn_notch_min_hz` | Lower dyn_notch_min to peakFreq − 20 Hz (floor: 50 Hz) | Medium | Notch can't track peaks outside its configured range |
| **Dynamic notch range** | Peak above `dyn_notch_max_hz` | Raise dyn_notch_max to peakFreq + 20 Hz (ceiling: 1000 Hz) | Medium | Same as above, upper bound |
| **RPM → notch count** | RPM filter active AND dyn_notch_count > size target (2 for sub-5", 1 for 5"+) | Reduce dyn_notch_count toward size target, max step 2 per iteration | High | Motor noise handled by RPM notches; sub-5" keeps 2 notches for frame vibration modes. Conservative stepping avoids removing too many notches at once |
| **RPM → notch Q** | RPM filter active AND no strong frame resonance | Raise dyn_notch_q to 500 | High | Only weak resonances remain; narrower notch = less signal distortion |
| **RPM → notch Q (resonance)** | RPM filter active AND strong frame resonance (≥ 12 dB, size-aware band — 5": 80-200 Hz) | Keep dyn_notch_q at 300 | Medium | Broad frame resonance needs wider notch to be effective |
| **LPF2 disable (gyro)** | RPM active AND noise < -35 dB | Disable gyro LPF2 | Medium | Very clean signal: LPF2 adds latency with no benefit |
| **LPF2 disable (D-term)** | RPM active AND noise < -35 dB | Disable D-term LPF2 | Medium | Clean signal with RPM: D-term LPF2 latency unnecessary |
| **LPF2 enable (gyro)** | No RPM AND overall noise level HIGH AND LPF2 disabled | Enable gyro LPF2 (250 Hz) | Low | Noisy without RPM: extra filtering protects motors |
| **LPF2 enable (D-term)** | No RPM AND overall noise level HIGH AND LPF2 disabled | Enable D-term LPF2 (150 Hz) | Low | High noise without RPM needs additional D-term protection |
| **F-YAW-RES** | Yaw-only peak ≥ 12 dB above floor, not covered by dyn_notch, no roll/pitch counterpart within 15 Hz | Informational observation (no value change) | Low | Yaw-only resonance often indicates loose FC stack, uneven motor mounting, or frame flex — yaw never drives LPF cutoffs |
| **F-DLPF-GYRO** | Throttle spectrogram noise increases ≥ 6 dB, Pearson ≥ 0.6, gyro LPF1 > 0, AND gyro dynamic NOT already active | Enable `gyro_lpf1_dyn_min_hz` (current static cutoff) and `gyro_lpf1_dyn_max_hz` (current static × 2) | Medium | BF 2:1 ratio convention: dyn_min = static, dyn_max = 2 × static. Throttle-ramped cutoff: more filtering at high throttle, less latency at cruise |
| **F-DLPF-DTERM** | Same throttle-noise trigger as F-DLPF-GYRO AND D-term LPF1 > 0 AND D-term dynamic NOT already active | Enable `dterm_lpf1_dyn_min_hz` (current static cutoff) and `dterm_lpf1_dyn_max_hz` (current static × 2) | Medium | BF 2:1 ratio convention. D amplifies high-frequency noise — dynamic filtering reduces motor heating at high throttle while preserving stick feel at cruise |
| **F-DLPF-GYRO-OFF** | No throttle-noise trigger AND noise delta < 4 dB AND `gyro_lpf1_dyn_min_hz > 0` | Disable gyro dynamic lowpass (`dyn_min_hz → 0`) | Low | Hysteresis: enable at ≥ 6 dB, disable only below 4 dB — deltas in the 4–6 dB gray zone leave the config untouched (prevents flip-flop) |
| **F-DLPF-DTERM-OFF** | Same no-throttle-noise trigger (delta < 4 dB) AND `dterm_lpf1_dyn_min_hz > 0` | Disable D-term dynamic lowpass (`dyn_min_hz → 0`) | Low | Simplify filter stack when throttle-dependent noise is absent (same 4/6 dB hysteresis) |
| **Deduplication** | Multiple rules target same setting | Keep more aggressive value, upgrade confidence | — | Ensures a single coherent recommendation per setting. Informational (no-op) recommendations pass through unmerged — they never replace or absorb an actionable recommendation |

**RPM filter awareness:** When RPM filter is active, safety bounds widen because 36 per-motor notch filters already handle motor noise. The dynamic notch is optimized (count stepped down toward the size target — 2 for sub-5", 1 for 5"+ — and Q 300→500) since only frame resonances remain.

**Dynamic lowpass awareness:** When `dyn_min_hz > 0`, the FilterRecommender recognizes that the effective cutoff is `dyn_min` (not `static_hz`). All noise-floor and resonance rules transparently target `dyn_min_hz`/`dyn_max_hz` instead of `static_hz`, maintaining the dynamic range ratio. The DynamicLowpassRecommender only fires enable/disable rules when the dynamic state needs to change — when dynamic is already active, the FilterRecommender handles tuning directly.

#### Filter Methodology Sources

| Source | What We Use From It |
|--------|---------------------|
| [Betaflight PID Tuning Guide](https://www.betaflight.com/docs/wiki/guides/current/PID-Tuning-Guide) | Gyro LPF1 cutoff range (50–80 Hz for noisy quads), general filtering philosophy |
| [BF Filtering Wiki](https://github.com/betaflight/betaflight/wiki/Gyro-&-Dterm-filtering-recommendations) | D-term LPF1 "70–90 Hz" recommendation, dynamic notch configuration |
| [BF Configurator](https://github.com/betaflight/betaflight-configurator) | RPM-aware max cutoffs (verified against Configurator auto-adjust behavior) |
| [Oscar Liang: PID Filter Tuning](https://oscarliang.com/pid-filter-tuning-blackbox/) | Blackbox-based filter tuning workflow, noise floor interpretation |
| [PIDtoolbox](https://pidtoolbox.com/home) | Spectral analysis methodology, noise floor percentile approach |
| Real Blackbox logs (3"–7" quads) | Calibration of 0 dB / -60 dB noise anchor points (v2 power-spectrum scale) |

### PID Tuning (Unified Pipeline)

Two extraction methods feed into the same recommendation engine. Both produce per-axis profiles with identical metrics — only the measurement method differs.

```
PID Tune:   StepDetector → StepMetrics → profiles + CrossAxisDetector + FeedforwardAnalyzer
Flash Tune: TransferFunctionEstimator (Wiener deconvolution) → synthetic profiles + ThrottleTFAnalyzer
                ↓                                                       ↓
                └──────────────── analyzePIDCore() ─────────────────────┘
                                      ↓
              PropWashDetector + DTermAnalyzer + DataQualityScorer + FeedforwardAnalyzer (header)
                                      ↓
              PIDRecommender → Post-processing (D-term gating, prop wash, damping ratio, quality)
                                      ↓
              SliderMapper + BayesianPIDOptimizer (when ≥3 sessions)
```

#### PID Tune: Step Detection

A "step" is a rapid stick movement. The detector scans setpoint data per axis:

1. Compute setpoint derivative at each sample
2. Flag samples where |derivative| > 500 deg/s/s as potential edges
3. Group consecutive edge samples into a single step
4. Validate: magnitude ≥ 150 deg/s, hold ≥ 50 ms, cooldown ≥ 100 ms between steps

#### PID Tune: Response Metrics

For each valid step, a 300 ms response window is analyzed:

| Metric | Definition | How It's Measured |
|--------|-----------|-------------------|
| **Rise time** | How fast the quad responds | Time from 10% to 90% of final gyro value |
| **Overshoot** | How much gyro exceeds the target | Peak deviation beyond steady-state, as % of step magnitude |
| **Settling time** | How quickly oscillations die out | Last time gyro exits the ±2% band around steady-state |
| **Latency** | Delay before first movement | Time until gyro moves >5% of step magnitude from baseline |
| **Ringing** | Post-step oscillation count | Zero-crossings around steady-state, counted as full cycles. SNR filter: oscillations below 5% of step magnitude are treated as gyro noise and excluded |
| **Steady-state error** | Accuracy after settling | Difference between target and actual position after settling |
| **FF energy ratio** | Feedforward vs P contribution | Sum-of-squares energy ratio `FF/(FF+P)` over step response window |

Metric definitions follow standard control theory (consistent with MATLAB `stepinfo`).

#### Flash Tune: Transfer Function Extraction

Flash Tune estimates the closed-loop transfer function H(f) = S_xy(f) / (S_xx(f) + ε) via Wiener deconvolution from any flight data. A synthetic step response is derived via IFFT cumulative integration. Extracted metrics: bandwidth (-3 dB), phase margin, gain margin (both carry a measured-crossing flag — unmeasured margins are excluded from scoring), overshoot, settling time, DC gain, and per-axis coherence γ²(f) with `coherenceMean` over the 1–30 Hz stick band. Per-band analysis across 5 throttle levels (longest contiguous run per band, min 2048 samples) reveals TPA tuning problems when metrics vary significantly with throttle.

#### Shared Recommendation Engine

All recommendations are anchored to the PID values from the Blackbox log header (the PIDs active during the flight), making them convergent — applying and re-analyzing produces no further changes. Step-response and TF rules run together in `recommendPID()` with deduplication.

**Flight Style Thresholds:**

| Threshold | Smooth | Balanced | Aggressive |
|-----------|--------|----------|------------|
| Overshoot ideal | 3% | 10% | 18% |
| Overshoot max | 12% | 25% | 35% |
| Moderate overshoot | 8% | 15% | 25% |
| Settling max | 250 ms | 200 ms | 150 ms |
| Ringing max | 1 cycle | 2 cycles | 3 cycles |
| Sluggish rise time | 120 ms | 80 ms | 50 ms |
| Steady-state error max | 8% | 5% | 3% |

*Yaw axis uses relaxed thresholds (1.5× overshoot limit, 1.5× ringing limit, 1.5× sluggish threshold).*

**PID Decision Table (Balanced thresholds shown):**

| Rule | Condition | Action | Step Size | Confidence | Rationale |
|------|-----------|--------|-----------|------------|-----------|
| **1a** | Overshoot > 25% (severity 1–2×) | D ↑ | +5 | High | D-term dampens bounce-back |
| **1a** | Overshoot > 25% (severity 2–4×) | D ↑ | +10 | High | Proportional step for faster convergence |
| **1a** | Overshoot > 25% (severity > 4×) | D ↑ | +15 | High | Extreme overshoot needs aggressive dampening |
| **1a** | Overshoot > 25% AND (severity > 2× OR D ≥ 60% of max) | P ↓ | -5 / -10 | High | D alone insufficient at extreme overshoot |
| **1b** | Overshoot 15–25% | D ↑ | +5 | Medium | Moderate overshoot, D-first strategy |
| **1c** | FF-dominated overshoot (FF > P at peak) | FF boost ↓ | -3 | Medium | Overshoot caused by feedforward, not P/D |
| **2** | Overshoot < 10% AND rise time > 80 ms (severity ≤ 2×) | P ↑ | +5 | Medium | Sluggish response needs more authority |
| **2** | Overshoot < 10% AND rise time > 160 ms (severity > 2×) | P ↑ | +10 | Medium | Very sluggish — larger step for faster convergence |
| **2b** | P > pTypical × 1.3 for quad size | P (informational) | same | Low | Warning only: P is high for this quad type |
| **3** | Ringing > 2 cycles | D ↑ | +5 | Medium | Oscillation = underdamped response |
| **4** | Settling > 200 ms AND overshoot < 15% | D ↑ | +5 | Low | Slow convergence, may have other causes |
| **5a** | Steady-state error > 5% | I ↑ | +5 / +10 | Medium / High | Tracking drift during holds, improves wind resistance |
| **5b** | Low error + slow settling + overshoot | I ↓ | -5 | Low | I-term oscillation pattern |

**Post-Processing Rules:**

| Rule | Condition | Action | Rationale |
|------|-----------|--------|-----------|
| **Damping ratio (underdamped)** | D/P < 0.45, no existing D rec | D ↑ to reach 0.45 ratio | Maintains healthy D/P balance |
| **Damping ratio (overdamped)** | D/P > 0.85, D was increased | P ↑ proportionally | Prevents excessive damping after D adjustment |
| **Damping ratio (overdamped)** | D/P > 0.85, no recs exist | D ↓ to reach 0.85 ratio | Reduces motor heat and noise |
| **D-term effectiveness (critical)** | D increase rec + dCritical flag | Upgrade confidence → High | D-term is doing useful dampening work, increase is safe |
| **D-term effectiveness (balanced)** | D increase rec + effectiveness 0.3–0.7 | Advisory note: monitor temps | D has some noise cost, user should check motor heat |
| **D-term effectiveness (low)** | D increase rec + effectiveness < 0.3 | Block the D increase; replace with informational "improve filters first" rec (`P-DTE-BLOCK`) | D is mostly noise — more D would mainly heat motors. The informational rec tells the pilot to run a Filter Tune before revisiting D |
| **D-term effectiveness (low, decrease)** | D decrease rec + effectiveness < 0.3 | Advisory note appended | D may not be doing much dampening — filter issue? |
| **Prop wash (severe + D rec)** | Severe prop wash (≥ 5×) on axis with existing D ↑ | Upgrade confidence → High | Prop wash confirms D increase will help |
| **Prop wash (severe, no D rec)** | Severe prop wash (≥ 5×) on worst axis, no D rec | D ↑ +5 on worst axis | Medium | Prop wash oscillation during descents needs more dampening |
| **FF energy ratio** | P decrease rec + meanFFEnergyRatio > 0.6 | Downgrade confidence → Low | Overshoot is feedforward-dominated, not P-caused |
| **PW-DMIN-GAIN** | Propwash severe + d_min active + gain < 35 | Increase d_min_gain to size-appropriate value (30-35 freestyle) | Medium | Higher gain ramps D faster during propwash events |
| **PW-DMIN-GAP** | d_min active + (d_max - d_min)/d_max < 20% | Lower d_min to d_max × 0.7 | Low | Wider gap gives D more room to ramp during propwash |
| **PW-DMIN-ENABLE** | Propwash severe + d_min disabled | Enable d_min at d_max × 0.7 | Low | d_min reduces noise at rest while allowing high D during propwash |
| **PW-IRELAX-CUTOFF** | Propwash severe (≥ 5×) + iterm_relax_cutoff > 7 | Lower cutoff by 5 (floor 7) | Medium | Progressive reduction per community guidance "15 → 10 → 7" for severe propwash |
| **PW-IRELAX-CUTOFF-MOD** | Propwash moderate (2–5×) + iterm_relax_cutoff > 15 | Lower cutoff by 5 (floor 15) | Low | Mild I-term suppression for moderate propwash without sacrificing tracking |
| **PW-IRELAX-ENABLE** | Propwash detected + iterm_relax OFF | Enable iterm_relax | Medium | I-term windup worsens propwash bounce-back |
| **PW-TPA-MODE** | Propwash severe + TPA mode = PD | Switch to D-only mode | Medium | PD mode reduces P during climb, losing authority |
| **PW-TPA-BREAKPOINT** | Propwash severe + breakpoint < 1300 | Raise to 1350 | Medium | Low breakpoint attenuates D too early during climb |
| **PW-TPA-RATE** | Propwash severe + rate > 65 | Lower to 65 | Medium | Excessive TPA rate reduces effective D during propwash recovery |

**Transfer Function Rules (Wiener deconvolution — primary source for Flash Tune, supplementary for PID Tune when TF data available):**

Transfer function rules complement step-response rules. Both run in the same `recommendPID()` call and share identical post-processing (D-term effectiveness gating, prop wash, data quality adjustment). Based on [Plasmatree PID-Analyzer](https://github.com/Plasmatree/PID-Analyzer) by Florian Melsheimer (2018).

| Rule | Condition | Action | Step Size | Base Confidence |
|------|-----------|--------|-----------|-----------------|
| **TF-1** | Phase margin < 45° (critical: < 30°) | D ↑ | +5 / +10 | Medium |
| **TF-2** | Synthetic overshoot > threshold | Same as Rule 1a | varies | Medium |
| **TF-3** | Bandwidth < threshold (smooth: 30, balanced: 40, aggressive: 60 Hz; yaw: × 0.7), no overshoot | P ↑ | +5 | Medium |
| **TF-4** | DC gain < style-aware threshold `20·log10(1 − SSE_max/100)` dB (smooth ≈ −0.7, balanced ≈ −0.4, aggressive ≈ −0.3) | I ↑ | +5 (+10 at 2× threshold) | Low / Medium |

**Coherence gate:** All TF rules (TF-1..TF-4) are skipped per axis when the axis's stick-band coherence mean (1–30 Hz) is below 0.5 — the transfer function estimate is not trustworthy enough to drive gain changes (the data quality scorer flags the axis with a low-coherence warning instead).

Base confidence is adjusted by the same post-processing as step-response rules. There is no blanket confidence cap for Flash Tune — gating logic is identical to PID Tune.

**Safety Bounds (quad-size-aware):**

Default bounds (5") shown. When drone size is known from the profile, per-size bounds apply — see `QUAD_SIZE_BOUNDS` in `constants.ts`.

| Parameter | Min | Max (1") | Max (2.5") | Max (3-4") | Max (5") | Max (6-7") |
|-----------|-----|---------|-----------|-----------|---------|------------|
| P gain | 30 (1") / 25 (2.5") / 20 (3"+) | 90 | 90 | 100-110 | 120 | 120 |
| D gain | 15 | 80 | 55 | 60-70 | 80 | 90-100 |
| I gain | 40 | 100 | 110 | 110-120 | 120 | 120 |

1" (whoop) bounds reflect real preset clusters (whoop_justice, whoop_ayyykayyy, UAV Tech Whoop: P 63-83, D 57-79 on roll/pitch) — micro quads legitimately run high P *and* high D.

**Key design decisions:**

- **Unified pipeline** — Both modes share the same post-processing (D-term effectiveness gating, prop wash, damping ratio, data quality, safety bounds). Only the metric extraction differs.
- **D-first strategy** — D increase is always the first action for overshoot. P is only reduced when overshoot is extreme (>2× threshold) or D is near its ceiling (≥60% of max).
- **Proportional step sizing** — ±5 for mild issues, ±10 for significant (2–4× threshold), ±15 for extreme (>4×). All changes clamped to safe bounds.
- **Flight-PID anchoring** — Targets are relative to PIDs from the Blackbox header (not current FC values), preventing drift when PIDs change between flights.
- **Feedforward awareness** — Detects FF-dominated overshoot via `|pidF|` vs `|pidP|` comparison at overshoot peak. Skips P/D changes and recommends `feedforward_boost` reduction instead. FF energy ratio gates P-decrease confidence.
- **Flight style adaptation** — Smooth pilots get tighter overshoot tolerances; Aggressive pilots tolerate more overshoot for sharper response.
- **Damping ratio validation** — Post-processing ensures D/P stays within 0.45–0.85 (upper bound 1.0 for 1"/2.5" micros — whoop presets legitimately run D/P ≈ 0.9–0.95).
- **D-term effectiveness gating** — Three tiers: >0.7 (boost confidence), 0.3–0.7 (allow with advisory), <0.3 (redirect to filter tuning). Prevents blindly increasing D when the problem is noise.
- **Prop wash integration** — Severe prop wash (≥5× the clean-segment baseline, 20–90 Hz; baseline = band energy of contiguous runs outside drop windows) boosts D-increase confidence or generates D +5 on worst axis. Minimum 3 events required.

### Methodology Sources

The autotuning rules and thresholds are based on established FPV community practices:

| Source | Used For |
|--------|----------|
| [Betaflight PID Tuning Guide](https://www.betaflight.com/docs/wiki/guides/current/PID-Tuning-Guide) | P/I/D role definitions, overshoot→D rule, bounce-back diagnostics |
| [FPVSIM Step Response Guide](https://fpvsim.com/how-tos/step-response-pd-balance) | P/D balance via step response graphs, ±5 step size, baseline values |
| [Plasmatree PID-Analyzer](https://github.com/Plasmatree/PID-Analyzer) | Wiener deconvolution reference implementation, transfer function approach |
| [Oscar Liang: PID Filter Tuning](https://oscarliang.com/pid-filter-tuning-blackbox/) | Blackbox-based tuning workflow, PIDToolBox methodology |
| [PIDtoolbox](https://pidtoolbox.com/home) | Overshoot 10–15% as ideal range for multirotors, spectral analysis |
| [UAV Tech Tuning Principles](https://theuavtech.com/tuning/) | D-gain as damper, P-gain authority, safety-first approach |
| [FPVtune](https://dev.to/fpvtune/i-built-an-auto-pid-tuning-tool-for-betaflight-heres-how-it-works-under-the-hood-okg) | Prop wash detection, D-term effectiveness ratio concepts |
| Standard control theory (rise time, settling, overshoot definitions) | Metric definitions consistent with MATLAB `stepinfo` |

## Known Limitations

- MSP v1 only (v2 support planned)
- Requires test flights in a safe environment
- Huffman-compressed Blackbox data cannot be decoded (compression is detected and clearly flagged in UI with a badge; analysis is disabled for compressed logs)
- Feedforward parameter write via MSP not yet supported (FF detection, FF-aware PID recommendations, and CLI apply all work; only direct MSP write of `feedforward_smooth_factor`/`feedforward_jitter_factor` is missing)
- Bayesian PID optimizer: framework complete (GP surrogate, Expected Improvement), full auto-apply pipeline integration pending (currently returns suggestions alongside rule-based recommendations)

## Development Roadmap

- **Phase 1**: ✅ MSP connection, profiles, snapshots
- **Phase 2**: ✅ Blackbox analysis, automated tuning, rollback
- **Phase 2.5**: ✅ UX polish — profile simplification, interactive analysis charts
- **Phase 3**: ✅ Mode-aware wizard, read-only analysis overview, flight guides
- **Phase 4**: ✅ Stateful tuning workflow (Filter Tune, PID Tune, Flash Tune) with smart reconnect, verification, tuning history
- **Phase 5**: ⬜ Complete manual testing & UX polish (real hardware validation)
- **Phase 6**: ✅ CI/CD & cross-platform releases (macOS/Windows/Linux installers)
- **Phase 7a**: ✅ Playwright E2E tests (demo mode, 37 tests across 7 spec files)
- **Phase 7b**: ⬜ E2E tests on real FC in CI pipeline

See [SPEC.md](./SPEC.md) for detailed requirements and phase tracking.

## Acknowledgments

- **[Plasmatree PID-Analyzer](https://github.com/Plasmatree/PID-Analyzer)** by Florian Melsheimer — pioneered Wiener deconvolution for FPV PID tuning (2018). FPVPIDlab's Flash Tune reimplements this technique with automatic PID recommendations.
- **[PIDtoolbox](https://github.com/bw1129/PIDtoolbox)** by bw1129 — spectral analysis methodology and overshoot ideal ranges draw on PIDtoolbox's work.
- **[Betaflight](https://betaflight.com/)** — the open-source flight controller firmware. FPVPIDlab communicates via MSP and validates against BF Explorer's binary log parser.

## Contributing

Contributions welcome! Please open an issue first to discuss changes.

## License

GPL-3.0-only — see [LICENSE](./LICENSE) for details.
