/**
 * IVR builder logic: the types the gateway's /api/ivr speaks (kept here, not in the shared package, because the shared package is a
 * built dependency), the helpers the editor uses, and the "can the IVR run on the next call?" evaluation. Pure, so it is unit tested.
 */

export const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'] as const;
export type DtmfKey = (typeof DTMF_KEYS)[number];
export type ActionType = 'connect-ai' | 'play-announcement' | 'repeat-menu' | 'hang-up';

export type IvrAction =
  | { type: 'connect-ai' }
  | { type: 'play-announcement'; assetId: string | null; then: 'return-to-menu' | 'hang-up' }
  | { type: 'repeat-menu' }
  | { type: 'hang-up'; goodbyeAssetId: string | null };
export type IvrFinalAction = { type: 'connect-ai' } | { type: 'hang-up'; goodbyeAssetId: string | null };
export interface IvrOption {
  key: DtmfKey;
  label: string;
  action: IvrAction;
}
export interface IvrConfig {
  schemaVersion: 1;
  direction: 'outbound';
  welcome: { assetId: string | null };
  menu: { assetId: string | null };
  invalid: { assetId: string | null };
  timeout: { assetId: string | null };
  options: IvrOption[];
  inputTimeoutMs: number;
  maxRetries: number;
  finalAction: IvrFinalAction;
  allowBargeIn: boolean;
}

export interface IvrIssue {
  path: string;
  message: string;
}
export interface IvrValidation {
  ok: boolean;
  errors: IvrIssue[];
  warnings: IvrIssue[];
}
export interface IvrAssetMeta {
  id: string;
  name: string;
  bytes: number;
  durationMs: number;
  sampleRate: number;
  channels: 1;
  bitsPerSample: 16;
  createdAt: string;
}
export interface IvrStatus {
  enabled: boolean;
  publishedVersion: number;
  publishedAt: string | null;
  hasSavedDraft: boolean;
  unpublishedChanges: boolean;
  problems: string[];
}
export interface IvrRuntime {
  /** A controller is registered, so an owned call is actually run by the IVR. False: switching the IVR on does nothing yet. */
  controllerRegistered: boolean;
  activeCalls: string[];
  /** The AI is in a mode where it can answer a caller, so a failed IVR can hand over to it. */
  aiCanAnswer: boolean;
}
export interface IvrAudioRules {
  sampleRate: number;
  persistent: boolean;
  maxBytes: number;
  minDurationMs: number;
  maxDurationMs: number;
}
export interface IvrPublished {
  version: number;
  publishedAt: string;
  config: IvrConfig;
}
export interface IvrLimits {
  maxOptions: number;
  labelMaxChars: number;
  inputTimeoutMs: { min: number; max: number; default: number };
  maxRetries: { min: number; max: number; default: number };
  keys: string[];
  actions: string[];
  finalActions: string[];
}
export interface IvrOverview {
  success: boolean;
  status: IvrStatus;
  draft: IvrConfig;
  published: IvrPublished | null;
  validation: IvrValidation;
  assets: IvrAssetMeta[];
  audio: IvrAudioRules;
  limits: IvrLimits;
  runtime: IvrRuntime | null;
}

export const ACTION_LABELS: Record<ActionType, string> = {
  'connect-ai': 'Connect to the AI assistant',
  'play-announcement': 'Play an announcement',
  'repeat-menu': 'Repeat the menu',
  'hang-up': 'Hang up',
};

export const LIMITS = {
  maxOptions: 12,
  labelMaxChars: 60,
  timeoutSeconds: { min: 2, max: 30 },
  retries: { min: 0, max: 5 },
} as const;

export function emptyConfig(): IvrConfig {
  return {
    schemaVersion: 1,
    direction: 'outbound',
    welcome: { assetId: null },
    menu: { assetId: null },
    invalid: { assetId: null },
    timeout: { assetId: null },
    options: [],
    inputTimeoutMs: 6000,
    maxRetries: 2,
    finalAction: { type: 'connect-ai' },
    allowBargeIn: true,
  };
}

