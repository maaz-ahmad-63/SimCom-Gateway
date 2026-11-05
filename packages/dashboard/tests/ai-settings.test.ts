import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCatalogResponse, AiCredentialStatus, AiReadinessView, AiSettingsView, AiAudioMeter } from '@sim-gateway/shared';
import { GatewayApiClient, GatewayApiError } from '../src/lib/api-client';
import { credentialBadges, missingRequired, validateKeyInput } from '../src/lib/ai-secrets';
import { buildSettingsPatch, draftFromSettings, isDirty, selectTtsProvider, validateDraft, voicesFor } from '../src/lib/ai-settings-form';
import { checklist, describeAudioHealth, summarizeReadiness } from '../src/lib/ai-readiness';

const catalog: AiCatalogResponse = {
  languages: ['en', 'hi'],
  stt: [
    { key: 'nova-3', label: 'Deepgram Nova-3', provider: 'deepgram', model: 'nova-3', implemented: true, unavailableReason: null, streaming: false, priceNote: null },
    { key: 'assemblyai', label: 'AssemblyAI', provider: 'assemblyai', model: null, implemented: false, unavailableReason: 'Not ported to the gateway yet', streaming: false, priceNote: null },
  ],
  llm: [
    { key: 'groq_qwen_3_8_27b', label: 'groq qwen 3 8 27b', provider: 'groq', model: 'qwen', implemented: true, unavailableReason: null, supportedParams: ['maxTokens'], priceNote: null },
    { key: 'gemini_3_flash', label: 'gemini 3 flash', provider: 'gemini', model: 'g', implemented: false, unavailableReason: 'Not ported to the gateway yet', priceNote: null },
  ],
  tts: [
    { key: 'cartesia', label: 'Cartesia Sonic-3', provider: 'cartesia', model: 'sonic-3', implemented: true, unavailableReason: null, voices: [{ id: 'katie', label: 'katie' }], sampleRates: [8000, 16000], priceNote: null },
    { key: 'deepgram', label: 'Deepgram Aura', provider: 'deepgram', model: null, implemented: true, unavailableReason: null, voices: [{ id: 'aura-luna-en', label: 'aura-luna-en' }], sampleRates: [8000, 16000, 24000], priceNote: null },
    { key: 'elevenlabs', label: 'elevenlabs', provider: 'elevenlabs', model: null, implemented: false, unavailableReason: 'Not ported to the gateway yet', voices: [], sampleRates: [], priceNote: null },
  ],
};

const settings = (over: Partial<AiSettingsView> = {}): AiSettingsView => ({
  mode: 'passive',
  stt: 'nova-3',
  llm: 'groq_qwen_3_8_27b',
  tts: 'cartesia',
  ttsVoice: 'katie',
  agent: { name: 'Phone agent', instructions: '', greeting: '', language: 'en', enabled: true, allowHangup: false },
  showTranscripts: false,
  diagnosticRecording: false,
  audioSampleRate: 8000,
  autoHandle: 'off',
  automation: { autoAnswer: false, autoAnswerRings: 2, autoActivateUsbAudio: false, autoReplies: false, maxCallSeconds: 900, idleFollowUps: true },
  params: { maxTokens: null, sttTimeoutMs: 8000, llmFirstTokenTimeoutMs: 8000, llmTotalTimeoutMs: 30000, ttsTimeoutMs: 8000, maxResponseChars: 600, vadMinSilenceMs: 1000, vadRmsThreshold: 0.003 },
  attestations: {
    inbound: { confirmed: false, confirmedAt: null, note: null, source: 'none' },
    outbound: { confirmed: false, confirmedAt: null, note: null, source: 'none' },
  },
  configErrors: [],
  configWarnings: [],
  secretStorageAvailable: true,
  updatedAt: null,
  ...over,
});

