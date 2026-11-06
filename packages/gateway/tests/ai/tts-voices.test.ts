import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { resetActiveRegistry } from '../../src/ai/registry/active.js';
import { createGatewayServer } from '../../src/server.js';
import { aiEnv } from './helpers.js';

/**
 * GET /api/ai/voices/:tts reads the provider's own voice list with the stored key, gateway side. Provider responses are mocked here (the
 * shapes of the providers' documentation); this does not prove any provider's live answer.
 */
const KEY = 'voices-test-api-key';
const SECRET = 'provider-secret-value-0123456789';
const closers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  resetActiveRegistry();
});

type Seen = { url: string; headers: Record<string, string> };
async function boot(respond: (url: string) => Response | Promise<Response>, env: Record<string, string | undefined> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voices-'));
  dirs.push(dir);
  const seen: Seen[] = [];
  const server = createGatewayServer({
    config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec') },
    modem: new MockModemAdapter({ autoAnswerDelayMs: 0 }),
    audio: new MockAudioAdapter(),
    instanceLockDir: dir,
    ai: {
      env: aiEnv({
        AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only',
        CARTESIA_API_KEY: SECRET,
        ELEVENLABS_API_KEY: SECRET,
        MURF_API_KEY: SECRET,
        INWORLD_API_KEY: SECRET,
        DEEPGRAM_API_KEY: SECRET,
        SONIOX_API_KEY: SECRET,
        ...env,
      }),
      providers: createMockProviders({ stt: ['x'], llm: ['y'] }),
      allowSimulatedHardware: true,
      registryDir: path.join(dir, 'registry'),
      fetchImpl: async (url, init) => {
        seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        return respond(url);
      },
    },
  });
  closers.push(async () => void (await server.close()));
  const get = (url: string) => request(server.app).get(url).set('x-api-key', KEY);
  return { get, seen };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('provider voice lists', () => {
  it('Inworld: follows pages, de-duplicates by voiceId, reads language and gender, and authenticates with Basic', async () => {
    const h = await boot((url) =>
      url.includes('pageToken=p2')
        ? json({ voices: [{ voiceId: 'Ashley', displayName: 'Ashley' }, { voiceId: 'Dennis', displayName: 'Dennis', langCode: 'EN_US', tags: ['male'] }] })
        : json({ voices: [{ voiceId: 'Ashley', displayName: 'Ashley', langCode: 'EN_US', gender: 'female', description: 'warm' }], nextPageToken: 'p2' })
    );
    const res = await h.get('/api/ai/voices/inworld');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tts: 'inworld', source: 'provider', error: null });
    expect(res.body.voices).toEqual([
      { id: 'Ashley', name: 'Ashley', language: 'EN_US', gender: 'female', description: 'warm' },
      { id: 'Dennis', name: 'Dennis', language: 'EN_US', gender: 'male', description: null },
    ]);
    expect(h.seen[0].url).toMatch(/^https:\/\/api\.inworld\.ai\/voices\/v1\/voices\?pageSize=500$/);
    expect(h.seen[0].headers.Authorization).toBe(`Basic ${SECRET}`);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('Cartesia, ElevenLabs, Murf, Deepgram and Soniox: each documented shape becomes the same voice list', async () => {
    const h = await boot((url) => {
      if (url.startsWith('https://api.cartesia.ai/voices')) return json({ data: [{ id: 'uuid-1', name: 'Katie', language: 'en', gender: 'feminine', description: 'calm' }], has_more: false });
      if (url.startsWith('https://api.elevenlabs.io/v2/voices')) return json({ voices: [{ voice_id: 'el-1', name: 'Rachel', labels: { gender: 'female', accent: 'american' } }], has_more: false });
      if (url.startsWith('https://api.murf.ai/v1/speech/voices')) return json([{ voiceId: 'en-US-natalie', displayName: 'Natalie (F)', locale: 'en-US', gender: 'Female' }]);
      if (url === 'https://api.deepgram.com/v1/models') return json({ stt: [{ name: 'nova-3' }], tts: [{ name: 'thalia', canonical_name: 'aura-2-thalia-en', languages: ['en-us'], metadata: { accent: 'American', tags: ['feminine'] } }] });
      if (url.startsWith('https://api.soniox.com/v1/shared-voices')) return json({ voices: [{ id: 'Maya', gender: 'female', accent: 'american', description: 'bright' }], next_page_cursor: null });
      return json({}, 404);
    });
    const ids = async (tts: string) => (await h.get(`/api/ai/voices/${tts}`)).body;
    expect((await ids('cartesia')).voices).toEqual([{ id: 'uuid-1', name: 'Katie', language: 'en', gender: 'feminine', description: 'calm' }]);
    expect((await ids('elevenlabs')).voices).toEqual([{ id: 'el-1', name: 'Rachel', language: 'american', gender: 'female', description: null }]);
    const murf = await ids('murf_falcon_2');
    expect(murf.voices).toEqual([{ id: 'en-US-natalie', name: 'Natalie (F)', language: 'en-US', gender: 'Female', description: null }]);
    expect(h.seen.find((s) => s.url.includes('murf'))!.url).toContain(`model=${encodeURIComponent(murf.model)}`);
    expect((await ids('deepgram')).voices).toEqual([{ id: 'aura-2-thalia-en', name: 'thalia', language: 'en-us', gender: 'female', description: 'American accent' }]);
    const sx = await ids('soniox');
    expect(sx.voices).toEqual([{ id: 'Maya', name: 'Maya', language: 'american', gender: 'female', description: 'bright' }]);
    expect(h.seen.find((s) => s.url.includes('soniox'))!.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(h.seen.find((s) => s.url.includes('elevenlabs'))!.headers['xi-api-key']).toBe(SECRET);
  });

  it('a rejected key, an unreachable provider and a missing key each fall back to the built-in list with their own reason, never the key', async () => {
    const rejected = await boot(() => new Response(`bad key ${SECRET}`, { status: 401 }));
    const r = (await rejected.get('/api/ai/voices/cartesia')).body;
    expect(r).toMatchObject({ source: 'built-in', error: { kind: 'invalid-credential' } });
    expect(r.voices.length).toBeGreaterThan(0); // the built-in Cartesia voices
    expect(JSON.stringify(r)).not.toContain(SECRET);

    const down = await boot(() => {
      throw new Error(`ECONNRESET ${SECRET}`);
    });
    const d = (await down.get('/api/ai/voices/inworld')).body;
    expect(d).toMatchObject({ source: 'built-in', voices: [], error: { kind: 'unreachable' } });
    expect(JSON.stringify(d)).not.toContain(SECRET);

    const none = await boot(() => json({}), { INWORLD_API_KEY: undefined });
    expect((await none.get('/api/ai/voices/inworld')).body).toMatchObject({ source: 'built-in', error: { kind: 'no-credential', message: expect.stringMatching(/INWORLD_API_KEY/) } });
    expect(none.seen).toHaveLength(0);
  });

  it('caches the list for the same option and key, refreshes on request, and refuses an unknown option', async () => {
    const h = await boot(() => json({ voices: [{ voiceId: 'Ashley', displayName: 'Ashley' }] }));
    await h.get('/api/ai/voices/inworld');
    await h.get('/api/ai/voices/inworld');
    expect(h.seen).toHaveLength(1);
    await h.get('/api/ai/voices/inworld?refresh=1');
    expect(h.seen).toHaveLength(2);
    expect((await h.get('/api/ai/voices/nope')).status).toBe(404);
  });
});
