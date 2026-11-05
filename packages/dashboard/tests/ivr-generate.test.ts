import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiClient } from '../src/lib/api-client';
import {
  chooseModel,
  describeGenerated,
  generateProblem,
  generationSignature,
  GeneratedInfo,
  suggestName,
  TtsModelChoice,
  TtsOptions,
  voicesOf,
  wavBlobFromBase64,
  wavFileName,
} from '../src/lib/ivr-generate';
import { AudioLibrary } from '../src/components/ivr/AudioLibrary';
import { GenerateAudioForm, GenerateFormProps } from '../src/components/ivr/GenerateAudio';

const model = (over: Partial<TtsModelChoice> = {}): TtsModelChoice => ({
  key: 'cartesia',
  label: 'Cartesia Sonic',
  provider: 'Cartesia',
  protocol: 'cartesia-tts',
  models: ['sonic-3'],
  defaultModel: 'sonic-3',
  defaultVoice: 'Katie',
  voices: [
    { name: 'Katie', label: 'Katie' },
    { name: 'Ravi', label: 'Ravi (warm)' },
  ],
  sampleRates: [8000, 16000],
  available: true,
  unavailableReason: null,
  current: false,
  ...over,
});
const OPTIONS: TtsOptions = {
  sampleRate: 8000,
  maxChars: 1000,
  models: [
    model({ key: 'deepgram', label: 'Deepgram Aura', provider: 'Deepgram', available: false, unavailableReason: 'The Deepgram API key is not set (DEEPGRAM_API_KEY).', voices: [], defaultVoice: 'aura-asteria-en' }),
    model({ key: 'cartesia', current: true }),
    model({ key: 'eleven', label: 'ElevenLabs', provider: 'ElevenLabs', models: ['eleven_flash_v2_5', 'eleven_turbo_v2_5'], voices: [], defaultVoice: 'Rachel' }),
  ],
};

const INFO: GeneratedInfo = {
  model: 'cartesia',
  provider: 'Cartesia',
  providerModel: 'sonic-3',
  voice: 'Katie',
  chars: 23,
  sourceSampleRate: 8000,
  converted: false,
  sampleRate: 8000,
  channels: 1,
  bitsPerSample: 16,
  bytes: 48044,
  durationMs: 3000,
  generationMs: 700,
};

const idle = { status: 'idle' } as const;
const noop = () => {};
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const form = (over: Partial<GenerateFormProps> = {}) =>
  html(
    React.createElement(GenerateAudioForm, {
      options: OPTIONS,
      optionsError: null,
      text: 'Welcome to our company.',
      modelKey: 'cartesia',
      providerModel: '',
      voice: 'Katie',
      name: 'Welcome to our company',
      onText: noop,
      onModel: noop,
      onProviderModel: noop,
      onVoice: noop,
      onName: noop,
      generateState: idle,
      onGenerate: noop,
      result: null,
      added: null,
      addState: idle,
      onAdd: noop,
      ...over,
    })
  );
const result = (over: Partial<GenerateFormProps['result'] & object> = {}) => ({
  url: 'blob:http://localhost/abc',
  info: INFO,
  signature: generationSignature({ text: 'Welcome to our company.', modelKey: 'cartesia', providerModel: '', voice: 'Katie' }),
  ...over,
});

describe('choosing a voice model', () => {
  it('prefers the asked-for model if usable, else the one the AI agent uses, else the first usable, else nothing', () => {
    expect(chooseModel(OPTIONS)).toBe('cartesia'); // current
    expect(chooseModel(OPTIONS, 'eleven')).toBe('eleven');
    expect(chooseModel(OPTIONS, 'deepgram')).toBe('cartesia'); // unusable preference is ignored
    expect(chooseModel({ ...OPTIONS, models: OPTIONS.models.map((m) => ({ ...m, current: false })) })).toBe('cartesia'); // first usable (deepgram is not)
    expect(chooseModel({ ...OPTIONS, models: OPTIONS.models.map((m) => ({ ...m, available: false })) })).toBe('');
  });

  it('lists a model\'s voices and always includes its default voice', () => {
    expect(voicesOf(model()).map((v) => v.name)).toEqual(['Katie', 'Ravi']);
    expect(voicesOf(model({ voices: [{ name: 'Ravi', label: 'Ravi' }], defaultVoice: 'Katie' })).map((v) => v.label)).toEqual(['Katie (default)', 'Ravi']);
    expect(voicesOf(model({ voices: [], defaultVoice: '' }))).toEqual([]);
    expect(voicesOf(undefined)).toEqual([]);
  });
});

