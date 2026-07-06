import { app, BrowserWindow } from 'electron';
import { join, resolve } from 'path';
import { createWindow, getMainWindow } from './window';
import { MSPClient } from './msp/MSPClient';
import { SnapshotManager } from './storage/SnapshotManager';
import { ProfileManager } from './storage/ProfileManager';
import { BlackboxManager } from './storage/BlackboxManager';
import { TuningSessionManager } from './storage/TuningSessionManager';
import { TuningHistoryManager } from './storage/TuningHistoryManager';
import {
  registerIPCHandlers,
  setMSPClient,
  setSnapshotManager,
  setProfileManager,
  setBlackboxManager,
  setTuningSessionManager,
  setTuningHistoryManager,
  setTelemetryManager,
  setLicenseManager,
  setEventCollector,
  setFCStateCache,
  setDemoMode,
  sendConnectionChanged,
  sendProfileChanged,
  sendNewFCDetected,
  sendTuningSessionChanged,
  sendFCStateChanged,
  consumePendingSettingsSnapshot,
} from './ipc/handlers';
import { FCStateCache } from './cache/FCStateCache';
import { parseProfileNamesFromDiff } from './ipc/handlers/types';
import { TelemetryManager } from './telemetry/TelemetryManager';
import { TelemetryEventCollector } from './telemetry/TelemetryEventCollector';
import { LicenseManager } from './license/LicenseManager';
import { initAutoUpdater } from './updater';
import { logger } from './utils/logger';
import { verifyAppliedConfig } from './utils/verifyAppliedConfig';
import { SNAPSHOT, PROFILE, TUNING_PHASE, TUNING_TYPE_LABELS } from '@shared/constants';
import { MockMSPClient, DEMO_FC_SERIAL } from './demo/MockMSPClient';
import { generateFilterDemoBBL } from './demo/DemoDataGenerator';
import {
  startDebugServer,
  setDebugDependencies,
  captureRendererConsole,
} from './debug/DebugServer';

/** Whether the app is running in demo mode (DEMO_MODE env var or --demo flag) */
const isDemoMode = process.env.DEMO_MODE === 'true' || process.argv.includes('--demo');

// Allow overriding userData path (used by E2E tests and dev:demo for isolation)
if (process.env.E2E_USER_DATA_DIR) {
  app.setPath('userData', resolve(process.env.E2E_USER_DATA_DIR));
}

let mspClient: MSPClient | MockMSPClient;
let snapshotManager: SnapshotManager;
let profileManager: ProfileManager;
let blackboxManager: BlackboxManager;
let tuningSessionManager: TuningSessionManager;
let tuningHistoryManager: TuningHistoryManager;
let telemetryManager: TelemetryManager;
let eventCollector: TelemetryEventCollector;
let licenseManager: LicenseManager;
let fcStateCache: FCStateCache;

