import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { AiNotReadyError } from '../../ai/orchestrator.js';
import { AiBlockedError, AiRuntime } from '../../ai/runtime.js';
import { AiSettingsService, SettingsError } from '../../ai/settings.js';
import { activeRegistryRevision } from '../../ai/registry/active.js';
import { AiUsageStore } from '../../ai/usage-store.js';
import { AiProviderError } from '../../ai/providers/types.js';

export interface AiRouteDependencies {
  runtime: AiRuntime;
  settings: AiSettingsService;
  usage: AiUsageStore;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };

function sinceIso(range: unknown): string | undefined {
  const now = Date.now();
  switch (range) {
    case 'today': {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case '7d':
      return new Date(now - 7 * 86_400_000).toISOString();
    case '30d':
      return new Date(now - 30 * 86_400_000).toISOString();
    default:
      return undefined;
  }
}

/**
 * The AI feature's whole HTTP surface, mounted under /api so the gateway's API-key middleware
 * covers it. Nothing here answers, dials or hangs up a call, sends an AT command, changes PCM
 * registration or writes audio to the modem. Credentials are accepted (PUT) but never returned.
 */
export function createAiRouter(deps: AiRouteDependencies): Router {
  const router = Router();
  const { runtime, settings, usage } = deps;

  const settingsView = () => settings.view(runtime.config);
  const agentView = () => settingsView().agent;

  // ---- overview -----------------------------------------------------------------------------------
  router.get(
    '/state',
    wrap((_req, res) => {
      res.json({
        settings: settingsView(),
        readiness: runtime.readiness(),
        credentials: runtime.credentials(),
        sessions: runtime.orchestrator.getSessions(),
        usageToday: usage.totals(sinceIso('today')),
        testResponse: runtime.testResponseReadiness(),
        conversation: runtime.conversationReadiness(),
        // Changes whenever the model registry does: a page that holds an older model catalog fetches it again.
        catalogRevision: activeRegistryRevision(),
      });
    })
  );

  router.get(
    '/readiness',
    wrap((_req, res) => {
      res.json(runtime.readiness());
    })
  );

  router.get(
    '/status',
    wrap((_req, res) => {
      res.json(runtime.orchestrator.getStatus());
    })
  );

  router.get(
    '/sessions',
    wrap((_req, res) => {
      res.json({ sessions: runtime.orchestrator.getSessions() });
    })
  );

  router.get(
    '/events',
    wrap((req, res) => {
      const callId = typeof req.query.callId === 'string' ? req.query.callId : undefined;
      res.json({ events: runtime.recentEvents(callId) });
    })
  );

  // ---- configuration ------------------------------------------------------------------------------
  router.get(
    '/catalog',
    wrap((_req, res) => {
      res.json(runtime.catalog());
    })
  );

  router.get(
    '/settings',
    wrap((_req, res) => {
      res.json(settingsView());
    })
  );

  router.put(
    '/settings',
    wrap((req, res) => {
      const before = settings.getStored();
      settings.update(req.body);
      runtime.reload();
      runtime.announceSettingsEffects(before, settings.getStored());
      res.json(settingsView());
    })
  );

  router.get(
    '/agent',
    wrap((_req, res) => {
      res.json(agentView());
    })
  );

  router.put(
    '/agent',
    wrap((req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { language, ...agent } = body;
      settings.update({ agent, ...(language !== undefined ? { language } : {}) });
      runtime.reload();
      res.json(agentView());
    })
  );

  router.post(
    '/mode',
    wrap((req, res) => {
      const mode = (req.body as { mode?: unknown } | undefined)?.mode;
      if (mode !== 'off' && mode !== 'passive' && mode !== 'active') throw new SettingsError('mode must be off, passive or active');
      runtime.setMode(mode);
      res.json({ mode: runtime.mode, readiness: runtime.readiness() });
    })
  );

  // ---- credentials (write-only) -------------------------------------------------------------------
  router.get(
    '/credentials',
    wrap((_req, res) => {
      res.json({ credentials: runtime.credentials(), secretStorageAvailable: settings.secretStorageAvailable });
    })
  );

  router.put(
    '/credentials/:name',
    wrap((req, res) => {
      runtime.setCredential(String(req.params.name), (req.body as { value?: unknown } | undefined)?.value);
      res.json({ credentials: runtime.credentials() });
    })
  );

  router.delete(
    '/credentials/:name',
    wrap((req, res) => {
      runtime.removeCredential(String(req.params.name));
      res.json({ credentials: runtime.credentials() });
    })
  );

  router.post(
    '/credentials/:name/validate',
    wrap(async (req, res) => {
      const result = await runtime.validateCredential(String(req.params.name));
      res.json({ ...result, credentials: runtime.credentials() });
    })
  );

  // ---- operator attestations ----------------------------------------------------------------------
  const kindOf = (req: Request): 'inbound' | 'outbound' => {
    const kind = req.params.kind;
    if (kind !== 'inbound' && kind !== 'outbound') throw new SettingsError('kind must be inbound or outbound', 404);
    return kind;
  };

  router.post(
    '/attestations/:kind',
    wrap((req, res) => {
      runtime.attest(kindOf(req), (req.body as { note?: unknown } | undefined)?.note);
      res.json({ settings: settingsView(), readiness: runtime.readiness() });
    })
  );

  router.delete(
    '/attestations/:kind',
    wrap((req, res) => {
      runtime.revokeAttestation(kindOf(req));
      res.json({ settings: settingsView(), readiness: runtime.readiness() });
    })
  );

  // ---- call control (marks a call for AI handling; never answers or dials) ------------------------
  router.post(
    '/calls/:id/arm',
    wrap(async (req, res) => {
      try {
        await runtime.orchestrator.arm(String(req.params.id));
        res.json({ success: true, armed: String(req.params.id) });
      } catch (error) {
        if ((error as Error).message === 'Only the current call can be armed') {
          res.status(404).json({ success: false, error: (error as Error).message });
          return;
        }
        throw error;
      }
    })
  );

  // One reply, one operator action. Never automatic, never repeated by the server.
  router.post(
    '/calls/:id/test-response',
    wrap(async (req, res) => {
      res.json(await runtime.playTestResponse(String(req.params.id), req.body ?? {}));
    })
  );

  // Per call, explicit, and revocable: the agent answers every finished caller utterance until switched off.
  router.post(
    '/calls/:id/conversation',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { enabled?: unknown; confirmBilling?: unknown; confirmPlayToCaller?: unknown };
      if (typeof body.enabled !== 'boolean') throw new SettingsError('enabled must be true or false');
      await runtime.setConversation(String(req.params.id), body.enabled, body);
      res.json({ success: true, enabled: body.enabled, conversation: runtime.conversationReadiness() });
    })
  );

  router.post(
    '/calls/:id/disarm',
    wrap(async (req, res) => {
      await runtime.orchestrator.disarm(String(req.params.id));
      res.json({ success: true, disarmed: String(req.params.id) });
    })
  );

  // ---- operator tests -----------------------------------------------------------------------------
  router.get(
    '/recordings',
    wrap((_req, res) => {
      res.json({ recordings: runtime.listRecordings() });
    })
  );

  router.post(
    '/test/stt',
    wrap(async (req, res) => {
      res.json(await runtime.testSttRecording(req.body ?? {}));
    })
  );

  router.post(
    '/test/llm',
    wrap(async (req, res) => {
      res.json(await runtime.testLlm(req.body ?? {}));
    })
  );

  router.post(
    '/test/tts',
    wrap(async (req, res) => {
      res.json(await runtime.previewTts(req.body ?? {}));
    })
  );

  router.get(
    '/test/tts/compatibility',
    wrap((_req, res) => {
      res.json(runtime.ttsCompatibility());
    })
  );

  // ---- usage and logs -----------------------------------------------------------------------------
  router.get(
    '/usage',
    wrap((req, res) => {
      res.json({ range: req.query.range ?? 'all', totals: usage.totals(sinceIso(req.query.range)) });
    })
  );

  router.get(
    '/turns',
    wrap((req, res) => {
      const limit = Number(req.query.limit ?? 50);
      const callId = typeof req.query.callId === 'string' ? req.query.callId : undefined;
      res.json({ turns: usage.recent(Number.isFinite(limit) ? limit : 50, callId) });
    })
  );

  router.delete(
    '/turns',
    wrap((_req, res) => {
      const removed = usage.clear();
      runtime.hub.clear();
      res.json({ removed });
    })
  );

  // ---- errors: map domain errors to precise statuses; unknown errors fall through to the gateway handler
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof SettingsError) {
      res.status(error.status).json({ success: false, error: error.message, issues: error.issues });
      return;
    }
    if (error instanceof AiNotReadyError) {
      res.status(409).json({ success: false, error: error.message, blockers: error.blockers });
      return;
    }
    if (error instanceof AiBlockedError) {
      res.status(409).json({ success: false, error: error.message, blockers: error.blockers });
      return;
    }
    if (error instanceof AiProviderError) {
      // Provider messages are already scrubbed of credentials.
      res.status(502).json({ success: false, error: error.message, stage: error.stage, provider: error.provider });
      return;
    }
    next(error);
  });

  return router;
}
