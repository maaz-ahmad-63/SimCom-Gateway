/** What GET /api/integrations/google-sheets returns. The key itself is never part of it. */
export interface SheetsConfig {
  enabled: boolean;
  spreadsheetId: string;
  sheetName: string;
  inboundTools: boolean;
  outboundTools: boolean;
  logOutcomes: boolean;
}

export interface SheetsTestStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SheetsTestResult {
  ok: boolean;
  at: string;
  steps: SheetsTestStep[];
  advice: string | null;
}

export interface SheetsStatus {
  config: SheetsConfig;
  credential: { stored: boolean; serviceAccountEmail: string | null; undecryptable: boolean };
  secretStorageAvailable: boolean;
  lastTest: SheetsTestResult | null;
  columns: string[];
  /** Whether the selected language model accepts function calling (the gateway's answer, from its model catalog). */
  modelTools: { model: string; provider: string | null; supported: boolean };
}

const DEFAULT_ID = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * The spreadsheet ID from whatever the operator pasted: the bare ID, or the sheet's URL (the part between /d/ and the next slash).
 * Anything else comes back unchanged so the validator can say what is wrong with it.
 */
export function spreadsheetIdFrom(input: string): string {
  const text = input.trim();
  const fromUrl = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(text)?.[1];
  return fromUrl ?? text;
}

export function tabNameProblem(name: string): string | null {
  if (name.trim() === '') return 'Enter the tab name (for example Calls)';
  if (name.length > 100) return 'The tab name is limited to 100 characters';
  if (/[\u0000-\u001f[\]*?:/\\]/.test(name)) return 'A tab name cannot contain [ ] * ? : / \\';
  return null;
}

/** Problems with the settings, shown before Save. The gateway checks them again. */
export function validateSheetsDraft(draft: SheetsConfig, credentialStored: boolean): string[] {
  const problems: string[] = [];
  if (draft.spreadsheetId !== '' && !DEFAULT_ID.test(draft.spreadsheetId)) problems.push('The spreadsheet ID does not look right: paste the sheet’s link or the ID between /d/ and /edit');
  const tab = tabNameProblem(draft.sheetName);
  if (tab) problems.push(tab);
  if (draft.enabled && draft.spreadsheetId === '') problems.push('Enter the spreadsheet before turning this on');
  if (draft.enabled && !credentialStored) problems.push('Store the service account key before turning this on');
  return problems;
}

/** Only what changed, shaped for PUT /api/integrations/google-sheets. */
export function sheetsPatch(original: SheetsConfig, draft: SheetsConfig): Partial<SheetsConfig> {
  const patch: Partial<SheetsConfig> = {};
  for (const key of Object.keys(draft) as Array<keyof SheetsConfig>) {
    if (draft[key] !== original[key]) (patch as Record<string, unknown>)[key] = draft[key];
  }
  return patch;
}

/**
 * A quick look at pasted key-file text, so an obvious mistake is caught before it is sent. It never repeats any of the text back:
 * the message names the problem only.
 */
export function keyFileProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return 'That is not valid JSON: paste the whole key file you downloaded from Google Cloud';
  }
  const file = parsed as { type?: unknown; client_email?: unknown; private_key?: unknown } | null;
  if (!file || typeof file !== 'object' || file.type !== 'service_account') return 'This is not a service account key (its "type" must be "service_account")';
  if (typeof file.client_email !== 'string' || !file.client_email.includes('@')) return 'The key file has no client_email';
  if (typeof file.private_key !== 'string' || !file.private_key.includes('PRIVATE KEY')) return 'The key file has no private_key';
  return null;
}

export type NoteTone = 'good' | 'warn' | 'neutral';

/** What to tell the operator about the selected model and tool calling. Never a silent no-op. */
export function modelToolsNote(model: SheetsStatus['modelTools'] | null | undefined, anyToolOn: boolean): { tone: NoteTone; text: string } {
  if (!model || typeof model.supported !== 'boolean') {
    return { tone: 'warn', text: 'The gateway did not report whether the selected model supports function calling, so it cannot be confirmed. Reload this page; if it persists, check the gateway version.' };
  }
  if (model.supported) return { tone: 'good', text: `${model.model} supports function calling.` };
  return {
    tone: anyToolOn ? 'warn' : 'neutral',
    text: `${model.model} is not known to support function calling, so the agent will not be given the save tool on any call. Contact details are still collected and confirmed by voice. Choose a model that supports it (for example an OpenAI, Groq or Gemini model) on the Language Model tab.`,
  };
}
