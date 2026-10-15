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

export interface GatewayServerOptions {
  config?: Partial<GatewayConfigInput>;
  modem?: IModemAdapter;
  audio?: IAudioAdapter;
  db?: DatabaseType;
  repository?: GatewayRepository;
  callManager?: ICallSessionManager;
  eventBus?: GatewayEventBus;
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
  const callManager =
    options.callManager ??
    new CallSessionManager({
      modem,
      audio,
      eventBus,
    });

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
        undefined,
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
      modem,
      audio,
      callManager,
      config,
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

  const start = async (): Promise<void> => {
    if (modem.getConnectionState() === 'DISCONNECTED') {
      await modem.initialize({
        atPort: config.atPort,
        atBaudRate: config.atBaudRate,
        audioPort: config.audioPort,
        audioBaudRate: config.audioBaudRate,
      });
    }

    await new Promise<void>((resolve) => {
      httpServer.listen(config.port, config.host, () => {
        resolve();
      });
    });
  };

  const close = async (): Promise<void> => {
    await socketServer.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    if (modem.getConnectionState() !== 'DISCONNECTED') {
      await modem.close();
    }
    db.close();
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
    db,
    config,
    start,
    close,
  };
}
