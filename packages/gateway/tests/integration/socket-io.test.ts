import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ClientSocket, Socket } from 'socket.io-client';
import fs from 'node:fs';
import path from 'node:path';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { ClientToServerEvents, ServerToClientEvents } from '@sim-gateway/shared';

describe('Integration: Socket.IO Real-Time Hub', () => {
  let serverInstance: GatewayServerInstance;
  let modem: MockModemAdapter;
  let audio: MockAudioAdapter;
  const testApiKey = 'test-secret-socket-12345';
  const testDbPath = path.resolve('./data/test-socket.sqlite');
  let serverPort: number;

  beforeAll(async () => {
    // Pick an available high port for testing
    serverPort = 49152 + Math.floor(Math.random() * 1000);

    modem = new MockModemAdapter({
      autoAnswerDelayMs: 0,
      ringIntervalMs: 50,
    });
    audio = new MockAudioAdapter({ frameDurationMs: 10 });

    serverInstance = createGatewayServer({
      config: {
        port: serverPort,
        host: '127.0.0.1',
        gatewayApiKey: testApiKey,
        sqliteDbPath: testDbPath,
      },
      modem,
      audio,
    });

    await serverInstance.start();
  });

  afterAll(async () => {
    await serverInstance.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  });

  it('rejects unauthenticated Socket.IO connections', async () => {
    const unauthClient = ClientSocket(`http://127.0.0.1:${serverPort}`, {
      auth: { token: 'wrong-key' },
      transports: ['websocket'],
      reconnection: false,
    });

    const errorPromise = new Promise<string>((resolve) => {
      unauthClient.on('connect_error', (err) => {
        resolve(err.message);
      });
    });

    const errorMessage = await errorPromise;
    expect(errorMessage).toContain('Unauthorized');
    unauthClient.disconnect();
  });

  it('connects authenticated client and delivers initial state snapshot', async () => {
    const client: Socket<ServerToClientEvents, ClientToServerEvents> = ClientSocket(
      `http://127.0.0.1:${serverPort}`,
      {
        auth: { token: testApiKey },
        transports: ['websocket'],
      }
    );

    const snapshotPromise = new Promise<any>((resolve) => {
      client.on('gateway:health', (health) => {
        resolve(health);
      });
    });

    const health = await snapshotPromise;
    expect(health.gatewayVersion).toBe('0.1.0');
    expect(health.isSimulated).toBe(true);
    expect(health.driverType).toBe('mock');

    client.disconnect();
  });

  it('delivers live events for dial, active audio, and hangup via Socket.IO', async () => {
    const client: Socket<ServerToClientEvents, ClientToServerEvents> = ClientSocket(
      `http://127.0.0.1:${serverPort}`,
      {
        auth: { token: testApiKey },
        transports: ['websocket'],
      }
    );

    await new Promise<void>((resolve) => client.on('connect', () => resolve()));

    const stateChanges: string[] = [];
    client.on('call:state_changed', (evt) => {
      stateChanges.push(evt.currentState);
    });

    let audioLevelReceived = false;
    client.on('audio:level', (data) => {
      if (data.inboundRms > 0) {
        audioLevelReceived = true;
      }
    });

    // 1. Dial via socket command with acknowledgment callback
    const dialResponse = await new Promise<any>((resolve) => {
      client.emit('call:dial', { phoneNumber: '+919876543210' }, (res) => {
        resolve(res);
      });
    });

    expect(dialResponse.success).toBe(true);
    expect(dialResponse.data.state).toBe('DIALING');

    // 2. Simulate remote answering to advance to ACTIVE
    modem.emit('urc', {
      raw: 'VOICE CALL: BEGIN',
      type: 'VOICE_CALL_BEGIN',
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });

    // Wait a brief moment for audio frames to be generated and throttled levels emitted
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(stateChanges).toContain('ACTIVE');
    expect(audioLevelReceived).toBe(true);

    // 3. Hangup via socket command with acknowledgment callback
    const hangupResponse = await new Promise<any>((resolve) => {
      client.emit('call:hangup', (res) => {
        resolve(res);
      });
    });

    expect(hangupResponse.success).toBe(true);
    expect(stateChanges).toContain('TERMINATING');

    client.disconnect();
  });
});
