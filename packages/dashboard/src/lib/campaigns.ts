/** Types and pure helpers for the Campaigns pages. The gateway validates and decides everything; this only shapes what is sent and shown. */

import type { CampaignConfig, ColumnDetection, CsvAnalysis } from './campaign-config';

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'stopped' | 'completed';
export type ContactStatus = 'queued' | 'calling' | 'completed' | 'failed' | 'skipped';

export interface CallingHours {
  start: string;
  end: string;
  /** 0 = Sunday ... 6 = Saturday. */
  days: number[];
  timeZone: string;
}

export interface CampaignSettings {
  interCallDelaySeconds: number;
  maxAttempts: number;
  retryDelayMinutes: number;
  retryOn: Array<'no_answer' | 'busy' | 'failed'>;
  callTimeoutSeconds: number;
  agentAttachTimeoutSeconds: number;
  callingHours: CallingHours;
  consentMode: 'column' | 'attested';
  defaultCountryCode: string | null;
  skipRecentlyCalledHours: number;
  maxConsecutiveFailures: number;
  greetingTemplate: string | null;
  contextNote: string;
}

export interface Counts {
  total: number;
  queued: number;
  calling: number;
  completed: number;
  failed: number;
  skipped: number;
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  pauseReason: string | null;
  settings: CampaignSettings;
  mapping: ColumnMapping | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  /** What the operator confirmed at the start (null while a draft). */
  acknowledgements: { realCalls: true; regulations: true; consent: true; consentMode: 'column' | 'attested'; willCall: number; at: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The campaign's own AI configuration in force (prompt and model); version 0 means none has been saved. */
  config: CampaignConfig;
  /** Which contact list is live: each replacement after the campaign started adds one, keeping the earlier list as history. */
  listVersion: number;
}

export interface ColumnMapping {
  phone: string;
  name?: string;
  designation?: string;
  company?: string;
  context?: string;
  consent?: string;
  optOut?: string;
  extra?: string[];
}

export interface RunnerStatus {
  campaignId: string | null;
  waiting: string | null;
  inFlight: { contactId: number; callId: string | null } | null;
  consecutiveFailures: number;
}

export interface Contact {
  id: number;
  campaignId: string;
  rowNumber: number;
  name: string;
  phoneRaw: string;
  phoneE164: string | null;
  designation: string;
  company: string;
  context: string;
  extra: Record<string, string>;
  consent: 'yes' | 'no' | 'unknown';
  optOut: boolean;
  status: ContactStatus;
  skipReason: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  callId: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  /** True for a contact of an earlier list, kept as history. */
  archived?: boolean;
  listVersion?: number;
}

export interface Attempt {
  attempt: number;
  callId: string | null;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  error: string | null;
}

export interface CsvPreview {
  delimiter: string;
  headers: string[];
  totalRows: number;
  sample: string[][];
  warnings: string[];
  suggestedMapping: Partial<ColumnMapping>;
  /** Which columns look like the name and the phone number, and whether the person must choose. */
  detection?: { name: ColumnDetection; phone: ColumnDetection };
  ambiguous?: boolean;
  /** Present when a mapping was sent and it is not usable. */
  mappingErrors?: string[];
  /** Present when a usable mapping was sent: what an import would do, with nothing stored. */
  analysis?: CsvAnalysis;
}

export interface ImportSummary {
  total: number;
  callable: number;
  invalidNumber: number;
  duplicate: number;
  missingName: number;
  optedOut: number;
  doNotCall: number;
  consentDeclined: number;
  consentUnknown: number;
}

export interface ImportResult {
  counts: Counts;
  summary: ImportSummary;
  problems: Array<{ rowNumber: number; reason: string }>;
  warnings: string[];
  /** The columns kept as each contact's custom fields. */
  customColumns?: string[];
  /** True when the campaign had already started: the earlier list is kept as history, this one is the live list. */
  replacedEarlierList?: boolean;
  listVersion?: number;
  status?: CampaignStatus;
}

export interface Review {
  campaign: Campaign;
  counts: Counts;
  willCall: number;
  willSkipAtStart: number;
  skipReasons: Record<string, number>;
  blockers: string[];
  insideCallingHoursNow: boolean;
  anotherRunning: { id: string; name: string } | null;
}

export const MAX_CSV_BYTES = 900_000;

/** The gateway refuses a request body above 1 MB once it is JSON-encoded (quotes and line breaks grow when encoded). */
export const MAX_REQUEST_BYTES = 1_000_000;

/** The size of the request that would carry this CSV, as the gateway will measure it. */
export function encodedRequestBytes(csv: string): number {
  return new TextEncoder().encode(JSON.stringify({ csv })).length + 2_000; // room for the column mapping
}

/** A clear message when the file cannot be sent, or null. Checked before sending, so the operator is told why. */
export function csvRequestProblem(csv: string): string | null {
  if (csv.length > MAX_CSV_BYTES) return `The file has ${csv.length.toLocaleString()} characters; the limit is ${MAX_CSV_BYTES.toLocaleString()} (about 5,000 contacts). Split it into smaller files.`;
  const bytes = encodedRequestBytes(csv);
  if (bytes > MAX_REQUEST_BYTES) {
    return `Once encoded for sending, this file is about ${Math.round(bytes / 1000)} KB; the limit is ${Math.round(MAX_REQUEST_BYTES / 1000)} KB (many line breaks or quotes make it larger than it looks). Remove blank lines, or split it into smaller files.`;
  }
  return null;
}

/**
 * Column names that may not be given to the agent as extra facts: the labels the gateway writes itself and words that read as
 * instructions. The gateway enforces this too; this list is checked against the gateway's own by a test.
 */
export const RESERVED_FIELD_KEYS: readonly string[] = [
  'contact_name', 'designation', 'company', 'campaign_purpose', 'contact_notes', 'call_context', 'campaign_rule',
  'system', 'system_prompt', 'system_message', 'prompt', 'instruction', 'instructions', 'rules', 'rule', 'role',
  'assistant', 'user', 'developer', 'ignore', 'override', 'policy',
];

export function isReservedColumn(name: string): boolean {
  const k = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return k === '' || RESERVED_FIELD_KEYS.includes(k) || /^(ignore|disregard|forget)_/.test(k) || /(^|_)(instruction|instructions|system_prompt)(_|$)/.test(k);
}

const OUTCOME_LABELS: Record<string, string> = {
  answered: 'answered',
  no_answer: 'no answer (rang, nobody picked up)',
  busy: 'busy (a declined call can be reported as busy)',
  ended_before_answer: 'ended before it was answered (could be a decline: not retried)',
  failed: 'call failed',
  agent_missing: 'answered, but the AI agent never joined (the person heard silence)',
  no_end_report: 'never reported that it ended',
  unknown: 'unknown (the gateway restarted during the call)',
};
export const outcomeLabel = (outcome: string | null): string => (outcome ? (OUTCOME_LABELS[outcome] ?? outcome) : '');

export const CONTACT_FIELDS: Array<{ key: Exclude<keyof ColumnMapping, 'extra'>; label: string; required?: boolean; hint?: string }> = [
  { key: 'phone', label: 'Phone number', required: true, hint: 'International format (+919876543210), or set a default country code in Settings.' },
  { key: 'name', label: 'Contact name', required: true, hint: 'A row without a usable name is set aside, not called.' },
  { key: 'designation', label: 'Designation' },
  { key: 'company', label: 'Company' },
  { key: 'context', label: 'Custom context', hint: 'Anything the agent should know about this person.' },
  { key: 'consent', label: 'Consent', hint: 'yes / no. Without it a contact is only called if you attest consent for the whole list.' },
  { key: 'optOut', label: 'Opt-out / do not call', hint: 'Any value other than blank or no skips the contact.' },
];

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function statusTone(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
  if (status === 'completed') return 'good';
  if (status === 'failed' || status === 'stopped') return 'bad';
  if (status === 'running' || status === 'calling' || status === 'paused') return 'warn';
  return 'neutral';
}

/** Share of contacts that have reached a final state (completed, failed or skipped), as a whole percentage. */
export function progressPercent(c: Counts): number {
  if (c.total === 0) return 0;
  return Math.round(((c.completed + c.failed + c.skipped) / c.total) * 100);
}

/** Mapping with unset fields left out, and the extra columns kept only if they are real columns. */
export function cleanMapping(m: Partial<ColumnMapping>, headers: string[]): ColumnMapping | null {
  if (!m.phone || !headers.includes(m.phone)) return null;
  if (!m.name || !headers.includes(m.name)) return null;
  const out: ColumnMapping = { phone: m.phone };
  for (const f of CONTACT_FIELDS) {
    if (f.key === 'phone') continue;
    const value = m[f.key];
    if (value && headers.includes(value)) out[f.key] = value;
  }
  const extra = (m.extra ?? []).filter((c) => headers.includes(c));
  if (extra.length > 0) out.extra = extra;
  return out;
}

/** Problems with a mapping that the operator can fix before importing (the gateway checks again). */
export function mappingProblems(m: Partial<ColumnMapping>, headers: string[]): string[] {
  const problems: string[] = [];
  if (!m.phone) problems.push('Choose the column that holds the phone number.');
  if (!m.name) problems.push('Choose the column that holds the contact name.');
  const used: string[] = [];
  for (const f of CONTACT_FIELDS) {
    const value = m[f.key];
    if (value) used.push(value);
  }
  // Every other column is kept as a custom field automatically; a column named like an instruction is kept too, but not given to the agent.
  for (const c of m.extra ?? []) used.push(c);
  if (new Set(used).size !== used.length) problems.push('Each column can only be used for one field.');
  for (const c of used) if (!headers.includes(c)) problems.push(`The column "${c}" is not in the file.`);
  return problems;
}

/** The editable form for a campaign's settings, as text fields, and the patch that sends only what changed. */
export interface SettingsForm {
  interCallDelaySeconds: string;
  maxAttempts: string;
  retryDelayMinutes: string;
  retryOn: Array<'no_answer' | 'busy' | 'failed'>;
  callTimeoutSeconds: string;
  agentAttachTimeoutSeconds: string;
  start: string;
  end: string;
  days: number[];
  timeZone: string;
  consentMode: 'column' | 'attested';
  defaultCountryCode: string;
  skipRecentlyCalledHours: string;
  maxConsecutiveFailures: string;
  greetingTemplate: string;
  contextNote: string;
}

export function formFromSettings(s: CampaignSettings): SettingsForm {
  return {
    interCallDelaySeconds: String(s.interCallDelaySeconds),
    maxAttempts: String(s.maxAttempts),
    retryDelayMinutes: String(s.retryDelayMinutes),
    retryOn: [...s.retryOn],
    callTimeoutSeconds: String(s.callTimeoutSeconds),
    agentAttachTimeoutSeconds: String(s.agentAttachTimeoutSeconds),
    start: s.callingHours.start,
    end: s.callingHours.end,
    days: [...s.callingHours.days],
    timeZone: s.callingHours.timeZone,
    consentMode: s.consentMode,
    defaultCountryCode: s.defaultCountryCode ?? '',
    skipRecentlyCalledHours: String(s.skipRecentlyCalledHours),
    maxConsecutiveFailures: String(s.maxConsecutiveFailures),
    greetingTemplate: s.greetingTemplate ?? '',
    contextNote: s.contextNote,
  };
}

const whole = (v: string): number => (v.trim() === '' ? NaN : Number(v));

/** Validation the operator sees immediately; the gateway enforces the same limits. */
export function settingsProblems(f: SettingsForm): string[] {
  const out: string[] = [];
  const range = (label: string, v: string, min: number, max: number) => {
    const n = whole(v);
    if (!Number.isInteger(n) || n < min || n > max) out.push(`${label} must be a whole number from ${min} to ${max}.`);
  };
  range('Delay between calls (seconds)', f.interCallDelaySeconds, 10, 3600);
  range('Maximum attempts', f.maxAttempts, 1, 5);
  range('Retry delay (minutes)', f.retryDelayMinutes, 1, 1440);
  range('Ring timeout (seconds)', f.callTimeoutSeconds, 15, 120);
  range('Wait for the AI agent after an answer (seconds)', f.agentAttachTimeoutSeconds, 5, 120);
  range('Skip numbers called within (hours)', f.skipRecentlyCalledHours, 0, 720);
  range('Pause after failed calls in a row', f.maxConsecutiveFailures, 1, 10);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.end)) out.push('Calling hours must be written HH:MM.');
  else if (f.start >= f.end) out.push('Calling hours must end after they start.');
  if (f.days.length === 0) out.push('Choose at least one calling day.');
  if (f.defaultCountryCode.trim() !== '' && !/^\d{1,3}$/.test(f.defaultCountryCode.trim())) out.push('The default country code is digits only, for example 91.');
  if (f.greetingTemplate.length > 300) out.push('The greeting is limited to 300 characters.');
  if (f.contextNote.length > 600) out.push('The campaign context is limited to 600 characters.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: f.timeZone });
  } catch {
    out.push('The time zone is not a valid IANA name (for example Asia/Kolkata).');
  }
  return out;
}

