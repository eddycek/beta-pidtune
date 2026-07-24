# Testing Guidelines

> **Rule:** After adding or removing tests, update the test inventory in this file. Keep counts accurate.

## Overview

This project uses **Vitest** and **React Testing Library** for testing. All UI changes must include tests and pass before committing.

## Test Stack

- **Vitest** - Fast unit test framework (Vite-native)
- **React Testing Library** - React component testing utilities
- **@testing-library/jest-dom** - Custom matchers for DOM assertions
- **@testing-library/user-event** - User interaction simulation
- **jsdom** - DOM implementation for Node.js
- **Playwright** - Electron E2E testing (demo mode)

## Running Tests

```bash
# Watch mode (development)
npm test

# Single run (CI / pre-commit)
npm run test:run

# Interactive UI
npm run test:ui

# Coverage report
npm run test:coverage

# E2E tests (requires build first)
npm run test:e2e

# E2E with Playwright UI
npm run test:e2e:ui

# Generate tuning sessions for demo history (slow, ~2 min for 5 sessions)
npm run demo:generate-history              # 5 mixed (filter + pid + flash)
npm run demo:generate-history:filter       # 5 filter-only
npm run demo:generate-history:pid          # 5 pid-only
npm run demo:generate-history:flash        # 5 flash-only
GENERATE_COUNT=15 npm run demo:generate-history  # custom count
```

## Pre-commit Hook

Tests run automatically before each commit via **husky** and **lint-staged**:
- Only tests related to changed files are executed
- Commit is blocked if tests fail

## Writing Tests

### File Location & Naming

Place test files next to the source file:
```
src/renderer/components/
  ConnectionPanel/
    ConnectionPanel.tsx          ← Component
    ConnectionPanel.test.tsx     ← Tests
    ConnectionPanel.css
```

- `.test.tsx` for component tests
- `.test.ts` for utility/hook/backend tests

### Basic Structure

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { YourComponent } from './YourComponent';

describe('YourComponent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.betaflight.someMethod).mockResolvedValue(mockData);
  });

  it('renders correctly', () => {
    render(<YourComponent />);
    expect(screen.getByText('Expected Text')).toBeInTheDocument();
  });

  it('handles user interaction', async () => {
    const user = userEvent.setup();
    render(<YourComponent />);

    await user.click(screen.getByRole('button', { name: /click me/i }));

    await waitFor(() => {
      expect(screen.getByText('Result')).toBeInTheDocument();
    });
  });
});
```

### Common Patterns

**Querying elements:**
```typescript
screen.getByRole('button', { name: /connect/i })  // preferred
screen.getByLabelText(/serial port/i)
screen.getByText(/connection/i)
```

**Async operations:**
```typescript
await waitFor(() => {
  expect(screen.getByText('Loaded')).toBeInTheDocument();
});
```

**Mocking API calls:**
```typescript
beforeEach(() => {
  vi.mocked(window.betaflight.connect).mockResolvedValue(undefined);
  vi.mocked(window.betaflight.listPorts).mockResolvedValue(mockPorts);
});
```

**Error states:**
```typescript
vi.mocked(window.betaflight.connect).mockRejectedValue(new Error('Connection failed'));
```

## Best Practices

**DO:**
- Test user behavior, not implementation details
- Use accessible queries (`getByRole`, `getByLabelText`)
- Use `waitFor()` for async state updates
- Clean up mocks with `vi.clearAllMocks()` in `beforeEach`
- Test edge cases: empty states, errors, loading, disabled

**DON'T:**
- Test implementation details (internal state, private methods)
- Use `setTimeout()` / `wait()` — use `waitFor()` instead
- Test library code — test YOUR code
- Skip cleanup — always reset mocks in `beforeEach`

## Debugging

```typescript
screen.debug();           // Print current DOM
it.only('...', () => {}); // Run only this test
it.skip('...', () => {}); // Skip this test
```

```bash
npm run test:ui           # Visual interface with DOM snapshots
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "not wrapped in act(...)" | Use `waitFor()` for async state updates |
| Test fails only in CI | Check for race conditions, use `waitFor` |
| Flaky test | Add `waitFor()`, increase timeout if needed |
| Mock not working | Ensure `vi.clearAllMocks()` in `beforeEach`, mock before `render()` |

---

## Test Inventory

**Total: 3278 unit tests across 149 files (3255 passing + 23 skipped fixture-gated) + 37 Playwright E2E tests across 7 spec files** (last verified: July 24, 2026)

Per-file counts below include skipped tests (as reported by `vitest run`). The 23 skipped tests live in `blackbox/realflight.regression.test.ts` (13) and `analysis/AnalysisPipeline.realdata.test.ts` (10) — they require optional local BBL fixtures.

### UI Components