export const isDirty = (a: IvrConfig | null, b: IvrConfig | null): boolean => JSON.stringify(a) !== JSON.stringify(b);

/** The first key not yet used by an option, in the order callers expect (1-9, then 0, *, #). */
export function nextFreeKey(config: IvrConfig): DtmfKey | null {
  const used = new Set(config.options.map((o) => o.key));
  return DTMF_KEYS.find((k) => !used.has(k)) ?? null;
}

export function addOption(config: IvrConfig): IvrConfig {
  const key = nextFreeKey(config);
  if (!key || config.options.length >= LIMITS.maxOptions) return config;
  return { ...config, options: [...config.options, { key, label: `Option ${config.options.length + 1}`, action: { type: 'connect-ai' } }] };
}

export const removeOption = (config: IvrConfig, index: number): IvrConfig => ({ ...config, options: config.options.filter((_, i) => i !== index) });

export function updateOption(config: IvrConfig, index: number, patch: Partial<IvrOption>): IvrConfig {
  return { ...config, options: config.options.map((o, i) => (i === index ? { ...o, ...patch } : o)) };
}

/** Switch an option to another action, keeping what carries over (a chosen announcement stays chosen) and giving the rest sensible defaults. */
export function actionOfType(type: ActionType, previous?: IvrAction): IvrAction {
  switch (type) {
    case 'connect-ai':
      return { type };
    case 'repeat-menu':
      return { type };
    case 'play-announcement':
      return { type, assetId: previous?.type === 'play-announcement' ? previous.assetId : previous?.type === 'hang-up' ? previous.goodbyeAssetId : null, then: previous?.type === 'play-announcement' ? previous.then : 'return-to-menu' };
    case 'hang-up':
      return { type, goodbyeAssetId: previous?.type === 'hang-up' ? previous.goodbyeAssetId : previous?.type === 'play-announcement' ? previous.assetId : null };
  }
}

export function finalActionOfType(type: 'connect-ai' | 'hang-up', previous: IvrFinalAction): IvrFinalAction {
  return type === 'connect-ai' ? { type } : { type, goodbyeAssetId: previous.type === 'hang-up' ? previous.goodbyeAssetId : null };
}

export function assetName(assets: IvrAssetMeta[], id: string | null): string {
  if (id === null) return 'none';
  return assets.find((a) => a.id === id)?.name ?? 'missing audio file';
}

export function describeAction(action: IvrAction, assets: IvrAssetMeta[]): string {
  switch (action.type) {
    case 'connect-ai':
      return 'Connect to the AI assistant';
    case 'repeat-menu':
      return 'Repeat the menu';
    case 'play-announcement':
      return `Play "${assetName(assets, action.assetId)}", then ${action.then === 'hang-up' ? 'hang up' : 'return to the menu'}`;
    case 'hang-up':
      return action.goodbyeAssetId ? `Play "${assetName(assets, action.goodbyeAssetId)}", then hang up` : 'Hang up';
  }
}

