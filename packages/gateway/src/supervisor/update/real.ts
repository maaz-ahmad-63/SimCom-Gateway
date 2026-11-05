import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isHttps, UpdateError } from './manifest.js';
import type { UpdateDeps } from './service.js';

/** The network, process and file parts of the updater, kept apart so the logic in service.ts can be tested without any of them. */

/** GET with redirects followed by hand: every hop must be https, so a redirect can never downgrade the connection. */
async function getHttps(url: string, timeoutMs: number): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!isHttps(current)) throw new UpdateError('INSECURE_URL', 'The update address is not a secure (https) address.');
    let res: Response;
    try {
      res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'SIZH-IT-Solution-Updater' } });
    } catch {
      throw new UpdateError('FETCH_FAILED', 'The update server could not be reached. Check the internet connection and try again.');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current).toString();
      continue;
    }
    if (!res.ok) throw new UpdateError('FETCH_FAILED', `The update server answered with an error (${res.status}).`);
    return res;
  }
  throw new UpdateError('FETCH_FAILED', 'The update server redirected too many times.');
}

export async function fetchBytes(url: string, maxBytes: number): Promise<Buffer> {
  const res = await getHttps(url, 15_000);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(res.body as never)) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new UpdateError('TOO_LARGE', 'The update information is larger than expected, so it was ignored.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function downloadTo(url: string, file: string, maxBytes: number): Promise<void> {
  const res = await getHttps(url, 30 * 60_000);
  let total = 0;
  const limited = async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      total += chunk.length;
      if (total > maxBytes) throw new UpdateError('SIZE_MISMATCH', 'The download is larger than announced, so it was stopped.');
      yield chunk;
    }
  };
  await pipeline(Readable.fromWeb(res.body as never) as unknown as AsyncIterable<Buffer>, limited, fs.createWriteStream(file));
}

/** Whether a call is in progress, asked of the gateway exactly as "Stop" does (launch.ts). Only a clear "no call" counts as idle. */
export function callStateFrom(gatewayPort: number, apiKey: string, gatewayRunning: () => boolean): () => Promise<'idle' | 'busy' | 'unknown'> {
  return () =>
    new Promise((resolve) => {
      if (!gatewayRunning()) return resolve('idle'); // nothing is running that could be on a call
      if (!apiKey) return resolve('unknown');
      const req = http.get({ host: '127.0.0.1', port: gatewayPort, path: '/api/gateway/health', headers: { 'x-api-key': apiKey }, timeout: 4000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const call = (JSON.parse(body) as { activeCall?: { state?: string } | null }).activeCall;
            resolve(res.statusCode === 200 ? (call && call.state && call.state !== 'IDLE' ? 'busy' : 'idle') : 'unknown');
          } catch {
            resolve('unknown');
          }
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve('unknown'));
    });
}

/** The runner and a node.exe are copied OUT of the program folder, because that folder is about to be renamed. */
export function launchRunnerFrom(appDir: string, runnerSource: string): UpdateDeps['launchRunner'] {
  return (jobFile, runnerDir) => {
    const node = path.join(runnerDir, 'node.exe');
    const script = path.join(runnerDir, 'update-runner.mjs');
    fs.copyFileSync(path.join(appDir, 'runtime', 'node.exe'), node);
    fs.copyFileSync(runnerSource, script);
    const child = spawn(node, [script, jobFile], { cwd: runnerDir, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  };
}