| File | Tests | Description |
|------|-------|-------------|
| `ConnectionPanel/ConnectionPanel.test.tsx` | 13 | Connection flow, port scanning, cooldown, auto-cooldown on unexpected disconnect |
| `FCInfo/FCInfoDisplay.test.tsx` | 39 | FC information display, CLI export, diagnostics, version-aware debug mode, feedforward config, fix/reset settings |
| `FCInfo/FixSettingsConfirmModal.test.tsx` | 4 | Fix settings confirmation modal, reboot warning, confirm/cancel |
| `BlackboxStatus/BlackboxStatus.test.tsx` | 34 | Blackbox status, download trigger, readonly mode, onAnalyze, SD card storage type, erase labels, log numbering, pagination, Huffman compression badge, disabled analyze for compressed logs |
| `ProfileSelector.test.tsx` | 11 | Profile switching, locking when FC connected |
| `ProfileEditModal.test.tsx` | 18 | Profile editing, validation, form handling, flight style selector |
| `ProfileDeleteModal.test.tsx` | 12 | Deletion confirmation, warnings |
| `SnapshotManager/SnapshotManager.test.tsx` | 49 | Snapshot CRUD, export, restore, baseline handling, dynamic numbering, pagination, tuning metadata labels, role badges, smart compare, restore warnings display and dismiss |
| `SnapshotManager/SnapshotDiffModal.test.tsx` | 13 | Snapshot diff view, change display |
| `SnapshotManager/snapshotDiffUtils.test.ts` | 29 | CLI diff parsing, change computation, corrupted config line detection |
| `Toast/Toast.test.tsx` | 14 | Toast notification rendering and lifecycle |
| `Toast/ToastContainer.test.tsx` | 6 | Toast container layout and stacking |
| `StartTuningModal.test.tsx` | 19 | Start tuning modal, 3-mode selection (Filter Tune/PID Tune/Flash Tune), "Start here" badge, cancel, BF PID profile selector (display, selection, labels, persistence) |
| `TuningStatusBanner/TuningStatusBanner.test.tsx` | 80 | Workflow banner, unified 4-step indicator, actions, downloading, applied phases, BB settings pre-flight warning, filter/PID verification flow, flashUsedSize-based erased state, import file, skip erase, SD card labels + eraseCompleted, Flash Tune phases, post-apply verification mismatch warning |
| `TuningWizard/TuningWizard.test.tsx` | 46 | Multi-step wizard flow, results display, apply, mode-aware routing, onApplyComplete with metrics, FF warning, RPM status, flight style display |
| `TuningWizard/FlightGuideContent.test.tsx` | 11 | Flight guide content rendering, version-aware tip filtering |
| `TuningWizard/TestFlightGuideStep.test.tsx` | 5 | Flight guide step integration |
| `TuningWizard/PhaseIllustration.test.tsx` | 11 | Phase illustration SVG rendering, custom size, aria-hidden, unknown title fallback |
| `TuningWorkflowModal/TuningWorkflowModal.test.tsx` | 23 | Workflow preparation modal, 3-tab layout (Filter/PID/Flash), mode-aware step filtering, flight guide sections |
| `AnalysisOverview/AnalysisOverview.test.tsx` | 39 | Diagnostic-only analysis view, auto-parse, session picker, breadcrumb navigation, session metadata, FF warning, RPM status, data quality pill, TF analysis, wind disturbance pill, mechanical health warnings |
| `TuningWizard/PIDAnalysisStep.test.tsx` | 10 | PID results display, flight style pill, step count pluralization, data quality pill |
| `TuningWizard/RecommendationCard.test.tsx` | 11 | Setting label lookup, value display, change percentage, confidence, feedforward labels |
| `TuningWizard/ApplyConfirmationModal.test.tsx` | 8 | Change counts, confirm/cancel, reboot warning |
| `TuningWizard/QuickAnalysisStep.test.tsx` | 6 | Quick analysis dual-panel (filter + TF), auto-run, progress, retry |
| `TuningWizard/WizardProgress.test.tsx` | 10 | Step indicator, mode-aware filtering (filter/pid/quick), current/done/upcoming states |
| `TuningWizard/SessionSelectStep.test.tsx` | 8 | Session picker, auto-parse, parsing/error/empty states, reverse order |
| `TuningWizard/TuningSummaryStep.test.tsx` | 17 | Recommendations table, mode-aware labels (filter/pid/quick), apply/progress/success/error states, tfResult for quick mode |
| `TuningWizard/charts/AxisTabs.test.tsx` | 6 | Tab rendering, selection, aria-selected, onChange callback |
| `TuningWizard/charts/ThrottleSpectrogramChart.test.tsx` | 10 | Throttle spectrogram heatmap rendering, axis labels, color scale, empty state, compact data (archived) rendering |
| `TuningHistory/AppliedChangesTable.test.tsx` | 7 | Setting changes table, percent formatting, empty state, zero value handling |
| `TuningHistory/NoiseComparisonChart.test.tsx` | 9 | Before/after spectrum overlay, delta pill, axis tabs, empty state |
| `TuningHistory/TuningCompletionSummary.test.tsx` | 27 | Completion summary with/without verification, noise chart, spectrogram comparison (Filter Tune), step response comparison (PID Tune), changes, PID metrics, actions, quality score badge with tier label, re-analyze button, mode-aware titles, smart suggestion buttons, convergence banner, iteration warning, previous session reference display |
| `TuningHistory/TuningHistoryPanel.test.tsx` | 18 | History list, expand/collapse, detail view with duration/flights, empty/loading states, quality score badge with tier label, trend chart, re-analyze verification, mode-aware labels |
| `TuningHistory/VerificationSessionModal.test.tsx` | 7 | Auto-analyze single session, multi-session picker, reverse order, cancel, error/parsing states |
| `TuningHistory/VerificationQualityWarning.test.tsx` | 6 | Quality warning modal for fair/poor verification data, tier display, failing sub-scores, accept/reject callbacks, dialog role |
| `TuningHistory/QualityTrendChart.test.tsx` | 7 | Trend chart rendering, minimum data threshold, null score handling, per-type colored lines, legend |
| `TuningHistory/SpectrogramComparisonChart.test.tsx` | 5 | Side-by-side spectrogram comparison, before/after labels, empty states, compact data rendering |
| `TuningHistory/StepResponseComparison.test.tsx` | 6 | Before/after step response metrics, per-axis comparison, delta indicators, empty states |
| `ProfileWizard.test.tsx` | 9 | Profile creation wizard, flight style selector, preset mapping |
| `ProfileCard.test.tsx` | 18 | Profile card rendering, badges (Active/Recent), relative time, click handlers, locked state, CSS classes |
| `ProfileWipeModal.test.tsx` | 8 | Profile wipe confirmation modal, deleted/kept lists, confirm/cancel, loading state, disabled buttons while wiping |
| `PresetSelector.test.tsx` | 11 | Preset dropdown rendering, selection callback, flight style mapping |
| `ErrorBoundary.test.tsx` | 6 | Error catch, fallback UI, try again reset, custom fallback, normal render |
| `App.test.tsx` | 10 | App render, title, version, BF compat badge, help button, ErrorBoundary integration, start tuning modal |
| `TelemetrySettings/TelemetrySettingsModal.test.tsx` | 7 | Telemetry settings modal, toggle switch, send now, installation ID display, close/overlay dismiss |
| `LicenseSettings/LicenseSettingsModal.test.tsx` | 9 | License settings modal, activate, error, dismiss, comparison table |
| `UpdateNotification/UpdateNotification.test.tsx` | 10 | Update notification render, events, changelog, install |
| `DiagnosticReport/ReportIssueModal.test.tsx` | 13 | Report issue modal form fields, submit with email/note, empty submit, sending state, cancel, privacy note, flight data checkbox (show/hide, default checked, submit with includeFlightData, BBL in privacy note) |
| `DiagnosticReport/ReportIssueButton.test.tsx` | 12 | Report issue button Pro gate, Free user hidden, modal open, submit success, submit failure, button variant |
| `LogPickerModal.test.tsx` | 7 | Log picker modal rendering, selection, cancel |

