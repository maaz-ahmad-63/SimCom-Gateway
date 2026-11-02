import {
  AtCommandError,
  AtCommandTimeoutError,
  ICallSessionManager,
  IModemAdapter,
  SerialPortDisconnectedError,
} from '@sim-gateway/shared';
import { AtPromptTimeoutError } from '../adapters/modem/at-command-queue.js';
import { createLogger, Logger } from '../core/logger.js';
import { cmsHint, parseCmsError } from './cms-errors.js';
import { dedupeKeyFor } from './sms-store.js';
import type { SmsStore } from './sms-store.js';
import {
  checkCsmp,
  checkMessageBasics,
  checkMessageForCharset,
  Csmp,
  normalizeDestination,
  parseCmgf,
  parseCmgl,
  parseCmgr,
  parseCpms,
  parseCpmsSupport,
  parseCsca,
  parseCscs,
  parseCsmp,
  parseIntegers,
  SmsMessage,
  SmsStatus,
  SmsValidationError,
  csmpEquals,
  STANDARD_CSMP,
  STANDARD_CSMP_COMMAND,
} from './parse.js';

/** The exact text a caller must send to authorize writing the standard text-mode parameters. */
export const CSMP_CONFIRMATION = `APPLY ${STANDARD_CSMP_COMMAND}`;

/** An SMS operation that failed, with the HTTP status and a stable code the API returns. */
/** The modem refused the ",1" (do not change status) parameter of AT+CMGL itself: a bare ERROR, or +CMS ERROR 303 (not supported). */
function rejectsListModeParameter(error: unknown): boolean {
  if (!(error instanceof AtCommandError || (error as Error)?.name === 'AtCommandError')) return false;
  const cms = parseCmsError((error as Error).message);
  return cms === null || cms.code === 303;
}

/** The exact text an operator sends to select a storage: it names what will happen. */
export const storageConfirmation = (storage: string) => `USE ${storage} FOR SMS STORAGE`;
/** The exact text an operator sends to delete: the count and the storage. */
export const deleteConfirmation = (count: number, storage: string) => `DELETE ${count} MESSAGE${count === 1 ? '' : 'S'} FROM ${storage}`;

type CpmsInfo = NonNullable<ReturnType<typeof parseCpms>>;
const withFree = (s: CpmsInfo['read']) => ({ ...s, free: Number.isFinite(s.total) && Number.isFinite(s.used) ? Math.max(0, s.total - s.used) : null });

export class SmsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SmsError';
  }
}

/** The one extra thing a modem must offer to send an SMS (the hardware and the mock adapters both do). */
export interface SmsCapableModem {
  sendSmsText(
    to: string,
    text: string,
    options?: { promptTimeoutMs?: number; completionTimeoutMs?: number }
  ): Promise<{ messageReference: number | null; raw: string }>;
}

export interface SmsServiceOptions {
  modem: IModemAdapter;
  callManager: ICallSessionManager;
  /** How long to wait for the modem's '>' prompt after AT+CMGS (default 8000 ms). */
  promptTimeoutMs?: number;
  /**
   * How long to wait for the network to accept a message after its text was sent (default 30000 ms, or SMS_SEND_TIMEOUT_MS).
   * The AT port is occupied for this long, so a call cannot be answered or hung up by AT command until it ends.
   */
  sendTimeoutMs?: number;
  /** Ordinary AT queries (default 5000 ms). */
  commandTimeoutMs?: number;
  /** Listing stored messages (default 15000 ms). */
  listTimeoutMs?: number;
  logger?: Logger;
  /** When given, every send that reached the modem is recorded (sent, unknown or failed) for the dashboard. */
  store?: SmsStore;
}

export interface SmsSendResult {
  success: true;
  to: string;
  messageReference: number | null;
  characters: number;
  /** Modem settings this request changed (only ever AT+CMGF=1, and only when the modem was in PDU mode). */
  settingsChanged: string[];
  warnings: string[];
  isSimulated: boolean;
}

export interface SmsListResult {
  success: true;
  count: number;
  messages: SmsMessage[];
  /** The storage being read (AT+CPMS?), when the modem reported it. */
  storage: { name: string; used: number; total: number } | null;
  /** True when the listing was allowed to change received messages from unread to read. */
  markedRead: boolean;
  /** True when the modem was asked, and accepted, to leave every message's status as it was (AT+CMGL with ",1"). */
  statusPreserved: boolean;
  settingsChanged: string[];
  isSimulated: boolean;
}

const STATUSES: Record<string, SmsStatus> = {
  all: 'ALL',
  unread: 'REC UNREAD',
  'rec unread': 'REC UNREAD',
  read: 'REC READ',
  'rec read': 'REC READ',
  unsent: 'STO UNSENT',
  'sto unsent': 'STO UNSENT',
  sent: 'STO SENT',
  'sto sent': 'STO SENT',
};

