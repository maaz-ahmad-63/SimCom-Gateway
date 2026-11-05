import { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { AlertError, AlertStore } from '../../ops/alerts.js';
import { BackupError, BackupService } from '../../ops/backup.js';
import type { CallDiagnosticsStore } from '../../ops/call-diagnostics.js';
import type { HealthMonitor } from '../../ops/health.js';
import type { NetworkDiagnostics } from '../../ops/network.js';
import { API_VERSION, compatibility } from '../../ops/version.js';

export interface OpsRouteDependencies {
  alerts: AlertStore;
  health: HealthMonitor;
  network: NetworkDiagnostics;
  diagnostics: CallDiagnosticsStore;
  backups: BackupService;
  version: () => { app: string; schema: number; node: string; apiVersion: number; startedAt: string };
  /** Builds the support bundle (the caller supplies everything that needs the live gateway). */
  bundle: () => unknown;
}

const pageSchema = z.object({ page: z.coerce.number().int().min(1).max(100000).optional(), pageSize: z.coerce.number().int().min(1).max(200).optional() });

/**
 * Operations API under /api/ops (behind the same API key as every other /api route).
 * Customer-facing fields (title, message, action) are separate from technical details, which are only returned by the
 * `/alerts/:id/diagnostics` route and the support bundle.
 */
export function createOpsRouter(d: OpsRouteDependencies): Router {
  const router = Router();
  const handle =
    (fn: (req: Request, res: Response) => unknown | Promise<unknown>): RequestHandler =>
    (req, res, next) => {
      void Promise.resolve()
        .then(() => fn(req, res))
        .then((out) => {
          if (out !== undefined) res.json(out);
        })
        .catch((error) => {
          if (error instanceof z.ZodError) res.status(400).json({ success: false, error: error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '), code: 'INVALID_REQUEST' });
          else if (error instanceof AlertError || error instanceof BackupError) res.status(error.status).json({ success: false, error: error.message, code: error.code });
          else next(error);
        });
    };
  const idOf = (req: Request) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n) || n < 1) throw new AlertError('Alert not found', 'NOT_FOUND', 404);
    return n;
  };

  router.get('/health', handle(async (req) => ({ success: true, ...(req.query.refresh === '1' ? await d.health.runAll() : d.health.snapshot()), alerts: d.alerts.active().length })));

  router.get('/version', handle((req) => {
    const claimed = Number(req.query.dashboardApi);
    return { success: true, ...d.version(), ...compatibility(Number.isInteger(claimed) ? claimed : null) };
  }));

  router.get('/alerts', handle(() => ({ success: true, alerts: d.alerts.active() })));
  router.get('/alerts/history', handle((req) => ({ success: true, ...d.alerts.history(pageSchema.parse(req.query).page, pageSchema.parse(req.query).pageSize) })));

  router.post('/alerts/:id/acknowledge', handle((req) => ({ success: true, alert: d.alerts.acknowledge(idOf(req)) })));
  router.post('/alerts/:id/dismiss', handle((req) => ({ success: true, alert: d.alerts.dismiss(idOf(req)) })));

  /** Safe retry: re-reads the state behind the alert. It never reconnects hardware, restarts anything or places a call. */
  router.post('/alerts/:id/recheck', handle(async (req) => {
    const alert = d.alerts.get(idOf(req));
    if (!alert) throw new AlertError('Alert not found', 'NOT_FOUND', 404);
    if (alert.retry !== 'recheck') throw new AlertError('This alert has no safe retry', 'NO_RETRY', 409);
    if (alert.component === 'network') await d.network.refresh();
    await d.health.run(alert.component);
    return { success: true, alert: d.alerts.get(alert.id), health: d.health.snapshot() };
  }));

  /** The technical detail of one alert: the protected diagnostic view. */
  router.get('/alerts/:id/diagnostics', handle((req) => {
    const found = d.alerts.details(idOf(req));
    if (!found) throw new AlertError('Alert not found', 'NOT_FOUND', 404);
    return { success: true, ...found };
  }));

  router.get('/network', handle(() => ({ success: true, reading: d.network.snapshot() })));
  router.post('/network/refresh', handle(async () => ({ success: true, reading: await d.network.refresh() })));

  router.get('/calls/:callId/diagnostics', handle((req) => {
    const found = d.diagnostics.get(String(req.params.callId).slice(0, 100));
    if (!found) throw new AlertError('No diagnosis was saved for this call', 'NOT_FOUND', 404);
    return { success: true, diagnostics: found };
  }));

  router.get('/backups', handle(() => ({ success: true, backups: d.backups.list(), pendingRestore: d.backups.pending() })));
  router.post('/backups', handle(async (_req, res) => {
    const backup = await d.backups.create('manual');
    res.status(201);
    return { success: true, backup };
  }));
  router.post('/backups/restore', handle((req) => {
    const body = z.object({ name: z.string().min(1).max(130), confirm: z.literal(true) }).parse(req.body);
    return { success: true, ...d.backups.stageRestore(body.name), message: 'The restore is staged. It is applied the next time the application starts; the current data is kept as a pre-restore backup.' };
  }));
  router.delete('/backups/restore', handle(() => ({ success: true, cancelled: d.backups.cancelRestore() })));

  router.get('/support-bundle', handle((_req, res) => {
    const bundle = d.bundle();
    res.setHeader('Content-Disposition', `attachment; filename="support-bundle-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json"`);
    res.type('application/json').send(JSON.stringify(bundle, null, 2));
    return undefined;
  }));

  router.get('/api-version', handle(() => ({ success: true, apiVersion: API_VERSION })));
  return router;
}
