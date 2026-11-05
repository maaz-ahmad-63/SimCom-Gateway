import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayApiClient, GatewayApiError } from '../src/lib/api-client';
import {
  ACTION_LABELS,
  actionOfType,
  addOption,
  describeAction,
  DTMF_KEYS,
  emptyConfig,
  finalActionOfType,
  formatBytes,
  formatDuration,
  isDirty,
  issueWhere,
  IvrAssetMeta,
  IvrConfig,
  IvrStatus,
  LIMITS,
  localIssues,
  nextFreeKey,
  readiness,
  ReadinessInput,
  referencedAssets,
  removeOption,
  saveProblems,
  statusSummary,
  updateOption,
} from '../src/lib/ivr';
import { AudioLibrary, audioRulesText } from '../src/components/ivr/AudioLibrary';
import { AnnouncementsCard, BehaviorCard, OptionsCard } from '../src/components/ivr/MenuEditor';
import { IssuesCard, ReadinessCard, StatusCard } from '../src/components/ivr/StatusPanel';
const A = (n: number) => String(n).repeat(64).slice(0, 64);
const asset = (id: string, name: string, durationMs = 1500): IvrAssetMeta => ({ id, name, bytes: durationMs * 16, durationMs, sampleRate: 8000, channels: 1, bitsPerSample: 16, createdAt: '2026-11-03T10:00:00Z' });
const ASSETS = [asset(A(1), 'Welcome'), asset(A(2), 'Menu'), asset(A(3), 'Invalid'), asset(A(4), 'Timeout'), asset(A(5), 'Hours'), asset(A(6), 'Bye')];
const status = (over: Partial<IvrStatus> = {}): IvrStatus => ({ enabled: false, publishedVersion: 0, publishedAt: null, hasSavedDraft: false, unpublishedChanges: false, problems: [], ...over });

const complete = (): IvrConfig => ({
  ...emptyConfig(),
  welcome: { assetId: A(1) },
  menu: { assetId: A(2) },
  invalid: { assetId: A(3) },
  timeout: { assetId: A(4) },
  options: [
    { key: '1', label: 'AI assistant', action: { type: 'connect-ai' } },
    { key: '2', label: 'Opening hours', action: { type: 'play-announcement', assetId: A(5), then: 'return-to-menu' } },
    { key: '3', label: 'Again', action: { type: 'repeat-menu' } },
    { key: '9', label: 'Goodbye', action: { type: 'hang-up', goodbyeAssetId: A(6) } },
  ],
  finalAction: { type: 'hang-up', goodbyeAssetId: A(6) },
});

