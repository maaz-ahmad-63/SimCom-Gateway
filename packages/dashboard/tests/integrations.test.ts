import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiSettingsView } from '@sim-gateway/shared';
import { GatewayApiClient } from '../src/lib/api-client';
import { buildSettingsPatch, draftFromSettings, validateDraft } from '../src/lib/ai-settings-form';
import { keyFileProblem, modelToolsNote, sheetsPatch, SheetsConfig, SheetsStatus, SheetsTestResult, spreadsheetIdFrom, tabNameProblem, validateSheetsDraft } from '../src/lib/integrations';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const config = (over: Partial<SheetsConfig> = {}): SheetsConfig => ({ enabled: false, spreadsheetId: '', sheetName: 'Calls', inboundTools: true, outboundTools: true, logOutcomes: false, ...over });
const status = (over: Partial<SheetsStatus> = {}): SheetsStatus => ({
  config: config(),
  credential: { stored: false, serviceAccountEmail: null, undecryptable: false },
  secretStorageAvailable: true,
  lastTest: null,
  columns: ['record_key', 'recorded_at', 'type'],
  modelTools: { model: 'openai_gpt_5_4_mini', provider: 'openai', supported: true },
  ...over,
});
const PRIVATE = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwgg\n-----END PRIVATE KEY-----\n';
const keyFile = (over: Record<string, unknown> = {}) => JSON.stringify({ type: 'service_account', client_email: 'bot@proj.iam.gserviceaccount.com', private_key: PRIVATE, ...over });

describe('Google Sheets settings helpers', () => {
  it('takes the spreadsheet ID from a pasted link or a bare ID, and leaves anything else for the validator', () => {
    expect(spreadsheetIdFrom(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)).toBe(ID);
    expect(spreadsheetIdFrom(`  ${ID}  `)).toBe(ID);
    expect(spreadsheetIdFrom('not a sheet')).toBe('not a sheet');
  });

  it('validates the settings before Save, and what is needed to turn it on', () => {
    expect(validateSheetsDraft(config(), false)).toEqual([]);
    expect(validateSheetsDraft(config({ spreadsheetId: 'short' }), true)[0]).toMatch(/does not look right/);
    expect(validateSheetsDraft(config({ enabled: true }), true)).toEqual(['Enter the spreadsheet before turning this on']);
    expect(validateSheetsDraft(config({ enabled: true, spreadsheetId: ID }), false)).toEqual(['Store the service account key before turning this on']);
    expect(validateSheetsDraft(config({ enabled: true, spreadsheetId: ID }), true)).toEqual([]);
    expect(validateSheetsDraft(config({ sheetName: '' }), true)).toEqual(['Enter the tab name (for example Calls)']);
    expect(tabNameProblem('a/b')).toMatch(/cannot contain/);
    expect(tabNameProblem('x'.repeat(101))).toMatch(/100/);
    expect(tabNameProblem('Leads 2026')).toBeNull();
  });

  it('sends only what changed', () => {
    expect(sheetsPatch(config(), config())).toEqual({});
    expect(sheetsPatch(config(), config({ enabled: true, logOutcomes: true }))).toEqual({ enabled: true, logOutcomes: true });
  });

  it('catches an obviously wrong key file without ever repeating its text', () => {
    expect(keyFileProblem('')).toBeNull();
    expect(keyFileProblem(keyFile())).toBeNull();
    for (const [text, expected] of [
      ['not json', /not valid JSON/],
      [JSON.stringify({ installed: { client_secret: 'SECRET-VALUE-123' } }), /not a service account key/],
      [keyFile({ client_email: 'nope' }), /no client_email/],
      [keyFile({ private_key: 'SECRET-VALUE-123' }), /no private_key/],
    ] as const) {
      const message = keyFileProblem(text);
      expect(message).toMatch(expected);
      expect(message).not.toContain('SECRET-VALUE-123');
      expect(message).not.toContain('MIIEvQ');
    }
  });

  it('says plainly when the selected model cannot be given tools, instead of letting a switch do nothing', () => {
    expect(modelToolsNote({ model: 'openai_gpt_5_4_mini', provider: 'openai', supported: true }, true)).toMatchObject({ tone: 'good' });
    const off = modelToolsNote({ model: 'telnyx_kimi_k3', provider: 'telnyx', supported: false }, true);
    expect(off.tone).toBe('warn');
    expect(off.text).toMatch(/not known to support function calling/);
    expect(off.text).toMatch(/still collected and confirmed by voice/);
    expect(modelToolsNote({ model: 'telnyx_kimi_k3', provider: 'telnyx', supported: false }, false).tone).toBe('neutral');
  });

  it('warns, and never claims support, when the model status is missing or malformed', () => {
    for (const bad of [undefined, null, {} as never, { model: 'x', provider: null } as never]) {
      for (const on of [true, false]) {
        const note = modelToolsNote(bad, on);
        expect(note.tone).toBe('warn');
        expect(note.text).toMatch(/cannot be confirmed/);
        expect(note.text).not.toMatch(/supports function calling\./);
      }
    }
  });
});