describe('what stops Generate', () => {
  const ok = { text: 'Hello', modelKey: 'cartesia', options: OPTIONS };
  it('says why, in a sentence, for each case', () => {
    expect(generateProblem(ok)).toBeNull();
    expect(generateProblem({ ...ok, options: null })).toMatch(/not loaded/);
    expect(generateProblem({ ...ok, options: { ...OPTIONS, models: OPTIONS.models.map((m) => ({ ...m, available: false })) } })).toMatch(/No voice model can be used/);
    expect(generateProblem({ ...ok, modelKey: '' })).toMatch(/Choose a voice model/);
    expect(generateProblem({ ...ok, modelKey: 'gone' })).toMatch(/no longer exists/);
    expect(generateProblem({ ...ok, modelKey: 'deepgram' })).toMatch(/DEEPGRAM_API_KEY/);
    expect(generateProblem({ ...ok, text: '  \n ' })).toMatch(/Enter the announcement text/);
    expect(generateProblem({ ...ok, text: 'x'.repeat(1001) })).toMatch(/1001 characters; the limit is 1000/);
  });
});

describe('names and files', () => {
  it('suggests a short library name from the first words, keeping any script', () => {
    expect(suggestName('Thank you for calling Acme! For sales press 1, for support press 2.')).toBe('Thank you for calling Acme For');
    expect(suggestName('   ')).toBe('');
    expect(suggestName('!!! ???')).toBe('');
    expect(suggestName('آپ کی کال کا شکریہ')).toBe('آپ کی کال کا شکریہ');
    expect(suggestName('word '.repeat(40)).length).toBeLessThanOrEqual(60);
  });

  it('makes a file name every system accepts, always .wav', () => {
    expect(wavFileName('Welcome message')).toBe('Welcome message.wav');
    expect(wavFileName('Sales: 50% off?/now.wav')).toBe('Sales 50% offnow.wav');
    expect(wavFileName('..\\..\\evil<>|"name')).toBe('....evilname.wav');
    expect(wavFileName('   ')).toBe('announcement.wav');
    expect(wavFileName('x'.repeat(200))).toBe(`${'x'.repeat(80)}.wav`);
  });

  it('describes the generated file, and says when it was converted', () => {
    expect(describeGenerated(INFO)).toBe('3.0 s · 8000 Hz mono 16-bit WAV · 47 KB · Cartesia, voice Katie');
    expect(describeGenerated({ ...INFO, converted: true, sourceSampleRate: 24000 })).toContain('converted from 24000 Hz');
  });
});