describe('the dashboard\'s copy of the model stays in step with the gateway\'s', () => {
  // The gateway's own model and validator, loaded at run time by path (not imported statically) so the dashboard's TypeScript program does
  // not compile gateway source under its own, older target.
  type Gateway = {
    DTMF_KEYS: readonly string[];
    defaultIvrConfig: () => unknown;
    ivrConfigSchema: { safeParse(v: unknown): { success: boolean } };
    IVR_LIMITS: { maxOptions: number; labelMaxChars: number; inputTimeoutMs: { min: number; max: number }; maxRetries: { min: number; max: number } };
    validateIvrConfig: (c: unknown, assets: { has(id: string): boolean }) => { ok: boolean; errors: Array<{ path: string }>; warnings: Array<{ path: string }> };
  };
  let gw!: Gateway;
  beforeAll(async () => {
    const dir = path.resolve(__dirname, '../../gateway/src/ivr');
    const config: any = await import(/* @vite-ignore */ path.join(dir, 'config.ts'));
    const validation: any = await import(/* @vite-ignore */ path.join(dir, 'validation.ts'));
    gw = { DTMF_KEYS: config.DTMF_KEYS, defaultIvrConfig: config.defaultIvrConfig, ivrConfigSchema: config.ivrConfigSchema, IVR_LIMITS: config.IVR_LIMITS, validateIvrConfig: validation.validateIvrConfig };
  });
  it('the empty configuration is the gateway\'s default, and passes the gateway\'s schema', () => {
    expect(emptyConfig()).toEqual(gw.defaultIvrConfig());
    expect(gw.ivrConfigSchema.safeParse(emptyConfig()).success).toBe(true);
  });

  it('keys, limits and ranges are the gateway\'s', () => {
    expect([...DTMF_KEYS].sort()).toEqual([...gw.DTMF_KEYS].sort());
    expect(LIMITS.maxOptions).toBe(gw.IVR_LIMITS.maxOptions);
    expect(LIMITS.labelMaxChars).toBe(gw.IVR_LIMITS.labelMaxChars);
    expect(LIMITS.timeoutSeconds).toEqual({ min: gw.IVR_LIMITS.inputTimeoutMs.min / 1000, max: gw.IVR_LIMITS.inputTimeoutMs.max / 1000 });
    expect(LIMITS.retries).toEqual({ min: gw.IVR_LIMITS.maxRetries.min, max: gw.IVR_LIMITS.maxRetries.max });
  });

  it('everything the editor builds is accepted by the gateway\'s schema', () => {
    expect(gw.ivrConfigSchema.safeParse(complete()).success).toBe(true);
    let c = emptyConfig();
    for (let i = 0; i < 12; i++) c = addOption(c);
    expect(gw.ivrConfigSchema.safeParse(c).success).toBe(true);
    for (const type of ['connect-ai', 'play-announcement', 'repeat-menu', 'hang-up'] as const) {
      expect(gw.ivrConfigSchema.safeParse({ ...emptyConfig(), options: [{ key: '1', label: 'x', action: actionOfType(type) }] }).success, type).toBe(true);
    }
    for (const type of ['connect-ai', 'hang-up'] as const) expect(gw.ivrConfigSchema.safeParse({ ...emptyConfig(), finalAction: finalActionOfType(type, { type: 'connect-ai' }) }).success).toBe(true);
  });

  it('the local issues agree with the gateway\'s own validator on which paths are errors', () => {
    const have = new Set(ASSETS.map((a) => a.id));
    const cases: IvrConfig[] = [
      complete(),
      emptyConfig(),
      { ...complete(), options: [...complete().options, { key: '1', label: 'dup', action: { type: 'repeat-menu' } }] },
      { ...complete(), welcome: { assetId: A(7) }, menu: { assetId: null } },
      { ...complete(), options: [{ key: '1', label: 'x', action: { type: 'play-announcement', assetId: null, then: 'hang-up' } }] },
      { ...complete(), menu: { assetId: null } },
      { ...complete(), welcome: { assetId: null }, menu: { assetId: null }, options: [] },
      { ...complete(), finalAction: { type: 'hang-up', goodbyeAssetId: A(8) }, options: [{ key: '2', label: 'x', action: { type: 'hang-up', goodbyeAssetId: A(9) } }] },
      { ...complete(), invalid: { assetId: null }, timeout: { assetId: null } },
      { ...complete(), options: [], menu: { assetId: null } },
    ];
    for (const config of cases) {
      const mine = localIssues(config, ASSETS);
      const theirs = gw.validateIvrConfig(config, { has: (id) => have.has(id) });
      expect(mine.ok, JSON.stringify(config.options.map((o) => o.key))).toBe(theirs.ok);
      expect(mine.errors.map((e) => e.path).sort()).toEqual(theirs.errors.map((e) => e.path).sort());
      expect(mine.warnings.map((w) => w.path).sort()).toEqual(theirs.warnings.map((w) => w.path).sort());
    }
  });
});

