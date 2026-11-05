import fs from 'node:fs';
import path from 'node:path';
import { isHttps, MAX_MANIFEST_BYTES, UpdateError, UpdateManifest, verifyManifest } from './manifest.js';
import { extractArchive, listArchive, unsafeEntries, validateStaged, verifyPackageFile } from './package.js';
import type { UpdateJob, UpdateResult } from './runner.js';

/**
 * What the supervisor does about updates. The state it reports is what the dashboard shows; nothing here touches the gateway's own files,
 * the modem, the database or the customer's keys. Every step that can fail has a code and a plain sentence for the customer.
 */

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'error';

export interface UpdateState {
  configured: boolean;
  currentVersion: string;
  phase: UpdatePhase;
  checkedAt: string | null;
  available: { version: string; notes?: string; publishedAt: string; size: number } | null;
  error: { code: string; message: string } | null;
  /** What the last update attempt ended as (reported once the new or restored program is running). */
  lastResult: UpdateResult | null;
  /** True when this install can be updated in place by this user (the program folder can be replaced). */
  canApply: boolean;
  cannotApplyReason: string | null;
}

export interface UpdateConfig {
  updateUrl: string;
  publicKeyPem: string | null;
  currentVersion: string;
  appDir: string;
  dataDir: string;
  gatewayPort: number;
  dashboardPort: number;
  statusPort: number;
  supervisorPid: number;
  /** How long the new version may take to become healthy before the update is undone. */
  healthTimeoutMs?: number;
}

export interface UpdateDeps {
  now(): Date;
  /** GET an https address; throws UpdateError. Must refuse redirects to anything but https and bodies larger than maxBytes. */
  fetchBytes(url: string, maxBytes: number): Promise<Buffer>;
  /** Stream an https address to a file; throws UpdateError. Must stop after maxBytes. */
  downloadTo(url: string, file: string, maxBytes: number): Promise<void>;
  callState(): Promise<'idle' | 'busy' | 'unknown'>;
  /** Copy the runner and a node.exe to a folder that is not the program folder, start it detached with the job file. */
  launchRunner(jobFile: string, runnerDir: string): void;
  /** Stop the gateway and dashboard cleanly and exit the supervisor. */
  stopSupervisor(): Promise<void>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

const sentence = (e: unknown): { code: string; message: string } =>
  e instanceof UpdateError ? { code: e.code, message: e.message } : { code: 'UNEXPECTED', message: 'The update could not be completed. See the log for details.' };

export class UpdateService {
  private state: UpdateState;
  private manifest: UpdateManifest | null = null;
  private busy = false;

  constructor(private readonly cfg: UpdateConfig, private readonly deps: UpdateDeps) {
    const writable = this.checkWritable();
    this.state = {
      configured: Boolean(cfg.updateUrl && isHttps(cfg.updateUrl) && cfg.publicKeyPem),
      currentVersion: cfg.currentVersion,
      phase: 'idle',
      checkedAt: null,
      available: null,
      error: null,
      lastResult: this.readLastResult(),
      canApply: writable === null,
      cannotApplyReason: writable,
    };
  }

  status(): UpdateState {
    // Read every time, not once at start: after a rollback the runner starts the old program BEFORE it writes the result, so the file may
    // appear a moment after this service was created.
    return { ...this.state, lastResult: this.readLastResult() ?? this.state.lastResult };
  }

  private get updatesDir(): string {
    return path.join(this.cfg.dataDir, 'updates');
  }
  private get resultFile(): string {
    return path.join(this.updatesDir, 'result.json');
  }

