# Documentation Index

Overview of all design documents in this directory. Completed documents are archived in [`complete/`](./complete/) as historical design records.

## Reference Documents

| Document | Description |
|----------|-------------|
| [PID_TUNING_KNOWLEDGE](./PID_TUNING_KNOWLEDGE.md) | FPV tuning knowledge base — PID/filter theory, quad archetypes, best practices. Used by the `/tuning-advisor` skill. |

## Active Documents

| Document | Status | Description |
|----------|--------|-------------|
| [TUNING_ALGORITHMS_AUDIT](./TUNING_ALGORITHMS_AUDIT.md) | **Active** | Deep DSP/tuning-algorithm audit + market benchmark (PIDtoolbox, Plasmatree, Blackbox Explorer, FPVtune) → phased roadmap. Phase 0 + Phase 1 (calibrated v2 PSD, robust peaks, size-aware resonance, coherence, contiguity, propwash baseline, yaw, verify coverage), Phase 2 (deconvolved step response, throttle-aware peak classification, filter overlays, before/after comparison, BF 4.5/4.6 capabilities, RPM filter rules, latency budget, ThrottleTF pitch + TPA), and Phase 3 P3.1–P3.4 (evidence UI, system ID what-if, filter placement optimizer, motor fault signatures) implemented; P3.5 (crowd benchmarking) deferred |
| [TUNING_MODE_COMPARISON](./TUNING_MODE_COMPARISON.md) | **Active** | Filter+PID Tune vs Flash Tune comparison — offline cross-validation findings, real-world validation plan |
| [TUNING_SESSION_EVALUATION](./TUNING_SESSION_EVALUATION.md) | **Active** | Tuning session evaluation strategy — size-aware noise thresholds, per-mode success criteria, convergence detection |
| [BLACKBOX_DOWNLOAD_OPTIMIZATION](./BLACKBOX_DOWNLOAD_OPTIMIZATION.md) | **Proposed** | MSC mode for flash storage (10–50× speedup) with MSP pipelining fallback (1.5–2×). Larger chunks deprioritized (already tested, poor results) |
| [CHIRP_FLIGHT_ANALYSIS](./CHIRP_FLIGHT_ANALYSIS.md) | **Proposed** | Chirp signal system identification for BF 4.6+ — exponential frequency sweep, per-axis sequential execution, coherence validation, high-precision transfer functions |
| [UX_IMPROVEMENT_IDEAS](./UX_IMPROVEMENT_IDEAS.md) | **Active** | Backlog of UX improvement ideas (4/7 done, rest are future work) |
| [CONFIG_HEALTH_CHECK](./CONFIG_HEALTH_CHECK.md) | **Proposed** | Read-only FC config audit — safety, motor/ESC, RC link, power, size-specific. ~20 rules across 5 categories, health score. Excludes PID/filter/blackbox (covered by tuning modes) |
| [PAYMENT_AND_INVOICING](./PAYMENT_AND_INVOICING.md) | **Proposed** | Stripe payment gateway + Trivi API invoicing. End-to-end purchase → invoice → license delivery flow |
| [LICENSE_KEY_SYSTEM](./LICENSE_KEY_SYSTEM.md) | **Active** | Freemium licensing via CF Workers + D1. Ed25519 keys, offline grace period, admin API |
| [PRO_VERSION_STRATEGY](./PRO_VERSION_STRATEGY.md) | **Proposed** | Pro version strategy & 10-year financial plan — pricing, feature split, revenue projections |
| [CODE_SIGNING_AND_UPDATES](./CODE_SIGNING_AND_UPDATES.md) | **Active** | macOS/Windows code signing, electron-updater auto-update, GitHub Releases provider |

## Completed Documents (`complete/`)

