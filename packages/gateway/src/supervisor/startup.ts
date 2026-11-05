/**
 * What happens when the customer clicks the application icon.
 *
 * The rule: the browser is opened only when the gateway AND the dashboard have both answered a health check. Anything else ends in a
 * plain message that says what is wrong and where the log is; a dead page is never opened. Every side effect (starting a process,
 * asking a port, opening a window) is passed in, so each outcome can be tested without starting anything.
 */

export type StartupFailure = 'DATA_DIR' | 'PORT_CONFLICT' | 'SUPERVISOR_EXITED' | 'SERVICE_FAILED' | 'TIMEOUT';

export type StartupResult = { ok: true; url: string; reusedExisting: boolean } | { ok: false; code: StartupFailure; title: string; message: string };

export interface HttpAnswer {
  status: number;
  body: string;
}

export interface StartupDeps {
  ports: { dashboard: number; gateway: number; status: number };
  /** One GET. null means nothing answered (refused, reset or too slow). */
  http: (url: string) => Promise<HttpAnswer | null>;
  /** Starts the supervisor in the background. `exited()` says whether it has already ended, `exitCode()` how. */
  spawnSupervisor: () => { exited: () => boolean; exitCode: () => number | null };
  /** What is listening on a TCP port, for example "node.exe (process 4120)"; null when the port is free. */
  portOwner: (port: number) => Promise<string | null>;
  dataDirWritable: () => { ok: boolean; error?: string };
  dataDir: string;
  logDir: string;
  /** The last lines of the supervisor's own log, for the message. */
  logTail: () => string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  openBrowser: (url: string) => void;
  /** Open the browser at all? False for the automatic start at sign-in. */
  browser: boolean;
  firstRun: () => boolean;
  markFirstRunDone: () => void;
  /** A small "starting" window, best effort. */
  splash?: { show: (text: string) => void; hide: () => void };
  log: (message: string) => void;
  timeoutMs?: number;
  pollMs?: number;
}

const fail = (code: StartupFailure, title: string, message: string): StartupResult => ({ ok: false, code, title, message });

function parseStatus(body: string): { gateway?: { state?: string; crashLoop?: boolean; message?: string }; dashboard?: { state?: string; crashLoop?: boolean; message?: string } } | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const logHint = (d: StartupDeps) => `\n\nDetails are in the log folder:\n${d.logDir}`;

/** The supervisor's exit code when another supervisor already runs (see supervisor/main.ts). */
export const SUPERVISOR_ALREADY_RUNNING = 3;

export const isHealthy = (a: HttpAnswer | null): boolean => a !== null && a.status === 200 && /"status"\s*:\s*"ok"/.test(a.body);
export const isServing = (a: HttpAnswer | null): boolean => a !== null && a.status >= 200 && a.status < 400;

