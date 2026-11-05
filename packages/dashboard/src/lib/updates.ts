/** What the dashboard knows about updates, and the three requests it can make. The supervisor does the work; see /api/update. */

export interface UpdateResultView {
  outcome: 'updated' | 'rolled_back' | 'failed' | 'recovered';
  fromVersion: string;
  toVersion: string;
  at: string;
  reason?: string;
}

export interface UpdateView {
  configured: boolean;
  currentVersion: string;
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'error';
  checkedAt: string | null;
  available: { version: string; notes?: string; publishedAt: string; size: number } | null;
  error: { code: string; message: string } | null;
  lastResult: UpdateResultView | null;
  canApply: boolean;
  cannotApplyReason: string | null;
}

export type UpdateAnswer = { ok: true; update: UpdateView } | { ok: false; code: string; message: string; update?: UpdateView };

const HEADERS = { 'x-dashboard-sms': '1' };

async function call(path: string, method: 'GET' | 'POST', doFetch: typeof fetch): Promise<UpdateAnswer> {
  try {
    const res = await doFetch(path, { method, headers: method === 'POST' ? { ...HEADERS, 'content-type': 'application/json' } : HEADERS, body: method === 'POST' ? '{}' : undefined, cache: 'no-store' });
    const body = (await res.json()) as { success?: boolean; update?: UpdateView; code?: string; error?: string };
    if (res.ok && body.success && body.update) return { ok: true, update: body.update };
    return { ok: false, code: body.code ?? 'ERROR', message: body.error ?? 'The update request failed.', update: body.update };
  } catch {
    return { ok: false, code: 'UNREACHABLE', message: 'The update service could not be reached.' };
  }
}

export const updateApi = (doFetch: typeof fetch = fetch) => ({
  status: () => call('/api/update', 'GET', doFetch),
  check: () => call('/api/update/check', 'POST', doFetch),
  apply: () => call('/api/update/apply', 'POST', doFetch),
});

export const formatSize = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(0)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export type Notice = { tone: 'good' | 'warn' | 'bad' | 'neutral'; title: string; detail?: string };

/** The one sentence to show about the state of updates. */
export function summarize(u: UpdateView): Notice {
  if (u.phase === 'installing') return { tone: 'neutral', title: 'Installing the update', detail: 'The program restarts on the new version in a minute. This page reconnects by itself.' };
  if (u.phase === 'downloading' || u.phase === 'verifying') return { tone: 'neutral', title: u.phase === 'downloading' ? 'Downloading the update' : 'Checking the update', detail: 'Your calls and settings are not touched.' };
  if (u.phase === 'checking') return { tone: 'neutral', title: 'Checking for updates' };
  if (u.error) return { tone: 'bad', title: 'Update problem', detail: u.error.message };
  if (u.available) return { tone: 'good', title: `Version ${u.available.version} is available`, detail: u.available.notes };
  if (!u.configured) return { tone: 'neutral', title: 'Updates are not set up', detail: 'This installation has no update address or signing key yet.' };
  return { tone: 'neutral', title: 'You have the latest version', detail: u.checkedAt ? `Last checked ${new Date(u.checkedAt).toLocaleString()}` : undefined };
}

/** What happened to the previous attempt, if there is something to say. A rolled-back update is always worth saying. */
export function lastResultNotice(r: UpdateResultView | null, currentVersion: string): Notice | null {
  if (!r) return null;
  if (r.outcome === 'updated' && r.toVersion === currentVersion) return { tone: 'good', title: `Updated to version ${r.toVersion}`, detail: `From version ${r.fromVersion}. Your data, settings and prompts were kept.` };
  if (r.outcome === 'rolled_back') return { tone: 'warn', title: `The update to ${r.toVersion} did not work and was undone`, detail: `${r.reason ?? ''} You are on version ${currentVersion} again; nothing was lost.`.trim() };
  if (r.outcome === 'recovered') return { tone: 'warn', title: 'An interrupted update was repaired', detail: `${r.reason ?? ''} You are on version ${currentVersion}.`.trim() };
  if (r.outcome === 'failed') return { tone: 'warn', title: `The update to ${r.toVersion} could not be installed`, detail: r.reason };
  return null;
}
