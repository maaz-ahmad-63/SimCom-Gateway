import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Applies a verified, already-extracted update. It is deliberately SELF-CONTAINED (node: imports only): the supervisor copies this file and
 * a copy of node.exe into the data folder and starts them from there, because Windows will not rename or delete a folder whose files are
 * in use, and the running supervisor, gateway and dashboard all run from the program folder.
 *
 *   1. wait for the old supervisor (which stopped the gateway and dashboard cleanly) to exit
 *   2. program folder -> <app>.backup, staged folder -> program folder   (two renames on one volume; customer data is elsewhere)
 *   3. start the new program and check that it is healthy for the announced version
 *   4. if anything fails: remove the new one, put the backup back, start the old program, and say why
 * The result is written to a file the next supervisor reports to the dashboard.
 */

export interface UpdateJob {
  appDir: string;
  stagingDir: string;
  backupDir: string;
  fromVersion: string;
  toVersion: string;
  supervisorPid: number;
  dataDir: string;
  gatewayPort: number;
  dashboardPort: number;
  statusPort: number;
  resultFile: string;
  healthTimeoutMs: number;
  stopTimeoutMs: number;
}

export interface UpdateResult {
  outcome: 'updated' | 'rolled_back' | 'failed' | 'recovered';
  fromVersion: string;
  toVersion: string;
  at: string;
  /** Plain-language reason when the update did not stick. */
  reason?: string;
  /** True when the previous version is running again (or never stopped being the installed one). */
  restored?: boolean;
}

export interface RunnerDeps {
  isAlive(pid: number): boolean;
  /** Start the program that lives in appDir; returns its pid. */
  startProgram(appDir: string, job: UpdateJob): number | null;
  /** Ask the program started above to stop and make sure it is gone. */
  stopProgram(pid: number | null, job: UpdateJob): Promise<void>;
  /** The program in appDir is serving and reports this version. */
  healthy(job: UpdateJob, version: string, pid: number | null): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(line: string): void;
}

// ---- the journal and crash recovery ----------------------------------------------------------------------------------------------

export type JournalState = 'started' | 'moving-aside' | 'installing' | 'rolling-back' | 'verified';

export interface Journal {
  version: 1;
  state: JournalState;
  appDir: string;
  stagingDir: string;
  backupDir: string;
  fromVersion: string;
  toVersion: string;
  runnerPid: number;
  at: string;
}

export const journalFile = (dataDir: string): string => path.join(dataDir, 'updates', 'journal.json');

function writeJournal(job: UpdateJob, state: JournalState, deps: Pick<RunnerDeps, 'now'>): void {
  const j: Journal = { version: 1, state, appDir: job.appDir, stagingDir: job.stagingDir, backupDir: job.backupDir, fromVersion: job.fromVersion, toVersion: job.toVersion, runnerPid: process.pid, at: deps.now().toISOString() };
  fs.mkdirSync(path.dirname(journalFile(job.dataDir)), { recursive: true });
  // Written to a side file and renamed, so a crash cannot leave half a journal.
  const side = `${journalFile(job.dataDir)}.tmp`;
  fs.writeFileSync(side, JSON.stringify(j));
  fs.renameSync(side, journalFile(job.dataDir));
}

/** A folder is a usable program when every file the launcher needs is there. Its version comes from VERSION.json. */
export function programVersion(dir: string): string | null {
  const need = ['VERSION.json', path.join('runtime', 'node.exe'), path.join('gateway', 'dist', 'supervisor', 'main.js'), path.join('dashboard', 'packages', 'dashboard', 'server.js')];
  if (!need.every((n) => fs.existsSync(path.join(dir, n)))) return null;
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(dir, 'VERSION.json'), 'utf8').replace(/^﻿/, '')) as { version?: string }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export interface RecoveryOutcome {
  status: 'none' | 'in_progress' | 'recovered' | 'unrecoverable';
  result?: UpdateResult;
}

