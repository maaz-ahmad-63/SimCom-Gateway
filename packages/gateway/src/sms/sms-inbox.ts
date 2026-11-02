import { IModemAdapter, UrcEvent } from '@sim-gateway/shared';
import { createLogger, Logger, redactDiagnosticText } from '../core/logger.js';
import { GatewayEventBus } from '../core/event-bus.js';
import { dedupeKeyFor, SmsStore } from './sms-store.js';
import { SmsError, SmsService } from './sms-service.js';

export interface SmsInboxOptions {
  service: SmsService;
  store: SmsStore;
  modem: IModemAdapter;
  /** Used to learn that a call ended (to catch up on what arrived during it) and to announce new messages. */
  eventBus?: GatewayEventBus;
  /** Notifications that arrive close together become one read (default 1500 ms). */
  debounceMs?: number;
  /** After a call ends, wait this long before reading, so the call's own cleanup finishes first (default 3000 ms). */
  afterCallMs?: number;
  /** Waits before the 1st, 2nd and 3rd retry of a FAILED read; then it stops until the next trigger (default 5 s, 30 s, 120 s). Reads only: a send is never retried. */
  retryDelaysMs?: readonly number[];
  /** While a call or a send is in the way, how soon to look again (defaults 30000 ms and 2000 ms). */
  waitRecheckMs?: number;
  busyRecheckMs?: number;
  /** Read the storage this often, always (SMS_POLL_INTERVAL_MS). 0 (default) = off. */
  pollIntervalMs?: number;
  /**
   * Until the first +CMTI has actually arrived, read the storage this often (default 120000 ms; 0 = off). A modem whose AT+CNMI
   * does not route indications, or whose firmware sends them to another USB port, otherwise shows new messages only on Refresh.
   * Once a notification has arrived, notifications drive the reads and this stops. Each read is refused during a call, so it
   * never sends an AT command while one exists.
   */
  fallbackPollMs?: number;
  logger?: Logger;
  now?: () => Date;
}

export interface InboxSyncResult {
  success: true;
  /** Messages read from the modem's storage in this pass. */
  listed: number;
  /** Of those, how many were new to the gateway. */
  added: number;
  storage: { name: string; used: number; total: number } | null;
  storageFull: boolean;
}

export interface InboxState {
  running: boolean;
  syncing: boolean;
  /** A read has been asked for and has not happened yet. */
  pending: boolean;
  /** Why a pending read is waiting: a call, the modem not being ready, or another SMS operation. */
  waiting: 'call' | 'modem' | 'busy' | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  /** The last failed read, sanitized (no numbers, keys or IMEI/IMSI): what failed, which command, and what to do. */
  lastError: { code: string; message: string; at: string; command?: string | null; hint?: string | null } | null;
  /** How this modem's storage is listed: without changing any status, with the standard command (statuses kept here), or not known yet. */
  listMode: 'status-preserving' | 'standard' | null;
  consecutiveFailures: number;
  storage: { name: string; used: number; total: number } | null;
  /** Storage is full: the modem may refuse new messages. The gateway never deletes anything to make room. */
  storageFull: boolean;
  /** AT+CNMI?: whether the modem announces new messages with +CMTI (null = not read yet or unreadable). */
  indications: { cnmi: number[] | null; notifies: boolean | null } | null;
  /** New-message notifications received since the gateway started. */
  notificationsSeen: number;
  /** A notification named a different storage than the one being read; that message will not be read until the storage setting is changed by the operator. */
  storageMismatch: { indicated: string; reading: string } | null;
  /** How the storage is being checked besides notifications: a fixed poll, the fallback poll (until a notification arrives), or neither. */
  polling: { mode: 'interval' | 'fallback' | 'off'; intervalMs: number | null };
}

/** Reasons a read cannot happen right now. They are waited out, not counted as failures and not retried on a timer that touches the modem. */
const WAIT_CODES: Record<string, 'call' | 'modem' | 'busy'> = { CALL_IN_PROGRESS: 'call', MODEM_NOT_READY: 'modem', MODEM_DISCONNECTED: 'modem', SMS_BUSY: 'busy' };

