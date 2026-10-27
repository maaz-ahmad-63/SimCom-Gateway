import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { acquireInstanceLock, InstanceLockError } from '../src/core/instance-lock.js';
import { createGatewayServer } from '../src/server.js';

describe('serial port instance lock', () => {
  let dir: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-locks-'));
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const liveForeignPid = (): number => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    children.push(child);
    return child.pid!;
  };

  const deadPid = (): number => spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid!;

  const writeLock = (resource: string, pid: number): string => {
    const file = path.join(dir, `${resource}.lock`);
    fs.writeFileSync(file, JSON.stringify({ pid, startedAt: '2026-10-16T00:00:00.000Z' }));
    return file;
  };

  it('records this process as owner of each port and removes the files on release', () => {
    const lock = acquireInstanceLock(['COM22', 'COM26'], dir);

    expect(fs.readdirSync(dir).sort()).toEqual(['COM22.lock', 'COM26.lock']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'COM26.lock'), 'utf8')).pid).toBe(process.pid);

    lock.release();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses to start while a live foreign process owns a port, naming the owner', () => {
    const owner = liveForeignPid();
    writeLock('COM22', owner);

    expect(() => acquireInstanceLock(['COM22', 'COM26'], dir)).toThrow(InstanceLockError);
    expect(() => acquireInstanceLock(['COM22', 'COM26'], dir)).toThrow(new RegExp(`pid ${owner}`));
  });

  it('is all-or-nothing: a conflict on the audio port leaves the AT port unlocked', () => {
    writeLock('COM26', liveForeignPid());

    expect(() => acquireInstanceLock(['COM22', 'COM26'], dir)).toThrow(InstanceLockError);
    expect(fs.existsSync(path.join(dir, 'COM22.lock'))).toBe(false);
  });

  it('takes over a stale lock left by a process that no longer exists', () => {
    writeLock('COM22', deadPid());

    const lock = acquireInstanceLock(['COM22'], dir);

    expect(JSON.parse(fs.readFileSync(path.join(dir, 'COM22.lock'), 'utf8')).pid).toBe(process.pid);
    lock.release();
  });

  it('takes over an unreadable lock file instead of wedging startup', () => {
    fs.writeFileSync(path.join(dir, 'COM22.lock'), 'not json');
    expect(() => acquireInstanceLock(['COM22'], dir)).not.toThrow();
  });

  it('never deletes a lock that another process has since taken over', () => {
    const lock = acquireInstanceLock(['COM22'], dir);
    const file = writeLock('COM22', liveForeignPid());

    lock.release();

    expect(fs.existsSync(file)).toBe(true);
  });

  describe('gateway startup', () => {
    const createServer = (port: number, autoReconnect = true) => {
      const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
      return {
        modem,
        server: createGatewayServer({
          config: {
            modemDriver: 'hardware',
            atPort: 'COM22',
            audioPort: 'COM26',
            gatewayApiKey: 'lock-test-secret-key',
            sqliteDbPath: path.join(dir, `gateway-${port}.sqlite`),
            port,
            host: '127.0.0.1',
            autoReconnect,
          },
          modem,
          audio: new MockAudioAdapter(),
          instanceLockDir: dir,
        }),
      };
    };

    it('a gateway never touches the serial ports while another process owns them', async () => {
      // The owner is a separate live process, exactly as a second `npm run start:gateway` would see.
      const owner = liveForeignPid();
      const lockFile = writeLock('COM26', owner);
      const second = createServer(45872);
      const secondInit = vi.spyOn(second.modem, 'initialize');

      try {
        await expect(second.server.start()).rejects.toThrow(new RegExp(`pid ${owner}.*COM26`));
        expect(secondInit).not.toHaveBeenCalled();
        expect(second.modem.getConnectionState()).toBe('DISCONNECTED');
        // The owner's lock is untouched and nothing was left half-claimed.
        expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(owner);
        expect(fs.existsSync(path.join(dir, 'COM22.lock'))).toBe(false);
      } finally {
        second.server.db.close();
      }
    });

    it('records ownership while running', async () => {
      const running = createServer(45871);
      await running.server.start();
      try {
        for (const port of ['COM22', 'COM26']) {
          expect(JSON.parse(fs.readFileSync(path.join(dir, `${port}.lock`), 'utf8')).pid).toBe(process.pid);
        }
      } finally {
        await running.server.close();
      }
    });

    it('releases the ports on shutdown so the next gateway can start', async () => {
      const first = createServer(45873);
      await first.server.start();
      await first.server.close();
      expect(fs.readdirSync(dir).filter((name) => name.endsWith('.lock'))).toEqual([]);

      const next = createServer(45874);
      await next.server.start();
      await next.server.close();
    });

    it('releases the ports when the modem fails to initialize and auto-reconnect is off (the start fails)', async () => {
      const failing = createServer(45875, false);
      vi.spyOn(failing.modem, 'initialize').mockRejectedValue(new Error('Access denied'));

      await expect(failing.server.start()).rejects.toThrow('Access denied');

      expect(fs.readdirSync(dir).filter((name) => name.endsWith('.lock'))).toEqual([]);
      failing.server.db.close();
    });

    it('keeps owning the ports when the modem is not ready but auto-reconnect keeps retrying (the gateway serves)', async () => {
      const retrying = createServer(45877, true);
      vi.spyOn(retrying.modem, 'initialize').mockRejectedValue(new Error('Access denied'));

      await expect(retrying.server.start()).resolves.toBeUndefined();

      expect(fs.readdirSync(dir).filter((name) => name.endsWith('.lock')).length).toBeGreaterThan(0);
      await retrying.server.close();
    });

    it('does not lock anything in mock mode', async () => {
      const modem = new MockModemAdapter();
      const server = createGatewayServer({
        config: {
          modemDriver: 'mock',
          gatewayApiKey: 'lock-test-secret-key',
          sqliteDbPath: path.join(dir, 'mock.sqlite'),
          port: 45876,
          host: '127.0.0.1',
        },
        modem,
        instanceLockDir: dir,
      });
      await server.start();
      expect(fs.readdirSync(dir).filter((name) => name.endsWith('.lock'))).toEqual([]);
      await server.close();
    });
  });
});