export function formatDuration(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Every audio file a configuration refers to. */
export function referencedAssets(config: IvrConfig): string[] {
  const ids: Array<string | null> = [config.welcome.assetId, config.menu.assetId, config.invalid.assetId, config.timeout.assetId];
  for (const o of config.options) {
    if (o.action.type === 'play-announcement') ids.push(o.action.assetId);
    if (o.action.type === 'hang-up') ids.push(o.action.goodbyeAssetId);
  }
  if (config.finalAction.type === 'hang-up') ids.push(config.finalAction.goodbyeAssetId);
  return Array.from(new Set(ids.filter((id): id is string => id !== null)));
}

/** Problems that would make the gateway refuse to SAVE the draft (shape and ranges), so the Save button can say why it is off. */
export function saveProblems(config: IvrConfig): string[] {
  const out: string[] = [];
  config.options.forEach((o, i) => {
    if (!o.label.trim()) out.push(`Option ${i + 1}: give it a label (it is only shown here, never spoken).`);
    if (o.label.length > LIMITS.labelMaxChars) out.push(`Option ${i + 1}: the label is longer than ${LIMITS.labelMaxChars} characters.`);
  });
  const seconds = config.inputTimeoutMs / 1000;
  if (!Number.isFinite(seconds) || seconds < LIMITS.timeoutSeconds.min || seconds > LIMITS.timeoutSeconds.max) {
    out.push(`The wait for a key must be between ${LIMITS.timeoutSeconds.min} and ${LIMITS.timeoutSeconds.max} seconds.`);
  }
  if (!Number.isInteger(config.maxRetries) || config.maxRetries < LIMITS.retries.min || config.maxRetries > LIMITS.retries.max) {
    out.push(`Retries must be a whole number from ${LIMITS.retries.min} to ${LIMITS.retries.max}.`);
  }
  return out;
}

/** What publishing would object to, worked out locally so the editor can say so while the operator types. The gateway's own check is final. */
export function localIssues(config: IvrConfig, assets: IvrAssetMeta[]): IvrValidation {
  const have = new Set(assets.map((a) => a.id));
  const errors: IvrIssue[] = [];
  const warnings: IvrIssue[] = [];
  const check = (id: string | null, path: string) => {
    if (id !== null && !have.has(id)) errors.push({ path, message: 'this audio file is no longer in the library; choose another' });
  };
  check(config.welcome.assetId, 'welcome.assetId');
  check(config.menu.assetId, 'menu.assetId');
  check(config.invalid.assetId, 'invalid.assetId');
  check(config.timeout.assetId, 'timeout.assetId');
  const seen = new Map<string, number>();
  config.options.forEach((o, i) => {
    const first = seen.get(o.key);
    if (first !== undefined) errors.push({ path: `options[${i}].key`, message: `key "${o.key}" is already used by option ${first + 1}; each key can run only one action` });
    else seen.set(o.key, i);
    if (o.action.type === 'play-announcement') {
      if (o.action.assetId === null) errors.push({ path: `options[${i}].action.assetId`, message: 'choose the announcement this option plays' });
      else check(o.action.assetId, `options[${i}].action.assetId`);
    }
    if (o.action.type === 'hang-up') check(o.action.goodbyeAssetId, `options[${i}].action.goodbyeAssetId`);
  });
  if (config.finalAction.type === 'hang-up') check(config.finalAction.goodbyeAssetId, 'finalAction.goodbyeAssetId');
  if (config.welcome.assetId === null && config.menu.assetId === null) errors.push({ path: 'welcome.assetId', message: 'add a welcome or a menu announcement: with neither, the caller would hear nothing' });
  if (config.options.length > 0 && config.menu.assetId === null) errors.push({ path: 'menu.assetId', message: 'add the menu announcement that tells callers which keys to press' });
  if (config.options.length === 0) {
    warnings.push({ path: 'options', message: `no options: the caller hears the announcements and the gateway then will ${config.finalAction.type === 'connect-ai' ? 'connect the caller to the AI' : 'end the call'} without waiting for a key` });
  } else {
    if (config.invalid.assetId === null) warnings.push({ path: 'invalid.assetId', message: 'no invalid-key announcement: after a wrong key the menu simply plays again' });
    if (config.timeout.assetId === null) warnings.push({ path: 'timeout.assetId', message: 'no timeout announcement: when no key is pressed the menu simply plays again' });
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Where an issue's path points, in the words used on the page. */
export function issueWhere(path: string): string {
  const option = /^options\[(\d+)\]/.exec(path);
  if (option) return `Option ${Number(option[1]) + 1}`;
  if (path.startsWith('welcome')) return 'Welcome';
  if (path.startsWith('menu')) return 'Menu prompt';
  if (path.startsWith('invalid')) return 'Invalid input';
  if (path.startsWith('timeout')) return 'No input';
  if (path.startsWith('finalAction')) return 'Final action';
  if (path === 'options') return 'Options';
  return path;
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export function statusSummary(status: IvrStatus, runtime: IvrRuntime | null): { label: string; tone: Tone; detail: string } {
  if (!status.enabled) {
    return { label: 'IVR off', tone: 'neutral', detail: 'Calls go straight to the normal AI handling. Nothing in this page affects a call until the IVR is turned on.' };
  }
  if (runtime && !runtime.controllerRegistered) {
    return { label: 'IVR on, not running', tone: 'bad', detail: 'The IVR is switched on, but this gateway has no IVR controller registered, so calls are NOT handled by it. Restart the gateway after the controller wiring is applied.' };
  }
  return { label: `IVR on · version ${status.publishedVersion}`, tone: 'good', detail: 'New outgoing calls play the published menu as soon as the person answers. Incoming calls are not affected: they still go to the AI.' };
}

export interface ReadinessItem {
  label: string;
  tone: Tone;
  detail: string;
}

export interface ReadinessInput {
  health: { driverType: string; modem: { connectionState: string; atPort: string; audioPort: string } } | null;
  ai: { readiness: { mode: string; checks: Array<{ name: string; status: string; detail: string }> } } | null;
  runtime: IvrRuntime | null;
  status: IvrStatus;
}

/**
 * Can the IVR run on the NEXT real call? Every item is something that can be known now. What cannot be known without a call (audio flowing,
 * and above all whether a key you press arrives as the key you pressed) is listed as "checked on the test call", never as passed.
 */
export function readiness(input: ReadinessInput): { items: ReadinessItem[]; blockers: string[]; canRun: boolean } {
  const items: ReadinessItem[] = [];
  const blockers: string[] = [];
  const block = (label: string, detail: string) => {
    items.push({ label, tone: 'bad', detail });
    blockers.push(`${label}: ${detail}`);
  };

  const modem = input.health?.modem;
  if (!input.health) block('Gateway', 'the gateway did not answer, so nothing here can be confirmed');
  else if (input.health.driverType !== 'hardware') block('Modem', 'the gateway is running a simulated modem, not Modem A');
  else if (modem?.connectionState !== 'READY') block('Modem', `the modem is ${modem?.connectionState ?? 'unknown'}, not READY: it cannot answer a call`);
  else items.push({ label: 'Modem', tone: 'good', detail: `READY on ${modem.atPort} (audio ${modem.audioPort})` });

  if (!input.runtime) items.push({ label: 'IVR controller', tone: 'warn', detail: 'this gateway did not report whether the IVR controller is running' });
  else if (!input.runtime.controllerRegistered) block('IVR controller', 'not registered on this gateway: switching the IVR on will do nothing until it is');
  else items.push({ label: 'IVR controller', tone: 'good', detail: 'registered: calls the IVR owns are run by it' });

  const checks = input.ai?.readiness.checks ?? [];
  const outbound = checks.find((c) => c.name === 'outbound-audio');
  if (!input.ai) items.push({ label: 'Outbound audio', tone: 'warn', detail: 'the AI readiness could not be read' });
  else if (!outbound) items.push({ label: 'Outbound audio', tone: 'warn', detail: 'no outbound-audio check was reported' });
  else if (outbound.status !== 'pass') block('Outbound audio', `${outbound.detail}. The IVR will not play audio nobody has confirmed is audible; confirm it on the AI page first`);
  else items.push({ label: 'Outbound audio', tone: 'good', detail: 'the audio path is ready (the audio port accepts writes); whether the caller hears it is verified per call' });

  items.push({ label: 'USB audio and key presses', tone: 'warn', detail: 'only checkable during a real call: the first test call confirms that audio flows and that each key reaches the option you expect' });

  if (!input.status.publishedVersion) block('Published menu', 'nothing is published yet');
  else items.push({ label: 'Published menu', tone: 'good', detail: `version ${input.status.publishedVersion}` });

  if (input.runtime) {
    items.push(
      input.runtime.aiCanAnswer
        ? { label: 'If the IVR fails', tone: 'good', detail: 'the call goes to the AI assistant' }
        : { label: 'If the IVR fails', tone: 'warn', detail: 'the AI is not set to reply to callers (it is off or listening-only), so a failed IVR ends the call, and "Connect to the AI" options will also end the call' }
    );
  }
  return { items, blockers, canRun: blockers.length === 0 };
}
