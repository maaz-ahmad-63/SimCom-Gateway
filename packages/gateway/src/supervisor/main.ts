import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSpecs, ensureConfigFile, parseEnvFile, preflight, resolveLayout } from './launcher.js';
import { provisionMasterKey, secretsStatus } from './master-key.js';
import { acquireSupervisorLock, ServiceSupervisor, startStatusServer, SupervisorLockError, TokenRoute } from './supervisor.js';
import { UpdateError } from './update/manifest.js';
import { callStateFrom, downloadTo, fetchBytes, launchRunnerFrom } from './update/real.js';
import { UpdateService } from './update/service.js';
import { readVersion } from './update/version.js';

/**
 * The one thing the customer launches. It creates the customer configuration on first run, starts the gateway and the dashboard, keeps
 * them running (with bounded restarts), serves a small status page on 127.0.0.1:4010 and stops both cleanly on Ctrl+C / service stop.
 * It never talks to the modem. Run with: node gateway/dist/supervisor/main.js
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// <app>/gateway/dist/supervisor/main.js -> <app>
const appDir = process.env.SIMGW_APP_DIR?.trim() || path.resolve(here, '..', '..', '..');
const layout = resolveLayout(appDir);
const logFile = path.join(layout.dataDir, 'logs', 'supervisor.log');

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  (level === 'error' ? console.error : console.log)(line);
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
    fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    /* the console line above still shows it */
  }
}

async function main(): Promise<void> {
  const problems = preflight(layout);
  if (problems.length > 0) {
    problems.forEach((p) => log('error', p));
    process.exit(2);
  }
  let release: () => void;
  try {
    release = acquireSupervisorLock(path.join(layout.dataDir, 'supervisor.lock'));
  } catch (e) {
    if (e instanceof SupervisorLockError) {
      log('error', `${e.message} Only one copy may run: two would fight over the modem.`);
      process.exit(3);
    }
    throw e;
  }
  const first = ensureConfigFile(layout.configFile);
  if (first.created) log('info', `First start: created the configuration at ${layout.configFile} (it holds a new random API key; the key is not shown here).`);

  // The encryption key for saved API keys: created once, never replaced, handed to the gateway before it starts. See master-key.ts.
  let fileValues: Record<string, string> = {};
  try {
    fileValues = parseEnvFile(fs.readFileSync(layout.configFile, 'utf8'));
  } catch {
    fileValues = {};
  }
  const secrets = provisionMasterKey({ secretsDir: layout.secretsDir, env: process.env, fileValues, dbPath: path.join(layout.dataDir, 'gateway.sqlite') });
  log(secrets.usable ? 'info' : 'error', `API key storage: ${secrets.state}. ${secrets.message}${secrets.action ? ` ${secrets.action}` : ''}`);
  const specs = buildSpecs(layout, process.env, secrets);
  const gatewayPort = Number(specs.gateway.env.PORT || 4000);
  const probe = () =>
    new Promise<boolean>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: gatewayPort, path: '/health', timeout: 4000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    });
  // The fourth stdio slot is a message channel: it is how a service is asked to finish and exit on Windows, where a signal is an instant kill.
  const run = (s: typeof specs.gateway) => spawn(s.command, s.args, { cwd: s.cwd, env: s.env as NodeJS.ProcessEnv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const gateway = new ServiceSupervisor(specs.gateway, { spawn: run as never, probe, log });
  const dashboard = new ServiceSupervisor(specs.dashboard, { spawn: run as never, log, hungAfterMs: 10 * 60_000 });
  const statusPort = Number(process.env.SIMGW_STATUS_PORT) || 4010;
  const token = crypto.randomBytes(24).toString('hex');
  const tokenFile = path.join(layout.dataDir, 'supervisor.token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });

  // Updates: a signed manifest at a configurable https address, checked and applied from the dashboard (see update/service.ts).
  const apiKey = fileValues.GATEWAY_API_KEY ?? '';
  const currentVersion = readVersion(appDir);
  const keyFile = path.join(appDir, 'update', 'public-key.pem');
  const updates = new UpdateService(
    {
      updateUrl: (process.env.SIMGW_UPDATE_URL || fileValues.UPDATE_URL || '').trim(),
      publicKeyPem: fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : null,
      currentVersion,
      appDir,
      dataDir: layout.dataDir,
      gatewayPort,
      dashboardPort: Number(process.env.SIMGW_DASHBOARD_PORT) || 3000,
      statusPort,
      supervisorPid: process.pid,
      healthTimeoutMs: Math.min(600_000, Math.max(10_000, Number(process.env.SIMGW_UPDATE_HEALTH_TIMEOUT_MS) || 180_000)),
    },
    {
      now: () => new Date(),
      fetchBytes,
      downloadTo,
      callState: callStateFrom(gatewayPort, apiKey, () => ['starting', 'running', 'backoff'].includes(gateway.status().state)),
      launchRunner: launchRunnerFrom(appDir, path.join(here, 'update', 'runner.js')),
      stopSupervisor: () => shutdown('update'),
      log,
    }
  );
  const updateRoute: TokenRoute = (method, url) => {
    const run = async (step: () => Promise<unknown>): Promise<{ status: number; body: unknown }> => {
      try {
        await step();
        return { status: 200, body: { success: true, update: updates.status() } };
      } catch (e) {
        const code = e instanceof UpdateError ? e.code : 'UNEXPECTED';
        return { status: code === 'UNEXPECTED' ? 500 : code === 'CALL_IN_PROGRESS' || code === 'BUSY' ? 409 : 400, body: { success: false, code, error: (e as Error).message, update: updates.status() } };
      }
    };
    if (method === 'GET' && url === '/update') return Promise.resolve({ status: 200, body: { success: true, update: updates.status() } });
    if (method === 'POST' && url === '/update/check') return run(() => updates.check());
    if (method === 'POST' && url === '/update/apply') return run(() => updates.apply());
    return null;
  };
  const status = () => ({ updatedAt: new Date().toISOString(), version: currentVersion, supervisorPid: process.pid, gateway: gateway.status(), dashboard: dashboard.status(), secrets: secretsStatus(secrets), update: updates.status() });
  startStatusServer(status, statusPort, '127.0.0.1', { token, onStop: () => void shutdown('stop requested'), route: updateRoute });
  // A copy for the installer's "is it running?" check and for support, even if the status page cannot be reached.
  const statusFile = path.join(layout.dataDir, 'supervisor-status.json');
  setInterval(() => {
    try {
      fs.writeFileSync(statusFile, JSON.stringify(status()));
    } catch {
      /* informational */
    }
  }, 5000).unref();

  gateway.start();
  dashboard.start();
  log('info', `Started. Dashboard: http://127.0.0.1:3000  Status: http://127.0.0.1:${statusPort}/status`);

  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log('info', `Stopping (${why}): the dashboard first, then the gateway, which finishes any call cleanup`);
    await dashboard.stop(2_000); // it keeps no state, so it is not given long
    await gateway.stop(25_000); // the gateway closes its ports and recordings on SIGTERM
    release();
    fs.rmSync(tokenFile, { force: true });
    log('info', 'Stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('Ctrl+C'));
  process.on('SIGTERM', () => void shutdown('service stop'));
  process.on('SIGBREAK', () => void shutdown('console closed'));
  // Keep the process alive; the children and the status server are unref'd on purpose.
  setInterval(() => undefined, 1 << 30);
}

main().catch((e) => {
  log('error', `The supervisor could not start: ${(e as Error).message}`);
  process.exit(1);
});
