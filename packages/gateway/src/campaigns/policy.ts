import { z } from 'zod';

/**
 * Campaign rules: pacing, retries, calling hours and consent. These are the operator's settings, not legal advice: calling
 * rules differ by country, state and the recipient's registration status, and the operator is responsible for following them.
 * The engine applies these before every call, not only when a campaign starts.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'not a valid IANA time zone (for example Asia/Kolkata)');

export const callingHoursSchema = z
  .object({
    start: z.string().regex(HHMM, 'start must be HH:MM'),
    end: z.string().regex(HHMM, 'end must be HH:MM'),
    /** 0 = Sunday ... 6 = Saturday. */
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    timeZone,
  })
  .refine((h) => h.start < h.end, { message: 'calling hours must end after they start (overnight windows are not supported)' });

export const campaignSettingsSchema = z.object({
  interCallDelaySeconds: z.number().int().min(10).max(3600).default(30),
  maxAttempts: z.number().int().min(1).max(5).default(2),
  retryDelayMinutes: z.number().int().min(1).max(1440).default(60),
  /**
   * Outcomes that may be retried. An answered call is never retried, and neither is one that ended before it was answered
   * for any other reason (that is what a decline looks like, and the modem cannot tell). A busy line may be a decline too,
   * so it is off unless the operator turns it on.
   */
  retryOn: z.array(z.enum(['no_answer', 'busy', 'failed'])).default(['no_answer', 'failed']),
  callTimeoutSeconds: z.number().int().min(15).max(120).default(45),
  /** An answered call must have the AI agent attached within this time, or the campaign pauses (the person is hearing silence). */
  agentAttachTimeoutSeconds: z.number().int().min(5).max(120).default(20),
  callingHours: callingHoursSchema.default(() => ({ start: '09:00', end: '20:00', days: [1, 2, 3, 4, 5, 6], timeZone: systemTimeZone() })),
  /** column: each contact needs a consent value of yes. attested: the operator confirms consent for the whole list at start. */
  consentMode: z.enum(['column', 'attested']).default('column'),
  defaultCountryCode: z.string().regex(/^\d{1,3}$/, 'digits only, e.g. 91').nullable().default(null),
  /** A number called in any campaign within this many hours is not called again (0 turns the check off). */
  skipRecentlyCalledHours: z.number().int().min(0).max(720).default(24),
  /** Pauses the campaign after this many failed calls in a row (a dead modem would otherwise burn through the list). */
  maxConsecutiveFailures: z.number().int().min(1).max(10).default(3),
  greetingTemplate: z.string().trim().max(300).nullable().default(null),
  /** Why the campaign is calling; given to the agent as context for every call. */
  contextNote: z.string().trim().max(600).default(''),
});
export type CampaignSettings = z.infer<typeof campaignSettingsSchema>;

export const campaignSettingsPatchSchema = z
  .object({
    interCallDelaySeconds: campaignSettingsSchema.shape.interCallDelaySeconds,
    maxAttempts: campaignSettingsSchema.shape.maxAttempts,
    retryDelayMinutes: campaignSettingsSchema.shape.retryDelayMinutes,
    retryOn: campaignSettingsSchema.shape.retryOn,
    callTimeoutSeconds: campaignSettingsSchema.shape.callTimeoutSeconds,
    agentAttachTimeoutSeconds: campaignSettingsSchema.shape.agentAttachTimeoutSeconds,
    callingHours: callingHoursSchema,
    consentMode: campaignSettingsSchema.shape.consentMode,
    defaultCountryCode: campaignSettingsSchema.shape.defaultCountryCode,
    skipRecentlyCalledHours: campaignSettingsSchema.shape.skipRecentlyCalledHours,
    maxConsecutiveFailures: campaignSettingsSchema.shape.maxConsecutiveFailures,
    greetingTemplate: campaignSettingsSchema.shape.greetingTemplate,
    contextNote: campaignSettingsSchema.shape.contextNote,
  })
  .partial()
  .strict();

export type Consent = 'yes' | 'no' | 'unknown';

const YES = /^(y|yes|true|1|t|opted[ _-]?in|granted|consent(ed)?|agreed?|ok)$/i;
const NO = /^(n|no|false|0|f|denied|declined|withdrawn|revoked|refused|opted[ _-]?out)$/i;

export function parseConsent(value: string | undefined): Consent {
  const v = (value ?? '').trim();
  if (v === '') return 'unknown';
  if (YES.test(v)) return 'yes';
  if (NO.test(v)) return 'no';
  return 'unknown'; // anything unrecognised is NOT consent
}

/** A column that says the person asked not to be called. Anything but an explicit no/blank counts as an opt-out. */
export function parseOptOut(value: string | undefined): boolean {
  const v = (value ?? '').trim();
  if (v === '') return false;
  return !/^(n|no|false|0|f|none|active)$/i.test(v);
}

export interface ContactFacts {
  phoneE164: string | null;
  consent: Consent;
  optOut: boolean;
}

/** Why a contact must not be called, or null when it may be. Evaluated at import, at start and again immediately before each dial. */
export function skipReason(contact: ContactFacts, settings: Pick<CampaignSettings, 'consentMode'>, onDoNotCallList: boolean): string | null {
  if (!contact.phoneE164) return 'invalid phone number';
  if (contact.optOut) return 'opted out (marked in the file)';
  if (onDoNotCallList) return 'on the do-not-call list';
  if (contact.consent === 'no') return 'consent declined or withdrawn';
  if (contact.consent === 'unknown' && settings.consentMode === 'column') return 'no consent recorded for this contact';
  return null;
}

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock day and time in the campaign's time zone. */
export function localParts(at: Date, tz: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: DAY_INDEX[get('weekday')] ?? 0, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function withinCallingHours(at: Date, hours: CampaignSettings['callingHours']): boolean {
  const { day, minutes } = localParts(at, hours.timeZone);
  if (!hours.days.includes(day)) return false;
  const [sh, sm] = hours.start.split(':').map(Number);
  const [eh, em] = hours.end.split(':').map(Number);
  return minutes >= sh * 60 + sm && minutes < eh * 60 + em;
}

/** Whether a finished call should be tried again, and the outcome name the rules use. */
export function shouldRetry(outcome: string | null, attempts: number, settings: Pick<CampaignSettings, 'maxAttempts' | 'retryOn'>): boolean {
  if (attempts >= settings.maxAttempts) return false;
  return outcome === 'no_answer' || outcome === 'busy' || outcome === 'failed' ? settings.retryOn.includes(outcome) : false;
}
