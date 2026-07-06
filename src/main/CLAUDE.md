# Main Process

Entry point: `src/main/index.ts`. Manages MSPClient, ProfileManager, SnapshotManager, BlackboxManager, TuningSessionManager, TelemetryManager, TelemetryEventCollector.

## Storage System

**Profile Storage** (`ProfileManager.ts`):
- Location: `{userData}/data/profiles/`
- One JSON file per profile: `{profileId}.json`
- Metadata index: `profiles.json` (list of all profiles)
- Current profile ID: `current-profile.txt`

**Snapshot Storage** (`SnapshotManager.ts`):
- Location: `{userData}/data/snapshots/`
- One JSON file per snapshot: `{snapshotId}.json`
- Contains: FC info, CLI diff, timestamp, label, type (baseline/manual/auto)
- Snapshots are linked to profiles via `snapshotIds` array

**Critical**: Snapshot filtering happens server-side (main process) based on current profile's `snapshotIds` array. This prevents snapshots from different profiles mixing in UI.

**Tuning History Storage** (`TuningHistoryManager.ts`):
- Location: `{userData}/data/tuning-history/{profileId}.json`
- Array of `CompletedTuningRecord[]` per profile (oldest-first on disk, newest-first in API)
- Archived from completed sessions with self-contained metrics + applied changes
- Deleted when profile is deleted
- Compact metrics: `FilterMetricsSummary` (noise floor, peaks, 128-bin spectrum, throttle spectrogram), `PIDMetricsSummary` (step response), `TransferFunctionMetricsSummary` (bandwidth, phase margin, dcGain, throttleBands)
- Spectrum downsampling: `downsampleSpectrum()`, `extractThrottleSpectrogram()` in `src/shared/utils/metricsExtract.ts`

**Telemetry Storage** (`TelemetryManager.ts` + `TelemetryEventCollector.ts`):
- Location: `{userData}/data/telemetry-settings.json` (settings), `{userData}/data/telemetry-events.json` (structured events)
- Opt-in only (disabled by default), anonymous UUID v4 installation ID
- Bundle assembly (v3): `TelemetryBundleV3` with per-session `TelemetrySessionRecord[]` including recommendation traces, verification deltas, and structured `TelemetryEvent[]`
- `TelemetryEventCollector`: ring-buffer (max 200 events), persisted to disk, cleared after successful upload
- Upload via Electron `net.fetch()` to CF Worker endpoint (gzipped JSON), skipped in demo mode

**Diagnostic Reports** (Pro only):
- `DiagnosticBundleBuilder.ts` builds gzipped bundles with recommendations, analysis data, FC config
- Optional BBL flight data upload (fire-and-forget, 50 MB max, 120s timeout)
- Endpoints: `POST /v1/diagnostic`, `PUT /v1/diagnostic/{id}/bbl`, `PATCH /v1/diagnostic/{reportId}`
- Auto-reports on apply verification failure (`sendAutoReport()` in `DiagnosticReportService.ts`)
- Rate-limited 1/hour per installation

**License Storage** (`LicenseManager.ts`):
- Location: `{userData}/license.json`
- Signed license object (Ed25519) for offline verification
- Free tier: 1 profile limit enforced in profileHandlers
- Demo mode + dev mode: auto-Pro

**Auto-Updater** (`src/main/updater.ts`):
- Uses `electron-updater` with GitHub Releases as provider
- Checks 10s after launch (packaged builds only, skip dev/demo)
- Silent background download, `autoInstallOnAppQuit = true`

## Auto-Apply Recommendations

**Apply Flow** (orchestrated in `TUNING_APPLY_RECOMMENDATIONS` IPC handler):
0. Pre-apply: `validateRecommendationBounds()` rejects if any value out of `BF_SETTING_RANGES` (firmware-exact ranges; PID entries use the cross-size envelope of `QUAD_SIZE_BOUNDS` so size-specific recommender output — e.g. 6"/7" D up to 100 — always passes; includes feedforward gates like `feedforward_smooth_factor`)
1. PID profile selection safety net — ensures FC is on the correct BF PID profile
2. Apply PID changes via MSP (must happen before CLI mode). Saves `currentConfig` for rollback
3. Enter CLI mode
4. Apply filter changes via CLI `set` commands. On failure: automatic PID rollback to `currentConfig`
5. Apply feedforward changes via CLI (separate stage from filters)
6. Sync PID profile name to FC via `set profile_name = X` (8-char BF limit, non-fatal if unsupported)
7. Save to EEPROM and reboot FC
8. Post-reboot: inline verification + post-tuning snapshot creation