| Document | Description |
|----------|-------------|
| [BBL_PARSER_VALIDATION](./complete/BBL_PARSER_VALIDATION.md) | Byte-exact validation of BBL parser against BF Explorer reference implementations |
| [BF_VERSION_POLICY](./complete/BF_VERSION_POLICY.md) | Betaflight version compatibility policy (min 4.3, recommended 4.5+) |
| [COMPREHENSIVE_TESTING_PLAN](./complete/COMPREHENSIVE_TESTING_PLAN.md) | 9-phase testing plan: 2180 tests / 107 files |
| [FLASH_TUNE_RECOMMENDATION_PARITY](./complete/FLASH_TUNE_RECOMMENDATION_PARITY.md) | Unified PID pipeline, quality score parity, DC gain I-term rule, per-band TF analysis |
| [FEEDFORWARD_AWARENESS](./complete/FEEDFORWARD_AWARENESS.md) | FF detection, FF-dominated overshoot classification, FF-aware PID recommendations, MSP read |
| [FLIGHT_STYLE_PROFILES](./complete/FLIGHT_STYLE_PROFILES.md) | Smooth/Balanced/Aggressive flight style selector, style-based PID thresholds, preset defaults |
| [OFFLINE_UX_TESTING](./complete/OFFLINE_UX_TESTING.md) | Demo mode (`--demo` flag) for offline UX testing. ~37 Playwright E2E tests |
| [PROPWASH_AND_DTERM_DIAGNOSTICS](./complete/PROPWASH_AND_DTERM_DIAGNOSTICS.md) | Prop wash detection + D-term effectiveness analysis with recommendation integration |
| [PROJECT_QUALITY_REPORT_2026-02-14](./complete/PROJECT_QUALITY_REPORT_2026-02-14.md) | Point-in-time quality assessment (Feb 14, 2026) |
| [QUICK_TUNE_WIENER_DECONVOLUTION](./complete/QUICK_TUNE_WIENER_DECONVOLUTION.md) | Single-flight Flash Tune mode via Wiener deconvolution: transfer function estimation, Bode plots. (Historical: originally described dual-mode Deep Tune vs Flash Tune; Deep Tune later replaced by separate Filter Tune + PID Tune modes) |
| [RPM_FILTER_AWARENESS](./complete/RPM_FILTER_AWARENESS.md) | RPM filter detection via MSP/BBL, RPM-aware filter bounds, dynamic notch optimization |
| [SD_CARD_BLACKBOX_SUPPORT](./complete/SD_CARD_BLACKBOX_SUPPORT.md) | SD card blackbox storage via MSC mode + tuning session fixes |
| [TUNING_HISTORY_AND_COMPARISON](./complete/TUNING_HISTORY_AND_COMPARISON.md) | Tuning session history + before/after comparison on completion |
| [TUNING_WORKFLOW_FIXES](./complete/TUNING_WORKFLOW_FIXES.md) | Fix for download/analyze blocking + phase transition issues |
| [TELEMETRY_COLLECTION](./complete/TELEMETRY_COLLECTION.md) | Anonymous telemetry via CF Workers + R2. Client + server + Terraform IaC + CI/CD (PRs #261–#265) |
| [TUNING_WORKFLOW_REVISION](./complete/TUNING_WORKFLOW_REVISION.md) | Stateful tuning workflow design. (Historical: originally described Deep Tune 10-phase state machine; later evolved into 3-mode architecture: Filter Tune, PID Tune, Flash Tune) |
| [DYNAMIC_LOWPASS_MSP_FIX](./complete/DYNAMIC_LOWPASS_MSP_FIX.md) | Read dynamic lowpass fields from MSP, dynamic-aware filter recommendations, filter type awareness (PRs #365–#366) |
| [PRESET_GAP_ANALYSIS](./complete/PRESET_GAP_ANALYSIS.md) | Gap analysis vs community presets — all 11 tasks implemented (PRs #314–#323) |
| [DIAGNOSTIC_REPORTS](./complete/DIAGNOSTIC_REPORTS.md) | Diagnostic report bundles for support investigation. Pro-only, gzipped upload to CF Worker + optional BBL flight data upload (PRs #310–#338) |
| [TUNING_PRECISION_IMPROVEMENTS](./complete/TUNING_PRECISION_IMPROVEMENTS.md) | 14 research-based tuning accuracy improvements — all implemented (Wiener deconvolution, proportional PID scaling, data quality scoring, throttle spectrograms, etc.). Chirp analysis extracted to standalone doc |
| [VERIFICATION_FLIGHT_SIMILARITY](./complete/VERIFICATION_FLIGHT_SIMILARITY.md) | Verification flight similarity matching & tuning loop prevention. 4-layer architecture: flight similarity matcher, recommendation hysteresis, convergence detection, iteration tracking (PRs #411–#415) |
| [FC_STATE_CACHE](./FC_STATE_CACHE.md) | Centralized FC data cache + event push. Eliminates race conditions from independent MSP reads, simplifies renderer state (~15 vars removed from App.tsx), fixes stale BB status/PID profile/erase step bugs (PR #428). *Status Complete but not yet archived — file lives at `docs/FC_STATE_CACHE.md`, not `complete/`* |

## Status Legend

| Status | Meaning |
|--------|---------|
| **Complete** | Fully implemented and merged. Archived in `complete/` as historical design record. |
| **Active** | Contains a mix of completed and pending items. Living document. |
