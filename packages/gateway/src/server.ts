import { AudioVerificationStore } from './ai/audio-verification-store.js';
import http from 'node:http';
import path from 'node:path';
import express, { Express } from 'express';
import cors from 'cors';
import { Database as DatabaseType } from 'better-sqlite3';
import {
  GatewayConfigInput,
  IAudioAdapter,
  ICallSessionManager,
  IModemAdapter,
} from '@sim-gateway/shared';

import { createDatabaseConnection } from './db/connection.js';
import { runMigrations, SCHEMA_VERSION } from './db/migrations.js';
import { GatewayRepository } from './db/repository.js';
import { GatewayEventBus } from './core/event-bus.js';
import { CallSessionManager } from './core/call-session-manager.js';
import { MockModemAdapter } from './adapters/modem/mock-modem.js';
import { Sim7600HardwareAdapter } from './adapters/modem/hardware-modem.js';
import { MockAudioAdapter } from './adapters/audio/mock-audio.js';
import { Sim7600HardwareAudioAdapter } from './adapters/audio/hardware-audio.js';
import { createAuthMiddleware, verifyApiKey } from './api/middleware/auth.js';
import { isLoopbackAddress, SessionTokens } from './api/middleware/session-tokens.js';
import { AuthFailureLimiter, limitAuthFailures, securityHeaders } from './api/middleware/security.js';
import { createOpsRouter } from './api/routes/ops.js';
import { RotatingFileLog } from './core/log-file.js';
import { AlertStore } from './ops/alerts.js';
import { applyPendingRestore, BackupService } from './ops/backup.js';
import { CallDiagnosticsStore, recordCallEnd } from './ops/call-diagnostics.js';
import { backgroundCheck, databaseCheck, gatewayCheck, HealthMonitor, modemCheck, networkCheck, providersCheck, storageCheck } from './ops/health.js';
import { NetworkDiagnostics } from './ops/network.js';
import { buildSupportBundle, safeConfig } from './ops/support-bundle.js';
import { API_VERSION, appVersion } from './ops/version.js';
import { errorHandler } from './api/middleware/error-handler.js';
import { createGatewayRouter } from './api/routes/gateway.js';
import { createCallsRouter } from './api/routes/calls.js';
import { createMockRouter } from './api/routes/mock.js';
import { GatewaySocketServer } from './api/socket/socket-server.js';
import { isAutoPort, loadConfig } from './config/index.js';
import { PortDiscovery, PortLister } from './hardware/port-discovery.js';
import { SerialPort } from 'serialport';
import { createLogger, redactDiagnosticText, setLogSink } from './core/logger.js';
import { UsbPcmVerifier } from './diagnostics/usb-pcm-verification.js';
import { InboundCaptureTap } from './diagnostics/inbound-capture.js';
import { acquireInstanceLock, InstanceLock } from './core/instance-lock.js';
import { createAiRouter } from './api/routes/ai.js';
import { AiCallOrchestrator } from './ai/orchestrator.js';
import { AiRuntime } from './ai/runtime.js';
import { CallRecorder } from './recording/call-recorder.js';
import { RecordingSettingsService, RecordingSkipStore } from './recording/recording-settings.js';
import { SmsInbox } from './sms/sms-inbox.js';
import { SmsService } from './sms/sms-service.js';
import { SmsStore } from './sms/sms-store.js';
import { loadRecordingConfig, RecordingConfig } from './recording/config.js';
import { AiSettingsService } from './ai/settings.js';
import { AiUsageStore } from './ai/usage-store.js';
import { ObservabilityStore } from './ai/observability-store.js';
import { setProviderAttemptSink } from './ai/obs-context.js';
import { createObservabilityRouter } from './api/routes/observability.js';
import { createCampaignsRouter } from './api/routes/campaigns.js';
import { CallContextRegistry } from './campaigns/call-context.js';
import { managerDialer } from './campaigns/dialer.js';
import { CallAnalysisStore } from './campaigns/call-analysis.js';
import { CallAnalysisService, CampaignCallRecords } from './campaigns/call-records.js';
import { CampaignRunner } from './campaigns/runner.js';
import { recordSpokenOptOut } from './campaigns/spoken-opt-out.js';
import { createIntegrationsRouter } from './api/routes/integrations.js';
import { createRegistryRouter } from './api/routes/registry.js';
import { PricingStore } from './ai/registry/pricing-store.js';
import { PricingUpdater } from './ai/registry/pricing-updater.js';
import { ModelRegistryService } from './ai/registry/service.js';
import { RegistryStore } from './ai/registry/store.js';
import { SheetsService } from './integrations/google-sheets/service.js';
import { SheetsConfigStore } from './integrations/google-sheets/store.js';
import { callRestriction, createToolRegistry, outcomeRecorder } from './integrations/google-sheets/wiring.js';
import { CampaignStore } from './campaigns/store.js';
import { IvrAssetStore } from './ivr/assets.js';
import { IvrStore } from './ivr/store.js';
import { IvrCallOwnership } from './ivr/ownership.js';
import type { IvrController } from './ivr/controller.js';
import { createIvrController } from './ivr/wiring.js';
import { createIvrRouter } from './api/routes/ivr.js';
import { TtsGenerator } from './ivr/tts-generate.js';
import { FetchLike, ProviderSet } from './ai/providers/index.js';
import { AgentAudioSink, AudioFormat, CallerAudioSource } from './ai/audio.js';

