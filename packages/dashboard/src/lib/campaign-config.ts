/**
 * Types and pure helpers for a campaign's own AI configuration (its prompt and model), the flexible CSV import and the token report.
 * The gateway validates and decides everything; this only shapes what is sent and what is shown, and states plainly what the provider
 * reported and what it did not.
 */

/** The longest campaign prompt. The gateway refuses a longer one (it never cuts it short); this is checked first so the operator sees why. */
export const PROMPT_MAX_CHARS = 10_000;

export interface CampaignConfig {
  /** 0 means none has been saved: the campaign still uses the agent's own instructions. */
  version: number;
  prompt: string;
  promptSha: string;
  promptChars: number;
  /** A Model Hub model chosen for this campaign, or null for the gateway's selected model. */
  llmKey: string | null;
  createdAt: string | null;
}

/** Length as the gateway measures it: line endings are made uniform (CRLF counts once), nothing else is changed. */
export function promptLength(text: string): number {
  return text.replace(/\r\n?/g, '\n').length;
}

export interface PromptCounter {
  used: number;
  max: number;
  remaining: number;
  over: boolean;
}

export function promptCounter(text: string): PromptCounter {
  const used = promptLength(text);
  return { used, max: PROMPT_MAX_CHARS, remaining: PROMPT_MAX_CHARS - used, over: used > PROMPT_MAX_CHARS };
}

/** The message shown while the prompt is too long (the gateway says the same and saves nothing). Null when it fits. */
export function promptProblem(text: string): string | null {
  const { used, over } = promptCounter(text);
  if (!over) return null;
  return `The prompt is ${used.toLocaleString('en-US')} characters; the limit is ${PROMPT_MAX_CHARS.toLocaleString('en-US')}. Shorten it by ${(used - PROMPT_MAX_CHARS).toLocaleString('en-US')} characters. Nothing is cut off for you.`;
}

export interface ConfigDraft {
  prompt: string;
  llmKey: string | null;
}

export const draftFromConfig = (c: CampaignConfig): ConfigDraft => ({ prompt: c.prompt, llmKey: c.llmKey });

/** Whether the editor holds something different from what is saved. */
export function configDirty(saved: CampaignConfig, draft: ConfigDraft): boolean {
  return draft.prompt.replace(/\r\n?/g, '\n') !== saved.prompt || draft.llmKey !== saved.llmKey;
}

/** What is sent to save: only the parts that changed. */
export function configPatch(saved: CampaignConfig, draft: ConfigDraft): { prompt?: string; llmKey?: string | null } {
  const patch: { prompt?: string; llmKey?: string | null } = {};
  if (draft.prompt.replace(/\r\n?/g, '\n') !== saved.prompt) patch.prompt = draft.prompt;
  if (draft.llmKey !== saved.llmKey) patch.llmKey = draft.llmKey;
  return patch;
}

// ---- model choices ---------------------------------------------------------------------------------------------------------------

export interface LlmCaching {
  vendor: string;
  promptCaching: 'automatic' | 'automatic-on-supported-models' | 'provider-dependent' | 'not-documented';
  reportsCachedTokens: 'documented' | 'unconfirmed';
  minimumPrefixTokens: number | null;
  persistentSession: 'not-available-through-this-api';
  note: string;
  sources: string[];
}

export interface LlmChoice {
  key: string;
  label: string;
  provider: string;
  vendor: string;
  model: string | null;
  tools: boolean;
  available: boolean;
  unavailableReason: string | null;
  /** The model the gateway itself uses when a campaign does not choose one. */
  current: boolean;
  caching: LlmCaching;
}

const CACHING_LABEL: Record<LlmCaching['promptCaching'], string> = {
  automatic: 'automatic prompt caching',
  'automatic-on-supported-models': 'automatic prompt caching on supported models only',
  'provider-dependent': 'caching depends on the underlying model',
  'not-documented': 'no caching behaviour documented',
};

/** One line on what is known about a model's prompt caching. It never promises a saving: only the provider's usage reply shows a hit. */
export function cachingSummary(choice: LlmChoice | undefined): string {
  if (!choice) return 'Uses the gateway\'s selected model. Its caching behaviour depends on that model.';
  const c = choice.caching;
  const reporting = c.reportsCachedTokens === 'documented' ? 'cached tokens are reported in its usage' : 'whether it reports cached tokens is not confirmed';
  return `${CACHING_LABEL[c.promptCaching]}; ${reporting}. No persistent session is used: every call is a separate, stateless conversation.`;
}