async function initialize(): Promise<void> {
  // Create MSP client (real or mock depending on demo mode)
  if (isDemoMode) {
    logger.info('=== DEMO MODE ACTIVE ===');
    const mockClient = new MockMSPClient();
    // Pre-generate demo BBL data for standalone analysis (outside tuning session)
    const demoBBL = generateFilterDemoBBL();
    mockClient.setDemoBBLData(demoBBL);
    // Flash starts with data (simulated previous flight) so "Erase Flash" button is visible
    // Without this, flashUsedSize===0 triggers showErasedState immediately in TuningStatusBanner
    mockClient.setFlashHasData(true);
    mspClient = mockClient;
  } else {
    mspClient = new MSPClient();
  }

  // Create profile manager
  const profileStoragePath = join(app.getPath('userData'), PROFILE.STORAGE_DIR);
  profileManager = new ProfileManager(profileStoragePath);
  await profileManager.initialize();

  // Create snapshot manager
  const snapshotStoragePath = join(app.getPath('userData'), SNAPSHOT.STORAGE_DIR);
  // Cast needed: in demo mode, MockMSPClient implements the same interface
  // that SnapshotManager uses (getFCInfo, exportCLIDiff, isConnected)
  snapshotManager = new SnapshotManager(snapshotStoragePath, mspClient as any);
  await snapshotManager.initialize();

  // Link profile manager to snapshot manager
  snapshotManager.setProfileManager(profileManager);

  // Create Blackbox manager
  try {
    logger.info('Initializing BlackboxManager...');
    blackboxManager = new BlackboxManager();
    await blackboxManager.initialize();
    logger.info('BlackboxManager initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize BlackboxManager:', error);
    throw error;
  }

  // Create Tuning Session manager
  const tuningStoragePath = join(app.getPath('userData'), 'data');
  tuningSessionManager = new TuningSessionManager(tuningStoragePath);
  await tuningSessionManager.initialize();

  // Create Tuning History manager
  const dataPath = join(app.getPath('userData'), 'data');
  tuningHistoryManager = new TuningHistoryManager(dataPath);
  await tuningHistoryManager.initialize();

  // Create Telemetry event collector
  const eventCollectorPath = join(app.getPath('userData'), 'data/telemetry-events.json');
  eventCollector = new TelemetryEventCollector(eventCollectorPath);
  await eventCollector.load();

  // Create Telemetry manager
  telemetryManager = new TelemetryManager(app.getPath('userData'));
  telemetryManager.setProfileManager(profileManager);
  telemetryManager.setTuningHistoryManager(tuningHistoryManager);
  telemetryManager.setBlackboxManager(blackboxManager);
  telemetryManager.setSnapshotManager(snapshotManager);
  telemetryManager.setEventCollector(eventCollector);
  telemetryManager.setDemoMode(isDemoMode);
  await telemetryManager.initialize();

  // Create License manager
  licenseManager = new LicenseManager(app.getPath('userData'));
  licenseManager.setDemoMode(isDemoMode);
  licenseManager.setInstallationIdProvider(() => telemetryManager.getSettings().installationId);
  await licenseManager.initialize();

  // Create FC state cache
  fcStateCache = new FCStateCache(mspClient);
  fcStateCache.setDependencies(snapshotManager, profileManager);
  snapshotManager.setFCStateCache(fcStateCache);

  // Set up IPC handlers
  setMSPClient(mspClient);
  setSnapshotManager(snapshotManager);
  setProfileManager(profileManager);
  setBlackboxManager(blackboxManager);
  setTuningSessionManager(tuningSessionManager);
  setTuningHistoryManager(tuningHistoryManager);
  setTelemetryManager(telemetryManager);
  setEventCollector(eventCollector);
  setLicenseManager(licenseManager);
  setFCStateCache(fcStateCache);
  setDemoMode(isDemoMode);
  registerIPCHandlers();

  // Start debug HTTP server if enabled (dev only)
  if (process.env.DEBUG_SERVER === 'true') {
    setDebugDependencies({
      mspClient,
      profileManager,
      snapshotManager,
      tuningSessionManager,
      blackboxManager,
      tuningHistoryManager,
      isDemoMode,
    });
    const port = parseInt(process.env.DEBUG_SERVER_PORT || '9300', 10);
    startDebugServer(port);
  }

  // Forward FC state cache changes to the renderer
  fcStateCache.on('state-changed', (state) => {
    const window = getMainWindow();
    if (window) {
      sendFCStateChanged(window, state);
    }
  });

  // Listen for connection changes.
  // For connect events: suppress the initial emit from MSPClient.connect() —
  // the 'connected' handler below sends a final re-emit after baseline creation
  // and smart reconnect are complete. Without this, the renderer calls
  // refreshBlackboxInfo() during CLI mode (baseline export) which timeouts.
  let suppressConnectEvent = false;
  mspClient.on('connection-changed', (status) => {
    if (status.connected && suppressConnectEvent) {
      return; // Will be re-emitted by 'connected' handler after all init is done
    }
    const window = getMainWindow();
    if (window) {
      sendConnectionChanged(window, status);
    }
    // Track unexpected disconnects during active tuning
    if (!status.connected && eventCollector) {
      eventCollector.emit('error', 'msp_disconnect');
    }
  });

  // Auto-detect profile and create baseline on connection
  mspClient.on('connected', async () => {
    suppressConnectEvent = true;
    try {
      // Get FC serial number and info (from connectionStatus which includes PID profile data)
      const fcSerial = await mspClient.getFCSerialNumber();
      const fcInfo = mspClient.getConnectionStatus().fcInfo!;
      logger.info(`Connected to FC with serial: ${fcSerial}`);

      // Find or prompt for profile
      const existingProfile = await profileManager.findProfileBySerial(fcSerial);

      const window = getMainWindow();
      if (existingProfile) {
        // Known drone - set as current profile
        const profile = await profileManager.setCurrentProfile(existingProfile.id);
        logger.info(`Profile loaded: ${existingProfile.name}`);

        // Notify UI of profile change
        if (window) {
          sendProfileChanged(window, profile);
        }

        // Create baseline ONLY for existing profiles
        // For new FCs, baseline will be created after profile is created
        logger.info('Creating baseline for existing profile...');
        await snapshotManager.createBaselineIfMissing();

        // Extract PID profile names from baseline CLI diff (scan newest→oldest)
        try {
          const snapshotIds = existingProfile.snapshotIds ?? [];
          for (let i = snapshotIds.length - 1; i >= 0; i--) {
            const snap = await snapshotManager.loadSnapshot(snapshotIds[i]);
            if (snap?.configuration?.cliDiff) {
              const profileNames = parseProfileNamesFromDiff(snap.configuration.cliDiff);
              if (Object.keys(profileNames).length > 0) {
                // Update app profile with FC-sourced profile names (don't overwrite user labels)
                const existingLabels = existingProfile.bfPidProfileLabels ?? {};
                const merged = { ...profileNames, ...existingLabels };
                await profileManager.updateProfile(existingProfile.id, {
                  bfPidProfileLabels: merged,
                });
                logger.info('Extracted PID profile names from CLI diff:', profileNames);
                break;
              }
              // Has diff but no profile names — continue searching older snapshots
            }
          }
        } catch (err) {
          logger.warn('Failed to extract PID profile names (non-fatal):', err);
        }

        // After a settings fix/reset, the FC reboots and reconnects.
        // Create a clean snapshot now (MSP + CLI available, no mode conflicts).
        if (consumePendingSettingsSnapshot()) {
          try {
            logger.info('Creating post-settings-change snapshot...');
            await snapshotManager.createSnapshot('Post-settings-change (auto)', 'auto');
            logger.info('Post-settings-change snapshot created');
          } catch (err) {
            logger.warn('Failed to create post-settings-change snapshot (non-fatal):', err);
          }
        }

        // Clear MSC mode flag if it was set (FC reconnected after MSC cycle)
        if (mspClient.mscModeActive) {
          logger.info('FC reconnected after MSC mode — clearing MSC flag');
          mspClient.clearMSCMode();
        }

        // When rebootPending is set, this is a reconnect after saveAndReboot()
        // (e.g. apply tuning). saveAndReboot() now handles reconnect internally,
        // and the apply IPC handler handles verify+snapshot. Skip those here.
        const isRebootReconnect = mspClient.rebootPending;
        if (isRebootReconnect) {
          logger.info('FC reconnected after save reboot — apply handler owns verify+snapshot');
          mspClient.clearRebootPending();
        }

        // Smart reconnect: check tuning session state
        try {
          const session = await tuningSessionManager.getSession(existingProfile.id);
          logger.info(
            `Smart reconnect: session=${session ? session.phase : 'null'}, profile=${existingProfile.id}`
          );
          if (session) {
            // Restore BF PID profile if session has one specified
            if (session.bfPidProfileIndex !== undefined) {
              try {
                await mspClient.selectPidProfile(session.bfPidProfileIndex);
                logger.info(`Reconnect: restored BF PID profile ${session.bfPidProfileIndex}`);
              } catch (e) {
                logger.warn('Reconnect: failed to restore BF PID profile (non-fatal):', e);
              }
            } else {
              // Session missing PID profile index — backfill from FC's current state
              try {
                const statusEx = await mspClient.getStatusEx(fcInfo.apiVersion);
                await tuningSessionManager.updatePhase(existingProfile.id, session.phase, {
                  bfPidProfileIndex: statusEx.pidProfileIndex,
                });
                logger.info(
                  `Reconnect: backfilled bfPidProfileIndex=${statusEx.pidProfileIndex} on session`
                );
              } catch (e) {
                logger.warn('Reconnect: failed to backfill PID profile index (non-fatal):', e);
              }
            }

            // Auto-transition from *_flight_pending → *_log_ready if flash has data
            if (
              session.phase === TUNING_PHASE.FILTER_FLIGHT_PENDING ||
              session.phase === TUNING_PHASE.PID_FLIGHT_PENDING ||
              session.phase === TUNING_PHASE.FLASH_FLIGHT_PENDING
            ) {
              // BB info may return storageType='none' immediately after reconnect
              // (dataflash subsystem not ready). Retry once after 2s settle delay.
              let bbInfo = await mspClient.getBlackboxInfo();
              if (bbInfo.storageType === 'none') {
                logger.info('Smart reconnect: BB returned none, retrying after 2s settle...');
                await new Promise((resolve) => setTimeout(resolve, 2000));
                bbInfo = await mspClient.getBlackboxInfo();
              }
              logger.info(
                `Smart reconnect: BB check — storage=${bbInfo.storageType}, hasLogs=${bbInfo.hasLogs}, usedSize=${bbInfo.usedSize}`
              );

              // For flash: usedSize > 0 means logs exist
              // For SD card: usedSize is always > 0 (filesystem overhead),
              // so we skip auto-transition for SD card — user confirms via UI
              if (bbInfo.storageType === 'flash' && bbInfo.hasLogs && bbInfo.usedSize > 0) {
                const nextPhase =
                  session.phase === TUNING_PHASE.FLASH_FLIGHT_PENDING
                    ? TUNING_PHASE.FLASH_LOG_READY
                    : session.phase === TUNING_PHASE.FILTER_FLIGHT_PENDING
                      ? TUNING_PHASE.FILTER_LOG_READY
                      : TUNING_PHASE.PID_LOG_READY;
                logger.info(
                  `Smart reconnect: flash has data, transitioning ${session.phase} → ${nextPhase}`
                );
                const updated = await tuningSessionManager.updatePhase(
                  existingProfile.id,
                  nextPhase,
                  { eraseCompleted: undefined }
                );
                sendTuningSessionChanged(updated);
              } else if (bbInfo.storageType === 'sdcard' && session.eraseSkipped) {
                // User skipped erase — treat reconnect as "flew and came back"
                const nextPhase =
                  session.phase === TUNING_PHASE.FLASH_FLIGHT_PENDING
                    ? TUNING_PHASE.FLASH_LOG_READY
                    : session.phase === TUNING_PHASE.FILTER_FLIGHT_PENDING
                      ? TUNING_PHASE.FILTER_LOG_READY
                      : TUNING_PHASE.PID_LOG_READY;
                logger.info(
                  `Smart reconnect: SD card + eraseSkipped, transitioning ${session.phase} → ${nextPhase}`
                );
                const updated = await tuningSessionManager.updatePhase(
                  existingProfile.id,
                  nextPhase,
                  { eraseSkipped: undefined }
                );
                sendTuningSessionChanged(updated);
              } else if (bbInfo.storageType === 'sdcard' && session.eraseCompleted) {
                // User explicitly erased via MSC mode — don't auto-transition
                // (they haven't flown yet), but the session already has eraseCompleted=true
                // so the UI banner will show the post-erase flight guide.
                logger.info(
                  'Smart reconnect: SD card + eraseCompleted — keeping phase (post-erase UI will show)'
                );
              } else if (bbInfo.storageType === 'sdcard') {
                logger.info(
                  'Smart reconnect: SD card detected — skipping auto-transition (user must confirm)'
                );
              }
            }

            // Smart reconnect for verification phases: if flash has data after erase,
            // user has flown — clear eraseCompleted so UI shows Download button
            const isVerificationPhase =
              session.phase === TUNING_PHASE.FILTER_VERIFICATION_PENDING ||
              session.phase === TUNING_PHASE.PID_VERIFICATION_PENDING ||
              session.phase === TUNING_PHASE.FLASH_VERIFICATION_PENDING;
            if (isVerificationPhase && session.eraseCompleted) {
              let bbInfo = await mspClient.getBlackboxInfo();
              if (bbInfo.storageType === 'none') {
                logger.info(
                  'Smart reconnect (verification): BB returned none, retrying after 2s...'
                );
                await new Promise((resolve) => setTimeout(resolve, 2000));
                bbInfo = await mspClient.getBlackboxInfo();
              }
              if (bbInfo.storageType === 'flash' && bbInfo.hasLogs && bbInfo.usedSize > 0) {
                logger.info(
                  `Smart reconnect: ${session.phase} + flash has data — clearing eraseCompleted`
                );
                const updated = await tuningSessionManager.updatePhase(
                  existingProfile.id,
                  session.phase,
                  { eraseCompleted: undefined }
                );
                sendTuningSessionChanged(updated);
              }
            }

            // Post-apply verification + snapshot: skip if this is a reboot reconnect
            // (apply handler handles these inline after saveAndReboot returns).
            // Only run here as fallback for manual reconnects (e.g. user unplugged/replugged).
            if (!isRebootReconnect) {
              // Post-apply read-back verification
              const isAppliedOrVerification =
                session.phase === TUNING_PHASE.FILTER_APPLIED ||
                session.phase === TUNING_PHASE.PID_APPLIED ||
                session.phase === TUNING_PHASE.FLASH_APPLIED ||
                session.phase === TUNING_PHASE.FILTER_VERIFICATION_PENDING ||
                session.phase === TUNING_PHASE.PID_VERIFICATION_PENDING ||
                session.phase === TUNING_PHASE.FLASH_VERIFICATION_PENDING;
              if (isAppliedOrVerification && session.applyVerified === undefined) {
                try {
                  const verifyResult = await verifyAppliedConfig(
                    mspClient,
                    session.tuningType,
                    session.appliedPIDChanges,
                    session.appliedFilterChanges,
                    session.appliedFeedforwardChanges
                  );
                  const verifiedSession = await tuningSessionManager.updatePhase(
                    existingProfile.id,
                    session.phase,
                    {
                      applyVerified: verifyResult.verified,
                      applyMismatches:
                        verifyResult.mismatches.length > 0 ? verifyResult.mismatches : undefined,
                      applyExpected: verifyResult.expected,
                      applyActual: verifyResult.actual,
                      applySuspicious: verifyResult.suspicious || undefined,
                    }
                  );
                  sendTuningSessionChanged(verifiedSession);
                  if (verifyResult.verified) {
                    logger.info('Post-apply verification: all settings match FC');
                  } else {
                    logger.warn(
                      `Post-apply verification: ${verifyResult.mismatches.length} mismatches`,
                      verifyResult.mismatches
                    );
                  }
                } catch (verifyErr) {
                  logger.warn('Post-apply verification failed (non-fatal):', verifyErr);
                }
              }

              // Create post-tuning snapshot on reconnect (fallback for manual reconnects)
              if (!session.postTuningSnapshotId && isAppliedOrVerification) {
                try {
                  let sessionNumber = 1;
                  const history = await tuningHistoryManager.getHistory(existingProfile.id);
                  sessionNumber = history.length + 1;
                  const tuningType = session.tuningType as keyof typeof TUNING_TYPE_LABELS;
                  const label = `Post-tuning #${sessionNumber} (${TUNING_TYPE_LABELS[tuningType]})`;
                  const snapshot = await snapshotManager.createSnapshot(label, 'auto', {
                    tuningSessionNumber: sessionNumber,
                    tuningType,
                    snapshotRole: 'post-tuning',
                  });
                  const updatedWithSnapshot = await tuningSessionManager.updatePhase(
                    existingProfile.id,
                    session.phase,
                    { postTuningSnapshotId: snapshot.id }
                  );
                  sendTuningSessionChanged(updatedWithSnapshot);
                  logger.info(`Post-tuning snapshot created on reconnect: ${snapshot.id}`);
                } catch (snapErr) {
                  logger.warn(
                    'Could not create post-tuning snapshot on reconnect (non-fatal):',
                    snapErr
                  );
                }
              }
            }
          }
        } catch (err) {
          logger.warn('Smart reconnect check failed (non-fatal):', err);
        }

        // Hydrate FC state cache — reads all MSP config and pushes to renderer
        // via 'state-changed' event. Replaces individual MSP reads and the
        // final connection re-emit (cache push gives renderer fresh state).
        try {
          await fcStateCache.hydrate();
        } catch (e) {
          logger.warn('Post-connect cache hydrate failed (non-fatal):', e);
        }

        // Final re-emit: ensure renderer has current connection + BB state.
        // Initial onConnectionChanged fires during MSPClient.connect() before
        // baseline creation and smart reconnect — BB info may be stale by then.
        suppressConnectEvent = false;
        if (mspClient.isConnected() && window) {
          sendConnectionChanged(window, { connected: true, fcInfo });
        }
      } else {
        // New drone - notify UI to show ProfileWizard modal
        // DO NOT create baseline yet - wait until profile is created
        logger.info('New FC detected - profile creation needed (baseline will be created later)');
        suppressConnectEvent = false;
        if (window) {
          sendConnectionChanged(window, { connected: true, fcInfo });
          logger.info(`Sending new FC detected event: ${fcSerial}`);
          sendNewFCDetected(window, fcSerial, fcInfo);
        } else {
          logger.error('Window is null, cannot send new FC detected event');
        }
      }
    } catch (error) {
      logger.error('Failed to handle connection:', error);
    } finally {
      suppressConnectEvent = false;
    }
  });

  // Handle unexpected disconnection (USB unplugged, etc.)
  mspClient.on('disconnected', () => {
    fcStateCache.clear();
    const window = getMainWindow();

    // If FC is in MSC mode or rebooting after save, this disconnect is expected — don't clear profile
    if (mspClient.mscModeActive || mspClient.rebootPending) {
      logger.info(
        `FC disconnected (${mspClient.mscModeActive ? 'MSC mode' : 'reboot pending'} — expected, keeping profile)`
      );
      // Still notify renderer that FC is disconnected (UI needs to reflect this)
      if (window) {
        sendConnectionChanged(window, { connected: false });
      }
      return;
    }

    logger.info('FC unexpectedly disconnected');

    // Clear current profile
    profileManager.clearCurrentProfile();

    // Notify renderer
    if (window) {
      // Send disconnected status
      sendConnectionChanged(window, { connected: false });
      // Clear profile in UI
      sendProfileChanged(window, null);
    }
  });

  // In demo mode, pre-create demo profile so ProfileWizard is skipped on connect
  if (isDemoMode) {
    await ensureDemoProfile();
  }

  logger.info('Application initialized');
}