export function normalizeStatus(value: unknown): SmsStatus {
  if (value === undefined || value === '') return 'ALL';
  const found = typeof value === 'string' ? STATUSES[value.trim().toLowerCase()] : undefined;
  if (!found) throw new SmsError(400, 'INVALID_STATUS', "'status' must be one of: all, unread, read, unsent, sent");
  return found;
}

const maskNumber = (n: string): string => (n.length <= 6 ? '***' : `${n.slice(0, 3)}${'*'.repeat(n.length - 5)}${n.slice(-2)}`);

export class SmsService {
  private readonly modem: IModemAdapter;
  private readonly callManager: ICallSessionManager;
  private readonly promptTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly listTimeoutMs: number;
  private readonly logger: Logger;
  private readonly store: SmsStore | undefined;
  private inFlight: string | null = null;
  /**
   * Whether this modem accepts AT+CMGL="...",1 (list without changing status). null until tried. Some SIM7600 firmware answers a
   * bare ERROR to the second parameter, so the inbox falls back to the standard listing (which flags listed unread messages as
   * read on the SIM itself) and keeps them unread in the gateway's own records. Forgotten on a reconnect (it may be another modem).
   */
  private statusPreservingList: boolean | null = null;

  constructor(options: SmsServiceOptions) {
    this.modem = options.modem;
    this.callManager = options.callManager;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 8000;
    const fromEnv = Number(process.env.SMS_SEND_TIMEOUT_MS);
    this.sendTimeoutMs = options.sendTimeoutMs ?? (Number.isFinite(fromEnv) && fromEnv >= 5000 && fromEnv <= 120000 ? fromEnv : 30000);
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
    this.listTimeoutMs = options.listTimeoutMs ?? 15000;
    this.logger = options.logger ?? createLogger('Sms');
    this.store = options.store;
  }

  /** A database problem must never turn a delivered (or uncertain) send into an error or hide it from the caller. */
  private remember(entry: Parameters<SmsStore['recordSent']>[0]): void {
    try {
      this.store?.recordSent(entry);
    } catch (error) {
      this.logger.warn(`SMS: could not record the sent message (${(error as Error).message})`);
    }
  }

  /**
   * The modem's new-message indication setting, read only (AT+CNMI?). `mt` 1 means a +CMTI line announces each new
   * message, which is what the inbox listens for; 0 means no indications, 2 means the text is pushed to the host
   * instead (+CMT), which this gateway does not handle. Null when it could not be read. Changes nothing.
   */
  async indicationSetting(): Promise<{ cnmi: number[] | null; notifies: boolean | null }> {
    return this.exclusive('indication', async () => {
      const reply = await this.ask('AT+CNMI?');
      if (!reply.ok) return { cnmi: null, notifies: null };
      const cnmi = parseIntegers(reply.raw, 'CNMI');
      return { cnmi, notifies: cnmi ? cnmi[1] === 1 : null };
    });
  }

  // ------------------------------------------------------------------------------------------ guards

  /**
   * SMS commands share the single AT port with call control, so none are sent while any call exists (the same rule as
   * the Hardware page's AT queries), nor while the modem is not READY.
   */
  private guard(): void {
    if (this.callManager.getCurrentCall()) {
      throw new SmsError(409, 'CALL_IN_PROGRESS', 'A call is in progress; SMS commands are not sent during a call so call control and audio are not disturbed');
    }
    const state = this.modem.getConnectionState();
    if (state !== 'READY') throw new SmsError(409, 'MODEM_NOT_READY', `The modem is ${state}, not READY`);
  }

  /** One SMS operation at a time: a second request is refused, not queued behind a send that can take half a minute. */
  private async exclusive<T>(label: string, work: () => Promise<T>): Promise<T> {
    this.guard();
    if (this.inFlight) throw new SmsError(409, 'SMS_BUSY', `Another SMS operation (${this.inFlight}) is in progress`);
    this.inFlight = label;
    try {
      return await work();
    } finally {
      this.inFlight = null;
    }
  }

  get busy(): string | null {
    return this.inFlight;
  }

  // ------------------------------------------------------------------------------------------ error mapping

