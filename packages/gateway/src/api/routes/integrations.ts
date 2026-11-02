import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import type { AiRuntime } from '../../ai/runtime.js';
import { SheetsService } from '../../integrations/google-sheets/service.js';
import { SheetsError } from '../../integrations/google-sheets/types.js';

export interface IntegrationsRouteDependencies {
  sheets: SheetsService;
  runtime: AiRuntime;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };

/**
 * Integration settings, mounted under /api so the gateway's API-key middleware covers it. The service account key is accepted
 * (PUT) and never returned: the status carries only whether one is stored and the account's email, which is what the sheet is
 * shared with. The connection test only reads from Google; it never writes to the sheet, places a call or touches the modem.
 */
export function createIntegrationsRouter(deps: IntegrationsRouteDependencies): Router {
  const router = Router();
  const { sheets, runtime } = deps;

  /** Whether the selected model can be given functions, so the dashboard can say so instead of letting a switch do nothing. */
  const modelTools = () => {
    const spec = runtime.config.config.llm.spec;
    return spec
      ? { model: runtime.config.config.llm.key, provider: spec.provider, supported: spec.toolCalling }
      : { model: runtime.config.config.llm.key, provider: null, supported: false };
  };

  router.get(
    '/google-sheets',
    wrap((_req, res) => {
      res.json({ ...sheets.store.status(), modelTools: modelTools() });
    })
  );

  router.put(
    '/google-sheets',
    wrap((req, res) => {
      sheets.store.update(req.body ?? {});
      res.json({ ...sheets.store.status(), modelTools: modelTools() });
    })
  );

  router.put(
    '/google-sheets/credential',
    wrap((req, res) => {
      sheets.store.setCredential((req.body as { serviceAccountJson?: unknown } | undefined)?.serviceAccountJson);
      res.json({ ...sheets.store.status(), modelTools: modelTools() });
    })
  );

  router.delete(
    '/google-sheets/credential',
    wrap((_req, res) => {
      sheets.store.deleteCredential();
      res.json({ ...sheets.store.status(), modelTools: modelTools() });
    })
  );

  router.post(
    '/google-sheets/test',
    wrap(async (_req, res) => {
      const result = await sheets.test();
      // modelTools belongs inside status: the dashboard replaces its whole status with this one, so a top-level copy left it undefined.
      res.json({ result, status: { ...sheets.store.status(), modelTools: modelTools() }, modelTools: modelTools() });
    })
  );

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof SheetsError) {
      res.status(error.status).json({ success: false, error: error.message, code: error.code });
      return;
    }
    next(error);
  });

  return router;
}
