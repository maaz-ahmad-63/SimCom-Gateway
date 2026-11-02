import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { loadAiConfig } from '../../src/ai/config.js';
import { createProviders } from '../../src/ai/providers/index.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { createGatewayServer } from '../../src/server.js';
import { aiEnv } from './helpers.js';

/**
 * Deepgram streaming was already built but could only be switched on in .env (AI_STT_STREAMING, default off), which is why
 * calls showed streaming=off. It is now an AI setting the dashboard can save, layered over .env like the others.
 */
const KEY = 'stt-stream-setting-key-123456';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function gateway(env: Record<string, string | undefined> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sttset-'));
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
  await modem.initialize();
  const server = createGatewayServer({
    config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec') },
    modem,
    audio: new MockAudioAdapter(),
    instanceLockDir: dir,
    ai: { env: aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only', ...env }), providers: createMockProviders(), allowSimulatedHardware: true },
  });
  cleanups.push(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return (m: 'get' | 'put', url: string) => request(server.app)[m](url).set('x-api-key', KEY);
}

describe('streaming speech-to-text as a dashboard setting', () => {
  it('is off by default, can be saved and read back, and survives a bad value', async () => {
    const api = await gateway();
    expect((await api('get', '/api/ai/settings')).body.settings?.sttStreaming ?? (await api('get', '/api/ai/settings')).body.sttStreaming).toBe(false);
    const on = await api('put', '/api/ai/settings').send({ sttStreaming: true });
    expect(on.status).toBe(200);
    const read = (await api('get', '/api/ai/settings')).body;
    expect((read.settings ?? read).sttStreaming).toBe(true);
    expect((await api('put', '/api/ai/settings').send({ sttStreaming: 'yes' })).status).toBe(400);
    expect(((await api('get', '/api/ai/settings')).body.settings ?? (await api('get', '/api/ai/settings')).body).sttStreaming).toBe(true); // untouched by the refusal
    await api('put', '/api/ai/settings').send({ sttStreaming: false });
    const off = (await api('get', '/api/ai/settings')).body;
    expect((off.settings ?? off).sttStreaming).toBe(false);
  });

  it('builds the streaming recogniser only when it is on and a Deepgram key exists, so a missing key never blocks a call', () => {
    const build = (extra: Record<string, string | undefined>) => {
      const env = aiEnv(extra);
      const { config } = loadAiConfig(env);
      return createProviders(config, { env, fetchImpl: async () => new Response('{}') });
    };
    expect(build({}).sttStream).toBeUndefined();
    expect(build({ AI_STT_STREAMING: 'true' }).sttStream).toBeDefined();
    expect(build({ AI_STT: 'groq_whisper', AI_STT_STREAMING: 'true', DEEPGRAM_API_KEY: undefined }).sttStream).toBeUndefined();
  });
});