### Charts

| File | Tests | Description |
|------|-------|-------------|
| `TuningWizard/charts/chartUtils.test.ts` | 20 | Data conversion, downsampling, findBestStep, robust Y domain |
| `TuningWizard/charts/SpectrumChart.test.tsx` | 5 | FFT spectrum chart rendering |
| `TuningWizard/charts/StepResponseChart.test.tsx` | 10 | Step response chart rendering, navigation |
| `TuningWizard/charts/BodePlot.test.tsx` | 4 | Bode plot (magnitude + phase) rendering for transfer function |
| `TuningWizard/charts/TFStepResponseChart.test.tsx` | 6 | TF synthetic step response chart, single/comparison modes, overshoot metrics, delta pill |

### Contexts

| File | Tests | Description |
|------|-------|-------------|
| `contexts/ToastContext.test.tsx` | 10 | Toast context provider, add/remove/auto-dismiss |

### Hooks

| File | Tests | Description |
|------|-------|-------------|
| `hooks/useConnection.test.ts` | 20 | Connection state, port management, error handling, toast notifications (connect/disconnect/error, intentional vs unexpected, dedup) |
| `hooks/useProfiles.test.ts` | 15 | Profile CRUD, event subscriptions |
| `hooks/useSnapshots.test.ts` | 19 | Snapshot management, restore, event-driven updates |
| `hooks/useTuningWizard.test.ts` | 24 | Wizard state, parse/analyze/apply lifecycle, PID/FF split, quick mode TF analysis |
| `hooks/useTuningSession.test.ts` | 10 | Tuning session lifecycle, IPC events, reload on profile change |
| `hooks/useTuningHistory.test.ts` | 5 | History loading, profile/session change reload, error handling |
| `hooks/useAnalysisOverview.test.ts` | 12 | Auto-parse, dual analysis, session picker |
| `hooks/useFCInfo.test.ts` | 8 | FC info fetch, CLI export, loading/error states |
| `hooks/useToast.test.tsx` | 5 | Toast helper methods, context requirement |
| `hooks/useBlackboxInfo.test.ts` | 9 | Auto-load, refresh, concurrent request prevention |
| `hooks/useBlackboxLogs.test.ts` | 9 | Log list, profile change subscription, delete, openFolder |
| `hooks/useTelemetrySettings.test.ts` | 4 | Telemetry settings hook, toggle enabled, send now, load failure handling |
| `hooks/useLicense.test.ts` | 7 | License load, activate, remove, events |
| `hooks/useAutoUpdate.test.ts` | 8 | Update state, events, install, cleanup |
| `hooks/useFCState.test.ts` | 6 | FC state cache hook, mount hydration, push updates, cleanup |
| `hooks/useDemoMode.test.ts` | 3 | Demo mode detection, reset demo |
| `utils/bbSettingsUtils.test.ts` | 18 | BB settings status computation, version-aware debug mode, fix/reset commands |
| `utils/spectrogramUtils.test.ts` | 15 | Spectrogram data transformation, color mapping, frequency/throttle axis utilities, compact data heatmap preparation |