/** What to do about a failed read, in the operator's words. */
function hintFor(code: string, command: string | null): string | null {
  switch (code) {
    case 'MODEM_ERROR':
      return `The modem answered ERROR${command ? ` to ${command}` : ''}. Check the modem's SMS settings on the SMS page (Check settings, read-only); the stored messages are unaffected.`;
    case 'SMS_CMS_ERROR':
      return 'The modem refused the read with a +CMS error (see the code). Common causes: no SIM storage selected, or the SIM is busy just after start-up.';
    case 'MODEM_TIMEOUT':
      return 'The modem did not answer in time. It is read again on the next notification, poll or Refresh.';
    case 'SMS_STORE_ERROR':
      return "The gateway could not write to its database. The messages are still on the modem and are read again next time; check the gateway's disk and log.";
    default:
      return null;
  }
}

/**
 * Keeps a persistent copy of what is in the modem's SMS storage, driven by the modem's own +CMTI notifications.
 *
 * Every read goes through SmsService, so it is serialized with call control on the one AT queue, refused during a call,
 * and never opens a port of its own. A read lists the storage without changing any message's status (read/unread), and
 * is deduplicated against what is stored, so repeated notifications or re-reads never create copies. If storage is full
 * that is reported; nothing is ever deleted, from the database or from the modem.
 *
 * Later phases (automation rules) can subscribe to the same ingestion point: `onNewMessages`.
 */
export class SmsInbox {
  private readonly service: SmsService;
  private readonly store: SmsStore;
  private readonly modem: IModemAdapter;
  private readonly eventBus?: GatewayEventBus;
  private readonly debounceMs: number;
  private readonly afterCallMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly waitRecheckMs: number;
  private readonly busyRecheckMs: number;
  private readonly pollIntervalMs: number;
  private readonly fallbackPollMs: number;
  private readonly logger: Logger;
  private readonly now: () => Date;

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Infinity;
  private pollTimer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private wasReady = false;
  private inFlight: Promise<InboxSyncResult> | null = null;
  private rerun = false;
  private pending = false;
  private waiting: InboxState['waiting'] = null;
  private lastSyncAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: InboxState['lastError'] = null;
  private failures = 0;
  private storage: InboxState['storage'] = null;
  private storageFull = false;
  private indications: InboxState['indications'] = null;
  private notificationsSeen = 0;
  private indicatedStorage: string | null = null;
  private mismatchReported = false;
  private indicationsWarned = false;
  private readonly newMessageListeners = new Set<(count: number) => void>();

