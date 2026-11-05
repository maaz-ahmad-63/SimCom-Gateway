import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { defaultIvrConfig, IvrConfig } from '../../src/ivr/config.js';
import { sha256, wav, wavWithListChunk } from './helpers.js';

const KEY = 'test-secret-ivr-api-12345';
const open: GatewayServerInstance[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

function boot(extra: { dbPath?: string; ivrDir?: string | null } = {}) {
  const server = createGatewayServer({
    config: { gatewayApiKey: KEY, ...(extra.dbPath ? { sqliteDbPath: extra.dbPath } : {}) },
    modem: new MockModemAdapter({ autoAnswerDelayMs: 0, ringIntervalMs: 50 }),
    ...(extra.dbPath ? {} : { db: new Database(':memory:') }),
    ...(extra.ivrDir !== undefined ? { ivr: { dir: extra.ivrDir } } : {}),
  });
  open.push(server);
  const api = (method: 'get' | 'post' | 'put' | 'delete', url: string) => request(server.app)[method](url).set('x-api-key', KEY);
  const upload = (file: Buffer, name = 'clip', type = 'audio/wav') => api('post', `/api/ivr/assets?name=${encodeURIComponent(name)}`).set('Content-Type', type).send(file);
  return { server, api, upload };
}

/** Upload the six announcements and return a complete, publishable configuration that uses them. */
async function completeConfig(upload: ReturnType<typeof boot>['upload']): Promise<IvrConfig> {
  const id = async (name: string, tone: number) => (await upload(wav({ ms: 600, tone }), name)).body.asset.id as string;
  const [welcome, menu, invalid, timeout, info, bye] = [await id('welcome', 300), await id('menu', 400), await id('invalid', 500), await id('timeout', 600), await id('info', 700), await id('bye', 800)];
  return {
    ...defaultIvrConfig(),
    welcome: { assetId: welcome },
    menu: { assetId: menu },
    invalid: { assetId: invalid },
    timeout: { assetId: timeout },
    options: [
      { key: '1', label: 'AI assistant', action: { type: 'connect-ai' } },
      { key: '2', label: 'Hours', action: { type: 'play-announcement', assetId: info, then: 'return-to-menu' } },
      { key: '3', label: 'Repeat', action: { type: 'repeat-menu' } },
      { key: '9', label: 'Goodbye', action: { type: 'hang-up', goodbyeAssetId: bye } },
    ],
    finalAction: { type: 'hang-up', goodbyeAssetId: bye },
  };
}

describe('authentication and wiring', () => {
  it('every IVR route needs the API key, like the rest of /api', async () => {
    const { server } = boot();
    const calls: Array<[string, string]> = [['get', '/api/ivr'], ['put', '/api/ivr/draft'], ['delete', '/api/ivr/draft'], ['post', '/api/ivr/validate'], ['post', '/api/ivr/publish'], ['put', '/api/ivr/enabled'], ['get', '/api/ivr/assets'], ['post', '/api/ivr/assets'], ['get', `/api/ivr/assets/${'a'.repeat(64)}/audio`], ['delete', `/api/ivr/assets/${'a'.repeat(64)}`]];
    for (const [method, url] of calls) {
      const res = await (request(server.app) as unknown as Record<string, (u: string) => request.Test>)[method](url);
      expect(res.status, `${method} ${url}`).toBe(401);
    }
    expect((await request(server.app).get('/api/ivr').set('x-api-key', 'wrong')).status).toBe(401);
  });

  it('existing endpoints are unaffected', async () => {
    const { api } = boot();
    expect((await api('get', '/api/gateway/health')).status).toBe(200);
    expect((await api('get', '/api/calls')).status).toBe(200);
  });

  it('the IVR is off and empty by default, and the server exposes no snapshot', async () => {
    const { api, server } = boot();
    const res = await api('get', '/api/ivr');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      status: { enabled: false, publishedVersion: 0, hasSavedDraft: false },
      published: null,
      draft: defaultIvrConfig(),
      assets: [],
      audio: { sampleRate: 8000, persistent: false },
      limits: { keys: expect.arrayContaining(['0', '*', '#']), actions: ['connect-ai', 'play-announcement', 'repeat-menu', 'hang-up'], finalActions: ['connect-ai', 'hang-up'] },
    });
    expect(res.body.validation.ok).toBe(false);
    expect(server.ivrStore.snapshot()).toBeNull();
  });
});

