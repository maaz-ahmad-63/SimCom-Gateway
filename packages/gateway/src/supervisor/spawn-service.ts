import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ServiceSpec } from './supervisor.js';

/**
 * Starts a service the way the supervisor does (hidden, with the message channel it uses to ask for a clean stop), with its standard error
 * written straight into `stderrFile`. The file is emptied at every start so it only ever holds the current run. A file, not a pipe: the
 * child can never block on a full pipe or die on a broken one if the supervisor goes away.
 */
export function spawnWithStderrFile(spec: ServiceSpec, stderrFile: string): ChildProcess {
  fs.mkdirSync(path.dirname(stderrFile), { recursive: true });
  const fd = fs.openSync(stderrFile, 'w');
  try {
    return spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'ignore', fd, 'ipc'], windowsHide: true });
  } finally {
    fs.closeSync(fd); // the child has its own handle
  }
}
