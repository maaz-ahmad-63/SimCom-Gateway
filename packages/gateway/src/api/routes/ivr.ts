import express, { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { DTMF_KEYS, IVR_ACTION_TYPES, IVR_FINAL_ACTION_TYPES, IVR_LIMITS } from '../../ivr/config.js';
import { IVR_ASSET_LIMITS, IvrAssetStore } from '../../ivr/assets.js';
import { IvrError } from '../../ivr/errors.js';
import { IvrStore } from '../../ivr/store.js';
import { TtsGenerator } from '../../ivr/tts-generate.js';

/** What the dashboard needs to know about the IVR at run time (not about its saved configuration). */
export interface IvrRuntimeView {
  /** A controller is registered, so a call the IVR owns is actually run by it. */
  controllerRegistered: boolean;
  /** Calls the IVR is running right now. */
  activeCalls: string[];
  /** The AI is in a mode where it can answer a caller, so a failed IVR can hand the call over to it. */
  aiCanAnswer: boolean;
}

export interface IvrRouteDependencies {
  store: IvrStore;
  assets: IvrAssetStore;
  runtime?: () => IvrRuntimeView;
  /** Text to speech for the audio library. Without it the generate routes answer 503. */
  tts?: TtsGenerator;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };

/** The media types an audio upload may arrive as. The gateway's JSON parser ignores all of them, so the body reaches this route untouched. */
const WAV_TYPES = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'application/octet-stream'];
/** A little above the asset limit so an oversized file reaches the asset check and gets its specific message; far bigger bodies are cut off here. */
const rawWav = express.raw({ type: WAV_TYPES, limit: IVR_ASSET_LIMITS.maxBytes + 512 * 1024 });

const enabledBody = z.object({ enabled: z.boolean() }).strict();

/**
 * The IVR's configuration API, mounted under /api so the gateway's API-key middleware covers it. It only reads and writes the saved
 * configuration and the audio files: it never touches a call, the modem or the audio port. (The runtime that uses the published
 * configuration comes later.)
 */
export function createIvrRouter(deps: IvrRouteDependencies): Router {
  const router = Router();
  const { store, assets } = deps;

  const assetsView = () => ({ assets: assets.list(), audio: audioView() });
  const audioView = () => ({
    sampleRate: assets.expectedSampleRate,
    persistent: assets.persistent,
    maxBytes: IVR_ASSET_LIMITS.maxBytes,
    minDurationMs: IVR_ASSET_LIMITS.minDurationMs,
    maxDurationMs: IVR_ASSET_LIMITS.maxDurationMs,
  });

  /** Everything the dashboard needs to draw the builder in one read. */
  router.get(
    '/',
    wrap((_req, res) => {
      res.json({
        success: true,
        status: store.status(),
        draft: store.getDraft(),
        published: store.getPublished(),
        validation: store.validate(),
        ...assetsView(),
        limits: { ...IVR_LIMITS, keys: DTMF_KEYS, actions: IVR_ACTION_TYPES, finalActions: IVR_FINAL_ACTION_TYPES },
        runtime: deps.runtime ? deps.runtime() : null,
      });
    })
  );

  router.put(
    '/draft',
    wrap((req, res) => {
      const draft = store.saveDraft(req.body);
      res.json({ success: true, draft, validation: store.validate(draft), status: store.status() });
    })
  );

  router.delete(
    '/draft',
    wrap((_req, res) => {
      store.discardDraft();
      const draft = store.getDraft();
      res.json({ success: true, draft, validation: store.validate(draft), status: store.status() });
    })
  );

  /** Check a configuration the way publishing would, without changing anything. A body is checked; an empty request checks the saved draft. */
  router.post(
    '/validate',
    wrap((req, res) => {
      const body = req.body as unknown;
      const given = body !== null && typeof body === 'object' && Object.keys(body as object).length > 0;
      res.json({ success: true, validation: store.validate(given ? body : undefined) });
    })
  );

  router.post(
    '/publish',
    wrap((_req, res) => {
      const published = store.publish();
      res.json({ success: true, published, status: store.status() });
    })
  );

  router.put(
    '/enabled',
    wrap((req, res) => {
      const { enabled } = enabledBody.parse(req.body ?? {});
      store.setEnabled(enabled);
      res.json({ success: true, enabled: store.isEnabled(), status: store.status() });
    })
  );

  router.get(
    '/assets',
    wrap((_req, res) => {
      res.json({ success: true, ...assetsView() });
    })
  );

  /**
   * PUT or POST the WAV file itself as the request body (Content-Type: audio/wav), with the display name in ?name=. The file is
   * checked and stored exactly as sent; nothing is resampled or converted. The same audio uploaded twice is stored once.
   */
  router.post(
    '/assets',
    rawWav,
    wrap((req, res) => {
      const name = typeof req.query.name === 'string' ? req.query.name : '';
      if (!Buffer.isBuffer(req.body)) {
        throw new IvrError('invalid_asset', 'Send the WAV file as the request body with Content-Type: audio/wav.', 415);
      }
      const { asset, duplicate } = assets.add(req.body, name);
      res.status(duplicate ? 200 : 201).json({ success: true, asset, duplicate, ...assetsView() });
    })
  );

  /** The voice models that could generate an announcement, and whether each can be used now. Reads the registry; calls no provider. */
  router.get(
    '/generate/options',
    wrap((_req, res) => {
      if (!deps.tts) throw new IvrError('tts_unavailable', 'Audio generation is not available on this gateway.', 503);
      res.json({ success: true, ...deps.tts.options() });
    })
  );

  /**
   * Generate an announcement from text. The WAV comes back (base64) in the IVR format for the dashboard to preview and download;
   * NOTHING is stored here. Adding it to the library is the ordinary upload above, which checks the file again.
   */
  router.post(
    '/generate',
    wrap(async (req, res) => {
      if (!deps.tts) throw new IvrError('tts_unavailable', 'Audio generation is not available on this gateway.', 503);
      const { wav, info } = await deps.tts.generate((req.body ?? {}) as Record<string, unknown>);
      res.json({ success: true, info, audioWavBase64: wav.toString('base64') });
    })
  );

  /** The stored file, for the dashboard's preview player. The id is a hash of the content, so the answer can be cached for good. */
  router.get(
    '/assets/:id/audio',
    wrap((req, res) => {
      const wav = assets.readWav(req.params.id);
      if (!wav) throw new IvrError('asset_not_found', 'That audio file does not exist.', 404);
      res.status(200).set({ 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length), 'Cache-Control': 'private, max-age=31536000, immutable' }).end(wav);
    })
  );

  router.delete(
    '/assets/:id',
    wrap((req, res) => {
      store.removeAsset(req.params.id);
      res.json({ success: true, removed: true, ...assetsView() });
    })
  );

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof IvrError) {
      res.status(error.status).json({
        success: false,
        error: error.message,
        code: `IVR_${error.code.toUpperCase()}`,
        // The same {path, message} shape the gateway's validation errors already use, so the dashboard reads both the same way.
        ...(error.issues.length > 0 ? { details: error.issues } : {}),
      });
      return;
    }
    const e = error as { type?: string; status?: number };
    if (e?.type === 'entity.too.large' || e?.status === 413) {
      res.status(413).json({
        success: false,
        error: `The audio file is larger than the ${IVR_ASSET_LIMITS.maxBytes / 1024 / 1024} MB limit. Use a shorter announcement.`,
        code: 'IVR_INVALID_ASSET',
      });
      return;
    }
    next(error);
  });

  return router;
}
