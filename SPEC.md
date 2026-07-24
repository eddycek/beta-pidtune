# FPV Drone Autotuning App for Betaflight

## Design Specification

**Source:** `fpv-betaflight-autotune-spec.pdf`
**Generated:** 2026-01-29
**Last Updated:** February 12, 2026

> This file is the authoritative project specification and the single source of truth for project status. Each requirement is annotated with its implementation status. Previous tracking files (`COMPLETION_REPORT.md`, `IMPLEMENTATION_SUMMARY.md`, `TODO.md`) have been consolidated here.

### Status Legend

| Icon | Meaning |
|------|---------|
| :white_check_mark: | Implemented and tested |
| :construction: | Partially implemented / in progress |
| :x: | Not yet started |
| :fast_forward: | Deferred (post-MVP / future) |

---

## 1. Introduction

Tuning an FPV drone's flight controller is overwhelming for many pilots, especially beginners. Betaflight exposes powerful tuning controls (PIDs, filters), but optimizing them requires interpreting Blackbox logs. This document specifies an application that guides users end-to-end: connect the drone over USB, perform guided test flights, collect Blackbox logs, analyze them, apply tuning changes, and explain every change in beginner-friendly terms.

Primary focus: filter tuning (noise vs latency) and PID tuning (step response). The app must support configuration versioning (snapshots), comparisons, and rollback. AI is optional in MVP; the tuning engine must be deterministic (rules/metrics) and work offline.

---

## 2. Objectives

| # | Objective | Status |
|---|-----------|--------|
| 1 | Automated filter tuning from Blackbox (noise spectrum, resonance detection, safe reduction of filtering for lower latency) | :white_check_mark: Analysis engine + auto-apply to FC via CLI. Convergent recommendations. |
| 2 | Automated PID tuning from Blackbox (P/D balance using step response metrics) | :white_check_mark: Analysis engine + auto-apply to FC via MSP. Convergent, flight-PID-anchored. Master gain step deferred. |
| 3 | Beginner-first UX: wizard flow + clear explanations + safety checks | :white_check_mark: Wizard UI, results display with before/after cards, apply confirmation, interactive charts, flight guides. |
| 4 | Full local workflow: USB connect, log download/import, analysis, apply settings | :white_check_mark: Complete end-to-end: connect → download → parse → analyze → apply → rollback. |
| 5 | Configuration versioning: snapshots, rollback, labeling, export/import | :white_check_mark: Full snapshot system with diff view, restore/rollback, safety backups. |
| 6 | Cross-platform: Windows/macOS/Linux | :white_check_mark: Electron app with cross-platform builds (macOS .dmg, Windows .exe, Linux .AppImage). CI/CD via GitHub Actions. |
| 7 | Minimal cloud dependencies; optional AI via user-supplied API key | :white_check_mark: Fully offline. AI integration deferred. |

---

## 3. Target Users

**Primary users:** FPV pilots with limited tuning knowledge who want a responsive, stable tune without manual graph reading.

**Secondary users:** Experienced tuners who want a fast, repeatable workflow, quick comparisons, and safe rollback.

---

## 4. Workflow Overview

High-level user journey:

| Step | Description | Status |
|------|-------------|--------|
| 1 | Connect drone over USB; read Betaflight version/target; create baseline backup snapshot | :white_check_mark: MSP connect + FC info + auto-baseline snapshot + smart reconnect detection |
| 2 | Configure Blackbox logging for analysis (high logging rate, correct debug mode); ensure prerequisite settings | :white_check_mark: Blackbox info read + diagnostics (debug_mode, logging rate warnings). One-click "Fix Settings" in FCInfoDisplay + pre-flight warning in TuningStatusBanner → CLI commands → save & reboot. |
| 3 | Filter tuning: throttle-sweep test flight; retrieve log; run noise analysis; propose safe filter adjustments; apply | :white_check_mark: Full pipeline with Filter Tune workflow, post-erase guidance, FFT analysis, interactive spectrum charts, auto-apply via CLI. |
| 4 | PID tuning: stick snap test flight; retrieve log; analyze step responses; apply P/D recommendations | :white_check_mark: Step response analysis, interactive step response charts, auto-apply via MSP, mandatory verification flight with before/after comparison. D sweep multi-log comparison deferred. |
| 5 | Restore other parameters (FeedForward, I, dynamic damping if used); store tuned snapshot; test-fly; rollback if needed | :construction: Snapshot restore/rollback :white_check_mark:. FF detection + FF-aware PID analysis + MSP read :white_check_mark:. FF write-back via CLI apply :white_check_mark:. I write-back tuning :x:. |

