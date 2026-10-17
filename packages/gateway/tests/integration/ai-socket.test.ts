import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ClientSocket, Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiInspectorEvent, ClientToServerEvents, ServerToClientEvents } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, noiseFloorPcm, sleep, speechPcm } from '../ai/helpers.js';

const KEY = 'ai-socket-test-key';

describe('Integration: AI inspector events over a real Socket.IO connection', () => {
  let server: GatewayServerInstance;
  let modem: MockModemAdapter;
  let source: ManualAudioSource;
  let dir: string;
  let port: number;
  const sockets: Array<Socket<ServerToClientEvents, ClientToServerEvents>> = [];

  const connect = (token: string) => {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = ClientSocket(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    return socket;
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-socket-'));
    port = 50152 + Math.floor(Math.random() * 1000);
    modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    source = new ManualAudioSource(FORMAT_8K, true);
    server = createGatewayServer({
      config: { port, host: '127.0.0.1', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec'), enableUsbAudioDiagnostic: true },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      ai: {
        env: aiEnv(),
        providers: createMockProviders({ stt: ['socket transcript'] }),
        allowSimulatedHardware: true,
        mode: 'passive',
        transports: () => ({ source, sink: new CollectingAudioSink(FORMAT_8K, true) }),
      },
    });
    await server.start();
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('delivers the inspector stages of the live call to authenticated clients only', async () => {
    const good = connect(KEY);
    const bad = connect('wrong-key');
    const received: AiInspectorEvent[] = [];
    const leaked: AiInspectorEvent[] = [];
    good.on('ai:event', (e) => received.push(e));
    bad.on('ai:event', (e) => leaked.push(e));
    await vi.waitFor(() => expect(good.connected).toBe(true));

    const call = await server.callManager.dial({ phoneNumber: '+919876543210' });
    modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
    await server.callManager.activateUsbAudioDiagnostic!();
    await sleep(60);
    const arm = await request(server.app).post(`/api/ai/calls/${call.id}/arm`).set('x-api-key', KEY);
    expect(arm.status).toBe(200);

    source.push(speechPcm(1200));
    source.push(noiseFloorPcm(1200));
    await vi.waitFor(() => expect(received.some((e) => e.stage === 'stt-result' && e.status === 'ok')).toBe(true), { timeout: 4000 });

    expect(received.every((e) => e.callId === call.id)).toBe(true); // the actual active call
    expect(received.find((e) => e.stage === 'call')?.detail).toMatch(/attached in passive mode/);
    const turn = received.filter((e) => e.turnId);
    for (const stage of ['pcm-capture', 'pcm-validation', 'stt-submit', 'stt-result']) {
      expect(turn.some((e) => e.stage === stage && e.status === 'ok'), stage).toBe(true);
    }
    expect(JSON.stringify(received)).not.toContain('socket transcript'); // text off by default
    expect(leaked).toEqual([]);

    // A client that connects later catches up from the buffer instead of missing the call.
    const caught = await request(server.app).get(`/api/ai/events?callId=${call.id}`).set('x-api-key', KEY);
    expect(caught.body.events.map((e: AiInspectorEvent) => e.seq)).toEqual(received.map((e) => e.seq));
  });
});