/**
 * An update was started but never finished (the runner was killed, the power failed). Decide from what is ACTUALLY on disk, not from the
 * journal alone, because the journal can be one step behind a rename. Rules:
 *   - a runner that is still alive owns the folders: touch nothing
 *   - folders are only ever RENAMED into place; one is removed only after a valid program is already in the program folder, so the only
 *     valid copy is never deleted
 *   - prefer the previous version (the backup); keep the new one if it was confirmed healthy; if the program folder is missing and only
 *     the staged new version is complete, use that rather than nothing
 * Customer data is outside all of these folders and is never read or written here.
 */
export async function recoverInterruptedUpdate(dataDir: string, deps: Pick<RunnerDeps, 'isAlive' | 'now' | 'log' | 'sleep'>): Promise<RecoveryOutcome> {
  let j: Journal;
  try {
    j = JSON.parse(fs.readFileSync(journalFile(dataDir), 'utf8')) as Journal;
  } catch {
    return { status: 'none' };
  }
  if (j.runnerPid && j.runnerPid !== process.pid && deps.isAlive(j.runnerPid)) return { status: 'in_progress' };

  const failedDir = `${j.appDir}.failed`;
  const resultFile = path.join(dataDir, 'updates', 'result.json');
  const finish = (outcome: UpdateResult['outcome'], reason: string, restored: boolean): RecoveryOutcome => {
    const result: UpdateResult = { outcome, fromVersion: j.fromVersion, toVersion: j.toVersion, at: deps.now().toISOString(), reason, restored };
    try {
      fs.writeFileSync(resultFile, JSON.stringify(result));
    } catch {
      /* logged below */
    }
    deps.log(`recovery: ${outcome} (${reason})`);
    if (restored) fs.rmSync(journalFile(dataDir), { force: true });
    return { status: restored ? 'recovered' : 'unrecoverable', result };
  };
  const move = (from: string, to: string): Promise<void> => renameWithRetry(from, to, { sleep: deps.sleep } as RunnerDeps, 10);

  const app = programVersion(j.appDir);
  const backup = programVersion(j.backupDir);
  const staged = programVersion(j.stagingDir);
  deps.log(`recovery: journal state ${j.state}; program folder ${app ?? (fs.existsSync(j.appDir) ? 'incomplete' : 'missing')}, backup ${backup ?? 'none'}, staged ${staged ?? 'none'}`);

  // The new version was confirmed healthy before the crash: the update did finish.
  if (app === j.toVersion && j.state === 'verified') {
    fs.rmSync(j.stagingDir, { recursive: true, force: true });
    return finish('updated', 'The update had already finished; only the final bookkeeping was interrupted.', true);
  }
  // The program folder is already the previous version: nothing was swapped, or a rollback had finished.
  if (app === j.fromVersion) {
    fs.rmSync(failedDir, { recursive: true, force: true });
    return finish('recovered', `The interrupted update was not applied. Version ${app} is in place and nothing was lost.`, true);
  }
  // The new version is in place but never confirmed healthy, or the program folder is missing or incomplete.
  if (app === j.toVersion || app === null) {
    if (backup !== null) {
      try {
        if (fs.existsSync(j.appDir)) {
          fs.rmSync(failedDir, { recursive: true, force: true }); // junk from an earlier attempt: the backup is the valid copy
          await move(j.appDir, failedDir);
        }
        try {
          await move(j.backupDir, j.appDir);
        } catch (e) {
          if (fs.existsSync(failedDir) && !fs.existsSync(j.appDir)) await move(failedDir, j.appDir); // put the program folder back as it was
          throw e;
        }
      } catch (e) {
        return finish('failed', `The previous version could not be restored automatically (${(e as NodeJS.ErrnoException).code ?? 'error'}). It is in ${j.backupDir}. Run the installer again to repair.`, false);
      }
      fs.rmSync(failedDir, { recursive: true, force: true });
      return finish('recovered', `An interrupted update was undone. Version ${backup} is in place again and nothing was lost.`, true);
    }
    if (app === null && staged !== null) {
      try {
        if (fs.existsSync(j.appDir)) await move(j.appDir, failedDir);
        await move(j.stagingDir, j.appDir);
      } catch (e) {
        return finish('failed', `The program folder could not be rebuilt (${(e as NodeJS.ErrnoException).code ?? 'error'}). Run the installer again to repair.`, false);
      }
      fs.rmSync(failedDir, { recursive: true, force: true });
      return finish('recovered', `The previous version was not available, so the complete new version ${staged} was put in place. Nothing was lost.`, true);
    }
    if (app === j.toVersion) return finish('recovered', `The new version ${app} is in place; the previous version was not kept, so it stays. Nothing was lost.`, true);
    return finish('failed', 'No complete copy of the program was found. Run the installer again; your data, settings and saved keys are kept.', false);
  }
  // A different complete version is in place (installed over it, or an earlier recovery already ran): leave it alone.
  return finish('recovered', `Version ${app} is in place. The interrupted update record was cleared.`, true);
}

