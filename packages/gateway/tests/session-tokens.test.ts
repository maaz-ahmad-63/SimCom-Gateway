import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { isLoopbackAddress, SessionTokens } from '../src/api/middleware/session-tokens.js';
import { createGatewayServer, GatewayServerInstance } from '../src/server.js';

/** Local session tokens: the installed dashboard's server trades the API key for a short-lived token; the browser holds only the token. */

const KEY = 'session-token-test-master-key-0123456789';

describe('SessionTokens', () => {
  it('issues random tokens that verify until they expire, keeps only their hash, and refuses anything else', () => {
    let t = 1_000_000;
    const s = new SessionTokens(60_000, () => t);
    const a = s.issue();
    const b = s.issue();
    expect(a.token).toMatch(/^st_[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(s.verify(a.token)).toBe(true);
    expect(s.verify(a.token.slice(0, -1) + (a.token.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(s.verify(KEY)).toBe(false);
    expect(s.verify(undefined)).toBe(false);
    expect(JSON.stringify([...(s as any).tokens.keys()])).not.toContain(a.token.slice(3));
    t += 60_001;
    expect(s.verify(a.token)).toBe(false);
  });

  it('knows a loopback caller', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.5.5.5']) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ['192.168.1.50', '::ffff:10.0.0.2', '8.8.8.8', '', undefined]) expect(isLoopbackAddress(a), String(a)).toBe(false);
  });
});

const servers: GatewayServerInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function boot(sessionTokens?: SessionTokens, port?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-'));
  dirs.push(dir);
  const server = createGatewayServer({
    config: { ...(port ? { port, host: '127.0.0.1' } : {}), modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec') },
    modem: new MockModemAdapter({ autoAnswerDelayMs: 0 }),
    audio: new MockAudioAdapter(),
    instanceLockDir: dir,
    sessionTokens,
  });
  servers.push(server);
  return server;
}
const mint = (s: GatewayServerInstance, key = KEY) => request(s.app).post('/api/auth/session').set('x-api-key', key);

describe('POST /api/auth/session and using the token', () => {
  it('mints only with the master key; the token works for REST but cannot mint another', async () => {
    const s = boot();
    const res = await mint(s);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, token: expect.stringMatching(/^st_/), expiresAt: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    const token = res.body.token as string;
    expect((await request(s.app).get('/api/gateway/health').set('x-api-key', token)).status).toBe(200);
    expect((await request(s.app).get('/api/gateway/health').set('authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await mint(s, token)).status).toBe(403); // a token is not the master key
    expect((await mint(s, 'wrong-key-wrong-key-wrong')).status).toBe(401);
    expect((await request(s.app).get('/api/gateway/health')).status).toBe(401);
  });

  it('an expired token is refused (401), and a new one works', async () => {
    let t = Date.now();
    const s = boot(new SessionTokens(1000, () => t));
    const token = (await mint(s)).body.token as string;
    expect((await request(s.app).get('/api/gateway/health').set('x-api-key', token)).status).toBe(200);
    t += 1001;
    expect((await request(s.app).get('/api/gateway/health').set('x-api-key', token)).status).toBe(401);
    const fresh = (await mint(s)).body.token as string;
    expect((await request(s.app).get('/api/gateway/health').set('x-api-key', fresh)).status).toBe(200);
  });

  it('a gateway restart ends every session (tokens live only in memory)', async () => {
    const first = boot();
    const token = (await mint(first)).body.token as string;
    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const second = boot();
    expect((await request(second.app).get('/api/gateway/health').set('x-api-key', token)).status).toBe(401);
  });

  it('repeated failures are still limited (the token goes through the same limiter), and a valid token clears the count', async () => {
    const s = boot();
    const token = (await mint(s)).body.token as string;
    for (let i = 0; i < 5; i++) expect((await request(s.app).get('/api/gateway/health').set('x-api-key', 'st_' + '0'.repeat(64))).status).toBe(401);
    expect((await request(s.app).get('/api/gateway/health').set('x-api-key', token)).status).toBe(200); // below the limit: clears it
    for (let i = 0; i < 20; i++) await request(s.app).get('/api/gateway/health').set('x-api-key', 'bad-' + i);
    const blocked = await request(s.app).get('/api/gateway/health').set('x-api-key', token);
    expect(blocked.status).toBe(429); // the limit applies to every credential from that client, as before
    expect(blocked.body.code).toBe('RATE_LIMITED');
  });

  it('the live connection accepts a session token and refuses a bad one', async () => {
    const port = 41000 + Math.floor(Math.random() * 8000);
    const s = boot(undefined, port);
    await s.start();
    const token = (await mint(s)).body.token as string;
    const connect = (auth: string) =>
      new Promise<string>((resolve) => {
        const c = ioClient(`http://127.0.0.1:${port}`, { auth: { token: auth }, transports: ['websocket'], reconnection: false, timeout: 4000 });
        c.on('connect', () => {
          c.close();
          resolve('connected');
        });
        c.on('connect_error', (e) => {
          c.close();
          resolve(`refused: ${e.message}`);
        });
      });
    expect(await connect(token)).toBe('connected');
    expect(await connect('st_' + 'f'.repeat(64))).toMatch(/^refused: Unauthorized/);
    expect(await connect(KEY)).toBe('connected'); // the master key keeps working (supervisor, remote dashboards)
  });
});
