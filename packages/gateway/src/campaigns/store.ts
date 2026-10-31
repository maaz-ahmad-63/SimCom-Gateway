import { randomUUID } from 'node:crypto';
import { Database as DatabaseType } from 'better-sqlite3';
import { ColumnMapping } from './csv.js';
import { classifyEnd } from './outcome.js';
import { CampaignSettings, campaignSettingsPatchSchema, campaignSettingsSchema, Consent, shouldRetry, skipReason } from './policy.js';

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'stopped' | 'completed';
export type ContactStatus = 'queued' | 'calling' | 'completed' | 'failed' | 'skipped';

export class CampaignError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 409
  ) {
    super(message);
  }
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
  /** What the operator confirmed at start (null while a draft). */
  acknowledgements: StartAcknowledgements | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StartAcknowledgements {
  realCalls: true;
  regulations: true;
  consent: true;
  consentMode: 'column' | 'attested';
  /** The contacts that would be called when it was confirmed. */
  willCall: number;
  at: string;
}

export interface ContactRecord {
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
  consent: Consent;
  optOut: boolean;
  status: ContactStatus;
  skipReason: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  callId: string | null;
  lastOutcome: string | null;
  lastError: string | null;
}

export interface ImportRow {
  rowNumber: number;
  name: string;
  phoneRaw: string;
  phoneE164: string | null;
  designation: string;
  company: string;
  context: string;
  extra: Record<string, string>;
  consent: Consent;
  optOut: boolean;
  status: 'queued' | 'skipped';
  skipReason: string | null;
}

export interface Counts {
  total: number;
  queued: number;
  calling: number;
  completed: number;
  failed: number;
  skipped: number;
}

const STATUSES: ContactStatus[] = ['queued', 'calling', 'completed', 'failed', 'skipped'];

function mapContact(r: Record<string, any>): ContactRecord {
  let extra: Record<string, string> = {};
  try {
    extra = r.extra ? (JSON.parse(r.extra) as Record<string, string>) : {};
  } catch {
    extra = {};
  }
  return {
    id: r.id,
    campaignId: r.campaign_id,
    rowNumber: r.row_number,
    name: r.name,
    phoneRaw: r.phone_raw,
    phoneE164: r.phone_e164,
    designation: r.designation,
    company: r.company,
    context: r.context,
    extra,
    consent: r.consent,
    optOut: r.opt_out === 1,
    status: r.status,
    skipReason: r.skip_reason,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastAttemptAt: r.last_attempt_at,
    callId: r.call_id,
    lastOutcome: r.last_outcome,
    lastError: r.last_error,
  };
}