const rm = (p: string) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });

async function renameWithRetry(from: string, to: string, deps: RunnerDeps, attempts = 20): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= attempts - 1) throw e;
      await deps.sleep(500);
    }
  }
}

export async function runUpdate(job: UpdateJob, deps: RunnerDeps): Promise<UpdateResult> {
  const base = { fromVersion: job.fromVersion, toVersion: job.toVersion };
  const done = (r: Omit<UpdateResult, 'at' | 'fromVersion' | 'toVersion'>): UpdateResult => {
    const result: UpdateResult = { ...base, at: deps.now().toISOString(), ...r };
    try {
      fs.mkdirSync(path.dirname(job.resultFile), { recursive: true });
      fs.writeFileSync(job.resultFile, JSON.stringify(result));
    } catch {
      /* the log line below still records it */
    }
    deps.log(`result: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`);
    // The journal says "an update is in progress". It is removed once the program folder is known to be in a good state; if the previous
    // version could not be put back it stays, so the next start tries again (see recoverInterruptedUpdate).
    if (result.restored !== false || result.outcome === 'updated') fs.rmSync(journalFile(job.dataDir), { force: true });
    return result;
  };
  const journal = (state: JournalState): void => writeJournal(job, state, deps);
  journal('started');

  // 1. The old supervisor must be gone, otherwise its files are still in use.
  const waited = deps.now().getTime();
  while (deps.isAlive(job.supervisorPid)) {
    if (deps.now().getTime() - waited > job.stopTimeoutMs) {
      deps.log('the old program did not stop in time; nothing was changed');
      return done({ outcome: 'failed', reason: 'The running program did not stop in time, so nothing was changed.', restored: true });
    }
    await deps.sleep(500);
  }

  // 2. Swap. Anything left over from an earlier attempt is removed first (the data folder is never touched).
  // The journal is written BEFORE each step, so a crash always leaves a record of how far this got.
  rm(job.backupDir);
  journal('moving-aside');
  try {
    await renameWithRetry(job.appDir, job.backupDir, deps);
  } catch (e) {
    deps.startProgram(job.appDir, job);
    return done({ outcome: 'failed', reason: `The program folder could not be moved aside (${(e as NodeJS.ErrnoException).code ?? 'error'}), so nothing was changed.`, restored: true });
  }
  let newPid: number | null = null;
  const rollback = async (why: string): Promise<UpdateResult> => {
    deps.log(`rolling back: ${why}`);
    journal('rolling-back');
    try {
      await deps.stopProgram(newPid, job);
    } catch {
      /* it may never have started */
    }
    const failedDir = `${job.appDir}.failed`;
    try {
      rm(failedDir);
      if (fs.existsSync(job.appDir)) await renameWithRetry(job.appDir, failedDir, deps);
      await renameWithRetry(job.backupDir, job.appDir, deps);
    } catch (e) {
      return done({ outcome: 'failed', reason: `${why} The previous version could not be put back automatically (${(e as NodeJS.ErrnoException).code ?? 'error'}); it is in ${job.backupDir}. Reinstall to repair.`, restored: false });
    }
    deps.startProgram(job.appDir, job);
    rm(failedDir);
    return done({ outcome: 'rolled_back', reason: why, restored: true });
  };

  journal('installing');
  try {
    await renameWithRetry(job.stagingDir, job.appDir, deps);
  } catch (e) {
    return rollback(`The new version could not be put in place (${(e as NodeJS.ErrnoException).code ?? 'error'}).`);
  }

  // 3. Start and verify the new program.
  newPid = deps.startProgram(job.appDir, job);
  if (newPid === null) return rollback('The new version could not be started.');
  if (!(await deps.healthy(job, job.toVersion, newPid))) return rollback('The new version did not become healthy in time.');

  // 4. Keep the previous version as the one rollback copy; the next update replaces it.
  journal('verified');
  return done({ outcome: 'updated', restored: false });
}