describe('audio assets', () => {
  it('uploads a WAV (201), serves back the identical bytes for preview, and lists it', async () => {
    const { api, upload } = boot();
    const file = wav({ ms: 900, tone: 250 });
    const res = await upload(file, 'Welcome message');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, duplicate: false, asset: { id: sha256(file), name: 'Welcome message', durationMs: 900, sampleRate: 8000 } });
    const audio = await api('get', `/api/ivr/assets/${res.body.asset.id}/audio`).buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on('data', (c: Buffer) => parts.push(c));
      r.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect(audio.status).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/wav');
    expect(audio.headers['cache-control']).toContain('immutable');
    expect((audio.body as Buffer).equals(file)).toBe(true);
    expect((await api('get', '/api/ivr/assets')).body.assets).toHaveLength(1);
  });

  it('the same audio again is a 200 duplicate with the original name, and is stored once', async () => {
    const { upload, api } = boot();
    const file = wav({ tone: 123 });
    await upload(file, 'first name');
    const again = await upload(Buffer.from(file), 'second name');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, asset: { name: 'first name' } });
    expect((await api('get', '/api/ivr/assets')).body.assets).toHaveLength(1);
  });

  it('a WAV with LIST metadata is accepted and served back exactly as uploaded', async () => {
    const { upload, api } = boot();
    const file = wavWithListChunk();
    const res = await upload(file, 'tagged');
    expect(res.status).toBe(201);
    expect(res.body.asset.id).toBe(sha256(file));
    const audio = await api('get', `/api/ivr/assets/${res.body.asset.id}/audio`).buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on('data', (c: Buffer) => parts.push(c));
      r.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect((audio.body as Buffer).equals(file)).toBe(true);
  });

  it('refuses unsuitable audio with 422, a code, and every reason in details', async () => {
    const { upload } = boot();
    const res = await upload(wav({ rate: 44100, channels: 2 }), 'bad');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ success: false, code: 'IVR_INVALID_ASSET', error: expect.stringContaining('cannot be used') });
    expect(res.body.details).toHaveLength(2);
    expect(res.body.details[0]).toEqual({ path: 'file', message: expect.any(String) });
  });

  it('needs a name, and the file as the body with an audio content type', async () => {
    const { upload, api } = boot();
    expect((await api('post', '/api/ivr/assets').set('Content-Type', 'audio/wav').send(wav())).status).toBe(422);
    const wrongType = await api('post', '/api/ivr/assets?name=x').set('Content-Type', 'application/json').send({ file: 'no' });
    expect(wrongType.status).toBe(415);
    expect(wrongType.body.code).toBe('IVR_INVALID_ASSET');
    expect((await upload(Buffer.alloc(0), 'empty')).status).toBe(422);
  });

  it('a file just over the limit gets the specific 413; a far bigger body is cut off with the same code', async () => {
    const { upload } = boot();
    const over = await upload(Buffer.alloc(4 * 1024 * 1024 + 100_000), 'big');
    expect(over.status).toBe(413);
    expect(over.body.code).toBe('IVR_INVALID_ASSET');
    expect(over.body.error).toContain('limit is 4 MB');
    const huge = await upload(Buffer.alloc(6 * 1024 * 1024), 'huge');
    expect(huge.status).toBe(413);
    expect(huge.body.code).toBe('IVR_INVALID_ASSET');
  });

  it('the JSON size limit everywhere else is unchanged', async () => {
    const { api } = boot();
    const res = await api('put', '/api/ivr/draft').send({ pad: 'x'.repeat(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('serving or deleting audio that does not exist, or an id that is not a hash, is a 404', async () => {
    const { api } = boot();
    for (const id of ['a'.repeat(64), 'short', '..%2F..%2Fetc']) {
      expect((await api('get', `/api/ivr/assets/${id}/audio`)).status, id).toBe(404);
      expect((await api('delete', `/api/ivr/assets/${id}`)).status, id).toBe(404);
    }
  });
});

describe('draft, validate, publish, enable', () => {
  it('saves a draft that may be incomplete, and reads it back with its validation', async () => {
    const { api } = boot();
    const saved = await api('put', '/api/ivr/draft').send({ ...defaultIvrConfig(), maxRetries: 4 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ success: true, draft: { maxRetries: 4 }, status: { hasSavedDraft: true, unpublishedChanges: true } });
    expect(saved.body.validation.ok).toBe(false);
    expect((await api('get', '/api/ivr')).body.draft.maxRetries).toBe(4);
  });

  it('refuses a draft that does not match the model with 422 and paths', async () => {
    const { api } = boot();
    const res = await api('put', '/api/ivr/draft').send({ ...defaultIvrConfig(), maxRetries: 50, options: [{ key: 'Q', label: 'x', action: { type: 'submenu' } }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('IVR_INVALID_CONFIG');
    expect(res.body.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['maxRetries', 'options[0].key']));
    expect((await api('get', '/api/ivr')).body.status.hasSavedDraft).toBe(false);
  });

  it('discarding the draft goes back to the published configuration (or the empty one)', async () => {
    const { api } = boot();
    await api('put', '/api/ivr/draft').send({ ...defaultIvrConfig(), maxRetries: 4 });
    const res = await api('delete', '/api/ivr/draft');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ draft: defaultIvrConfig(), status: { hasSavedDraft: false } });
  });

  it('validate checks a body, or the saved draft when there is none, and changes nothing', async () => {
    const { api, upload } = boot();
    const config = await completeConfig(upload);
    expect((await api('post', '/api/ivr/validate').send(config)).body.validation.ok).toBe(true);
    expect((await api('post', '/api/ivr/validate').send({})).body.validation.ok).toBe(false); // the (empty) saved draft
    const dup = { ...config, options: [...config.options, { key: '1', label: 'dup', action: { type: 'repeat-menu' } }] };
    const res = await api('post', '/api/ivr/validate').send(dup);
    expect(res.body.validation.ok).toBe(false);
    expect(res.body.validation.errors[0].path).toBe('options[4].key');
    expect((await api('get', '/api/ivr')).body.status.hasSavedDraft).toBe(false);
  });

  it('refuses to publish an incomplete draft (422, what is wrong), and nothing is published', async () => {
    const { api } = boot();
    await api('put', '/api/ivr/draft').send(defaultIvrConfig());
    const res = await api('post', '/api/ivr/publish');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('IVR_INVALID_CONFIG');
    expect(res.body.details.length).toBeGreaterThan(0);
    expect((await api('get', '/api/ivr')).body.published).toBeNull();
  });

  it('publish with no saved draft is a 409', async () => {
    const { api } = boot();
    const res = await api('post', '/api/ivr/publish');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IVR_INVALID_CONFIG');
  });

  it('publishes a complete draft as version 1, then 2; the IVR stays off until it is switched on', async () => {
    const { api, upload, server } = boot();
    const config = await completeConfig(upload);
    await api('put', '/api/ivr/draft').send(config);
    const first = await api('post', '/api/ivr/publish');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ success: true, published: { version: 1, config }, status: { enabled: false, publishedVersion: 1, unpublishedChanges: false } });
    await api('put', '/api/ivr/draft').send({ ...config, maxRetries: 4 });
    expect((await api('post', '/api/ivr/publish')).body.published.version).toBe(2);
    expect(server.ivrStore.snapshot()).toBeNull(); // published but not enabled
  });

  it('enabling needs a published configuration (409); the body is checked strictly; on and off persist', async () => {
    const { api, upload, server } = boot();
    const early = await api('put', '/api/ivr/enabled').send({ enabled: true });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('IVR_NOT_PUBLISHED');
    await api('put', '/api/ivr/draft').send(await completeConfig(upload));
    await api('post', '/api/ivr/publish');
    expect((await api('put', '/api/ivr/enabled').send({ enabled: 'yes' })).status).toBe(400);
    expect((await api('put', '/api/ivr/enabled').send({ enabled: true, extra: 1 })).status).toBe(400);
    expect((await api('put', '/api/ivr/enabled').send({})).status).toBe(400);
    const on = await api('put', '/api/ivr/enabled').send({ enabled: true });
    expect(on.body).toMatchObject({ success: true, enabled: true, status: { enabled: true } });
    expect(server.ivrStore.snapshot()?.version).toBe(1);
    expect((await api('put', '/api/ivr/enabled').send({ enabled: false })).body.enabled).toBe(false);
    expect(server.ivrStore.snapshot()).toBeNull();
  });
});

describe('deleting audio', () => {
  it('is refused (409) while a draft or the published configuration uses it, and allowed afterwards', async () => {
    const { api, upload } = boot();
    const config = await completeConfig(upload);
    const info = (config.options[1].action as { assetId: string }).assetId;
    await api('put', '/api/ivr/draft').send(config);
    const blocked = await api('delete', `/api/ivr/assets/${info}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('IVR_ASSET_IN_USE');
    await api('post', '/api/ivr/publish');
    const without = { ...config, options: config.options.filter((o) => o.action.type !== 'play-announcement') };
    await api('put', '/api/ivr/draft').send(without);
    expect((await api('delete', `/api/ivr/assets/${info}`)).body.code).toBe('IVR_ASSET_IN_USE'); // the published one still needs it
    await api('post', '/api/ivr/publish');
    const ok = await api('delete', `/api/ivr/assets/${info}`);
    expect(ok.status).toBe(200);
    expect(ok.body.assets.map((a: { id: string }) => a.id)).not.toContain(info);
  });
});

describe('a restart (real database file and audio folder)', () => {
  it('keeps the audio, the draft, the published version and the on/off switch', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ivr-api-'));
    const dbPath = path.join(base, 'gateway.sqlite');
    const ivrDir = path.join(base, 'ivr');
    try {
      const first = boot({ dbPath, ivrDir });
      expect((await first.api('get', '/api/ivr')).body.audio.persistent).toBe(true);
      const config = await completeConfig(first.upload);
      await first.api('put', '/api/ivr/draft').send(config);
      await first.api('post', '/api/ivr/publish');
      await first.api('put', '/api/ivr/enabled').send({ enabled: true });
      const welcome = config.welcome.assetId!;
      await open.pop()!.close();

      const second = boot({ dbPath, ivrDir });
      const res = await second.api('get', '/api/ivr');
      expect(res.body.status).toMatchObject({ enabled: true, publishedVersion: 1, hasSavedDraft: true, problems: [] });
      expect(res.body.published.config).toEqual(config);
      expect(res.body.assets).toHaveLength(6);
      expect(fs.readdirSync(ivrDir).filter((f) => f.endsWith('.wav'))).toHaveLength(6);
      expect(second.server.ivrStore.snapshot()?.pcm(welcome)?.length).toBe(600 * 16);
    } finally {
      while (open.length) await open.pop()!.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('with no audio folder yet, the first upload creates it', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ivr-api-'));
    try {
      const ivrDir = path.join(base, 'ivr');
      const { api, upload } = boot({ ivrDir });
      expect((await api('get', '/api/ivr')).status).toBe(200);
      expect(fs.existsSync(ivrDir)).toBe(false);
      await upload(wav(), 'first');
      expect(fs.existsSync(ivrDir)).toBe(true);
    } finally {
      while (open.length) await open.pop()!.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
