/**
 * Which prompt a call uses, as the dashboard shows it, and how an edit becomes a saved value.
 *
 * The rule is the gateway's (ai/default-prompts.ts selectPrompt) and a test keeps the two identical: the customer's prompt for the
 * direction, else the shared one, else the built-in default. The built-in texts come from the gateway (settings.agent.defaultPrompts), so
 * they exist in one place only. Restoring the default means saving an empty string: the gateway reads an empty value as "not set".
 */

export interface DefaultPrompts {
  inbound: { instructions: string; greeting: string };
  outbound: { instructions: string; greeting: string };
}

/** The agent settings as the gateway sends them, with the built-in prompts a newer gateway adds. */
export interface AgentWithDefaults {
  defaultPrompts?: DefaultPrompts;
}

export type PromptSource = 'custom' | 'shared' | 'default' | 'none';

const filled = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== '';

export interface PromptView {
  /** The text a call uses now (empty when there is none, or when the built-in text is not known to this page). */
  instructions: string;
  greeting: string;
  source: { instructions: PromptSource; greeting: PromptSource };
}

export interface PromptInputs {
  customInstructions: string;
  customGreeting: string;
  sharedInstructions: string;
  sharedGreeting: string;
  /** The built-in prompt for this direction, when the gateway has sent it. */
  defaults?: { instructions: string; greeting: string };
}

/**
 * The prompt a call in this direction will use. The greeting follows the gateway's rule: the built-in greeting is used only when the
 * instructions are the built-in ones too, so a customer who wrote instructions but no greeting keeps a call that waits for the caller.
 */
export function effectivePrompt(i: PromptInputs): PromptView {
  let instructions = '';
  let instructionsFrom: PromptSource = 'default';
  if (filled(i.customInstructions)) [instructions, instructionsFrom] = [i.customInstructions, 'custom'];
  else if (filled(i.sharedInstructions)) [instructions, instructionsFrom] = [i.sharedInstructions, 'shared'];
  else instructions = i.defaults?.instructions ?? '';

  let greeting = '';
  let greetingFrom: PromptSource;
  if (filled(i.customGreeting)) [greeting, greetingFrom] = [i.customGreeting, 'custom'];
  else if (filled(i.sharedGreeting)) [greeting, greetingFrom] = [i.sharedGreeting, 'shared'];
  else if (instructionsFrom === 'default') [greeting, greetingFrom] = [i.defaults?.greeting ?? '', 'default'];
  else greetingFrom = 'none';
  return { instructions, greeting, source: { instructions: instructionsFrom, greeting: greetingFrom } };
}

/** The customer has written something of their own for this direction (so there is something to restore). */
export const hasCustomPrompt = (i: Pick<PromptInputs, 'customInstructions' | 'customGreeting'>): boolean => filled(i.customInstructions) || filled(i.customGreeting);

/**
 * What removing the customer's own text leads back to. If shared instructions exist, THEY apply (the precedence is own, then shared, then
 * built-in), so the honest name for the action is "use the shared instructions", not "restore the default". Shared instructions are never
 * touched by it.
 */
export function restoreTarget(i: Pick<PromptInputs, 'sharedInstructions'>): 'shared' | 'default' {
  return filled(i.sharedInstructions) ? 'shared' : 'default';
}

/** Exactly what a call in this direction will use once the customer's own text is removed, from the same rule as everything else. */
export function afterRestore(i: PromptInputs): PromptView {
  return effectivePrompt({ ...i, customInstructions: '', customGreeting: '' });
}

/**
 * The settings patch for this direction's two fields, and nothing else: it can never carry the shared instructions or the shared
 * greeting, so saving or restoring one direction cannot delete or change them.
 */
export function directionPatch(direction: 'inbound' | 'outbound', instructions: string, greeting: string): Record<string, { [field: string]: string }> {
  return direction === 'inbound' ? { agent: { inboundInstructions: instructions, inboundGreeting: greeting } } : { agent: { outboundInstructions: instructions, outboundGreeting: greeting } };
}

/** What the editor starts from: the customer's own text, else what is in use now, so editing never starts from a blank page. */
export function textToEdit(custom: string, effective: string): string {
  return filled(custom) ? custom : effective;
}

/**
 * What to save after an edit. Text identical to the built-in default is saved as nothing, so the prompt keeps following the built-in one
 * (which improves with updates) instead of becoming a frozen copy. An empty edit is also nothing. Anything else is saved as typed.
 */
export function textToSave(edited: string, builtIn: string | undefined): string {
  if (!filled(edited)) return '';
  if (builtIn !== undefined && edited.trim() === builtIn.trim()) return '';
  return edited;
}

export const SOURCE_LABEL: Record<PromptSource, string> = {
  custom: 'Custom',
  shared: 'Shared',
  default: 'Default',
  none: 'None',
};