// ---- real dependencies ------------------------------------------------------------------------------------------------------------

const getStatus = (port: number, pathName: string): Promise<{ status: number; body: string } | null> =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });

export function realDeps(logFile: string): RunnerDeps {
  const log = (line: string) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${new Date().toISOString()} [update] ${line}\n`);
    } catch {
      /* nothing else to do */
    }
  };
  return {
    log,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    startProgram: (appDir) => {
      const main = path.join(appDir, 'gateway', 'dist', 'supervisor', 'main.js');
      const node = path.join(appDir, 'runtime', 'node.exe');
      try {
        const child = spawn(node, [main], { cwd: appDir, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, SIMGW_APP_DIR: appDir, SIMGW_NODE: node } });
        child.on('error', () => undefined);
        child.unref();
        return child.pid ?? null;
      } catch {
        return null;
      }
    },
    stopProgram: async (pid, job) => {
      // Ask politely through the supervisor's own stop request; then make sure the process tree is gone.
      try {
        const token = fs.readFileSync(path.join(job.dataDir, 'supervisor.token'), 'utf8').trim();
        await new Promise<void>((resolve) => {
          const req = http.request({ host: '127.0.0.1', port: job.statusPort, path: '/stop', method: 'POST', headers: { 'x-supervisor-token': token }, timeout: 4000 }, (res) => {
            res.resume();
            resolve();
          });
          req.on('error', () => resolve());
          req.on('timeout', () => req.destroy());
          req.end();
        });
      } catch {
        /* fall through to the forced stop */
      }
      for (let i = 0; i < 30 && pid !== null; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (pid !== null) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
      await new Promise((r) => setTimeout(r, 2000));
    },
    healthy: async (job, version, pid) => {
      const until = Date.now() + job.healthTimeoutMs;
      while (Date.now() < until) {
        if (pid !== null) {
          try {
            process.kill(pid, 0);
          } catch {
            return false; // the new supervisor died: no point waiting
          }
        }
        const status = await getStatus(job.statusPort, '/status');
        let reported: { version?: string } = {};
        try {
          reported = status ? (JSON.parse(status.body) as { version?: string }) : {};
        } catch {
          reported = {};
        }
        if (status?.status === 200 && reported.version === version) {
          const gw = await getStatus(job.gatewayPort, '/health');
          const dash = await getStatus(job.dashboardPort, '/');
          if (gw?.status === 200 && dash && dash.status > 0 && dash.status < 500) return true;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      return false;
    },
  };
}

// Started directly (from the copy in the data folder). `--recover <dataDir>` repairs an interrupted update; otherwise argv[2] is the job file.
// Exit codes for --recover: 0 nothing to do or recovered, 2 an update is still being applied, 3 no complete program could be restored.
const startedAsRunner = Boolean(process.argv[1]) && path.basename(process.argv[1]).startsWith('update-runner');
if (startedAsRunner && process.argv[2] === '--recover' && process.argv[3]) {
  const dataDir = process.argv[3];
  const deps = realDeps(path.join(dataDir, 'logs', 'update.log'));
  recoverInterruptedUpdate(dataDir, deps).then(
    (r) => process.exit(r.status === 'in_progress' ? 2 : r.status === 'unrecoverable' ? 3 : 0),
    (e) => {
      deps.log(`recovery error: ${(e as Error).message}`);
      process.exit(3);
    }
  );
} else if (startedAsRunner && process.argv[2]) {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^﻿/, '')) as UpdateJob;
  const deps = realDeps(path.join(job.dataDir, 'logs', 'update.log'));
  runUpdate(job, deps)
    .then(() => process.exit(0))
    .catch((e) => {
      deps.log(`unexpected error: ${(e as Error).message}`);
      process.exit(1);
    });
}

export const runnerFile = fileURLToPath(import.meta.url);