  private mapError(error: unknown, context: Record<string, unknown> = {}): SmsError {
    if (error instanceof SmsError) return error;
    if (error instanceof SmsValidationError) {
      // The caller's input is wrong (400), except when what is wrong is the modem's current character set (409).
      return new SmsError(error.code === 'UNSUPPORTED_CHARSET' ? 409 : 400, error.code, error.message, context);
    }
    if (error instanceof AtPromptTimeoutError) {
      return error.phase === 'prompt'
        ? new SmsError(504, 'SMS_PROMPT_TIMEOUT', `The modem did not ask for the message text within ${error.timeoutMs} ms. Nothing was sent; the gateway cancelled text entry.`, context)
        : new SmsError(
            504,
            'SMS_OUTCOME_UNKNOWN',
            `The message text was sent but the modem gave no result within ${error.timeoutMs} ms. The message MAY have been sent: check with the recipient before sending again.`,
            context
          );
    }
    if (error instanceof AtCommandTimeoutError || (error as Error)?.name === 'AtCommandTimeoutError') {
      return new SmsError(504, 'MODEM_TIMEOUT', (error as Error).message, context);
    }
    if (error instanceof SerialPortDisconnectedError || (error as Error)?.name === 'SerialPortDisconnectedError') {
      return new SmsError(503, 'MODEM_DISCONNECTED', (error as Error).message, context);
    }
    if (error instanceof AtCommandError || (error as Error)?.name === 'AtCommandError') {
      const cms = parseCmsError((error as Error).message);
      if (cms) {
        const hint = cmsHint(cms.code);
        const notFound = cms.code === 321;
        const label = cms.code !== null ? `${cms.code} (${cms.text})` : cms.text;
        return new SmsError(notFound ? 404 : 502, notFound ? 'SMS_NOT_FOUND' : 'SMS_CMS_ERROR', `The modem refused the request: +CMS ERROR: ${label}`, {
          cmsCode: cms.code,
          cmsText: cms.text,
          ...(hint ? { hint } : {}),
          ...context,
        });
      }
      return new SmsError(502, 'MODEM_ERROR', (error as Error).message, context);
    }
    return new SmsError(500, 'SMS_INTERNAL_ERROR', error instanceof Error ? error.message : 'Unexpected error', context);
  }

  // ------------------------------------------------------------------------------------------ read-only helpers

  private async ask(command: string, timeoutMs = this.commandTimeoutMs): Promise<{ ok: true; raw: string } | { ok: false; error: string; cause: unknown }> {
    try {
      return { ok: true, raw: await this.modem.executeCommand(command, timeoutMs) };
    } catch (error) {
      return { ok: false, error: (error as Error).message, cause: error };
    }
  }

  /**
   * Text mode is required for every text endpoint. If the modem reports PDU mode the gateway switches it with AT+CMGF=1,
   * says so in the response (settingsChanged), and logs it. That is the only setting ever changed: the service centre,
   * text-mode parameters, character set, storage and new-message indication are read, never written.
   */
  private async ensureTextMode(settingsChanged: string[]): Promise<void> {
    const mode = await this.ask('AT+CMGF?');
    if (!mode.ok) throw this.mapError(mode.cause); // keeps the real cause: a timeout stays a timeout
    const value = parseCmgf(mode.raw);
    if (value === null) throw new SmsError(502, 'MODEM_ERROR', `Could not read the SMS format (AT+CMGF?): ${mode.raw.slice(0, 120)}`);
    if (value === 1) return;
    const set = await this.ask('AT+CMGF=1');
    if (!set.ok) throw this.mapError(set.cause);
    settingsChanged.push('AT+CMGF=1 (the modem was in PDU mode)');
    this.logger.info('SMS: the modem was in PDU mode; switched it to text mode with AT+CMGF=1');
  }

  // ------------------------------------------------------------------------------------------ send

