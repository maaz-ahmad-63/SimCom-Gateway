import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageNoticeView } from '../src/components/ai/StorageNotice';
import { credentialBadges, isUnreadable } from '../src/lib/ai-secrets';
import { fetchSupervisorSecrets, storageNotice, SupervisorSecrets } from '../src/lib/secret-storage';

/**
 * Customers add, update and remove API keys in the dashboard and never edit a file. When keys cannot be saved, the message says why in
 * plain words, with what to do, and never tells a customer to edit .env.
 */
const sup = (over: Partial<SupervisorSecrets> = {}): SupervisorSecrets => ({ state: 'ok', usable: true, message: 'Saved API keys are encrypted with this PC\'s key.', action: null, file: 'C:\\ProgramData\\SimGatewaySecrets\\master.key', ...over });

describe('what the customer is told when keys cannot be saved', () => {
  it('says nothing when keys can be saved', () => {
    expect(storageNotice({ storageAvailable: true, supervisor: sup() })).toBeNull();
    expect(storageNotice({ storageAvailable: true, supervisor: null })).toBeNull(); // development with a key in .env
  });

  it('explains a missing, unreadable or damaged key file with what to do, in the installed product', () => {
    const missing = storageNotice({ storageAvailable: false, supervisor: sup({ state: 'missing_with_saved_keys', usable: false, message: 'SIZH IT Solution\'s encryption key file is missing, but API keys were saved earlier.', action: 'Restore it from a backup, or reset the key storage (Start menu: "Reset saved API keys").' }) })!;
    expect(missing).toMatchObject({ tone: 'bad', title: 'The encryption key for your saved API keys is missing' });
    expect(missing.action).toMatch(/Reset saved API keys/);
    expect(storageNotice({ storageAvailable: false, supervisor: sup({ state: 'unreadable', usable: false }) })!.title).toBe('SIZH IT Solution cannot read its encryption key');
    expect(storageNotice({ storageAvailable: false, supervisor: sup({ state: 'invalid', usable: false }) })!.title).toBe('The encryption key for your saved API keys is damaged');
    expect(storageNotice({ storageAvailable: false, supervisor: sup({ state: 'cannot_protect', usable: false }) })!.tone).toBe('bad');
    for (const state of ['missing_with_saved_keys', 'unreadable', 'invalid', 'cannot_protect', 'cannot_create']) {
      const n = storageNotice({ storageAvailable: false, supervisor: sup({ state, usable: false, message: 'm', action: 'a' }) })!;
      expect(`${n.title} ${n.message} ${n.action}`, state).not.toMatch(/\.env|AI_SECRETS_MASTER_KEY/);
    }
  });

  it('asks for a restart when the key exists but the gateway started without it', () => {
    const n = storageNotice({ storageAvailable: false, supervisor: sup() })!;
    expect(n).toMatchObject({ tone: 'warn', title: 'Saving API keys is not active yet' });
    expect(n.action).toMatch(/Stop SIZH IT Solution/);
  });

  it('keeps the developer hint only when there is no supervisor (a development setup)', () => {
    const n = storageNotice({ storageAvailable: false, supervisor: null })!;
    expect(n.title).toBe('Key storage is off');
    expect(n.action).toContain('AI_SECRETS_MASTER_KEY');
    expect(n.message).toMatch(/installed product creates one by itself/);
  });

  it('draws the notice, or nothing', () => {
    expect(renderToStaticMarkup(React.createElement(StorageNoticeView, { notice: null }))).toBe('');
    const html = renderToStaticMarkup(React.createElement(StorageNoticeView, { notice: storageNotice({ storageAvailable: false, supervisor: sup({ state: 'invalid', usable: false, message: 'File damaged.', action: 'Restore it.' }) }) }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('File damaged.');
    expect(html).toContain('What to do: Restore it.');
    expect(html).toContain('data-tone="bad"');
  });
});

describe('reading the supervisor status', () => {
  const answer = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response) as unknown as typeof fetch;
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the status page of the computer the dashboard came from, and returns only the key state', async () => {
    const f = answer({ gateway: {}, secrets: { state: 'created', usable: true, message: 'ok', action: null, file: 'C:\\x\\master.key' } });
    expect(await fetchSupervisorSecrets('127.0.0.1', f)).toEqual({ state: 'created', usable: true, message: 'ok', action: null, file: 'C:\\x\\master.key' });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://127.0.0.1:4010/status');
    await fetchSupervisorSecrets('::1', f);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('http://[::1]:4010/status');
  });

  it('returns null when there is no supervisor, an old one, or garbage', async () => {
    expect(await fetchSupervisorSecrets('127.0.0.1', vi.fn(async () => { throw new Error('refused'); }) as unknown as typeof fetch)).toBeNull();
    expect(await fetchSupervisorSecrets('127.0.0.1', answer({ gateway: {} }))).toBeNull();
    expect(await fetchSupervisorSecrets('127.0.0.1', answer({ secrets: { state: 5 } }))).toBeNull();
    expect(await fetchSupervisorSecrets('127.0.0.1', answer({}, false))).toBeNull();
  });
});

describe('Configured / Not configured, and never the key', () => {
  const cred = (over: Record<string, unknown>) => ({ name: 'GROQ_API_KEY', provider: 'Groq', requiredBySelection: false, source: 'missing', masked: null, lastCheck: 'not-checked', lastCheckedAt: null, lastCheckDetail: null, ...over }) as never;

  it('shows Configured for a saved key without any of its characters, even if the gateway sends a mask', () => {
    const b = credentialBadges(cred({ source: 'stored', masked: '••••WXYZ' }));
    expect(b.presence).toEqual({ label: 'Configured', tone: 'good' });
    expect(JSON.stringify(b)).not.toContain('WXYZ');
  });

  it('shows Not configured when there is no key, and flags a saved key that can no longer be read', () => {
    expect(credentialBadges(cred({})).presence.label).toBe('Not configured');
    const unreadable = cred({ lastCheckDetail: 'A stored key exists but cannot be decrypted (AI_SECRETS_MASTER_KEY missing or changed); store it again' });
    expect(isUnreadable(unreadable)).toBe(true);
    expect(credentialBadges(unreadable).presence).toEqual({ label: 'Saved key unreadable', tone: 'bad' });
    expect(credentialBadges(unreadable).check.label).toBe('Enter the key again');
    expect(isUnreadable(cred({ source: 'stored', lastCheckDetail: 'cannot be decrypted' }))).toBe(false);
  });

  it('keeps a key from .env working and labelled for development', () => {
    expect(credentialBadges(cred({ source: 'env' })).presence.label).toBe('Configured (from .env)');
  });
});