// ---- CSV detection and the import preview ------------------------------------------------------------------------------------------

export interface ColumnDetection {
  column: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  candidates: string[];
  ambiguous: boolean;
  basis: 'header' | 'content' | 'none';
}

export interface AnalysisContact {
  rowNumber: number;
  name: string;
  phoneRaw: string;
  phoneE164: string | null;
  status: 'queued' | 'skipped';
  skipReason: string | null;
  customFields: Record<string, string>;
}

export interface CsvAnalysis {
  summary: {
    total: number;
    callable: number;
    invalidNumber: number;
    duplicate: number;
    missingName: number;
    optedOut: number;
    doNotCall: number;
    consentDeclined: number;
    consentUnknown: number;
  };
  customColumns: string[];
  problems: Array<{ rowNumber: number; reason: string }>;
  contacts: AnalysisContact[];
}

/** Which required column still needs the person's decision, as a sentence each (empty when the detection can be accepted as it is). */
export function detectionQuestions(detection: { name: ColumnDetection; phone: ColumnDetection } | undefined): string[] {
  if (!detection) return [];
  const out: string[] = [];
  const ask = (label: string, d: ColumnDetection) => {
    if (!d.ambiguous) return;
    if (!d.column) out.push(`No column looks like the ${label}. Choose which column holds it.`);
    else if (d.candidates.length > 0) out.push(`More than one column could be the ${label} (${[d.column, ...d.candidates].map((c) => `“${c}”`).join(', ')}). Choose the right one.`);
    else out.push(`The ${label} column “${d.column}” is only a guess. Check it, or choose another.`);
  };
  ask('contact name', detection.name);
  ask('phone number', detection.phone);
  return out;
}

// ---- a contact's own information ----------------------------------------------------------------------------------------------------

/** The information that came with one contact, as labelled lines: its notes first, then every custom column of the file, in file order. */
export function contactFields(contact: { context: string; extra: Record<string, string> }): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (contact.context) out.push(['Notes', contact.context]);
  for (const [key, value] of Object.entries(contact.extra ?? {})) if (value) out.push([key, value]);
  return out;
}

// ---- token usage -------------------------------------------------------------------------------------------------------------------

export interface UsageTotals {
  calls: number;
  turns: number;
  turnsWithUsage: number;
  inputTokens: number;
  outputTokens: number;
  /** null: no turn reported a cache figure, which is not the same as zero. */
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  turnsReportingCache: number;
  uncachedInputTokens: number | null;
  inputTokensOnTurnsReportingCache: number | null;
}

export interface UsageCall {
  callId: string;
  contactId: number;
  contactName: string;
  attemptStartedAt: string;
  configVersion: number | null;
  llm: string | null;
  turns: number;
  turnsWithUsage: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  turnsReportingCache: number;
}

export interface CampaignUsage {
  totals: UsageTotals;
  calls: UsageCall[];
}

export const formatTokens = (n: number): string => n.toLocaleString('en-US');

/**
 * What to say about a campaign's token use, only as far as the providers reported it. Cached tokens are shown separately from ordinary
 * input tokens; when no turn carried a cache figure the report says so instead of showing 0, and nothing here estimates a saving.
 */
export function usageLines(t: UsageTotals): string[] {
  if (t.calls === 0) return ['No calls have been placed from this campaign yet.'];
  if (t.turnsWithUsage === 0) return [`${t.calls} call(s), ${t.turns} turn(s), but the provider reported no token counts for them.`];
  const lines = [`${formatTokens(t.inputTokens)} input and ${formatTokens(t.outputTokens)} output tokens over ${t.turnsWithUsage} turn(s) with usage (${t.calls} call(s)).`];
  if (t.turnsReportingCache === 0) {
    lines.push('The provider did not report cached tokens for any turn, so cache use is unknown (it is not zero).');
  } else {
    lines.push(
      `On the ${t.turnsReportingCache} turn(s) where the provider reported cache use: ${formatTokens(t.cachedInputTokens ?? 0)} of ${formatTokens(t.inputTokensOnTurnsReportingCache ?? 0)} input tokens were served from its prompt cache, ${formatTokens(t.uncachedInputTokens ?? 0)} were not.`
    );
    if (t.turnsReportingCache < t.turnsWithUsage) lines.push(`${t.turnsWithUsage - t.turnsReportingCache} other turn(s) did not report cache use.`);
    if ((t.cacheWriteTokens ?? 0) > 0) lines.push(`${formatTokens(t.cacheWriteTokens ?? 0)} tokens were reported as written to the cache.`);
  }
  return lines;
}