export async function startAndWait(d: StartupDeps): Promise<StartupResult> {
  const timeoutMs = d.timeoutMs ?? 120_000;
  const pollMs = d.pollMs ?? 500;

  // 1. Can anything be written? A folder the user cannot write to was the reason the first installer showed a dead page.
  const writable = d.dataDirWritable();
  if (!writable.ok) {
    return fail('DATA_DIR', 'SIZH IT Solution cannot save its data', `SIZH IT Solution cannot write to its data folder:\n${d.dataDir}\n\n${writable.error ?? ''}\n\nRun the SIZH IT Solution installer again to repair the folder permissions, or ask your administrator to give your Windows account write access to that folder.`.replace(/\n\n\n/g, '\n\n'));
  }

  // 2. Is it already running? Then there is nothing to start: only wait for it.
  const existing = await d.http(`http://127.0.0.1:${d.ports.status}/status`);
  const reused = existing !== null && existing.status === 200;
  let handle: { exited: () => boolean; exitCode: () => number | null } | null = null;
  if (reused) {
    d.log('SIZH IT Solution is already running; waiting for it to be ready');
  } else {
    // 3. Is something else using a port we need? Say what, instead of letting a service crash on it.
    const needs: Array<[number, string]> = [
      [d.ports.dashboard, 'the dashboard'],
      [d.ports.gateway, 'the gateway'],
      [d.ports.status, 'the status page'],
    ];
    for (const [port, what] of needs) {
      const owner = await d.portOwner(port);
      if (owner) {
        return fail(
          'PORT_CONFLICT',
          'A port SIZH IT Solution needs is in use',
          `Port ${port} (used by ${what}) is already taken by ${owner}.\n\nIf an old copy of SIZH IT Solution is still running, close it from Task Manager (or restart the computer). Otherwise close the program that uses port ${port}, then start SIZH IT Solution again.${logHint(d)}`
        );
      }
    }
    d.log('starting the supervisor');
    handle = d.spawnSupervisor();
  }

  // 4. Wait until both services answer.
  const deadline = d.now() + timeoutMs;
  let splashShown = false;
  let lastGateway = false;
  let lastDashboard = false;
  for (;;) {
    const gateway = await d.http(`http://127.0.0.1:${d.ports.gateway}/health`);
    const dashboard = await d.http(`http://127.0.0.1:${d.ports.dashboard}/`);
    lastGateway = isHealthy(gateway);
    lastDashboard = isServing(dashboard);
    if (lastGateway && lastDashboard) break;

    if (!splashShown && d.browser) {
      d.splash?.show('Starting SIZH IT Solution… the first start can take up to a minute.');
      splashShown = true;
    }
    if (handle && handle.exited()) {
      // The supervisor ended before the services were up. Exit code 3 means "another supervisor already holds the lock" (two quick clicks):
      // the one that is running is starting the services, so keep waiting for it. Anything else is a real failure, unless a supervisor is
      // already answering its status page.
      if (handle.exitCode() === SUPERVISOR_ALREADY_RUNNING) {
        d.log('another supervisor is already starting the services; waiting for it');
        handle = null;
      }
    }
    if (handle && handle.exited()) {
      const status = await d.http(`http://127.0.0.1:${d.ports.status}/status`);
      if (!(status && status.status === 200)) {
        d.splash?.hide();
        return fail('SUPERVISOR_EXITED', 'SIZH IT Solution could not start', `The SIZH IT Solution program stopped right after it started (exit code ${handle.exitCode() ?? 'unknown'}).\n\n${d.logTail() ? `Last log lines:\n${d.logTail()}` : 'It wrote nothing to its log.'}${logHint(d)}`);
      }
    }
    const st = await d.http(`http://127.0.0.1:${d.ports.status}/status`);
    const parsed = st && st.status === 200 ? parseStatus(st.body) : null;
    for (const name of ['gateway', 'dashboard'] as const) {
      const s = parsed?.[name];
      if (s && (s.crashLoop || s.state === 'failed')) {
        d.splash?.hide();
        return fail('SERVICE_FAILED', `The ${name} could not start`, `The ${name} keeps stopping after it starts, so SIZH IT Solution gave up restarting it.\n\n${s.message ?? ''}\n\n${d.logTail() ? `Last log lines:\n${d.logTail()}` : ''}${logHint(d)}`.replace(/\n{3,}/g, '\n\n'));
      }
    }
    if (d.now() >= deadline) {
      d.splash?.hide();
      const waiting = [!lastGateway && 'the gateway', !lastDashboard && 'the dashboard'].filter(Boolean).join(' and ');
      return fail('TIMEOUT', 'SIZH IT Solution is taking too long to start', `${waiting.charAt(0).toUpperCase()}${waiting.slice(1)} did not become ready within ${Math.round(timeoutMs / 1000)} seconds.\n\nWait a minute and click the icon again. If it keeps happening, send the log folder to support.${logHint(d)}`);
    }
    await d.sleep(pollMs);
  }
  d.splash?.hide();

  // 5. Ready. Only now is the browser opened.
  const first = d.firstRun();
  const url = `http://127.0.0.1:${d.ports.dashboard}${first ? '/setup' : '/'}`;
  if (d.browser) d.openBrowser(url);
  if (first) d.markFirstRunDone();
  d.log(`ready: ${url}`);
  return { ok: true, url, reusedExisting: reused };
}

/** The last `lines` non-empty lines of a text. */
export function tailLines(text: string, lines = 12): string {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-lines).join('\n');
}

/** Pull "node.exe (process 123)" out of `netstat -ano` and `tasklist` output for a listening port. */
export function ownerFromNetstat(netstat: string, port: number, imageOf: (pid: number) => string | null): string | null {
  for (const line of netstat.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i').exec(line);
    if (m) {
      const pid = Number(m[1]);
      const image = imageOf(pid);
      return image ? `${image} (process ${pid})` : `another program (process ${pid})`;
    }
  }
  return null;
}
