import { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { analyzeRows, validateMapping } from '../../campaigns/import.js';
import { ColumnMapping, CSV_LIMITS, parseCsv } from '../../campaigns/csv.js';
import { detectColumns } from '../../campaigns/detect.js';
import { normalizePhone } from '../../campaigns/phone.js';
import { CallAnalysisStore, FILTERS, INTERESTS, OUTCOMES } from '../../campaigns/call-analysis.js';
import { callsCsv, CallAnalysisService, CampaignCallRecords, SORTS } from '../../campaigns/call-records.js';
import { campaignSettingsPatchSchema, withinCallingHours } from '../../campaigns/policy.js';
import { CampaignRunner } from '../../campaigns/runner.js';
import { CampaignError, CampaignStore, ContactStatus, validatePrompt } from '../../campaigns/store.js';

export interface CampaignRouteDependencies {
  store: CampaignStore;
  runner: CampaignRunner;
  /** Why the AI cannot take outbound calls right now (empty when it can). */
  blockers: () => string[];
  /** The Model Hub's language models: why a campaign cannot use one right now, and the choices with their caching facts. Absent: no choice is offered. */
  llm?: { problem: (llmKey: string | null) => string | null; choices: () => unknown[] };
  /** The campaign call records (table, detail, analytics, export) and the post-call analysis behind them. Absent: those routes answer 503. */
  calls?: { records: CampaignCallRecords; analysis: CallAnalysisService; store: CallAnalysisStore };
  now?: () => Date;
}

const mappingSchema = z.object({
  phone: z.string().min(1),
  name: z.string().optional(),
  designation: z.string().optional(),
  company: z.string().optional(),
  context: z.string().optional(),
  consent: z.string().optional(),
  optOut: z.string().optional(),
  /** Optional. Absent: every column that is not a mapped field is kept as a custom field. Present: only these. */
  extra: z.array(z.string()).max(40).optional(),
});

const startSchema = z.object({
  confirm: z.literal(true),
  /** The operator types the campaign's name: a deliberate act, not a stray click. */
  confirmName: z.string(),
  acknowledgements: z.object({
    realCalls: z.literal(true),
    regulations: z.literal(true),
    consent: z.literal(true),
  }),
});

const callQuerySchema = z.object({
  search: z.string().max(200).optional(),
  filter: z.enum(FILTERS).optional(),
  sort: z.enum(SORTS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
const classificationSchema = z.object({
  outcome: z.enum(OUTCOMES).nullable().optional(),
  interest: z.enum(INTERESTS).nullable().optional(),
  summary: z.string().trim().max(700).nullable().optional(),
  nextAction: z.string().trim().max(300).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});
const statusSchema = z.enum(['queued', 'calling', 'completed', 'failed', 'skipped']);
const pageSchema = z.object({ page: z.coerce.number().int().min(1).max(100000).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional() });

/**
 * Campaign API, mounted under /api so the gateway API-key middleware covers it. Uploading, previewing and importing a CSV only
 * parse and store rows: they never place a call. A call can only start after POST /:id/start with the explicit confirmation.
 */
export function createCampaignsRouter({ store, runner, blockers, llm, calls, now = () => new Date() }: CampaignRouteDependencies): Router {
  const router = Router();
  const handle =
    (fn: (req: Request, res: Response) => unknown): RequestHandler =>
    (req, res, next) => {
      try {
        const out = fn(req, res);
        if (out !== undefined) res.json(out);
      } catch (error) {
        if (error instanceof z.ZodError) {
          res.status(400).json({ success: false, error: error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '), code: 'INVALID_REQUEST' });
          return;
        }
        if (error instanceof CampaignError) {
          res.status(error.status).json({ success: false, error: error.message, code: error.code });
          return;
        }
        next(error);
      }
    };

  /** Like handle, for a route that waits (the analysis request). */
  const handleAsync =
    (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
    (req, res, next) => {
      void Promise.resolve()
        .then(() => fn(req, res))
        .then((out) => {
          if (out !== undefined) res.json(out);
        })
        .catch((error) => {
          if (error instanceof z.ZodError) res.status(400).json({ success: false, error: error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '), code: 'INVALID_REQUEST' });
          else if (error instanceof CampaignError) res.status(error.status).json({ success: false, error: error.message, code: error.code });
          else next(error);
        });
    };

  const detail = (id: string) => {
    const campaign = store.require(id);
    return {
      campaign,
      counts: store.counts(id),
      runner: store.running()?.id === id ? runner.status() : null,
    };
  };

  router.get('/', handle(() => ({ success: true, campaigns: store.list() })));

  router.post('/', handle((req, res) => {
    const body = z.object({ name: z.string(), settings: campaignSettingsPatchSchema.optional() }).parse(req.body);
    const campaign = store.create(body.name, body.settings ?? {});
    res.status(201);
    return { success: true, campaign, counts: store.counts(campaign.id) };
  }));

  router.get('/readiness', handle(() => ({ success: true, blockers: blockers(), runner: runner.status() })));

  /** The language models a campaign can choose, whether each can be used now, and what is known about its prompt caching. */
  router.get('/llm-options', handle(() => ({ success: true, models: llm?.choices() ?? [] })));

  // ---- do-not-call --------------------------------------------------------------------------------------------
  router.get('/do-not-call', handle((req) => ({ success: true, ...store.listDoNotCall(pageSchema.parse(req.query).page, pageSchema.parse(req.query).pageSize) })));

  router.post('/do-not-call', handle((req, res) => {
    const body = z.object({ phone: z.string(), reason: z.string().max(200).optional(), defaultCountryCode: z.string().regex(/^\d{1,3}$/).optional() }).parse(req.body);
    const phone = normalizePhone(body.phone, body.defaultCountryCode);
    if (!phone.ok) throw new CampaignError(phone.reason, 'INVALID_PHONE', 400);
    const result = store.addDoNotCall(phone.e164, body.reason ?? null);
    res.status(201);
    return { success: true, phone: phone.e164, ...result };
  }));

  router.delete('/do-not-call/:phone', handle((req) => {
    const phone = normalizePhone(decodeURIComponent(req.params.phone), null);
    if (!phone.ok) throw new CampaignError(phone.reason, 'INVALID_PHONE', 400);
    return { success: true, removed: store.removeDoNotCall(phone.e164) };
  }));

  // ---- CSV preview: parse only, nothing is stored ---------------------------------------------------------------
  /**
   * Read a file and say what is in it, storing nothing. `detection` says which columns look like the contact name and phone, and
   * whether the person must choose (`ambiguous`). Given a `mapping` (the detected one, or the person's), `analysis` previews what an
   * import would do: how many contacts are valid, invalid or duplicates, which other columns are kept as custom fields, and the first
   * contacts as they would be saved. `campaignId` borrows that campaign's country code and consent rule.
   */
  router.post('/preview-csv', handle((req) => {
    const body = z.object({ csv: z.string().max(CSV_LIMITS.maxChars + 10), mapping: mappingSchema.optional(), campaignId: z.string().optional(), defaultCountryCode: z.string().regex(/^\d{1,3}$/).nullable().optional() }).parse(req.body);
    const parsed = parseCsv(body.csv);
    if (parsed.fatal) throw new CampaignError(parsed.fatal, 'INVALID_CSV', 400);
    const detection = detectColumns(parsed.headers, parsed.rows);
    const base = {
      success: true,
      delimiter: parsed.delimiter,
      headers: parsed.headers,
      totalRows: parsed.rows.length,
      sample: parsed.rows.slice(0, 10),
      warnings: parsed.warnings,
      suggestedMapping: detection.mapping,
      detection: { name: detection.name, phone: detection.phone },
      ambiguous: detection.ambiguous,
    };
    if (!body.mapping) return base;
    const mapping = body.mapping as ColumnMapping;
    const errors = validateMapping(parsed.headers, mapping);
    if (errors.length > 0) return { ...base, mappingErrors: errors };
    const campaign = body.campaignId ? store.require(body.campaignId) : null;
    const settings = { defaultCountryCode: campaign ? campaign.settings.defaultCountryCode : (body.defaultCountryCode ?? null), consentMode: campaign ? campaign.settings.consentMode : ('column' as const) };
    const analysis = analyzeRows(parsed, mapping, settings, (e164) => store.isDoNotCall(e164));
    return {
      ...base,
      analysis: {
        summary: analysis.summary,
        customColumns: analysis.customColumns,
        problems: analysis.problems.slice(0, 50),
        contacts: analysis.rows.slice(0, 10).map((r) => ({ rowNumber: r.rowNumber, name: r.name, phoneRaw: r.phoneRaw, phoneE164: r.phoneE164, status: r.status, skipReason: r.skipReason, customFields: r.extra })),
      },
    };
  }));

  // ---- one campaign -----------------------------------------------------------------------------------------------
  router.get('/:id', handle((req) => ({ success: true, ...detail(req.params.id) })));

  /**
   * Edit a campaign in ANY state, a completed one included. The prompt (at most 10,000 characters, refused rather than cut) and the
   * model are validated before anything is saved; a save that is refused changes nothing. Editing never starts, resumes or stops a
   * campaign, and only calls placed afterwards use the new configuration.
   */
  router.patch('/:id', handle((req) => {
    const body = z
      .object({ name: z.string().optional(), settings: campaignSettingsPatchSchema.optional(), config: z.object({ prompt: z.string().optional(), llmKey: z.string().max(120).nullable().optional() }).strict().optional() })
      .strict()
      .parse(req.body);
    const campaign = store.require(req.params.id);
    if ((body.name !== undefined || body.settings) && campaign.status === 'running') throw new CampaignError('Pause the campaign before changing its name or settings (it is running)', 'NOT_EDITABLE');
    if (body.config?.prompt !== undefined) validatePrompt(body.config.prompt);
    if (body.config?.llmKey) {
      const problem = llm ? llm.problem(body.config.llmKey) : `The model '${body.config.llmKey}' is not available on this gateway`;
      if (problem) throw new CampaignError(problem, 'INVALID_MODEL', 400);
    }
    if (body.settings) store.updateSettings(req.params.id, body.settings);
    if (body.name !== undefined) store.rename(req.params.id, body.name);
    if (body.config) store.saveConfig(req.params.id, body.config);
    return { success: true, ...detail(req.params.id) };
  }));

  router.get('/:id/config/versions', handle((req) => ({ success: true, versions: store.configVersions(req.params.id) })));

  router.delete('/:id', handle((req) => {
    store.remove(req.params.id);
    return { success: true };
  }));

  /**
   * Validate the file against a column mapping and store the result as this draft's contacts (replacing any earlier import).
   * Rows that can never be called are stored too, marked skipped with the reason, so the operator sees exactly what happened.
   */
  router.post('/:id/import', handle((req) => {
    const body = z.object({ csv: z.string().max(CSV_LIMITS.maxChars + 10), mapping: mappingSchema }).parse(req.body);
    const campaign = store.require(req.params.id);
    const parsed = parseCsv(body.csv);
    if (parsed.fatal) throw new CampaignError(parsed.fatal, 'INVALID_CSV', 400);
    const mapping = body.mapping as ColumnMapping;
    const errors = validateMapping(parsed.headers, mapping);
    if (errors.length > 0) throw new CampaignError(errors.join('; '), 'INVALID_MAPPING', 400);
    const analysis = analyzeRows(parsed, mapping, campaign.settings, (e164) => store.isDoNotCall(e164));
    const counts = store.importContacts(campaign.id, analysis.rows, mapping, { csv: body.csv, summary: analysis.summary });
    const after = store.require(campaign.id);
    return {
      success: true,
      counts,
      summary: analysis.summary,
      customColumns: analysis.customColumns,
      problems: analysis.problems,
      warnings: parsed.warnings,
      // After the campaign started, the earlier list is kept as history and this one becomes the live list (the campaign's state is unchanged).
      replacedEarlierList: campaign.status !== 'draft',
      listVersion: after.listVersion,
      status: after.status,
    };
  }));

  router.get('/:id/imports', handle((req) => {
    store.require(req.params.id);
    return { success: true, imports: store.imports(req.params.id) };
  }));

  /** The uploaded file exactly as it arrived, for auditing. */
  router.get('/:id/imports/:importId/csv', (req, res, next) => {
    try {
      const csv = store.importCsv(req.params.id, Number(req.params.importId));
      if (csv === null) {
        res.status(404).json({ success: false, error: 'Import not found', code: 'IMPORT_NOT_FOUND' });
        return;
      }
      res.type('text/csv; charset=utf-8').set('Cache-Control', 'private, no-store').send(csv);
    } catch (error) {
      next(error);
    }
  });

  /** What this campaign's calls used, as the providers reported it (see CampaignStore.usage). */
  router.get('/:id/usage', handle((req) => {
    store.require(req.params.id);
    return { success: true, ...store.usage(req.params.id) };
  }));

  // ---- call records: the table, one call, the counts, the export and the analysis, all from the same saved records -------------------
  const needCalls = () => {
    if (!calls) throw new CampaignError('Call records are not available on this gateway', 'NOT_AVAILABLE', 503);
    return calls;
  };
  const attemptIdOf = (req: Request) => {
    const n = Number(req.params.attemptId);
    if (!Number.isInteger(n) || n < 1) throw new CampaignError('Call record not found', 'CALL_NOT_FOUND', 404);
    return n;
  };

  router.get('/:id/calls', handle((req) => {
    store.require(req.params.id);
    return { success: true, ...needCalls().records.list(req.params.id, callQuerySchema.parse(req.query)) };
  }));

  router.get('/:id/calls/export.csv', handle((req, res) => {
    const campaign = store.require(req.params.id);
    const csv = callsCsv(needCalls().records.all(req.params.id, callQuerySchema.parse(req.query)));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-${campaign.id.slice(0, 8)}-calls.csv"`);
    res.send(csv);
    return undefined;
  }));

  router.get('/:id/calls/:attemptId', handle((req) => {
    store.require(req.params.id);
    const found = needCalls().records.detail(req.params.id, attemptIdOf(req));
    if (!found) throw new CampaignError('Call record not found in this campaign', 'CALL_NOT_FOUND', 404);
    return { success: true, call: found };
  }));

  router.post('/:id/calls/:attemptId/analyze', handleAsync(async (req) => {
    store.require(req.params.id);
    const c = needCalls();
    const attempt = attemptIdOf(req);
    if (!c.records.detail(req.params.id, attempt)) throw new CampaignError('Call record not found in this campaign', 'CALL_NOT_FOUND', 404);
    if (!c.analysis.available) throw new CampaignError('No language model is available for analysis', 'NOT_AVAILABLE', 503);
    const result = await c.analysis.analyze(req.params.id, attempt, { force: true });
    return { success: true, result, call: c.records.detail(req.params.id, attempt) };
  }));

  router.put('/:id/calls/:attemptId/classification', handle((req) => {
    store.require(req.params.id);
    const c = needCalls();
    const attempt = attemptIdOf(req);
    if (!c.records.detail(req.params.id, attempt)) throw new CampaignError('Call record not found in this campaign', 'CALL_NOT_FOUND', 404);
    const body = classificationSchema.parse(req.body);
    const blank = (v: string | null | undefined) => (v === undefined || v === null || v === '' ? null : v);
    const next = { outcome: body.outcome ?? null, interest: body.interest ?? null, summary: blank(body.summary), nextAction: blank(body.nextAction), note: blank(body.note) };
    if (Object.values(next).every((v) => v === null)) throw new CampaignError('Nothing to correct: give an outcome, interest, summary, next action or note', 'INVALID_REQUEST', 400);
    c.store.setOverride(attempt, req.params.id, next);
    return { success: true, call: c.records.detail(req.params.id, attempt) };
  }));

  /** Remove a correction: the original AI (or rule) result shows again. The AI result itself was never changed. */
  router.delete('/:id/calls/:attemptId/classification', handle((req) => {
    store.require(req.params.id);
    const c = needCalls();
    const attempt = attemptIdOf(req);
    if (!c.records.detail(req.params.id, attempt)) throw new CampaignError('Call record not found in this campaign', 'CALL_NOT_FOUND', 404);
    return { success: true, removed: c.store.clearOverride(attempt), call: c.records.detail(req.params.id, attempt) };
  }));

  router.get('/:id/analytics', handle((req) => {
    store.require(req.params.id);
    return { success: true, ...needCalls().records.analytics(req.params.id) };
  }));

  router.get('/:id/contacts', handle((req) => {
    store.require(req.params.id);
    const q = z.object({ status: statusSchema.optional(), q: z.string().max(80).optional(), includeArchived: z.enum(['1', 'true']).optional() }).parse(req.query);
    return { success: true, ...store.listContacts(req.params.id, { status: q.status as ContactStatus | undefined, q: q.q, includeArchived: q.includeArchived !== undefined, ...pageSchema.parse(req.query) }) };
  }));

  router.get('/:id/contacts/:contactId', handle((req, res) => {
    const contact = store.getContact(Number(req.params.contactId));
    if (!contact || contact.campaignId !== req.params.id) {
      res.status(404).json({ success: false, error: 'Contact not found', code: 'CONTACT_NOT_FOUND' });
      return undefined;
    }
    return { success: true, contact, attempts: store.attempts(contact.id) };
  }));

  router.post('/:id/contacts/:contactId/opt-out', handle((req, res) => {
    const contact = store.getContact(Number(req.params.contactId));
    if (!contact || contact.campaignId !== req.params.id || !contact.phoneE164) {
      res.status(404).json({ success: false, error: 'Contact not found', code: 'CONTACT_NOT_FOUND' });
      return undefined;
    }
    const result = store.addDoNotCall(contact.phoneE164, 'opted out during campaign', 'campaign');
    return { success: true, ...result };
  }));

  /** Everything the operator should read before starting: what will be called, what will not and why, and what is blocking. */
  router.get('/:id/review', handle((req) => {
    const campaign = store.require(req.params.id);
    const counts = store.counts(campaign.id);
    const refused = store.wouldSkip(campaign.id);
    const byReason: Record<string, number> = {};
    for (const r of refused) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
    const skippedAlready = store.listContacts(campaign.id, { status: 'skipped', pageSize: 100 }).items;
    for (const c of skippedAlready) byReason[c.skipReason ?? 'skipped'] = (byReason[c.skipReason ?? 'skipped'] ?? 0) + 1;
    return {
      success: true,
      campaign,
      counts,
      willCall: counts.queued - refused.length,
      willSkipAtStart: refused.length,
      skipReasons: byReason,
      blockers: blockers(),
      insideCallingHoursNow: withinCallingHours(now(), campaign.settings.callingHours),
      anotherRunning: (() => {
        const r = store.running();
        return r && r.id !== campaign.id ? { id: r.id, name: r.name } : null;
      })(),
    };
  }));

  router.post('/:id/start', handle((req) => {
    const campaign = store.require(req.params.id);
    const body = startSchema.parse(req.body);
    if (body.confirmName.trim() !== campaign.name) throw new CampaignError('Type the campaign name exactly to confirm', 'CONFIRMATION_MISMATCH', 400);
    const b = blockers();
    if (b.length > 0) throw new CampaignError(`The AI agent cannot take outbound calls yet: ${b.join('; ')}`, 'AI_NOT_READY');
    const modelProblem = llm?.problem(campaign.config.llmKey) ?? null;
    if (modelProblem) throw new CampaignError(`This campaign's model cannot be used: ${modelProblem}`, 'MODEL_UNAVAILABLE');
    const started = store.start(campaign.id, body.acknowledgements);
    return { success: true, skippedAtStart: started.skipped, ...detail(campaign.id) };
  }));

  /** Run a completed or stopped campaign again on its current contact list, with the same confirmation as a first start. */
  router.post('/:id/restart', handle((req) => {
    const campaign = store.require(req.params.id);
    const body = startSchema.parse(req.body);
    if (body.confirmName.trim() !== campaign.name) throw new CampaignError('Type the campaign name exactly to confirm', 'CONFIRMATION_MISMATCH', 400);
    const b = blockers();
    if (b.length > 0) throw new CampaignError(`The AI agent cannot take outbound calls yet: ${b.join('; ')}`, 'AI_NOT_READY');
    const modelProblem = llm ? llm.problem(campaign.config.llmKey) : null;
    if (modelProblem) throw new CampaignError(`This campaign's model cannot be used: ${modelProblem}`, 'MODEL_UNAVAILABLE');
    const started = store.restart(campaign.id, body.acknowledgements);
    return { success: true, skippedAtStart: started.skipped, ...detail(campaign.id) };
  }));

  router.post('/:id/pause', handle((req) => {
    store.pause(req.params.id, 'paused by the operator');
    return { success: true, ...detail(req.params.id) };
  }));

  router.post('/:id/resume', handle((req) => {
    const b = blockers();
    if (b.length > 0) throw new CampaignError(`The AI agent cannot take outbound calls yet: ${b.join('; ')}`, 'AI_NOT_READY');
    const modelProblem = llm?.problem(store.require(req.params.id).config.llmKey) ?? null;
    if (modelProblem) throw new CampaignError(`This campaign's model cannot be used: ${modelProblem}`, 'MODEL_UNAVAILABLE');
    store.resume(req.params.id);
    return { success: true, ...detail(req.params.id) };
  }));

  router.post('/:id/stop', handle((req) => {
    store.stop(req.params.id);
    return { success: true, ...detail(req.params.id) };
  }));

  return router;
}