describe('the generated WAV reaches the browser and the library unchanged', () => {
  /** A canonical 44-byte-header PCM WAV, as the gateway produces. */
  const wavBytes = (() => {
    const data = Buffer.alloc(1600);
    for (let i = 0; i < 800; i++) data.writeInt16LE(Math.round(Math.sin(i / 5) * 9000), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + data.length, 4);
    h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(8000, 24);
    h.writeUInt32LE(16000, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
  })();

  it('decodes base64 to the same bytes with an audio/wav type (what Download saves)', async () => {
    const blob = wavBlobFromBase64(wavBytes.toString('base64'));
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(wavBytes.length);
    expect(Buffer.from(await blob.arrayBuffer()).equals(wavBytes)).toBe(true);
    const bytes = Buffer.from(await blob.arrayBuffer());
    expect([bytes.toString('ascii', 0, 4), bytes.readUInt16LE(20), bytes.readUInt16LE(22), bytes.readUInt32LE(24), bytes.readUInt16LE(34)]).toEqual(['RIFF', 1, 1, 8000, 16]);
  });

  describe('through the API client', () => {
    const original = global.fetch;
    beforeEach(() => void (global.fetch = vi.fn()));
    afterEach(() => {
      global.fetch = original;
      vi.restoreAllMocks();
    });
    const client = () => new GatewayApiClient({ gatewayUrl: 'http://gw:4000/', apiKey: 'key-123456' });
    const ok = (body: unknown) => (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, json: async () => body });
    const call = (n = 0) => (global.fetch as ReturnType<typeof vi.fn>).mock.calls[n] as [string, RequestInit & { headers: Record<string, string> }];

    it('reads the voice models with GET and generates with POST and a JSON body that confirms billing', async () => {
      ok(OPTIONS);
      expect(await client().getIvrTtsOptions()).toEqual(OPTIONS);
      expect(call()[0]).toBe('http://gw:4000/api/ivr/generate/options');
      expect(call()[1].headers['x-api-key']).toBe('key-123456');

      ok({ success: true, info: INFO, audioWavBase64: 'AAAA' });
      await client().generateIvrAudio({ text: 'Hello', model: 'cartesia', voice: 'Katie', confirmBilling: true });
      expect(call(1)[0]).toBe('http://gw:4000/api/ivr/generate');
      expect(call(1)[1].method).toBe('POST');
      expect(JSON.parse(call(1)[1].body as string)).toEqual({ text: 'Hello', model: 'cartesia', voice: 'Katie', confirmBilling: true });
    });

    it('hands the very same generated Blob to the existing upload (no re-encoding, WAV content type)', async () => {
      const blob = wavBlobFromBase64(wavBytes.toString('base64'));
      ok({ success: true, asset: {}, duplicate: false, assets: [], audio: {} });
      await client().uploadIvrAsset(blob, 'Welcome');
      const [url, init] = call();
      expect(url).toBe('http://gw:4000/api/ivr/assets?name=Welcome');
      expect(init.headers['Content-Type']).toBe('audio/wav');
      expect(init.body).toBe(blob);
    });

    it('turns a refused generation into a readable error', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ success: false, error: 'Cartesia Sonic cannot be used: The Cartesia API key is not set (CARTESIA_API_KEY).', code: 'IVR_TTS_UNAVAILABLE' }),
      });
      await expect(client().generateIvrAudio({ text: 'Hi', model: 'cartesia', confirmBilling: true })).rejects.toMatchObject({
        statusCode: 409,
        code: 'IVR_TTS_UNAVAILABLE',
        message: expect.stringContaining('CARTESIA_API_KEY'),
      });
    });
  });
});