describe('editing helpers', () => {
  it('picks the next free key in the order callers expect: 1-9, then 0, *, #', () => {
    let c = emptyConfig();
    const picked: string[] = [];
    for (let i = 0; i < 12; i++) {
      picked.push(nextFreeKey(c)!);
      c = addOption(c);
    }
    expect(picked).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#']);
    expect(nextFreeKey(c)).toBeNull();
    expect(addOption(c)).toBe(c); // a 13th option is not added
  });

  it('a new option gets a label and the AI action, and keys already taken are skipped', () => {
    const c = addOption({ ...emptyConfig(), options: [{ key: '1', label: 'x', action: { type: 'repeat-menu' } }] });
    expect(c.options[1]).toEqual({ key: '2', label: 'Option 2', action: { type: 'connect-ai' } });
  });

  it('removing and updating an option leaves the others alone', () => {
    const c = complete();
    expect(removeOption(c, 1).options.map((o) => o.key)).toEqual(['1', '3', '9']);
    expect(updateOption(c, 0, { key: '5' }).options.map((o) => o.key)).toEqual(['5', '2', '3', '9']);
    expect(c.options[0].key).toBe('1'); // not mutated
  });

  it('changing an option\'s action keeps a chosen announcement and resets the rest', () => {
    const play = actionOfType('play-announcement', { type: 'hang-up', goodbyeAssetId: A(6) });
    expect(play).toEqual({ type: 'play-announcement', assetId: A(6), then: 'return-to-menu' });
    expect(actionOfType('hang-up', { type: 'play-announcement', assetId: A(5), then: 'hang-up' })).toEqual({ type: 'hang-up', goodbyeAssetId: A(5) });
    expect(actionOfType('connect-ai', play)).toEqual({ type: 'connect-ai' });
    expect(actionOfType('play-announcement', { type: 'play-announcement', assetId: A(5), then: 'hang-up' })).toEqual({ type: 'play-announcement', assetId: A(5), then: 'hang-up' });
    expect(finalActionOfType('hang-up', { type: 'connect-ai' })).toEqual({ type: 'hang-up', goodbyeAssetId: null });
    expect(finalActionOfType('connect-ai', { type: 'hang-up', goodbyeAssetId: A(6) })).toEqual({ type: 'connect-ai' });
  });

  it('knows when the draft differs from what was saved, and which audio a menu uses', () => {
    expect(isDirty(complete(), complete())).toBe(false);
    expect(isDirty(complete(), { ...complete(), maxRetries: 4 })).toBe(true);
    expect(referencedAssets(complete()).sort()).toEqual([A(1), A(2), A(3), A(4), A(5), A(6)].sort());
    expect(referencedAssets(emptyConfig())).toEqual([]);
  });

  it('says why Save is off: empty or long labels, and out-of-range timing', () => {
    expect(saveProblems(complete())).toEqual([]);
    expect(saveProblems({ ...complete(), options: [{ key: '1', label: '  ', action: { type: 'connect-ai' } }] })).toEqual([expect.stringContaining('Option 1: give it a label')]);
    expect(saveProblems({ ...complete(), options: [{ key: '1', label: 'x'.repeat(61), action: { type: 'connect-ai' } }] })[0]).toContain('longer than 60');
    expect(saveProblems({ ...complete(), inputTimeoutMs: 1000 })[0]).toContain('between 2 and 30 seconds');
    expect(saveProblems({ ...complete(), inputTimeoutMs: 31_000 })[0]).toContain('between 2 and 30 seconds');
    expect(saveProblems({ ...complete(), maxRetries: 6 })[0]).toContain('0 to 5');
    expect(saveProblems({ ...complete(), maxRetries: 1.5 })[0]).toContain('whole number');
  });

  it('describes actions and issue locations in the page\'s own words', () => {
    expect(describeAction({ type: 'connect-ai' }, ASSETS)).toBe('Connect to the AI assistant');
    expect(describeAction({ type: 'play-announcement', assetId: A(5), then: 'hang-up' }, ASSETS)).toBe('Play "Hours", then hang up');
    expect(describeAction({ type: 'play-announcement', assetId: A(9), then: 'return-to-menu' }, ASSETS)).toContain('missing audio file');
    expect(describeAction({ type: 'hang-up', goodbyeAssetId: null }, ASSETS)).toBe('Hang up');
    expect(describeAction({ type: 'hang-up', goodbyeAssetId: A(6) }, ASSETS)).toBe('Play "Bye", then hang up');
    expect(issueWhere('options[2].action.assetId')).toBe('Option 3');
    expect(issueWhere('menu.assetId')).toBe('Menu prompt');
    expect(issueWhere('timeout.assetId')).toBe('No input');
    expect(issueWhere('finalAction.goodbyeAssetId')).toBe('Final action');
    expect(Object.keys(ACTION_LABELS)).toEqual(['connect-ai', 'play-announcement', 'repeat-menu', 'hang-up']);
  });

  it('formats sizes and durations', () => {
    expect(formatDuration(1500)).toBe('1.5 s');
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatBytes(24_000)).toBe('23 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('local issues (what publishing would object to)', () => {
  it('a complete menu has no errors and no warnings', () => {
    expect(localIssues(complete(), ASSETS)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('names the repeated key, the missing audio and the missing menu prompt, each with where', () => {
    const c: IvrConfig = { ...complete(), menu: { assetId: null }, options: [...complete().options, { key: '1', label: 'dup', action: { type: 'repeat-menu' } }], welcome: { assetId: A(7) } };
    const r = localIssues(c, ASSETS);
    expect(r.ok).toBe(false);
    const told = r.errors.map((e) => `${issueWhere(e.path)}: ${e.message}`);
    expect(told).toHaveLength(3);
    expect(told).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Welcome: this audio file is no longer in the library/),
        expect.stringMatching(/^Menu prompt: add the menu announcement/),
        expect.stringMatching(/^Option 5: key "1" is already used by option 1/),
      ])
    );
  });
});

describe('status and readiness', () => {
  it('summarizes the IVR in plain words, including "on but not running"', () => {
    expect(statusSummary(status(), null)).toMatchObject({ label: 'IVR off', tone: 'neutral' });
    expect(statusSummary(status({ enabled: true, publishedVersion: 3 }), { controllerRegistered: true, activeCalls: [], aiCanAnswer: true })).toMatchObject({ label: 'IVR on · version 3', tone: 'good' });
    const broken = statusSummary(status({ enabled: true, publishedVersion: 3 }), { controllerRegistered: false, activeCalls: [], aiCanAnswer: true });
    expect(broken.tone).toBe('bad');
    expect(broken.detail).toContain('NOT handled by it');
  });

  const good = (): ReadinessInput => ({
    health: { driverType: 'hardware', modem: { connectionState: 'READY', atPort: 'COM20', audioPort: 'COM19' } },
    ai: { readiness: { mode: 'active', checks: [{ name: 'outbound-audio', status: 'pass', detail: 'ok' }] } },
    runtime: { controllerRegistered: true, activeCalls: [], aiCanAnswer: true },
    status: status({ enabled: true, publishedVersion: 2 }),
  });

  it('everything that can be known is fine: nothing blocks, and the key mapping is still listed as a call-time check, never as passed', () => {
    const r = readiness(good());
    expect(r.blockers).toEqual([]);
    expect(r.canRun).toBe(true);
    const keys = r.items.find((i) => i.label === 'USB audio and key presses')!;
    expect(keys.tone).toBe('warn');
    expect(keys.detail).toContain('first test call');
    expect(r.items.find((i) => i.label === 'Modem')!.detail).toBe('READY on COM20 (audio COM19)');
  });

  it('each real blocker is reported on its own', () => {
    const one = (patch: Partial<ReadinessInput>) => readiness({ ...good(), ...patch }).blockers.join(' | ');
    expect(one({ health: null })).toContain('gateway did not answer');
    expect(one({ health: { driverType: 'mock', modem: { connectionState: 'READY', atPort: '', audioPort: '' } } })).toContain('simulated modem');
    expect(one({ health: { driverType: 'hardware', modem: { connectionState: 'DISCONNECTED', atPort: 'COM20', audioPort: 'COM19' } } })).toContain('DISCONNECTED, not READY');
    expect(one({ runtime: { controllerRegistered: false, activeCalls: [], aiCanAnswer: true } })).toContain('IVR controller');
    expect(one({ ai: { readiness: { mode: 'active', checks: [{ name: 'outbound-audio', status: 'unverified', detail: 'audibility has not been confirmed' }] } } })).toMatch(/Outbound audio: audibility has not been confirmed.*confirm it on the AI page/);
    expect(one({ status: status() })).toContain('nothing is published yet');
  });

  it('says what happens when the IVR fails, depending on whether the AI can answer', () => {
    expect(readiness(good()).items.find((i) => i.label === 'If the IVR fails')).toMatchObject({ tone: 'good' });
    const passive = readiness({ ...good(), runtime: { controllerRegistered: true, activeCalls: [], aiCanAnswer: false } });
    expect(passive.items.find((i) => i.label === 'If the IVR fails')).toMatchObject({ tone: 'warn', detail: expect.stringContaining('ends the call') });
    expect(passive.canRun).toBe(true); // a limitation worth knowing, not a blocker
  });
});

describe('the page\'s components', () => {
  const html = (el: React.ReactElement) => renderToStaticMarkup(el);
  const noop = () => {};

  it('announcements: four pickers, each over the uploaded audio, with a missing file called out', () => {
    const out = html(React.createElement(AnnouncementsCard, { config: { ...complete(), welcome: { assetId: A(9) } }, assets: ASSETS, onChange: noop }));
    for (const label of ['Welcome announcement', 'Menu prompt', 'Invalid-input announcement', 'No-input announcement']) expect(out).toContain(label);
    expect(out).toContain('Missing audio file');
    expect(out).toContain('Welcome · 1.5 s');
  });

  it('options: a row per option with its key and action, the action\'s own fields, and a duplicate warning', () => {
    const config = { ...complete(), options: [...complete().options, { key: '2' as const, label: 'again', action: { type: 'connect-ai' as const } }] };
    const out = html(React.createElement(OptionsCard, { config, assets: ASSETS, onAdd: noop, onRemove: noop, onUpdate: noop }));
    expect(out).toContain('5 of 12');
    expect(out).toContain('Announcement to play');
    expect(out).toContain('Goodbye before hanging up');
    expect(out).toContain('Pressing <span class="font-mono text-slate-300">2</span> → Play &quot;Hours&quot;, then return to the menu');
    expect(out).toContain('This key is also used by an earlier option');
    expect(out).toContain('Add option');
  });

  it('options: Add is off at twelve options, and an empty menu explains what happens', () => {
    let full = emptyConfig();
    for (let i = 0; i < 12; i++) full = addOption(full);
    expect(html(React.createElement(OptionsCard, { config: full, assets: ASSETS, onAdd: noop, onRemove: noop, onUpdate: noop }))).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<button)[\s\S])*?Add option/);
    expect(html(React.createElement(OptionsCard, { config: emptyConfig(), assets: ASSETS, onAdd: noop, onRemove: noop, onUpdate: noop }))).toContain('final action below runs without waiting for a key');
  });

  it('behavior: timing in seconds, retries, and a goodbye picker only when the final action hangs up', () => {
    const hangUp = html(React.createElement(BehaviorCard, { config: complete(), assets: ASSETS, onChange: noop }));
    expect(hangUp).toContain('Wait for a key (seconds)');
    expect(hangUp).toContain('value="6"');
    expect(hangUp).toContain('Goodbye before the final hang-up');
    const ai = html(React.createElement(BehaviorCard, { config: { ...complete(), finalAction: { type: 'connect-ai' } }, assets: ASSETS, onChange: noop }));
    expect(ai).not.toContain('Goodbye before the final hang-up');
  });

  it('status: off by default with the switch disabled until something is published; on shows the version and a turn-off button', () => {
    const off = html(React.createElement(StatusCard, { status: status(), runtime: null, state: { status: 'idle' }, onEnable: noop }));
    expect(off).toContain('IVR off');
    expect(off).toContain('nothing published');
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*>\s*Turn the IVR on/);
    const on = html(React.createElement(StatusCard, { status: status({ enabled: true, publishedVersion: 4, publishedAt: '2026-11-03T10:00:00Z', unpublishedChanges: true }), runtime: { controllerRegistered: true, activeCalls: ['c1'], aiCanAnswer: true }, state: { status: 'idle' }, onEnable: noop }));
    expect(on).toContain('IVR on · version 4');
    expect(on).toContain('published v4');
    expect(on).toContain('unpublished changes');
    expect(on).toContain('Turn the IVR off');
    expect(on).toContain('handling 1 call right now');
  });

  it('status: an IVR that is on but has no controller is shown as not running', () => {
    const out = html(React.createElement(StatusCard, { status: status({ enabled: true, publishedVersion: 1 }), runtime: { controllerRegistered: false, activeCalls: [], aiCanAnswer: true }, state: { status: 'idle' }, onEnable: noop }));
    expect(out).toContain('IVR on, not running');
  });

  it('readiness and issues lists show every item, with errors and warnings told apart', () => {
    const r = html(React.createElement(ReadinessCard, { canRun: false, items: [{ label: 'Modem', tone: 'bad', detail: 'not READY' }, { label: 'Keys', tone: 'warn', detail: 'check on the call' }] }));
    expect(r).toContain('blocked');
    expect(r).toContain('Modem');
    expect(r).toContain('check on the call');
    const issues = html(React.createElement(IssuesCard, { dirty: true, issues: { ok: false, errors: [{ path: 'options[1].key', message: 'key "1" is already used' }], warnings: [{ path: 'invalid.assetId', message: 'no invalid-key announcement' }] } }));
    expect(issues).toContain('1 to fix');
    expect(issues).toContain('Option 2:');
    expect(issues).toContain('Invalid input:');
    expect(issues).toContain('unsaved edits');
    expect(html(React.createElement(IssuesCard, { dirty: false, issues: { ok: true, errors: [], warnings: [] } }))).toContain('Nothing to fix.');
    expect(html(React.createElement(IssuesCard, { dirty: false, issues: null }))).toBe('');
  });

  it('audio library: the gateway\'s rules in words, an empty state, and delete off for audio that is in use', () => {
    const rules = { sampleRate: 8000, persistent: true, maxBytes: 4 * 1024 * 1024, minDurationMs: 100, maxDurationMs: 120_000 };
    expect(audioRulesText(rules)).toContain('mono, 16-bit, 8000 Hz, 0.1 s to 120 s, up to 4.0 MB');
    expect(audioRulesText(rules)).toContain('never converts, resamples or changes the volume');
    const empty = html(React.createElement(AudioLibrary, { assets: [], rules, inUse: new Set<string>(), state: { status: 'idle' }, onUpload: async () => undefined, onDelete: noop }));
    expect(empty).toContain('No audio yet');
    const list = html(React.createElement(AudioLibrary, { assets: ASSETS.slice(0, 2), rules, inUse: new Set([A(1)]), state: { status: 'idle' }, onUpload: async () => undefined, onDelete: noop }));
    expect(list).toContain('2 files');
    expect(list).toContain('in use');
    expect(list).toMatch(/aria-label="Delete Welcome"[^>]*disabled=""|disabled=""[^>]*aria-label="Delete Welcome"/);
    expect(list).not.toMatch(/disabled=""[^>]*aria-label="Delete Menu"|aria-label="Delete Menu"[^>]*disabled=""/);
  });

  it('the navigation links to the page, and the page exists', () => {
    const nav = fs.readFileSync(path.resolve(__dirname, '../src/components/layout/Navigation.tsx'), 'utf8');
    expect(nav).toContain("href: '/ivr'");
    expect(fs.existsSync(path.resolve(__dirname, '../src/app/ivr/page.tsx'))).toBe(true);
  });
});

