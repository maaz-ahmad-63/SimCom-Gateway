import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../src/ai/catalog-view.js';
import { resetActiveRegistry } from '../../src/ai/registry/active.js';
import { defaultRegistry } from '../../src/ai/registry/defaults.js';
import { RegistryStore } from '../../src/ai/registry/store.js';
import { SCHEMA_VERSION } from '../../src/ai/registry/schema.js';

/**
 * A registry.json saved by an older version (before the Inworld language model was a default) must still show the Inworld model after
 * the upgrade, without the customer pressing "Add missing defaults", and without changing anything the customer saved.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  resetActiveRegistry();
});

function savedByOlderVersion() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-upgrade-'));
  dirs.push(dir);
  const d = defaultRegistry();
  const models = d.models
    .filter((m) => !(m.stage === 'llm' && m.provider === 'inworld')) // what 0.1.3 had: no Inworld language model
    .map((m) => (m.stage === 'llm' && m.id === 'groq_gpt_oss_20b' ? { ...m, enabled: false } : m)); // the customer switched one off
  models.push({ id: 'my_own_model', stage: 'llm', provider: 'groq', protocol: 'openai-chat', model: 'my-own/model', label: 'My own model', enabled: true, aliases: [], options: { body: {}, tools: false } } as never);
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, providers: d.providers, models }, null, 2));
  return dir;
}

describe('a registry saved by an older version gets the defaults a newer version added', () => {
  it('the Inworld language model appears in the catalog after loading; the customer’s own changes are kept', () => {
    const dir = savedByOlderVersion();
    const store = new RegistryStore({ dir });
    expect(store.load().ok).toBe(true);
    const llm = buildCatalog({ INWORLD_API_KEY: 'x'.repeat(24) }).llm;
    expect(llm.find((o) => o.key === 'inworld_gpt_5_4')).toMatchObject({ provider: 'inworld', model: 'openai/gpt-5.4', implemented: true });
    expect(llm.find((o) => o.key === 'groq_gpt_oss_20b')).toMatchObject({ implemented: false, unavailableReason: 'Switched off in the model registry' }); // still off
    expect(llm.find((o) => o.key === 'my_own_model')).toMatchObject({ label: 'My own model' }); // still there
  });

  it('the saved file is not rewritten by loading; the next change writes the complete list, and a restart keeps it', () => {
    const dir = savedByOlderVersion();
    const before = fs.readFileSync(path.join(dir, 'registry.json'), 'utf8');
    const store = new RegistryStore({ dir });
    store.load();
    expect(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8')).toBe(before);
    expect(store.upsertModel({ ...store.file().models.find((m) => m.id === 'my_own_model')!, label: 'Renamed' }).ok).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8')) as { models: Array<{ id: string }> };
    expect(saved.models.some((m) => m.id === 'inworld_gpt_5_4')).toBe(true);
    resetActiveRegistry();
    const again = new RegistryStore({ dir });
    again.load();
    expect(buildCatalog({}).llm.some((o) => o.key === 'inworld_gpt_5_4')).toBe(true);
    expect(buildCatalog({}).llm.find((o) => o.key === 'my_own_model')?.label).toBe('Renamed');
  });
});

describe('the Inworld Gemma model', () => {
  it('is built in with the model id Inworld serves, and a customer who added it by hand keeps their own entry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-gemma-'));
    dirs.push(dir);
    const d = defaultRegistry();
    expect(d.models.find((m) => m.id === 'inworld_gemma_4_31b')).toMatchObject({ provider: 'inworld', protocol: 'openai-chat', model: 'inworld/models/gemma-4-31b-it' });
    const models = d.models.filter((m) => !(m.stage === 'llm' && m.provider === 'inworld'));
    models.push({ id: 'inworld_gemma_4_31b', stage: 'llm', provider: 'inworld', protocol: 'openai-chat', model: 'inworld/models/gemma-4-31b-it', label: 'My Gemma (added by hand)', enabled: true, aliases: ['inworld_gemma_4_31b_it'], options: { body: {}, tools: false } } as never);
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, providers: d.providers, models }));
    const store = new RegistryStore({ dir });
    expect(store.load().ok).toBe(true);
    const llm = buildCatalog({}).llm.filter((o) => o.provider === 'inworld');
    expect(llm.map((o) => [o.key, o.label])).toEqual([
      ['inworld_gemma_4_31b', 'My Gemma (added by hand)'], // theirs, not replaced
      ['inworld_gpt_5_4', 'OpenAI GPT-5.4 (through Inworld Router)'], // added as new
    ]);
  });
});