describe('settings form', () => {
  it('sends only what changed, and nothing when nothing changed', () => {
    const original = draftFromSettings(settings());
    expect(buildSettingsPatch(original, original)).toEqual({});
    expect(isDirty(original, original)).toBe(false);
    const edited = { ...original, llm: 'groq_gpt_oss_20b', agent: { ...original.agent, instructions: 'Be brief.' }, params: { ...original.params, maxTokens: 120 } };
    expect(buildSettingsPatch(original, edited)).toEqual({ llm: 'groq_gpt_oss_20b', agent: { instructions: 'Be brief.' }, params: { maxTokens: 120 } });
    expect(isDirty(original, edited)).toBe(true);
  });

  it('refuses providers that are listed but not ported, without hiding why', () => {
    const base = draftFromSettings(settings());
    expect(validateDraft(base, catalog)).toEqual([]);
    expect(validateDraft({ ...base, stt: 'assemblyai' }, catalog).join(' ')).toMatch(/AssemblyAI is listed but not ported/);
    expect(validateDraft({ ...base, llm: 'gemini_3_flash' }, catalog).join(' ')).toMatch(/not ported/);
    expect(validateDraft({ ...base, tts: 'elevenlabs' }, catalog).join(' ')).toMatch(/not ported/);
    expect(validateDraft({ ...base, stt: 'ghost' }, catalog).join(' ')).toMatch(/Unknown speech-to-text provider/);
  });

  it('checks voice, sample rate, language and numeric bounds', () => {
    const base = draftFromSettings(settings());
    expect(validateDraft({ ...base, tts: 'deepgram', ttsVoice: 'flux-alexis-en' }, catalog).join(' ')).toMatch(/Aura voice/);
    expect(validateDraft({ ...base, audioSampleRate: 22050 }, catalog).join(' ')).toMatch(/cannot produce raw 22050 Hz/);
    expect(validateDraft({ ...base, language: 'English' }, catalog).join(' ')).toMatch(/Language must look like/);
    expect(validateDraft({ ...base, params: { ...base.params, maxTokens: 5 } }, catalog).join(' ')).toMatch(/Max tokens/);
    expect(validateDraft({ ...base, params: { ...base.params, sttTimeoutMs: 100 } }, catalog).join(' ')).toMatch(/STT timeout/);
    expect(validateDraft({ ...base, agent: { ...base.agent, name: '  ' } }, catalog).join(' ')).toMatch(/name/);
  });

  it('never keeps a voice from the previous TTS provider', () => {
    const base = draftFromSettings(settings());
    const next = selectTtsProvider(base, catalog, 'deepgram');
    expect(next.tts).toBe('deepgram');
    expect(next.ttsVoice).toBe('aura-luna-en');
    expect(voicesFor(catalog, 'elevenlabs')).toEqual([]);
    expect(selectTtsProvider(base, catalog, 'elevenlabs').ttsVoice).toBe('');
  });
});

describe('credential display and input', () => {
  const cred = (over: Partial<AiCredentialStatus>): AiCredentialStatus => ({
    name: 'DEEPGRAM_API_KEY',
    provider: 'Deepgram',
    requiredBySelection: true,
    source: 'missing',
    masked: null,
    lastCheck: 'not-checked',
    lastCheckedAt: null,
    lastCheckDetail: null,
    ...over,
  });

  it('keeps missing, rejected and unreachable apart', () => {
    expect(credentialBadges(cred({})).presence).toEqual({ label: 'Not configured', tone: 'bad' });
    expect(credentialBadges(cred({ requiredBySelection: false })).presence.tone).toBe('neutral');
    const stored = credentialBadges(cred({ source: 'stored', masked: '••••WXYZ', lastCheck: 'invalid' }));
    expect(stored.presence).toEqual({ label: 'Configured', tone: 'good' }); // never any character of the key
    expect(stored.check).toEqual({ label: 'Provider rejected it', tone: 'bad' });
    expect(credentialBadges(cred({ source: 'env', lastCheck: 'unreachable' })).check.label).toBe('Could not reach provider');
    expect(credentialBadges(cred({ source: 'env', lastCheck: 'ok' })).check.tone).toBe('good');
    expect(credentialBadges(cred({ source: 'env' })).check.label).toBe('Not checked yet'); // present is not the same as valid
    expect(credentialBadges(cred({})).check.label).toBe('Nothing to check');
  });

  it('lists required keys that are missing, by name only', () => {
    expect(missingRequired([cred({}), cred({ name: 'GROQ_API_KEY', source: 'env' }), cred({ name: 'OPENAI_API_KEY', requiredBySelection: false })])).toEqual(['DEEPGRAM_API_KEY']);
  });

  it('validates pasted keys the way the gateway does', () => {
    expect(validateKeyInput('')).toMatch(/Paste/);
    expect(validateKeyInput('short')).toMatch(/too short/);
    expect(validateKeyInput('has a space inside')).toMatch(/no spaces/);
    expect(validateKeyInput('x'.repeat(600))).toMatch(/too long/);
    expect(validateKeyInput('  dg-live-ABCDEFGH1234  ')).toBeNull();
  });
});

