import type { z } from 'zod';
import type { ContactState } from '../contact-details.js';

/** The two kinds of call. A tool lists the modes it may run in; nothing runs in a mode it does not list. */
export type ToolMode = 'inbound' | 'outbound';

/** What a tool may know about the call it runs in. Supplied by the conversation, never by the model or the caller's words. */
export interface ToolContext {
  callId: string;
  mode: ToolMode;
  /** Set only for a campaign call (from the call's own metadata, not from anything said). */
  campaignId: string | null;
  contactId: number | null;
  /** What the caller has said and confirmed on this call so far. */
  contact: () => ContactState;
  /** The caller asked, on this call, not to be contacted again. */
  optedOut: () => boolean;
  /** A standing reason this call's person must not have anything recorded (do-not-call list, declined consent); null when none. */
  restriction: () => string | null;
  /** Aborted when the turn is cancelled or the tool's time is up. */
  signal: AbortSignal;
}

/** What goes back to the model. `message` is written for the model: short, factual, and says what to do next. */
export type ToolOutcome =
  | { ok: true; message: string; data?: Record<string, unknown> }
  | { ok: false; code: string; message: string };

export interface ToolDefinition<Args = unknown> {
  name: string;
  description: string;
  /** JSON Schema shown to the model. The `schema` below is what is actually enforced. */
  parameters: Record<string, unknown>;
  schema: z.ZodType<Args>;
  modes: readonly ToolMode[];
  timeoutMs: number;
  execute(args: Args, ctx: ToolContext): Promise<ToolOutcome>;
}

/** One executed (or refused) call, as the conversation records it. Arguments are never included: they hold personal details. */
export interface ToolRun {
  name: string;
  ok: boolean;
  code: string | null;
  durationMs: number;
  /** The text handed back to the model. */
  content: string;
}
