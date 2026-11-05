import { z } from 'zod';

/**
 * The IVR configuration model. First version: OUTBOUND calls only, ONE level of menu (a key runs an action; there are no submenus),
 * and four actions. Every object is strict, so a misspelt or unsupported field is refused instead of silently ignored.
 *
 * This file is only the SHAPE (types, ranges, allowed values). Whether a configuration is complete enough to publish (assets that
 * exist, a menu prompt when there are options, keys that are not repeated) is `validateIvrConfig`'s job, so a draft can be saved
 * half finished but never published that way.
 */

export const DTMF_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'] as const;
export const IVR_ACTION_TYPES = ['connect-ai', 'play-announcement', 'repeat-menu', 'hang-up'] as const;
/** The only actions allowed as the FINAL action (what happens when the retries run out, or when there is no menu). */
export const IVR_FINAL_ACTION_TYPES = ['connect-ai', 'hang-up'] as const;

export const IVR_LIMITS = {
  maxOptions: 12,
  labelMaxChars: 60,
  inputTimeoutMs: { min: 2_000, max: 30_000, default: 6_000 },
  maxRetries: { min: 0, max: 5, default: 2 },
} as const;

export type DtmfKey = (typeof DTMF_KEYS)[number];

/** An audio asset is named by the SHA-256 of its file (see assets.ts), so a reference can never point at different audio later. */
export const assetIdSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be an audio asset id (64 hex characters)');
/** A prompt slot: an asset, or null for "nothing to play here". */
const assetRef = assetIdSchema.nullable();

export const dtmfKeySchema = z.enum(DTMF_KEYS);

/** Connect the caller to the existing AI worker. */
const connectAiAction = z.object({ type: z.literal('connect-ai') }).strict();
/** Play an announcement, then go back to the menu, or end the call. */
const playAnnouncementAction = z
  .object({
    type: z.literal('play-announcement'),
    assetId: assetIdSchema.nullable(),
    then: z.enum(['return-to-menu', 'hang-up']),
  })
  .strict();
/** Play the menu prompt again. Counts as a fresh listening round; does not use up a retry. */
const repeatMenuAction = z.object({ type: z.literal('repeat-menu') }).strict();
/** End the call, optionally after a goodbye announcement. */
const hangUpAction = z.object({ type: z.literal('hang-up'), goodbyeAssetId: assetRef }).strict();

export const ivrActionSchema = z.discriminatedUnion('type', [connectAiAction, playAnnouncementAction, repeatMenuAction, hangUpAction]);
export const ivrFinalActionSchema = z.discriminatedUnion('type', [connectAiAction, hangUpAction]);

export const ivrOptionSchema = z
  .object({
    key: dtmfKeySchema,
    /** What the operator calls this option in the dashboard (never spoken, never sent anywhere). */
    label: z.string().trim().min(1, 'give the option a label').max(IVR_LIMITS.labelMaxChars),
    action: ivrActionSchema,
  })
  .strict();

export const ivrConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    /**
     * Outbound only in this version. A configuration saved when the IVR still ran on incoming calls says 'inbound'; it is read as
     * outbound (the direction was never a choice, and the rest of the menu is unchanged), and written back as 'outbound'.
     */
    direction: z.enum(['outbound', 'inbound']).transform((): 'outbound' => 'outbound'),
    /** Played first. Optional: a menu can start straight with its prompt. */
    welcome: z.object({ assetId: assetRef }).strict(),
    /** Tells the caller which keys to press. Required to publish whenever there are options. */
    menu: z.object({ assetId: assetRef }).strict(),
    /** Played after a key that is not one of the options. Optional: the menu simply repeats. */
    invalid: z.object({ assetId: assetRef }).strict(),
    /** Played when no key was pressed in time. Optional: the menu simply repeats. */
    timeout: z.object({ assetId: assetRef }).strict(),
    options: z.array(ivrOptionSchema).max(IVR_LIMITS.maxOptions),
    /** How long to wait for a key after the menu prompt has finished. */
    inputTimeoutMs: z.number().int().min(IVR_LIMITS.inputTimeoutMs.min).max(IVR_LIMITS.inputTimeoutMs.max),
    /** Wrong keys or silences tolerated before the final action. 0 means the first mistake goes to it. */
    maxRetries: z.number().int().min(IVR_LIMITS.maxRetries.min).max(IVR_LIMITS.maxRetries.max),
    /** What happens when the retries run out, and what happens after the announcements when there are no options at all. */
    finalAction: ivrFinalActionSchema,
    /** A key pressed while an announcement plays stops it and counts. */
    allowBargeIn: z.boolean(),
  })
  .strict();

export type IvrAction = z.infer<typeof ivrActionSchema>;
export type IvrFinalAction = z.infer<typeof ivrFinalActionSchema>;
export type IvrOption = z.infer<typeof ivrOptionSchema>;
export type IvrConfig = z.infer<typeof ivrConfigSchema>;

/** An empty configuration: nothing to play, no options. It is a valid draft and cannot be published until it says something. */
export function defaultIvrConfig(): IvrConfig {
  return {
    schemaVersion: 1,
    direction: 'outbound',
    welcome: { assetId: null },
    menu: { assetId: null },
    invalid: { assetId: null },
    timeout: { assetId: null },
    options: [],
    inputTimeoutMs: IVR_LIMITS.inputTimeoutMs.default,
    maxRetries: IVR_LIMITS.maxRetries.default,
    finalAction: { type: 'connect-ai' },
    allowBargeIn: true,
  };
}

/** The saved draft document. */
export const storedDraftSchema = z.object({ savedAt: z.string(), config: ivrConfigSchema }).strict();
/** The published document: the configuration plus the version it was published as. */
export const storedPublishedSchema = z.object({ version: z.number().int().min(1), publishedAt: z.string(), config: ivrConfigSchema }).strict();

export type StoredDraft = z.infer<typeof storedDraftSchema>;
export type PublishedIvr = z.infer<typeof storedPublishedSchema>;

/** Every asset id a configuration refers to, in the order they would be used. */
export function referencedAssetIds(config: IvrConfig): string[] {
  const ids: Array<string | null> = [config.welcome.assetId, config.menu.assetId, config.invalid.assetId, config.timeout.assetId];
  for (const option of config.options) {
    if (option.action.type === 'play-announcement') ids.push(option.action.assetId);
    if (option.action.type === 'hang-up') ids.push(option.action.goodbyeAssetId);
  }
  if (config.finalAction.type === 'hang-up') ids.push(config.finalAction.goodbyeAssetId);
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/** zod's issues as the {path, message} list the dashboard will show. */
export function zodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({
    path: i.path.reduce<string>((p, seg) => (typeof seg === 'number' ? `${p}[${seg}]` : p ? `${p}.${seg}` : String(seg)), '') || 'config',
    message: i.message,
  }));
}
