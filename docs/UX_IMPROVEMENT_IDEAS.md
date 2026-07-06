# UX Improvement Ideas

> **Status**: Active

Collected ideas for improving the tuning workflow UX. Roughly prioritized by impact.

## ~~1. Pre-Flight Blackbox Settings Check~~ :white_check_mark: Done

Implemented: FCInfoDisplay shows "Fix Settings" button when blackbox settings are wrong. TuningStatusBanner shows amber pre-flight warning during `*_flight_pending` phases with one-click "Fix Settings" button. Both trigger `FC_FIX_BLACKBOX_SETTINGS` IPC → CLI commands → save & reboot.

## 2. Flight Type Validation After Download

After downloading a log, quickly check if it matches the expected flight type: hover segments for filter phase, step inputs for PID phase. Warn before running analysis if data doesn't match. Saves time and avoids misleading recommendations.

## ~~3. Before/After Comparison on Completion~~ :white_check_mark: Done

Implemented: TuningCompletionSummary replaces the status banner when session phase is `completed`. Shows NoiseComparisonChart (before/after spectrum overlay with dB delta) when verification data available, falls back to numeric noise stats without verification. Applied filter and PID changes displayed in AppliedChangesTable with old → new values and % change. PID step response metrics shown per axis. PRs #96–#99.

## 4. Cherry-Pick Recommendations Before Apply

Allow users to select individual recommendations instead of all-or-nothing apply. Checkboxes on `RecommendationCard` items in `TuningSummaryStep`. Useful for experienced users who want fine-grained control.

## ~~5. Verification Flight Guidance~~ :white_check_mark: Done

Implemented: TuningStatusBanner offers optional verification hover after PID apply. User can fly a 30s gentle hover, download the log, and the app runs filter analysis to produce an "after" noise spectrum. NoiseComparisonChart overlays before/after spectra with per-axis dB delta indicators. User can skip verification to go straight to completion. PRs #96–#99.

## ~~6. Tuning Session History~~ :white_check_mark: Done

Implemented: TuningHistoryManager archives completed sessions to `{userData}/data/tuning-history/{profileId}.json` with self-contained metrics (CompactSpectrum, FilterMetricsSummary, PIDMetricsSummary). TuningHistoryPanel on dashboard shows expandable cards with date, change count, and noise level. Expanding a card shows TuningSessionDetail with NoiseComparisonChart and AppliedChangesTable. Auto-reloads on profile change and session dismissal. PRs #96–#99.

## 7. Recovery After Interrupted Apply

If USB disconnects mid-apply, the pre-tuning snapshot is the safety net. On reconnect, detect inconsistent state and offer "Restore pre-tuning snapshot" directly in the banner for a smoother recovery UX.