export function settingsPatch(f: SettingsForm): Record<string, unknown> {
  return {
    interCallDelaySeconds: whole(f.interCallDelaySeconds),
    maxAttempts: whole(f.maxAttempts),
    retryDelayMinutes: whole(f.retryDelayMinutes),
    retryOn: f.retryOn,
    callTimeoutSeconds: whole(f.callTimeoutSeconds),
    agentAttachTimeoutSeconds: whole(f.agentAttachTimeoutSeconds),
    callingHours: { start: f.start, end: f.end, days: [...f.days].sort((a, b) => a - b), timeZone: f.timeZone },
    consentMode: f.consentMode,
    defaultCountryCode: f.defaultCountryCode.trim() === '' ? null : f.defaultCountryCode.trim(),
    skipRecentlyCalledHours: whole(f.skipRecentlyCalledHours),
    maxConsecutiveFailures: whole(f.maxConsecutiveFailures),
    greetingTemplate: f.greetingTemplate.trim() === '' ? null : f.greetingTemplate.trim(),
    contextNote: f.contextNote.trim(),
  };
}

export interface StartGateInput {
  campaignName: string;
  typedName: string;
  acknowledgements: { realCalls: boolean; regulations: boolean; consent: boolean };
  review: Pick<Review, 'willCall' | 'blockers' | 'anotherRunning'>;
}

/** Why the Start button is still disabled; empty means every explicit confirmation is in place. The gateway enforces it again. */
export function startBlockers(i: StartGateInput): string[] {
  const out: string[] = [];
  if (i.review.willCall <= 0) out.push('There are no callable contacts.');
  for (const b of i.review.blockers) out.push(b);
  if (i.review.anotherRunning) out.push(`Another campaign (“${i.review.anotherRunning.name}”) is running.`);
  if (!i.acknowledgements.realCalls) out.push('Confirm that this places real phone calls.');
  if (!i.acknowledgements.regulations) out.push('Confirm that you will follow the calling rules that apply to these contacts.');
  if (!i.acknowledgements.consent) out.push('Confirm that you have the right to contact these people.');
  if (i.typedName.trim() !== i.campaignName) out.push('Type the campaign name exactly.');
  return out;
}

export function nextRetryText(c: Contact): string | null {
  return c.status === 'queued' && c.nextAttemptAt ? `retry after ${c.nextAttemptAt.replace('T', ' ').slice(0, 16)} UTC` : null;
}
