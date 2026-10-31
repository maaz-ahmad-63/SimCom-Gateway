import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrations.js';
import { GatewayRepository } from '../../src/db/repository.js';
import { AiSettingsService } from '../../src/ai/settings.js';
import { aiEnv, SECRET } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});
function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsmodel-'));
  const file = path.join(dir, 'g.sqlite');
  const open = () => {
    const db = new Database(file);
    runMigrations(db);
    cleanups.push(() => db.close());
    return new AiSettingsService(new GatewayRepository(db), aiEnv({ AI_AUDIO_SAMPLE_RATE: '8000', MURF_API_KEY: SECRET, SONIOX_API_KEY: SECRET, INWORLD_API_KEY: SECRET, ELEVENLABS_API_KEY: SECRET }));
  };
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { open };
}

describe('the TTS model setting', () => {
  it('is saved, persists across a restart, and shows in the settings view', () => {
    const s = service();
    const a = s.open();
    a.update({ tts: 'soniox', ttsVoice: 'Adrian', ttsModel: 'tts-rt-v2' });
    const b = s.open();
    expect(b.view(b.loadConfig())).toMatchObject({ tts: 'soniox', ttsVoice: 'Adrian', ttsModel: 'tts-rt-v2' });
    expect(b.loadConfig().config.tts).toEqual({ key: 'soniox', voice: 'Adrian', model: 'tts-rt-v2' });
  });
  it('refuses a model that is not the provider\'s, changing nothing', () => {
    const a = service().open();
    a.update({ tts: 'soniox', ttsVoice: 'Adrian' });
    expect(() => a.update({ ttsModel: 'sonic-3' })).toThrow(/Settings rejected/);
    expect(a.view(a.loadConfig()).ttsModel).toBeNull();
    expect(() => a.update({ tts: 'deepgram', ttsVoice: 'aura-asteria-en', ttsModel: 'x' })).toThrow(/Settings rejected/);
  });
  it('returns to the default when the provider changes, and null clears it', () => {
    const a = service().open();
    a.update({ tts: 'elevenlabs', ttsVoice: 'cgSgspJ2msm6clMCkdW9', ttsModel: 'eleven_multilingual_v2' });
    expect(a.view(a.loadConfig()).ttsModel).toBe('eleven_multilingual_v2');
    a.update({ tts: 'inworld', ttsVoice: 'Ashley' });
    expect(a.view(a.loadConfig()).ttsModel).toBeNull();
    a.update({ ttsModel: 'inworld-tts-2' });
    a.update({ ttsModel: null });
    expect(a.view(a.loadConfig()).ttsModel).toBeNull();
  });
});
