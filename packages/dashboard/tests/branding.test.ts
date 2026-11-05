import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Customer screens must not carry the old product name or the modem model. Hardware pages (Troubleshooting) and code comments are exempt. */
const OLD = /SIM ?Gateway|SIM7600|SIMCOM|SIMCom/;
const EXEMPT = [/hardware/i, /lib[\/]hardware-mode/, /sms-text/, /api-client/, /[\/]api[\/]/, /AtConsole|Diagnostics/i];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?)$/.test(n) ? [p] : [];
  });
}

describe('customer-facing branding', () => {
  it('uses SIZH IT Solution and not the old name in screens and messages', () => {
    const bad: string[] = [];
    for (const f of files(join(__dirname, '..', 'src'))) {
      if (EXEMPT.some((r) => r.test(f))) continue;
      const lines = readFileSync(f, 'utf8').split(/\r?\n/);
      lines.forEach((l, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(l) || l.includes('@sim-gateway/')) return;
        if (OLD.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 90)}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
