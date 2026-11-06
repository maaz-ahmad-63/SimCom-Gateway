/**
 * Light / dark theme. The choice ('light', 'dark' or 'system') is a per-browser convenience kept in localStorage; every read and write is
 * guarded, so a browser that blocks storage simply follows the system theme. The theme is a class on <html> ('light' or 'dark') that the
 * colour tokens in globals.css follow.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'sizh-theme';

export function readThemeChoice(storage: Pick<Storage, 'getItem'> | null | undefined): ThemeChoice {
  try {
    const v = storage?.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function saveThemeChoice(storage: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined, choice: ThemeChoice): void {
  try {
    if (choice === 'system') storage?.removeItem(THEME_STORAGE_KEY);
    else storage?.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

export function resolveTheme(choice: ThemeChoice, systemPrefersLight: boolean): Theme {
  if (choice === 'system') return systemPrefersLight ? 'light' : 'dark';
  return choice;
}

export function applyTheme(root: { classList: { add(c: string): void; remove(...c: string[]): void } }, theme: Theme): void {
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
}

/** Runs before the page paints (inline in <head>), so a light-theme user never sees a dark flash. Mirrors the functions above. */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var l=t==='light'||(t!=='dark'&&window.matchMedia('(prefers-color-scheme: light)').matches);var c=document.documentElement.classList;c.remove('light','dark');c.add(l?'light':'dark');}catch(e){}})();`;
