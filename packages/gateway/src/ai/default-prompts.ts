import type { CallDirection } from '@sim-gateway/shared';

/**
 * The prompts a call uses when nobody has written any, so a first test call works with nothing configured.
 *
 * They are deliberately short and say only what is true for ANY business: the assistant is an AI, it does not invent facts, and it
 * knows how to end politely. They name no company and give no prices, hours or promises, because the gateway knows none. The built-in
 * call rules (ai/prompt.ts: short spoken replies, TTS formatting, the END_CALL protocol) are still added after them for every call, so
 * these texts only describe the role.
 *
 * They live in code, not in the database. A customer who never edits a prompt therefore gets better defaults with every update, and a
 * customer who did edit one keeps theirs (it is stored, and always wins).
 */

export const DEFAULT_INBOUND_INSTRUCTIONS = `You are an AI assistant answering a phone call for the business that set you up. If asked, say plainly that you are an AI assistant and never pretend to be a person.
Find out politely what the caller needs and help with what you actually know. You have no details about opening hours, prices or services unless they are written here or the caller tells you, so if you do not know something, say so and offer to take a message so a person can follow up.
Ask for the caller's name and the best way to reach them only if they want a callback. Keep the call short, polite and clear.`;

export const DEFAULT_OUTBOUND_INSTRUCTIONS = `You are an AI assistant making a phone call on behalf of the business that set you up. At the start, say that you are an AI assistant and briefly why you are calling, then ask whether this is a good moment to talk.
If it is not a good time, offer to call back and end the call politely. Never pressure anyone, and if they ask not to be called again, apologise and end the call at once.
You know nothing about the person you are calling beyond what you are told during this call, so do not invent facts, prices or promises. If you are asked something you do not know, say so and offer a follow-up from a person.`;

export const DEFAULT_INBOUND_GREETING = "Hello, thank you for calling. I'm an AI assistant. How can I help you today?";
export const DEFAULT_OUTBOUND_GREETING = 'Hello, this is an AI assistant calling. Is this a good time to talk for a moment?';

export interface DefaultPrompts {
  inbound: { instructions: string; greeting: string };
  outbound: { instructions: string; greeting: string };
}

export const DEFAULT_PROMPTS: DefaultPrompts = {
  inbound: { instructions: DEFAULT_INBOUND_INSTRUCTIONS, greeting: DEFAULT_INBOUND_GREETING },
  outbound: { instructions: DEFAULT_OUTBOUND_INSTRUCTIONS, greeting: DEFAULT_OUTBOUND_GREETING },
};

export type PromptSource = 'direction' | 'shared' | 'default' | 'none';

/** The part of the gateway configuration that decides the prompt (the same fields ai/directions.ts reads). */
export interface PromptConfig {
  sharedInstructions: string | null;
  greeting: string | null;
  promptBody: string;
  directions: { inbound: { instructions: string | null; greeting: string | null }; outbound: { instructions: string | null; greeting: string | null } };
}

const blank = (v: string | null | undefined): v is null | undefined | '' => v === null || v === undefined || v.trim() === '';

/**
 * The prompt and greeting for a call: the customer's prompt for this direction, else the shared one, else the built-in default.
 * Where a customer prompt or a shared one exists, the result is identical to what ai/directions.ts agentFor has always produced, including
 * "no greeting" (the agent then waits for the caller to speak). Only a call with NOTHING customised, which used to get neither instructions
 * nor a greeting, now gets the defaults. So the default greeting is tied to the default instructions: a customer who wrote instructions
 * but no greeting keeps the behaviour they have, instead of suddenly hearing a greeting they never chose.
 */
export function selectPrompt(config: PromptConfig, direction: CallDirection): { systemPrompt: string; greeting: string | null; source: { instructions: PromptSource; greeting: PromptSource } } {
  const which = direction === 'outbound' ? 'outbound' : 'inbound';
  const own = config.directions[which];
  const defaults = DEFAULT_PROMPTS[which];

  let instructions: string;
  let instructionsFrom: PromptSource;
  if (!blank(own.instructions)) [instructions, instructionsFrom] = [own.instructions, 'direction'];
  else if (!blank(config.sharedInstructions)) [instructions, instructionsFrom] = [config.sharedInstructions, 'shared'];
  else [instructions, instructionsFrom] = [defaults.instructions, 'default'];

  let greeting: string | null;
  let greetingFrom: PromptSource;
  if (!blank(own.greeting)) [greeting, greetingFrom] = [own.greeting, 'direction'];
  else if (!blank(config.greeting)) [greeting, greetingFrom] = [config.greeting, 'shared'];
  else if (instructionsFrom === 'default') [greeting, greetingFrom] = [defaults.greeting, 'default'];
  else [greeting, greetingFrom] = [null, 'none'];

  return { systemPrompt: `${instructions}\n\n${config.promptBody}`, greeting, source: { instructions: instructionsFrom, greeting: greetingFrom } };
}