  async send(toValue: unknown, messageValue: unknown): Promise<SmsSendResult> {
    let to: string;
    let message: string;
    try {
      to = normalizeDestination(toValue);
      message = checkMessageBasics(messageValue);
    } catch (error) {
      throw this.mapError(error);
    }
    const modem = this.modem as IModemAdapter & Partial<SmsCapableModem>;
    if (typeof modem.sendSmsText !== 'function') throw new SmsError(501, 'SMS_NOT_SUPPORTED', 'This modem driver cannot send SMS');

    return this.exclusive('send', async () => {
      const settingsChanged: string[] = [];
      const warnings: string[] = [];
      const snapshot: Record<string, unknown> = {};
      let attempted = false;
      try {
        await this.ensureTextMode(settingsChanged);

        // Read-only look at everything text-mode sending depends on. A failed query is noted and does not block by
        // itself; a definitely wrong value does, so a rejection can be explained before it happens.
        const cscsReply = await this.ask('AT+CSCS?');
        const cscaReply = await this.ask('AT+CSCA?');
        const csmpReply = await this.ask('AT+CSMP?');
        const charset = cscsReply.ok ? parseCscs(cscsReply.raw) : null;
        const smsc = cscaReply.ok ? parseCsca(cscaReply.raw) : null;
        const csmp: Csmp | null = csmpReply.ok ? parseCsmp(csmpReply.raw) : null;
        snapshot.charset = charset;
        snapshot.smsc = smsc === null ? null : smsc === '' ? '(empty)' : '(set)';
        snapshot.csmp = csmp;
        for (const [name, reply] of [['AT+CSCS?', cscsReply], ['AT+CSCA?', cscaReply], ['AT+CSMP?', csmpReply]] as const) {
          if (!reply.ok) warnings.push(`${name} could not be read (${reply.error}); that check was skipped`);
        }

        const { septets } = checkMessageForCharset(message, charset);
        if (smsc === '') {
          throw new SmsError(
            409,
            'SMSC_NOT_SET',
            'The modem reports no SMS service centre number (AT+CSCA?). The number is carrier-specific and is not set automatically; set it on the modem and try again.',
            { snapshot }
          );
        }
        if (csmp) {
          const verdict = checkCsmp(csmp);
          warnings.push(...verdict.warnings);
          if (verdict.blocking.length > 0) {
            throw new SmsError(409, 'SMS_PARAMS_INVALID', `The modem's text-mode parameters would make it reject the message: ${verdict.blocking.join('; ')}. Nothing was sent and nothing was changed.`, {
              problems: verdict.blocking,
              snapshot,
            });
          }
        }

        this.guard(); // a call may have started while the settings were being read
        this.logger.info(`SMS: sending ${message.length} characters to ${maskNumber(to)}`);
        attempted = true;
        const result = await modem.sendSmsText!(to, message, { promptTimeoutMs: this.promptTimeoutMs, completionTimeoutMs: this.sendTimeoutMs });
        this.logger.info(`SMS: accepted by the modem for ${maskNumber(to)} (reference ${result.messageReference ?? 'unknown'})`);
        this.remember({ to, text: message, status: 'sent', messageReference: result.messageReference });
        return {
          success: true as const,
          to,
          messageReference: result.messageReference,
          characters: septets,
          settingsChanged,
          warnings,
          isSimulated: this.modem.isSimulated,
        };
      } catch (error) {
        const mapped = this.mapError(error, Object.keys(snapshot).length > 0 ? { snapshot } : {});
        this.logger.warn(`SMS: send to ${maskNumber(to)} failed (${mapped.code})`);
        // Only a send that actually reached the modem is recorded. An uncertain one is kept as 'unknown' so it stays
        // visible and nobody sends it again on a guess.
        if (attempted) {
          this.remember({ to, text: message, status: mapped.code === 'SMS_OUTCOME_UNKNOWN' ? 'unknown' : 'failed', errorCode: mapped.code, errorMessage: mapped.message });
        }
        throw mapped;
      }
    });
  }

  // ------------------------------------------------------------------------------------------ list / read

  /** What is known about listing without changing status on this modem (for diagnostics). */
  listCapability(): 'status-preserving' | 'standard' | null {
    return this.statusPreservingList === null ? null : this.statusPreservingList ? 'status-preserving' : 'standard';
  }

  /** After a reconnect the modem may be another one: learn its listing capability again. */
  resetCapabilities(): void {
    this.statusPreservingList = null;
  }

  /**
   * List the storage. `fallbackToStandard` (the inbox) uses the standard AT+CMGL="..." when the modem rejects the
   * status-preserving form; without it (the plain API) such a rejection is reported, as before. Either way it is one SMS
   * operation on the AT queue, refused during a call, and the rejected form is not sent again on this connection.
   */
  async list(options: { status?: unknown; markRead?: boolean; fallbackToStandard?: boolean } = {}): Promise<SmsListResult> {
    const status = normalizeStatus(options.status);
    const markRead = options.markRead === true;
    return this.exclusive('list', () => this.listCore(status, markRead, options.fallbackToStandard === true));
  }

