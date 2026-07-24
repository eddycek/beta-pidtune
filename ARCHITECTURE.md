# Architecture Overview

**Last Updated:** July 24, 2026 | **Phase 4 Complete, Phase 6 Complete** | **3243 unit tests (3220 passing + 23 skipped), 147 files + 37 Playwright E2E tests**

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Electron App                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                     Renderer Process (React)                          │  │
│  │                                                                        │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌──────────────┐ ┌──────────────┐   │  │
│  │  │ Connection  │ │  FC Info +  │ │  Blackbox    │ │  Snapshot    │   │  │
│  │  │   Panel     │ │ Diagnostics │ │   Status     │ │  + History  │   │  │
│  │  └──────┬──────┘ └──────┬──────┘ └──────┬───────┘ └──────┬──────┘   │  │
│  │         │               │               │                │           │  │
│  │  ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴───────┐ ┌──────┴──────┐   │  │
│  │  │  Profile    │ │   Tuning    │ │   Tuning     │ │  Analysis   │   │  │
│  │  │  Selector   │ │   Status    │ │   Wizard     │ │  Overview   │   │  │
│  │  │ + Wizard    │ │   Banner    │ │ + Charts     │ │ (read-only) │   │  │
│  │  └──────┬──────┘ └──────┬──────┘ └──────┬───────┘ └──────┬──────┘   │  │
│  │         │               │               │                │           │  │
│  │  ┌──────┴───────────────┴───────────────┴────────────────┴────────┐  │  │
│  │  │                    Custom React Hooks                          │  │  │
│  │  │  useConnection | useProfiles | useSnapshots | useTuningSession │  │  │
│  │  │  useTuningWizard | useAnalysisOverview | useToast | ...        │  │  │
│  │  └────────────────────────────┬───────────────────────────────────┘  │  │
│  │                               │                                      │  │
│  │                      window.betaflight API                           │  │
│  └───────────────────────────────┼──────────────────────────────────────┘  │
│                                  │                                         │
│  ┌───────────────────────────────┼──────────────────────────────────────┐  │
│  │              Preload Script (contextBridge, 689 lines)              │  │
│  └───────────────────────────────┼──────────────────────────────────────┘  │
│                                  │ IPC (67 channels, 16 event types)        │
│                                  │                                         │
│  ┌───────────────────────────────┼──────────────────────────────────────┐  │
│  │                     Main Process (Node.js)                          │  │
│  │                                                                      │  │
│  │  ┌────────────────────────────┴─────────────────────────────────┐   │  │
│  │  │                    IPC Handlers (67 handlers, 13 modules)     │   │  │
│  │  │  connection:* | fc:* | snapshot:* | profile:* | blackbox:*  │   │  │
│  │  │  analysis:* | tuning:* | pid:*                              │   │  │
│  │  └───┬──────────┬──────────┬────────────┬──────────┬───────────┘   │  │
│  │      │          │          │            │          │                │  │
│  │  ┌───┴───┐ ┌────┴────┐ ┌──┴───────┐ ┌──┴──────┐ ┌┴──────────┐    │  │
│  │  │ MSP   │ │Snapshot │ │ Profile  │ │Blackbox │ │  Tuning   │    │  │
│  │  │Client │ │Manager  │ │ Manager  │ │Manager  │ │  Session  │    │  │
│  │  │       │ │         │ │          │ │         │ │ + History │    │  │
│  │  └───┬───┘ └─────────┘ └──────────┘ └─────────┘ └───────────┘    │  │
│  │      │                                                             │  │
│  │  ┌───┴──────────┐  ┌─────────────────┐  ┌──────────────────┐      │  │
│  │  │MSPConnection │  │ BlackboxParser  │  │ Analysis Engine │      │  │
│  │  │ + CLI Mode   │  │ (6 modules,     │  │ FFT + Step Resp │      │  │
│  │  │ + fcEntered  │  │  245 tests)     │  │ (27 modules,    │      │  │
│  │  │   CLI flag   │  │                 │  │  1127 tests)    │      │  │
│  │  └───┬──────────┘  └─────────────────┘  └──────────────────┘      │  │
│  │      │                                                             │  │
│  │  ┌───┴──────────┐                                                  │  │
│  │  │ MSPProtocol  │                                                  │  │
│  │  │ v1 + Jumbo   │                                                  │  │
│  │  └───┬──────────┘                                                  │  │
│  └──────┼─────────────────────────────────────────────────────────────┘  │
│         │                                                                │
│  ┌──────┴───────────────────────────────────────────────────────────┐    │
│  │                  serialport (Native Module)                      │    │
│  └──────────────────────────┬───────────────────────────────────────┘    │
│                              │                                           │
└──────────────────────────────┼───────────────────────────────────────────┘
                               │
                     ┌─────────┴─────────┐
                     │  USB Serial Port  │
                     │  Flight Controller│
                     │   (Betaflight)    │
                     └───────────────────┘
```

---

## Main Process (`src/main/`)

### Entry Point (`index.ts`, 424 lines)

Creates and wires seven managers + FCStateCache + optional debug server:

```typescript
const mspClient = new MSPClient();
const profileManager = new ProfileManager(`${userData}/data/profiles`);
const snapshotManager = new SnapshotManager(`${userData}/data/snapshots`, mspClient);
const blackboxManager = new BlackboxManager();                    // {userData}/data/blackbox-logs
const tuningSessionManager = new TuningSessionManager(`${userData}/data`); // {userData}/data/tuning
const tuningHistoryManager = new TuningHistoryManager(`${userData}/data`); // {userData}/data/tuning-history
const telemetryManager = new TelemetryManager(`${userData}/data`);         // {userData}/data/telemetry-settings.json
const fcStateCache = new FCStateCache(mspClient);                 // Centralized FC state cache
```

**Event wiring (MSPClient → Main Window):**
- `'connection-changed'` → `sendConnectionChanged(window, status)`
- `'connected'` → Profile detection + baseline creation + smart reconnect
- `'disconnected'` → Clear profile + notify UI

**On FC connect flow:**
1. Read FC serial number (`MSP_UID`)
2. Read FC info (variant, version, board, target)
3. Look up profile by serial (`findProfileBySerial`)
4. If profile exists → set current, create baseline if missing, check tuning session
5. If new FC → fire `EVENT_NEW_FC_DETECTED` → renderer shows ProfileWizard modal

**Smart reconnect detection** (after step 4):
```
If tuning session exists AND phase is filter_flight_pending, pid_flight_pending, or flash_flight_pending:
  Read flash info via MSP_DATAFLASH_SUMMARY
  If flash has data (usedSize > 0):
    Transition to filter_log_ready or pid_log_ready
    Broadcast EVENT_TUNING_SESSION_CHANGED
