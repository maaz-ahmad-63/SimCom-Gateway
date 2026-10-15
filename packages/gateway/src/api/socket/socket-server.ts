import { Server as HttpServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  IAudioAdapter,
  ICallSessionManager,
  IModemAdapter,
  GatewayHealthStatus,
  dialRequestSchema,
  dtmfRequestSchema,
  triggerMockInboundSchema,
  CallStateChangeEvent,
  CallSession,
  UrcEvent,
} from '@sim-gateway/shared';
import os from 'node:os';
import { verifyApiKey } from '../middleware/auth.js';
import { GatewayEventBus } from '../../core/event-bus.js';
import { MockModemAdapter } from '../../adapters/modem/mock-modem.js';

export interface SocketServerOptions {
  httpServer: HttpServer;
  corsOrigin: string;
  expectedApiKey: string;
  modem: IModemAdapter;
  audio?: IAudioAdapter;
  callManager: ICallSessionManager;
  eventBus: GatewayEventBus;
  atPort: string;
  audioPort: string;
}

export class GatewaySocketServer {
  private readonly io: Server<ClientToServerEvents, ServerToClientEvents>;
  private lastAudioLevelEmit = 0;
  private readonly audioThrottleMs = 100; // 10Hz live VU meter updates

  constructor(private readonly options: SocketServerOptions) {
    this.io = new Server<ClientToServerEvents, ServerToClientEvents>(options.httpServer, {
      cors: {
        origin: options.corsOrigin,
        methods: ['GET', 'POST'],
        credentials: true,
      },
      pingTimeout: 10000,
      pingInterval: 10000,
    });

    this.setupAuth();
    this.setupConnection();
    this.bindGatewayEvents();
  }

  getIo(): Server<ClientToServerEvents, ServerToClientEvents> {
    return this.io;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.io.close(() => resolve());
    });
  }

  private setupAuth(): void {
    this.io.use((socket, next) => {
      // Check auth object or handshake headers
      const token =
        (socket.handshake.auth?.token as string | undefined) ||
        (socket.handshake.headers['x-api-key'] as string | undefined);

      if (!token || !verifyApiKey(token, this.options.expectedApiKey)) {
        return next(new Error('Unauthorized: Invalid or missing API key'));
      }

      next();
    });
  }

  private setupConnection(): void {
    this.io.on('connection', async (socket: Socket<ClientToServerEvents, ServerToClientEvents>) => {
      // 1. Send initial state snapshot to connected client
      await this.sendSnapshot(socket);

      // 2. Client-to-server command: call:dial
      socket.on('call:dial', async (request, callback) => {
        try {
          const validated = dialRequestSchema.parse(request);
          const session = await this.options.callManager.dial(validated);
          callback({ success: true, data: session });
        } catch (err) {
          callback({ success: false, error: (err as Error).message });
        }
      });

      // 3. Client-to-server command: call:answer
      socket.on('call:answer', async (callback) => {
        try {
          const session = await this.options.callManager.answer();
          callback({ success: true, data: session });
        } catch (err) {
          callback({ success: false, error: (err as Error).message });
        }
      });

      // 4. Client-to-server command: call:hangup
      socket.on('call:hangup', async (callback) => {
        try {
          await this.options.callManager.hangup('User requested hangup via Socket.IO');
          callback({ success: true });
        } catch (err) {
          callback({ success: false, error: (err as Error).message });
        }
      });

      // 5. Client-to-server command: call:dtmf
      socket.on('call:dtmf', async (request, callback) => {
        try {
          const validated = dtmfRequestSchema.parse(request);
          await this.options.callManager.sendDtmf(validated);
          callback({ success: true });
        } catch (err) {
          callback({ success: false, error: (err as Error).message });
        }
      });

      // 6. Client-to-server command: mock:trigger_inbound
      socket.on('mock:trigger_inbound', (data, callback) => {
        try {
          if (this.options.modem.driverType !== 'mock') {
            callback({ success: false, error: 'Mock trigger is disabled in hardware mode' });
            return;
          }

          const validated = triggerMockInboundSchema.parse(data);
          const mockModem = this.options.modem as MockModemAdapter;
          mockModem.simulateInboundCall(validated.phoneNumber, validated.ringCount);
          callback({ success: true });
        } catch (err) {
          callback({ success: false, error: (err as Error).message });
        }
      });
    });
  }

  private bindGatewayEvents(): void {
    // Call state change
    this.options.eventBus.on('call:state_changed', (event: CallStateChangeEvent) => {
      this.io.emit('call:state_changed', event);
    });

    // Call started
    this.options.eventBus.on('call:started', (session: CallSession) => {
      this.io.emit('call:started', session);
    });

    // Call ended
    this.options.eventBus.on('call:ended', (session: CallSession) => {
      this.io.emit('call:ended', session);
    });

    // Modem URCs
    this.options.eventBus.on('modem:urc', (urc: UrcEvent) => {
      this.io.emit('modem:urc', urc);
    });

    // Gateway alerts
    this.options.eventBus.on('gateway:alert', (alert) => {
      this.io.emit('gateway:alert', alert);
    });

    // Audio adapter live VU meter / RMS events (throttled to 10Hz)
    if (this.options.audio) {
      this.options.audio.on('audio_frame', (frame) => {
        const now = Date.now();
        if (now - this.lastAudioLevelEmit >= this.audioThrottleMs) {
          this.lastAudioLevelEmit = now;
          const stats = this.options.audio?.getStats();
          this.io.emit('audio:level', {
            inboundRms: frame.rmsLevel,
            outboundRms: stats?.currentRmsOutbound ?? 0,
            timestamp: now,
          });
        }
      });
    }
  }

  private async sendSnapshot(
    socket: Socket<ClientToServerEvents, ServerToClientEvents>
  ): Promise<void> {
    try {
      const activeCall = this.options.callManager.getCurrentCall();
      let signal = null;
      let network = null;
      let info = null;

      if (this.options.modem.getConnectionState() === 'READY') {
        [signal, network, info] = await Promise.all([
          this.options.modem.getSignalQuality().catch(() => null),
          this.options.modem.getNetworkStatus().catch(() => null),
          this.options.modem.getDeviceInfo().catch(() => null),
        ]);
      }

      const healthSnapshot: GatewayHealthStatus = {
        gatewayVersion: '0.1.0',
        uptimeSeconds: Math.round(process.uptime()),
        isSimulated: this.options.modem.isSimulated,
        driverType: this.options.modem.driverType,
        modem: {
          connectionState: this.options.modem.getConnectionState(),
          info,
          signal,
          network,
          atPort: this.options.atPort,
          audioPort: this.options.audioPort,
        },
        activeCall,
        audioStreaming: this.options.audio ? this.options.audio.getStats().isStreaming : false,
        system: {
          platform: os.platform(),
          nodeVersion: process.version,
          memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        },
        timestamp: new Date().toISOString(),
      };

      socket.emit('gateway:health', healthSnapshot);

      if (signal && network) {
        socket.emit('modem:telemetry', { signal, network });
      }

      if (activeCall) {
        socket.emit('call:started', activeCall);
      }
    } catch {
      // Snapshot delivery failure shouldn't abort connection
    }
  }
}