describe('the IVR is for outgoing calls only', () => {
  it('a new configuration is outbound, and the screens say so instead of promising incoming-call handling', () => {
    expect(emptyConfig().direction).toBe('outbound');
    const on = statusSummary(status({ enabled: true, publishedVersion: 2, publishedAt: '2026-11-03T10:00:00Z' }), { controllerRegistered: true, activeCalls: [], aiCanAnswer: true });
    expect(on.detail).toMatch(/outgoing calls/i);
    expect(on.detail).toMatch(/Incoming calls are not affected/);
    const page = fs.readFileSync(path.resolve(__dirname, '../src/app/ivr/page.tsx'), 'utf8');
    expect(page).toMatch(/outgoing calls only/);
    expect(page).not.toMatch(/Answer incoming calls/);
    const panel = fs.readFileSync(path.resolve(__dirname, '../src/components/ivr/StatusPanel.tsx'), 'utf8');
    expect(panel).toMatch(/every OUTGOING call/);
    expect(panel).not.toMatch(/every incoming call is answered/);
  });
});

describe('GatewayApiClient IVR methods', () => {
  const original = global.fetch;
  beforeEach(() => void (global.fetch = vi.fn()));
  afterEach(() => {
    global.fetch = original;
    vi.restoreAllMocks();
  });
  const client = () => new GatewayApiClient({ gatewayUrl: 'http://gw:4000/', apiKey: 'key-123456' });
  const ok = (body: unknown) => (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, json: async () => body });
  const call = (n = 0) => (global.fetch as ReturnType<typeof vi.fn>).mock.calls[n] as [string, RequestInit & { headers: Record<string, string> }];

  it('reads the overview, saves and discards the draft, validates, publishes and switches on and off with the right verbs and bodies', async () => {
    ok({ success: true });
    await client().getIvr();
    expect(call()[0]).toBe('http://gw:4000/api/ivr');
    expect(call()[1].headers['x-api-key']).toBe('key-123456');

    ok({ success: true });
    await client().saveIvrDraft(complete());
    expect(call(1)[0]).toBe('http://gw:4000/api/ivr/draft');
    expect(call(1)[1].method).toBe('PUT');
    expect(JSON.parse(call(1)[1].body as string)).toEqual(complete());

    ok({ success: true });
    await client().discardIvrDraft();
    expect([call(2)[0], call(2)[1].method]).toEqual(['http://gw:4000/api/ivr/draft', 'DELETE']);

    ok({ success: true });
    await client().validateIvr();
    expect([call(3)[0], call(3)[1].method, call(3)[1].body]).toEqual(['http://gw:4000/api/ivr/validate', 'POST', '{}']);

    ok({ success: true });
    await client().publishIvr();
    expect([call(4)[0], call(4)[1].method]).toEqual(['http://gw:4000/api/ivr/publish', 'POST']);

    ok({ success: true });
    await client().setIvrEnabled(true);
    expect([call(5)[0], call(5)[1].method, call(5)[1].body]).toEqual(['http://gw:4000/api/ivr/enabled', 'PUT', '{"enabled":true}']);
  });

  it('uploads the WAV itself as the body with an audio content type and the name in the query', async () => {
    ok({ success: true });
    const file = new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' });
    await client().uploadIvrAsset(file, 'Welcome & hello');
    const [url, init] = call();
    expect(url).toBe('http://gw:4000/api/ivr/assets?name=Welcome%20%26%20hello');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('audio/wav');
    expect(init.headers['x-api-key']).toBe('key-123456');
    expect(init.body).toBe(file); // not JSON-encoded
  });

  it('deletes by id and downloads the stored audio with the key', async () => {
    ok({ success: true });
    await client().deleteIvrAsset(A(1));
    expect([call()[0], call()[1].method]).toEqual([`http://gw:4000/api/ivr/assets/${A(1)}`, 'DELETE']);

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) });
    const blob = await client().downloadIvrAsset(A(2));
    expect(blob).toBeInstanceOf(Blob);
    expect(call(1)[0]).toBe(`http://gw:4000/api/ivr/assets/${A(2)}/audio`);
    expect(call(1)[1].headers).toEqual({ 'x-api-key': 'key-123456' });

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(client().downloadIvrAsset(A(3))).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('Could not load the audio file') });
  });

  it('a refused publish carries its code and the list of problems for the page to show', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 422,
      statusText: 'Unprocessable',
      json: async () => ({ success: false, error: 'The configuration cannot be published: 1 problem to fix.', code: 'IVR_INVALID_CONFIG', details: [{ path: 'menu.assetId', message: 'add the menu announcement' }] }),
    });
    const error = await client().publishIvr().catch((e) => e as GatewayApiError);
    expect(error).toBeInstanceOf(GatewayApiError);
    expect(error).toMatchObject({ statusCode: 422, code: 'IVR_INVALID_CONFIG', details: [{ path: 'menu.assetId', message: 'add the menu announcement' }] });
  });
});