describe('the gateway client for integrations', () => {
  const original = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  });
  afterEach(() => {
    global.fetch = original;
  });
  const client = () => new GatewayApiClient({ gatewayUrl: 'http://127.0.0.1:4000', apiKey: 'dashboard-test-key-123' });
  const last = () => {
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    return { url: String(url), init: init as RequestInit };
  };

  it('uses the integrations endpoints with the API key, and sends the key file only in the body of one PUT', async () => {
    await client().getGoogleSheets();
    expect(last()).toMatchObject({ url: 'http://127.0.0.1:4000/api/integrations/google-sheets' });
    await client().saveGoogleSheets({ enabled: true });
    expect(last().init).toMatchObject({ method: 'PUT', body: JSON.stringify({ enabled: true }) });
    await client().saveGoogleSheetsCredential(keyFile());
    expect(last().url).toBe('http://127.0.0.1:4000/api/integrations/google-sheets/credential');
    expect(last().init.method).toBe('PUT');
    expect(JSON.parse(String(last().init.body))).toEqual({ serviceAccountJson: keyFile() });
    await client().deleteGoogleSheetsCredential();
    expect(last().init.method).toBe('DELETE');
    await client().testGoogleSheets();
    expect(last()).toMatchObject({ url: 'http://127.0.0.1:4000/api/integrations/google-sheets/test' });
    expect(last().init.method).toBe('POST');
    expect((last().init.headers as Record<string, string>)['x-api-key']).toBe('dashboard-test-key-123');
    // The key file never appears in a URL.
    for (const [url] of (global.fetch as ReturnType<typeof vi.fn>).mock.calls) expect(String(url)).not.toContain('PRIVATE');
  });
});

describe('the Google Sheets cards', () => {
  const credentialCard = async (s: SheetsStatus) => {
    vi.resetModules();
    const { CredentialCard } = await import('../src/components/ai/IntegrationsTab');
    return renderToStaticMarkup(React.createElement(CredentialCard, { status: s, onChange: () => undefined }));
  };

  it('with no key: a paste box, the setup steps, and no key shown anywhere', async () => {
    const html = await credentialCard(status());
    expect(html).toContain('Paste the whole service account JSON key file');
    expect(html).toContain('not set');
    expect(html).toContain('never shown here again, never logged');
    expect(html).not.toContain('PRIVATE KEY');
  });

  it('with a key: shows the email to share the sheet with and Replace/Remove, never the key or a paste box', async () => {
    const html = await credentialCard(status({ credential: { stored: true, serviceAccountEmail: 'bot@proj.iam.gserviceaccount.com', undecryptable: false } }));
    expect(html).toContain('bot@proj.iam.gserviceaccount.com');
    expect(html).toContain('Replace key');
    expect(html).toContain('>Remove<');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('PRIVATE KEY');
  });

  it('warns that key storage is off when the gateway has no master key, and disables the box', async () => {
    const html = await credentialCard(status({ secretStorageAvailable: false }));
    expect(html).toContain('AI_SECRETS_MASTER_KEY');
    expect(html).toMatch(/<textarea[^>]*disabled/);
  });

  it('shows an undecryptable key as a problem to fix', async () => {
    const html = await credentialCard(status({ credential: { stored: true, serviceAccountEmail: null, undecryptable: true } }));
    expect(html).toContain('cannot be decrypted');
  });

  it('shows each test step with what to do about a failure', async () => {
    const result: SheetsTestResult = {
      ok: false,
      at: '2026-10-29T12:00:00.000Z',
      steps: [
        { name: 'Service account key', ok: true, detail: 'Stored for bot@proj.iam.gserviceaccount.com' },
        { name: 'Google sign-in and spreadsheet access', ok: false, detail: 'Google denied access.' },
      ],
      advice: 'Share the spreadsheet with bot@proj.iam.gserviceaccount.com as an Editor.',
    };
    vi.resetModules();
    const { TestResultView } = await import('../src/components/ai/IntegrationsTab');
    const html = renderToStaticMarkup(React.createElement(TestResultView, { result }));
    expect(html).toContain('connection failed');
    expect(html).toContain('Service account key');
    expect(html).toContain('Google denied access.');
    expect(html).toContain('as an Editor.');
  });
});

