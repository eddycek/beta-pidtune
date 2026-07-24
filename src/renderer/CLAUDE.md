# Renderer Process

React application with hooks-based state management. No direct IPC access — uses `window.betaflight` API only.

## Key Hooks

- **useFCState** — Centralized FC state from cache (info, PID/filter/FF config, BB info, BB settings). Push-updated via `EVENT_FC_STATE_CHANGED`
- **useConnection** — FC connection state, port scanning
- **useProfiles** — Profile CRUD, current profile
- **useTuningSession** — Active session state, phase transitions
- **useBlackboxInfo / useBlackboxLogs** — Blackbox storage and log data
- **useLicense** — Licensing/Pro features
- **useToast** — Toast notifications

## Analysis Overview (`components/AnalysisOverview/`)

Read-only single-page analysis view. Opened when user clicks "Analyze" on a downloaded log **without an active tuning session**.

- **useAnalysisOverview hook**: Auto-parses on mount, auto-runs both filter and PID analyses in parallel for single-session logs, session picker for multi-session logs
- Single scrollable page with filter section (noise spectrum, axis summary, observations) and PID section (step metrics, current PIDs, step response chart, observations)
- No wizard steps, no Apply button, no flight guide — purely informational
- Reuses SpectrumChart, StepResponseChart, RecommendationCard from TuningWizard
- Recommendations labeled as "Observations" (read-only context)

## Tuning Wizard (`components/TuningWizard/`)

Multi-step wizard for active tuning sessions (Filter Tune, PID Tune, and Flash Tune).

**Steps by mode**:
- `filter`: Flight Guide → Session → Filters → Summary (skips PIDs)
- `pid`: Flight Guide → Session → PIDs → Summary (skips Filters)
- `flash`: Session → Flash Tune Analysis (filter + TF in parallel, auto-runs) → Summary

Key components:
- **useTuningWizard hook**: State management for parse/filter/PID analysis and apply lifecycle
- **WizardProgress**: Visual step indicator, dynamic step filtering by mode
- **Step components**: TestFlightGuideStep (renders FlightGuideContent), SessionSelectStep, FilterAnalysisStep, PIDAnalysisStep, QuickAnalysisStep (Flash Tune), TuningSummaryStep
- **ApplyConfirmationModal**: Confirmation dialog (snapshot option, reboot warning)
- **RecommendationCard**: Shared component used across analysis steps (FilterAnalysisStep, PIDAnalysisStep, QuickAnalysisStep)
- Flight guide data in `src/shared/constants/flightGuide.ts`

## Analysis Charts (`components/TuningWizard/charts/`)

Interactive visualization using Recharts (SVG).

- **SpectrumChart**: FFT noise spectrum with per-axis color coding, noise floor reference lines, peak frequency markers. Optional `filterSettings` prop overlays the configured gyro/D-term filter-chain response (right axis, attenuation dB; models from `@shared/utils/filterResponse`) and shades the dynamic notch range
- **StepResponseChart**: Setpoint vs gyro trace for individual steps, Prev/Next navigation, metrics overlay
- **TFStepResponseChart**: Synthetic step response from Transfer Function (Wiener deconvolution). Single/comparison modes
- **BodePlot**: Frequency response visualization (magnitude + phase + coherence γ² when present, with the 0.5 recommendation-gate line). Used in AnalysisOverview and analysis steps
- **RecommendationCard** renders the structured `evidence` block (P3.1) — collapsible "Why? Measured evidence" list of measurements + trigger; SpectrumChart tags peaks with the ruleId whose `evidence.anchorFrequencyHz` matches (±8 Hz) via its optional `recommendations` prop
- **ThrottleSpectrogramChart**: Custom SVG heatmap — noise magnitude (dB) across frequency × throttle bands. Accepts both live `data` and `compactData` props. Optional `filterSettings` prop overlays the gyro LPF1 cutoff line (dynamic LPF traces its throttle curve across bands)
- **AxisTabs**: Shared tab selector (Roll/Pitch/Yaw/All). Supports `showAll` prop for spectrogram views
- **chartUtils**: Data conversion (Float64Array → Recharts format), downsampling, findBestStep scoring
- **StepResponseTrace**: Raw trace data extracted in `StepMetrics.computeStepResponse()`

## Tuning History & Comparison (`components/TuningHistory/`)

Completed tuning sessions archived with self-contained metrics for comparison.

- **TuningCompletionSummary**: Shown when `session.phase === 'completed'`. Mode-aware verification charts. Dismiss/Start New buttons
- **SpectrogramComparisonChart**: Side-by-side ThrottleSpectrogramChart with dB delta pill (Filter Tune)
- **StepResponseComparison**: Per-axis PID metrics before/after grid (PID Tune)
- **NoiseComparisonChart**: Before/after spectrum overlay with delta pill
- **AppliedChangesTable**: Reusable table of setting changes with old → new values and % change
- **TuningHistoryPanel**: Dashboard section below SnapshotManager. Expandable cards per completed session
- **QualityTrendChart**: Line chart showing flight quality score progression (minimum 2 data points)
- **TuningSessionDetail**: Expanded view with mode-aware verification charts
- **VerificationQualityWarning**: Modal shown when verification flight data quality is fair/poor. Displays tier, score, failing sub-scores, "Fly Again" / "Accept Anyway" buttons
- **useTuningHistory hook**: Loads history for current profile, reloads on profile change and session dismissal

## Dashboard Layout

- ConnectionPanel and ProfileSelector side by side in `.top-row` when connected
- When disconnected, ConnectionPanel takes full width
- Post-erase UX: `erasedForPhase` (React state) tracks erase per-phase, banner shows flight guide after erase
- SD card erase: `eraseCompleted` (persisted in TuningSession) survives MSC disconnect/reconnect
- SD card labels: `TuningStatusBanner` uses `storageType` prop — "Erase Logs" instead of "Erase Flash"

## Settings Modal (`TelemetrySettingsModal`)

- Tabbed UI: Telemetry | Logs
- Telemetry tab: toggle, data collection summary, upload status + errors
- Logs tab: scrollable box (last 50 lines, 64KB tail read), color-coded, Refresh + Export
