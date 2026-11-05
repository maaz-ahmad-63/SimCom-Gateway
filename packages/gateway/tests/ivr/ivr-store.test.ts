import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayRepository } from '../../src/db/repository.js';
import { runMigrations } from '../../src/db/migrations.js';
import { IvrAssetStore } from '../../src/ivr/assets.js';
import { defaultIvrConfig, IvrConfig } from '../../src/ivr/config.js';
import { IvrError } from '../../src/ivr/errors.js';
import { IVR_KEYS, IvrStore } from '../../src/ivr/store.js';
import { completeConfig, memoryAssets, memoryBackend, wav } from './helpers.js';

function make(rate = 8000) {
  const backend = memoryBackend();
  const assets = memoryAssets(rate);
  const store = new IvrStore({ backend, assets, now: () => new Date('2026-11-03T12:00:00.000Z') });
  return { backend, assets, store, ...completeConfig(assets) };
}

const thrown = (fn: () => unknown): IvrError => {
  try {
    fn();
  } catch (error) {
    return error as IvrError;
  }
  throw new Error('expected an IvrError');
};

describe('the IVR is off and empty by default', () => {
  it('disabled, nothing published, version 0, an empty draft, and no snapshot (calls are handled exactly as before)', () => {
    const { store } = make();
    expect(store.isEnabled()).toBe(false);
    expect(store.getPublished()).toBeNull();
    expect(store.version()).toBe(0);
    expect(store.getDraft()).toEqual(defaultIvrConfig());
    expect(store.snapshot()).toBeNull();
    expect(store.status()).toEqual({ enabled: false, publishedVersion: 0, publishedAt: null, hasSavedDraft: false, unpublishedChanges: false, problems: [] });
  });

  it('a damaged or unexpected "enabled" value means off', () => {
    const { store, backend } = make();
    for (const value of ['', 'TRUE', '1', 'yes', 'null', '{"enabled":true}']) {
      backend.map.set(IVR_KEYS.enabled, value);
      expect(store.isEnabled(), value).toBe(false);
    }
  });
});

describe('the draft', () => {
  it('is saved under ivr.draft and survives a restart (a new store over the same settings)', () => {
    const { store, backend, config, assets } = make();
    store.saveDraft(config);
    expect(backend.map.has(IVR_KEYS.draft)).toBe(true);
    const restarted = new IvrStore({ backend, assets });
    expect(restarted.getDraft()).toEqual(config);
    expect(restarted.status().hasSavedDraft).toBe(true);
  });

  it('may be incomplete (no audio at all) but must match the model', () => {
    const { store } = make();
    expect(() => store.saveDraft(defaultIvrConfig())).not.toThrow();
    const e = thrown(() => store.saveDraft({ ...defaultIvrConfig(), maxRetries: 50, options: [{ key: 'Z', label: 'x', action: { type: 'submenu' } }] }));
    expect(e.code).toBe('invalid_config');
    expect(e.status).toBe(422);
    expect(e.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['maxRetries', 'options[0].key']));
  });

  it('a refused save leaves the previous draft exactly as it was', () => {
    const { store, config } = make();
    store.saveDraft(config);
    expect(() => store.saveDraft({ ...config, inputTimeoutMs: 1 })).toThrow(IvrError);
    expect(store.getDraft()).toEqual(config);
  });

  it('discarding it goes back to editing the published configuration', () => {
    const { store, config } = make();
    store.saveDraft(config);
    store.publish();
    store.saveDraft({ ...config, maxRetries: 4 });
    expect(store.getDraft().maxRetries).toBe(4);
    store.discardDraft();
    expect(store.getDraft()).toEqual(config);
    expect(store.status().hasSavedDraft).toBe(false);
  });
});