  private readLastResult(): UpdateResult | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.cfg.dataDir, 'updates', 'result.json'), 'utf8')) as UpdateResult;
    } catch {
      return null;
    }
  }

  /** The program folder is replaced by renaming it next to itself, so its parent must be writable by this user. */
  private checkWritable(): string | null {
    const probe = `${this.cfg.appDir}.write-test`;
    try {
      fs.mkdirSync(probe);
      fs.rmdirSync(probe);
      return null;
    } catch {
      return 'This installation is in a protected folder, so it cannot update itself. Run the newer installer once; later updates then work from the dashboard.';
    }
  }

  private fail(e: unknown): never {
    this.state = { ...this.state, phase: 'error', error: sentence(e) };
    throw e;
  }

  /** Ask the update address whether a newer, correctly signed version exists. Never downloads the package. */
  async check(): Promise<UpdateState> {
    if (this.busy) throw new UpdateError('BUSY', 'An update step is already running.');
    if (!this.state.configured) {
      const e = new UpdateError('NOT_CONFIGURED', 'Updates are not set up for this installation (no update address or signing key).');
      this.state = { ...this.state, error: sentence(e) };
      throw e;
    }
    this.busy = true;
    this.state = { ...this.state, phase: 'checking', error: null };
    try {
      const url = this.cfg.updateUrl;
      let bytes: Buffer;
      try {
        bytes = await this.deps.fetchBytes(url, MAX_MANIFEST_BYTES);
      } catch (e) {
        // A release address that has no release yet (GitHub answers 404 until the first release is published) is "nothing new", not a fault.
        if (e instanceof UpdateError && e.code === 'NOT_PUBLISHED') {
          this.manifest = null;
          this.state = { ...this.state, phase: 'idle', available: null, checkedAt: this.deps.now().toISOString() };
          return this.status();
        }
        throw e;
      }
      const sig = (await this.deps.fetchBytes(`${url}.sig`, 1024)).toString('utf8');
      try {
        this.manifest = verifyManifest(bytes, sig, this.cfg.publicKeyPem!, this.cfg.currentVersion, this.deps.now());
      } catch (e) {
        if (e instanceof UpdateError && e.code === 'NOT_NEWER') {
          this.manifest = null;
          this.state = { ...this.state, phase: 'idle', available: null, checkedAt: this.deps.now().toISOString() };
          return this.status();
        }
        throw e;
      }
      const m = this.manifest;
      this.state = { ...this.state, phase: 'available', checkedAt: this.deps.now().toISOString(), available: { version: m.version, notes: m.notes, publishedAt: m.publishedAt, size: m.packageSize } };
      this.deps.log('info', `Update ${m.version} is available`);
      return this.status();
    } catch (e) {
      this.deps.log('warn', `Update check failed: ${(e as Error).message}`);
      return this.fail(e);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Download, verify, stage and hand over to the runner. Refuses during a call (and when it cannot tell). The supervisor stops itself after
   * this returns, so the answer reaches the dashboard first.
   */
  async apply(): Promise<UpdateState> {
    if (this.busy) throw new UpdateError('BUSY', 'An update step is already running.');
    if (!this.manifest || this.state.phase !== 'available') throw new UpdateError('NO_UPDATE', 'Check for updates first.');
    if (!this.state.canApply) throw new UpdateError('NOT_WRITABLE', this.state.cannotApplyReason ?? 'This installation cannot update itself.');
    await this.requireNoCall();
    this.busy = true;
    const m = this.manifest;
    const { appDir, dataDir } = this.cfg;
    const stagingDir = `${appDir}.new`;
    const archive = path.join(this.updatesDir, 'download', `update-${m.version}.zip`);
    try {
      this.state = { ...this.state, phase: 'downloading', error: null };
      fs.mkdirSync(path.dirname(archive), { recursive: true });
      fs.rmSync(archive, { force: true });
      fs.rmSync(stagingDir, { recursive: true, force: true });
      await this.deps.downloadTo(m.packageUrl, archive, m.packageSize);

      this.state = { ...this.state, phase: 'verifying' };
      await verifyPackageFile(archive, m);
      const problems = unsafeEntries(await listArchive(archive));
      if (problems.length > 0) throw new UpdateError('UNSAFE_PACKAGE', `The update contains files it should not (${problems[0]}), so it was discarded.`);
      await extractArchive(archive, stagingDir);
      validateStaged(stagingDir, m.version);

      this.state = { ...this.state, phase: 'installing' };
      await this.requireNoCall(); // a call may have started while the package was downloading
      const runnerDir = path.join(this.updatesDir, 'runner');
      const job: UpdateJob = {
        appDir,
        stagingDir,
        backupDir: `${appDir}.backup`,
        fromVersion: this.cfg.currentVersion,
        toVersion: m.version,
        supervisorPid: this.cfg.supervisorPid,
        dataDir,
        gatewayPort: this.cfg.gatewayPort,
        dashboardPort: this.cfg.dashboardPort,
        statusPort: this.cfg.statusPort,
        resultFile: this.resultFile,
        healthTimeoutMs: this.cfg.healthTimeoutMs ?? 180_000,
        stopTimeoutMs: 90_000,
      };
      fs.mkdirSync(runnerDir, { recursive: true });
      const jobFile = path.join(runnerDir, 'job.json');
      fs.writeFileSync(jobFile, JSON.stringify(job));
      fs.rmSync(this.resultFile, { force: true });
      this.deps.launchRunner(jobFile, runnerDir);
      this.deps.log('info', `Installing ${m.version}: the program stops now and restarts on the new version`);
      const answer = this.status();
      // Stopping is deferred so the HTTP answer above is sent first.
      setImmediate(() => void this.deps.stopSupervisor());
      return answer;
    } catch (e) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.rmSync(archive, { force: true });
      this.deps.log('warn', `Update was not installed: ${(e as Error).message}`);
      return this.fail(e);
    } finally {
      this.busy = false;
    }
  }

  private async requireNoCall(): Promise<void> {
    const call = await this.deps.callState();
    if (call === 'busy') throw new UpdateError('CALL_IN_PROGRESS', 'A call is in progress. The update will not start until it ends.');
    if (call === 'unknown') throw new UpdateError('CALL_STATE_UNKNOWN', 'The program could not confirm that no call is in progress, so it did not update. Try again in a moment.');
  }
}
