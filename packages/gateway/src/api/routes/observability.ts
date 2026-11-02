import { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { CallFilters, ObservabilityStore } from '../../ai/observability-store.js';

export interface ObservabilityRouteDependencies {
  store: ObservabilityStore;
  /** The retention settings in force, shown to the operator. */
  retention?: { retentionDays: number; maxEvents: number };
}

const iso = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO date-time')
  .transform((v) => new Date(v).toISOString());

const filterSchema = z.object({
  from: iso.optional(),
  to: iso.optional(),
  status: z.string().trim().min(1).max(40).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  provider: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  simulated: z.enum(['only', 'exclude']).optional(),
});

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Read-only call observability API, mounted under /api so the gateway API-key middleware covers it. It only reads what the
 * pipeline already recorded; it never touches the modem, a call or a provider.
 */
export function createObservabilityRouter({ store, retention }: ObservabilityRouteDependencies): Router {
  const router = Router();
  const handle =
    (fn: Parameters<RequestHandler>[1] extends infer R ? (req: Parameters<RequestHandler>[0], res: R) => unknown : never): RequestHandler =>
    (req, res, next) => {
      try {
        const out = fn(req, res);
        if (out !== undefined) res.json(out);
      } catch (error) {
        if (error instanceof z.ZodError) {
          res.status(400).json({ success: false, error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), code: 'INVALID_QUERY' });
          return;
        }
        next(error);
      }
    };
  const filters = (q: unknown): CallFilters => filterSchema.parse(q);

  router.get('/status', handle(() => ({ success: true, ...store.stats(), retention: retention ?? null })));

  router.get('/overview', handle((req) => ({ success: true, ...store.overview(filters(req.query)) })));

  router.get('/latency', handle((req) => {
    const o = store.overview(filters(req.query));
    return { success: true, latencyMs: o.latencyMs, providers: o.providers, turns: o.turns };
  }));

  router.get('/calls', handle((req) => ({ success: true, ...store.listCalls(filters(req.query), pageSchema.parse(req.query)) })));

  router.get('/calls/:id', handle((req, res) => {
    const detail = store.callDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ success: false, error: 'Call not found', code: 'CALL_NOT_FOUND' });
      return undefined;
    }
    return { success: true, ...detail };
  }));

  router.get('/calls/:id/turns/:turnId', handle((req, res) => {
    const events = store.eventsFor(req.params.id, req.params.turnId);
    if (events.length === 0) {
      res.status(404).json({ success: false, error: 'No recorded events for that turn', code: 'TURN_NOT_FOUND' });
      return undefined;
    }
    return { success: true, callId: req.params.id, turnId: req.params.turnId, events };
  }));

  router.get('/errors', handle((req) => ({ success: true, ...store.errors(filters(req.query), pageSchema.parse(req.query)) })));

  return router;
}
