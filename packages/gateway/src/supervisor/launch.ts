import { ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile, resolveLayout } from './launcher.js';
import { resetMasterKey } from './master-key.js';
import { HttpAnswer, ownerFromNetstat, startAndWait, StartupDeps, tailLines } from './startup.js';

/**
 * The program behind the Start-menu and desktop icons ("SIZH IT Solution"). Run by the bundled Node, hidden by the small SimGateway.js
 * wrapper, so the customer sees no console and types no command.
 *
 *   launch.js              start (or find) SIZH IT Solution, wait until it is healthy, then open the dashboard
 *   launch.js --no-browser the same, without opening a browser (the automatic start at Windows sign-in)
 *   launch.js --stop       stop it cleanly (refuses while a call is in progress; add --force to stop anyway)
 *   launch.js --reset-secrets  after a confirmation, replace the encryption key for saved API keys (they must be entered again)
 *
 * It never talks to the modem. Exit code 0 means ready (or stopped); 1 means a problem was shown to the customer and written to the log.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = process.env.SIMGW_APP_DIR?.trim() || path.resolve(here, '..', '..', '..');
const layout = resolveLayout(appDir);
const logDir = path.join(layout.dataDir, 'logs');
const args = process.argv.slice(2);
const noBrowser = args.includes('--no-browser');

function configValues(): Record<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(layout.configFile, 'utf8'));
  } catch {
    return {};
  }
}

const ports = {
  dashboard: Number(process.env.SIMGW_DASHBOARD_PORT) || 3000,
  gateway: Number(configValues().PORT) || 4000,
  status: Number(process.env.SIMGW_STATUS_PORT) || 4010,
};

function log(message: string): void {
  const line = `${new Date().toISOString()} [launcher] ${message}\n`;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, 'launcher.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, line);
  } catch {
    /* the message is also shown to the customer when it matters */
  }
}

function get(url: string, method = 'GET', headers: Record<string, string> = {}): Promise<HttpAnswer | null> {
  return new Promise((resolve) => {
    const req = http.request(url, { method, headers, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += String(c).slice(0, 8000)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** A window with a message. The text goes in through the environment, so no quoting can break it. */
function showDialog(title: string, message: string, offerLogs: boolean): void {
  const script = offerLogs
    ? "Add-Type -AssemblyName System.Windows.Forms; $r = [System.Windows.Forms.MessageBox]::Show($env:SIMGW_MSG + \"`r`n`r`nOpen the log folder now?\", $env:SIMGW_TITLE, 'YesNo', 'Error'); if ($r -eq 'Yes') { Start-Process explorer.exe $env:SIMGW_LOGDIR }"
    : "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:SIMGW_MSG, $env:SIMGW_TITLE, 'OK', 'Information')";
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], {
    env: { ...process.env, SIMGW_MSG: message, SIMGW_TITLE: title, SIMGW_LOGDIR: logDir },
    windowsHide: true,
    stdio: 'ignore',
  });
}

/** A Yes/No window. Only an explicit Yes counts; closing it or pressing No answers no. */
function confirmDialog(title: string, message: string): boolean {
  const script = "Add-Type -AssemblyName System.Windows.Forms; $r = [System.Windows.Forms.MessageBox]::Show($env:SIMGW_MSG, $env:SIMGW_TITLE, 'YesNo', 'Warning', 'Button2'); if ($r -eq 'Yes') { exit 10 } else { exit 11 }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], { env: { ...process.env, SIMGW_MSG: message, SIMGW_TITLE: title }, windowsHide: true, stdio: 'ignore' });
  return r.status === 10;
}

let splashProcess: ChildProcess | null = null;
const splash = {
  show(text: string) {
    try {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = 'SIZH IT Solution'; $f.Width = 440; $f.Height = 120; $f.StartPosition = 'CenterScreen'; $f.TopMost = $true; $f.FormBorderStyle = 'FixedDialog'; $f.ControlBox = $false; $l = New-Object System.Windows.Forms.Label; $l.Text = $env:SIMGW_MSG; $l.Dock = 'Fill'; $l.TextAlign = 'MiddleCenter'; $f.Controls.Add($l); [void]$f.ShowDialog()";
      splashProcess = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], { env: { ...process.env, SIMGW_MSG: text }, windowsHide: true, stdio: 'ignore' });
      splashProcess.on('error', () => undefined);
    } catch {
      /* the splash is a courtesy */
    }
  },
  hide() {
    try {
      splashProcess?.kill();
    } catch {
      /* already gone */
    }
    splashProcess = null;
  },
};

function imageOf(pid: number): string | null {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return /^"([^"]+)"/m.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function portOwner(port: number): Promise<string | null> {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return ownerFromNetstat(out, port, imageOf);
  } catch {
    return null; // cannot tell: let the supervisor try, it reports a real failure itself
  }
}

function dataDirWritable(): { ok: boolean; error?: string } {
  try {
    for (const dir of [layout.dataDir, logDir]) {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function spawnSupervisor() {
  const main = path.join(here, 'main.js');
  const child = spawn(process.execPath, [main], {
    cwd: appDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, SIMGW_APP_DIR: appDir, SIMGW_NODE: process.execPath },
  });
  let exitCode: number | null = null;
  let exited = false;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });
  child.on('error', (e) => {
    exited = true;
    log(`could not start the supervisor: ${e.message}`);
  });
  child.unref();
  return { exited: () => exited, exitCode: () => exitCode };
}

