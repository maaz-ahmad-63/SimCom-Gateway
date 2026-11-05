import { describe, expect, it } from 'vitest';
import { defaultIvrConfig, ivrConfigSchema, IvrConfig, referencedAssetIds } from '../../src/ivr/config.js';
import { validateIvrConfig } from '../../src/ivr/validation.js';
import { completeConfig, memoryAssets } from './helpers.js';

const GHOST = 'a'.repeat(64); // a well-formed asset id that no store has

const valid = (config: unknown, assets = memoryAssets()) => validateIvrConfig(config, assets);
const paths = (issues: Array<{ path: string }>) => issues.map((i) => i.path);

describe('the configuration model (shape only)', () => {
  it('the default configuration matches the model, is outbound-only, and starts empty', () => {
    const config = defaultIvrConfig();
    expect(ivrConfigSchema.safeParse(config).success).toBe(true);
    expect(config.direction).toBe('outbound');
    expect(config.options).toEqual([]);
  });

  it('is outbound only: "both" and anything else is refused', () => {
    expect(ivrConfigSchema.safeParse({ ...defaultIvrConfig(), direction: 'outbound' }).success).toBe(true);
    expect(ivrConfigSchema.safeParse({ ...defaultIvrConfig(), direction: 'both' }).success).toBe(false);
    expect(ivrConfigSchema.safeParse({ ...defaultIvrConfig(), direction: 'sideways' }).success).toBe(false);
  });

  it('a configuration saved when the IVR ran on incoming calls still loads, and is read as outbound (the menu is unchanged)', () => {
    const parsed = ivrConfigSchema.safeParse({ ...defaultIvrConfig(), direction: 'inbound', maxRetries: 3 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.direction).toBe('outbound');
      expect(parsed.data.maxRetries).toBe(3);
    }
  });

  it('accepts the twelve phone keys and refuses anything else', () => {
    for (const key of ['0', '1', '5', '9', '*', '#']) {
      expect(ivrConfigSchema.safeParse({ ...defaultIvrConfig(), options: [{ key, label: 'x', action: { type: 'connect-ai' } }] }).success, key).toBe(true);
    }
    for (const key of ['A', 'D', '10', '', ' 1', 'ONE', 1]) {
      expect(ivrConfigSchema.safeParse({ ...defaultIvrConfig(), options: [{ key, label: 'x', action: { type: 'connect-ai' } }] }).success, String(key)).toBe(false);
    }
  });

  it('timeout and retry limits: inclusive bounds, whole numbers only', () => {
    const with_ = (patch: Partial<IvrConfig>) => ivrConfigSchema.safeParse({ ...defaultIvrConfig(), ...patch }).success;
    expect(with_({ inputTimeoutMs: 2000 })).toBe(true);
    expect(with_({ inputTimeoutMs: 30000 })).toBe(true);
    expect(with_({ inputTimeoutMs: 1999 })).toBe(false);
    expect(with_({ inputTimeoutMs: 30001 })).toBe(false);
    expect(with_({ inputTimeoutMs: 5000.5 })).toBe(false);
    expect(with_({ maxRetries: 0 })).toBe(true);
    expect(with_({ maxRetries: 5 })).toBe(true);
    expect(with_({ maxRetries: 6 })).toBe(false);
    expect(with_({ maxRetries: -1 })).toBe(false);
    expect(with_({ maxRetries: 1.5 })).toBe(false);
  });

  it('labels need text and have a length limit; there are at most twelve options', () => {
    const one = (label: string) => ({ ...defaultIvrConfig(), options: [{ key: '1', label, action: { type: 'connect-ai' } }] });
    expect(ivrConfigSchema.safeParse(one('Sales')).success).toBe(true);
    expect(ivrConfigSchema.safeParse(one('')).success).toBe(false);
    expect(ivrConfigSchema.safeParse(one('   ')).success).toBe(false);
    expect(ivrConfigSchema.safeParse(one('x'.repeat(61))).success).toBe(false);
    const keys = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'];
    const many = (n: number) => ({ ...defaultIvrConfig(), options: Array.from({ length: n }, (_, i) => ({ key: keys[i % 12], label: 'x', action: { type: 'connect-ai' } })) });
    expect(ivrConfigSchema.safeParse(many(12)).success).toBe(true);
    expect(ivrConfigSchema.safeParse(many(13)).success).toBe(false);
  });

  it('asset references must look like asset ids', () => {
    for (const id of ['', 'abc', 'A'.repeat(64), '../../etc/passwd', 'g'.repeat(64), 'a'.repeat(63)]) {
      expect(ivrConfigSchema.safeParse({ ...defaultIvrConfig(), welcome: { assetId: id } }).success, id).toBe(false);
    }
    expect(ivrConfigSchema.safeParse({ ...defaultIvrConfig(), welcome: { assetId: GHOST } }).success).toBe(true);
  });
});