describe('publishing', () => {
  it('refuses an incomplete draft, says what is wrong, and changes nothing', () => {
    const { store, backend } = make();
    store.saveDraft(defaultIvrConfig());
    const e = thrown(() => store.publish());
    expect(e.code).toBe('invalid_config');
    expect(e.issues.length).toBeGreaterThan(0);
    expect(store.getPublished()).toBeNull();
    expect(store.version()).toBe(0);
    expect(backend.map.has(IVR_KEYS.published)).toBe(false);
    expect(backend.map.has(IVR_KEYS.version)).toBe(false);
  });

  it('refuses duplicate keys and missing audio at publish time even though the draft saved', () => {
    const { store, config } = make();
    store.saveDraft({ ...config, options: [...config.options, { key: '1', label: 'dup', action: { type: 'repeat-menu' } }] });
    expect(thrown(() => store.publish()).issues.map((i) => i.message).join(' ')).toContain('already used');
    store.saveDraft({ ...config, welcome: { assetId: 'f'.repeat(64) } });
    expect(thrown(() => store.publish()).issues).toEqual([expect.objectContaining({ path: 'welcome.assetId' })]);
    expect(store.getPublished()).toBeNull();
  });

  it('refuses when there is no saved draft', () => {
    const { store } = make();
    const e = thrown(() => store.publish());
    expect(e.code).toBe('invalid_config');
    expect(e.status).toBe(409);
  });

  it('publishes a complete draft: stored under ivr.published with a version and time, and the counter under ivr.version', () => {
    const { store, backend, config } = make();
    store.saveDraft(config);
    const published = store.publish();
    expect(published).toEqual({ version: 1, publishedAt: '2026-11-03T12:00:00.000Z', config });
    expect(JSON.parse(backend.map.get(IVR_KEYS.published)!)).toEqual(published);
    expect(backend.map.get(IVR_KEYS.version)).toBe('1');
    expect(store.getPublished()).toEqual(published);
    expect(store.status()).toMatchObject({ publishedVersion: 1, unpublishedChanges: false });
  });

  it('each publish is the next version; editing the draft does not touch what is published', () => {
    const { store, config } = make();
    store.saveDraft(config);
    expect(store.publish().version).toBe(1);
    store.saveDraft({ ...config, maxRetries: 4 });
    expect(store.getPublished()!.config.maxRetries).toBe(2); // still the old one
    expect(store.status().unpublishedChanges).toBe(true);
    expect(store.publish().version).toBe(2);
    expect(store.getPublished()!.config.maxRetries).toBe(4);
    expect(store.status().unpublishedChanges).toBe(false);
  });

  it('a refused publish does not change the published version', () => {
    const { store, config } = make();
    store.saveDraft(config);
    store.publish();
    store.saveDraft({ ...config, welcome: { assetId: 'f'.repeat(64) } });
    expect(() => store.publish()).toThrow(IvrError);
    expect(store.getPublished()!.version).toBe(1);
    expect(store.getPublished()!.config).toEqual(config);
  });

  it('version numbers are never reused, even if the published record is lost', () => {
    const { store, backend, config } = make();
    store.saveDraft(config);
    store.publish();
    store.publish();
    backend.map.delete(IVR_KEYS.published);
    expect(store.version()).toBe(2);
    expect(store.publish().version).toBe(3);
  });

  it('survives a stop between the two writes: a counter that is behind is corrected by the published record', () => {
    const { store, backend, config } = make();
    store.saveDraft(config);
    store.publish();
    backend.map.set(IVR_KEYS.version, '0');
    expect(store.version()).toBe(1);
    expect(store.publish().version).toBe(2);
  });

  it('refuses audio that is no longer at the gateway sample rate', () => {
    const backend = memoryBackend();
    let rate = 8000;
    const assets = new IvrAssetStore({ dir: null, sampleRate: () => rate });
    const store = new IvrStore({ backend, assets });
    const { config } = completeConfig(assets);
    store.saveDraft(config);
    rate = 16000; // the gateway was reconfigured after the audio was uploaded
    const e = thrown(() => store.publish());
    expect(e.code).toBe('invalid_config');
    expect(e.message).toContain('16000 Hz');
    expect(e.issues.length).toBeGreaterThan(0);
  });

  it('validate() checks a configuration the way publishing would, without changing anything', () => {
    const { store, config, backend } = make();
    const before = new Map(backend.map);
    expect(store.validate(config).ok).toBe(true);
    expect(store.validate(defaultIvrConfig()).ok).toBe(false);
    expect(store.validate().ok).toBe(false); // the (empty) draft
    expect(backend.map).toEqual(before);
  });
});

