import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSelection, importSummary, CredentialImportPreview, replacementsIn } from '../src/lib/env-import';

const preview: CredentialImportPreview = {
  recognized: [
    { name: 'GROQ_API_KEY', provider: 'Groq', line: 1, action: 'add', masked: '••••0111', overridesEnv: false },
    { name: 'OPENAI_API_KEY', provider: 'OpenAI', line: 2, action: 'unchanged', masked: '••••2333', overridesEnv: false },
    { name: 'INWORLD_API_KEY', provider: 'Inworld', line: 3, action: 'update', masked: '••••PT0=', overridesEnv: false },
  ],
  invalid: [{ line: 4, name: 'DEEPGRAM_API_KEY', reason: 'looks like a placeholder' }],
  unrecognized: [{ line: 5, name: 'SQLITE_DB_PATH' }],
  duplicates: [],
  secretStorageAvailable: true,
};

describe('.env import (dashboard)', () => {
  it('selects only NEW keys by default; a key that would replace a saved one waits for the user', () => {
    expect(defaultSelection(preview)).toEqual(['GROQ_API_KEY']);
    expect(replacementsIn(preview, ['GROQ_API_KEY'])).toEqual([]);
    expect(replacementsIn(preview, ['GROQ_API_KEY', 'INWORLD_API_KEY'])).toEqual(['Inworld']);
  });

  it('summarises a result without any key value', () => {
    expect(
      importSummary({ added: [{ name: 'GROQ_API_KEY', provider: 'Groq', masked: '••••0111' }], updated: [], unchanged: [], invalid: preview.invalid, unrecognized: preview.unrecognized })
    ).toBe('1 added, 0 updated, 0 unchanged; 1 invalid, 1 not provider keys (ignored).');
  });

  it('never keeps pasted secrets in browser storage', () => {
    const src = ['src/components/settings/EnvImport.tsx', 'src/lib/env-import.ts', 'src/app/settings/api-keys/page.tsx'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    expect(src).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\s*[.[]/);
  });
});