describe('publish validation (what a shape cannot say)', () => {
  it('a complete configuration passes, with real assets', () => {
    const assets = memoryAssets();
    const { config } = completeConfig(assets);
    const result = valid(config, assets);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('the empty default is a valid draft but cannot be published: there would be nothing to hear', () => {
    const result = valid(defaultIvrConfig());
    expect(result.ok).toBe(false);
    expect(paths(result.errors)).toContain('welcome.assetId');
  });

  it('duplicate DTMF keys are refused, naming the repeated one', () => {
    const assets = memoryAssets();
    const { config } = completeConfig(assets);
    const dup: IvrConfig = { ...config, options: [...config.options, { key: '1', label: 'Another one', action: { type: 'repeat-menu' } }] };
    const result = valid(dup, assets);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({ path: 'options[4].key', message: expect.stringContaining('key "1" is already used by option 1') })]);
  });

  it('every audio reference must exist, and each problem says where it is', () => {
    const assets = memoryAssets();
    const { config } = completeConfig(assets);
    const broken: IvrConfig = {
      ...config,
      welcome: { assetId: GHOST },
      menu: { assetId: 'b'.repeat(64) },
      invalid: { assetId: 'c'.repeat(64) },
      timeout: { assetId: 'd'.repeat(64) },
      options: [
        { key: '1', label: 'a', action: { type: 'play-announcement', assetId: 'e'.repeat(64), then: 'hang-up' } },
        { key: '2', label: 'b', action: { type: 'hang-up', goodbyeAssetId: 'f'.repeat(64) } },
      ],
      finalAction: { type: 'hang-up', goodbyeAssetId: '1'.repeat(64) },
    };
    const result = valid(broken, assets);
    expect(result.ok).toBe(false);
    expect(paths(result.errors).sort()).toEqual(
      ['welcome.assetId', 'menu.assetId', 'invalid.assetId', 'timeout.assetId', 'options[0].action.assetId', 'options[1].action.goodbyeAssetId', 'finalAction.goodbyeAssetId'].sort()
    );
  });

  it('an announcement option with no announcement chosen is refused', () => {
    const assets = memoryAssets();
    const { config } = completeConfig(assets);
    const result = valid({ ...config, options: [{ key: '1', label: 'x', action: { type: 'play-announcement', assetId: null, then: 'return-to-menu' } }] }, assets);
    expect(paths(result.errors)).toEqual(['options[0].action.assetId']);
  });

  it('options need a menu announcement, and the caller must hear something', () => {
    const assets = memoryAssets();
    const { config } = completeConfig(assets);
    expect(paths(valid({ ...config, menu: { assetId: null } }, assets).errors)).toEqual(['menu.assetId']);
    const silent = valid({ ...config, welcome: { assetId: null }, menu: { assetId: null }, options: [] }, assets);
    expect(silent.ok).toBe(false);
    expect(paths(silent.errors)).toEqual(['welcome.assetId']);
  });

  it('a welcome alone is a valid IVR with no menu: it announces, then runs the final action (a warning says so)', () => {
    const assets = memoryAssets();
    const { config, ids } = completeConfig(assets);
    const result = valid({ ...config, menu: { assetId: null }, invalid: { assetId: null }, timeout: { assetId: null }, options: [], finalAction: { type: 'hang-up', goodbyeAssetId: ids.bye } }, assets);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([expect.objectContaining({ path: 'options', message: expect.stringContaining('end the call') })]);
  });

  it('missing optional prompts only warn: they never block publishing', () => {
    const assets = memoryAssets();
    const { config } = completeConfig(assets);
    const result = valid({ ...config, invalid: { assetId: null }, timeout: { assetId: null } }, assets);
    expect(result.ok).toBe(true);
    expect(paths(result.warnings).sort()).toEqual(['invalid.assetId', 'timeout.assetId']);
  });

  it('a document that does not match the model is reported by the model, with paths, and nothing else', () => {
    const result = valid({ ...defaultIvrConfig(), maxRetries: 99, options: [{ key: 'Q', label: '', action: { type: 'submenu' } }] });
    expect(result.ok).toBe(false);
    expect(paths(result.errors)).toEqual(expect.arrayContaining(['maxRetries', 'options[0].key', 'options[0].label']));
    expect(result.warnings).toEqual([]);
  });

  it('referencedAssetIds lists each asset once, in use order', () => {
    const assets = memoryAssets();
    const { config, ids } = completeConfig(assets);
    expect(referencedAssetIds(config)).toEqual([ids.welcome, ids.menu, ids.invalid, ids.timeout, ids.info, ids.bye]);
    expect(referencedAssetIds(defaultIvrConfig())).toEqual([]);
  });
});
