import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The API Keys page renders one row per credential the gateway lists: nothing is added or filtered on this side. */
const status = (name: string, source: 'missing' | 'stored' | 'env', masked: string | null = null) => ({
  name, provider: name.replace('_API_KEY', ''), requiredBySelection: false, source, masked, lastCheck: 'not-checked', lastCheckedAt: null, lastCheckDetail: null,
});
const SIX = ['MURF_API_KEY', 'TELNYX_API_KEY', 'DEEPGRAM_API_KEY', 'INWORLD_API_KEY', 'CARTESIA_API_KEY', 'SONIOX_API_KEY'];

const render = async (credentials: ReturnType<typeof status>[], canStore = true) => {
  vi.resetModules();
  vi.doMock('../src/lib/context/AiContext', () => ({
    useAi: () => ({ state: { credentials, settings: { secretStorageAvailable: canStore } }, error: null, refresh: async () => undefined }),
  }));
  const { KeysTab } = await import('../src/components/ai/KeysTab');
  return renderToStaticMarkup(React.createElement(KeysTab));
};
const rowOf = (html: string, name: string) => {
  const at = html.indexOf(`>${name}<`);
  const end = html.indexOf('</li>', at);
  return html.slice(html.lastIndexOf('<li', at), end);
};

afterEach(() => {
  vi.doUnmock('../src/lib/context/AiContext');
  vi.resetModules();
});

describe('the API Keys page', () => {
  it('shows a row for each of the six providers exactly once, with Add key for the ones with no key', async () => {
    const html = await render([
      status('DEEPGRAM_API_KEY', 'stored', 'dg-…7890'), status('GROQ_API_KEY', 'stored', 'gsk-…abcd'), status('OPENAI_API_KEY', 'missing'),
      status('TELNYX_API_KEY', 'stored', 'KEY…wxyz'), status('CARTESIA_API_KEY', 'stored', 'sk_c…1234'),
      status('MURF_API_KEY', 'missing'), status('SONIOX_API_KEY', 'missing'), status('INWORLD_API_KEY', 'missing'),
    ]);
    for (const name of SIX) expect(html.split(`>${name}<`).length - 1, name).toBe(1);
    for (const name of ['MURF_API_KEY', 'SONIOX_API_KEY', 'INWORLD_API_KEY']) {
      const row = rowOf(html, name);
      expect(row, name).toContain('Add key');
      expect(row, name).toContain('Check with provider');
      expect(row, name).not.toContain('Remove'); // nothing stored yet, so nothing to remove
    }
  });

  it('offers Update, Check and Remove once a key is stored, shows Configured, and never shows the saved key again (not even its last characters)', async () => {
    const html = await render([status('MURF_API_KEY', 'stored', 'mur…cabc'), status('SONIOX_API_KEY', 'stored', 'son…ab12')]);
    for (const name of ['MURF_API_KEY', 'SONIOX_API_KEY']) {
      const row = rowOf(html, name);
      expect(row).toContain('Update key');
      expect(row).toContain('Check with provider');
      expect(row).toContain('>Remove key<');
      expect(row).toContain('Configured');
    }
    expect(html).not.toContain('mur…cabc');
    expect(html).not.toContain('son…ab12');
    expect(html).not.toMatch(/••••/);
  });

  it('shows only what the gateway lists: an older gateway without the new providers shows no invented rows', async () => {
    const html = await render([status('DEEPGRAM_API_KEY', 'stored', 'dg-…7890'), status('CARTESIA_API_KEY', 'missing')]);
    expect(html).not.toContain('MURF_API_KEY');
    expect(html).not.toContain('SONIOX_API_KEY');
    expect(html).not.toContain('INWORLD_API_KEY');
  });
});