describe('API client for the AI endpoints', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const client = new GatewayApiClient({ gatewayUrl: 'http://127.0.0.1:4000', apiKey: 'gw-key-123456' });

  it('sends a provider key only in the request body of the save call, with the gateway key header', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: true, json: async () => ({ credentials: [] }) });
    await client.saveAiCredential('DEEPGRAM_API_KEY', 'dg-live-ABCDEFGH1234');
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4000/api/ai/credentials/DEEPGRAM_API_KEY');
    expect(url).not.toContain('dg-live');
    expect(init.method).toBe('PUT');
    expect(init.headers['x-api-key']).toBe('gw-key-123456');
    expect(JSON.parse(init.body)).toEqual({ value: 'dg-live-ABCDEFGH1234' });
  });

  it('asks for explicit billing consent on every provider test', async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({}) });
    await client.testAiLlm('hello');
    await client.previewAiTts('hello');
    await client.testAiStt({ file: 'a.wav' });
    for (const call of (global.fetch as any).mock.calls) expect(JSON.parse(call[1].body).confirmBilling).toBe(true);
  });

  it('surfaces the gateway’s blockers and validation issues instead of a bare status', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({ success: false, error: 'AI replies are blocked until readiness passes', blockers: ['hardware: simulated', 'outbound-audio: unverified'] }),
    });
    const error = await client.setAiMode('active').catch((e) => e as GatewayApiError);
    expect(error).toBeInstanceOf(GatewayApiError);
    expect((error as GatewayApiError).statusCode).toBe(409);
    expect((error as GatewayApiError).reasons).toEqual(['hardware: simulated', 'outbound-audio: unverified']);
  });

  it('reports a network failure as such', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(client.getAiState()).rejects.toMatchObject({ code: 'NETWORK_ERROR', statusCode: 0 });
  });
});

describe('readiness wording', () => {
  const readiness = (over: Partial<AiReadinessView>): AiReadinessView => ({
    passiveOk: false,
    ok: false,
    checkedAt: '2026-10-16T00:00:00.000Z',
    checks: [
      { name: 'hardware', status: 'pass', detail: 'real' },
      { name: 'inbound-audio', status: 'unverified', detail: 'not confirmed' },
    ],
    blockers: ['inbound-audio: not confirmed'],
    passiveBlockers: [],
    mode: 'passive',
    simulatedHardware: false,
    ...over,
  });

  it('never says ready unless the gateway says every check passed', () => {
    expect(summarizeReadiness(null).label).toBe('Unknown');
    expect(summarizeReadiness(readiness({ mode: 'off' })).label).toBe('AI is off');
    expect(summarizeReadiness(readiness({ simulatedHardware: true })).label).toBe('Simulated hardware');
    expect(summarizeReadiness(readiness({ passiveOk: true })).label).toBe('Passive ready');
    expect(summarizeReadiness(readiness({ passiveOk: true })).tone).toBe('warn');
    expect(summarizeReadiness(readiness({ passiveOk: false, passiveBlockers: ['modem: ERROR'] }))).toMatchObject({ label: 'Blocked', tone: 'bad', detail: 'modem: ERROR' });
    expect(summarizeReadiness(readiness({ ok: true, passiveOk: true, blockers: [] })).label).toBe('Ready to reply');
  });

  it('keeps simulated hardware flagged even when other checks look fine', () => {
    expect(summarizeReadiness(readiness({ simulatedHardware: true, passiveOk: true })).tone).toBe('warn');
  });

  it('labels which checks are needed to transcribe and which only to reply', () => {
    const rows = checklist(readiness({}));
    expect(rows.find((r) => r.name === 'hardware')?.needed).toBe('passive');
    expect(rows.find((r) => r.name === 'inbound-audio')?.needed).toBe('replies');
  });

  const meter = (over: Partial<AiAudioMeter>): AiAudioMeter => ({
    receivedBytes: 160000, receivedSeconds: 10, submittedSeconds: 2, utterances: 1, lastFrameAgoMs: 20, maxGapMs: 22, rms: 0.01, peak: 0.1, silentForMs: 500, observedSampleRate: 8000, expectedSampleRate: 8000, backlogMs: 0, ...over,
  });

  it('reads the meters honestly: stalled, gappy, silent and clipping are called out', () => {
    expect(describeAudioHealth(meter({}))).toEqual({ tone: 'good', notes: ['Audio is arriving steadily'] });
    expect(describeAudioHealth(meter({ receivedBytes: 0, lastFrameAgoMs: null })).tone).toBe('bad');
    expect(describeAudioHealth(meter({ lastFrameAgoMs: 4000 })).notes.join(' ')).toMatch(/stalled/);
    expect(describeAudioHealth(meter({ maxGapMs: 400 })).tone).toBe('warn');
    expect(describeAudioHealth(meter({ silentForMs: 30000 })).notes.join(' ')).toMatch(/line noise/);
    expect(describeAudioHealth(meter({ peak: 1 })).notes.join(' ')).toMatch(/clipping/);
    const mislabeled = describeAudioHealth(meter({ observedSampleRate: 16000 }));
    expect(mislabeled.tone).toBe('bad');
    expect(mislabeled.notes.join(' ')).toMatch(/mislabeled/);
    expect(describeAudioHealth(meter({ observedSampleRate: 8100 })).tone).toBe('good');
    expect(describeAudioHealth(meter({ observedSampleRate: null })).tone).toBe('good'); // still measuring
  });
});
