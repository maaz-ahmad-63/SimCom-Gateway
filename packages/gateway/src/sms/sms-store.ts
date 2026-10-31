import crypto from 'node:crypto';
import { Database as DatabaseType } from 'better-sqlite3';
import { SmsMessage } from './parse.js';
import { decodeSmsText, SmsTextEncoding } from './text-decoding.js';

/** One message as the dashboard and API see it. */
export interface StoredSms {
  id: number;
  direction: 'received' | 'sent';
  /** 'modem': read from the modem's storage. 'gateway': sent through this gateway. */
  source: 'modem' | 'gateway';
  storage: string | null;
  index: number | null;
  /** Sender (received) or destination (sent). */
  address: string | null;
  /** Readable text: a received message the modem reported as UCS-2 hex is decoded (see text-decoding.ts). */
  text: string;
  /** Exactly what the modem reported and the database holds (never rewritten). */
  rawText: string;
  /** 'ucs2': `text` was decoded from UCS-2 hex. 'text': as received. */
  textEncoding: SmsTextEncoding;
  /** Network timestamp for a received message; when the send was attempted for a sent one. */
  time: string | null;
  /** What the modem says: REC UNREAD, REC READ, STO SENT, STO UNSENT. Null for messages sent through the gateway. */
  modemStatus: string | null;
  read: boolean | null;
  /** Gateway-sent only: 'sent' (the modem accepted it), 'unknown' (outcome not known, never auto-retried), 'failed'. */
  sendStatus: 'sent' | 'unknown' | 'failed' | null;
  messageReference: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** False once a later read of the storage no longer lists it (deleted on the modem by something else). */
  onModem: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface Row {
  id: number;
  dedupe_key: string;
  direction: 'received' | 'sent';
  source: 'modem' | 'gateway';
  storage: string | null;
  storage_index: number | null;
  address: string | null;
  text: string;
  message_time: string | null;
  modem_status: string | null;
  send_status: 'sent' | 'unknown' | 'failed' | null;
  message_reference: number | null;
  error_code: string | null;
  error_message: string | null;
  on_modem: number;
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * Identifies one stored message across re-reads and repeated notifications: the same storage, index, sender, timestamp
 * and text is the same message. (A reused index with different content is a different message.)
 */
export function dedupeKeyFor(storage: string | null, message: Pick<SmsMessage, 'index' | 'address' | 'timestamp' | 'text'>): string {
  return crypto
    .createHash('sha1')
    .update([storage ?? '', message.index, message.address ?? '', message.timestamp ?? '', message.text].join('\u0000'))
    .digest('hex');
}

/**
 * The database keeps the text exactly as the modem reported it (the dedupe key is built from it, so it is never rewritten);
 * decoding happens here, when a message is read out. Sent messages are what this gateway sent and are returned as they are.
 */
const toStored = (r: Row): StoredSms => {
  const decoded = r.direction === 'received' ? decodeSmsText(r.text) : { text: r.text, rawText: r.text, encoding: 'text' as const };
  return {
  id: r.id,
  direction: r.direction,
  source: r.source,
  storage: r.storage,
  index: r.storage_index,
  address: r.address,
  text: decoded.text,
  rawText: decoded.rawText,
  textEncoding: decoded.encoding,
  time: r.message_time,
  modemStatus: r.modem_status,
  read: r.modem_status === null ? null : r.modem_status !== 'REC UNREAD',
  sendStatus: r.send_status,
  messageReference: r.message_reference,
  errorCode: r.error_code,
  errorMessage: r.error_message,
  onModem: r.on_modem === 1,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  };
};

/** SQLite store for SMS messages. It never deletes: the gateway does not remove messages, from here or from the modem. */
export class SmsStore {
  constructor(
    private readonly db: DatabaseType,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Record a message read from the modem. Returns true when it is new. A message already known is not duplicated; its
   * modem status (read/unread) and "still on the modem" flag are refreshed.
   */
  /**
   * `preserveUnread`: the listing itself may have changed the modem's flag (the standard AT+CMGL marks listed unread messages as
   * read on the SIM). Then a message the gateway stored as unread stays unread here: only the operator marks a message read,
   * never a read the gateway made. Without it (a status-preserving listing) the modem's status is taken as it is.
   */
  upsertFromModem(storage: string | null, message: SmsMessage, options: { preserveUnread?: boolean } = {}): boolean {
    const key = dedupeKeyFor(storage, message);
    const at = this.now().toISOString();
    const direction = message.direction === 'sent' ? 'sent' : 'received';
    // Stored in UTC so messages from different network offsets sort correctly; the dedupe key keeps the original text.
    const parsed = message.timestamp ? new Date(message.timestamp) : null;
    const time = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : message.timestamp;
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO sms_messages (dedupe_key, direction, source, storage, storage_index, address, text, message_time, modem_status, on_modem, first_seen_at, last_seen_at)
         VALUES (?, ?, 'modem', ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(key, direction, storage, message.index, message.address, message.text, time, message.status, at, at);
    if (inserted.changes === 1) return true;
    if (options.preserveUnread) {
      this.db
        .prepare("UPDATE sms_messages SET modem_status = CASE WHEN modem_status = 'REC UNREAD' AND ? = 'REC READ' THEN modem_status ELSE ? END, on_modem = 1, last_seen_at = ? WHERE dedupe_key = ?")
        .run(message.status, message.status, at, key);
    } else {
      this.db.prepare('UPDATE sms_messages SET modem_status = ?, on_modem = 1, last_seen_at = ? WHERE dedupe_key = ?').run(message.status, at, key);
    }
    return false;
  }

  /**
   * After a full read of a storage: messages the store holds for it that were not in the read are flagged as no longer
   * on the modem. They are kept. Only call this after a read that completed, never after a failed one.
   */
  markMissing(storage: string | null, seenKeys: Set<string>): number {
    const rows = this.db.prepare("SELECT id, dedupe_key FROM sms_messages WHERE source = 'modem' AND on_modem = 1 AND storage IS ?").all(storage) as Array<{ id: number; dedupe_key: string }>;
    const gone = rows.filter((r) => !seenKeys.has(r.dedupe_key));
    const update = this.db.prepare('UPDATE sms_messages SET on_modem = 0 WHERE id = ?');
    for (const r of gone) update.run(r.id);
    return gone.length;
  }

  /** The stored identity of messages, for the delete check (the modem must still hold exactly these). */
  identities(ids: number[]): Array<{ id: number; dedupeKey: string; direction: string; source: string; storage: string | null; index: number | null; onModem: boolean }> {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT id, dedupe_key, direction, source, storage, storage_index, on_modem FROM sms_messages WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: number; dedupe_key: string; direction: string; source: string; storage: string | null; storage_index: number | null; on_modem: number }>;
    return rows.map((r) => ({ id: r.id, dedupeKey: r.dedupe_key, direction: r.direction, source: r.source, storage: r.storage, index: r.storage_index, onModem: r.on_modem === 1 }));
  }

  /** After an operator-confirmed delete on the modem: the stored copy is kept, flagged as no longer on the modem. */
  markDeletedFromModem(id: number): void {
    this.db.prepare('UPDATE sms_messages SET on_modem = 0 WHERE id = ?').run(id);
  }

  /** A message the gateway tried to send. `unknown` means the outcome could not be established. */
  recordSent(entry: { to: string; text: string; status: 'sent' | 'unknown' | 'failed'; messageReference?: number | null; errorCode?: string; errorMessage?: string }): number {
    const at = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO sms_messages (dedupe_key, direction, source, address, text, message_time, send_status, message_reference, error_code, error_message, on_modem, first_seen_at, last_seen_at)
         VALUES (?, 'sent', 'gateway', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(`gw:${crypto.randomUUID()}`, entry.to, entry.text, at, entry.status, entry.messageReference ?? null, entry.errorCode ?? null, entry.errorMessage?.slice(0, 300) ?? null, at, at);
    return Number(result.lastInsertRowid);
  }

  list(options: { direction?: 'received' | 'sent'; limit?: number; offset?: number } = {}): { messages: StoredSms[]; total: number; unread: number } {
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const where = options.direction ? 'WHERE direction = ?' : '';
    const args = options.direction ? [options.direction] : [];
    const rows = this.db.prepare(`SELECT * FROM sms_messages ${where} ORDER BY COALESCE(message_time, first_seen_at) DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Row[];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM sms_messages ${where}`).get(...args) as { n: number }).n;
    const unread = (this.db.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE direction = 'received' AND modem_status = 'REC UNREAD'").get() as { n: number }).n;
    return { messages: rows.map(toStored), total, unread };
  }

  get(id: number): StoredSms | null {
    const row = this.db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(id) as Row | undefined;
    return row ? toStored(row) : null;
  }
}