```

**Debug server** (when `DEBUG_SERVER=true`): After managers are initialized, `setDebugDependencies()` and `startDebugServer()` launch an HTTP server on port 9300. After window creation, `captureRendererConsole()` hooks into `webContents.on('console-message')`. Implementation: `src/main/debug/DebugServer.ts` (435 lines). 10 endpoints: `/health`, `/state`, `/screenshot`, `/logs`, `/console`, `/msp`, `/tuning-history`, `/tuning-session`, `/snapshots`, `/blackbox-logs`.

---

### MSP Layer (`src/main/msp/`)

| File | Lines | Purpose |
|------|-------|---------|
| `MSPClient.ts` | 969 | High-level API with retry logic |
| `MSPConnection.ts` | 309 | Serial port handling, CLI mode |
| `MSPProtocol.ts` | 229 | MSP v1 packet encoding/decoding |
| `cliUtils.ts` | — | CLI command parsing utilities |
| `commands.ts` | 16 | MSP command enum (23 commands) |
| `types.ts` | 44 | MSP type definitions |

#### MSP Protocol (v1)

```
Request:   $  M  <  [SIZE:u8] [CMD:u8] [DATA:SIZE bytes] [CHECKSUM:u8]
Response:  $  M  >  [SIZE:u8] [CMD:u8] [DATA:SIZE bytes] [CHECKSUM:u8]
Error:     $  M  !  [SIZE:u8] [CMD:u8] [DATA:SIZE bytes] [CHECKSUM:u8]

Checksum = SIZE ^ CMD ^ DATA[0] ^ ... ^ DATA[SIZE-1]
Jumbo: auto-upgraded when payload > 255 bytes (for flash reads)
```

#### MSP Commands Used

| Command | Code | Purpose |
|---------|------|---------|
| `MSP_API_VERSION` | 1 | API version check |
| `MSP_FC_VARIANT` | 2 | Firmware identification (BTFL) |
| `MSP_FC_VERSION` | 3 | Firmware version string |
| `MSP_BOARD_INFO` | 4 | Board name, target |
| `MSP_DATAFLASH_SUMMARY` | 70 | Flash capacity/usage |
| `MSP_DATAFLASH_READ` | 71 | Download Blackbox data |
| `MSP_DATAFLASH_ERASE` | 72 | Erase flash |
| `MSP_FILTER_CONFIG` | 92 | Read current filter settings (47+ bytes, BF 4.3+) — includes RPM filter (bytes 43-44), dynamic notch (bytes 39, 47), dynamic lowpass (gyro: bytes 17,24,25; D-term: bytes 28,29-36) |
| `MSP_PID_ADVANCED` | 94 | Read feedforward configuration (45 bytes: boost, per-axis gains, smoothing, jitter, transition, max rate limit) |
| `MSP_PID` | 112 | Read PID configuration (9 bytes: 3 axes × 3 terms) |
| `MSP_STATUS_EX` | 150 | Extended status (PID profile index, profile count) |
| `MSP_UID` | 160 | FC unique ID (96-bit, for profile matching) |
| `MSP_SET_PID` | 202 | Write PID configuration |
| `MSP_SELECT_SETTING` | 210 | Select BF PID profile (0-indexed) |

#### MSPConnection — CLI Mode Handling

- **`cliMode: boolean`** — local flag, reset by `exitCLI()`
- **`fcEnteredCLI: boolean`** — persistent flag tracking whether CLI was entered this session
- **`enterCLI()`** — sends `#\r\n`, sets both flags
- **`exitCLI()`** — resets only `cliMode` (FC stays in CLI until reboot)
- **`clearFCRebootedFromCLI()`** — clears `fcEnteredCLI` after `save` (FC reboots from save)
- **`close()`** — if `fcEnteredCLI` is set, sends `exit\r\n` (reboots FC) before closing port

**Critical**: BF CLI `exit` always calls `systemReset()` — there's no way to leave CLI without rebooting. So `exitCLI()` only resets the local flag. The FC remains in CLI until `close()` sends exit or the USB cable is unplugged.

**CLI prompt detection**: `sendCLICommand()` accumulates output and resolves when buffer ends with `\n#` (not just `#`, which false-matches `# comment` lines in `diff all` output).

#### MSPClient — Key Methods

**Connection:**
- `connect(portPath)` — 500ms stabilization, `forceExitCLI()` to recover stuck state, retry logic (2 attempts with reset between)
- `disconnect()` — close with 1s backend delay for port release
- Cooldown: 3s UI timer after disconnect prevents "FC not responding"

**FC info:** `getFCInfo()` → composite of `getApiVersion()`, `getFCVariant()`, `getFCVersion()`, `getBoardInfo()`. `getStatusEx()` reads current PID profile index and count.

**PID profile selection:** `selectPIDProfile(index)` via `MSP_SELECT_SETTING` (210) switches the active BF PID profile (0-indexed). Used before tuning to target a specific profile slot.

**Configuration:** `exportCLIDiff()` / `exportCLIDump()` — enter CLI, run `diff all` / `dump`, send `exit` (reboots FC), then auto-reconnect (handles both USB-CDC stay-alive and USB re-enumeration scenarios)

**Blackbox download:** `downloadBlackboxLog(onProgress)` — adaptive chunking (starts 180B, max 240B per read), strips 6-7 byte dataflash header from each chunk. Returns `{ data, compressionDetected }` — Huffman compression is detected and flagged (analysis blocked for compressed logs)

**MSP_DATAFLASH_READ response format:**
```
[4B readAddress LE][2B dataSize LE][1B isCompressed (BF4.1+)][flash data]
extractFlashPayload() returns { data, isCompressed } — auto-detects 6-byte vs 7-byte header by comparing response length with dataSize field. Huffman compression flag is propagated to caller.
```