  private async listCore(status: string, markRead: boolean, fallbackToStandard: boolean): Promise<SmsListResult> {
    const options = { fallbackToStandard };
    {
      const settingsChanged: string[] = [];
      let command = 'AT+CMGF?';
      try {
        await this.ensureTextMode(settingsChanged);
        command = 'AT+CSCS?';
        const charset = (await this.ask('AT+CSCS?').then((r) => (r.ok ? parseCscs(r.raw) : null)));
        command = 'AT+CPMS?';
        const cpms = await this.ask('AT+CPMS?');
        const storage = cpms.ok ? (parseCpms(cpms.raw)?.read ?? null) : null;
        const standard = `AT+CMGL="${status}"`;
        let raw: string;
        let preserved: boolean;
        if (markRead || (this.statusPreservingList === false && options.fallbackToStandard)) {
          command = standard;
          raw = await this.modem.executeCommand(standard, this.listTimeoutMs);
          preserved = false;
        } else {
          // The optional second parameter 1 asks the modem not to change a message's status (unread to read).
          command = `${standard},1`;
          try {
            raw = await this.modem.executeCommand(command, this.listTimeoutMs);
            this.statusPreservingList = true;
            preserved = true;
          } catch (error) {
            if (!rejectsListModeParameter(error)) throw error;
            this.logger.warn(`SMS: the modem rejects ${command} (list without changing status)${options.fallbackToStandard ? `; trying ${standard}` : ''}`);
            if (!options.fallbackToStandard) throw error;
            command = standard;
            try {
              raw = await this.modem.executeCommand(standard, this.listTimeoutMs);
            } catch (standardError) {
              // Both failed: that says nothing about the ",1" parameter, so nothing is concluded about it.
              this.statusPreservingList = null;
              throw standardError;
            }
            // Only the standard form works on this modem: use it directly from now on (one command per read, not two).
            this.statusPreservingList = false;
            preserved = false;
          }
        }
        const messages = parseCmgl(raw, charset);
        return { success: true as const, count: messages.length, messages, storage, markedRead: !preserved, statusPreserved: preserved, settingsChanged, isSimulated: this.modem.isSimulated };
      } catch (error) {
        throw this.withMarkReadHint(this.mapError(error, { command }), markRead);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ storage

  /**
   * Read-only: which storage is in use (AT+CPMS?) with used, total and free slots, and which storages the modem accepts for
   * each role (AT+CPMS=?). The capacity of a storage that is not selected is not reported by the modem until it is selected.
   */
  async storageInfo(): Promise<Record<string, unknown>> {
    return this.exclusive('storage', async () => {
      const current = await this.ask('AT+CPMS?');
      if (!current.ok) throw this.mapError(current.cause, { command: 'AT+CPMS?' });
      const supported = await this.ask('AT+CPMS=?');
      const cpms = parseCpms(current.raw);
      const support = supported.ok ? parseCpmsSupport(supported.raw) : null;
      const names = support ? [...new Set([...support.read, ...support.write, ...support.receive])] : [];
      return {
        success: true,
        current: cpms ? { read: withFree(cpms.read), write: withFree(cpms.write), receive: withFree(cpms.receive) } : null,
        supported: support,
        options: names.map((name) => ({
          name,
          read: support!.read.includes(name),
          write: support!.write.includes(name),
          receive: support!.receive.includes(name),
          usable: support!.read.includes(name) && support!.write.includes(name) && support!.receive.includes(name),
          selected: cpms ? cpms.read.name === name && cpms.write.name === name && cpms.receive.name === name : false,
        })),
        supportedUnknown: support === null,
        note: 'Only the selected storage reports its capacity. Another storage\'s size is known after selecting it.',
        raw: { current: current.raw.slice(0, 200), supported: supported.ok ? supported.raw.slice(0, 200) : `error: ${supported.error}` },
        isSimulated: this.modem.isSimulated,
      };
    });
  }

  /**
   * Select one storage for reading, writing and receiving (AT+CPMS="X","X","X"), after an explicit confirmation. Allowed only
   * when the modem lists X for all three roles; verified by reading AT+CPMS? back. Nothing is moved or deleted: messages
   * already in the previous storage stay there (and in the gateway's database).
   */
  async selectStorage(storageValue: unknown, confirmation: unknown): Promise<Record<string, unknown>> {
    const storage = typeof storageValue === 'string' ? storageValue.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(storage)) throw new SmsError(400, 'INVALID_STORAGE', "'storage' must be a two-letter storage name such as ME or SM");
    if (confirmation !== storageConfirmation(storage)) {
      throw new SmsError(400, 'CONFIRMATION_REQUIRED', `This changes the modem's SMS storage. To authorize it, send { "confirm": "${storageConfirmation(storage)}" } exactly.`, { required: storageConfirmation(storage) });
    }
    return this.exclusive('storage-select', async () => {
      const supportedReply = await this.ask('AT+CPMS=?');
      if (!supportedReply.ok) throw this.mapError(supportedReply.cause, { command: 'AT+CPMS=?', note: 'Nothing was changed.' });
      const support = parseCpmsSupport(supportedReply.raw);
      if (!support) throw new SmsError(502, 'STORAGE_UNKNOWN', 'The modem did not say which storages it supports (AT+CPMS=?); nothing was changed', { raw: supportedReply.raw.slice(0, 200) });
      if (!support.read.includes(storage) || !support.write.includes(storage) || !support.receive.includes(storage)) {
        throw new SmsError(409, 'STORAGE_UNSUPPORTED', `The modem does not offer ${storage} for reading, writing and receiving; nothing was changed`, { supported: support });
      }
      const beforeReply = await this.ask('AT+CPMS?');
      if (!beforeReply.ok) throw this.mapError(beforeReply.cause, { command: 'AT+CPMS?' });
      const before = parseCpms(beforeReply.raw);
      if (before && before.read.name === storage && before.write.name === storage && before.receive.name === storage) {
        return { success: true, changed: false, verified: true, storage, current: { read: withFree(before.read), write: withFree(before.write), receive: withFree(before.receive) }, isSimulated: this.modem.isSimulated };
      }
      this.guard(); // a call may have started while reading
      const command = `AT+CPMS="${storage}","${storage}","${storage}"`;
      this.logger.info(`SMS: selecting ${storage} storage (${command})`);
      const write = await this.ask(command);
      if (!write.ok) throw this.mapError(write.cause, { command, old: before, note: 'The modem refused it; the previous storage is still selected (check with the storage view).' });
      const afterReply = await this.ask('AT+CPMS?');
      const after = afterReply.ok ? parseCpms(afterReply.raw) : null;
      if (!after || after.read.name !== storage || after.write.name !== storage || after.receive.name !== storage) {
        throw new SmsError(502, 'STORAGE_VERIFY_FAILED', `The modem accepted ${command} but AT+CPMS? does not show ${storage} for all three roles`, { command, old: before, actual: after ?? (afterReply.ok ? afterReply.raw.slice(0, 200) : afterReply.error) });
      }
      this.logger.info(`SMS: ${storage} storage selected (${after.read.used}/${after.read.total} used, verified)`);
      return {
        success: true,
        changed: true,
        verified: true,
        command,
        storage,
        old: before ? { read: withFree(before.read), write: withFree(before.write), receive: withFree(before.receive) } : null,
        current: { read: withFree(after.read), write: withFree(after.write), receive: withFree(after.receive) },
        note: 'Messages in the previous storage stay there and in the gateway database; nothing was moved or deleted. Whether the modem keeps this after it restarts is not verified: the SMS page shows the storage in use after every read.',
        isSimulated: this.modem.isSimulated,
      };
    });
  }

  /**
   * Delete selected messages from the modem's storage, after an explicit confirmation that names the count and the storage.
   * Only messages the gateway has stored are eligible, and before anything is deleted the modem is read again: each index
   * must still hold exactly the stored message (same storage, sender, time and text). If any does not, nothing is deleted.
   * The gateway's copies are kept. A delete is never retried.
   */
  async deleteStored(idsValue: unknown, confirmation: unknown): Promise<Record<string, unknown>> {
    if (!this.store) throw new SmsError(501, 'SMS_STORE_UNAVAILABLE', 'The SMS message store is not available');
    const store = this.store;
    const ids = Array.isArray(idsValue) ? idsValue : [];
    if (ids.length === 0 || ids.length > 20 || !ids.every((id) => Number.isInteger(id) && id > 0) || new Set(ids).size !== ids.length) {
      throw new SmsError(400, 'INVALID_SELECTION', "'ids' must list 1 to 20 different stored message ids");
    }
    const rows = store.identities(ids as number[]);
    const problems: string[] = [];
    for (const id of ids as number[]) {
      const row = rows.find((r) => r.id === id);
      if (!row) problems.push(`message ${id} is not in the gateway database`);
      else if (row.source !== 'modem' || row.index === null || row.storage === null) problems.push(`message ${id} was not read from the modem's storage`);
      else if (!row.onModem) problems.push(`message ${id} is no longer on the modem`);
    }
    const storages = [...new Set(rows.map((r) => r.storage))];
    if (storages.length > 1) problems.push(`the selection spans several storages (${storages.join(', ')}); delete from one at a time`);
    if (problems.length > 0) throw new SmsError(409, 'NOT_SAFELY_STORED', `Nothing was deleted: ${problems.join('; ')}`, { problems });
    const storage = storages[0] as string;
    if (confirmation !== deleteConfirmation(ids.length, storage)) {
      throw new SmsError(400, 'CONFIRMATION_REQUIRED', `This deletes messages from the modem's ${storage} storage. To authorize it, send { "confirm": "${deleteConfirmation(ids.length, storage)}" } exactly.`, { required: deleteConfirmation(ids.length, storage) });
    }
    return this.exclusive('delete', async () => {
      // The modem is read again first: each index must still hold exactly the message the gateway stored.
      const listing = await this.listCore('ALL', false, true);
      if (listing.storage?.name !== storage) {
        throw new SmsError(409, 'STORAGE_CHANGED', `Nothing was deleted: the modem now reads ${listing.storage?.name ?? 'an unknown storage'}, not ${storage}`);
      }
      const mismatched = rows.filter((row) => {
        const onModem = listing.messages.find((m) => m.index === row.index);
        return !onModem || dedupeKeyFor(storage, onModem) !== row.dedupeKey;
      });
      if (mismatched.length > 0) {
        throw new SmsError(409, 'MODEM_CONTENT_CHANGED', `Nothing was deleted: the modem no longer holds exactly the stored message at index ${mismatched.map((r) => r.index).join(', ')}`, { ids: mismatched.map((r) => r.id) });
      }
      const deleted: number[] = [];
      for (const row of rows) {
        this.guard(); // never during a call
        const command = `AT+CMGD=${row.index}`;
        const reply = await this.ask(command);
        if (!reply.ok) {
          const error = this.mapError(reply.cause, { command, deleted, notAttempted: rows.filter((r) => r.id !== row.id && !deleted.includes(r.id)).map((r) => r.id) });
          this.logger.warn(`SMS: ${command} failed (${error.code}); ${deleted.length} deleted before it, the rest not attempted`);
          throw error;
        }
        store.markDeletedFromModem(row.id);
        deleted.push(row.id);
        this.logger.info(`SMS: deleted index ${row.index} from ${storage} (operator-confirmed; the gateway copy is kept)`);
      }
      return { success: true, storage, deleted, kept: 'The deleted messages remain in the gateway database.', isSimulated: this.modem.isSimulated };
    });
  }

  async read(indexValue: unknown, options: { markRead?: boolean } = {}): Promise<{ success: true; message: SmsMessage; markedRead: boolean; settingsChanged: string[]; isSimulated: boolean }> {
    const index = typeof indexValue === 'number' ? indexValue : typeof indexValue === 'string' && /^\d+$/.test(indexValue) ? Number(indexValue) : NaN;
    if (!Number.isInteger(index) || index < 1 || index > 999) throw new SmsError(400, 'INVALID_INDEX', "The message index must be a whole number from 1 to 999");
    const markRead = options.markRead === true;
    return this.exclusive('read', async () => {
      const settingsChanged: string[] = [];
      try {
        await this.ensureTextMode(settingsChanged);
        const charset = await this.ask('AT+CSCS?').then((r) => (r.ok ? parseCscs(r.raw) : null));
        const raw = await this.modem.executeCommand(`AT+CMGR=${index}${markRead ? '' : ',1'}`, this.commandTimeoutMs * 2);
        const message = parseCmgr(raw, index, charset);
        if (!message) throw new SmsError(404, 'SMS_NOT_FOUND', `There is no message at index ${index}`);
        return { success: true as const, message, markedRead: markRead, settingsChanged, isSimulated: this.modem.isSimulated };
      } catch (error) {
        throw this.withMarkReadHint(this.mapError(error), markRead);
      }
    });
  }

  private withMarkReadHint(error: SmsError, markRead: boolean): SmsError {
    if (markRead || (error.code !== 'SMS_CMS_ERROR' && error.code !== 'MODEM_ERROR')) return error;
    return new SmsError(error.status, error.code, error.message, {
      ...error.details,
      markReadHint: 'This request asked the modem not to change the message status (AT+CMGL/AT+CMGR with a second parameter 1). If this firmware does not accept that, repeat with ?markRead=true, which uses the plain command and marks unread messages as read.',
    });
  }

  // ------------------------------------------------------------------------------------------ text-mode parameters

  /**
   * Write the standard text-mode parameters (AT+CSMP=17,167,0,0) and prove it worked. This is the one operation that
   * changes the modem's SMS parameters, so it needs the exact confirmation text, a READY modem and no call, runs alone
   * on the serialized AT queue, reads AT+CSMP? before and after, and reports both. It writes nothing else: not the
   * service centre, character set, storage or indication settings. It is not saved to the modem's non-volatile memory
   * (no AT+CSAS), so a modem reset may restore the previous values. It is never retried.
   */
  async applyStandardTextParameters(confirmation: unknown): Promise<Record<string, unknown>> {
    if (confirmation !== CSMP_CONFIRMATION) {
      throw new SmsError(400, 'CONFIRMATION_REQUIRED', `This changes the modem's SMS text-mode parameters. To authorize it, send { "confirm": "${CSMP_CONFIRMATION}" } exactly.`, {
        required: CSMP_CONFIRMATION,
      });
    }
    return this.exclusive('text-parameters', async () => {
      const readCsmp = async (when: 'before' | 'after'): Promise<{ raw: string; csmp: ReturnType<typeof parseCsmp> }> => {
        const reply = await this.ask('AT+CSMP?');
        if (!reply.ok) {
          const mapped = this.mapError(reply.cause);
          throw when === 'before'
            ? mapped
            : new SmsError(502, 'CSMP_READBACK_FAILED', `AT+CSMP? could not be read back after the write (${mapped.message}); the modem's current value is unknown`, { command: STANDARD_CSMP_COMMAND });
        }
        return { raw: reply.raw, csmp: parseCsmp(reply.raw) };
      };

      const before = await readCsmp('before');
      if (!before.csmp) throw new SmsError(502, 'MODEM_ERROR', `Could not read the current AT+CSMP? value: ${before.raw.slice(0, 120)}`);
      if (csmpEquals(before.csmp, STANDARD_CSMP)) {
        this.logger.info('SMS: AT+CSMP already holds the standard values; nothing written');
        return { success: true, changed: false, verified: true, command: null, old: before.csmp, new: before.csmp, isSimulated: this.modem.isSimulated };
      }

      this.guard(); // a call may have started while the old value was being read
      this.logger.info(`SMS: writing ${STANDARD_CSMP_COMMAND} (was ${before.csmp.fo},${before.csmp.vp},${before.csmp.pid},${before.csmp.dcs})`);
      const write = await this.ask(STANDARD_CSMP_COMMAND);
      if (!write.ok) {
        const error = this.mapError(write.cause, { command: STANDARD_CSMP_COMMAND, old: before.csmp, note: 'The write was rejected; the old value may still be in effect (check with GET /api/gateway/sms/status).' });
        this.logger.warn(`SMS: ${STANDARD_CSMP_COMMAND} failed (${error.code})`);
        throw error;
      }

      const after = await readCsmp('after');
      if (!after.csmp || !csmpEquals(after.csmp, STANDARD_CSMP)) {
        throw new SmsError(502, 'CSMP_VERIFY_FAILED', `The modem accepted ${STANDARD_CSMP_COMMAND} but AT+CSMP? does not show the requested values`, {
          command: STANDARD_CSMP_COMMAND,
          old: before.csmp,
          requested: STANDARD_CSMP,
          actual: after.csmp ?? after.raw.slice(0, 120),
        });
      }
      this.logger.info('SMS: AT+CSMP now holds the standard values (verified by read-back)');
      return {
        success: true,
        changed: true,
        verified: true,
        command: STANDARD_CSMP_COMMAND,
        old: before.csmp,
        new: after.csmp,
        persisted: false,
        note: 'Not saved to the modem\'s non-volatile memory; a modem reset may restore the previous values.',
        isSimulated: this.modem.isSimulated,
      };
    });
  }

  // ------------------------------------------------------------------------------------------ diagnostics

  /**
   * Read-only diagnosis of the modem's SMS configuration: nothing is changed. It is what to look at when a send is
   * rejected (for example "+CMS ERROR: Invalid text mode parameter", code 305, which points at AT+CSMP / AT+CSCS / AT+CSCA).
   */
  async status(): Promise<Record<string, unknown>> {
    return this.exclusive('status', async () => {
      const queries: Array<[string, string]> = [
        ['textMode', 'AT+CMGF?'],
        ['serviceCentre', 'AT+CSCA?'],
        ['textModeParameters', 'AT+CSMP?'],
        ['charset', 'AT+CSCS?'],
        ['storage', 'AT+CPMS?'],
        ['supportedStorages', 'AT+CPMS=?'],
        ['newMessageIndication', 'AT+CNMI?'],
        ['showTextModeParameters', 'AT+CSDH?'],
        ['supportedListStatuses', 'AT+CMGL=?'],
        ['supportedTextModeParameters', 'AT+CSMP=?'],
      ];
      const raw: Record<string, { command: string; ok: boolean; response?: string; error?: string }> = {};
      for (const [name, command] of queries) {
        const reply = await this.ask(command);
        raw[name] = reply.ok ? { command, ok: true, response: reply.raw } : { command, ok: false, error: reply.error };
      }
      const get = (name: string): string | null => (raw[name].ok ? (raw[name].response ?? null) : null);
      const cmgf = get('textMode') ? parseCmgf(get('textMode')!) : null;
      const csca = get('serviceCentre') ? parseCsca(get('serviceCentre')!) : null;
      const csmp = get('textModeParameters') ? parseCsmp(get('textModeParameters')!) : null;
      const charset = get('charset') ? parseCscs(get('charset')!) : null;
      const cpms = get('storage') ? parseCpms(get('storage')!) : null;
      const cnmi = get('newMessageIndication') ? parseIntegers(get('newMessageIndication')!, 'CNMI') : null;

      const problems: string[] = [];
      const warnings: string[] = [];
      if (cmgf === 0) warnings.push('The modem is in PDU mode (AT+CMGF=0); the gateway switches it to text mode when an SMS endpoint is used');
      if (cmgf === null) problems.push('The SMS format (AT+CMGF?) could not be read');
      if (csca === '') problems.push('No SMS service centre number is set (AT+CSCA?)');
      if (csca === null) warnings.push('The service centre number (AT+CSCA?) could not be read');
      if (csmp) {
        const verdict = checkCsmp(csmp);
        problems.push(...verdict.blocking);
        warnings.push(...verdict.warnings);
      } else {
        warnings.push('The text-mode parameters (AT+CSMP?) could not be read');
      }
      if (charset !== null && charset !== 'GSM' && charset !== 'IRA') problems.push(`The character set is ${charset}; only GSM and IRA are supported for sending`);

      return {
        success: true,
        isSimulated: this.modem.isSimulated,
        settings: {
          textMode: cmgf === null ? null : cmgf === 1,
          serviceCentre: csca === null ? null : csca === '' ? 'not set' : 'set',
          textModeParameters: csmp,
          charset,
          storage: cpms,
          supportedStorages: get('supportedStorages') ? parseCpmsSupport(get('supportedStorages')!) : null,
          newMessageIndication: cnmi,
        },
        assessment: { canSend: problems.length === 0, problems, warnings },
        raw,
      };
    });
  }
}
