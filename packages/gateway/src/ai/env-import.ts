/**
 * Parses pasted .env text for the API-key import. Only the parsing: deciding which names are provider keys, and storing them, is the
 * runtime's job (the registry's credential names are the source of truth). Values are never logged, and nothing here keeps them.
 *
 * Accepted: KEY=value, `export KEY=value`, single- or double-quoted values (double quotes understand \" \\ \n), values containing '=',
 * inline comments after an unquoted value (" # ..."), comments and blank lines. A name that appears twice keeps its LAST value, as a
 * shell sourcing the file would.
 */

export interface EnvEntry {
  line: number;
  name: string;
  value: string;
}

export interface EnvProblem {
  line: number;
  name: string | null;
  reason: string;
}

export interface EnvParseResult {
  entries: EnvEntry[];
  problems: EnvProblem[];
  /** Names given more than once (the last one is used). */
  duplicates: string[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_IMPORT_CHARS = 200_000;

function unquote(raw: string, line: number, name: string): { value: string } | EnvProblem {
  const q = raw[0];
  if (q !== '"' && q !== "'") {
    // Unquoted: an inline comment starts at " #"; the value is what is before it.
    const hash = raw.search(/\s#/);
    return { value: (hash >= 0 ? raw.slice(0, hash) : raw).trim() };
  }
  let out = '';
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i];
    if (q === '"' && c === '\\' && i + 1 < raw.length) {
      const n = raw[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      continue;
    }
    if (c === q) {
      const rest = raw.slice(i + 1).trim();
      if (rest !== '' && !rest.startsWith('#')) return { line, name, reason: 'unexpected text after the closing quote' };
      return { value: out };
    }
    out += c;
  }
  return { line, name, reason: 'the quoted value has no closing quote' };
}

export function parseEnvText(text: string): EnvParseResult {
  const byName = new Map<string, EnvEntry>();
  const problems: EnvProblem[] = [];
  const duplicates = new Set<string>();
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  lines.forEach((rawLine, index) => {
    const line = index + 1;
    let s = rawLine.trim();
    if (s === '' || s.startsWith('#')) return;
    if (/^export\s+/.test(s)) s = s.replace(/^export\s+/, '');
    const eq = s.indexOf('=');
    if (eq <= 0) {
      problems.push({ line, name: null, reason: 'not a NAME=value line' });
      return;
    }
    const name = s.slice(0, eq).trim();
    if (!NAME.test(name)) {
      problems.push({ line, name: null, reason: 'the name is not a valid variable name' });
      return;
    }
    const parsed = unquote(s.slice(eq + 1).trim(), line, name);
    if ('reason' in parsed) {
      problems.push(parsed);
      return;
    }
    if (byName.has(name)) duplicates.add(name);
    byName.set(name, { line, name, value: parsed.value });
  });
  return { entries: [...byName.values()], problems, duplicates: [...duplicates] };
}

/**
 * Other names people's .env files commonly use for the same provider key (vendor SDK defaults). Only mapped when the target is a
 * credential this gateway stores; when both names are given, the gateway's own name wins. Never GATEWAY_API_KEY: that is the gateway's
 * own access key, not a provider key.
 */
export const CREDENTIAL_ALIASES: Readonly<Record<string, string>> = {
  ELEVEN_API_KEY: 'ELEVENLABS_API_KEY',
  XI_API_KEY: 'ELEVENLABS_API_KEY',
  GOOGLE_API_KEY: 'GEMINI_API_KEY',
  GOOGLE_GENERATIVE_AI_API_KEY: 'GEMINI_API_KEY',
};

/** The same rule the encrypted store enforces (8-512 characters, no whitespace or control characters), plus obvious placeholders. */
export function apiKeyProblem(value: string): string | null {
  const v = value.trim();
  if (v === '') return 'the value is empty';
  if (v.length < 8 || v.length > 512 || /[\s\u0000-\u001f]/.test(v)) return 'does not look like an API key (8-512 characters, no spaces)';
  if (/^(<.*>|your[_-]?.*|changeme|change[_-]me|placeholder|x{4,}|\*{4,}|todo|none|null|undefined)$/i.test(v)) return 'looks like a placeholder, not a real key';
  return null;
}