**Erase:** `eraseBlackboxFlash()` — sends `MSP_DATAFLASH_ERASE`, polls `MSP_DATAFLASH_SUMMARY` until `usedSize === 0` (some FCs don't ACK the erase command).

---

### Blackbox Parser (`src/main/blackbox/`)

Parses Betaflight `.bbl`/`.bfl` binary log files into typed time-series data. Validated against Betaflight Explorer for byte-exact compatibility.

| File | Lines | Tests | Purpose |
|------|-------|-------|---------|
| `BlackboxParser.ts` | 855 | 35+9+13 | Main orchestrator, multi-session, corruption recovery |
| `StreamReader.ts` | 123 | 35 | Binary cursor with VB encoding |
| `HeaderParser.ts` | 188 | 25 | ASCII header parsing → `BBLLogHeader` |
| `ValueDecoder.ts` | 273 | 64 | 10 encoding types → raw field values |
| `PredictorApplier.ts` | 169 | 31 | 10 predictor types → absolute values |
| `FrameParser.ts` | 479 | 15 | Frame-level assembly (I/P/S/E frames) |
| `constants.ts` | 201 | — | Config thresholds |

#### Pipeline

```
Buffer → StreamReader → HeaderParser → FrameParser → BlackboxParser
           ↓               ↓              ↓
      Binary Cursor    BBLLogHeader   Frame decode:
           ↓                              ValueDecoder → PredictorApplier
      VB encoding                         ↓
                                     BlackboxFlightData {
                                       gyro: [Roll, Pitch, Yaw] (Float64Array),
                                       setpoint, pidP/I/D, motor, debug, rcCommand
                                     }
```

#### Encoding Types (10)

| ID | Name | Description |
|----|------|-------------|
| 0 | `SIGNED_VB` | Signed variable-byte (zigzag) |
| 1 | `UNSIGNED_VB` | Unsigned variable-byte |
| 3 | `NEG_14BIT` | `-signExtend14Bit(readUnsignedVB())` |
| 6 | `TAG8_8SVB` | Tag byte → up to 8 signedVB values. **count==1 special case**: reads signedVB directly (no tag byte) |
| 7 | `TAG2_3S32` | Tag byte (2 bits) → 3 values (16/32-bit) |
| 8 | `TAG8_4S16` | Tag byte → 4 values (8/16-bit). Version-dependent bit layout |
| 9 | `NULL` | No encoding (field skipped) |
| 10 | `TAG2_3SVARIABLE` | Tag byte → 3 signedVB values |

#### Predictor Types (10)

| ID | Name | I-frame | P-frame |
|----|------|---------|---------|
| 0 | `ZERO` | value | value |
| 1 | `PREVIOUS` | value | value + prev |
| 2 | `STRAIGHT_LINE` | value | value + (2×prev - prev2) |
| 3 | `AVERAGE_2` | value | value + `Math.trunc((prev + prev2)/2)` — C integer division |
| 4 | `MINTHROTTLE` | value + minthrottle | value + prev |
| 5 | `MOTOR_0` | value + motor[0] | value + prev |
| 6 | `INCREMENT` | value | value + prev + 1 |
| 9 | `VBATREF` | value + vbatref | value + prev |

#### Frame Types

```
'I' (0x49) — Keyframe with absolute values
'P' (0x50) — Predicted frame with deltas from previous
'S' (0x53) — Slow-rate data
'E' (0x45) — Event markers (LOG_END, DISARM, SYNC_BEEP, etc.)
```

**Event parsing** uses VB encoding (not fixed skip): SYNC_BEEP=1×UVB, DISARM=1×UVB, FLIGHT_MODE=2×UVB, LOGGING_RESUME=2×UVB, LOG_END validates `"End of log\0"` (anti-false-positive).

#### Frame Validation (aligned with BF Explorer)

| Check | Threshold |
|-------|-----------|
| Structural size | 256 bytes max |
| Iteration jump | < 5000 |
| Time jump | < 10 seconds |
| I-frame backward tolerance | 50ms time, 500 iterations |

No sensor value thresholds (debug/motor can exceed any fixed range). No consecutive corrupt frame limit. Corrupt frame recovery: rewind to `frameStart + 1`, continue byte-by-byte.

---

### Analysis Engine (`src/main/analysis/`)

Two independent analysis pipelines: **filter tuning** (FFT noise analysis) and **PID tuning** (step response metrics).

| File | Lines | Tests | Purpose |
|------|-------|-------|---------|
| `FFTCompute.ts` | 224 | 24 | Welch's method, detrended Hanning windows, power-domain averaging, calibrated one-sided power spectrum (v2 scale) |
| `SegmentSelector.ts` | 375 | 31 | Hover + throttle sweep detection, yaw steadiness gating (1.5×) |
| `NoiseAnalyzer.ts` | 342 | 36 | Peak detection (plateau handling, 15 Hz spacing, parabolic interpolation), size-aware noise classification |
| `FilterRecommender.ts` | 1045 | 108 | Noise-based filter targets, RPM-aware bounds, dynamic-lowpass-aware (tunes dyn_min/max when active), propwash floor, medium noise, notch-aware resonance, LPF2, yaw-only resonance observation, preset gap analysis settings |
| `FilterAnalyzer.ts` | 372 | 20 | Filter analysis orchestrator (data quality, throttle spectrogram, group delay) |
| `ThrottleSpectrogramAnalyzer.ts` | 210 | 23 | Throttle-dependent spectrogram analysis (contiguous runs only) |
| `GroupDelayEstimator.ts` | 216 | 28 | Group delay estimation, filter latency measurement, uses dyn_min_hz when dynamic active |
| `StepDetector.ts` | 164 | 16 | Derivative-based step input detection |
| `StepMetrics.ts` | 416 | 53 | Rise time, overshoot, settling, trace, FF contribution, adaptive window |
| `PIDRecommender.ts` | 1840 | 266 | Flight-PID-anchored P/D recommendations, FF-aware, damping ratio, I-term, quad-size-aware bounds, D-min/TPA advisory, TF coherence gate, preset gap analysis settings |
| `PIDAnalyzer.ts` | 640 | 28 | PID analysis orchestrator (FF context, data quality, cross-axis, propwash) |
| `CrossAxisDetector.ts` | 162 | 20 | Cross-axis coupling detection |
| `PropWashDetector.ts` | 367 | 20 | Propwash detection and analysis (clean-segment baseline) |
| `DataQualityScorer.ts` | 403 | 39 | Flight data quality scoring (0-100), confidence adjustment, low coherence warning |
| `headerValidation.ts` | 300 | 45 | BB header diagnostics, version-aware debug mode, RPM enrichment, preset gap analysis fields |
| `throttleUtils.ts` | 24 | 4 | Shared throttle normalization heuristics (1000-2000/0-1000/0-100/0-1 formats) |
| `constants.ts` | 927 | 11 | All tunable thresholds (validated by `constants.test.ts`) |

#### Filter Analysis Pipeline

```
BlackboxFlightData → SegmentSelector → FFTCompute → NoiseAnalyzer → FilterRecommender
                         ↓                ↓              ↓                ↓
                    FlightSegments   PowerSpectrum   NoisePeaks    FilterRecommendation[]
                    (hover/sweep)    (per axis)      (classified)  (with reasons)
```

**SegmentSelector** finds stable hover segments and throttle sweeps:
- Hover: throttle 15–75%, roll/pitch gyro std < 50 deg/s (yaw < 75 deg/s — 1.5× relaxed), min 0.5s duration
- Sweeps: throttle range > 40%, 2–15s duration, monotonic check
- Prefers sweeps over hovers when available

**FFTCompute**: detrended Hanning windows, Welch's method (50% overlap, 4096-sample window, power-domain averaging), returns a calibrated one-sided power spectrum `PowerSpectrum { frequencies, magnitudes }` (Float64Array). Spectrum scale v2 (`SPECTRUM_SCALE_VERSION = 2`): a sine of amplitude A reads 10·log10(A²/2); dB values sit ≈10 dB above the legacy v1 amplitude-averaged scale.

**NoiseAnalyzer** detects peaks by prominence (> 6 dB above local floor, plateau-aware, 15 Hz minimum spacing, parabolic sub-bin interpolation) and classifies:
- **Frame resonance**: size-aware `FRAME_RESONANCE_BY_SIZE` band (5": 80–200 Hz, 1"/2.5": 150–350 Hz, 7": 60–150 Hz)
- **Motor harmonics**: equally-spaced peaks (≥ 3 peaks)
- **Electrical noise**: > 500 Hz

Noise floor: 25th percentile of magnitude spectrum.

**FilterRecommender** — convergent noise-based targeting:

```
Target cutoff = linear interpolation (v2 power-spectrum scale):
  noiseFloorDb =   0 dB → min cutoff (very noisy)
  noiseFloorDb = -60 dB → max cutoff (very clean)

Safety bounds (RPM-aware):
  Gyro LPF1:  75–300 Hz (75–500 Hz with RPM filter)
  D-term LPF1: 70–200 Hz (70–300 Hz with RPM filter)

Dead zone: 5 Hz minimum change to recommend
Resonance: if prominent peak (>12 dB) is below current cutoff → lower cutoff to peak - 20 Hz
RPM active: recommend dyn_notch_count=1, dyn_notch_q=500 (frame resonance only)
Dynamic lowpass active (dyn_min_hz > 0): target dyn_min/max instead of static_hz
```

RPM filter state is detected from `MSP_FILTER_CONFIG` (bytes 43-44) or BBL raw headers as fallback. Dynamic lowpass state is detected from `MSP_FILTER_CONFIG` dynamic lowpass fields (gyro: offsets 17,24,25; D-term: offsets 28,29-36). Helper exports: `isRpmFilterActive()`, `isGyroDynamicActive()`, `isDtermDynamicActive()`. The `rpmFilterActive` flag propagates through to `FilterAnalysisResult` and the UI.

Recommendations are **convergent** (idempotent): re-analyzing the same log after applying produces no further changes.

#### PID Analysis Pipeline

```
BlackboxFlightData → StepDetector → StepMetrics → PIDRecommender
                         ↓              ↓              ↓
                    StepDetection[]  StepResponse[] PIDRecommendation[]
                    (per axis)       (with traces,  (flight-PID-anchored,
                                      ffDominated)   FF-aware)

BBL rawHeaders → extractFeedforwardContext() → FeedforwardContext
                                                  ↓
                                            classifyFFContribution()
                                            (|pidF| vs |pidP| at peak)
```

**StepDetector** finds sharp stick inputs:
- Derivative threshold: 500 deg/s/s
- Minimum magnitude: 150 deg/s
- Hold time: ≥ 50ms, cooldown: ≥ 100ms between steps

**StepMetrics** computes per-step response quality:

| Metric | Definition |
|--------|-----------|
| Rise time | 10% → 90% of target (ms) |
| Overshoot | (peak - target) / target × 100 (%) |
| Settling time | Last exit from ±2% band (ms) |
| Latency | Time to 5% movement from baseline (ms) |
| Ringing | Post-step oscillation count (zero-crossings) |

Each step also stores a `StepResponseTrace { timeMs, setpoint, gyro }` (Float64Array) for chart visualization. Steps can be classified as `ffDominated: boolean` via `classifyFFContribution()`.

**PIDRecommender** — flight-PID-anchored convergent recommendations (FF-aware):

```
extractFlightPIDs(rawHeaders) → PIDConfiguration from BBL header
  (P[0]/I[0]/D[0] fields = PIDs active during the flight)

Decision rules:
  Overshoot > 25%              → increase D +5 (high confidence)
  Overshoot > 25% AND D ≥ 60%  → also decrease P -5
  Overshoot 15–25%             → increase D +5 (medium confidence)
  Overshoot < 10% AND rise > 80ms → increase P +5 (medium)
  Ringing > 2 cycles           → increase D +5 (medium)
  Yaw: relaxed thresholds (1.5× overshoot, 120ms sluggish)

Safety bounds: P 20–120, D 15–80, I 30–120

FF-aware override:
  extractFeedforwardContext(rawHeaders) → { active, boost?, maxRateLimit? }
  When majority of steps are ffDominated (|pidF| > |pidP| at peak):
    → Skip P/D overshoot rules
    → Recommend feedforward_boost reduction instead
```

Anchoring to flight PIDs (not current FC PIDs) makes recommendations **convergent**. FF-aware classification prevents misattributing feedforward-caused overshoot to P/D imbalance.

#### Header Validation (`headerValidation.ts`)

Checks before analysis:
- `debug_mode` should be `GYRO_SCALED` (warning if `NONE` or other)
- Logging rate should be ≥ 2 kHz (warning if < 2 kHz)
- Results shown as amber warnings in FCInfoDisplay

---

### Storage Layer (`src/main/storage/`)

| Manager | Storage Path | Format |
|---------|-------------|--------|
| `ProfileManager` | `{userData}/data/profiles/` | `{id}.json` + `profiles.json` index + `current-profile.txt` |
| `SnapshotManager` | `{userData}/data/snapshots/` | `{id}.json` per snapshot |
| `BlackboxManager` | `{userData}/data/blackbox-logs/` | `blackbox_{timestamp}.bbl` + `logs.json` index |
| `TuningSessionManager` | `{userData}/data/tuning/` | `{profileId}.json` per session |
| `TuningHistoryManager` | `{userData}/data/tuning-history/` | `{profileId}.json` per profile (archived records) |
| `TelemetryManager` | `{userData}/data/` | `telemetry-settings.json` (opt-in settings + installation ID) |
| `LicenseManager` | `{userData}/` | `license.json` (Ed25519 signed license for offline verification) |

**User data path:** `~/Library/Application Support/fpvpidlab/` (macOS) | `%APPDATA%/fpvpidlab/` (Windows) | `~/.config/fpvpidlab/` (Linux)

#### Profile Data Model

```typescript
DroneProfile {
  id: string,                    // UUID
  fcSerialNumber: string,        // MSP_UID hex (profile ↔ FC link)
  name: string,                  // "My 5 inch Freestyle"
  size: DroneSize,               // '1"' | '2"' | ... | '10"'
  battery: BatteryType,          // '1S' | ... | '6S'
  propSize?: string,
  weight?: number,
  motorKV?: number,
  notes?: string,
  fcInfo: FCInfo,
  createdAt: string,             // ISO timestamp
  lastConnected?: string,
  connectionCount: number,
  snapshotIds: string[],         // Links to owned snapshots
  baselineSnapshotId?: string,
  bfPidProfileIndex?: number,    // Last-used BF PID profile (0-indexed)
  bfPidProfileLabels?: string[]  // User labels for each BF PID profile slot
}
```

8 preset profiles available: tiny-whoop, 3inch-whoop, 3inch-freestyle, 4inch-freestyle, 5inch-freestyle, 5inch-race, 6inch-longrange, 7inch-longrange.

#### Snapshot Data Model

```typescript
ConfigurationSnapshot {
  id: string,
  timestamp: string,
  label: string,                // "Baseline", "Pre-tuning #3 (Filter Tune)", user-defined
  type: 'baseline' | 'manual' | 'auto',
  fcInfo: FCInfo,
  configuration: { cliDiff: string },
  metadata: {
    appVersion: string,
    createdBy: string,
    tuningSessionNumber?: number,   // Session counter for contextual labels
    tuningType?: 'filter' | 'pid' | 'flash', // Filter Tune, PID Tune, or Flash Tune
    snapshotRole?: 'pre-tuning' | 'post-tuning',  // Role badges (orange/green)
    bfPidProfileIndex?: number   // BF PID profile active when snapshot was taken
  }
}
```

Server-side filtering: `listSnapshots()` returns only snapshots whose IDs are in `currentProfile.snapshotIds` — prevents cross-profile data leaks.

#### Tuning Session Data Model

```typescript
TuningSession {
  profileId: string,
  phase: TuningPhase,            // 14-phase state machine (Filter Tune: 6, PID Tune: 6, Flash Tune: 6, shared: 2)
  startedAt: string,
  updatedAt: string,
  baselineSnapshotId?: string,
  filterLogId?: string,
  appliedFilterChanges?: AppliedChange[],
  pidLogId?: string,
  appliedPIDChanges?: AppliedChange[],
  verificationLogId?: string,
  postTuningSnapshotId?: string,
  filterMetrics?: FilterMetricsSummary,
  pidMetrics?: PIDMetricsSummary,
  verificationMetrics?: FilterMetricsSummary,
  bfPidProfileIndex?: number     // BF PID profile targeted by this session (0-indexed)
}
```

---

### IPC Layer (`src/main/ipc/`)

**67 IPC channels** organized by domain:

| Domain | Channels | Key Operations |
|--------|----------|---------------|
| Connection (8) | `list_ports`, `connect`, `disconnect`, `get_status`, `is_demo_mode`, `reset_demo`, `get_logs`, `export_logs` | Port scanning, connect/disconnect, demo mode, logs |
| FC Info (8) | `get_info`, `get_state`, `export_cli`, `get_blackbox_settings`, `get_feedforward_config`, `get_rates_config`, `fix_blackbox_settings`, `select_pid_profile` | FC data, cached state, CLI export, FF config, rates config, BB settings fix, BF PID profile selection (MSP_SELECT_SETTING) |
| Profiles (11) | `create`, `create_from_preset`, `update`, `delete`, `wipe`, `list`, `get`, `get_current`, `set_current`, `export`, `get_fc_serial` | Full profile CRUD + wipe |
| Snapshots (6) | `create`, `list`, `delete`, `export`, `load`, `restore` | Snapshot CRUD + rollback |
| Blackbox (9) | `get_info`, `download_log`, `list_logs`, `delete_log`, `erase_flash`, `open_folder`, `test_read`, `parse_log`, `import_log` | Flash ops + parsing + import |
| Analysis (3) | `run_filter`, `run_pid`, `run_transfer_function` | FFT + step response + Wiener deconvolution |
| Tuning (8) | `apply_recommendations`, `get_session`, `start_session`, `update_phase`, `reset_session`, `get_history`, `update_verification`, `update_history_verification` | Apply + session state + history + verification |
| PID (3) | `get_config`, `update_config`, `save_config` | MSP PID read/write |
| Telemetry (3) | `get_settings`, `set_enabled`, `send_now` | Anonymous usage telemetry settings + manual upload |
| License (4) | `activate`, `get_status`, `remove`, `validate` | License activation, status, removal |
| Update (2) | `check`, `install` | Auto-update check, install |
| Diagnostic (2) | `send_report`, `patch_report` | Build diagnostic bundle, upload to CF Worker + fire-and-forget BBL upload (Pro only) + PATCH auto-report with user details |

**16 Event types** (Main → Renderer):

| Event | Payload |
|-------|---------|
| `fc_state_changed` | `FCState` |
| `connection_changed` | `ConnectionStatus` |
| `profile_changed` | `DroneProfile \| null` |
| `new_fc_detected` | `(fcSerial, fcInfo)` |
| `pid_changed` | `PIDConfiguration` |
| `error` | `string` |
| `log` | `(message, level)` |
| `blackbox_download_progress` | `number` (0–100) |
| `blackbox_parse_progress` | `BlackboxParseProgress` |
| `analysis_progress` | `AnalysisProgress` |
| `tuning_apply_progress` | `ApplyRecommendationsProgress` |
| `snapshot_restore_progress` | `SnapshotRestoreProgress` |
| `tuning_session_changed` | `TuningSession \| null` |
| `license_changed` | `LicenseStatus` |
| `update_available` | `UpdateInfo` |
| `update_downloaded` | `UpdateInfo` |

#### Apply Recommendations Handler (critical ordering)

```
Stage 1: Apply PID changes via MSP (MSP_SET_PID)    ← MUST be before CLI mode
Stage 2: Enter CLI mode (via exportCLIDiff)
Stage 3: Apply filter changes via CLI "set" commands
Stage 4: CLI "save" → FC reboots

Why: MSP commands fail while FC is in CLI mode (CLI captures all input).
```

#### Snapshot Restore Handler

```
Stage 1 (backup): Create "Pre-restore (auto)" snapshot
Stage 2 (cli):    Enter CLI → send each restorable command (resilient: continues on error)
Stage 3 (save):   CLI "save" → FC reboots

Restorable commands: set, feature, serial, aux, beacon, map, resource, timer, dma, profile (context), rateprofile (context)
Skipped: diff, batch, defaults, save, board_name, manufacturer_id, mcu_id, signature

Resilient restore: if a CLI command fails (e.g., out-of-range value, unknown setting),
the handler continues with remaining commands. Failed commands are collected in
SnapshotRestoreResult.failedCommands[] and shown as warnings in the UI.
```

---

## Preload Bridge (`src/preload/index.ts`, 527 lines)

Exposes `window.betaflight` API to renderer via `contextBridge.exposeInMainWorld()`. All methods return Promises; events return unsubscribe functions.

**Pattern:**
```typescript
// Request-response (renderer → main → renderer)
async connect(port: string): Promise<void> {
  const response = await ipcRenderer.invoke(IPCChannel.CONNECTION_CONNECT, port);
  if (!response.success) throw new Error(response.error);
}

// Event subscription (main → renderer)
onConnectionChanged(callback: (status: ConnectionStatus) => void): () => void {
  const handler = (_: any, status: ConnectionStatus) => callback(status);
  ipcRenderer.on(IPCChannel.EVENT_CONNECTION_CHANGED, handler);
  return () => ipcRenderer.removeListener(IPCChannel.EVENT_CONNECTION_CHANGED, handler);
}
```

**Security model:**
- Renderer has no direct `ipcRenderer` access
- Only the methods defined in preload are exposed
- All inputs validated in IPC handlers (main process)
- No `eval()`, no dynamic code execution
- SerialPort access only through main process

---

## Renderer (`src/renderer/`)

### App State & Routing (`App.tsx`)

Three view modes based on state:

```
analysisLogId set?  → <AnalysisOverview logId={...} />     (read-only analysis)
activeLogId set?    → <TuningWizard logId={...} mode={...} /> (tuning wizard)
else                → Dashboard (ConnectionPanel, ProfileSelector, TuningStatusBanner,
                       FCInfoDisplay, BlackboxStatus, SnapshotManager)
```

**Key state variables:**
- `isConnected`, `currentProfile` — control what's visible on dashboard
- `tuning.session` — drives TuningStatusBanner visibility and BlackboxStatus readonly mode
- `erasedForPhase: string | null` — tracks flash erase per tuning phase (avoids stale boolean)
- `wizardMode: 'filter' | 'pid'` — which analysis to run when wizard opens
- `analysisLogId` vs `activeLogId` — read-only overview vs tuning wizard

### Component Hierarchy

```
App (ToastProvider wrapper)
├── AppContent
│   ├── Header: "FPVPIDlab" + version + "How to tune?" button
│   │
│   ├── [If analysisLogId] AnalysisOverview (read-only, single page)
│   ├── [If activeLogId]   TuningWizard (guided multi-step)
│   ├── [Else] Dashboard:
│   │   ├── .top-row (flex, side-by-side):
│   │   │   ├── ConnectionPanel
│   │   │   └── ProfileSelector (if connected + profile)
│   │   │
│   │   ├── TuningStatusBanner (if tuning session active)
│   │   │   └── Step indicator + action buttons + post-erase guidance
│   │   │
│   │   ├── TuningCompletionSummary (if session.phase === 'completed')
│   │   │   └── Noise comparison chart + applied changes + PID metrics + actions
│   │   │
│   │   ├── "Start Tuning Session" banner (if no session, connected)
│   │   │
│   │   ├── FCInfoDisplay (if connected)
│   │   │   └── FC info grid + BB diagnostics + FF config + export buttons
│   │   │
│   │   ├── BlackboxStatus (if connected)
│   │   │   └── Storage info (flash/SD card) + logs + Download/Erase/Analyze (readonly if session)
│   │   │
│   │   ├── SnapshotManager (if connected + profile)
│   │   │   └── Create + list + diff view + restore
│   │   │
│   │   └── TuningHistoryPanel (if history exists)
│   │       └── Expandable history cards → TuningSessionDetail
│   │
│   ├── ProfileWizard (modal, on new FC detection)
│   ├── TuningWorkflowModal (help modal)
│   ├── TelemetrySettingsModal (telemetry opt-in/out, send now)
│   └── ToastContainer
```

### React Hooks (15 hooks)

| Hook | Key Returns | Purpose |
|------|-------------|---------|
| `useConnection` | `{ports, status, connect, disconnect, scanPorts}` | Serial port connection |
| `useFCInfo` | `{fcInfo, loading}` | FC information polling |
| `useProfiles` | `{profiles, currentProfile, createProfile, ...}` | Profile CRUD |
| `useSnapshots` | `{snapshots, createSnapshot, restoreSnapshot, ...}` | Snapshot management |
| `useBlackboxInfo` | `{info, refresh}` | Flash storage status |
| `useBlackboxLogs` | `{logs, deleteLog, refresh}` | Downloaded log list |
| `useTuningSession` | `{session, startSession, resetSession}` | Tuning session lifecycle |
| `useTuningWizard` | `{parseResult, filterResult, pidResult, applying, ...}` | Wizard state machine |
| `useTuningHistory` | `{history, loading, reload}` | Tuning history loading + auto-reload |
| `useAnalysisOverview` | `{parseResult, filterResult, pidResult, ...}` | Auto-parse + dual analysis |
| `useDemoMode` | `{isDemoMode, resetDemo}` | Demo mode detection + reset |
| `useTelemetrySettings` | `{settings, loading, toggleEnabled, sendNow, sending}` | Telemetry settings + manual upload |
| `useLicense` | `{status, activate, remove, loading}` | License activation + status |
| `useAutoUpdate` | `{updateAvailable, updateDownloaded, install}` | Auto-update state + events |
| `useToast` | `{success, error, warning, info}` | Toast notifications |

### Interactive Charts (`TuningWizard/charts/`)

Built with **Recharts** (SVG):

- **SpectrumChart** — FFT noise spectrum per axis (roll/pitch/yaw). Shows noise floor reference lines, detected peak frequency markers, color-coded axes.
- **StepResponseChart** — Overlaid setpoint vs gyro trace for individual steps. Prev/Next navigation, metrics overlay (overshoot %, rise time, settling, latency).
- **TFStepResponseChart** — Synthetic step response from Transfer Function (Wiener deconvolution). Single mode for Flash Analysis, before/after comparison for verification. Per-axis overshoot metrics, delta pill.
- **ThrottleSpectrogramChart** — Custom SVG heatmap showing noise magnitude across frequency (x) and throttle (y) bands. Color-coded dB scale. Accepts both live `data` (analysis) and `compactData` (archived) props. Integrated in FilterAnalysisStep, QuickAnalysisStep, AnalysisOverview, and TuningSessionDetail.
- **SpectrogramComparisonChart** — Side-by-side before/after spectrogram comparison for Filter Tune verification. Shows throttle spectrograms from analysis and verification flights with labels.
- **StepResponseComparison** — Before/after PID metrics comparison for PID Tune verification. Shows per-axis overshoot, rise time, settling time, and ringing with delta indicators.
- **AxisTabs** — Shared Roll/Pitch/Yaw/All tab selector for charts. Supports `showAll` prop.
- **chartUtils** — `toRechartsData()` conversion, `downsampleData()`, `findBestStep()` scoring, `computeRobustYDomain()` (outlier-resistant Y axis).

---

## Tuning State Machine

State machine persisted per-profile in `{userData}/data/tuning/{profileId}.json`. Three modes: **Filter Tune** (filter-only, 6 phases), **PID Tune** (PID-only, 6 phases), and **Flash Tune** (combined, 6 phases).

```
Filter Tune:                PID Tune:                   Flash Tune:

  START SESSION               START SESSION               START SESSION
       │                           │                           │
filter_flight_pending       pid_flight_pending          flash_flight_pending
       │                           │                           │
[smart reconnect]           [smart reconnect]           [smart reconnect]
       │                           │                           │
 filter_log_ready            pid_log_ready               flash_log_ready
       │                           │                           │
  filter_analysis             pid_analysis               flash_analysis
       │                           │                      (filter + TF)
  filter_applied              pid_applied                      │
       │                           │                    flash_applied
filter_verification_      pid_verification_                    │
  pending                   pending                   verification_pending
       │                           │                           │
    completed                  completed                  completed
```

**TuningStatusBanner** renders per-phase with unified 4-step layout for all modes (Prepare → Flight → Tune → Verify):
- Current step (1–4) with progress indicator
- Phase-specific text and action button
- Post-erase state: "Flash erased! Disconnect and fly..." + "View Flight Guide"
- Pre-flight BB settings warning when `bbSettingsOk === false` with "Fix Settings" button
- Reset button to abandon session

**TuningCompletionSummary** replaces banner when `session.phase === 'completed'`:
- Mode-aware verification rendering:
  - Filter Tune: spectrogram comparison (side-by-side before/after spectrograms)
  - PID Tune: step response comparison (before/after PID metrics per axis)
  - Flash Tune: noise comparison chart (before/after spectrum overlay with dB delta)
- Applied filter and PID changes tables
- PID step response metrics per axis
- Smart suggestion buttons: context-aware "Start New Tuning Cycle" with pre-selected mode based on verification results
- "Dismiss" action to close completion summary

**TuningHistoryPanel** shows archived past sessions:
- Expandable cards with date, change count summary, noise level
- Detail view reuses NoiseComparisonChart and AppliedChangesTable
- Auto-reloads on profile change and session dismissal

**BlackboxStatus** enters readonly mode (`readonly={!!tuning.session}`) — hides all action buttons, shows only storage info and log list. All actions driven by TuningStatusBanner.

---

## Data Flows

### 1. Connect Flow

```
User clicks Connect → ConnectionPanel → useConnection.connect(port)
  → window.betaflight.connect(port) → IPC → MSPClient.connect()
  → MSPConnection.open() → 500ms stabilize → forceExitCLI()
  → getFCInfo() (with 2× retry + reset) → emit 'connected'
  → Main: profile lookup → baseline → smart reconnect check
  → sendConnectionChanged() → renderer onConnectionChanged → UI update
```

### 2. Blackbox Download + Analysis Flow

```
User clicks Download → BlackboxStatus → window.betaflight.downloadBlackboxLog()
  → IPC → MSPClient.downloadBlackboxLog() → adaptive chunks via MSP_DATAFLASH_READ
  → BlackboxManager.saveLog() → return metadata
  → User clicks Analyze → handleAnalyze() → set activeLogId → show TuningWizard
  → useTuningWizard auto-parses: parseBlackboxLog(logId)
  → BlackboxParser.parse(buffer) → StreamReader → Header → Frames → FlightData
  → User picks session → auto-runs analysis:
    Filter: SegmentSelector → FFTCompute → NoiseAnalyzer → FilterRecommender
    PID:    StepDetector → StepMetrics → PIDRecommender
  → Results display with interactive charts
```

### 3. Apply Recommendations Flow

```
User clicks Apply → ApplyConfirmationModal → useTuningWizard.confirmApply()
  → window.betaflight.applyRecommendations(input) → IPC handler:
  Stage 1: MSPClient.setPIDConfiguration() via MSP_SET_PID (before CLI)
  Stage 2: Enter CLI mode (via exportCLIDiff)
  Stage 3: CLI "set" commands for each filter recommendation
  Stage 4: CLI "save" → FC reboots
  → Progress events → renderer progress bar
  → TuningSessionManager.updatePhase() → advance to next phase
```

### 4. Snapshot Restore Flow

```
User clicks Restore → confirmation dialog → useSnapshots.restoreSnapshot()
  → window.betaflight.restoreSnapshot(id, createBackup) → IPC handler:
  Stage 1: Create "Pre-restore (auto)" backup snapshot
  Stage 2: Parse cliDiff → extract restorable commands → enterCLI → send each
  Stage 3: CLI "save" → FC reboots
  → Progress events → renderer progress bar
```

---

## Error Handling

```
Hardware error (FC timeout, USB disconnect)
  → MSPConnection throws ConnectionError / TimeoutError
  → MSPClient catches, logs, re-throws with context
  → IPC handler catches → returns { success: false, error: message }
  → Preload API throws Error
  → React hook catches → sets error state / shows toast
  → UI displays error to user
```

**Error types:** `ConnectionError`, `MSPError`, `TimeoutError`, `SnapshotError`

**Recovery patterns:**
- Connection retry: 2 attempts with `forceExitCLI()` reset between
- 3s cooldown after disconnect prevents port-in-use errors
- Corrupt BBL frames: rewind + byte-by-byte resync (no data loss)
- Analysis fallback: if no hover segments found, use entire flight

---

## Shared Types (`src/shared/types/`, 10 files)

| File | Key Types |
|------|-----------|
| `common.types.ts` | `FCInfo` (includes `pidProfileIndex`, `pidProfileCount`), `ConnectionStatus`, `PortInfo`, `ConfigurationSnapshot`, `SnapshotMetadata` |
| `profile.types.ts` | `DroneProfile`, `DroneProfileMetadata`, `ProfileCreationInput`, `DroneSize`, `BatteryType`, `FlightStyle` |
| `pid.types.ts` | `PIDTerm { P, I, D }`, `PIDFTerm extends PIDTerm { F }`, `PIDConfiguration`, `FeedforwardConfiguration` |
| `blackbox.types.ts` | `BlackboxInfo`, `BlackboxParseResult`, `BlackboxFlightData`, `BBLLogHeader`, `BBLEncoding`, `BBLPredictor` |
| `analysis.types.ts` | `PowerSpectrum`, `NoiseProfile`, `FilterRecommendation`, `StepResponse` (with `ffDominated`), `StepResponseTrace`, `PIDRecommendation`, `AxisStepMetrics`, `CurrentFilterSettings`, `FeedforwardContext` |
| `tuning.types.ts` | `TuningPhase` (14 values), `TuningType` (`'filter' | 'pid' | 'flash'`), `TuningSession`, `TuningMode`, `AppliedChange` |
| `tuning-history.types.ts` | `CompactSpectrum`, `CompactThrottleSpectrogram`, `CompactThrottleBand`, `FilterMetricsSummary`, `PIDMetricsSummary`, `CompletedTuningRecord`, `RecommendationTrace`, `VerificationDelta` |
| `ipc.types.ts` | `ApplyRecommendationsInput/Progress/Result`, `SnapshotRestoreProgress/Result`, `BetaflightAPI` (complete API interface) |
| `telemetry.types.ts` | `TelemetrySettings`, `TelemetryBundle`, `TelemetryBundleV2`, `TelemetrySessionRecord` |
| `toast.types.ts` | `ToastType`, `Toast` |

## Shared Utilities (`src/shared/utils/`)

| File | Key Exports |
|------|-------------|
| `metricsExtract.ts` | `downsampleSpectrum()`, `downsampleStepResponse()`, `extractFilterMetrics()`, `extractPIDMetrics()`, `extractThrottleSpectrogram()` — compact metrics for history storage |

---

## Testing Strategy

**3243 unit tests across 147 files (3220 passing + 23 skipped fixture-gated) + 37 Playwright E2E tests**. See [TESTING.md](./TESTING.md) for complete inventory.

| Area | Files | Tests |
|------|-------|-------|
| Blackbox Parser | 9 | 245 |
| FFT Analysis (+ Data Quality + Spectrogram + Delay + Throttle Utils) | 9 | 313 |
| Step Response + PID + TF + CrossAxis + PropWash + DTerm + Bayesian + Verification + Golden Outputs | 21 | 758 |
| Header Validation + Constants + Main Utils | 3 | 82 |
| MSP Protocol & Client | 4 | 196 |
| MSC (Mass Storage) | 2 | 45 |
| Storage Managers | 7 | 123 |
| IPC Handlers | 4 | 152 |
| FC State Cache | 1 | 17 |
| Telemetry | 2 | 38 |
| Diagnostic | 1 | 12 |
| License | 1 | 12 |
| Auto-Updater | 1 | 12 |
| UI Components + Charts + Contexts | 56 | 829 |
| React Hooks + Utils | 18 | 197 |
| Shared Constants & Utils | 5 | 102 |
| E2E Workflows (Vitest) | 1 | 31 |
| Demo Mode (Vitest) | 2 | 79 |
| **Playwright E2E** | **7** | **37** |

**Pre-commit hook** (husky + lint-staged) blocks commits when tests fail. All async UI tests use `waitFor()`. Mock layer: `src/renderer/test/setup.ts` mocks entire `window.betaflight` API.

**Playwright E2E** (demo mode): Launches real Electron app with mock FC, clicks through full tuning workflow (Filter Tune, PID Tune, Flash Tune, and diagnostic reports). Run via `npm run test:e2e` (32 tests in normal runs) or `npm run demo:generate-history` (generators, session count via `GENERATE_COUNT` env var). 37 tests across 7 spec files. See `e2e/` directory and [docs/complete/OFFLINE_UX_TESTING.md](./docs/complete/OFFLINE_UX_TESTING.md).
