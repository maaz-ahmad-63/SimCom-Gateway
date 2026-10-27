import http from 'node:http';
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
import { runMigrations } from './db/migrations.js';
import { GatewayRepository } from './db/repository.js';
import { GatewayEventBus } from './core/event-bus.js';
import { CallSessionManager } from './core/call-session-manager.js';
import { MockModemAdapter } from './adapters/modem/mock-modem.js';
import { Sim7600HardwareAdapter } from './adapters/modem/hardware-modem.js';
import { MockAudioAdapter } from './adapters/audio/mock-audio.js';
import { Sim7600HardwareAudioAdapter } from './adapters/audio/hardware-audio.js';
import { createAuthMiddleware } from './api/middleware/auth.js';
import { errorHandler } from './api/middleware/error-handler.js';
import { createGatewayRouter } from './api/routes/gateway.js';
import { createCallsRouter } from './api/routes/calls.js';
import { createMockRouter } from './api/routes/mock.js';
import { GatewaySocketServer } from './api/socket/socket-server.js';
import { loadConfig } from './config/index.js';
import { createLogger, redactDiagnosticText } from './core/logger.js';
import { UsbPcmVerifier } from './diagnostics/usb-pcm-verification.js';
import { InboundCaptureTap } from './diagnostics/inbound-capture.js';
import { acquireInstanceLock, InstanceLock } from './core/instance-lock.js';
import { createAiRouter } from './api/routes/ai.js';
import { AiCallOrchestrator } from './ai/orchestrator.js';
import { AiRuntime } from './ai/runtime.js';
import { CallRecorder } from './recording/call-recorder.js';
import { loadRecordingConfig, RecordingConfig } from './recording/config.js';
import { AiSettingsService } from './ai/settings.js';
import { AiUsageStore } from './ai/usage-store.js';
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
  /** Complete-call recording overrides (tests). Production reads CALL_RECORDING_* from the environment. */
  recording?: Partial<RecordingConfig>;
  /** AI agent test seams. In production none of these is set: env + real providers + the SIM7600EI audio adapter. */
  ai?: {
    env?: Record<string, string | undefined>;
    providers?: ProviderSet;
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
  callRecorder: CallRecorder;
  db: DatabaseType;
  config: GatewayConfigInput;
  start: () => Promise<void>;
  close: () => Promise<void>;
}

export function createGatewayServer(
  options: GatewayServerOptions = {}
): GatewayServerInstance {
  const config = loadConfig(options.config);

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
  const usbPcmVerifierRef: { current?: UsbPcmVerifier } = {};
  const aiRuntime = new AiRuntime({
    settings: aiSettings,
    usage: aiUsage,
    modem,
    audio,
    callManager,
    eventBus,
    recordingsDir: config.audioDumpDir,
    providers: options.ai?.providers,
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
  });
  const aiOrchestrator = aiRuntime.orchestrator;
  if (aiRuntime.config.config.enabled) {
    for (const message of aiRuntime.config.errors) logger.error(`AI agent disabled by configuration: ${message}`);
    for (const message of aiRuntime.config.warnings) logger.warn(`AI agent: ${message}`);
  }

  // Complete-call recording: off unless enabled AND consent is acknowledged. Not the diagnostic capture feature.
  const callRecorder = new CallRecorder({
    audio,
    eventBus,
    config: { ...loadRecordingConfig(options.ai?.env ?? process.env), ...options.recording },
    sampleRate: () => aiRuntime.config.config.audio.format?.sampleRate ?? config.audioSampleRate,
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

  // Payload body size limit
  app.use(express.json({ limit: '1mb' }));

  // API Key Authentication Middleware on all /api routes
  const authMiddleware = createAuthMiddleware(config.gatewayApiKey);
  app.use('/api', authMiddleware);

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
      listPorts: options.ai?.hardwarePortLister,
      recorder: callRecorder,
    })
  );

  app.use(
    '/api/ai',
    createAiRouter({
      runtime: aiRuntime,
      settings: aiSettings,
      usage: aiUsage,
    })
  );

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
    modem,
    audio,
    callManager,
    eventBus,
    atPort: config.atPort,
    audioPort: config.audioPort,
  });

  let instanceLock: InstanceLock | null = null;
  const releaseInstanceLock = (): void => {
    process.off('exit', releaseInstanceLock);
    instanceLock?.release();
    instanceLock = null;
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
        callRecorder.start();
        resolve();
      });
    });
  };

  const close = async (): Promise<void> => {
    logger.info('Closing gateway server connections...');
    await aiRuntime.stop();
    callRecorder.stop(); // finalizes any recording in progress
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
    callRecorder,
    db,
    config,
    start,
    close,
  };
}
