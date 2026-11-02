import { z } from 'zod';
import type { SaveResult, SheetRecord } from '../../integrations/google-sheets/types.js';
import { ToolContext, ToolDefinition, ToolMode, ToolOutcome } from './types.js';

export interface ContactSink {
  saveRecord(record: SheetRecord, signal?: AbortSignal): Promise<SaveResult>;
}

const schema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    phone: z.string().trim().min(1).max(32).optional(),
    email: z.string().trim().min(1).max(254).optional(),
  })
  .strict()
  .refine((a) => a.name !== undefined || a.phone !== undefined || a.email !== undefined, { message: 'give at least one of name, phone or email' });
type Args = z.infer<typeof schema>;

const digits = (s: string): string => s.replace(/\D/g, '');
const same = (a: string, b: string): boolean => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Saves the details the caller has given and CONFIRMED to the Google Sheet. The model names which details to save, but the values
 * written come from what this call's own transcript established and the caller agreed to after a read-back (ContactDetails), never
 * from the model's wording: a value that is unconfirmed, missing or different from the confirmed one is refused, with the reason, so
 * the agent goes back and confirms it. Nothing is saved after the caller has asked not to be contacted, or for a number that must
 * not have anything recorded. Success is reported only when Google confirmed the write.
 */
export function saveContactTool(deps: { sink: ContactSink; modes: readonly ToolMode[]; now?: () => Date }): ToolDefinition<Args> {
  const now = deps.now ?? (() => new Date());
  return {
    name: 'save_contact_details',
    description:
      'Save the caller\'s contact details to the company spreadsheet. Use it only for a detail the caller has given and has CONFIRMED after you read it back to them. ' +
      'List only the details to save. Never call it for unconfirmed details, and never tell the caller anything was saved unless this tool returns ok true.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'The caller\'s name, exactly as they confirmed it.' },
        phone: { type: 'string', description: 'The caller\'s phone number (digits), exactly as they confirmed it.' },
        email: { type: 'string', description: 'The caller\'s email address, exactly as they confirmed it.' },
      },
    },
    schema,
    modes: deps.modes,
    timeoutMs: 10_000,
    async execute(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
      if (ctx.optedOut()) return { ok: false, code: 'opted_out', message: 'The caller asked not to be contacted. Nothing may be saved. Do not ask for or save any details.' };
      const restriction = ctx.restriction();
      if (restriction) return { ok: false, code: 'restricted', message: `Nothing may be saved for this call (${restriction}).` };

      const known = ctx.contact();
      const problems: string[] = [];
      let name: string | null = null;
      let phone: string | null = null;
      let email: string | null = null;

      if (args.name !== undefined) {
        if (!known.name) problems.push('name: the caller has not given a name on this call');
        else if (!known.nameConfirmed) problems.push('name: the caller has not confirmed it yet; say it back and wait for their agreement');
        else if (!same(args.name, known.name)) problems.push('name: it differs from the name the caller confirmed; use exactly what they confirmed');
        else name = known.name;
      }
      if (args.phone !== undefined) {
        if (!known.phone) problems.push('phone: the caller has not given a number on this call');
        else if (!known.phone.confirmed) problems.push('phone: the caller has not confirmed it yet; read it back and wait for their agreement');
        else if (digits(args.phone) !== known.phone.heard) problems.push('phone: it differs from the number the caller confirmed; use exactly what they confirmed');
        else phone = known.phone.heard;
      }
      if (args.email !== undefined) {
        if (!known.email) problems.push('email: the caller has not given an address on this call');
        else if (!known.email.confirmed) problems.push('email: the caller has not confirmed it yet; read it back and wait for their agreement');
        else if (!same(args.email, known.email.heard)) problems.push('email: it differs from the address the caller confirmed; use exactly what they confirmed');
        else email = known.email.heard;
      }
      if (problems.length > 0) return { ok: false, code: 'not_confirmed', message: `Nothing was saved. ${problems.join('. ')}.` };

      const campaign = ctx.campaignId !== null && ctx.contactId !== null;
      const result = await deps.sink.saveRecord(
        {
          key: campaign ? `campaign:${ctx.campaignId}:${ctx.contactId}:contact` : `call:${ctx.callId}:contact`,
          type: 'contact',
          recordedAt: now().toISOString(),
          callId: ctx.callId,
          campaignId: ctx.campaignId,
          contactId: ctx.contactId,
          direction: ctx.mode,
          name,
          phone,
          email,
          outcome: null,
          detail: null,
        },
        ctx.signal
      );
      if (!result.ok) return { ok: false, code: result.code, message: `Not saved: ${result.message} Do not tell the caller it was saved; say there was a problem and that the team will follow up.` };
      const saved = [name && 'name', phone && 'phone', email && 'email'].filter(Boolean).join(', ');
      return {
        ok: true,
        message: result.status === 'unchanged' ? `Already saved (${saved}); nothing changed.` : result.status === 'updated' ? `The existing record was corrected (${saved}).` : `Saved (${saved}).`,
        data: { status: result.status },
      };
    },
  };
}