  constructor(options: SmsInboxOptions) {
    this.service = options.service;
    this.store = options.store;
    this.modem = options.modem;
    this.eventBus = options.eventBus;
    this.debounceMs = options.debounceMs ?? 1500;
    this.afterCallMs = options.afterCallMs ?? 3000;
    this.retryDelaysMs = options.retryDelaysMs ?? [5_000, 30_000, 120_000];
    this.waitRecheckMs = options.waitRecheckMs ?? 30_000;
    this.busyRecheckMs = options.busyRecheckMs ?? 2_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 0;
    this.fallbackPollMs = options.fallbackPollMs ?? 120_000;
    this.logger = options.logger ?? createLogger('SmsInbox');
    this.now = options.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------------------------------ lifecycle

  start(): void {
    if (this.running) return;
    this.running = true;
    this.modem.on('urc', this.onUrc);
    this.modem.on('connection_state', this.onConnectionState);
    this.eventBus?.on('call:ended', this.onCallEnded);
    if (this.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => this.requestSync('poll'), this.pollIntervalMs);
      this.pollTimer.unref?.();
    } else if (this.fallbackPollMs > 0) {
      this.fallbackTimer = setInterval(() => this.requestSync('fallback-poll'), this.fallbackPollMs);
      this.fallbackTimer.unref?.();
    }
    // Catch up on whatever arrived while the gateway was not running.
    this.wasReady = this.modem.getConnectionState() === 'READY';
    if (this.wasReady) this.requestSync('startup');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.modem.off('urc', this.onUrc);
    this.modem.off('connection_state', this.onConnectionState);
    this.eventBus?.off('call:ended', this.onCallEnded);
    if (this.timer) clearTimeout(this.timer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.stopFallback();
    this.timer = null;
    this.pollTimer = null;
    this.timerAt = Infinity;
  }

  /** Later phases (rules, automation) can react to new messages here. Not used yet. */
  onNewMessages(listener: (count: number) => void): () => void {
    this.newMessageListeners.add(listener);
    return () => this.newMessageListeners.delete(listener);
  }

  state(): InboxState {
    return {
      running: this.running,
      syncing: this.inFlight !== null,
      pending: this.pending,
      waiting: this.waiting,
      lastSyncAt: this.lastSyncAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      listMode: this.service.listCapability(),
      consecutiveFailures: this.failures,
      storage: this.storage,
      storageFull: this.storageFull,
      indications: this.indications,
      notificationsSeen: this.notificationsSeen,
      storageMismatch: this.indicatedStorage && this.storage && this.indicatedStorage !== this.storage.name ? { indicated: this.indicatedStorage, reading: this.storage.name } : null,
      polling: this.pollTimer
        ? { mode: 'interval', intervalMs: this.pollIntervalMs }
        : this.fallbackTimer
          ? { mode: 'fallback', intervalMs: this.fallbackPollMs }
          : { mode: 'off', intervalMs: null },
    };
  }

  // ------------------------------------------------------------------------------------------ triggers

  private readonly onUrc = (urc: UrcEvent): void => {
    if (urc.type !== 'CUSTOM' || urc.payload?.kind !== 'sms-indication') return;
    this.notificationsSeen++;
    // Notifications reach this port: they drive the reads from now on, so the fallback poll is no longer needed.
    if (this.fallbackTimer) {
      this.stopFallback();
      this.logger.info('SMS: new-message notifications arrive on the AT port; the fallback poll is stopped');
    }
    const storage = typeof urc.payload.storage === 'string' ? urc.payload.storage : null;
    if (storage) this.indicatedStorage = storage;
    this.logger.info(`SMS: new-message notification (${this.notificationsSeen} since start)`);
    this.requestSync('notification');
  };

  private readonly onConnectionState = (state: string): void => {
    if (state === 'READY') {
      // After a reconnect the modem may have been reset or replaced: learn its indication setting and listing capability again,
      // and catch up.
      if (!this.wasReady) {
        this.indications = null;
        this.service.resetCapabilities();
      }
      this.wasReady = true;
      this.requestSync('modem-ready');
    } else if (state === 'DISCONNECTED' || state === 'ERROR') {
      this.wasReady = false;
    }
  };

  private stopFallback(): void {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private readonly onCallEnded = (): void => {
    // Anything that arrived during the call is read now (the read was refused while the call lasted).
    if (this.pending) this.schedule(this.afterCallMs);
  };

  /** Ask for a read soon. Requests close together are one read. Safe to call at any time. */
  requestSync(reason: string): void {
    if (!this.running) return;
    this.pending = true;
    this.logger.debug(`SMS: read requested (${reason})`);
    this.schedule(this.debounceMs);
  }

  private schedule(ms: number): void {
    const at = Date.now() + ms;
    if (this.timer && this.timerAt <= at) return; // an earlier read is already planned
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      void this.runPending();
    }, ms);
    this.timer.unref?.();
  }

  private async runPending(): Promise<void> {
    if (!this.running || !this.pending) return;
    try {
      await this.sync();
    } catch (error) {
      this.afterFailure(error);
    }
  }

  private afterFailure(error: unknown): void {
    const smsError = error instanceof SmsError ? error : null;
    const wait = smsError ? WAIT_CODES[smsError.code] : undefined;
    if (wait) {
      // Not a failure: the read just has to wait for the call to end, the modem to be ready, or the other SMS operation.
      this.waiting = wait;
      this.pending = true;
      if (wait === 'busy') this.schedule(this.busyRecheckMs);
      else if (wait === 'modem') this.schedule(this.waitRecheckMs);
      else this.schedule(this.waitRecheckMs); // a call also schedules a read when it ends
      return;
    }
    this.waiting = null;
    this.failures++;
    const code = smsError?.code ?? 'SMS_INTERNAL_ERROR';
    const command = typeof smsError?.details?.command === 'string' ? smsError.details.command : null;
    this.lastError = { code, message: redactDiagnosticText((error as Error).message).slice(0, 300), at: this.now().toISOString(), command, hint: hintFor(code, command) };
    const delay = this.retryDelaysMs[this.failures - 1];
    if (delay !== undefined) {
      this.logger.warn(`SMS: reading the storage failed (${this.lastError.code}); retry ${this.failures} of ${this.retryDelaysMs.length} in ${Math.round(delay / 1000)} s`);
      this.pending = true;
      this.schedule(delay);
    } else {
      this.logger.warn(`SMS: reading the storage failed (${this.lastError.code}); giving up until the next notification or manual refresh`);
      this.pending = false;
      this.alert('warn', `SMS: could not read the modem's messages (${this.lastError.code}). Use Refresh to try again.`);
    }
  }

  // ------------------------------------------------------------------------------------------ the read