### IPC Handlers

| File | Tests | Description |
|------|-------|-------------|
| `ipc/handlers.test.ts` | 125 | All 51 IPC handler channels: connection, FC info, profiles, snapshots, blackbox, PID config, analysis (filter+PID+TF), tuning apply (PID+filter+FF+bounds validation), firmware-exact bounds gate (cross-size PID envelope incl. D=100, d_min_gain/tpa_rate/dyn_notch/FF gates), informational-rec apply guard (advisory recs never auto-applied), snapshot restore, tuning session, BB settings fix, BF PID profile selection, reuse verification log on repeat tuning, handler registration |
| `ipc/handlers/telemetryHandlers.test.ts` | 4 | Telemetry IPC handlers: get settings, set enabled, send now, error when manager null |
| `ipc/handlers/diagnosticHandlers.test.ts` | 14 | Diagnostic IPC handler: send report, bundle build, gzip upload, Pro license gate, error handling, BBL upload (fire-and-forget, skip when disabled, file not found, upload failure, verification log selection, telemetry event) |
| `ipc/handlers/types.test.ts` | 9 | IPC handler utility types, createResponse, parseDiffSetting |

### MSP Protocol & Client

| File | Tests | Description |
|------|-------|-------------|
| `msp/MSPProtocol.test.ts` | 40 | MSPv1 encode/decode, jumbo frames, round-trip, parseBuffer, checksum validation, garbage recovery |
| `msp/MSPConnection.test.ts` | 51 | Connection lifecycle, sendCommand, sendCommandNoResponse, timeouts, error/partial responses, CLI mode (prompt debounce, chunk-boundary, trailing CR), event forwarding, port error fast-fail, CLI buffer limit |
| `msp/MSPClient.test.ts` | 86 | FC info queries, PID/filter/FF config, board info, UID, blackbox info (flash+SD card), SD card summary, MSC reboot (fire-and-forget), set PID, CLI diff, save & reboot, connect/disconnect, version gate, listPorts, chunk ceiling, erase disconnect detection, BF PID profile selection (getStatusEx, selectPIDProfile), exportCLIDiff auto-reconnect, extended MSP_PID_ADVANCED parsing (feedforward_averaging, dyn_idle_min_rpm base layout + vbat_sag/thrust_linear/anti_gravity/TPA from 61-byte API 1.45+ layout) |
| `msp/cliUtils.test.ts` | 19 | CLI command response validation, error pattern detection (incl. Allowed range), setting extraction |

### MSC (Mass Storage Class)

| File | Tests | Description |
|------|-------|-------------|
| `msc/driveDetector.test.ts` | 29 | Cross-platform volume snapshot (macOS/Windows/Linux), BF log file matching (root + subdirs), new drive detection with polling, drive eject |
| `msc/MSCManager.test.ts` | 16 | Download/erase lifecycle, MSC rejection, mount timeout, cancel, multi-file copy, eject error handling, copy timeout, file size validation |

### Storage