describe('inbound and outbound agent settings in the dashboard form', () => {
  const settings = (agent: Record<string, unknown> = {}): AiSettingsView =>
    ({
      mode: 'passive', stt: 'nova-3', llm: 'groq_qwen_3_8_27b', tts: 'cartesia', ttsVoice: 'katie', showTranscripts: false, diagnosticRecording: false, audioSampleRate: 8000, autoHandle: 'off',
      agent: { name: 'Phone agent', instructions: 'Shared.', greeting: 'Hello.', language: 'en', enabled: true, allowHangup: false, ...agent },
      automation: { autoAnswer: false, autoAnswerRings: 2, autoActivateUsbAudio: false, autoReplies: false, maxCallSeconds: 900, idleFollowUps: true },
      params: { maxTokens: null, sttTimeoutMs: 8000, llmFirstTokenTimeoutMs: 8000, llmTotalTimeoutMs: 30000, ttsTimeoutMs: 8000, maxResponseChars: 600, vadMinSilenceMs: 1000, vadRmsThreshold: 0.003 },
    }) as unknown as AiSettingsView;

  it('loads the four fields (empty when the gateway has none), and saves only the one that changed', () => {
    const original = draftFromSettings(settings());
    expect(original.agent).toMatchObject({ inboundInstructions: '', inboundGreeting: '', outboundInstructions: '', outboundGreeting: '' });
    const edited = { ...original, agent: { ...original.agent, outboundGreeting: 'Hi, this is Sam.' } };
    expect(buildSettingsPatch(original, edited)).toEqual({ agent: { outboundGreeting: 'Hi, this is Sam.' } });
    const loaded = draftFromSettings(settings({ inboundGreeting: 'Thanks for calling.', outboundInstructions: 'Outreach.' }));
    expect(loaded.agent).toMatchObject({ inboundGreeting: 'Thanks for calling.', outboundInstructions: 'Outreach.' });
    // Clearing a field is a change too: it sends an empty string so the gateway goes back to the shared one.
    expect(buildSettingsPatch(loaded, { ...loaded, agent: { ...loaded.agent, inboundGreeting: '' } })).toEqual({ agent: { inboundGreeting: '' } });
  });

  it('warns about over-long values before Save', () => {
    const catalog = { languages: ['en'], stt: [{ key: 'nova-3', implemented: true }], llm: [{ key: 'groq_qwen_3_8_27b', implemented: true }], tts: [{ key: 'cartesia', implemented: true, voices: [], sampleRates: [] }] } as never;
    const base = draftFromSettings(settings());
    expect(validateDraft({ ...base, agent: { ...base.agent, outboundInstructions: 'x'.repeat(8001) } }, catalog)).toContain('Outbound instructions are limited to 8000 characters');
    expect(validateDraft({ ...base, agent: { ...base.agent, inboundGreeting: 'x'.repeat(501) } }, catalog)).toContain('The inbound greeting is limited to 500 characters');
    expect(validateDraft(base, catalog)).toEqual([]);
  });

  it('the Agent tab shows what an inbound and an outbound call will say, next to the shared settings, with the editor behind Edit', async () => {
    vi.resetModules();
    const draft = draftFromSettings(settings({ inboundGreeting: 'Thanks for calling Acme.', outboundGreeting: 'Hi from Acme.' }));
    vi.doMock('../src/components/ai/useSettingsDraft', () => ({
      useSettingsDraft: () => ({
        draft,
        setDraft: () => undefined,
        dirty: false,
        problems: [],
        action: { status: 'idle' },
        save: () => undefined,
        cancel: () => undefined,
        catalog: { languages: ['en'] },
        state: { sessions: [], settings: { attestations: { inbound: { confirmed: false, confirmedAt: null, note: null, source: 'none' }, outbound: { confirmed: false, confirmedAt: null, note: null, source: 'none' } } } },
      }),
    }));
    // The two prompt cards read what the gateway has SAVED, through the AI context.
    vi.doMock('../src/lib/context/AiContext', () => ({
      useAi: () => ({
        state: { settings: { agent: { instructions: '', greeting: '', inboundInstructions: '', inboundGreeting: 'Thanks for calling Acme.', outboundInstructions: 'Outreach for Acme.', outboundGreeting: 'Hi from Acme.' } } },
        refresh: async () => undefined,
      }),
    }));
    const { AgentTab } = await import('../src/components/ai/AgentTab');
    const html = renderToStaticMarkup(React.createElement(AgentTab));
    vi.doUnmock('../src/components/ai/useSettingsDraft');
    vi.doUnmock('../src/lib/context/AiContext');
    expect(html).toContain('Inbound calls');
    expect(html).toContain('Outbound calls');
    expect(html).toContain('data-testid="inbound-reading"'); // read first; the editor appears when Edit is pressed
    expect(html).toContain('data-testid="outbound-reading"');
    expect(html).not.toContain('aria-label="Inbound instructions"');
    expect(html).toContain('Thanks for calling Acme.');
    expect(html).toContain('Hi from Acme.');
    expect(html).toContain('Outreach for Acme.');
    expect(html).toContain('Shared instructions');
    expect(html).toContain('A campaign adds its own prompt');
  });
});