---

## 5. Functional Requirements: Drone Connection

| Requirement | Status | Notes |
|-------------|--------|-------|
| Detect Betaflight FC via USB serial | :white_check_mark: | MSPConnection with vendor ID filtering + fallback |
| Communicate via MSP to read/write settings and retrieve logs | :white_check_mark: | MSPClient with retry logic, MSPProtocol encoder/decoder |
| Handle reconnects and FC reboots after save | :white_check_mark: | 3s cooldown, 1s backend delay, auto port rescan, CLI exit reboot handling |
| Support exporting config as CLI diff/dump and importing for restore | :white_check_mark: | `exportCLI('diff'|'dump')` via MSP CLI mode |
| Smart reconnect detection (auto-advance tuning phase on reconnect with flight data) | :white_check_mark: | Checks flash data on reconnect, auto-transitions flight_pending → log_ready |

---

## 6. Functional Requirements: Blackbox Logs

| Requirement | Status | Notes |
|-------------|--------|-------|
| Import .bbl/.bfl files and/or download logs from onboard flash via MSP | :white_check_mark: | MSP_DATAFLASH_READ download + BlackboxManager storage |
| Parse raw gyro and relevant channels (setpoint/gyro tracking) for analysis | :white_check_mark: | BlackboxParser: gyro, setpoint, PID, motor, debug as Float64Array (245 tests) |
| Load multiple logs for comparative analysis (e.g., D sweep flights) | :fast_forward: | Single-log analysis works. Multi-log comparison deferred to future iteration. |
| Ensure performance: large logs, FFT, and metric computation must not freeze UI | :white_check_mark: | Async parsing with progress events, FFT with event loop yielding |
| FC diagnostics: validate debug_mode and logging rate from Blackbox header | :white_check_mark: | GYRO_SCALED check, logging rate warnings in FC info panel |

---

## 7. Functional Requirements: Filter Tuning