| File | Tests | Description |
|------|-------|-------------|
| `storage/FileStorage.test.ts` | 13 | Snapshot JSON save/load/delete/list/export, ensureDirectory, snapshotExists |
| `storage/ProfileStorage.test.ts` | 13 | Profile persistence, loadProfiles, findBySerial, export, ensureDirectory idempotent |
| `storage/ProfileManager.test.ts` | 4 | clearSnapshotRefs behavior: clears snapshotIds + baselineSnapshotId, updatedAt bump, missing profile, no snapshots |
| `storage/SnapshotManager.test.ts` | 8 | Baseline force-delete protection (snapshot + profile baseline), baselineId clearing, profile unlink after force delete, cliDiff+cliDump snapshot creation |
| `storage/BlackboxManager.test.ts` | 17 | Log save/list/get/delete/export, profile filtering, soft delete, initialization |
| `storage/TuningSessionManager.test.ts` | 35 | Session CRUD, phase transitions, transition validation (invalid/backward/cross-mode rejected), zero-change `*_analysis → completed` shortcut (all 3 tuning types), per-profile persistence, Flash Tune phases |
| `storage/TuningHistoryManager.test.ts` | 33 | History archive, retrieval ordering, corrupted data handling, per-profile isolation, delete, updateLatestVerification, updateRecordVerification, tuningType field, getLatestByType filtering |

### Telemetry

| File | Tests | Description |
|------|-------|-------------|
| `telemetry/TelemetryManager.test.ts` | 20 | Telemetry manager initialization, settings persistence, bundle assembly (v1 + v2 + v3), upload via net.fetch, demo mode skip, error handling, TelemetryBundleV3 with per-session records and structured events, event collector integration |
| `telemetry/TelemetryEventCollector.test.ts` | 18 | Event collector emit, ring buffer, meta truncation, session ID, load/persist, clear, graceful error handling |

### License

| File | Tests | Description |
|------|-------|-------------|
| `license/LicenseManager.test.ts` | 12 | Offline validation, status, activate, remove, demo/dev mode |

### Diagnostic

| File | Tests | Description |
|------|-------|-------------|
| `diagnostic/DiagnosticBundleBuilder.test.ts` | 12 | Diagnostic bundle building: profile/snapshot/telemetry assembly, recommendation extraction, filter/PID/TF analysis summary, verification metrics, event log, empty/missing data handling |

### FC State Cache

| File | Tests | Description |
|------|-------|-------------|
| `cache/FCStateCache.test.ts` | 17 | Hydrate, invalidate, clear, CLI mode guard, flash-to-none guard, generation counter, event emission, blackbox settings from snapshot |

### Main Process Utils

| File | Tests | Description |
|------|-------|-------------|
| `utils/verifyAppliedConfig.test.ts` | 26 | Full-config apply verification: PID match/mismatch/retry, filter match/mismatch, flash combined, sanity checks (P/I/D=0, filter bypassed), expected/actual recording, mode-aware scope (PID-only, filter-only, both), feedforward read-back (full MSP-readable set incl. averaging/TPA/anti-gravity/thrust_linear/dyn_idle/vbat_sag, silent skip of fields absent from pre-1.45 short layouts, CLI-only skip shrunk to tpa_low_always/pidsum_limit*/rc_smoothing_auto_factor/simplified_dmax_gain/dterm_lpf1_dyn_expo, optional getFeedforwardConfiguration) |

### Auto-Updater

| File | Tests | Description |
|------|-------|-------------|
| `updater.test.ts` | 12 | Init, config, events, delay, error handling |

### Blackbox Parser

| File | Tests | Description |
|------|-------|-------------|
| `blackbox/BlackboxParser.test.ts` | 35 | End-to-end parsing, multi-session, corruption recovery |
| `blackbox/BlackboxParser.fuzz.test.ts` | 18 | Fuzz/property-based: random bytes, truncation, extreme values, oversized frames, all-zero, huge iterations |
| `blackbox/BlackboxParser.integration.test.ts` | 9 | Real flight BBL regression tests |
| `blackbox/realflight.regression.test.ts` | 13 | Additional real-flight regression tests |
| `blackbox/StreamReader.test.ts` | 35 | Binary stream reading, variable-byte encoding |
| `blackbox/HeaderParser.test.ts` | 25 | BBL header parsing, field definitions |
| `blackbox/ValueDecoder.test.ts` | 64 | 10 encoding types |
| `blackbox/PredictorApplier.test.ts` | 31 | 10 predictor types, C integer division |
| `blackbox/FrameParser.test.ts` | 15 | I/P/S frame decoding |

### FFT Analysis

