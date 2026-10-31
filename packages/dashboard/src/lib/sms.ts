/**
 * Browser side of the SMS page. It talks only to this dashboard's own /api/sms relay (same origin); the relay adds the gateway
 * API key on the server. Nothing in this file reads, stores or sends a gateway API key.
 */

import { decodeSmsText, DecodedSmsText, SmsTextEncoding } from './sms-text';

export const SMS_UI_HEADER = 'x-dashboard-sms';

// ------------------------------------------------------------------------------------------------ types (the gateway's JSON)

export interface StoredSms {
  id: number;
  direction: 'received' | 'sent';
  source: 'modem' | 'gateway';
  storage: string | null;
  index: number | null;
  address: string | null;
  text: string;
  /** Newer gateways: exactly what the modem reported, and whether `text` was decoded from UCS-2 hex. */
  rawText?: string;
  textEncoding?: SmsTextEncoding;
  time: string | null;
  modemStatus: string | null;
  read: boolean | null;
  sendStatus: 'sent' | 'unknown' | 'failed' | null;
  messageReference: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  onModem: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface InboxState {
  running: boolean;
  syncing: boolean;
  pending: boolean;
  waiting: 'call' | 'modem' | 'busy' | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  /** The last failed read, sanitized by the gateway; `command` and `hint` are missing on older gateways. */
  lastError: { code: string; message: string; at: string; command?: string | null; hint?: string | null } | null;
  /** How the modem's storage is listed (missing on older gateways). */
  listMode?: 'status-preserving' | 'standard' | null;
  consecutiveFailures: number;
  storage: { name: string; used: number; total: number } | null;
  storageFull: boolean;
  indications: { cnmi: number[] | null; notifies: boolean | null } | null;
  notificationsSeen: number;
  storageMismatch: { indicated: string; reading: string } | null;
  /** How the gateway checks the storage besides notifications (missing on older gateways). */
  polling?: { mode: 'interval' | 'fallback' | 'off'; intervalMs: number | null };
}

export interface InboxResponse {
  success: true;
  messages: StoredSms[];
  total: number;
  unread: number;
  inbox: InboxState | null;
}

export interface SyncResponse {
  success: true;
  listed: number;
  added: number;
  storage: { name: string; used: number; total: number } | null;
  storageFull: boolean;
  inbox: InboxState;
}

export interface SendResponse {
  success: true;
  to: string;
  messageReference: number | null;
  characters: number;
  settingsChanged: string[];
  warnings: string[];
  isSimulated: boolean;
}

export interface ModemMessageResponse {
  success: true;
  message: { index: number; status: string; direction: string; address: string | null; timestamp: string | null; text: string };
  markedRead: boolean;
}

export interface StatusResponse {
  success: true;
  settings: Record<string, unknown>;
  assessment: { canSend: boolean; problems: string[]; warnings: string[] };
}

export class SmsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SmsApiError';
  }
}

