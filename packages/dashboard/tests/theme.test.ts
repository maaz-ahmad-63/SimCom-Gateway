import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyTheme, readThemeChoice, resolveTheme, saveThemeChoice, THEME_BOOT_SCRIPT, THEME_STORAGE_KEY } from '../src/lib/theme';

const SRC = path.resolve(__dirname, '../src');
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(tsx|ts)$/.test(e.name) ? [path.join(dir, e.name)] : []));

describe('theme choice', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };

  it('remembers light or dark, and "system" means nothing saved', () => {
    const s = store();
    expect(readThemeChoice(s)).toBe('system');
    saveThemeChoice(s, 'light');
    expect(s.m.get(THEME_STORAGE_KEY)).toBe('light');
    expect(readThemeChoice(s)).toBe('light');
    saveThemeChoice(s, 'system');
    expect(s.m.has(THEME_STORAGE_KEY)).toBe(false);
  });

  it('a blocked or broken storage falls back to the system theme and never throws', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(readThemeChoice(broken)).toBe('system');
    expect(() => saveThemeChoice(broken, 'dark')).not.toThrow();
    expect(readThemeChoice({ getItem: () => 'purple' })).toBe('system');
    expect(readThemeChoice(null)).toBe('system');
  });

  it('resolves the system choice from the operating system preference and applies exactly one class', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
    const classes = new Set(['dark', 'other']);
    applyTheme({ classList: { add: (c) => void classes.add(c), remove: (...c) => c.forEach((x) => classes.delete(x)) } }, 'light');
    expect(Array.from(classes).sort()).toEqual(['light', 'other']);
  });

  it('the boot script reads the same key and is guarded', () => {
    expect(THEME_BOOT_SCRIPT).toContain(THEME_STORAGE_KEY);
    expect(THEME_BOOT_SCRIPT).toMatch(/^\(function\(\)\{try\{/);
    expect(THEME_BOOT_SCRIPT).toContain('prefers-color-scheme: light');
  });
});

describe('every component follows the theme tokens', () => {
  const css = fs.readFileSync(path.join(SRC, 'app/globals.css'), 'utf8');
  const config = fs.readFileSync(path.resolve(__dirname, '../tailwind.config.ts'), 'utf8');
  const TOKENIZED = ['slate', 'cyan', 'blue', 'emerald', 'amber', 'rose', 'red', 'purple', 'orange'];

  it('uses only colour palettes that are theme tokens (light and dark values exist for each shade)', () => {
    const used = new Set<string>();
    for (const f of files(SRC)) {
      const re = /\b(?:bg|text|border|ring|from|to|via|divide|placeholder|accent|outline|fill|stroke|decoration)-([a-z]+)-(\d{2,3})\b/g;
      const text = fs.readFileSync(f, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) used.add(m[1]);
    }
    const untokenized = Array.from(used).filter((p) => !TOKENIZED.includes(p));
    expect(untokenized).toEqual([]);
    for (const p of TOKENIZED) {
      expect(config).toContain(`${p}: scale('${p}')`);
      for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) expect(css.match(new RegExp(`--${p}-${step}:`, 'g'))?.length, `${p}-${step}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('has no hard-coded colours in class names', () => {
    const offenders = files(SRC).filter((f) => /\b(?:bg|text|border|from|to|via)-\[#[0-9a-fA-F]{3,8}\]/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('defines both themes, and the brand bar keeps its own navy in both', () => {
    expect(css).toMatch(/:root\.light\s*\{/);
    expect(css).toMatch(/\.theme-dark\s*\{/);
    const light = css.slice(css.indexOf(':root.light'));
    expect(light).toMatch(/--brand-bar:\s*9 14 27;/);
    expect(css.slice(0, css.indexOf(':root.light'))).toMatch(/--brand-bar:\s*9 14 27;/);
  });

  it('shows the supplied logo file as supplied (no recreated or recoloured logo)', () => {
    const header = fs.readFileSync(path.join(SRC, 'components/layout/Header.tsx'), 'utf8');
    expect(header).toContain('src="/brand/sizh-logo.png"');
    expect(fs.existsSync(path.resolve(__dirname, '../public/brand/sizh-logo.png'))).toBe(true);
  });
});