export interface GatewayServerOptions {
  config?: Partial<GatewayConfigInput>;
  modem?: IModemAdapter;
  audio?: IAudioAdapter;
  db?: DatabaseType;
  repository?: GatewayRepository;
  callManager?: ICallSessionManager;
  eventBus?: GatewayEventBus;
  /** Directory for serial-port ownership locks (hardware mode). Defaults to the OS temp dir. */
  instanceLockDir?: string;
  /** Test seam: the local session-token store (a short lifetime or a controlled clock). */
  sessionTokens?: SessionTokens;
  /** Test seam for automatic port discovery: what Windows reports about its serial ports. Production uses SerialPort.list(). */
  listSerialPorts?: PortLister;
  /** Test seam: how often the gateway looks for a modem that came back after the adapter gave up (default 15 s). */
  modemWatchMs?: number;
  /** Complete-call recording overrides (tests). Production reads CALL_RECORDING_* from the environment. */
  recording?: Partial<RecordingConfig>;
  /** Where the IVR's audio files live. null keeps them in memory. Default: an `ivr` folder beside the database (in memory when a database is injected). */
  ivr?: { dir?: string | null };
  /** AI agent test seams. In production none of these is set: env + real providers + the SIM7600EI audio adapter. */
  ai?: {
    env?: Record<string, string | undefined>;
    providers?: ProviderSet;
    /** Test seam: the providers used for a call whose campaign chose its own language model. */
    providersForLlm?: (llmKey: string) => ProviderSet;
    fetchImpl?: FetchLike;
    /** Test seam: let a mock modem/audio satisfy the AI hardware check. Never set in production. */
    allowSimulatedHardware?: boolean;
    /** Test seams for timing of the hands-free workflow. Never set in production. */
    hardwarePortLister?: () => Promise<import('./api/routes/hardware.js').RawPortInfo[]>;
    idleWaitsMs?: readonly [number, number, number];
    callLimitMs?: number;
    automationAudioWaitMs?: number;
    automationPollMs?: number;
    automationActivation?: { settleMs?: number; retryMs?: number; attempts?: number };
    /** Test seam: fixed AI runtime mode. Never set in production. */
    mode?: 'off' | 'passive' | 'active';
    /** Where the model registry's JSON files live. null keeps them in memory. Default: beside the database (AI_REGISTRY_DIR overrides). */
    registryDir?: string | null;
    transports?: (
      call: import('@sim-gateway/shared').CallSession,
      format: AudioFormat
    ) => { source: CallerAudioSource; sink: AgentAudioSink };
  };
}

export interface GatewayServerInstance {
  app: Express;
  httpServer: http.Server;
  socketServer: GatewaySocketServer;
  modem: IModemAdapter;
  audio: IAudioAdapter;
  callManager: ICallSessionManager;
  repository: GatewayRepository;
  eventBus: GatewayEventBus;
  aiOrchestrator: AiCallOrchestrator;
  aiRuntime: AiRuntime;
  campaignStore: CampaignStore;
  campaignRunner: CampaignRunner;
  ivrStore: IvrStore;
  ivrAssets: IvrAssetStore;
  ivrOwnership: IvrCallOwnership;
  ivrController: IvrController;
  callRecorder: CallRecorder;
  smsService: SmsService;
  smsInbox: SmsInbox;
  smsStore: SmsStore;
  /** Which serial ports belong to the modem (hardware mode). Lists ports, opens none. */
  portDiscovery: PortDiscovery | null;
  db: DatabaseType;
  config: GatewayConfigInput;
  start: () => Promise<void>;
  close: () => Promise<void>;
}

/** SMS_FALLBACK_POLL_MS: unset = 120000, 0 = off, otherwise at least 60000 (a smaller value is raised to it). */
export function smsFallbackPollMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 120_000;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 120_000;
  if (value === 0) return 0;
  return Math.max(60_000, Math.round(value));
}