| Requirement | Status | Notes |
|-------------|--------|-------|
| Compute gyro noise spectrum (FFT) over steady segments (exclude takeoff/landing) | :white_check_mark: | SegmentSelector + FFTCompute (Welch's method, Hanning window) |
| Detect peaks (frame resonance, motor harmonics) and overall noise floor | :white_check_mark: | NoiseAnalyzer: prominence-based peaks, 3 classification types, quartile noise floor |
| Decide adjustments: dynamic notch, RPM filtering validation, gyro/D-term lowpass cutoff changes, safety bounds | :white_check_mark: | Gyro/D-term LPF, RPM-aware bounds (widened when RPM active), dynamic notch optimization (count/Q) |
| Prefer minimal filtering compatible with safe noise levels to minimize latency | :white_check_mark: | Low noise → raise cutoffs for less latency; safety bounds enforced |
| Provide plain-English explanation per change + interactive graph view | :white_check_mark: | Plain-English explanations + interactive FFT spectrum chart (Recharts) |
| Apply changes to FC and save; auto-snapshot new config | :white_check_mark: | Auto-apply via CLI `set` commands, pre-tuning safety snapshot, save & reboot |

---

## 8. Functional Requirements: PID Tuning

| Requirement | Status | Notes |
|-------------|--------|-------|
| P/D balance: run stick snap flights; compute step responses; recommend P/D adjustments | :white_check_mark: | Step detection + metrics + scoring + recommendations + interactive step response chart |
| Flight style-aware PID thresholds (smooth/balanced/aggressive) | :white_check_mark: | Per-profile FlightStyle selector, style-based PID_STYLE_THRESHOLDS map, preset defaults, UI context display |
| D sweep multi-log comparison (vary D, compare response quality) | :fast_forward: | Deferred — requires multi-flight iterative workflow. |
| Master gain step: scale P/D together; detect onset of oscillation | :fast_forward: | Deferred — requires multi-flight iterative workflow. |
| Restore and tune secondary parameters (FF, I, anti-gravity, etc.) | :construction: | FF detection from BBL headers, FF-aware PID recommendations (skip P/D when FF-dominated), MSP_PID_ADVANCED read, FF config display in FC Info. FF write-back via CLI apply stage :white_check_mark:. I write-back not yet implemented. |
| Write final PIDs to FC; save; snapshot + diff vs previous | :white_check_mark: | Auto-apply PIDs via MSP + filters via CLI. Pre-tuning safety snapshot. Save & reboot. |

---

## 9. UX Requirements

| Requirement | Status | Notes |
|-------------|--------|-------|
| Wizard flow with progress | :white_check_mark: | Mode-aware wizard (filter/pid/quick) with unified 4-step progress indicator + status banner (16 phases across 3 modes) |
| Beginner language; tooltips for terms; advanced details toggle | :construction: | Recommendation reasons are beginner-friendly. Flight guides done. Metric tooltips and chart descriptions implemented (PR #240). Advanced details toggle not yet built. |
| Clear flight instructions with checklists and visual hints | :white_check_mark: | FlightGuideContent with 6 phases + 5 tips. TuningWorkflowModal for preparation. Post-erase guidance. |
| Robust error handling: inconclusive logs, missing data, parsing errors | :white_check_mark: | Parser corruption recovery, analysis fallback to full flight, IPC error responses, toast notifications |
| Profiles/History screen: list snapshots, compare, restore, export/import | :white_check_mark: | Snapshot list + delete + export + restore/rollback + GitHub-style diff comparison view |
| Interactive analysis charts | :white_check_mark: | FFT spectrum chart + step response chart + axis tabs (Recharts) |
| Read-only analysis overview (no tuning session) | :white_check_mark: | Single-page analysis view with both filter and PID results |
| Tuning completion summary with before/after comparison | :white_check_mark: | Noise comparison chart, applied changes table, PID metrics, verification hover |
| Tuning session history per profile | :white_check_mark: | Archived records, expandable history panel, detail view |

---

## 10. Platform and Technology Choice

| Decision | Status | Implementation |
|----------|--------|----------------|
| Cross-platform desktop app for reliable USB serial, offline operation, and local file handling | :white_check_mark: | Electron (Node.js + Chromium) chosen |
| Electron (Node.js + Chromium): fastest ecosystem, mature JS tooling | :white_check_mark: | Electron 28 + Vite + TypeScript + React |
| Tauri (Rust backend + WebView): smaller binaries and lower RAM | :fast_forward: | Not chosen for MVP. May revisit post-v1. |
| Keep analysis engine modular so it can later run as a Kubernetes service | :white_check_mark: | Analysis modules are pure functions (input → output), no Electron dependencies |

---

## 11. Architecture Proposal

### Core Modules

| Module | Spec Name | Status | Implementation |
|--------|-----------|--------|----------------|
| UI | React + chart library | :white_check_mark: | React + Recharts (interactive SVG charts) |
| Backend | Electron Node process with serial/MSP + analysis workers | :white_check_mark: | Main process with MSPClient, managers, IPC handlers |
| `msp-client` | connect, read/write settings, reboot, log download | :white_check_mark: | `src/main/msp/` — MSPProtocol, MSPConnection, MSPClient |
| `config-vcs` | snapshots, diffs, rollback, export/import | :white_check_mark: | `src/main/storage/SnapshotManager.ts` + ProfileManager + snapshot restore + diff view |
| `blackbox-parser` | decode logs | :white_check_mark: | `src/main/blackbox/` — 6 modules, 245 tests (incl. fuzz + real-flight regression) |
| `analysis-filter` | FFT, noise floor, peaks, filter recommendations | :white_check_mark: | `src/main/analysis/` — 5 modules, 129 tests (convergent noise-based targets, RPM-aware, data quality scoring) |
| `analysis-pid` | step response extraction, scoring, recommendations | :white_check_mark: | `src/main/analysis/` — 4 modules, 97 tests (flight PID anchoring, convergent, FF-aware, data quality scoring) |
| `tuning-orchestrator` | state machine + safety constraints | :white_check_mark: | TuningSessionManager (16-phase state machine, 3 modes: Filter Tune, PID Tune, Flash Tune) + apply handlers + restore handler |
| `ui-wizard` | screens + explanations + charts | :white_check_mark: | TuningWizard (mode-aware) + AnalysisOverview + TuningStatusBanner + interactive charts |

### Persistence

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| Local folder; store snapshots as JSON + CLI diff | :white_check_mark: | File-based JSON in `{userData}/data/` — profiles, snapshots, blackbox-logs, tuning sessions, tuning-history |

---

## 12. Kubernetes Readiness (Future)

| Requirement | Status | Notes |
|-------------|--------|-------|
| Package analysis engine as a stateless service (container) | :fast_forward: | Architecture supports this — analysis modules are pure functions |
| Keep core algorithms pure and testable (input → output) | :white_check_mark: | All analysis modules: pure TypeScript, no side effects, 1127 tests across 32 test files in `src/main/analysis/` (incl. golden-output regression harness) |
| Cloud optional; local remains primary | :white_check_mark: | Fully offline, no network calls |

---

## 13. Business and Product Strategy

| Consideration | Status | Notes |
|---------------|--------|-------|
| Market pain is real: many pilots struggle with tuning | N/A | Validated by spec |
| Differentiator: end-to-end tuning workflow + automated recommendations + rollback + beginner explanations | :white_check_mark: | Full end-to-end pipeline with Filter Tune, PID Tune, and Flash Tune workflows |
| Monetization paths (later): open-core or freemium | :construction: | Freemium license system implemented (PRs #266-#268). Payment integration pending. |
| MVP should be fully usable offline without accounts | :white_check_mark: | No accounts, no network, fully local |

---

## 14. MVP Deliverables

| Deliverable | Status | Notes |
|-------------|--------|-------|
| Cross-platform desktop app (Win/macOS/Linux) | :white_check_mark: | Electron app with CI/CD builds for macOS (.dmg), Windows (.exe), Linux (.AppImage). |
| USB connect + read/write Betaflight settings via MSP | :white_check_mark: | Complete |
| Snapshot/versioning with rollback | :white_check_mark: | Complete with diff view |
| Blackbox log import/download + parsing | :white_check_mark: | Complete (245 parser tests incl. fuzz) |
| Filter analysis + apply changes | :white_check_mark: | Complete with interactive charts |
| PID analysis (P/D balance) + apply changes | :white_check_mark: | Complete with interactive charts. Master gain deferred. |
| Tutorial screens for required test flights | :white_check_mark: | Filter Tune / PID Tune / Flash Tune workflows with status banner, flight guides, post-erase guidance |
| Export session report (PDF/HTML) | :fast_forward: | Deferred to future iteration |

---

## 15. References

- Betaflight documentation: Blackbox, MSP protocol, Configurator
- Betaflight Blackbox Log Viewer source code (parsing and plotting)
- PIDtoolbox wiki / step response methodology
- Oscar Liang: Blackbox tuning guides and throttle sweep methodology
- Open-source parsers: orangebox (Python), bbl_parser (Rust)
- @betaflight/api (JS) or equivalent MSP libraries

---

## Phase Tracking

### Phase 1: Core Infrastructure :white_check_mark:
**Status:** Complete | **PRs:** #1

- Electron + Vite + TypeScript + React project setup
- MSP Protocol implementation (connect, read/write, CLI mode)
- FC information display
- Configuration export (CLI diff/dump)
- Snapshot versioning system (create, delete, export, baseline)
- Multi-drone profile system (auto-detect by FC serial, 10 presets)
- Profile management UI (wizard, editing, deletion, locking)
- IPC architecture (preload bridge, event broadcasting)

### Phase 2: Blackbox Analysis & Automated Tuning :white_check_mark:
**Status:** Complete | **PRs:** #2–#10

- Blackbox MSP commands (download, erase, info)
- Blackbox binary log parser (245 tests, validated against BF Explorer)
- FFT analysis engine (127 tests, Welch's method, peak detection, RPM-aware)
- Step response analyzer (95 tests, flight-PID anchoring, FF-aware)
- Tuning wizard UI (5-step flow)
- Auto-apply recommendations (MSP PIDs → snapshot → CLI filters → save)
- Convergent recommendations (idempotent)
- Snapshot restore/rollback with safety backup

### Phase 2.5: UX Polish :white_check_mark:
**Status:** Complete | **PRs:** #11–#16

- Profile simplification (removed unused fields)
- Interactive analysis charts (FFT spectrum, step response) via Recharts
- Snapshot diff/comparison view (GitHub-style)
- Toast notification system

### Phase 3: Mode-Aware Analysis :white_check_mark:
**Status:** Complete | **PRs:** #17–#30

- Mode-aware wizard (filter-only / pid-only step routing)
- Read-only AnalysisOverview (single-page view without tuning session)
- Flight guide content (6 phases + 5 tips per flight type)
- TuningWorkflowModal (tuning workflow preparation)

### Phase 4: Stateful Tuning Workflow :white_check_mark:
**Status:** Complete | **PRs:** #31–#99, #235–#236, #240, #248–#257 | **Tests:** 1520+ across 82+ files

- TuningSessionManager (16-phase state machine across 3 modes: Filter Tune, PID Tune, Flash Tune; per-profile persistence)
- TuningStatusBanner (dashboard banner with unified 4-step indicator for all modes, action buttons)
- Mode-aware verification: spectrogram comparison (Filter Tune), step response comparison (PID Tune), noise spectrum overlay (Flash Tune)
- Smart reconnect detection (auto-advance when flight data detected)
- Post-erase guidance (flash erased notification with flight guide link)
- BlackboxStatus readonly mode during active tuning sessions
- FC diagnostics (GYRO_SCALED check, logging rate verification, one-click fix)
- CLI disconnect/reconnect fix (exit reboot handling)
- Dashboard layout (side-by-side Connection + Profile panels)
- Feedforward awareness: FF detection from BBL headers, FF-dominated overshoot classification, FF-aware PID recommendations
- MSP_PID_ADVANCED read: feedforward configuration via MSP command 94
- Feedforward display in FC Info panel: boost, per-axis gains, smoothing, jitter, transition, max rate limit
- RPM filter awareness: RPM state detection via MSP/BBL headers, RPM-aware filter bounds, dynamic notch optimization
- Flight style preferences: Smooth/Balanced/Aggressive selector in profiles, style-based PID thresholds, preset defaults, UI context display
- BF version policy: min 4.3 (API 1.44), version gate on connect, version-aware debug mode
- Comprehensive testing plan: 9-phase plan adding 464 tests. See [docs/complete/COMPREHENSIVE_TESTING_PLAN.md](./docs/complete/COMPREHENSIVE_TESTING_PLAN.md).
- Verification flight: mandatory per-mode verification via "Erase & Verify" (Filter Tune: throttle sweep, PID Tune: stick snaps, Flash Tune: hover)
- Navigation breadcrumb in AnalysisOverview, snapshot/analysis UX fixes
- Tuning history & comparison: session archive per profile, completion summary with noise spectrum overlay, applied changes table, PID metrics, expandable history panel
- BF PID profile selection: MSP_SELECT_SETTING + getStatusEx, profile selector in StartTuningModal with history context, profile badge on TuningStatusBanner and TuningHistoryPanel, snapshot restore preserves profile/rateprofile context

### Phase 5: Complete Manual Testing & UX Polish :x:
**Status:** Not started

End-to-end manual testing with real hardware to validate the entire tuning workflow.

**Goals:**
- Complete real-world tuning cycle (connect → filters → PIDs → verify)
- Validate log parsing accuracy against known-good logs from multiple FC types
- Verify recommendation quality (are filter/PID suggestions actually improving flight?)
- UX polish: fix any workflow friction, confusing labels, missing feedback
- Test edge cases: different FC boards, firmware versions, flash sizes
- Re-test log parsing with various Betaflight versions (4.3, 4.4, 4.5)
- Validate recommendation convergence on real flight data
- Cross-platform smoke test (macOS primary, Windows/Linux basic)

### Phase 6: CI/CD & Cross-Platform Releases :white_check_mark:
**Status:** Complete

Automated build pipeline producing installable applications for all platforms.

**Completed:**
- GitHub Actions CI pipeline: lint (`eslint`), type check (`tsc --noEmit`), test (`vitest`) on every PR
- Automated cross-platform release builds on git tag push:
  - **macOS**: `.dmg` installer
  - **Windows**: `.exe` installer (NSIS)
  - **Linux**: `.AppImage`
- Electron Builder for packaging
- Draft GitHub Releases with auto-uploaded artifacts
- ESLint + Prettier configuration with lint-staged pre-commit integration
- TypeScript strict type checking in CI (zero errors enforced)
- React ErrorBoundary for crash recovery
- IPC handler modularization (split monolithic 1500-line file into 12 domain modules)
- Data quality scoring: 0-100 quality score for flight data, confidence adjustment, quality warnings
- Flight quality score with trend chart: visual quality tracking across tuning sessions in history panel
- Feedforward write-back via CLI apply stage
- Anonymous telemetry collection: opt-in client-side telemetry (TelemetryManager, settings modal, IPC handlers). Collects tuning mode usage, drone sizes, quality scores — no flight data or PIDs (PR #261). Telemetry enrichment (PRs #286–#290): structured `ruleId` on all recommendations, `RecommendationTrace` and `VerificationDelta` types, `TelemetryBundleV2` with per-session records, CF Worker v2 admin endpoints, `/telemetry-evaluator` skill

**Completed (PRs #266–#268):**
- Code signing (macOS notarization, Windows Authenticode)
- Auto-update mechanism (electron-updater with GitHub Releases)
- Freemium license system (Ed25519 offline-first, free tier 1 profile, Pro unlimited)
- Settings modal with tabbed Telemetry + Logs viewer

### Phase 7: E2E Tests :construction:
**Status:** Demo mode E2E complete. Real FC E2E not started.

#### 7a: Demo Mode E2E (Playwright) :white_check_mark:
Automated Playwright E2E tests that launch the real Electron app in demo mode (mock FC) and walk through the full tuning workflow. No hardware required.

**Completed:**
- Playwright E2E infrastructure: `e2e/electron-app.ts` fixture with `launchDemoApp()`, screenshot helpers, isolated `E2E_USER_DATA_DIR`
- 4 smoke tests: app launch, auto-connect, dashboard elements
- 7 Filter Tune cycle tests: complete filter-only cycle with wizard, apply, erase & verify, download, analyze verification, complete, dismiss, history check
- 7 PID Tune cycle tests: complete PID-only cycle with wizard, apply, erase & verify, download, analyze verification, complete, dismiss, history check
- 7 Flash Tune cycle tests: Flash Tune cycle with parallel analysis, apply all, erase & verify, download, analyze verification, complete, dismiss, history check
- 5-cycle history generator: `npm run demo:generate-history` for populating tuning history with progressive quality scores
- `advancePastVerification()` fix: keeps mock FC flight type cycle in sync when verification is skipped across multiple cycles
- Total: 37 Playwright E2E tests across 7 spec files (32 in normal runs — smoke + 3 tuning cycles + diagnostic — plus generators/stress)

#### 7b: Real FC E2E :x:
Automated end-to-end tests running in CI pipeline against a real FC connected to a dedicated machine.

**Goals:**
- Dedicated test runner machine with FC physically connected via USB
- Self-hosted GitHub Actions runner or remote test agent
- E2E test suite covering:
  - Serial port detection and connection
  - MSP command round-trip (read FC info, read/write PIDs, read/write filters)
  - CLI mode entry/exit, CLI diff export
  - Blackbox flash operations (erase, write test data, read back)
  - Snapshot create/restore cycle
  - Full tuning apply flow (apply recommendations → verify settings changed)
- Test isolation: reset FC to known state before each test
- Reporting: test results in CI with FC firmware version metadata
- Support multiple FC boards/firmware versions (test matrix)

---

## Progress Summary

**Last Updated:** July 24, 2026 | **Tests:** 3278 unit tests across 149 files (3255 passing + 23 skipped) + 37 Playwright E2E tests | **PRs Merged:** #1–#432

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Core Infrastructure | **100%** :white_check_mark: | MSP, profiles, snapshots |
| Phase 2: Blackbox Analysis & Tuning | **100%** :white_check_mark: | Parser, FFT, step response, auto-apply, rollback |
| Phase 2.5: UX Polish | **100%** :white_check_mark: | Charts, diff view, toast |
| Phase 3: Mode-Aware Analysis | **100%** :white_check_mark: | Wizard modes, read-only analysis, flight guides |
| Phase 4: Tuning Workflow | **100%** :white_check_mark: | Session state machine (Filter Tune + PID Tune + Flash Tune), smart reconnect, status banner, mode-aware verification, tuning history |
| Phase 5: Manual Testing & UX Polish | **0%** :x: | Next up |
| Phase 6: CI/CD & Releases | **100%** :white_check_mark: | CI pipeline, cross-platform releases, ESLint/Prettier, ErrorBoundary, handler split, data quality, flight quality score, telemetry |
| Phase 7a: Demo E2E (Playwright) | **100%** :white_check_mark: | ~37 Playwright tests (demo mode, Filter Tune + PID Tune + Flash Tune + diagnostic reports + generators) |
| Phase 7b: Real FC E2E | **0%** :x: | After Phase 5 |

### Remaining Spec Items (deferred to future iterations)

| Item | Section | Notes |
|------|---------|-------|
| D sweep multi-log comparison | 8 | Requires multi-flight iterative workflow |
| Master gain step (P/D scaling) | 8 | Requires multi-flight iterative workflow |
| FF/I/secondary parameter tuning | 8 | FF detection + FF-aware PID recommendations + MSP read done. FF write-back via CLI apply stage done. I write-back not yet implemented. |
| UI tooltips for technical terms | 9 | Metric tooltips and chart descriptions done (PR #240). Advanced details toggle remaining. |
| Auto-configure BB logging settings | 4 | Would streamline pre-flight setup |
| AI-powered tuning (optional) | 2 | Post-MVP, user-supplied API key |
| Export session report (PDF/HTML) | 14 | Nice-to-have for sharing |
| Kubernetes analysis service | 12 | Post-v1, architecture already supports it |