**Edge case**: If total recommendations = 0, returns success without reboot. Zero-change sessions may complete directly: `TuningSessionManager` allows the `*_analysis → completed` transition (verification is skipped when nothing was applied, PR #241).

**Important**: MSP commands must execute before CLI mode (FC only processes CLI in CLI mode → MSP timeouts).

**Auto-Snapshot Strategy** (2 per tuning cycle):
- `Pre-tuning #N (Type)` — created by Start Tuning (rollback safety net)
- `Post-tuning #N (Type)` — created on reconnect after PID/Quick apply (final tuned result)

Snapshots carry tuning metadata (`tuningSessionNumber`, `tuningType`, `snapshotRole`) for contextual labels and smart Compare matching by session number.

## Snapshot Restore (Rollback)

**Restore Flow** (orchestrated in `SNAPSHOT_RESTORE` IPC handler):
1. Load snapshot — check for `cliDump` (full state) or fall back to `cliDiff` (legacy)
2. Stage 1 (backup): Create "Pre-restore (auto)" safety snapshot (2s settle after reboot)
3. Stage 2 (cli): Enter CLI mode
   - **Dump-based** (new snapshots with `cliDump`): Send `defaults nosave` first → apply all dump commands → exact 1:1 FC state match
   - **Diff-based** (legacy snapshots): Apply diff commands only (no `defaults nosave`)
4. Stage 3 (save): Save and reboot FC
5. Stage 4 (MSP): Restore PID config via MSP (safety net for `simplified_pids_mode`)

**Full state snapshots**: Since PR #431, snapshots store both `cliDiff` (for comparison UI) and `cliDump` (for complete restore). `exportCLIDiffAndDump()` captures both in a single CLI session (one reboot). Dump-based restore with `defaults nosave` ensures all settings — including BF defaults — are restored exactly.

**Resilient restore**: If a CLI command fails (e.g., out-of-range value), the handler logs the failure, collects the command in `failedCommands[]`, and continues with remaining commands.

**Restorable commands**: `set`, `feature`, `serial`, `aux`, `beacon`, `map`, `resource`, `timer`, `dma`, `profile` (context switch), `rateprofile` (context switch) — everything except identity and control commands.

## SD Card Blackbox Support

- `BlackboxInfo.storageType`: `'flash' | 'sdcard' | 'none'` — detection is automatic
- SD card logs cannot be read via MSP — download uses MSC (Mass Storage Class) mode
- MSC workflow: `MSP_REBOOT(type=2)` → FC re-enumerates as USB drive → copy .bbl files → eject → FC reboots
- `MSCManager` (`src/main/msc/`) orchestrates the full MSC download/erase cycle
- MSC disconnect is expected — `mscModeActive` flag prevents profile clear on disconnect
- Design doc: `docs/SD_CARD_BLACKBOX_SUPPORT.md`

## Smart Reconnect Detection

- On reconnect with existing profile, checks if tuning session is in `*_flight_pending` phase
- If flash has data (`bbInfo.hasLogs && bbInfo.usedSize > 0`), auto-transitions to `*_log_ready`
- SD card state flags: `eraseSkipped` (treat reconnect as "flew"), `eraseCompleted` (post-erase UI shows guide, don't auto-transition yet)
- `mscModeActive` flag prevents profile clear during expected MSC disconnect
- `rebootPending` flag prevents profile clear during expected save-reboot
- Implemented in `src/main/index.ts` after `createBaselineIfMissing()`

## FC State Cache

`src/main/cache/FCStateCache.ts` — centralized in-memory cache for all MSP-readable FC state. Hydrates once on connect, provides synchronous reads to IPC handlers, pushes state changes to renderer via `EVENT_FC_STATE_CHANGED`. See `src/main/cache/CLAUDE.md` for full details (hydration sequence, invalidation matrix, guards).

## Post-Apply Verification

On smart reconnect after apply, `verifyAppliedConfig()` (`src/main/utils/verifyAppliedConfig.ts`) reads back full PID and filter configuration from FC via MSP, compares ALL readable values (not just applied changes), and runs sanity checks (P/I/D=0, filter bypassed). Applied feedforward changes are also verified for the MSP-readable subset (boost, smooth/jitter factor, max rate limit); CLI-only FF settings (e.g. `feedforward_averaging`, `tpa_*`) are skipped during verification (same treatment as `rpm_filter_q`); only unknown settings land in `unchecked`. Retries PID write+readback once on mismatch (10s timeout). Results stored on `TuningSession.applyVerified`, `applyMismatches`, `applyExpected`, `applyActual`, `applySuspicious`, and `autoReportId`. On failure, auto-submits diagnostic report (Pro only).
