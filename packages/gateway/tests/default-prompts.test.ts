import { describe, expect, it } from 'vitest';
import { agentFor } from '../src/ai/directions.js';
import { loadAiConfig } from '../src/ai/config.js';
import { DEFAULT_PROMPTS, PromptConfig, selectPrompt } from '../src/ai/default-prompts.js';

/**
 * The built-in prompts and the rule that chooses between them and a customer's own.
 * The regression that matters: wherever a customer or shared prompt exists, the result must be exactly what agentFor() has always
 * produced. Only a configuration with NOTHING set gets the defaults.
 */
const BODY = 'BUILT-IN CALL RULES';
const config = (over: Partial<PromptConfig> = {}): PromptConfig => ({
  sharedInstructions: null,
  greeting: null,
  promptBody: BODY,
  directions: { inbound: { instructions: null, greeting: null }, outbound: { instructions: null, greeting: null } },
  ...over,
});
const withDirection = (d: 'inbound' | 'outbound', own: { instructions?: string | null; greeting?: string | null }, over: Partial<PromptConfig> = {}) => {
  const c = config(over);
  c.directions[d] = { instructions: own.instructions ?? null, greeting: own.greeting ?? null };
  return c;
};

describe('the built-in prompts', () => {
  const texts = [DEFAULT_PROMPTS.inbound.instructions, DEFAULT_PROMPTS.inbound.greeting, DEFAULT_PROMPTS.outbound.instructions, DEFAULT_PROMPTS.outbound.greeting];

  it('say that the assistant is an AI assistant, in both directions', () => {
    for (const t of texts) expect(t, t.slice(0, 40)).toMatch(/AI assistant/);
    expect(DEFAULT_PROMPTS.inbound.instructions).toMatch(/never pretend to be a person/);
  });

  it('are short, fit the limits the dashboard enforces, and use plain words suitable for speech', () => {
    for (const t of [DEFAULT_PROMPTS.inbound.instructions, DEFAULT_PROMPTS.outbound.instructions]) {
      expect(t.length).toBeLessThan(900);
      expect(t.length).toBeLessThanOrEqual(8000);
    }
    for (const t of [DEFAULT_PROMPTS.inbound.greeting, DEFAULT_PROMPTS.outbound.greeting]) expect(t.length).toBeLessThanOrEqual(500);
  });

  it('invent nothing: no company name, number, address, price or promise, and they leave call rules and the call ending to the built-in rules', () => {
    for (const t of texts) {
      expect(t).not.toMatch(/\d{3,}/); // no phone numbers or prices
      expect(t).not.toMatch(/https?:|@|www\./i);
      expect(t).not.toMatch(/SIZH|Acme|SIM7600/);
      expect(t).not.toContain('END_CALL'); // ending the call is the built-in rules' job
    }
    expect(DEFAULT_PROMPTS.outbound.instructions).toMatch(/ask not to be called again/);
  });

  it('describe the right role for each direction', () => {
    expect(DEFAULT_PROMPTS.inbound.instructions).toMatch(/answering a phone call/);
    expect(DEFAULT_PROMPTS.outbound.instructions).toMatch(/making a phone call/);
    expect(DEFAULT_PROMPTS.outbound.greeting).toMatch(/good time/);
  });
});

