import { IvrConfig, ivrConfigSchema, zodIssues } from './config.js';
import { IvrIssue } from './errors.js';

export interface IvrValidation {
  /** True when there are no errors. Warnings never block publishing. */
  ok: boolean;
  errors: IvrIssue[];
  warnings: IvrIssue[];
}

/** What validation needs to know about the audio assets: only whether one exists. */
export interface AssetLookup {
  has(id: string): boolean;
}

/**
 * Is this configuration complete enough to publish? Checks the shape first (a document that does not match the model has no further
 * problems worth listing), then the things a shape cannot say: repeated keys, assets that do not exist, a menu with nothing to say.
 * Whether the AI is READY is deliberately not checked here: that is a runtime fact, and the runtime falls back safely when it is not.
 */
export function validateIvrConfig(input: unknown, assets: AssetLookup): IvrValidation {
  const parsed = ivrConfigSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error), warnings: [] };
  const config: IvrConfig = parsed.data;
  const errors: IvrIssue[] = [];
  const warnings: IvrIssue[] = [];

  // A reference must point at an asset that exists. (null means "nothing here", which each rule below handles itself.)
  const checkAsset = (id: string | null, path: string) => {
    if (id !== null && !assets.has(id)) errors.push({ path, message: 'this audio file is no longer available; upload it again or choose another' });
  };
  checkAsset(config.welcome.assetId, 'welcome.assetId');
  checkAsset(config.menu.assetId, 'menu.assetId');
  checkAsset(config.invalid.assetId, 'invalid.assetId');
  checkAsset(config.timeout.assetId, 'timeout.assetId');

  // Keys: unique.
  const seen = new Map<string, number>();
  config.options.forEach((option, i) => {
    const first = seen.get(option.key);
    if (first !== undefined) {
      errors.push({ path: `options[${i}].key`, message: `key "${option.key}" is already used by option ${first + 1}; each key can run only one action` });
    } else {
      seen.set(option.key, i);
    }
  });

  // Actions: what each one needs.
  config.options.forEach((option, i) => {
    const action = option.action;
    if (action.type === 'play-announcement') {
      if (action.assetId === null) errors.push({ path: `options[${i}].action.assetId`, message: 'choose the announcement this option plays' });
      else checkAsset(action.assetId, `options[${i}].action.assetId`);
    } else if (action.type === 'hang-up') {
      checkAsset(action.goodbyeAssetId, `options[${i}].action.goodbyeAssetId`);
    }
  });
  if (config.finalAction.type === 'hang-up') checkAsset(config.finalAction.goodbyeAssetId, 'finalAction.goodbyeAssetId');

  // The caller must hear something, and a menu must say which keys to press.
  if (config.welcome.assetId === null && config.menu.assetId === null) {
    errors.push({ path: 'welcome.assetId', message: 'add a welcome or a menu announcement: with neither, the caller would hear nothing' });
  }
  if (config.options.length > 0 && config.menu.assetId === null) {
    errors.push({ path: 'menu.assetId', message: 'add the menu announcement that tells callers which keys to press' });
  }

  if (config.options.length === 0) {
    const then = config.finalAction.type === 'connect-ai' ? 'connect the caller to the AI' : 'end the call';
    warnings.push({ path: 'options', message: `no options: the caller hears the announcements and the gateway then will ${then} without waiting for a key` });
  } else {
    if (config.invalid.assetId === null) warnings.push({ path: 'invalid.assetId', message: 'no invalid-key announcement: after a wrong key the menu simply plays again' });
    if (config.timeout.assetId === null) warnings.push({ path: 'timeout.assetId', message: 'no timeout announcement: when no key is pressed the menu simply plays again' });
  }

  return { ok: errors.length === 0, errors, warnings };
}