  /**
   * Read the modem's storage now, once, and ingest it. Used by the dashboard's Refresh. Errors (call in progress, busy,
   * modem not ready, modem errors) are thrown to the caller, not retried. If a read is already running its result is returned.
   */
  async syncNow(): Promise<InboxSyncResult> {
    return this.sync();
  }

  private sync(): Promise<InboxSyncResult> {
    if (this.inFlight) {
      this.rerun = true; // something arrived while reading: read once more afterwards
      return this.inFlight;
    }
    const run = this.readAndIngest().finally(() => {
      this.inFlight = null;
      if (this.rerun) {
        this.rerun = false;
        if (this.running) this.requestSync('arrived-during-read');
      }
    });
    this.inFlight = run;
    return run;
  }

  private async readAndIngest(): Promise<InboxSyncResult> {
    this.lastSyncAt = this.now().toISOString();
    {
      // The status-preserving listing first; on firmware that rejects it, the standard one. A message stored as unread stays
      // unread here either way (preserveUnread), so the gateway's own reads never mark anything read on the dashboard.
      const listing = await this.service.list({ status: 'all', markRead: false, fallbackToStandard: true });
      const storageName = listing.storage?.name ?? null;
      const seen = new Set<string>();
      let added = 0;
      try {
        for (const message of listing.messages) {
          seen.add(dedupeKeyFor(storageName, message));
          if (this.store.upsertFromModem(storageName, message, { preserveUnread: !listing.statusPreserved })) added++;
        }
        this.store.markMissing(storageName, seen);
      } catch (error) {
        throw new SmsError(500, 'SMS_STORE_ERROR', `The gateway could not save the messages to its database: ${redactDiagnosticText((error as Error).message).slice(0, 200)}`);
      }

      this.storage = listing.storage;
      this.pending = false;
      this.waiting = null;
      this.failures = 0;
      this.lastError = null;
      this.lastSuccessAt = this.now().toISOString();
      this.updateStorageState();
      await this.readIndicationsOnce();

      if (added > 0) {
        this.logger.info(`SMS: ${added} new message(s) stored`);
        // No sender or text in the notice: it is only a nudge for the dashboard to refresh.
        this.alert('info', `SMS: ${added} new message${added === 1 ? '' : 's'} received`);
        for (const listener of this.newMessageListeners) {
          try {
            listener(added);
          } catch {
            // a listener must not break ingestion
          }
        }
      }
      return { success: true, listed: listing.count, added, storage: listing.storage, storageFull: this.storageFull };
    }
  }

  /** Full storage is reported, once per change. Nothing is deleted to make room. */
  private updateStorageState(): void {
    const full = this.storage !== null && this.storage.total > 0 && this.storage.used >= this.storage.total;
    if (full && !this.storageFull) {
      this.alert(
        'warn',
        `SMS: the modem's message storage (${this.storage!.name}) is full (${this.storage!.used}/${this.storage!.total}). It may refuse new messages. The gateway never deletes messages; delete some on the modem yourself.`
      );
    } else if (!full && this.storageFull) {
      this.alert('info', 'SMS: the modem has room for new messages again');
    }
    this.storageFull = full;
    const mismatch = this.state().storageMismatch;
    if (mismatch && !this.mismatchReported) {
      this.mismatchReported = true;
      this.alert(
        'warn',
        `SMS: the modem announces new messages in ${mismatch.indicated} but the gateway reads ${mismatch.reading}. Those messages will not appear until the modem's storage setting (AT+CPMS) is changed by you; the gateway does not change it.`
      );
    }
  }

  /** Whether the modem announces new messages at all, learned once (read only). */
  private async readIndicationsOnce(): Promise<void> {
    if (this.indications !== null) return;
    try {
      this.indications = await this.service.indicationSetting();
    } catch {
      return; // asked again after the next read
    }
    if (this.indications.notifies === false && !this.indicationsWarned) {
      this.indicationsWarned = true;
      this.alert(
        'warn',
        `SMS: the modem does not announce new messages with +CMTI (AT+CNMI? is ${this.indications.cnmi?.join(',') ?? 'unreadable'}). The gateway does not change it; ${this.fallbackTimer ? `it checks the storage every ${Math.round(this.fallbackPollMs / 1000)} s instead` : 'use Refresh, or set SMS_POLL_INTERVAL_MS'}.`
      );
    }
  }

  private alert(level: 'info' | 'warn' | 'error', message: string): void {
    this.eventBus?.emit('gateway:alert', { level, message, timestamp: this.now().toISOString() });
  }
}