// ------------------------------------------------------------------------------------------------ client

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One request. Never retried: a repeated send could send twice. */
export async function smsRequest<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<T> {
  const fetchImpl: FetchLike = init.fetchImpl ?? ((input, options) => fetch(input, options));
  const controller = new AbortController();
  const timer = init.timeoutMs ? setTimeout(() => controller.abort(), init.timeoutMs) : null;
  let response: Response;
  try {
    response = await fetchImpl(`/api/sms${path}`, {
      method: init.method ?? 'GET',
      headers: { [SMS_UI_HEADER]: '1', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new SmsApiError(0, 'CLIENT_TIMEOUT', 'The dashboard stopped waiting for an answer');
    throw new SmsApiError(0, 'NETWORK_ERROR', 'The dashboard server could not be reached');
  } finally {
    if (timer) clearTimeout(timer);
  }
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new SmsApiError(response.status, 'BAD_RESPONSE', 'The dashboard server did not answer with JSON');
  }
  if (!response.ok || body?.success === false) {
    throw new SmsApiError(response.status, String(body?.code ?? 'ERROR'), String(body?.error ?? `Request failed (${response.status})`), body?.details);
  }
  return body as T;
}

export const smsApi = {
  inbox: (direction?: 'received' | 'sent', fetchImpl?: FetchLike) => smsRequest<InboxResponse>(`/inbox${direction ? `?direction=${direction}` : ''}`, { fetchImpl, timeoutMs: 15_000 }),
  /** Reads the modem's storage into the gateway's copy. Does not mark anything read. */
  sync: (fetchImpl?: FetchLike) => smsRequest<SyncResponse>('/sync', { method: 'POST', body: undefined, fetchImpl, timeoutMs: 40_000 }),
  status: (fetchImpl?: FetchLike) => smsRequest<StatusResponse>('/status', { fetchImpl, timeoutMs: 40_000 }),
  /** The message as the modem holds it now (gateway: GET /api/gateway/sms/:index, which leaves its status unchanged). */
  modemMessage: (index: number, fetchImpl?: FetchLike) => smsRequest<ModemMessageResponse>(`/${index}`, { fetchImpl, timeoutMs: 30_000 }),
  send: (to: string, message: string, fetchImpl?: FetchLike) => smsRequest<SendResponse>('/send', { method: 'POST', body: { to, message }, fetchImpl, timeoutMs: 100_000 }),
};

// ------------------------------------------------------------------------------------------------ compose validation

export const SMS_MAX_SEPTETS = 160;
const EXTENSION = new Set(['^', '{', '}', '\\', '[', '~', ']', '|']);

/** Characters counted the way one SMS counts them: the extension set takes two. */
export function countSmsCharacters(message: string): number {
  let n = 0;
  for (const ch of message) n += EXTENSION.has(ch) ? 2 : 1;
  return n;
}

/** Spaces, hyphens, dots and brackets are allowed in what is typed; the gateway gets only "+" and digits. */
export function normalizeRecipient(value: string): string {
  return value.trim().replace(/[\s\-.()]/g, '');
}

export interface ComposeCheck {
  to: string;
  errors: { to?: string; message?: string };
  ok: boolean;
}

export function checkCompose(rawTo: string, message: string): ComposeCheck {
  const to = normalizeRecipient(rawTo);
  const errors: ComposeCheck['errors'] = {};
  if (!to) errors.to = 'Enter the recipient number';
  else if (!/^\+[1-9]\d{6,14}$/.test(to)) errors.to = "Use international format: '+' then 7 to 15 digits, for example +919876543210";
  if (message.trim().length === 0) errors.message = 'Write a message';
  // eslint-disable-next-line no-control-regex
  else if (/[^\x20-\x7e\r\n]/.test(message)) errors.message = 'Use plain characters only (letters, digits, punctuation). Emoji and accented letters are not supported';
  else if (countSmsCharacters(message) > SMS_MAX_SEPTETS) errors.message = `One message holds ${SMS_MAX_SEPTETS} characters (this is ${countSmsCharacters(message)})`;
  return { to, errors, ok: Object.keys(errors).length === 0 };
}

// ------------------------------------------------------------------------------------------------ send outcome

/** A send whose result is not known. It is never retried automatically, and sending again needs an explicit confirmation. */
const UNCERTAIN = new Set(['SMS_OUTCOME_UNKNOWN', 'PROXY_TIMEOUT', 'PROXY_UNCERTAIN', 'CLIENT_TIMEOUT']);

export type SendView =
  | { state: 'sent'; title: string; detail: string }
  | { state: 'uncertain'; title: string; detail: string }
  | { state: 'failed'; title: string; detail: string; notSent: boolean };

export function describeSendResult(result: SendResponse): SendView {
  return {
    state: 'sent',
    title: 'The modem accepted the message',
    detail: `To ${result.to}${result.messageReference !== null ? ` (reference ${result.messageReference})` : ''}${result.isSimulated ? ' - simulated modem, nothing was transmitted' : ''}. Delivery to the phone is not confirmed by the modem.`,
  };
}

export function describeSendError(error: unknown): SendView {
  const e = error instanceof SmsApiError ? error : new SmsApiError(0, 'UNKNOWN', error instanceof Error ? error.message : 'Unknown error');
  if (UNCERTAIN.has(e.code)) {
    return {
      state: 'uncertain',
      title: 'Not sure whether it was sent',
      detail: `${e.message} Check with the recipient before sending again. The dashboard will not retry by itself.`,
    };
  }
  const notSentCodes = new Set([
    'CALL_IN_PROGRESS', 'MODEM_NOT_READY', 'SMS_BUSY', 'VALIDATION_ERROR', 'INVALID_DESTINATION', 'INVALID_MESSAGE', 'MESSAGE_TOO_LONG', 'UNSUPPORTED_CHARACTERS',
    'UNSUPPORTED_CHARSET', 'SMSC_NOT_SET', 'SMS_PARAMS_INVALID', 'SMS_PROMPT_TIMEOUT', 'SMS_CMS_ERROR', 'MODEM_ERROR', 'GATEWAY_UNREACHABLE', 'PROXY_NOT_CONFIGURED',
    'PROXY_KEY_REJECTED', 'PROXY_FORBIDDEN_HOST', 'PROXY_FORBIDDEN', 'PROXY_BAD_REQUEST', 'NETWORK_ERROR',
  ]);
  const hint = typeof e.details?.hint === 'string' ? ` ${e.details.hint}` : '';
  return { state: 'failed', title: 'The message was not sent', detail: `${e.message}${hint}`, notSent: notSentCodes.has(e.code) };
}

// ------------------------------------------------------------------------------------------------ display helpers

export function formatSmsTime(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export interface Badge {
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}

export function messageBadge(m: StoredSms): Badge {
  if (m.direction === 'received') return m.read === false ? { label: 'Unread', tone: 'warn' } : { label: 'Read', tone: 'neutral' };
  if (m.sendStatus === 'sent') return { label: 'Sent', tone: 'good' };
  if (m.sendStatus === 'unknown') return { label: 'Outcome unknown', tone: 'warn' };
  if (m.sendStatus === 'failed') return { label: 'Not sent', tone: 'bad' };
  return { label: m.modemStatus === 'STO UNSENT' ? 'Unsent' : 'Sent (stored)', tone: 'neutral' };
}

export interface Notice {
  key: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  text: string;
}

/** What the person should be told about the inbox itself. */
export function inboxNotices(inbox: InboxState | null, callActive: boolean): Notice[] {
  const notices: Notice[] = [];
  if (callActive) notices.push({ key: 'call', tone: 'neutral', text: 'A call is in progress. Messages that arrive are read after it ends, and sending and Refresh are unavailable until then.' });
  if (!inbox) return notices;
  if (!inbox.running) notices.push({ key: 'stopped', tone: 'warn', text: 'The gateway is not watching for new messages (the inbox is off). Use Refresh to read the modem.' });
  if (inbox.storageFull && inbox.storage) {
    notices.push({ key: 'full', tone: 'bad', text: `The modem's message storage (${inbox.storage.name}) is full (${inbox.storage.used}/${inbox.storage.total}). It may refuse new messages. Nothing is deleted automatically: delete some on the modem yourself.` });
  }
  if (inbox.storageMismatch) {
    notices.push({ key: 'mismatch', tone: 'warn', text: `The modem announces new messages in ${inbox.storageMismatch.indicated} but the gateway reads ${inbox.storageMismatch.reading}. Those will not appear until the modem's storage setting is changed by you.` });
  }
  const pollSeconds = inbox.polling && inbox.polling.mode !== 'off' && inbox.polling.intervalMs ? Math.round(inbox.polling.intervalMs / 1000) : null;
  if (inbox.indications && inbox.indications.notifies === false) {
    notices.push({
      key: 'indications',
      tone: 'warn',
      text: pollSeconds
        ? `The modem is not set to announce new messages, so the gateway checks it every ${pollSeconds} s instead (Refresh reads it now).`
        : 'The modem is not set to announce new messages, so they appear only when you press Refresh.',
    });
  }
  if (inbox.lastError && inbox.consecutiveFailures > 0 && !inbox.waiting) {
    const e = inbox.lastError;
    const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
    const detail = [sentence(e.hint ?? e.message), e.command ? `Command: ${e.command}.` : null].filter(Boolean).join(' ');
    notices.push({
      key: 'error',
      tone: 'warn',
      text: `The last attempt to read the modem failed (${e.code}, ${inbox.consecutiveFailures} time${inbox.consecutiveFailures === 1 ? '' : 's'} in a row). ${detail} ${inbox.pending ? 'It will try again shortly.' : 'Use Refresh from modem to try again.'}`,
    });
  }
  if (inbox.listMode === 'standard') {
    notices.push({
      key: 'list-mode',
      tone: 'neutral',
      text: 'This modem cannot list messages without flagging them as read on the SIM, so the gateway uses the standard listing and keeps each message Unread here until you read it. Nothing is deleted.',
    });
  }
  if (inbox.waiting === 'call') notices.push({ key: 'waiting-call', tone: 'neutral', text: 'New messages are waiting to be read until the call ends.' });
  if (inbox.waiting === 'modem') notices.push({ key: 'waiting-modem', tone: 'neutral', text: 'New messages are waiting to be read until the modem is ready.' });
  return notices;
}

export type ListStateKind = 'loading' | 'messages' | 'empty' | 'offline' | 'auth' | 'setup' | 'error';

/**
 * What the message list area shows. An empty inbox is only called empty when the gateway answered: an offline gateway, a
 * rejected key or a missing setup is said as such, never shown as "no messages".
 */
export function listState(input: { loading: boolean; error: SmsApiError | null; count: number; inbox: InboxState | null; folder: 'inbox' | 'sent' }): { kind: ListStateKind; text: string } {
  const { loading, error, count, inbox, folder } = input;
  if (count > 0) return { kind: 'messages', text: '' };
  if (loading) return { kind: 'loading', text: 'Loading messages...' };
  if (error) {
    if (['GATEWAY_UNREACHABLE', 'GATEWAY_TIMEOUT', 'NETWORK_ERROR', 'CLIENT_TIMEOUT', 'GATEWAY_BAD_RESPONSE'].includes(error.code)) {
      return { kind: 'offline', text: 'The gateway is not answering, so the stored messages cannot be shown. Nothing is lost: they are kept on the gateway and appear here when it is back.' };
    }
    if (error.code === 'PROXY_KEY_REJECTED') return { kind: 'auth', text: "The gateway refused the dashboard server's key, so the inbox cannot be read. See the setup note above." };
    if (error.code === 'PROXY_NOT_CONFIGURED' || error.code === 'PROXY_FORBIDDEN_HOST') return { kind: 'setup', text: 'The inbox cannot be read until the setup above is done.' };
    if (error.code === 'SMS_STORE_ERROR') return { kind: 'error', text: `The gateway could not read its message database, so stored messages cannot be shown (they are not deleted). ${error.message}` };
    return { kind: 'error', text: `The inbox could not be read: ${error.message}` };
  }
  if (folder === 'sent') return { kind: 'empty', text: 'No sent messages yet.' };
  // Nothing stored and the reads are failing: that is a failure to report, not an empty inbox.
  if (inbox?.lastError && inbox.consecutiveFailures > 0) {
    const e = inbox.lastError;
    return {
      kind: 'error',
      text: `No received messages are stored${inbox.lastSuccessAt ? '' : ' yet, and none has been read from the modem'}: the last read failed (${e.code}). ${e.hint ?? e.message}`,
    };
  }
  if (inbox && !inbox.running) return { kind: 'empty', text: 'No received messages are stored. The gateway is not watching for new ones (its inbox is off), so use Refresh from modem.' };
  return { kind: 'empty', text: 'No received messages yet. New messages appear here by themselves; Refresh from modem reads the modem now.' };
}

/** Background reads of the stored list: every 30 s, slowing to every 2 minutes while the gateway keeps failing (never stops). */
export function pollDelayMs(consecutiveErrors: number): number {
  return consecutiveErrors >= 3 ? 120_000 : 30_000;
}

/** The realtime "SMS: ..." notices not handled yet, so two notices close together are not missed. */
export function unseenSmsAlerts(alerts: Array<{ message: string; timestamp: string }>, seen: Set<string>): string[] {
  return alerts
    .filter((a) => a.message.startsWith('SMS:'))
    .map((a) => `${a.timestamp}|${a.message}`)
    .filter((key) => !seen.has(key));
}

/** Setup problems of the relay, not of the modem: shown with instructions instead of a bare error. */
export function setupProblem(error: SmsApiError | null): string | null {
  if (!error) return null;
  if (error.code === 'PROXY_NOT_CONFIGURED' || error.code === 'PROXY_KEY_REJECTED' || error.code === 'PROXY_FORBIDDEN_HOST') return error.message;
  return null;
}

/**
 * The text to show for a message. A gateway that already decoded it says so (`textEncoding`), and its text is used as given,
 * so nothing is decoded twice. Otherwise (an older gateway) a received message's UCS-2 hex is decoded here. Sent messages
 * are what this gateway sent and are shown exactly.
 */
export function smsDisplayText(m: { direction: string; text: string; rawText?: string; textEncoding?: SmsTextEncoding }): DecodedSmsText {
  if (m.textEncoding) return { text: m.text, rawText: m.rawText ?? m.text, encoding: m.textEncoding };
  if (m.direction !== 'received') return { text: m.text, rawText: m.text, encoding: 'text' };
  return decodeSmsText(m.text);
}