describe('the generate form', () => {
  it('shows loading, and a load failure, before there are options', () => {
    expect(form({ options: null })).toContain('Loading voice models');
    const failed = form({ options: null, optionsError: 'Could not load the voice models: HTTP 500' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Could not load the voice models: HTTP 500');
    expect(failed).not.toContain('Loading voice models');
  });

  it('offers the models, disables the unavailable one and says why', () => {
    const open = form();
    expect(open).toMatch(/<option value="deepgram" disabled="">Deepgram Aura \(unavailable\)<\/option>/);
    expect(open).toMatch(/<option value="cartesia" selected="">Cartesia Sonic<\/option>/);
    expect(open).toContain('Cartesia · used by the AI agent');
    const unavailable = form({ modelKey: 'deepgram', voice: '' });
    expect(unavailable).toContain('The Deepgram API key is not set (DEEPGRAM_API_KEY).');
  });

  it('lists the voices for the model, or asks for a typed voice when the registry names none', () => {
    const withVoices = form();
    expect(withVoices).toContain('Ravi (warm)');
    const typed = form({ modelKey: 'eleven', voice: 'Rachel' });
    expect(typed).toContain('Type the provider voice name or id');
    expect(typed).toMatch(/<input[^>]*aria-label="Voice"[^>]*value="Rachel"|<input[^>]*value="Rachel"[^>]*aria-label="Voice"/);
  });

  it('shows the provider model picker only when the entry offers several', () => {
    expect(form({ modelKey: 'eleven', voice: 'Rachel' })).toContain('aria-label="Provider model"');
    expect(form({ modelKey: 'eleven', voice: 'Rachel' })).toContain('eleven_flash_v2_5 (default)');
    expect(form()).not.toContain('aria-label="Provider model"');
  });

  it('enables Generate with a valid choice and explains the billing; disables it and says why otherwise', () => {
    const ready = form();
    expect(ready).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Generate<\/button>/);
    expect(ready).not.toMatch(/disabled=""[^>]*title="Generate the speech"|title="Generate the speech"[^>]*disabled=""/);
    expect(ready).toContain('Sends the text to Cartesia, which may bill for it.');
    const empty = form({ text: '' });
    expect(empty).toMatch(/disabled=""[^>]*title="Enter the announcement text\."|title="Enter the announcement text\."[^>]*disabled=""/);
    expect(empty).toContain('Enter the announcement text.');
    expect(form({ text: 'x'.repeat(1001) })).toContain('1001 characters; the limit is 1000');
  });

  it('counts the characters against the limit', () => {
    expect(form({ text: 'Hello there' })).toContain('11 / 1000 characters');
  });

  it('shows a generation failure with its reason, and a running state', () => {
    const failed = form({ generateState: { status: 'error', message: 'Cartesia could not generate the audio: HTTP 401' } });
    expect(failed).toContain('Cartesia could not generate the audio: HTTP 401');
    expect(form({ generateState: { status: 'running' } })).toMatch(/animate-spin/);
  });

  it('with a result: preview player, details, download link named after the library name, and Add to library', () => {
    const out = form({ result: result() });
    expect(out).toContain('aria-label="Generated audio preview"');
    expect(out).toMatch(/<audio[^>]*controls=""[^>]*src="blob:http:\/\/localhost\/abc"|<audio[^>]*src="blob:http:\/\/localhost\/abc"[^>]*controls=""/);
    expect(out).toContain('3.0 s · 8000 Hz mono 16-bit WAV');
    expect(out).toMatch(/<a[^>]*href="blob:http:\/\/localhost\/abc"[^>]*download="Welcome to our company\.wav"|<a[^>]*download="Welcome to our company\.wav"[^>]*href="blob:http:\/\/localhost\/abc"/);
    expect(out).toContain('Add to library');
    expect(out).not.toContain('generate again');
  });

  it('says so when the text or voice changed since the audio was made', () => {
    expect(form({ result: result(), text: 'A different sentence.' })).toContain('text or voice changed: generate again');
    expect(form({ result: result(), voice: 'Ravi' })).toContain('text or voice changed: generate again');
  });

  it('cannot add without a name, or twice, and says what happened after adding', () => {
    const disabledAdd = (out: string) => /disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Add to library|Add to library/.test(out) && /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Add to library/.test(out);
    expect(disabledAdd(form({ result: result(), name: '  ' }))).toBe(true);
    expect(disabledAdd(form({ result: result() }))).toBe(false);
    const added = form({ result: result(), added: { duplicate: false } });
    expect(disabledAdd(added)).toBe(true);
    expect(added).toContain('Added to the library. Pick it in the menu below.');
    expect(form({ result: result(), added: { duplicate: true } })).toContain('already in the library');
  });

  it('shows an upload refusal (the library\'s own reason) next to the result', () => {
    const out = form({ result: result(), addState: { status: 'error', message: 'This audio file cannot be used: it is too short (50 ms)' } });
    expect(out).toContain('This audio file cannot be used: it is too short (50 ms)');
  });
});

describe('inside the audio library', () => {
  const rules = { sampleRate: 8000, persistent: true, maxBytes: 4 * 1024 * 1024, minDurationMs: 100, maxDurationMs: 120_000 };
  it('adds a "Generate audio from text" option, closed until asked for, beside the existing upload', () => {
    const out = html(React.createElement(AudioLibrary, { assets: [], rules, inUse: new Set<string>(), state: idle, onUpload: async () => undefined, onDelete: noop }));
    expect(out).toContain('Generate audio from text');
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('aria-label="Generate audio from text"'); // the form itself is not shown yet
    expect(out).toContain('Choose a WAV file to upload'); // the upload is untouched
    expect(out).toContain('No audio yet');
  });
});