export function createGatewayServer(
  options: GatewayServerOptions = {}
): GatewayServerInstance {
  const config = loadConfig(options.config);

  // 0. Customer data lives in one data folder. A restore the customer staged is applied here, BEFORE the database is opened.
  const dataDir = path.dirname(path.resolve(config.sqliteDbPath));
  if (!options.db) applyPendingRestore(config.sqliteDbPath, SCHEMA_VERSION, createLogger('Restore'));
  // Structured log file with rotation (not for tests, which have no data folder of their own).
  const fileLog = options.db || process.env.VITEST ? null : new RotatingFileLog({
    dir: process.env.LOG_DIR?.trim() || path.join(dataDir, 'logs'),
    maxBytes: Math.max(1, Number(process.env.LOG_MAX_MB) || 10) * 1024 * 1024,
    maxFiles: Math.max(1, Number(process.env.LOG_MAX_FILES) || 10),
    retentionDays: Math.max(1, Number(process.env.LOG_RETAIN_DAYS) || 14),
    onError: (m) => console.warn(m),
  });
  if (fileLog) setLogSink((r) => fileLog.write(r));

  // 1. Database & Persistence
  const db =
    options.db ??
    createDatabaseConnection({
      dbPath: config.sqliteDbPath,
      walMode: true,
    });
  runMigrations(db);
  const repository = options.repository ?? new GatewayRepository(db);

  // 2. Hardware / Mock Adapters
  // Ports that are not set explicitly are discovered from the modem's USB identity just before each port is opened.
  const listSerialPorts: PortLister = options.listSerialPorts ?? (() => SerialPort.list() as Promise<Awaited<ReturnType<PortLister>>>);
  const portDiscovery =
    config.modemDriver === 'hardware'
      ? new PortDiscovery(listSerialPorts, {
          explicitAt: isAutoPort(config.atPort) ? null : config.atPort,
          explicitAudio: isAutoPort(config.audioPort) ? null : config.audioPort,
          selector: process.env.MODEM_DEVICE ?? null,
        })
      : null;
  /** The ports in use now: the discovered ones, else what is configured (which may be 'auto' until a modem is found). */
  const currentPorts = (): { at: string; audio: string } => {
    const found = portDiscovery?.ports();
    return { at: found?.at ?? config.atPort, audio: found?.audio ?? config.audioPort };
  };
  const modem =
    options.modem ??
    (config.modemDriver === 'hardware'
      ? new Sim7600HardwareAdapter({
          atPort: config.atPort,
          audioPort: config.audioPort,
          atBaudRate: config.atBaudRate,
          commandTimeoutMs: config.commandTimeoutMs,
          dialTimeoutMs: config.dialTimeoutMs,
          autoReconnect: config.autoReconnect,
          resolvePort: portDiscovery && isAutoPort(config.atPort) ? () => portDiscovery.resolveAt() : undefined,
        })
      : new MockModemAdapter({
          carrierName: 'Vi India',
          firmwareRevision: 'SIM7600M21-A_V1.1',
        }));

  const audio =
    options.audio ??
    (config.modemDriver === 'hardware'
      ? new Sim7600HardwareAudioAdapter({
          audioPort: config.audioPort,
          audioBaudRate: config.audioBaudRate,
          sampleRate: config.audioSampleRate,
          enableDumps: config.enableAudioDumps,
          dumpDir: config.audioDumpDir,
          resolvePort: portDiscovery && isAutoPort(config.audioPort) ? () => portDiscovery.resolveAudio() : undefined,
        })
      : new MockAudioAdapter({ sampleRate: config.audioSampleRate }));

  // 3. Core Event Bus & Call Session Manager
  const eventBus = options.eventBus ?? new GatewayEventBus();
  const logger = createLogger('Server');
  eventBus.on('error', (error) => {
    logger.error(`Gateway error: ${error.message}`, error);
  });
  const callManager =
    options.callManager ??
    new CallSessionManager({
      modem,
      audio,
      eventBus,
      enableUsbAudioDiagnostic: config.enableUsbAudioDiagnostic,
    });

  // AI voice agent: optional and inert unless enabled. Settings saved from the dashboard are layered over
  // .env; a bad AI setting disables the agent and is reported, it never stops the gateway.
  const aiEnv = options.ai?.env ?? process.env;
  const aiSettings = new AiSettingsService(repository, aiEnv);
  const aiUsage = new AiUsageStore(db);
  // Call telemetry. What was said is stored only when AI_OBSERVABILITY_STORE_TEXT=true (off by default).
  const observability = new ObservabilityStore(db, {
    storeText: aiEnv.AI_OBSERVABILITY_STORE_TEXT === 'true',
    onError: (e) => logger.warn(`Call telemetry write failed (dropped): ${e.message}`),
  });
  // Retention applies to trace events only (never calls or the turn log). 0 keeps everything.
  const intEnv = (name: string, fallback: number): number => {
    const raw = aiEnv[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      logger.warn(`${name}="${raw}" is not a whole number of 0 or more; using ${fallback}`);
      return fallback;
    }
    return n;
  };
  const retention = { retentionDays: intEnv('AI_OBSERVABILITY_RETENTION_DAYS', 30), maxEvents: intEnv('AI_OBSERVABILITY_MAX_EVENTS', 1_000_000) };
  const unregisterAttempts = setProviderAttemptSink((a, ctx) => {
    if (!ctx) return; // not part of a call (an operator test, a credential check)
    observability.record({
      callId: ctx.callId,
      turnId: ctx.turnId,
      stage: 'provider-attempt',
      status: a.outcome === 'ok' ? 'ok' : a.outcome === 'cancelled' ? 'cancelled' : 'failed',
      latencyMs: a.durationMs,
      detail: a.detail,
      provider: a.provider,
      httpStatus: a.httpStatus,
      attempt: a.attempt,
      data: { aiStage: a.stage, outcome: a.outcome, willRetry: a.willRetry },
    });
  });
  const usbPcmVerifierRef: { current?: UsbPcmVerifier } = {};
  // Campaigns: per-call context for the AI, a persistent queue, and a sequential runner over the existing call manager.
  const callContexts = new CallContextRegistry();
  const campaignStore = new CampaignStore(db);
  // Google Sheets: the encrypted credential and the settings live in the same settings store as the AI keys (same master key).
  const sheets = new SheetsService({ store: new SheetsConfigStore(repository, aiEnv.AI_SECRETS_MASTER_KEY), fetchImpl: options.ai?.fetchImpl });
  // AI Model Hub: the provider / model / voice / pricing registry. The built-in entries are the original catalog; the operator's
  // entries are six JSON files beside the database. It is loaded before the AI runtime reads its configuration. A damaged file
  // leaves the last valid registry in force (and says so); a change that would break the model in use is refused.
  const registryDir =
    options.ai && 'registryDir' in options.ai
      ? (options.ai.registryDir ?? null)
      : options.db
        ? null
        : aiEnv.AI_REGISTRY_DIR?.trim() || path.join(path.dirname(path.resolve(config.sqliteDbPath)), 'registry');
  const aiRuntimeRef: { current?: AiRuntime } = {};

  // IVR: settings in the same table as the AI settings, audio files in an `ivr` folder beside the database, and call OWNERSHIP (who
  // may attach to an incoming call). Built before the AI runtime because the runtime is told which calls the IVR holds. There is no
  // IVR controller yet, so no handler is registered and no call is ever held: every call behaves exactly as it did without the IVR.
  const ivrDir =
    options.ivr && 'dir' in options.ivr ? (options.ivr.dir ?? null) : options.db ? null : path.join(path.dirname(path.resolve(config.sqliteDbPath)), 'ivr');
  const ivrAssets = new IvrAssetStore({ dir: ivrDir, sampleRate: () => aiRuntimeRef.current?.config.config.audio.format?.sampleRate ?? config.audioSampleRate });
  const ivrStore = new IvrStore({ backend: repository, assets: ivrAssets });
  const ivrOwnership = new IvrCallOwnership({
    store: ivrStore,
    manager: callManager,
    eventBus,
    aiCanAnswer: () => aiRuntimeRef.current?.mode === 'active',
    armAi: (callId) => {
      const runtime = aiRuntimeRef.current;
      return runtime ? runtime.orchestrator.arm(callId) : Promise.reject(new Error('the AI runtime is not running'));
    },
    mark: (callId, event) => void aiRuntimeRef.current?.hub.publish(callId, event),
  });
  const currentSelection = () => {
    const c = aiRuntimeRef.current?.config.config;
    return c ? { llm: c.llm.key, stt: c.stt.key, tts: c.tts.key, voice: c.tts.voice } : null;
  };
  const modelRegistry = new RegistryStore({ dir: registryDir, selection: currentSelection, onChange: () => aiRuntimeRef.current?.reload() });
  const registryLoad = modelRegistry.load();
  if (!registryLoad.ok) {
    for (const issue of registryLoad.issues.slice(0, 10)) logger.error(`Model registry: ${issue.collection}${issue.id ? ` '${issue.id}'` : ''} ${issue.path}: ${issue.message}. The last valid registry stays in force.`);
  }
  // Prices are separate and optional: a damaged pricing file never affects which models can run.
  const pricingStore = new PricingStore({ dir: registryDir });
  const pricingLoad = pricingStore.load();
  if (!pricingLoad.ok) {
    for (const issue of pricingLoad.issues.slice(0, 10)) logger.error(`Pricing: ${issue.path}: ${issue.message}. The last valid prices stay in force.`);
  }
  const aiRuntime = new AiRuntime({
    settings: aiSettings,
    usage: aiUsage,
    observability,
    callContext: (call) => callContexts.forCall(call),
    onOptOut: (call) => void recordSpokenOptOut(campaignStore, callContexts, call),
    tools: { registry: createToolRegistry(sheets), restriction: (call) => callRestriction(campaignStore, callContexts, call) },
    modem,
    audio,
    callManager,
    eventBus,
    recordingsDir: config.audioDumpDir,
    providers: options.ai?.providers,
    providersForLlm: options.ai?.providersForLlm,
    fetchImpl: options.ai?.fetchImpl,
    transports: options.ai?.transports,
    allowSimulatedHardware: options.ai?.allowSimulatedHardware,
    forceMode: options.ai?.mode,
    idleWaitsMs: options.ai?.idleWaitsMs,
    callLimitMs: options.ai?.callLimitMs,
    automationAudioWaitMs: options.ai?.automationAudioWaitMs,
    automationPollMs: options.ai?.automationPollMs,
    automationActivation: options.ai?.automationActivation,
    audioPortBusy: () => usbPcmVerifierRef.current?.isBusy === true,
    ivr: ivrOwnership,
    audioVerificationStore: new AudioVerificationStore(db),
  });
  aiRuntimeRef.current = aiRuntime;
  // The IVR controller runs the menu for calls the IVR owns. Registering it changes nothing while the IVR is switched off (the default):
  // until a configuration is published AND switched on, no call is ever IVR-owned.
  const ivrController = createIvrController({ modem, audio, manager: callManager, eventBus, runtime: () => aiRuntimeRef.current });
  ivrOwnership.registerHandler(ivrController);
  const pricingUpdater = new PricingUpdater({ registry: modelRegistry, pricing: pricingStore, dir: registryDir, fetchImpl: options.ai?.fetchImpl });
  const modelRegistryService = new ModelRegistryService({
    registry: modelRegistry,
    pricing: pricingStore,
    updater: pricingUpdater,
    secret: (name) => aiSettings.resolveSecret(name),
    credentialState: (name) => {
      const source = aiSettings.credentialSource(name).source as string;
      return source === 'stored' ? 'stored' : aiSettings.resolveSecret(name) ? 'env' : 'missing';
    },
    selection: currentSelection,
    fetchImpl: options.ai?.fetchImpl,
  });
  const aiOrchestrator = aiRuntime.orchestrator;
  if (aiRuntime.config.config.enabled) {
    for (const message of aiRuntime.config.errors) logger.error(`AI agent disabled by configuration: ${message}`);
    for (const message of aiRuntime.config.warnings) logger.warn(`AI agent: ${message}`);
  }

  // Complete-call recording: off unless enabled AND consent is acknowledged. Not the diagnostic capture feature. The CALL_RECORDING_*
  // environment values are the starting point; what the operator saves in Settings > Call Recording wins and applies without a restart.
  const recordingBase = { ...loadRecordingConfig(options.ai?.env ?? process.env), ...options.recording };
  const recordingSkips = new RecordingSkipStore(db);
  // (The callback only runs on a later settings change, after callRecorder exists.)
  const recordingSettings = new RecordingSettingsService(repository, recordingBase, (next) => callRecorder.updateConfig(next));
  const callRecorder = new CallRecorder({
    audio,
    eventBus,
    config: recordingSettings.effective(),
    sampleRate: () => aiRuntime.config.config.audio.format?.sampleRate ?? config.audioSampleRate,
    skips: recordingSkips,
  });

  // SMS: one service (so "one SMS operation at a time" and the call protection hold everywhere), a persistent message
  // store, and the inbox that reads new messages when the modem announces them (+CMTI). The inbox starts with the server.
  const smsStore = new SmsStore(db);
  const smsService = new SmsService({ modem, callManager, store: smsStore });
  const smsPollEnv = Number(process.env.SMS_POLL_INTERVAL_MS);
  const smsInbox = new SmsInbox({
    service: smsService,
    store: smsStore,
    modem,
    eventBus,
    pollIntervalMs: Number.isFinite(smsPollEnv) && smsPollEnv >= 60_000 ? smsPollEnv : 0,
    // Until the first +CMTI arrives (SMS_FALLBACK_POLL_MS: 0 = off, otherwise at least 60000; default 120000).
    fallbackPollMs: smsFallbackPollMs(process.env.SMS_FALLBACK_POLL_MS),
  });

  const usbPcmVerifier =
    config.enableUsbPcmCaptureTest || config.enableUsbPcmOutboundToneTest
      ? new UsbPcmVerifier({
          audio,
          callManager,
          outputDir: config.audioDumpDir,
          captureEnabled: config.enableUsbPcmCaptureTest,
          outboundToneEnabled: config.enableUsbPcmOutboundToneTest,
          externalBusyReason: () =>
            aiOrchestrator.hasActiveSession ? 'The AI agent is using the audio port for this call' : null,
        })
      : undefined;
  usbPcmVerifierRef.current = usbPcmVerifier;
  // Read-only listener on the existing audio stream; works beside the AI agent. Only exists when the capture test is enabled.
  const inboundCaptureTap = config.enableUsbPcmCaptureTest ? new InboundCaptureTap({ audio, callManager }) : undefined;

  // 4. Persistence Event Hookup (Safely recording calls to SQLite)
  eventBus.on('call:started', (session) => {
    try {
      repository.upsertCall(session);
      repository.recordCallEvent(
        session.id,
        'CALL_STARTED',
        session.metadata,
        undefined,
        session.state
      );
    } catch {
      // Avoid crashing call flow if database write fails
    }
  });

  eventBus.on('call:state_changed', (event) => {
    try {
      repository.upsertCall(event.session);
      repository.recordCallEvent(
        event.callId,
        'STATE_CHANGED',
        // Why the state changed (never identifiers): lets a later investigation tell BEGIN from CONNECT.
        { trigger: event.trigger ?? null, triggerLine: event.triggerLine ?? null, at: event.timestamp },
        event.previousState,
        event.currentState
      );
    } catch {
      // Avoid crashing call flow
    }
  });

  eventBus.on('call:ended', (session) => {
    try {
      repository.upsertCall(session);
      repository.recordCallEvent(
        session.id,
        'CALL_ENDED',
        {
          durationSeconds: session.durationSeconds,
          outcome: session.outcome,
          terminationReason: session.terminationReason,
        },
        session.state,
        'IDLE'
      );
    } catch {
      // Avoid crashing call flow
    }
  });

  // 5. Express Application
  const app = express();

  // Strict CORS policy restricted to configured dashboard origin
  app.use(
    cors({
      origin: config.corsOrigin,
      credentials: true,
    })
  );

  app.use(securityHeaders());

  // Liveness for a supervisor or the dashboard: no key, and nothing in it but "the process is answering".
  const startedAt = new Date();
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: appVersion(), apiVersion: API_VERSION, uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000) });
  });

  // Payload body size limit
  app.use(express.json({ limit: '1mb' }));

  // API Key Authentication Middleware on all /api routes
  let lastBlockedLog = 0;
  // Local session tokens: the installed dashboard's server (this computer) trades the API key for a short-lived token, so the browser never
  // holds the key. A token is accepted like the key (REST and the live connection) and is checked under the same failure limit.
  const sessionTokens = options.sessionTokens ?? new SessionTokens();
  const authMiddleware = limitAuthFailures(createAuthMiddleware(config.gatewayApiKey, sessionTokens), new AuthFailureLimiter(), () => {
    if (Date.now() - lastBlockedLog > 60_000) {
      lastBlockedLog = Date.now();
      logger.warn('Too many failed API-key attempts: a client is being refused for a minute');
    }
  });
  app.use('/api', authMiddleware);

  // Minting needs the MASTER key (a session token cannot mint another) and a caller on this computer.
  app.post('/api/auth/session', (req, res) => {
    const given = (req.headers['x-api-key'] as string | undefined) ?? '';
    if (!verifyApiKey(given, config.gatewayApiKey)) {
      res.status(403).json({ success: false, error: 'A session can only be created with the gateway API key', code: 'FORBIDDEN' });
      return;
    }
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({ success: false, error: 'Sessions are only issued to programs on this computer', code: 'FORBIDDEN' });
      return;
    }
    res.json({ success: true, ...sessionTokens.issue() });
  });

  // Routes
  app.use(
    '/api/gateway',
    createGatewayRouter({
      usbPcmVerifier,
      inboundCaptureTap,
      modem,
      audio,
      callManager,
      config,
      listPorts: options.ai?.hardwarePortLister ?? options.listSerialPorts,
      portDiscovery,
      currentPorts,
      recorder: callRecorder,
      recordingSettings,
      recordingSkips,
      sms: smsService,
      smsInbox,
      smsStore,
    })
  );

  app.use('/api/ai/registry', createRegistryRouter({ service: modelRegistryService, store: modelRegistry, updater: pricingUpdater }));
  app.use(
    '/api/ai',
    createAiRouter({
      runtime: aiRuntime,
      settings: aiSettings,
      usage: aiUsage,
    })
  );

  app.use('/api/observability', createObservabilityRouter({ store: observability, retention }));

  // Call records and the post-call analysis. The analysis is one extra model request made after a campaign call has ended, only for a real
  // conversation; with test providers injected it is off, so it can never consume a scripted reply.
  const callAnalysisStore = new CallAnalysisStore(db);
  const callRecords = new CampaignCallRecords(db, callAnalysisStore);
  const callAnalysis = new CallAnalysisService({
    db,
    records: callRecords,
    store: callAnalysisStore,
    complete: options.ai?.providers ? undefined : (request) => aiRuntime.completeText(request),
    logger,
  });
  const recordOutcome = outcomeRecorder(sheets, campaignStore);
  const campaignRunner = new CampaignRunner({
    store: campaignStore,
    dialer: managerDialer(callManager),
    contexts: callContexts,
    blockers: () => aiRuntime.campaignBlockers(),
    agent: { attached: (callId) => aiRuntime.orchestrator.isAttached(callId) },
    alert: (level, message) => eventBus.emit('gateway:alert', { level, message, timestamp: new Date().toISOString() }),
    onAttemptFinished: async (info) => {
      callAnalysis.scheduleAfterAttempt(info.campaignId, info.contactId, info.callId);
      await recordOutcome(info);
    },
  });
  app.use('/api/integrations', createIntegrationsRouter({ sheets, runtime: aiRuntime }));
  app.use('/api/campaigns', createCampaignsRouter({ store: campaignStore, runner: campaignRunner, blockers: () => aiRuntime.campaignBlockers(), llm: { problem: (key) => aiRuntime.llmProblem(key), choices: () => aiRuntime.llmChoices() }, calls: { records: callRecords, analysis: callAnalysis, store: callAnalysisStore } }));

  // ---- operations: alerts, health, network diagnostics, per-call diagnoses, backups ------------------------------------------------
  const alertStore = new AlertStore(db, undefined, (type, a) => {
    const level = type === 'resolved' ? 'info' : a.severity === 'warning' ? 'warn' : a.severity === 'info' ? 'info' : 'error';
    logger[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info'](`Alert ${type}: ${a.title}`, { component: a.component, key: a.key, severity: a.severity });
    eventBus.emit('gateway:alert', { level, message: type === 'resolved' ? `Resolved: ${a.title}` : `${a.title}. ${a.message}`, timestamp: new Date().toISOString() });
  });
  const callDiagnostics = new CallDiagnosticsStore(db);
  const gatewayBusy = () => callManager.getCurrentCall() !== null;
  const networkDiagnostics = new NetworkDiagnostics({
    modem,
    isBusy: gatewayBusy,
    logger,
    onSnapshot: (reading, previous) => {
      if (!previous || previous.verdict.code !== reading.verdict.code) logger.info(`SIM and network status: ${reading.verdict.code}`, { sim: reading.sim.state, rssi: reading.signal.rssi, cs: reading.registration.cs.stat, eps: reading.registration.eps.stat });
    },
  });
  const backupService = new BackupService({ db, dbPath: config.sqliteDbPath, expectedSchema: SCHEMA_VERSION, logger });
  const healthMonitor = new HealthMonitor({
    alerts: alertStore,
    logger,
    checks: [
      gatewayCheck({ version: appVersion(), startedAt }),
      modemCheck({ state: () => modem.getConnectionState(), simulated: modem.isSimulated }),
      networkCheck({ snapshot: () => networkDiagnostics.snapshot(), modemReady: () => modem.getConnectionState() === 'READY', simulated: modem.isSimulated }),
      providersCheck({ db }),
      databaseCheck({ db, expectedSchema: SCHEMA_VERSION }),
      storageCheck({ dataDir, recorderError: () => callRecorder.getStatus().lastError }),
      backgroundCheck({
        db,
        campaignPaused: () => (db.prepare("SELECT pause_reason FROM campaigns WHERE status = 'paused' AND pause_reason IS NOT NULL AND pause_reason != 'paused by the operator' LIMIT 1").get() as { pause_reason: string } | undefined)?.pause_reason ?? null,
      }),
    ],
  });
  // After a call ends and its cleanup is done, save why it ended. This only reads (and asks the modem for AT+CEER, through its own queue,
  // only when no call exists); a failure here never reaches the call.
  eventBus.on('call:ended', (session) => {
    logger.info('Call ended', { callId: session.id, outcome: session.outcome, direction: session.direction, durationSeconds: session.durationSeconds });
    setTimeout(() => {
      void recordCallEnd(
        {
          store: callDiagnostics,
          network: () => networkDiagnostics.snapshot(),
          readCeer: async () => (modem.isSimulated || modem.getConnectionState() !== 'READY' || gatewayBusy() ? null : modem.executeCommand('AT+CEER', 3000)),
          logger,
        },
        session
      );
    }, 1500).unref?.();
  });
  eventBus.on('call:started', (session) => logger.info('Call started', { callId: session.id, direction: session.direction }));
  eventBus.on('modem:connection_state', (state) => logger.info('Modem connection state changed', { state }));
  app.use(
    '/api/ops',
    createOpsRouter({
      alerts: alertStore,
      health: healthMonitor,
      network: networkDiagnostics,
      diagnostics: callDiagnostics,
      backups: backupService,
      version: () => ({ app: appVersion(), schema: SCHEMA_VERSION, node: process.version, apiVersion: API_VERSION, startedAt: startedAt.toISOString() }),
      bundle: () =>
        buildSupportBundle({
          version: { app: appVersion(), schema: SCHEMA_VERSION, node: process.version },
          startedAt: startedAt.toISOString(),
          db,
          dbPath: config.sqliteDbPath,
          health: healthMonitor.snapshot(),
          alerts: { active: alertStore.active(), recent: alertStore.history(1, 100).items },
          network: networkDiagnostics.snapshot(),
          diagnostics: callDiagnostics,
          config: safeConfig(config as unknown as Record<string, unknown>),
          keysPresent: { gatewayApiKey: Boolean(config.gatewayApiKey) },
          fileLogs: () => fileLog?.tail(1500) ?? [],
        }),
    })
  );
  app.use('/api/ivr', createIvrRouter({
      store: ivrStore,
      assets: ivrAssets,
      tts: new TtsGenerator({
        config: () => aiRuntime.config.config,
        env: () => aiSettings.effectiveEnv(),
        fetchImpl: options.ai?.fetchImpl,
        sampleRate: () => ivrAssets.expectedSampleRate,
      }),
      runtime: () => ({ controllerRegistered: ivrOwnership.hasHandler, activeCalls: ivrController.activeCalls, aiCanAnswer: Boolean(aiRuntimeRef.current?.config.config.enabled && aiRuntimeRef.current.config.config.automation.autoReplies) }),
    }));

  app.use(
    '/api/calls',
    createCallsRouter({
      callManager,
      repository,
    })
  );

  app.use(
    '/api/mock',
    createMockRouter({
      modem,
    })
  );

  // Error Handler
  app.use(errorHandler);

  // 6. HTTP & Socket.IO Server
  const httpServer = http.createServer(app);
  const socketServer = new GatewaySocketServer({
    httpServer,
    corsOrigin: config.corsOrigin,
    expectedApiKey: config.gatewayApiKey,
    sessions: sessionTokens,
    modem,
    audio,
    callManager,
    eventBus,
    atPort: config.atPort,
    audioPort: config.audioPort,
    currentPorts,
    audioVerification: aiRuntime.audioVerification,
  });

  let instanceLock: InstanceLock | null = null;
  const releaseInstanceLock = (): void => {
    process.off('exit', releaseInstanceLock);
    instanceLock?.release();
    instanceLock = null;
  };

  /**
   * After the adapter has given up reconnecting (the modem was unplugged for longer than its retries), look for it now and
   * then by LISTING the serial ports only, and start the adapter again once its modem is present. It never opens a port itself,
   * never runs while the adapter is connecting or retrying, and never while a call exists, so there is never a second connection.
   */
  let pruneTimer: NodeJS.Timeout | null = null;
  const startRetention = (): void => {
    const run = async (): Promise<void> => {
      if (callManager.getCurrentCall()) return; // never while a call is live; the next pass catches up
      const r = await observability.prune({ ...retention, busy: () => callManager.getCurrentCall() !== null });
      if (r.deleted > 0) logger.info(`Call telemetry retention removed ${r.deleted} old trace event(s)`);
    };
    const first = setTimeout(() => void run(), 60_000);
    first.unref();
    pruneTimer = setInterval(() => void run(), 6 * 3_600_000);
    pruneTimer.unref();
    cleanupFirstPrune = () => clearTimeout(first);
  };
  let cleanupFirstPrune: (() => void) | null = null;
  let modemWatch: NodeJS.Timeout | null = null;
  let modemWatchBusy = false;
  const startModemWatch = (): void => {
    if (!portDiscovery || modemWatch) return;
    const hw = modem as unknown as { getDiagnostics?: () => { reconnectScheduled: boolean } | null };
    modemWatch = setInterval(async () => {
      if (modemWatchBusy) return;
      const state = modem.getConnectionState();
      if (state !== 'ERROR' && state !== 'DISCONNECTED') return;
      if (hw.getDiagnostics?.()?.reconnectScheduled || callManager.getCurrentCall()) return;
      modemWatchBusy = true;
      try {
        const result = await portDiscovery.scan();
        if (result.ok && portDiscovery.isPresent(result.at)) {
          logger.info(`Modem found again on ${result.at}; reconnecting`);
          await modem.initialize().catch(() => {}); // a failure reschedules the adapter's own retries
        }
      } finally {
        modemWatchBusy = false;
      }
    }, options.modemWatchMs ?? 15_000);
    modemWatch.unref?.();
  };

  const start = async (): Promise<void> => {
    logger.info(`Starting gateway server in ${config.modemDriver} mode on ${config.host}:${config.port}`);
    // Claim the serial ports before anything opens them; a second gateway fails here, naming the owner.
    if (config.modemDriver === 'hardware' && !instanceLock) {
      instanceLock = acquireInstanceLock([config.atPort, config.audioPort], options.instanceLockDir);
      process.once('exit', releaseInstanceLock);
      logger.info(`Serial port ownership recorded for ${config.atPort} and ${config.audioPort} (pid ${process.pid})`);
    }
    if (modem.getConnectionState() === 'DISCONNECTED') {
      const portConfig = {
        atPort: config.atPort,
        atBaudRate: config.atBaudRate,
        audioPort: config.audioPort,
        audioBaudRate: config.audioBaudRate,
      };
      if (config.modemDriver === 'hardware' && config.autoReconnect) {
        // The modem can be missing, re-enumerating or slow at startup. The API and dashboard must still come up so
        // the operator can see the state; the adapter keeps retrying on its own (it schedules a reconnect on failure).
        modem.initialize(portConfig).catch((error: Error) => {
          logger.error(
            `Modem is not ready at startup: ${redactDiagnosticText(error.message)}. The gateway is serving and will keep retrying.`
          );
        });
      } else {
        try {
          await modem.initialize(portConfig);
        } catch (error) {
          // A failed start must not keep claiming ports it never managed to open.
          releaseInstanceLock();
          throw error;
        }
      }
    }

    await new Promise<void>((resolve) => {
      httpServer.listen(config.port, config.host, () => {
        logger.info(`HTTP and Socket.IO server listening on http://${config.host}:${config.port}`);
        aiRuntime.start();
        // A campaign that was running when the gateway stopped is paused, never resumed on its own; nothing is dialled here.
        const recovered = campaignStore.recover();
        if (recovered.paused > 0 || recovered.settled > 0) logger.warn(`Campaigns after restart: ${recovered.paused} paused, ${recovered.settled} interrupted call(s) settled`);
        campaignRunner.start();
        callRecorder.start();
        // SMS_INBOX_ENABLED=false leaves the inbox off, so the gateway sends no SMS-related AT command by itself.
        if (process.env.SMS_INBOX_ENABLED?.trim().toLowerCase() !== 'false') smsInbox.start();
        startModemWatch();
        startRetention();
        networkDiagnostics.start();
        healthMonitor.start();
        backupService.start(() => !gatewayBusy());
        logger.info('Gateway started', { version: appVersion(), schema: SCHEMA_VERSION, driver: config.modemDriver, pid: process.pid });
        resolve();
      });
    });
  };

  const close = async (): Promise<void> => {
    logger.info('Closing gateway server connections...');
    if (modemWatch) clearInterval(modemWatch);
    modemWatch = null;
    if (pruneTimer) clearInterval(pruneTimer);
    cleanupFirstPrune?.();
    networkDiagnostics.stop();
    healthMonitor.stop();
    backupService.stop();
    smsInbox.stop();
    ivrController.stop();
    ivrOwnership.stop();
    await aiRuntime.stop();
    campaignRunner.stop(); // no new campaign call starts; one already ringing is not hung up
    callRecorder.stop(); // finalizes any recording in progress
    unregisterAttempts();
    await socketServer.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    if (modem.getConnectionState() !== 'DISCONNECTED') {
      await modem.close();
    }
    db.close();
    releaseInstanceLock();
    logger.info('Gateway server shutdown complete');
    setLogSink(null);
    await fileLog?.close();
  };

  return {
    app,
    httpServer,
    socketServer,
    modem,
    audio,
    callManager,
    repository,
    eventBus,
    aiOrchestrator,
    aiRuntime,
    campaignStore,
    campaignRunner,
    ivrStore,
    ivrAssets,
    ivrOwnership,
    ivrController,
    callRecorder,
    smsService,
    smsInbox,
    smsStore,
    portDiscovery,
    db,
    config,
    start,
    close,
  };
}
