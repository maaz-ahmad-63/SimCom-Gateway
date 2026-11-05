import { createHash, randomUUID } from 'node:crypto';
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

/** The longest campaign prompt. Checked here and in the dashboard; a longer one is refused, never cut short. */
export const PROMPT_MAX_CHARS = 10_000;

/**
 * The campaign's own AI configuration: what the agent is told for every call of this campaign, and which model answers. Every save that
 * changes something is a new immutable version; a call records the version it was created with, so editing never alters the past.
 * Version 0 means none has been saved: the campaign keeps behaving exactly as it did before this existed.
 */
export interface CampaignConfig {
  version: number;
  prompt: string;
  promptSha: string;
  promptChars: number;
  /** A model of the Model Hub for this campaign's calls, or null for the gateway's selected model. */
  llmKey: string | null;
  createdAt: string | null;
}

export interface ConfigInput {
  prompt?: unknown;
  llmKey?: unknown;
}

export interface ImportSource {
  csv: string;
  summary: unknown;
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
  config: CampaignConfig;
  /** Which contact list is live (1 for the first import; each replacement after the campaign started adds one). */
  listVersion: number;
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
  /** True for a contact of an earlier list: kept as history, never called again. */
  archived: boolean;
  listVersion: number;
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
    archived: r.archived === 1,
    listVersion: r.list_version ?? 1,
  };
}

/** The campaign row with the configuration version in force. `withPrompt: false` leaves the text out (lists), keeping its length. */
const campaignSelect = (withPrompt: boolean) =>
  `SELECT c.*, ${withPrompt ? 'v.prompt' : "''"} AS cfg_prompt, v.prompt_sha AS cfg_sha, COALESCE(length(v.prompt), 0) AS cfg_chars, v.llm_key AS cfg_llm, v.created_at AS cfg_at
   FROM campaigns c LEFT JOIN campaign_config_versions v ON v.campaign_id = c.id AND v.version = c.config_version`;

const shaOf = (text: string) => createHash('sha256').update(text).digest('hex');

