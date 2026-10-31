import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { redactDiagnosticText } from '../../core/logger.js';
import { decodeSmsText } from '../../sms/text-decoding.js';
import { SmsError, SmsService } from '../../sms/sms-service.js';
import type { SmsInbox } from '../../sms/sms-inbox.js';
import type { SmsStore } from '../../sms/sms-store.js';

/**
 * A message straight from the modem, for the API: the text made readable (UCS-2 hex decoded) with the original kept beside
 * it. Only for responses: the inbox ingests the parser's output unchanged, so its dedupe keys never change.
 */
function withReadableText<T extends { direction: string; text: string }>(message: T): T & { rawText: string; textEncoding: 'text' | 'ucs2' } {
  if (message.direction !== 'received') return { ...message, rawText: message.text, textEncoding: 'text' };
  const decoded = decodeSmsText(message.text);
  return { ...message, text: decoded.text, rawText: decoded.rawText, textEncoding: decoded.encoding };
}

const sendSchema = z
  .object({
    to: z.string({ required_error: "'to' is required" }),
    message: z.string({ required_error: "'message' is required" }).max(2000),
  })
  .strict();

const textParametersSchema = z.object({ confirm: z.string({ required_error: "'confirm' is required" }) }).strict();

const truthy = (value: unknown): boolean => typeof value === 'string' && ['1', 'true', 'yes'].includes(value.toLowerCase());

/**
 * SMS over the gateway's own AT port. Mounted under /api/gateway/sms, behind the same API-key middleware as every other
 * /api route. Every handler goes through SmsService, which refuses during a call or while another SMS operation runs.
 */
export function createSmsRouter(service: SmsService, extras: { inbox?: SmsInbox; store?: SmsStore } = {}): Router {
  const router = Router();
  const { inbox, store } = extras;

  const handle =
    (work: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req: Request, res: Response, next: NextFunction) => {
      work(req, res).catch((error: unknown) => {
        if (error instanceof SmsError) {
          res.status(error.status).json({ success: false, error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
          return;
        }
        next(error);
      });
    };

  /**
   * The gateway's own copy of the messages (received from the modem's storage, and sent through the gateway). It reads the
   * database only: no AT command, so it works during a call and never changes a message's read/unread status.
   * ?direction=received|sent, ?limit (default 100, max 500), ?offset.
   */
  router.get(
    '/inbox',
    handle(async (req, res) => {
      if (!store) throw new SmsError(501, 'SMS_STORE_UNAVAILABLE', 'The SMS message store is not available');
      const direction = req.query.direction === 'received' || req.query.direction === 'sent' ? req.query.direction : undefined;
      if (req.query.direction !== undefined && !direction) throw new SmsError(400, 'INVALID_DIRECTION', "'direction' must be received or sent");
      const limit = Number(req.query.limit);
      const offset = Number(req.query.offset);
      let page: ReturnType<SmsStore['list']>;
      try {
        page = store.list({ direction, limit: Number.isFinite(limit) ? limit : undefined, offset: Number.isFinite(offset) ? offset : undefined });
      } catch (error) {
        // Database only: this never touches the modem, so the failure is the database's and is reported as such.
        throw new SmsError(500, 'SMS_STORE_ERROR', `The gateway could not read its message database: ${redactDiagnosticText((error as Error).message).slice(0, 200)}`);
      }
      res.json({ success: true, ...page, inbox: inbox?.state() ?? null });
    })
  );

  /**
   * Read the modem's storage now and add anything new to the gateway's copy (the dashboard's Refresh). Uses the AT queue, so it
   * is refused during a call, while the modem is not READY, and while another SMS operation runs. Does not mark messages read.
   */
  router.post(
    '/sync',
    handle(async (_req, res) => {
      if (!inbox) throw new SmsError(501, 'SMS_STORE_UNAVAILABLE', 'The SMS inbox is not available');
      const result = await inbox.syncNow();
      res.json({ ...result, inbox: inbox.state() });
    })
  );

  /** Read-only: the storage in use with used/total/free, and which storages the modem supports. Asks the modem; refused during a call. */
  router.get('/storage', handle(async (_req, res) => void res.json(await service.storageInfo())));

  /** Select a storage for read, write and receive, after { storage, confirm: "USE <X> FOR SMS STORAGE" }. Verified by read-back. */
  router.post(
    '/storage',
    handle(async (req, res) => {
      const body = (req.body ?? {}) as { storage?: unknown; confirm?: unknown };
      const result = await service.selectStorage(body.storage, body.confirm);
      inbox?.requestSync('storage-selected');
      res.json(result);
    })
  );

  /**
   * Delete stored messages from the modem, after { ids, confirm: "DELETE <n> MESSAGE(S) FROM <storage>" }. Only messages the
   * gateway has stored, re-checked against the modem first; the gateway copies are kept. Never automatic, never retried.
   */
  router.post(
    '/delete',
    handle(async (req, res) => {
      const body = (req.body ?? {}) as { ids?: unknown; confirm?: unknown };
      const result = await service.deleteStored(body.ids, body.confirm);
      inbox?.requestSync('messages-deleted');
      res.json(result);
    })
  );

  /** Read-only: what the modem's SMS configuration is and whether a send would be accepted. Changes nothing. */
  router.get('/status', handle(async (_req, res) => void res.json(await service.status())));

  /**
   * Write the standard text-mode parameters, AT+CSMP=17,167,0,0, after an explicit confirmation:
   * { "confirm": "APPLY AT+CSMP=17,167,0,0" }. Refused during a call or while the modem is not READY. Reads the old value,
   * writes, reads back and verifies, and returns old and new. Changes nothing else.
   */
  router.post(
    '/text-parameters',
    handle(async (req, res) => {
      const body = textParametersSchema.parse(req.body);
      res.json(await service.applyStandardTextParameters(body.confirm));
    })
  );

  /** Send one text message: { "to": "+91XXXXXXXXXX", "message": "..." }. */
  router.post(
    '/send',
    handle(async (req, res) => {
      const body = sendSchema.parse(req.body); // a ZodError becomes the gateway's standard 400
      res.json(await service.send(body.to, body.message));
    })
  );

  /** Stored messages. ?status=all|unread|read|unsent|sent (default all). ?markRead=true allows unread to become read. */
  router.get(
    '/',
    handle(async (req, res) => {
      const result = await service.list({ status: req.query.status, markRead: truthy(req.query.markRead) });
      res.json({ ...result, messages: result.messages.map(withReadableText) });
    })
  );

  /** One stored message by its index in the modem's storage. */
  router.get(
    '/:index',
    handle(async (req, res) => {
      const result = await service.read(req.params.index, { markRead: truthy(req.query.markRead) });
      res.json({ ...result, message: withReadableText(result.message) });
    })
  );

  return router;
}
