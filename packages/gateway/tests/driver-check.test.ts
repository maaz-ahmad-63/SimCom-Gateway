import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The installer's modem and driver check (installer/scripts/check-modem-driver.ps1). It is read only, so it is tested against saved
 * descriptions of what Windows could report; no modem, driver or COM port is involved. Windows PowerShell is needed to run it.
 */
const script = path.resolve(__dirname, '../../../installer/scripts/check-modem-driver.ps1');
const windows = process.platform === 'win32';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drvchk-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

type Dev = { InstanceId: string; FriendlyName: string; Status: string; Problem: number; Provider: string | null; Version: string | null; Date: string | null; Signer: string | null; IsSigned: boolean };
const dev = (mi: string, name: string, over: Partial<Dev> = {}): Dev => ({ InstanceId: `USB\\VID_1E0E&PID_9001&MI_${mi}\\6&1`, FriendlyName: name, Status: 'OK', Problem: 0, Provider: 'Qualcomm Incorporated', Version: '2.1.3.8', Date: '2019-11-20', Signer: 'Microsoft Windows Hardware Compatibility Publisher', IsSigned: true, ...over });
const good = () => [dev('00', 'Simcom HS-USB Diagnostics 9001 (COM17)'), dev('02', 'Simcom HS-USB AT PORT 9001 (COM20)'), dev('04', 'Simcom HS-USB Audio 9001 (COM19)')];

function check(devices: Dev[], vcRuntime = true) {
  const file = path.join(dir, `f${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ devices, vcRuntime }));
  const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Json', '-FromJson', file], { encoding: 'utf8', timeout: 60_000 });
  return { code: run.status, out: JSON.parse(run.stdout) as { state: string; exitCode: number; modemAccess: string; ports: { at: string | null; audio: string | null }; messages: string[] } };
}

describe.skipIf(!windows)('modem and driver check', () => {
  it('is ready only when the AT port and the USB audio port both exist with signed drivers', () => {
    const r = check(good());
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ state: 'ready', modemAccess: 'none', ports: { at: 'COM20', audio: 'COM19' } });
    expect(r.out.messages.join(' ')).toMatch(/modem itself is not queried/);
  });

  it('says so when no modem is on USB', () => {
    const r = check([]);
    expect(r.code).toBe(10);
    expect(r.out.state).toBe('no_modem');
    expect(r.out.messages.join(' ')).toMatch(/Plug the modem/);
  });

  it('detects a modem whose driver is missing or in error and points to the official driver, never to a bundled one', () => {
    const r = check([dev('00', 'Simcom HS-USB Diagnostics', { Status: 'Error', Problem: 28, Provider: null, Version: null, IsSigned: false }), dev('02', 'Simcom HS-USB AT PORT 9001 (COM20)'), dev('04', 'Simcom HS-USB Audio 9001 (COM19)')]);
    expect(r.code).toBe(11);
    expect(r.out.state).toBe('driver_missing');
    const text = r.out.messages.join(' ');
    expect(text).toMatch(/official Windows USB driver/);
    expect(text).toMatch(/does not include or download a driver/);
    expect(text).toMatch(/unofficial site/);
  });

  it('detects a missing AT port and a missing audio port separately', () => {
    expect(check([dev('04', 'Simcom HS-USB Audio 9001 (COM19)')]).out.state).toBe('no_at_port');
    expect(check([dev('02', 'Simcom HS-USB AT PORT 9001')]).out.state).toBe('no_at_port'); // no COM number: not usable
    const noAudio = check([dev('02', 'Simcom HS-USB AT PORT 9001 (COM20)')]);
    expect(noAudio.code).toBe(13);
    expect(noAudio.out).toMatchObject({ state: 'no_audio_port', ports: { at: 'COM20', audio: null } });
    expect(noAudio.out.messages.join(' ')).toMatch(/USB audio port/);
  });

  it('does not accept an unsigned driver, and reports a missing Visual C++ runtime last', () => {
    const unsigned = good().map((d) => ({ ...d, IsSigned: false }));
    expect(check(unsigned).out.state).toBe('driver_unsigned');
    const noRuntime = check(good(), false);
    expect(noRuntime.code).toBe(15);
    expect(noRuntime.out.state).toBe('vc_runtime_missing');
    expect(check([], false).out.state).toBe('no_modem'); // the modem comes first
  });
});

describe('the package never contains a driver', () => {
  it('has no driver files in the repository or in the installer sources', () => {
    const root = path.resolve(__dirname, '../../..');
    const found: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name.startsWith('.next')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(inf|sys|cat|py|pyc)$/i.test(e.name) || /^python\d*(\.exe)?$/i.test(e.name) || /^requirements.*\.txt$/i.test(e.name)) found.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(found).toEqual([]);
  });

  it('has an installer that refuses to package a driver or a Python runtime', () => {
    const build = fs.readFileSync(path.resolve(__dirname, '../../../installer/build-package.ps1'), 'utf8');
    expect(build).toMatch(/\.inf/);
    expect(build).toMatch(/python/i);
    expect(build).toMatch(/must never be shipped/);
  });
});