/**
 * Create the demo profile if it doesn't already exist.
 * This ensures the 'connected' event handler finds an existing profile
 * and skips the ProfileWizard modal entirely.
 */
async function ensureDemoProfile(): Promise<void> {
  const existing = await profileManager.findProfileBySerial(DEMO_FC_SERIAL);
  if (existing) {
    logger.info(`[DEMO] Demo profile already exists: ${existing.name} (${existing.id})`);
    return;
  }

  logger.info('[DEMO] Creating demo profile...');
  await profileManager.createProfile({
    fcSerialNumber: DEMO_FC_SERIAL,
    fcInfo: {
      variant: 'BTFL',
      version: '4.5.1',
      target: 'STM32F405',
      boardName: 'OMNIBUSF4SD',
      apiVersion: { protocol: 0, major: 1, minor: 46 },
    },
    name: 'Demo Quad (5" Freestyle)',
    size: '5"',
    battery: '4S',
    propSize: '5.1"',
    weight: 650,
    motorKV: 2400,
    flightStyle: 'balanced',
    notes: 'Auto-created demo profile for offline UX testing',
  });
  logger.info('[DEMO] Demo profile created');
}

app.whenReady().then(async () => {
  await initialize();
  createWindow();

  // Start capturing renderer console for debug server
  if (process.env.DEBUG_SERVER === 'true') {
    captureRendererConsole();
  }

  // Initialize auto-updater (packaged builds only, not demo)
  if (!isDemoMode) {
    initAutoUpdater();
  }

  // In demo mode, auto-connect after window is ready
  if (isDemoMode && mspClient instanceof MockMSPClient) {
    setTimeout(() => {
      logger.info('[DEMO] Auto-connecting demo FC...');
      (mspClient as MockMSPClient).simulateConnect();
    }, 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  // Cleanup
  if (mspClient?.isConnected()) {
    await mspClient.disconnect();
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Track uncaught exceptions (privacy-safe: message only, no stacktrace)
process.on('uncaughtException', (error) => {
  if (eventCollector) {
    eventCollector.emit('error', 'uncaught', { message: error.message });
    eventCollector.persist().catch(() => {});
  }
  logger.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  if (eventCollector) {
    const message = reason instanceof Error ? reason.message : String(reason);
    eventCollector.emit('error', 'uncaught', { message });
    eventCollector.persist().catch(() => {});
  }
  logger.error('Unhandled rejection:', reason);
});

app.on('before-quit', async () => {
  // Persist any pending telemetry events before quitting
  if (eventCollector) {
    await eventCollector.persist().catch(() => {});
  }
  if (mspClient?.isConnected()) {
    await mspClient.disconnect();
  }
});