describe('turning it on', () => {
  it('cannot be enabled before something is published; once published it can be switched on and off, and the switch persists', () => {
    const { store, backend, config, assets } = make();
    const e = thrown(() => store.setEnabled(true));
    expect(e.code).toBe('not_published');
    expect(e.status).toBe(409);
    expect(store.isEnabled()).toBe(false);
    store.saveDraft(config);
    store.publish();
    expect(store.isEnabled()).toBe(false); // publishing does not turn it on
    store.setEnabled(true);
    expect(backend.map.get(IVR_KEYS.enabled)).toBe('true');
    expect(new IvrStore({ backend, assets }).isEnabled()).toBe(true);
    store.setEnabled(false);
    expect(new IvrStore({ backend, assets }).isEnabled()).toBe(false);
  });

  it('turning it off needs no published configuration', () => {
    const { store } = make();
    expect(store.setEnabled(false)).toBe(false);
  });
});

describe('deleting audio', () => {
  it('is refused while the draft or the published configuration uses it, and allowed once neither does', () => {
    const { store, config, ids } = make();
    store.saveDraft(config);
    store.publish();
    expect(thrown(() => store.removeAsset(ids.info)).code).toBe('asset_in_use');
    // Drop it from the draft only: the published configuration still needs it.
    const without: IvrConfig = { ...config, options: config.options.filter((o) => o.action.type !== 'play-announcement') };
    store.saveDraft(without);
    const e = thrown(() => store.removeAsset(ids.info));
    expect(e.code).toBe('asset_in_use');
    expect(e.message).toContain('published configuration (version 1)');
    store.publish();
    expect(store.removeAsset(ids.info)).toBe(true);
  });

  it('says plainly when the audio does not exist', () => {
    const { store } = make();
    const e = thrown(() => store.removeAsset('a'.repeat(64)));
    expect(e.code).toBe('asset_not_found');
    expect(e.status).toBe(404);
  });
});

