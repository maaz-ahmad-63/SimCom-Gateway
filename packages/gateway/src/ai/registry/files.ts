import fs from 'node:fs';
import path from 'node:path';

/** Small file helpers shared by the registry and pricing stores: read JSON, write it atomically, keep a last-good copy. */

export type ReadResult = { kind: 'missing' } | { kind: 'error'; message: string } | { kind: 'ok'; value: unknown };

export function readJsonFile(file: string): ReadResult {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error', message: `cannot be read: ${(error as Error).message}` };
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) };
  } catch (error) {
    return { kind: 'error', message: `is not valid JSON: ${(error as Error).message}` };
  }
}

/** Write to a temporary file in the same folder, then rename: a reader sees the old file or the new one, never half of one. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** The copy used if the live file is damaged before the next start. A failed copy never blocks a valid change. */
export function snapshotJson(dir: string, name: string, value: unknown): void {
  try {
    writeJsonAtomic(path.join(dir, '.last-valid', name), value);
  } catch {
    // best effort
  }
}

export const lastValidPath = (dir: string, name: string) => path.join(dir, '.last-valid', name);
