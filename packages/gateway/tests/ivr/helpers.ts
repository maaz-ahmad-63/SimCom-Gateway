import { createHash } from 'node:crypto';
import { wavHeader } from '../../src/recording/wav.js';
import type { SettingsBackend } from '../../src/ai/settings.js';
import { defaultIvrConfig, IvrConfig } from '../../src/ivr/config.js';
import { IvrAssetStore } from '../../src/ivr/assets.js';

/** A canonical PCM WAV. `tone` makes the content differ (so two calls give two different ids). */
export function wav(opts: { rate?: number; channels?: number; bits?: number; ms?: number; dataBytes?: number; tone?: number } = {}): Buffer {
  const rate = opts.rate ?? 8000;
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const bytesPerMs = (rate * channels * (bits / 8)) / 1000;
  const dataBytes = opts.dataBytes ?? Math.round((opts.ms ?? 1000) * bytesPerMs);
  const data = Buffer.alloc(dataBytes);
  const tone = opts.tone ?? 440;
  if (bits === 16) {
    for (let i = 0; i + 1 < dataBytes; i += 2) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * tone * (i / 2 / channels)) / rate) * 8000), i);
  }
  return Buffer.concat([wavHeader(rate, channels, bits, dataBytes), data]);
}

/** A WAV with an extra LIST chunk before the data, as many audio editors write. */
export function wavWithListChunk(): Buffer {
  const base = wav({ ms: 500 });
  const data = base.subarray(44);
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]);
  const header = Buffer.from(base.subarray(0, 36));
  header.writeUInt32LE(header.length - 8 + list.length + 8 + data.length, 4);
  const dataChunk = Buffer.concat([Buffer.from('data'), Buffer.from([0, 0, 0, 0]), data]);
  dataChunk.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, list, dataChunk]);
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** The settings table, as a Map (the same three methods the repository offers). */
export function memoryBackend(): SettingsBackend & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getSetting: (key) => map.get(key) ?? null,
    setSetting: (key, value) => void map.set(key, value),
    deleteSetting: (key) => void map.delete(key),
  };
}

export const memoryAssets = (rate = 8000) => new IvrAssetStore({ dir: null, sampleRate: () => rate });

/** A complete, publishable configuration built from real assets in `assets`. */
export function completeConfig(assets: IvrAssetStore): { config: IvrConfig; ids: Record<string, string> } {
  const add = (name: string, tone: number) => assets.add(wav({ ms: 800, tone }), name).asset.id;
  const ids = { welcome: add('welcome', 300), menu: add('menu', 400), invalid: add('invalid', 500), timeout: add('timeout', 600), info: add('info', 700), bye: add('bye', 800) };
  const config: IvrConfig = {
    ...defaultIvrConfig(),
    welcome: { assetId: ids.welcome },
    menu: { assetId: ids.menu },
    invalid: { assetId: ids.invalid },
    timeout: { assetId: ids.timeout },
    options: [
      { key: '1', label: 'Talk to the AI assistant', action: { type: 'connect-ai' } },
      { key: '2', label: 'Opening hours', action: { type: 'play-announcement', assetId: ids.info, then: 'return-to-menu' } },
      { key: '3', label: 'Hear the menu again', action: { type: 'repeat-menu' } },
      { key: '9', label: 'Goodbye', action: { type: 'hang-up', goodbyeAssetId: ids.bye } },
    ],
    finalAction: { type: 'hang-up', goodbyeAssetId: ids.bye },
  };
  return { config, ids };
}