describe('the per-call snapshot', () => {
  const live = () => {
    const ctx = make();
    ctx.store.saveDraft(ctx.config);
    ctx.store.publish();
    ctx.store.setEnabled(true);
    return ctx;
  };

  it('is null while the IVR is off, even with a published configuration', () => {
    const ctx = live();
    ctx.store.setEnabled(false);
    expect(ctx.store.snapshot()).toBeNull();
  });

  it('carries the published configuration, its version, and the samples of every announcement it uses', () => {
    const { store, config, ids, assets } = live();
    const snap = store.snapshot()!;
    expect(snap).toMatchObject({ version: 1, publishedAt: '2026-11-03T12:00:00.000Z', takenAt: '2026-11-03T12:00:00.000Z', sampleRate: 8000 });
    expect(snap.config).toEqual(config);
    for (const id of Object.values(ids)) expect(snap.pcm(id)!.equals(assets.readPcm(id)!)).toBe(true);
    expect(snap.pcm('0'.repeat(64))).toBeUndefined();
    expect(snap.pcm(ids.welcome)!.length).toBe(800 * 16); // 800 ms of 16-bit 8 kHz samples, no header
  });

  it('cannot be changed by later edits, a new publish, or a deleted asset', () => {
    const { store, config, ids, assets } = live();
    const snap = store.snapshot()!;
    const welcomeBefore = Buffer.from(snap.pcm(ids.welcome)!);
    const configBefore = JSON.parse(JSON.stringify(snap.config));

    store.saveDraft({ ...config, maxRetries: 5, options: [], welcome: { assetId: ids.bye }, menu: { assetId: null } });
    store.publish(); // version 2, a different IVR
    store.setEnabled(true);
    store.removeAsset(ids.info); // no longer referenced by anything
    assets.remove(ids.welcome); // even the audio itself going away

    expect(snap.version).toBe(1);
    expect(snap.config).toEqual(configBefore);
    expect(snap.pcm(ids.welcome)!.equals(welcomeBefore)).toBe(true);
    expect(snap.pcm(ids.info)).toBeDefined();
    expect(store.snapshot()!.version).toBe(2); // the next call gets the new one
  });

  it('is frozen: assigning to it, at any depth, is refused', () => {
    const { store } = live();
    const snap = store.snapshot()! as unknown as { config: IvrConfig; version: number };
    expect(() => {
      snap.config.maxRetries = 9;
    }).toThrow(TypeError);
    expect(() => {
      snap.config.options[0].label = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      (snap.config.options as unknown as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      snap.version = 99;
    }).toThrow(TypeError);
  });

  it('gives each call its own copy of the audio: scribbling on one call\'s samples does not reach another', () => {
    const { store, ids } = live();
    const a = store.snapshot()!;
    const b = store.snapshot()!;
    a.pcm(ids.menu)!.fill(0);
    expect(b.pcm(ids.menu)!.some((byte) => byte !== 0)).toBe(true);
    expect(store.snapshot()!.pcm(ids.menu)!.some((byte) => byte !== 0)).toBe(true);
  });

  it('fails clearly, not silently, when published audio is missing or no longer at the gateway rate', () => {
    const missing = live();
    missing.assets.remove(missing.ids.menu);
    const e = thrown(() => missing.store.snapshot());
    expect(e.code).toBe('asset_unavailable');
    expect(e.status).toBe(409);

    const backend = memoryBackend();
    let rate = 8000;
    const assets = new IvrAssetStore({ dir: null, sampleRate: () => rate });
    const store = new IvrStore({ backend, assets });
    store.saveDraft(completeConfig(assets).config);
    store.publish();
    store.setEnabled(true);
    rate = 16000;
    expect(thrown(() => store.snapshot()).message).toContain('16000 Hz');
  });
});

describe('damaged stored documents are reported, never silently replaced', () => {
  it('an unreadable published record is ignored, listed as a problem, and gives no snapshot', () => {
    const { store, backend, config } = make();
    store.saveDraft(config);
    store.publish();
    store.setEnabled(true);
    backend.map.set(IVR_KEYS.published, '{ definitely not json');
    expect(store.getPublished()).toBeNull();
    expect(store.snapshot()).toBeNull();
    expect(store.status().problems).toEqual([expect.stringContaining('published cannot be read')]);
  });

  it('a draft that no longer matches the model falls back to the published configuration and is reported', () => {
    const { store, backend, config } = make();
    store.saveDraft(config);
    store.publish();
    backend.map.set(IVR_KEYS.draft, JSON.stringify({ savedAt: 'x', config: { ...config, maxRetries: 99 } }));
    expect(store.getDraft()).toEqual(config);
    expect(store.status().problems).toEqual([expect.stringContaining('draft cannot be read')]);
  });
});

describe('with a real SQLite repository and an in-memory database (no asset folder)', () => {
  const dbs: Database.Database[] = [];
  afterEach(() => dbs.splice(0).forEach((d) => d.close()));

  it('uses the existing gateway_settings table: no new table, no migration, and the keys are ordinary settings rows', () => {
    const db = new Database(':memory:');
    dbs.push(db);
    runMigrations(db);
    const tablesBefore = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const repository = new GatewayRepository(db);
    const assets = new IvrAssetStore({ dir: null, sampleRate: () => 8000 });
    const store = new IvrStore({ backend: repository, assets });
    const { config } = completeConfig(assets);

    store.saveDraft(config);
    const published = store.publish();
    store.setEnabled(true);

    const rows = db.prepare("SELECT key, value FROM gateway_settings WHERE key LIKE 'ivr.%' ORDER BY key").all() as Array<{ key: string; value: string }>;
    expect(rows.map((r) => r.key)).toEqual(['ivr.draft', 'ivr.enabled', 'ivr.published', 'ivr.version']);
    expect(JSON.parse(rows.find((r) => r.key === 'ivr.published')!.value)).toEqual(published);
    expect(rows.find((r) => r.key === 'ivr.enabled')!.value).toBe('true');
    expect(rows.find((r) => r.key === 'ivr.version')!.value).toBe('1');
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)).toEqual(tablesBefore);

    // A second store over the same database (a restart) sees everything.
    const restarted = new IvrStore({ backend: repository, assets });
    expect(restarted.isEnabled()).toBe(true);
    expect(restarted.getPublished()).toEqual(published);
    expect(restarted.snapshot()!.version).toBe(1);
  });

  it('works with an asset folder that does not exist yet, creating it on the first upload', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ivr-store-'));
    try {
      const dir = path.join(base, 'ivr');
      const assets = new IvrAssetStore({ dir, sampleRate: () => 8000 });
      const store = new IvrStore({ backend: memoryBackend(), assets });
      expect(store.validate(defaultIvrConfig()).ok).toBe(false); // reading with no folder is fine
      expect(fs.existsSync(dir)).toBe(false);
      assets.add(wav(), 'first');
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