function mapCampaign(r: Record<string, any>): Campaign {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    pauseReason: r.pause_reason,
    settings: campaignSettingsSchema.parse(JSON.parse(r.settings)),
    mapping: r.mapping ? (JSON.parse(r.mapping) as ColumnMapping) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    confirmedAt: r.confirmed_at,
    acknowledgements: r.acknowledgements ? (JSON.parse(r.acknowledgements) as StartAcknowledgements) : null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/** Persistent campaign state. Every transition is one small statement, so progress is on disk before the next step begins. */
export class CampaignStore {
  constructor(
    private readonly db: DatabaseType,
    private readonly now: () => Date = () => new Date()
  ) {}

  private iso(): string {
    return this.now().toISOString();
  }

  // ---- campaigns ---------------------------------------------------------------------------------------------

  create(name: string, settings: Partial<CampaignSettings> = {}): Campaign {
    const clean = name.trim();
    if (!clean || clean.length > 120) throw new CampaignError('A campaign needs a name of 1 to 120 characters', 'INVALID_NAME', 400);
    const full = campaignSettingsSchema.parse(settings);
    const id = randomUUID();
    const at = this.iso();
    this.db.prepare('INSERT INTO campaigns (id, name, status, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, clean, 'draft', JSON.stringify(full), at, at);
    return this.get(id)!;
  }

  get(id: string): Campaign | null {
    const r = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Record<string, any> | undefined;
    return r ? mapCampaign(r) : null;
  }

  require(id: string): Campaign {
    const c = this.get(id);
    if (!c) throw new CampaignError('Campaign not found', 'CAMPAIGN_NOT_FOUND', 404);
    return c;
  }

  list(): Array<Campaign & { counts: Counts }> {
    const rows = this.db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 200').all() as Array<Record<string, any>>;
    return rows.map((r) => ({ ...mapCampaign(r), counts: this.counts(r.id) }));
  }

  running(): Campaign | null {
    const r = this.db.prepare("SELECT * FROM campaigns WHERE status = 'running' ORDER BY started_at LIMIT 1").get() as Record<string, any> | undefined;
    return r ? mapCampaign(r) : null;
  }

  updateSettings(id: string, patch: unknown): Campaign {
    const c = this.require(id);
    if (c.status !== 'draft' && c.status !== 'paused') throw new CampaignError(`Settings can only be changed while a campaign is a draft or paused (it is ${c.status})`, 'NOT_EDITABLE');
    const parsed = campaignSettingsPatchSchema.parse(patch);
    // What was confirmed at the start (how consent is established, and how local numbers were read) cannot be loosened afterwards.
    if (c.status !== 'draft') {
      for (const key of ['consentMode', 'defaultCountryCode'] as const) {
        if (key in parsed && JSON.stringify(parsed[key]) !== JSON.stringify(c.settings[key])) {
          throw new CampaignError(`${key === 'consentMode' ? 'The consent mode' : 'The default country code'} cannot be changed after the campaign has started`, 'NOT_EDITABLE');
        }
      }
    }
    const merged = campaignSettingsSchema.parse({ ...c.settings, ...parsed });
    this.db.prepare('UPDATE campaigns SET settings = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), this.iso(), id);
    return this.require(id);
  }

  rename(id: string, name: string): Campaign {
    const c = this.require(id);
    if (c.status !== 'draft') throw new CampaignError('Only a draft can be renamed', 'NOT_EDITABLE');
    if (!name.trim() || name.trim().length > 120) throw new CampaignError('A campaign needs a name of 1 to 120 characters', 'INVALID_NAME', 400);
    this.db.prepare('UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ?').run(name.trim(), this.iso(), id);
    return this.require(id);
  }

  remove(id: string): void {
    const c = this.require(id);
    if (c.status === 'running' || c.status === 'paused') throw new CampaignError('Stop the campaign before deleting it', 'NOT_DELETABLE');
    // Explicit rather than relying on cascading foreign keys, so nothing is ever left behind.
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM campaign_attempts WHERE campaign_id = ?').run(id);
      this.db.prepare('DELETE FROM campaign_contacts WHERE campaign_id = ?').run(id);
      this.db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
    })();
  }

  counts(id: string): Counts {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM campaign_contacts WHERE campaign_id = ? GROUP BY status').all(id) as Array<{ status: ContactStatus; n: number }>;
    const out: Counts = { total: 0, queued: 0, calling: 0, completed: 0, failed: 0, skipped: 0 };
    for (const r of rows) {
      if (STATUSES.includes(r.status)) out[r.status] = r.n;
      out.total += r.n;
    }
    return out;
  }

  // ---- contacts ----------------------------------------------------------------------------------------------

  /** Replace a draft's contacts with the analysed rows. Imports never dial; they only write rows. */
  importContacts(campaignId: string, rows: ImportRow[], mapping: ColumnMapping): Counts {
    const c = this.require(campaignId);
    if (c.status !== 'draft') throw new CampaignError('Contacts can only be imported into a draft campaign', 'NOT_EDITABLE');
    const at = this.iso();
    const insert = this.db.prepare(
      `INSERT INTO campaign_contacts (campaign_id, row_number, name, phone_raw, phone_e164, designation, company, context, extra, consent, opt_out, status, skip_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM campaign_contacts WHERE campaign_id = ?').run(campaignId);
      for (const r of rows) {
        insert.run(campaignId, r.rowNumber, r.name, r.phoneRaw, r.phoneE164, r.designation, r.company, r.context, JSON.stringify(r.extra), r.consent, r.optOut ? 1 : 0, r.status, r.skipReason, at, at);
      }
      this.db.prepare('UPDATE campaigns SET mapping = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(mapping), at, campaignId);
    })();
    return this.counts(campaignId);
  }

  listContacts(campaignId: string, options: { status?: ContactStatus; q?: string; page?: number; pageSize?: number } = {}) {
    const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 25)));
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const where = ['campaign_id = ?'];
    const params: unknown[] = [campaignId];
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.q) {
      where.push(`(name LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR phone_e164 LIKE ? ESCAPE '\\' OR phone_raw LIKE ? ESCAPE '\\')`);
      const like = `%${options.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like, like, like);
    }
    const w = where.join(' AND ');
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM campaign_contacts WHERE ${w}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM campaign_contacts WHERE ${w} ORDER BY row_number LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, any>>;
    return { page, pageSize, total, items: rows.map(mapContact) };
  }

  getContact(id: number): ContactRecord | null {
    const r = this.db.prepare('SELECT * FROM campaign_contacts WHERE id = ?').get(id) as Record<string, any> | undefined;
    return r ? mapContact(r) : null;
  }

  attempts(contactId: number) {
    return (this.db.prepare('SELECT * FROM campaign_attempts WHERE contact_id = ? ORDER BY attempt').all(contactId) as Array<Record<string, any>>).map((a) => ({
      attempt: a.attempt as number,
      callId: a.call_id as string | null,
      startedAt: a.started_at as string,
      endedAt: a.ended_at as string | null,
      outcome: a.outcome as string | null,
      error: a.error as string | null,
    }));
  }

  /** Queued contacts that the rules would refuse right now (for the review screen and before the campaign starts). */
  wouldSkip(campaignId: string): Array<{ id: number; reason: string }> {
    const c = this.require(campaignId);
    const rows = this.db.prepare("SELECT * FROM campaign_contacts WHERE campaign_id = ? AND status = 'queued'").all(campaignId) as Array<Record<string, any>>;
    const out: Array<{ id: number; reason: string }> = [];
    for (const r of rows) {
      const reason = skipReason({ phoneE164: r.phone_e164, consent: r.consent, optOut: r.opt_out === 1 }, c.settings, r.phone_e164 ? this.isDoNotCall(r.phone_e164) : false);
      if (reason) out.push({ id: r.id, reason });
    }
    return out;
  }

  markSkipped(contactId: number, reason: string): void {
    this.db.prepare("UPDATE campaign_contacts SET status = 'skipped', skip_reason = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(reason, this.iso(), contactId);
  }

  /** The next queued contact that is due, in file order; retries come after first attempts. */
  nextDue(campaignId: string): ContactRecord | null {
    const r = this.db
      .prepare(
        `SELECT * FROM campaign_contacts WHERE campaign_id = ? AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY (next_attempt_at IS NOT NULL), row_number LIMIT 1`
      )
      .get(campaignId, this.iso()) as Record<string, any> | undefined;
    return r ? mapContact(r) : null;
  }

  /** When the earliest retry becomes due, or null when nothing is waiting for one. */
  nextRetryAt(campaignId: string): string | null {
    const r = this.db.prepare("SELECT MIN(next_attempt_at) AS at FROM campaign_contacts WHERE campaign_id = ? AND status = 'queued' AND next_attempt_at IS NOT NULL").get(campaignId) as { at: string | null };
    return r.at;
  }

  /**
   * Take the contact for a call. The UPDATE only succeeds while the row is still queued, so two callers (or a restart in the
   * middle) can never both dial the same contact: whoever changes the row owns the attempt.
   */
  claim(contactId: number): { attempt: number } | null {
    const at = this.iso();
    const tx = this.db.transaction((): { attempt: number } | null => {
      const res = this.db.prepare("UPDATE campaign_contacts SET status = 'calling', attempts = attempts + 1, last_attempt_at = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'").run(at, at, contactId);
      if (res.changes !== 1) return null;
      const row = this.db.prepare('SELECT attempts, campaign_id, phone_e164 FROM campaign_contacts WHERE id = ?').get(contactId) as { attempts: number; campaign_id: string; phone_e164: string };
      this.db.prepare('INSERT INTO campaign_attempts (campaign_id, contact_id, phone_e164, attempt, started_at) VALUES (?, ?, ?, ?, ?)').run(row.campaign_id, contactId, row.phone_e164, row.attempts, at);
      return { attempt: row.attempts };
    });
    return tx();
  }

  /** The call was not placed after all (the gateway was busy): give the attempt back. */
  release(contactId: number): void {
    const at = this.iso();
    this.db.transaction(() => {
      this.db.prepare("UPDATE campaign_contacts SET status = 'queued', attempts = MAX(0, attempts - 1), updated_at = ? WHERE id = ? AND status = 'calling'").run(at, contactId);
      this.db.prepare('DELETE FROM campaign_attempts WHERE id = (SELECT MAX(id) FROM campaign_attempts WHERE contact_id = ?) AND call_id IS NULL AND ended_at IS NULL').run(contactId);
    })();
  }

  setCallId(contactId: number, callId: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE campaign_contacts SET call_id = ?, updated_at = ? WHERE id = ?').run(callId, this.iso(), contactId);
      this.db.prepare('UPDATE campaign_attempts SET call_id = ? WHERE id = (SELECT MAX(id) FROM campaign_attempts WHERE contact_id = ?)').run(callId, contactId);
    })();
  }

  /** Record how the attempt ended and move the contact on: completed, failed for good, or queued again for a later retry. */
  finishAttempt(contactId: number, result: { outcome: string | null; error?: string | null; next: 'completed' | 'failed' | { retryAt: string } }): void {
    const at = this.iso();
    const error = result.error ? result.error.slice(0, 300) : null;
    this.db.transaction(() => {
      this.db.prepare('UPDATE campaign_attempts SET ended_at = ?, outcome = ?, error = ? WHERE id = (SELECT MAX(id) FROM campaign_attempts WHERE contact_id = ?)').run(at, result.outcome ?? 'unknown', error, contactId);
      if (typeof result.next === 'string') {
        this.db.prepare('UPDATE campaign_contacts SET status = ?, last_outcome = ?, last_error = ?, updated_at = ? WHERE id = ?').run(result.next, result.outcome ?? 'unknown', error, at, contactId);
      } else {
        this.db.prepare("UPDATE campaign_contacts SET status = 'queued', next_attempt_at = ?, last_outcome = ?, last_error = ?, updated_at = ? WHERE id = ?").run(result.next.retryAt, result.outcome ?? 'unknown', error, at, contactId);
      }
    })();
  }

  /** Another campaign (or this one) called this number recently. Attempts of the contact itself do not count. */
  recentlyCalled(phoneE164: string, hours: number, exceptContactId: number): boolean {
    if (hours <= 0) return false;
    const since = new Date(this.now().getTime() - hours * 3_600_000).toISOString();
    const r = this.db.prepare('SELECT 1 AS hit FROM campaign_attempts WHERE phone_e164 = ? AND contact_id != ? AND started_at >= ? LIMIT 1').get(phoneE164, exceptContactId, since);
    return r !== undefined;
  }

  // ---- campaign state changes --------------------------------------------------------------------------------

  /**
   * draft -> running. Everything is checked BEFORE anything is changed, so a refused start leaves the draft exactly as it was;
   * the skipping of contacts the rules refuse and the change of state then happen together in one transaction.
   */
  start(id: string, acknowledgements?: { realCalls: true; regulations: true; consent: true }): { campaign: Campaign; skipped: number } {
    const c = this.require(id);
    if (c.status !== 'draft') throw new CampaignError(`Only a draft campaign can be started (this one is ${c.status})`, 'BAD_STATE');
    if (this.running()) throw new CampaignError('Another campaign is already running; the modem can only place one call at a time', 'ANOTHER_RUNNING');
    const refused = this.wouldSkip(id);
    const callable = this.counts(id).queued - refused.length;
    if (callable <= 0) {
      throw new CampaignError(
        refused.length > 0
          ? `There are no callable contacts: all ${refused.length} queued contact(s) would be skipped by the rules (for example no consent recorded). Nothing was changed.`
          : 'There are no callable contacts in this campaign. Nothing was changed.',
        'NOTHING_TO_CALL',
        400
      );
    }
    const at = this.iso();
    const record: StartAcknowledgements | null = acknowledgements ? { ...acknowledgements, consentMode: c.settings.consentMode, willCall: callable, at } : null;
    this.db.transaction(() => {
      for (const r of refused) this.markSkipped(r.id, r.reason);
      this.db
        .prepare("UPDATE campaigns SET status = 'running', pause_reason = NULL, confirmed_at = ?, acknowledgements = ?, started_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'")
        .run(at, record ? JSON.stringify(record) : null, at, at, id);
    })();
    return { campaign: this.require(id), skipped: refused.length };
  }

  pause(id: string, reason: string | null = null): Campaign {
    const c = this.require(id);
    if (c.status !== 'running') throw new CampaignError(`Only a running campaign can be paused (this one is ${c.status})`, 'BAD_STATE');
    this.db.prepare("UPDATE campaigns SET status = 'paused', pause_reason = ?, updated_at = ? WHERE id = ?").run(reason, this.iso(), id);
    return this.require(id);
  }

  resume(id: string): Campaign {
    const c = this.require(id);
    if (c.status !== 'paused') throw new CampaignError(`Only a paused campaign can be resumed (this one is ${c.status})`, 'BAD_STATE');
    if (this.running()) throw new CampaignError('Another campaign is already running', 'ANOTHER_RUNNING');
    this.db.prepare("UPDATE campaigns SET status = 'running', pause_reason = NULL, updated_at = ? WHERE id = ?").run(this.iso(), id);
    return this.require(id);
  }

  /** Stop for good. Contacts still waiting are marked skipped; a call already in progress is left to finish. */
  stop(id: string): Campaign {
    const c = this.require(id);
    if (c.status !== 'running' && c.status !== 'paused') throw new CampaignError(`Only a running or paused campaign can be stopped (this one is ${c.status})`, 'BAD_STATE');
    const at = this.iso();
    this.db.transaction(() => {
      this.db.prepare("UPDATE campaign_contacts SET status = 'skipped', skip_reason = 'campaign stopped', updated_at = ? WHERE campaign_id = ? AND status = 'queued'").run(at, id);
      this.db.prepare("UPDATE campaigns SET status = 'stopped', finished_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
    })();
    return this.require(id);
  }

  complete(id: string): void {
    const at = this.iso();
    this.db.prepare("UPDATE campaigns SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(at, at, id);
  }

  // ---- do-not-call -------------------------------------------------------------------------------------------

  isDoNotCall(phoneE164: string): boolean {
    return this.db.prepare('SELECT 1 FROM do_not_call WHERE phone_e164 = ?').get(phoneE164) !== undefined;
  }

  /** Opt a number out everywhere: it is remembered for future campaigns and skipped in every campaign that still has it queued. */
  addDoNotCall(phoneE164: string, reason: string | null, source = 'operator'): { skippedContacts: number } {
    const at = this.iso();
    let skipped = 0;
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO do_not_call (phone_e164, reason, source, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(phone_e164) DO UPDATE SET reason = excluded.reason, source = excluded.source').run(phoneE164, reason, source, at);
      skipped = this.db.prepare("UPDATE campaign_contacts SET status = 'skipped', skip_reason = 'on the do-not-call list', updated_at = ? WHERE phone_e164 = ? AND status = 'queued'").run(at, phoneE164).changes;
    })();
    return { skippedContacts: skipped };
  }

  removeDoNotCall(phoneE164: string): boolean {
    return this.db.prepare('DELETE FROM do_not_call WHERE phone_e164 = ?').run(phoneE164).changes > 0;
  }

  listDoNotCall(page = 1, pageSize = 50) {
    const size = Math.min(200, Math.max(1, pageSize));
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM do_not_call').get() as { n: number }).n;
    const items = this.db.prepare('SELECT phone_e164 AS phone, reason, source, added_at AS addedAt FROM do_not_call ORDER BY added_at DESC LIMIT ? OFFSET ?').all(size, (Math.max(1, page) - 1) * size);
    return { page, pageSize: size, total, items };
  }

  // ---- restart -----------------------------------------------------------------------------------------------

  /**
   * After a restart: a running campaign is paused (it never resumes dialling on its own), and a contact that was mid-call is
   * settled from what the call log recorded. When the log shows a reliable "nobody answered" (or busy) result the contact
   * follows the campaign's retry rules exactly as if the process had not stopped; an ambiguous or missing result is never
   * dialled again blindly (it is marked failed, with the reason). Nothing is dialled here.
   */
  recover(): { paused: number; settled: number } {
    const at = this.iso();
    let paused = 0;
    let settled = 0;
    this.db.transaction(() => {
      paused = this.db.prepare("UPDATE campaigns SET status = 'paused', pause_reason = 'the gateway restarted: review the campaign, then resume it', updated_at = ? WHERE status = 'running'").run(at).changes;
      const stuck = this.db
        .prepare("SELECT c.id, c.call_id, c.attempts, c.campaign_id FROM campaign_contacts c WHERE c.status = 'calling'")
        .all() as Array<{ id: number; call_id: string | null; attempts: number; campaign_id: string }>;
      for (const s of stuck) {
        const call = s.call_id ? (this.db.prepare('SELECT outcome, termination_reason FROM calls WHERE id = ?').get(s.call_id) as { outcome: string | null; termination_reason: string | null } | undefined) : undefined;
        const campaign = this.get(s.campaign_id);
        let status: 'completed' | 'failed' | 'queued' = 'failed';
        let outcome = 'unknown';
        let error: string | null = 'the gateway restarted during the call; the outcome is unknown, so it is not retried';
        let nextAttemptAt: string | null = null;
        if (call?.outcome) {
          const kind = classifyEnd({ outcome: call.outcome, reason: call.termination_reason });
          outcome = kind;
          error = null;
          if (kind === 'answered') status = 'completed';
          else if (campaign && (kind === 'no_answer' || kind === 'busy') && shouldRetry(kind, s.attempts, campaign.settings)) {
            status = 'queued';
            nextAttemptAt = new Date(this.now().getTime() + campaign.settings.retryDelayMinutes * 60_000).toISOString();
          } else if (kind === 'ended_before_answer') error = 'The call ended before it was answered; it cannot be told apart from a decline, so it is not retried automatically.';
        }
        this.db.prepare('UPDATE campaign_attempts SET ended_at = ?, outcome = ?, error = ? WHERE id = (SELECT MAX(id) FROM campaign_attempts WHERE contact_id = ?) AND ended_at IS NULL').run(at, outcome, error, s.id);
        this.db.prepare('UPDATE campaign_contacts SET status = ?, next_attempt_at = ?, last_outcome = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, nextAttemptAt, outcome, error, at, s.id);
        settled++;
      }
    })();
    return { paused, settled };
  }
}