describe('precedence: the customer\'s prompt, then the shared one, then the built-in default', () => {
  it('uses the built-in default for each direction when nothing is set, with the built-in call rules after it', () => {
    const inbound = selectPrompt(config(), 'inbound');
    expect(inbound.systemPrompt).toBe(`${DEFAULT_PROMPTS.inbound.instructions}\n\n${BODY}`);
    expect(inbound.greeting).toBe(DEFAULT_PROMPTS.inbound.greeting);
    expect(inbound.source).toEqual({ instructions: 'default', greeting: 'default' });
    const outbound = selectPrompt(config(), 'outbound');
    expect(outbound.systemPrompt).toBe(`${DEFAULT_PROMPTS.outbound.instructions}\n\n${BODY}`);
    expect(outbound.greeting).toBe(DEFAULT_PROMPTS.outbound.greeting);
  });

  it('prefers the direction\'s own prompt over the shared one, and the shared one over the default', () => {
    const own = selectPrompt(withDirection('inbound', { instructions: 'OWN IN', greeting: 'OWN HELLO' }, { sharedInstructions: 'SHARED', greeting: 'SHARED HELLO' }), 'inbound');
    expect(own).toMatchObject({ greeting: 'OWN HELLO', source: { instructions: 'direction', greeting: 'direction' } });
    expect(own.systemPrompt).toBe(`OWN IN\n\n${BODY}`);
    const shared = selectPrompt(config({ sharedInstructions: 'SHARED', greeting: 'SHARED HELLO' }), 'outbound');
    expect(shared).toMatchObject({ greeting: 'SHARED HELLO', source: { instructions: 'shared', greeting: 'shared' } });
    expect(shared.systemPrompt).toBe(`SHARED\n\n${BODY}`);
  });

  it('decides instructions and greeting separately, and one direction never affects the other', () => {
    const mixed = selectPrompt(withDirection('inbound', { instructions: 'OWN IN' }), 'inbound');
    expect(mixed.source).toEqual({ instructions: 'direction', greeting: 'none' }); // own instructions, no greeting: the agent waits, as it always did
    expect(mixed.greeting).toBeNull();
    const greetingOnly = selectPrompt(withDirection('inbound', { greeting: 'OWN HELLO' }), 'inbound');
    expect(greetingOnly.source).toEqual({ instructions: 'default', greeting: 'direction' }); // own greeting, default instructions
    const other = selectPrompt(withDirection('inbound', { instructions: 'OWN IN', greeting: 'OWN HELLO' }), 'outbound');
    expect(other.source).toEqual({ instructions: 'default', greeting: 'default' });
    expect(other.systemPrompt).not.toContain('OWN IN');
  });

  it('treats an empty or blank customer prompt as "not set" (this is what Restore Default stores)', () => {
    for (const blank of ['', '   ', '\n\t']) {
      const r = selectPrompt(withDirection('inbound', { instructions: blank, greeting: blank }), 'inbound');
      expect(r.source).toEqual({ instructions: 'default', greeting: 'default' });
    }
  });
});

describe('nothing changes for a configuration that already has a prompt', () => {
  const cases: Array<[string, PromptConfig, 'inbound' | 'outbound']> = [
    ['own inbound', withDirection('inbound', { instructions: 'Be the receptionist.', greeting: 'Hi there.' }), 'inbound'],
    ['own outbound', withDirection('outbound', { instructions: 'Call about the enquiry.', greeting: 'Hello.' }), 'outbound'],
    ['shared only', config({ sharedInstructions: 'Shared rules.', greeting: 'Shared hello.' }), 'inbound'],
    ['shared, other direction own', withDirection('outbound', { instructions: 'Outbound only.' }, { sharedInstructions: 'Shared rules.' }), 'inbound'],
    ['own instructions, shared greeting', withDirection('inbound', { instructions: 'Own.' }, { greeting: 'Shared hello.' }), 'inbound'],
  ];
  it.each(cases)('gives the same system prompt and greeting as agentFor(): %s', (_name, c, direction) => {
    const now = selectPrompt(c, direction);
    const before = agentFor(c as never, direction);
    expect(now.systemPrompt).toBe(before.systemPrompt);
    expect(now.greeting).toBe(before.greeting);
  });

  it('only differs from agentFor() where nothing was set: there it used to give no instructions and no greeting', () => {
    const before = agentFor(config() as never, 'inbound');
    expect(before).toMatchObject({ systemPrompt: BODY, greeting: null });
    expect(selectPrompt(config(), 'inbound').systemPrompt).not.toBe(BODY);
  });

  it('matches what the real configuration parser produces from the stored settings', () => {
    // The settings the dashboard saves become these variables (settings.ts envWith); the parser turns them into the config used above.
    const parsed = loadAiConfig({ AI_INBOUND_INSTRUCTIONS: 'Saved by the customer.', AI_OUTBOUND_INSTRUCTIONS: '', AI_ENABLED: 'true' } as Record<string, string | undefined>).config;
    expect(selectPrompt(parsed, 'inbound').source.instructions).toBe('direction');
    expect(selectPrompt(parsed, 'outbound').source.instructions).toBe('default'); // an empty saved value means "not set"
    expect(selectPrompt(parsed, 'inbound').systemPrompt.startsWith('Saved by the customer.')).toBe(true);
  });
});