/** The prompt as it will be stored: line endings made uniform, nothing else changed. Too long is an error, never a silent cut. */
export function validatePrompt(value: unknown): string {
  if (typeof value !== 'string') throw new CampaignError('The campaign prompt must be text', 'INVALID_PROMPT', 400);
  const text = value.replace(/\r\n?/g, '\n');
  if (text.includes('\u0000')) throw new CampaignError('The campaign prompt contains a null character, which cannot be saved', 'INVALID_PROMPT', 400);
  if (text.length > PROMPT_MAX_CHARS) {
    throw new CampaignError(`The campaign prompt is ${text.length.toLocaleString('en-US')} characters; the limit is ${PROMPT_MAX_CHARS.toLocaleString('en-US')}. Shorten it: nothing was saved or cut off.`, 'PROMPT_TOO_LONG', 400);
  }
  return text;
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
    config: { version: r.config_version ?? 0, prompt: r.cfg_prompt ?? '', promptSha: r.cfg_sha ?? '', promptChars: r.cfg_chars ?? 0, llmKey: r.cfg_llm ?? null, createdAt: r.cfg_at ?? null },
    listVersion: r.list_version ?? 1,
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
    const r = this.db.prepare(`${campaignSelect(true)} WHERE c.id = ?`).get(id) as Record<string, any> | undefined;
    return r ? mapCampaign(r) : null;
  }

  require(id: string): Campaign {
    const c = this.get(id);
    if (!c) throw new CampaignError('Campaign not found', 'CAMPAIGN_NOT_FOUND', 404);
    return c;
  }

  list(): Array<Campaign & { counts: Counts }> {
    const rows = this.db.prepare(`${campaignSelect(false)} ORDER BY c.created_at DESC LIMIT 200`).all() as Array<Record<string, any>>;
    return rows.map((r) => ({ ...mapCampaign(r), counts: this.counts(r.id) }));
  }

  running(): Campaign | null {
    const r = this.db.prepare(`${campaignSelect(true)} WHERE c.status = 'running' ORDER BY c.started_at LIMIT 1`).get() as Record<string, any> | undefined;
    return r ? mapCampaign(r) : null;
  }

  updateSettings(id: string, patch: unknown): Campaign {
    const c = this.require(id);
    // A finished campaign (stopped or completed) can be edited too: this only changes what FUTURE calls use, and never restarts anything.
    if (c.status === 'running') throw new CampaignError('Pause the campaign before changing its settings (it is running)', 'NOT_EDITABLE');
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
    if (c.status === 'running') throw new CampaignError('Pause the campaign before renaming it (it is running)', 'NOT_EDITABLE');
    if (!name.trim() || name.trim().length > 120) throw new CampaignError('A campaign needs a name of 1 to 120 characters', 'INVALID_NAME', 400);
    this.db.prepare('UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ?').run(name.trim(), this.iso(), id);
    return this.require(id);
  }

  /**
   * Save the campaign's AI configuration. Allowed in EVERY state, including completed, because it only decides what calls placed from
   * now on are told; it never changes the campaign's state, and calls already made or in progress keep the version they were created
   * with. A save that changes nothing creates no version. Returns the campaign with the configuration in force.
   */
  saveConfig(id: string, input: ConfigInput): Campaign {
    const c = this.require(id);
    const prompt = input.prompt === undefined ? c.config.prompt : validatePrompt(input.prompt);
    let llmKey = c.config.llmKey;
    if (input.llmKey !== undefined) {
      if (input.llmKey === null || input.llmKey === '') llmKey = null;
      else if (typeof input.llmKey === 'string' && input.llmKey.trim().length > 0 && input.llmKey.length <= 120) llmKey = input.llmKey.trim();
      else throw new CampaignError('The model must be the key of a model in the Model Hub', 'INVALID_MODEL', 400);
    }
    if (c.config.version > 0 && prompt === c.config.prompt && llmKey === c.config.llmKey) return c;
    if (c.config.version === 0 && prompt === '' && llmKey === null) return c;
    const next = (this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM campaign_config_versions WHERE campaign_id = ?').get(id) as { v: number }).v + 1;
    const at = this.iso();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO campaign_config_versions (campaign_id, version, prompt, prompt_sha, llm_key, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, next, prompt, shaOf(prompt), llmKey, at);
      this.db.prepare('UPDATE campaigns SET config_version = ?, updated_at = ? WHERE id = ?').run(next, at, id);
    })();
    return this.require(id);
  }

  /** The configuration in force, with the prompt text. */
  activeConfig(id: string): CampaignConfig {
    return this.require(id).config;
  }

  /** Every saved version, newest first (the prompt text is left out: its length and fingerprint identify it). */
  configVersions(id: string): Array<{ version: number; promptChars: number; promptSha: string; llmKey: string | null; createdAt: string; active: boolean }> {
    const active = this.require(id).config.version;
    return (this.db.prepare('SELECT version, length(prompt) AS chars, prompt_sha, llm_key, created_at FROM campaign_config_versions WHERE campaign_id = ? ORDER BY version DESC').all(id) as Array<Record<string, any>>).map((r) => ({
      version: r.version,
      promptChars: r.chars,
      promptSha: r.prompt_sha,
      llmKey: r.llm_key,
      createdAt: r.created_at,
      active: r.version === active,
    }));
  }

  /** The configuration this attempt's call was created with (recorded when the call was placed). */
  setAttemptSnapshot(contactId: number, snapshot: { configVersion: number; promptSha: string; llmKey: string | null }): void {
    this.db
      .prepare('UPDATE campaign_attempts SET config_version = ?, prompt_sha = ?, llm_key = ? WHERE id = (SELECT MAX(id) FROM campaign_attempts WHERE contact_id = ?)')
      .run(snapshot.configVersion, snapshot.promptSha, snapshot.llmKey, contactId);
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
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM campaign_contacts WHERE campaign_id = ? AND archived = 0 GROUP BY status').all(id) as Array<{ status: ContactStatus; n: number }>;
    const out: Counts = { total: 0, queued: 0, calling: 0, completed: 0, failed: 0, skipped: 0 };
    for (const r of rows) {
      if (STATUSES.includes(r.status)) out[r.status] = r.n;
      out.total += r.n;
    }
    return out;
  }

  // ---- contacts ----------------------------------------------------------------------------------------------

  /**
   * Store the analysed rows as the campaign's live contact list. Importing never dials; it only writes rows.
   *
   *  - A DRAFT has never called anyone, so its earlier rows are simply replaced.
   *  - A paused, stopped or completed campaign may have history. Its earlier rows are KEPT, marked archived, together with every
   *    attempt, call link and outcome that points at them; contacts of the old list that were still waiting are marked skipped
   *    ("replaced by a newer contact list") so they can never be dialled. The new rows become the live list. The campaign's own
   *    state is not touched: a completed campaign stays completed, nothing is queued to run.
   *  - A running campaign cannot have its list replaced (pause it first): a call may be choosing its next contact.
   */
  importContacts(campaignId: string, rows: ImportRow[], mapping: ColumnMapping, source?: ImportSource): Counts {
    const c = this.require(campaignId);
    if (c.status === 'running') throw new CampaignError('Pause or stop the campaign before replacing its contact list (it is running)', 'NOT_EDITABLE');
    const at = this.iso();
    const draft = c.status === 'draft';
    const listVersion = draft ? c.listVersion : c.listVersion + 1;
    const insert = this.db.prepare(
      `INSERT INTO campaign_contacts (campaign_id, row_number, name, phone_raw, phone_e164, designation, company, context, extra, consent, opt_out, status, skip_reason, created_at, updated_at, list_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      if (draft) {
        this.db.prepare('DELETE FROM campaign_contacts WHERE campaign_id = ? AND archived = 0').run(campaignId);
      } else {
        this.db
          .prepare(
            `UPDATE campaign_contacts SET archived = 1, updated_at = ?,
               skip_reason = CASE WHEN status = 'queued' THEN 'replaced by a newer contact list' ELSE skip_reason END,
               status = CASE WHEN status = 'queued' THEN 'skipped' ELSE status END
             WHERE campaign_id = ? AND archived = 0`
          )
          .run(at, campaignId);
      }
      for (const r of rows) {
        insert.run(campaignId, r.rowNumber, r.name, r.phoneRaw, r.phoneE164, r.designation, r.company, r.context, JSON.stringify(r.extra), r.consent, r.optOut ? 1 : 0, r.status, r.skipReason, at, at, listVersion);
      }
      this.db.prepare('UPDATE campaigns SET mapping = ?, list_version = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(mapping), listVersion, at, campaignId);
      if (source) {
        this.db
          .prepare('INSERT INTO campaign_imports (campaign_id, list_version, csv, mapping, summary, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(campaignId, listVersion, source.csv, JSON.stringify(mapping), JSON.stringify(source.summary ?? null), rows.length, at);
      }
    })();
    return this.counts(campaignId);
  }

  /** The uploads of a campaign, newest first (without the file text). */
  imports(campaignId: string): Array<{ id: number; listVersion: number; rowCount: number; bytes: number; summary: unknown; mapping: unknown; createdAt: string }> {
    return (this.db.prepare('SELECT id, list_version, row_count, length(csv) AS bytes, summary, mapping, created_at FROM campaign_imports WHERE campaign_id = ? ORDER BY id DESC').all(campaignId) as Array<Record<string, any>>).map((r) => ({
      id: r.id,
      listVersion: r.list_version,
      rowCount: r.row_count,
      bytes: r.bytes,
      summary: r.summary ? JSON.parse(r.summary) : null,
      mapping: r.mapping ? JSON.parse(r.mapping) : null,
      createdAt: r.created_at,
    }));
  }

  /** The uploaded file exactly as it arrived, for auditing. */
  importCsv(campaignId: string, importId: number): string | null {
    const r = this.db.prepare('SELECT csv FROM campaign_imports WHERE campaign_id = ? AND id = ?').get(campaignId, importId) as { csv: string } | undefined;
    return r?.csv ?? null;
  }

  /**
   * What the campaign's calls used, from what the providers reported. Tokens are summed per call from the turns of the call and are
   * only counted where the provider gave a number; "cached" is only counted on turns whose provider reported a cache figure at all,
   * so a provider that never reports it shows as not reported, not as zero. Offline mock turns are never counted.
   */
  usage(campaignId: string) {
    const rows = this.db
      .prepare(
        `SELECT a.id AS attempt_id, a.call_id, a.contact_id, a.config_version, a.prompt_sha, a.started_at, c.name AS contact_name,
                COUNT(t.id) AS turns,
                SUM(CASE WHEN t.llm_prompt_tokens IS NOT NULL THEN 1 ELSE 0 END) AS usage_turns,
                COALESCE(SUM(t.llm_prompt_tokens), 0) AS input_tokens,
                COALESCE(SUM(t.llm_completion_tokens), 0) AS output_tokens,
                SUM(CASE WHEN t.llm_cached_tokens IS NOT NULL THEN 1 ELSE 0 END) AS cache_turns,
                COALESCE(SUM(t.llm_cached_tokens), 0) AS cached_tokens,
                COALESCE(SUM(CASE WHEN t.llm_cached_tokens IS NOT NULL THEN t.llm_prompt_tokens END), 0) AS input_on_cache_turns,
                COALESCE(SUM(t.llm_cache_write_tokens), 0) AS cache_write_tokens,
                MAX(t.llm_key) AS llm_key
         FROM campaign_attempts a
         JOIN campaign_contacts c ON c.id = a.contact_id
         LEFT JOIN ai_turns t ON t.call_id = a.call_id AND t.mock = 0
         WHERE a.campaign_id = ? AND a.call_id IS NOT NULL
         GROUP BY a.id ORDER BY a.started_at, a.id`
      )
      .all(campaignId) as Array<Record<string, any>>;
    const calls = rows.map((r) => ({
      callId: r.call_id as string,
      contactId: r.contact_id as number,
      contactName: r.contact_name as string,
      attemptStartedAt: r.started_at as string,
      configVersion: (r.config_version ?? null) as number | null,
      llm: (r.llm_key ?? null) as string | null,
      turns: r.turns as number,
      turnsWithUsage: r.usage_turns as number,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      cachedInputTokens: (r.cache_turns > 0 ? r.cached_tokens : null) as number | null,
      cacheWriteTokens: (r.cache_turns > 0 ? r.cache_write_tokens : null) as number | null,
      turnsReportingCache: r.cache_turns as number,
    }));
    const sum = (f: (r: Record<string, any>) => number) => rows.reduce((n, r) => n + f(r), 0);
    const cacheTurns = sum((r) => r.cache_turns);
    const inputOnCacheTurns = sum((r) => r.input_on_cache_turns);
    const cached = sum((r) => r.cached_tokens);
    return {
      totals: {
        calls: rows.length,
        turns: sum((r) => r.turns),
        turnsWithUsage: sum((r) => r.usage_turns),
        inputTokens: sum((r) => r.input_tokens),
        outputTokens: sum((r) => r.output_tokens),
        /** null when no turn reported a cache figure. */
        cachedInputTokens: cacheTurns > 0 ? cached : null,
        cacheWriteTokens: cacheTurns > 0 ? sum((r) => r.cache_write_tokens) : null,
        turnsReportingCache: cacheTurns,
        /** Of the input tokens on the turns that did report a cache figure: how many were not served from the cache. */
        uncachedInputTokens: cacheTurns > 0 ? inputOnCacheTurns - cached : null,
        inputTokensOnTurnsReportingCache: cacheTurns > 0 ? inputOnCacheTurns : null,
      },
      calls,
    };
  }

  listContacts(campaignId: string, options: { status?: ContactStatus; q?: string; page?: number; pageSize?: number; includeArchived?: boolean } = {}) {
    const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 25)));
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const where = ['campaign_id = ?'];
    const params: unknown[] = [campaignId];
    if (!options.includeArchived) where.push('archived = 0');
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
    const rows = this.db.prepare("SELECT * FROM campaign_contacts WHERE campaign_id = ? AND archived = 0 AND status = 'queued'").all(campaignId) as Array<Record<string, any>>;
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
        `SELECT * FROM campaign_contacts WHERE campaign_id = ? AND archived = 0 AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY (next_attempt_at IS NOT NULL), row_number LIMIT 1`
      )
      .get(campaignId, this.iso()) as Record<string, any> | undefined;
    return r ? mapContact(r) : null;
  }

  /** When the earliest retry becomes due, or null when nothing is waiting for one. */
  nextRetryAt(campaignId: string): string | null {
    const r = this.db.prepare("SELECT MIN(next_attempt_at) AS at FROM campaign_contacts WHERE campaign_id = ? AND archived = 0 AND status = 'queued' AND next_attempt_at IS NOT NULL").get(campaignId) as { at: string | null };
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

  /**
   * Run a finished (completed or stopped) campaign again on its current contact list, for example after a new CSV was uploaded. Only
   * contacts still queued are called; every earlier attempt, call and result is left as it was.
   */
  restart(id: string, acknowledgements?: { realCalls: true; regulations: true; consent: true }): { campaign: Campaign; skipped: number } {
    const c = this.require(id);
    if (c.status !== 'completed' && c.status !== 'stopped') throw new CampaignError(`Only a completed or stopped campaign can be run again (this one is ${c.status})`, 'BAD_STATE');
    if (this.running()) throw new CampaignError('Another campaign is already running; the modem can only place one call at a time', 'ANOTHER_RUNNING');
    const refused = this.wouldSkip(id);
    const callable = this.counts(id).queued - refused.length;
    if (callable <= 0) {
      throw new CampaignError('There are no contacts waiting to be called. Upload a new contact list first. Nothing was changed.', 'NOTHING_TO_CALL', 400);
    }
    const at = this.iso();
    const record: StartAcknowledgements | null = acknowledgements ? { ...acknowledgements, consentMode: c.settings.consentMode, willCall: callable, at } : null;
    this.db.transaction(() => {
      for (const r of refused) this.markSkipped(r.id, r.reason);
      this.db
        .prepare("UPDATE campaigns SET status = 'running', pause_reason = NULL, finished_at = NULL, confirmed_at = ?, acknowledgements = ?, updated_at = ? WHERE id = ? AND status IN ('completed', 'stopped')")
        .run(at, record ? JSON.stringify(record) : null, at, id);
    })();
    return { campaign: this.require(id), skipped: refused.length };
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