| File | Tests | Description |
|------|-------|-------------|
| `analysis/FFTCompute.test.ts` | 24 | Hanning window, Welch's method, sine detection, calibrated v2 power-spectrum scale (detrending, power-domain averaging, known-amplitude sine reads 10·log10(A²/2)) |
| `analysis/SegmentSelector.test.ts` | 31 | Hover detection, throttle sweep detection, throttle normalization, yaw steadiness gating (1.5× threshold) |
| `analysis/NoiseAnalyzer.test.ts` | 43 | Peak detection (plateau handling, 15 Hz min spacing, parabolic sub-bin interpolation), size-aware frame-resonance classification, noise floor, throttle-track reclassification (reclassifyPeaksWithThrottle: tracking → motor_harmonic, stationary → frame_resonance/electrical, insufficient bands/prominence keeps heuristic, classifiedBy + throttleTrack stamps) |
| `analysis/FilterRecommender.test.ts` | 108 | Noise-based targets, convergence, safety bounds, RPM-aware bounds, dynamic notch, propwash floor, medium noise handling, notch-aware resonance (incl. disabled-notch dyn_notch_count=0 coverage), LPF2 recommendations (incl. D-term disable threshold boundary), conditional Q, motor harmonic diagnostic (F-MOTOR-DIAG), structured ruleId on all recommendations, iterm_relax, anti-gravity, thrust linear, RPM Q (3-4" midpoint 850), D-max, dyn idle, TPA, D-term expo, pidsum limit, FF rate limit, FF-dominated noise guard, yaw-only resonance observation (F-YAW-RES), informational recs bypass deduplication |
| `analysis/DataQualityScorer.test.ts` | 39 | Filter/PID data quality scoring, tier mapping, warnings, confidence adjustment, TF data quality, low coherence warning |
| `analysis/FilterAnalyzer.test.ts` | 20 | End-to-end pipeline, progress reporting, segment fallback warnings, RPM context propagation, data quality scoring, throttle spectrogram, group delay |
| `analysis/ThrottleSpectrogramAnalyzer.test.ts` | 23 | Throttle-dependent spectrogram analysis, frequency-throttle mapping, noise source tracking, contiguous-run gating (findContiguousRuns, min 512 samples, length-weighted power average) |
| `analysis/GroupDelayEstimator.test.ts` | 28 | Group delay estimation, filter phase response, latency measurement, analytic PT1/notch anchors (denominator-only notch formula), LPF2 modeled as PT1 (BF 4.3+ default) |
| `analysis/RpmFilterRecommender.test.ts` | 18 | RPM filter tuning rules: min_hz from dynamic-idle floor (gap/waste directions, deadzone, clamping), min_hz from measured fundamental track (lower-only), harmonic-count increase from integer-ratio tracks (tolerance, amplitude threshold, max cap), fade-range and weights advisories, cross-axis dedup |

### Step Response Analysis

| File | Tests | Description |
|------|-------|-------------|
| `analysis/StepDetector.test.ts` | 16 | Derivative-based step detection, hold/cooldown |
| `analysis/StepMetrics.test.ts` | 53 | Rise time, overshoot, settling, latency, ringing, FF contribution classification, trackingErrorRMS computation and aggregation, adaptive window, FF energy ratio |
| `analysis/StepResponseStacker.test.ts` | 10 | Deconvolved (stacked) step response: Wiener deconvolution windows, low/high input-magnitude split (500 deg/s), input-energy-weighted coherence trust gate (≥2 windows, ≥0.5), quiet-window skip (max \|setpoint\| < 50 deg/s), metric extraction on 2nd-order demo plant, curve downsampling |
| `analysis/PIDRecommender.test.ts` | 266 | Flight PID anchoring, TF coherence gate (TF rules skipped below coherenceMean 0.5), convergence, safety bounds, FF context, FF-aware recommendations, flight style thresholds, proportional severity scaling, TF-based recommendations, damping ratio (micro max 1.0 vs standard 0.85), I-term, D-term effectiveness gating (informational P-DTE-BLOCK replacement), prop wash integration, Rule TF-4 DC gain I-term (style-aware threshold), quad-size-aware bounds (1" dMax 80/pTypical 72), severity-scaled sluggish P, P-too-high warning, P-too-low warning, informational flag, relaxed yaw ringing threshold (×1.5), FF boost step 3, D-min/TPA advisory, structured ruleId on all recommendations, iterm_relax_cutoff (severity-aware floor, aggressive typical 30), anti-gravity (700 g gate), thrust linear, RPM notch Q, D-max boost, dyn idle, TPA breakpoint/rate (small breakpoint 1250), D-term expo, pidsum limit (informational), FF rate limit, RC link FF profiles, bounds clamping validation, style-aware d_min gain |
| `analysis/PIDAnalyzer.test.ts` | 28 | End-to-end pipeline, progress reporting, FF context wiring, flight style propagation, data quality scoring, cross-axis, propwash integration |
| `analysis/CrossAxisDetector.test.ts` | 20 | Cross-axis coupling detection, axis interaction analysis |
| `analysis/PropWashDetector.test.ts` | 20 | Propwash detection, wash-out frequency analysis, clean-segment baseline (computeCleanRuns, whole-flight fallback) |
| `analysis/DTermAnalyzer.test.ts` | 8 | D-term effectiveness, energy ratio computation, dCritical flag |
| `analysis/WindDisturbanceDetector.test.ts` | 11 | Wind/disturbance detection, gyro variance during hover, calm/moderate/windy classification, per-axis independence, hover-only analysis, multiple segments |
| `analysis/MechanicalHealthChecker.test.ts` | 21 | Mechanical health diagnostic, extreme noise detection, axis asymmetry, motor imbalance, combined issues, threshold edge cases, size-aware extreme-noise threshold (resolveExtremeNoiseThresholdDb: whoop 0 dB vs 5" -10 dB, undefined fallback) |
| `analysis/DynamicLowpassRecommender.test.ts` | 31 | Dynamic lowpass analysis, throttle-noise correlation, recommendation generation (gyro + D-term), threshold validation, structured ruleId, disable hysteresis (4 dB threshold, 4-6 dB gray zone leaves config untouched) |
| `analysis/SliderMapper.test.ts` | 16 | Slider-aligned PID mapping, master multiplier, PD ratio, buildRecommendedPIDs, slider delta computation |
| `analysis/FeedforwardAnalyzer.test.ts` | 65 | Extended FF analysis, leading-edge overshoot detection, small-step jitter analysis, RC link rate extraction, smooth/jitter factor recommendations, RC link profile lookup, baseline comparison, merge logic, FF-RC-SMOOTH advisory skipped for aggressive style, deriveMaxStickRate (max \|setpoint\|, floor 300, fallback 670) |
| `analysis/BayesianPIDOptimizer.test.ts` | 31 | Gaussian Process surrogate, Expected Improvement, Latin Hypercube Sampling, bounds |
| `analysis/TransferFunctionEstimator.test.ts` | 32 | Wiener deconvolution, frequency response estimation, Bode plot data, PID recommendations from transfer function, DC gain from 1-5 Hz band average (computeDcGainDb with bin-1/bin-0 fallbacks), magnitude-squared coherence γ²(f) + coherenceMean (1-30 Hz band, ≥2 Welch windows), gain/phase margin crossingFound flags |
| `analysis/ThrottleTFAnalyzer.test.ts` | 8 | Per-band TF analysis, throttle binning, variance computation, TPA warning, band boundaries |
| `analysis/VerificationMatcher.test.ts` | 33 | Flight similarity matching (mechanical peaks, throttle overlap, step count ratio), filter/PID/flash verification scoring, PID magnitude CoV sub-score, BBL fixture calibration with real flight data |
| `analysis/ConvergenceDetector.test.ts` | 18 | Convergence detection, diminishing returns, iteration tracking, previous session comparison, spectrum-scale-version guard (refuses cross-scale noise comparison), flash phase-margin sentinel guard (ignores 90° placeholder) |
| `analysis/AnalysisPipeline.realdata.bbl.test.ts` | 10 | Real BBL fixture integration tests with actual flight data |
| `analysis/AnalysisPipeline.realdata.test.ts` | 20 | End-to-end filter+PID analysis with bf45-reference fixture and real_flight.bbl, safety bounds, determinism, performance |
| `analysis/goldenOutputs.test.ts` | 7 | Golden-output regression harness: full FilterAnalyzer + PIDAnalyzer + TransferFunctionEstimator pipelines over demo-generator BBLs and real VX3.5 logs, snapshot-compared against `__fixtures__/golden/*.json` (recommendations, noise floors, peaks, step metrics; regenerate via `UPDATE_GOLDEN=1`) |
| `analysis/throttleUtils.test.ts` | 4 | Shared throttle normalization (normalizeThrottle) and contiguous-run finder (findContiguousRuns) |
| `analysis/OfflineTuning.pipeline.test.ts` | 44 | Offline tuning validation with 4 real VX3.5 BBL logs: pipeline smoke (filter+PID on all logs), factory settings regression, convergence (fixpoint ≤3 iterations, no oscillation), determinism, recommendation direction, cross-pipeline robustness, mechanical health (no false-positive critical), group delay sanity, header extraction invariants, cross-validation Filter+PID vs Flash Tune (noise floor consistency, rec target convergence, step response vs Wiener PID comparison, TF-exclusive metrics, data quality) |

### Header Validation

| File | Tests | Description |
|------|-------|-------------|
| `analysis/constants.test.ts` | 11 | PID style threshold validation, ordering constraints, balanced-matches-existing, iterm relax ranges, RC link profiles |

### Shared Constants & Types

| File | Tests | Description |
|------|-------|-------------|
| `shared/utils/metricsExtract.test.ts` | 40 | Spectrum downsampling, filter/PID/TF metrics extraction, boundary handling, trackingErrorRMS extraction, step response downsampling, throttleBands extraction, dcGain extraction, throttle spectrogram extraction, recommendation trace extraction |
| `shared/utils/verificationDelta.test.ts` | 10 | Verification delta computation, before/after metric comparison, improvement/regression detection, missing metrics handling |
| `shared/utils/tuneQualityScore.test.ts` | 41 | Quality score computation, tier boundaries, partial metrics, backward compat, clamping, TIER_LABELS, verification quality, transfer function metrics (bandwidth, phase margin, quality parity), v2 noise-floor anchors (best -50 / worst -10 dB), phase-margin skip for axes without measured crossover |
| `shared/constants.test.ts` | 7 | Preset profile flight style mapping validation |
| `shared/types/profile.types.test.ts` | 4 | FlightStyle type compilation, DroneProfileOptional inheritance |

### Header Validation & Constants

| File | Tests | Description |
|------|-------|-------------|
| `analysis/headerValidation.test.ts` | 45 | GYRO_SCALED check, logging rate validation (effective log rate = looptime × pInterval × pDenom), BF version-aware debug mode, BBL firmware version parsing (with "Betaflight" prefix), BBL header RPM enrichment, BBL-primary static cutoff/notch-range overrides, independent field enrichment, preset gap analysis header fields |

### E2E Workflow (Vitest)

| File | Tests | Description |
|------|-------|-------------|
| `e2e/tuningWorkflow.e2e.test.ts` | 31 | End-to-end tuning workflow via IPC handlers: profile + connection workflow, snapshot workflow, tuning session lifecycle |

### Demo Mode (Offline UX Testing)

| File | Tests | Description |
|------|-------|-------------|
| `demo/MockMSPClient.test.ts` | 53 | Mock FC connection, state management, FC info, PID/filter/FF config, blackbox, CLI, save/reboot, flags, flight type cycling, advancePastVerification, Flash Tune mode, BF PID profile selection (getStatusEx, selectPIDProfile) |
| `demo/DemoDataGenerator.test.ts` | 26 | BBL generation for filter/PID/quick analysis, multi-session, header metadata, step inputs, throttle sweeps, progressive noise reduction |

### Playwright E2E Tests (Demo Mode)

End-to-end tests that launch the real Electron app in demo mode and walk through the UI using Playwright. Requires a build before running (`npm run build:e2e`).

| File | Tests | Description |
|------|-------|-------------|
| `e2e/demo-smoke.spec.ts` | 4 | App launch, auto-connect, dashboard elements (blackbox, start tuning, reset demo) |
| `e2e/demo-tuning-cycle.spec.ts` | 7 | Full Filter Tune cycle: start → modal → erase → download → filter wizard → apply → erase & verify → download → analyze verification → complete → dismiss → check history |
| `e2e/demo-pid-tune-cycle.spec.ts` | 7 | Full PID Tune cycle: start → modal → erase → download → PID wizard → apply → erase & verify → download → analyze verification → complete → dismiss → check history |
| `e2e/demo-quick-tune-cycle.spec.ts` | 7 | Full Flash Tune cycle: start → modal (Flash) → erase → download → flash wizard (auto-analysis) → apply all → erase & verify → download → analyze verification → complete → dismiss → check history |
| `e2e/demo-generate-history.spec.ts` | 4 | Generates completed tuning sessions in 4 modes: mixed, filter-only, pid-only, flash-only. Session count configurable via `GENERATE_COUNT` env var (default 5). Excluded from normal `test:e2e` runs, run via `npm run demo:generate-history` |
| `e2e/demo-diagnostic-report.spec.ts` | 7 | Diagnostic Report flow: complete filter tune → report issue from completion summary → submit to dev worker → dismiss → report from history (included in normal `test:e2e` runs; can be run alone via `npm run test:e2e:diagnostic`) |
| `e2e/demo-generate-stress.spec.ts` | 1 | Generates stress-test tuning sessions with edge-case scenarios (excluded from normal `test:e2e` runs, run via `npm run demo:generate-history:stress`) |

**E2E infrastructure:**
- `e2e/electron-app.ts` — Shared fixture with `launchDemoApp()`, screenshot helpers, button/text wait utilities
- `playwright.config.ts` — Config: 1 worker, 60s timeout, trace on failure
- `.e2e-userdata/` — Isolated user data directory (wiped before each test file for clean state)
- `E2E_USER_DATA_DIR` env var — Overrides Electron `userData` path for test isolation
- `DEBUG_SERVER=true` env var — E2E tests launch with debug HTTP server on port 9300 for post-failure inspection (`/state`, `/logs`, `/screenshot`)
