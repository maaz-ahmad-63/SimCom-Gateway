import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { PricingError, PricingUpdater } from '../../ai/registry/pricing-updater.js';
import { Stage } from '../../ai/registry/schema.js';
import { ModelRegistryService } from '../../ai/registry/service.js';
import { RegistryStore } from '../../ai/registry/store.js';

export interface RegistryRouteDependencies {
  service: ModelRegistryService;
  store: RegistryStore;
  updater: PricingUpdater;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };

const isStage = (v: unknown): v is Stage => v === 'llm' || v === 'stt' || v === 'tts';

/**
 * The AI Model Hub's HTTP surface, mounted under /api (so the API-key middleware covers it). The dashboard reads every provider, model,
 * voice and price from here. A rejected change answers 422 with every validation issue and changes nothing; the registry in force stays
 * the last valid one. No response carries a credential value.
 */
export function createRegistryRouter(deps: RegistryRouteDependencies): Router {
  const router = Router();
  const { service, store, updater } = deps;

  const outcome = (res: Response, result: { ok: boolean; issues: unknown[] }) => {
    if (result.ok) {
      res.json({ success: true, registry: service.view() });
      return;
    }
    const issues = result.issues as Array<{ collection: string; id: string | null; path: string; message: string }>;
    // `blockers` is the list of readable messages the dashboard's API client already shows; `issues` keeps the structure.
    res.status(422).json({
      success: false,
      error: 'The registry was not changed: the entry is not valid',
      issues,
      blockers: issues.map((i) => `${i.collection}${i.id ? ` '${i.id}'` : ''} ${i.path}: ${i.message}`),
    });
  };
  const bad = (res: Response, message: string) => void res.status(400).json({ success: false, error: message });

  router.get('/', wrap((_req, res) => void res.json(service.view())));
  router.get('/export', wrap((_req, res) => void res.json(store.exportDocument())));

  router.post(
    '/validate',
    wrap((req, res) => {
      const body = (req.body ?? {}) as { kind?: unknown; entry?: unknown; document?: { providers?: unknown[]; models?: unknown[] } };
      if (body.document) return void res.json(service.validateDocument(body.document));
      if (body.kind !== 'provider' && body.kind !== 'model') return bad(res, 'kind must be "provider" or "model"');
      res.json(service.validateEntry(body.kind, body.entry));
    })
  );

  router.post(
    '/import',
    wrap((req, res) => {
      const body = (req.body ?? {}) as { document?: { providers?: unknown[]; models?: unknown[] }; dryRun?: unknown };
      if (!body.document || typeof body.document !== 'object') return bad(res, 'document is required (the exported registry JSON)');
      if (body.dryRun === true) return void res.json(service.validateDocument(body.document));
      outcome(res, service.importDocument(body.document));
    })
  );

  router.post(
    '/restore-defaults',
    wrap((req, res) => {
      const ids = (req.body as { ids?: unknown } | undefined)?.ids;
      outcome(res, service.restoreDefaults(Array.isArray(ids) ? (ids as never) : undefined));
    })
  );

  router.post('/providers', wrap((req, res) => outcome(res, service.createProvider(req.body))));
  router.patch(
    '/providers/:id',
    wrap((req, res) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return bad(res, 'the body must be an object of the fields to change');
      outcome(res, service.updateProvider(req.params.id, req.body as Record<string, unknown>));
    })
  );
  router.delete('/providers/:id', wrap((req, res) => outcome(res, service.removeProvider(req.params.id))));

  router.post('/models', wrap((req, res) => outcome(res, service.createModel(req.body))));
  router.patch(
    '/models/:stage/:id',
    wrap((req, res) => {
      if (!isStage(req.params.stage)) return void res.status(404).json({ success: false, error: 'stage must be llm, stt or tts' });
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return bad(res, 'the body must be an object of the fields to change');
      outcome(res, service.updateModel(req.params.stage, req.params.id, req.body as Record<string, unknown>));
    })
  );
  router.delete(
    '/models/:stage/:id',
    wrap((req, res) => {
      if (!isStage(req.params.stage)) return void res.status(404).json({ success: false, error: 'stage must be llm, stt or tts' });
      outcome(res, service.removeModel(req.params.stage, req.params.id));
    })
  );

  router.post('/test/provider/:id', wrap(async (req, res) => void res.json(await service.testProvider(req.params.id))));
  router.post(
    '/test/model/:stage/:id',
    wrap(async (req, res) => {
      if (!isStage(req.params.stage)) return void res.status(404).json({ success: false, error: 'stage must be llm, stt or tts' });
      // A language model is tested with a real, very short request, which the provider bills: the caller has to say it knows.
      if (req.params.stage === 'llm' && (req.body as { confirmBilling?: unknown } | undefined)?.confirmBilling !== true) {
        return void res.status(400).json({ success: false, error: 'Testing a language model sends one very short request to the provider, which is billed. Send confirmBilling: true to run it.' });
      }
      res.json(await service.testModel(req.params.stage, req.params.id, { generate: req.params.stage === 'llm' }));
    })
  );

  // ---- pricing review (separate from the model registry) --------------------------------------------
  router.get('/pricing/history', wrap((_req, res) => void res.json({ history: updater.history() })));
  router.get(
    '/pricing/proposals/:id',
    wrap((req, res) => {
      const proposal = updater.proposal(req.params.id);
      if (!proposal) return void res.status(404).json({ success: false, error: 'no such proposal' });
      res.json(proposal);
    })
  );
  router.post(
    '/pricing/check',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { providerIds?: unknown; force?: unknown };
      const providerIds = Array.isArray(body.providerIds) ? body.providerIds.filter((v): v is string => typeof v === 'string') : undefined;
      res.json({ checks: await updater.check({ providerIds, force: body.force === true }), registry: service.view() });
    })
  );
  router.post(
    '/pricing/proposals',
    wrap((req, res) => {
      const body = (req.body ?? {}) as { document?: unknown; entries?: unknown; note?: unknown };
      const json = body.document ?? body.entries;
      if (json === undefined) return bad(res, 'send the reviewed prices as "entries" (an array) or "document" ({ schemaVersion, prices })');
      const proposal = updater.proposeFromJson(json, 'manual-import', null, typeof body.note === 'string' ? body.note.slice(0, 300) : null);
      res.json({ success: true, proposal, registry: service.view() });
    })
  );
  router.post(
    '/pricing/proposals/:id/approve',
    wrap((req, res) => {
      const body = (req.body ?? {}) as { overrideIds?: unknown; onlyIds?: unknown; note?: unknown };
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
      const result = updater.approve(req.params.id, { overrideIds: strings(body.overrideIds), onlyIds: strings(body.onlyIds), note: typeof body.note === 'string' ? body.note.slice(0, 300) : null });
      res.json({ success: true, ...result, registry: service.view() });
    })
  );
  router.post(
    '/pricing/proposals/:id/reject',
    wrap((req, res) => {
      const note = (req.body as { note?: unknown } | undefined)?.note;
      const proposal = updater.reject(req.params.id, typeof note === 'string' ? note.slice(0, 300) : null);
      res.json({ success: true, proposal, registry: service.view() });
    })
  );

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof PricingError) return void res.status(error.status).json({ success: false, error: error.message });
    next(error);
  });

  return router;
}
