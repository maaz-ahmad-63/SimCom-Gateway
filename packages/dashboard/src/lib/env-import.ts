import type { AiCredentialStatus } from '@sim-gateway/shared';

/** POST /api/ai/credentials/import/preview: what an import would do. Values appear only masked (••••1234). */
export interface CredentialImportPreview {
  recognized: Array<{ name: string; provider: string; line: number; action: 'add' | 'update' | 'unchanged'; masked: string; overridesEnv: boolean }>;
  invalid: Array<{ line: number; name: string | null; reason: string }>;
  unrecognized: Array<{ line: number; name: string }>;
  duplicates: string[];
  secretStorageAvailable: boolean;
}

/** POST /api/ai/credentials/import/apply */
export interface CredentialImportResult {
  added: Array<{ name: string; provider: string; masked: string }>;
  updated: Array<{ name: string; provider: string; masked: string }>;
  unchanged: Array<{ name: string; provider: string; masked: string }>;
  invalid: CredentialImportPreview['invalid'];
  unrecognized: CredentialImportPreview['unrecognized'];
  duplicates: string[];
  credentials: AiCredentialStatus[];
}

export const ACTION_LABEL: Record<CredentialImportPreview['recognized'][number]['action'], string> = { add: 'Add', update: 'Update', unchanged: 'Unchanged' };

/** The names selected by default: everything that would change something. */
export const defaultSelection = (p: CredentialImportPreview): string[] => p.recognized.filter((r) => r.action !== 'unchanged').map((r) => r.name);

/** One sentence for the result of an import. */
export function importSummary(r: Pick<CredentialImportResult, 'added' | 'updated' | 'unchanged' | 'invalid' | 'unrecognized'>): string {
  const n = (count: number, word: string) => `${count} ${word}`;
  const parts = [n(r.added.length, 'added'), n(r.updated.length, 'updated'), n(r.unchanged.length, 'unchanged')];
  const skipped = [r.invalid.length ? `${r.invalid.length} invalid` : '', r.unrecognized.length ? `${r.unrecognized.length} not provider keys (ignored)` : ''].filter(Boolean);
  return `${parts.join(', ')}${skipped.length ? `; ${skipped.join(', ')}` : ''}.`;
}
