import { describe, expect, it } from 'vitest';
import { keyEnvFor } from '../src/lib/ai-keys';
import { buildSettingsPatch, draftFromSettings, selectTtsProvider, SettingsDraft } from '../src/lib/ai-settings-form';

describe('which stored key a provider option needs', () => {
  it('uses the key the gateway names, for every requested provider', () => {
    expect(keyEnvFor({ provider: 'murf_falcon_2', keyEnv: 'MURF_API_KEY' })).toBe('MURF_API_KEY');
    expect(keyEnvFor({ key: 'inworld', keyEnv: 'INWORLD_API_KEY' })).toBe('INWORLD_API_KEY');
    expect(keyEnvFor({ provider: 'soniox', keyEnv: 'SONIOX_API_KEY' })).toBe('SONIOX_API_KEY');
  });
  it('keeps the gateway\'s answer even when it says no credential is stored for the option', () => {
    expect(keyEnvFor({ provider: 'assemblyai', keyEnv: null })).toBeNull();
  });
  it('falls back to a provider table for an older gateway, and never guesses another provider\'s key', () => {
    for (const [provider, key] of [['telnyx', 'TELNYX_API_KEY'], ['deepgram', 'DEEPGRAM_API_KEY'], ['deepgram-flux', 'DEEPGRAM_API_KEY'], ['cartesia', 'CARTESIA_API_KEY'], ['soniox', 'SONIOX_API_KEY'], ['inworld', 'INWORLD_API_KEY'], ['murf_falcon_2_hi', 'MURF_API_KEY']] as const) {
      expect(keyEnvFor({ provider }), provider).toBe(key);
    }
    expect(keyEnvFor({ provider: 'unknown-provider' })).toBeNull();
    expect(keyEnvFor(undefined)).toBeNull();
  });
});

describe('the TTS model in the settings draft', () => {
  const settings = { stt: 'nova-3', llm: 'x', tts: 'soniox', ttsVoice: 'Adrian', ttsModel: null, audioSampleRate: 8000, autoHandle: 'inbound', showTranscripts: false, diagnosticRecording: false, automation: {}, agent: { name: 'a', instructions: '', greeting: '', enabled: true, allowHangup: false, language: 'en' }, params: {} } as never;
  const draft = (over: Partial<SettingsDraft> = {}): SettingsDraft => ({ ...draftFromSettings(settings), ...over });

  it('reads the model (null = default) and sends it only when it changed', () => {
    const original = draft();
    expect(original.ttsModel).toBeNull();
    expect(buildSettingsPatch(original, draft())).toEqual({});
    expect(buildSettingsPatch(original, draft({ ttsModel: 'tts-rt-v2' }))).toEqual({ ttsModel: 'tts-rt-v2' });
    expect(buildSettingsPatch(draft({ ttsModel: 'tts-rt-v2' }), draft({ ttsModel: null }))).toEqual({ ttsModel: null });
  });
  it('returns to the default model when another provider is chosen (a model id belongs to one provider)', () => {
    const catalog = { tts: [{ key: 'inworld', voices: [] }], stt: [], llm: [], languages: [] } as never;
    expect(selectTtsProvider(draft({ ttsModel: 'tts-rt-v2' }), catalog, 'inworld').ttsModel).toBeNull();
  });
});
