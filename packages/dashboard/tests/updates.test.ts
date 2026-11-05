import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastResultNotice, summarize, UpdateView, updateApi } from '../src/lib/updates';
import { relayUpdate, UI_HEADER } from '../src/lib/server/update-proxy';

const view = (over: Partial<UpdateView> = {}): UpdateView => ({
  configured: true,
  currentVersion: '0.1.2',
  phase: 'idle',
  checkedAt: null,
  available: null,
  error: null,
  lastResult: null,
  canApply: true,
  cannotApplyReason: null,
  ...over,
});

describe('what the dashboard says about updates', () => {
  it('says there is nothing to do, that one is available, or that setup is missing', () => {
    expect(summarize(view()).title).toMatch(/latest version/);
    expect(summarize(view({ available: { version: '0.2.0', publishedAt: '', size: 1 }, phase: 'available' }))).toMatchObject({ tone: 'good', title: 'Version 0.2.0 is available' });
    expect(summarize(view({ configured: false })).title).toMatch(/not set up/);
    expect(summarize(view({ error: { code: 'BAD_SIGNATURE', message: 'not signed' } }))).toMatchObject({ tone: 'bad', detail: 'not signed' });
    expect(summarize(view({ phase: 'installing' })).title).toMatch(/Installing/);
  });
  it('always reports an undone update, and confirms a finished one only once the new version is running', () => {
    const rolled = { outcome: 'rolled_back' as const, fromVersion: '0.1.2', toVersion: '0.2.0', at: '', reason: 'The new version did not become healthy in time.' };
    expect(lastResultNotice(rolled, '0.1.2')).toMatchObject({ tone: 'warn' });
    expect(lastResultNotice(rolled, '0.1.2')?.detail).toMatch(/nothing was lost/);
    const done = { outcome: 'updated' as const, fromVersion: '0.1.2', toVersion: '0.2.0', at: '' };
    expect(lastResultNotice(done, '0.2.0')?.title).toMatch(/Updated to version 0.2.0/);
    expect(lastResultNotice(done, '0.1.2')).toBeNull();
    expect(lastResultNotice(null, '0.1.2')).toBeNull();
  });
  it('sends the dashboard header and a JSON body, and turns a failure into a sentence', async () => {
    const seen: RequestInit[] = [];
    const api = updateApi((async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ success: false, code: 'CALL_IN_PROGRESS', error: 'A call is in progress.', update: view() }), { status: 409 });
    }) as unknown as typeof fetch);
    const r = await api.apply();
    expect(r).toMatchObject({ ok: false, code: 'CALL_IN_PROGRESS', message: 'A call is in progress.' });
    expect((seen[0].headers as Record<string, string>)[UI_HEADER]).toBe('1');
    expect((seen[0].headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});

describe('the update relay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-proxy-'));
  const tokenFile = path.join(dir, 'supervisor.token');
  fs.writeFileSync(tokenFile, 'secret-token');
  const env = { SIMGW_SUPERVISOR_URL: 'http://127.0.0.1:4010', SIMGW_SUPERVISOR_TOKEN_FILE: tokenFile } as unknown as NodeJS.ProcessEnv;
  const post = (headers: Record<string, string> = {}) =>
    new Request('http://localhost:3000/api/update/check', { method: 'POST', headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json', [UI_HEADER]: '1', ...headers }, body: '{}' });

  it('is absent outside the installed product', async () => {
    const res = await relayUpdate(post(), 'check', {} as unknown as NodeJS.ProcessEnv);
    expect(res.status).toBe(404);
  });
  it('refuses another computer, a missing dashboard header and another site, without calling the supervisor', async () => {
    let calls = 0;
    const f = (async () => void calls++) as unknown as typeof fetch;
    expect((await relayUpdate(post({ host: '192.168.1.20:3000', origin: 'http://192.168.1.20:3000' }), 'check', env, f)).status).toBe(403);
    expect((await relayUpdate(post({ [UI_HEADER]: '0' }), 'check', env, f)).status).toBe(403);
    expect((await relayUpdate(post({ origin: 'http://evil.example' }), 'check', env, f)).status).toBe(403);
    expect(calls).toBe(0);
  });
  it('forwards a valid request with the token, and never returns the token to the browser', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify({ success: true, update: view() }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await relayUpdate(post(), 'check', env, f);
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({ url: 'http://127.0.0.1:4010/update/check', headers: { 'x-supervisor-token': 'secret-token' } });
    expect(await res.text()).not.toContain('secret-token');
  });
  it('says so plainly when the supervisor is not running', async () => {
    const f = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const res = await relayUpdate(post(), 'check', env, f);
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/did not answer/);
  });
});