const firstRunFile = path.join(layout.dataDir, 'first-run.done');

async function start(): Promise<number> {
  const deps: StartupDeps = {
    ports,
    http: (url) => get(url),
    spawnSupervisor,
    portOwner,
    dataDirWritable,
    dataDir: layout.dataDir,
    logDir,
    logTail: () => {
      try {
        return tailLines(fs.readFileSync(path.join(logDir, 'supervisor.log'), 'utf8'), 10);
      } catch {
        return '';
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    openBrowser: (url) => {
      spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    },
    browser: !noBrowser,
    firstRun: () => !fs.existsSync(firstRunFile),
    markFirstRunDone: () => {
      try {
        fs.writeFileSync(firstRunFile, new Date().toISOString());
      } catch {
        /* it only decides which page opens first */
      }
    },
    splash,
    log,
    timeoutMs: Number(process.env.SIMGW_START_TIMEOUT_MS) || 120_000,
  };
  const result = await startAndWait(deps);
  if (result.ok) return 0;
  log(`${result.code}: ${result.title}`);
  // At sign-in the start is automatic and silent: the problem is in the log, and the icon explains it when clicked.
  if (!noBrowser) showDialog(result.title, result.message, true);
  else console.error(`${result.title}: ${result.message}`);
  return 1;
}

async function stop(): Promise<number> {
  const force = args.includes('--force');
  const status = await get(`http://127.0.0.1:${ports.status}/status`);
  if (!status || status.status !== 200) {
    console.log('SIZH IT Solution is not running.');
    return 0;
  }
  if (!force) {
    // Never cut a call off: ask the gateway whether one is in progress.
    const key = configValues().GATEWAY_API_KEY;
    const health = key ? await get(`http://127.0.0.1:${ports.gateway}/api/gateway/health`, 'GET', { 'x-api-key': key }) : null;
    try {
      const call = health ? (JSON.parse(health.body) as { activeCall?: { state?: string } | null }).activeCall : null;
      if (call && call.state && call.state !== 'IDLE') {
        console.error('A call is in progress. End it first, or use --force.');
        return 3;
      }
    } catch {
      /* the gateway did not answer: nothing to protect */
    }
  }
  let token = '';
  try {
    token = fs.readFileSync(path.join(layout.dataDir, 'supervisor.token'), 'utf8').trim();
  } catch {
    console.error('Cannot stop it cleanly: the supervisor token file is missing.');
    return 4;
  }
  const answer = await get(`http://127.0.0.1:${ports.status}/stop`, 'POST', { 'x-supervisor-token': token });
  if (!answer || answer.status !== 202) {
    console.error('The supervisor did not accept the stop request.');
    return 4;
  }
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await get(`http://127.0.0.1:${ports.status}/status`))) {
      log('stopped by request');
      console.log('Stopped.');
      return 0;
    }
  }
  console.error('SIZH IT Solution did not stop within a minute.');
  return 1;
}

/**
 * The one way to replace the encryption key for saved API keys. It asks first, refuses while a call is in progress, keeps the old key file
 * (renamed, never deleted) and starts the product again with the new key. Saved API keys cannot be read afterwards and are entered again.
 */
async function resetSecrets(): Promise<number> {
  const ok = confirmDialog(
    'Reset saved API keys?',
    'This replaces the encryption key that protects your saved API keys.\n\nYour saved provider keys can no longer be read and you will have to enter them again on the AI Agent page. The old key file is kept aside, not deleted.\n\nOnly do this if SIZH IT Solution reported that its key file is missing or damaged.\n\nReset now?'
  );
  if (!ok) return 0;
  const stopped = await stop();
  if (stopped !== 0) {
    showDialog('Nothing was changed', 'SIZH IT Solution could not be stopped (a call may be in progress), so the keys were not reset. End the call and try again.', false);
    return stopped;
  }
  const result = resetMasterKey({ secretsDir: layout.secretsDir, env: process.env, fileValues: configValues(), dbPath: path.join(layout.dataDir, 'gateway.sqlite') });
  log(`reset of saved-key storage: ${result.state}; the old key file was kept as ${result.replacedFile ?? '(there was none)'}`);
  if (!result.usable) {
    showDialog('The keys could not be reset', `${result.message}${result.action ? `\n\n${result.action}` : ''}`, true);
    return 1;
  }
  showDialog('Saved API keys reset', 'A new encryption key was created. Enter your provider API keys again on the AI Agent page.\n\nSIZH IT Solution starts now.', false);
  return start();
}

(args.includes('--reset-secrets') ? resetSecrets() : args.includes('--stop') ? stop() : start())
  .then((code) => process.exit(code))
  .catch((e) => {
    log(`launcher error: ${(e as Error).message}`);
    if (!noBrowser && !args.includes('--stop')) showDialog('SIZH IT Solution could not start', `${(e as Error).message}\n\nLog folder: ${logDir}`, true);
    process.exit(1);
  });
