import { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { analyzeRows, validateMapping } from '../../campaigns/import.js';
import { ColumnMapping, CSV_LIMITS, parseCsv, suggestMapping } from '../../campaigns/csv.js';
import { normalizePhone } from '../../campaigns/phone.js';
import { campaignSettingsPatchSchema, withinCallingHours } from '../../campaigns/policy.js';
import { CampaignRunner } from '../../campaigns/runner.js';
import { CampaignError, CampaignStore, ContactStatus } from '../../campaigns/store.js';

export interface CampaignRouteDependencies {
  store: CampaignStore;
  runner: CampaignRunner;
  /** Why the AI cannot take outbound calls right now (empty when it can). */
  blockers: () => string[];
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
  extra: z.array(z.string()).max(8).optional(),
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

const statusSchema = z.enum(['queued', 'calling', 'completed', 'failed', 'skipped']);
const pageSchema = z.object({ page: z.coerce.number().int().min(1).max(100000).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional() });

/**
 * Campaign API, mounted under /api so the gateway API-key middleware covers it. Uploading, previewing and importing a CSV only
 * parse and store rows: they never place a call. A call can only start after POST /:id/start with the explicit confirmation.
 */
export function createCampaignsRouter({ store, runner, blockers, now = () => new Date() }: CampaignRouteDependencies): Router {
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
  router.post('/preview-csv', handle((req) => {
    const body = z.object({ csv: z.string().max(CSV_LIMITS.maxChars + 10) }).parse(req.body);
    const parsed = parseCsv(body.csv);
    if (parsed.fatal) throw new CampaignError(parsed.fatal, 'INVALID_CSV', 400);
    return { success: true, delimiter: parsed.delimiter, headers: parsed.headers, totalRows: parsed.rows.length, sample: parsed.rows.slice(0, 10), warnings: parsed.warnings, suggestedMapping: suggestMapping(parsed.headers) };
  }));

  // ---- one campaign -----------------------------------------------------------------------------------------------
  router.get('/:id', handle((req) => ({ success: true, ...detail(req.params.id) })));

  router.patch('/:id', handle((req) => {
    const body = z.object({ name: z.string().optional(), settings: campaignSettingsPatchSchema.optional() }).strict().parse(req.body);
    if (body.name !== undefined) store.rename(req.params.id, body.name);
    if (body.settings) store.updateSettings(req.params.id, body.settings);
    return { success: true, ...detail(req.params.id) };
  }));

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
    const counts = store.importContacts(campaign.id, analysis.rows, mapping);
    return { success: true, counts, summary: analysis.summary, problems: analysis.problems, warnings: parsed.warnings };
  }));

  router.get('/:id/contacts', handle((req) => {
    store.require(req.params.id);
    const q = z.object({ status: statusSchema.optional(), q: z.string().max(80).optional() }).parse(req.query);
    return { success: true, ...store.listContacts(req.params.id, { status: q.status as ContactStatus | undefined, q: q.q, ...pageSchema.parse(req.query) }) };
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
    const started = store.start(campaign.id, body.acknowledgements);
    return { success: true, skippedAtStart: started.skipped, ...detail(campaign.id) };
  }));

  router.post('/:id/pause', handle((req) => {
    store.pause(req.params.id, 'paused by the operator');
    return { success: true, ...detail(req.params.id) };
  }));

  router.post('/:id/resume', handle((req) => {
    const b = blockers();
    if (b.length > 0) throw new CampaignError(`The AI agent cannot take outbound calls yet: ${b.join('; ')}`, 'AI_NOT_READY');
    store.resume(req.params.id);
    return { success: true, ...detail(req.params.id) };
  }));

  router.post('/:id/stop', handle((req) => {
    store.stop(req.params.id);
    return { success: true, ...detail(req.params.id) };
  }));

  return router;
}
