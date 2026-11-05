import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AlertStore } from '../src/ops/alerts.js';
import { backgroundCheck, classifyProviderFailure, databaseCheck, diskStatus, HealthMonitor, modemCheck, networkCheck, providersCheck, storageCheck } from '../src/ops/health.js';
import { assess, parseRegistration, parseSimState, signalFromCsq } from '../src/ops/network.js';
import { OPS_SCHEMA_SQL } from '../src/ops/schema.js';
import { redactStrings, safeConfig } from '../src/ops/support-bundle.js';

const open: Database.Database[] = [];
afterEach(() => open.splice(0).forEach((d) => d.close()));
function makeDb() {
  const db = new Database(':memory:');
  open.push(db);
  db.exec(OPS_SCHEMA_SQL);
  db.exec(`CREATE TABLE _schema_migrations (version INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE call_trace_events (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, at TEXT, stage TEXT, status TEXT, detail TEXT, provider TEXT, http_status INTEGER);
    CREATE TABLE call_analyses (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, created_at TEXT);`);
  return db;
}
const clock = { t: Date.parse('2026-11-04T10:00:00.000Z') };
const now = () => new Date(clock.t);

describe('alerts do not flood and resolve themselves', () => {
  it('keeps one record per problem, counts repeats, escalates, resolves and keeps history', () => {
    const events: string[] = [];
    const alerts = new AlertStore(makeDb(), now, (t, a) => events.push(`${t}:${a.key}`));
    const base = { key: 'modem:disconnected', component: 'modem', title: 'Modem disconnected', message: 'm', action: 'a' };
    for (let i = 0; i < 5; i++) alerts.raise({ ...base, severity: 'warning' });
    expect(alerts.active()).toHaveLength(1);
    expect(alerts.active()[0]).toMatchObject({ count: 5, severity: 'warning' });
    alerts.raise({ ...base, severity: 'critical' });
    expect(alerts.active()[0].severity).toBe('critical');
    expect(events).toEqual(['raised:modem:disconnected', 'escalated:modem:disconnected']); // five repeats caused one notice
    expect(alerts.resolve('modem:disconnected')?.status).toBe('resolved');
    expect(alerts.active()).toHaveLength(0);
    expect(alerts.resolve('modem:disconnected')).toBeNull();
    expect(events.at(-1)).toBe('resolved:modem:disconnected');
    alerts.raise({ ...base, severity: 'error' }); // the same problem again is a new record
    expect(alerts.history().total).toBe(2);
  });

  it('refuses to dismiss an active critical alert but lets it be acknowledged, and sorts worst first', () => {
    const alerts = new AlertStore(makeDb(), now);
    const crit = alerts.raise({ key: 'a', component: 'x', severity: 'critical', title: 't', message: 'm' });
    const info = alerts.raise({ key: 'b', component: 'x', severity: 'info', title: 't', message: 'm' });
    expect(() => alerts.dismiss(crit.id)).toThrow(/cannot be dismissed/);
    expect(alerts.acknowledge(crit.id).acknowledgedAt).not.toBeNull();
    expect(alerts.active().map((a) => a.key)).toEqual(['a', 'b']);
    alerts.dismiss(info.id);
    expect(alerts.active().map((a) => a.key)).toEqual(['a']);
    alerts.resolve('a');
    expect(() => alerts.dismiss(crit.id)).not.toThrow();
  });

  it('keeps technical detail out of the customer fields and redacts it', () => {
    const alerts = new AlertStore(makeDb(), now);
    const a = alerts.raise({ key: 'k', component: 'providers', severity: 'error', title: 'Key rejected', message: 'The provider did not accept the key.', details: { header: 'api_key=sk-abcdef1234567890', phone: '919876543210' } });
    expect(JSON.stringify(a)).not.toContain('sk-abcdef');
    const d = alerts.details(a.id)!;
    expect(JSON.stringify(d.details)).not.toContain('sk-abcdef1234567890');
    expect(JSON.stringify(d.details)).not.toContain('919876543210');
  });
});

describe('the health monitor keeps alerts in step with the checks', () => {
  it('raises while a check fails and resolves when it passes; a check that throws is unknown, not ok', async () => {
    const alerts = new AlertStore(makeDb(), now);
    let state = 'DISCONNECTED';
    let boom = false;
    const monitor = new HealthMonitor({
      alerts,
      now,
      checks: [
        modemCheck({ state: () => state, simulated: false, now }),
        { id: 'flaky', label: 'Flaky', run: () => { if (boom) throw new Error('x'); return { id: 'flaky', label: 'Flaky', status: 'ok', summary: 'fine', observedAt: now().toISOString() }; } },
      ],
    });
    let snap = await monitor.runAll();
    expect(snap.overall).toBe('critical');
    expect(alerts.active().map((a) => a.key)).toEqual(['modem:disconnected']);
    state = 'READY';
    snap = await monitor.runAll();
    expect(snap.overall).toBe('ok');
    expect(alerts.active()).toHaveLength(0);
    expect(alerts.history().items[0]).toMatchObject({ key: 'modem:disconnected', status: 'resolved' });
    boom = true;
    snap = await monitor.runAll();
    expect(snap.components.find((c) => c.id === 'flaky')!.status).toBe('unknown');
    expect(snap.overall).toBe('unknown');
  });

  it('does not call a modem that is still starting an error until it has had time', async () => {
    const alerts = new AlertStore(makeDb(), now);
    const check = modemCheck({ state: () => 'INITIALIZING', simulated: false, now, graceMs: 45_000 });
    const monitor = new HealthMonitor({ alerts, now, checks: [check] });
    await monitor.runAll();
    expect(alerts.active()).toHaveLength(0);
    clock.t += 60_000;
    await monitor.runAll();
    expect(alerts.active().map((a) => a.key)).toEqual(['modem:stuck']);
    expect((await modemCheck({ state: () => 'DISCONNECTED', simulated: true, now }).run()).status).toBe('not_applicable');
  });
});

describe('disk and storage', () => {
  it('maps free space to a status and never reports a number it could not read', async () => {
    expect(diskStatus(5 * 1024 ** 3).status).toBe('ok');
    expect(diskStatus(1 * 1024 ** 3).status).toBe('warning');
    expect(diskStatus(300 * 1024 ** 2).status).toBe('error');
    expect(diskStatus(50 * 1024 ** 2).status).toBe('critical');
    const run = (free: number | null, writable = true, recorderError: string | null = null) => storageCheck({ dataDir: 'd', recorderError: () => recorderError, now, free: () => free, writable: () => ({ ok: writable, error: writable ? undefined : 'EACCES' }) }).run();
    expect((await run(50 * 1024 ** 2)).alert).toMatchObject({ key: 'storage:disk-low', severity: 'critical' });
    expect((await run(10 * 1024 ** 3)).status).toBe('ok');
    expect((await run(null)).status).toBe('ok'); // unknown free space is not an alarm
    expect((await run(10 * 1024 ** 3, false)).status).toBe('critical');
    expect((await run(10 * 1024 ** 3, true, 'ENOSPC')).alert?.key).toBe('storage:recording-failed');
  });
});

describe('AI provider failures', () => {
  it('explains the common causes without showing raw errors', () => {
    expect(classifyProviderFailure({ http_status: 401, detail: null })).toMatchObject({ kind: 'auth', severity: 'error' });
    expect(classifyProviderFailure({ http_status: 429, detail: null }).kind).toBe('rate_limit');
    expect(classifyProviderFailure({ http_status: 402, detail: null }).kind).toBe('quota');
    expect(classifyProviderFailure({ http_status: 400, detail: 'You exceeded your current quota' }).kind).toBe('quota');
    expect(classifyProviderFailure({ http_status: 503, detail: null }).kind).toBe('unavailable');
    expect(classifyProviderFailure({ http_status: null, detail: 'request timed out' }).kind).toBe('timeout');
  });

  it('alerts on repeated failures from the trace and clears when the provider works again', async () => {
    const db = makeDb();
    const alerts = new AlertStore(db, now);
    const ins = db.prepare('INSERT INTO call_trace_events (call_id, at, stage, status, detail, provider, http_status) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const at = () => new Date(clock.t).toISOString();
    ins.run('c', at(), 'provider-attempt', 'failed', 'bad key', 'openai', 401);
    ins.run('c', at(), 'provider-attempt', 'failed', 'bad key', 'openai', 401);
    const monitor = new HealthMonitor({ alerts, now, checks: [providersCheck({ db, now })] });
    await monitor.runAll();
    expect(alerts.active()[0]).toMatchObject({ key: 'provider:openai:auth', severity: 'error' });
    expect(alerts.active()[0].title).toBe('AI provider rejected the API key');
    ins.run('c2', at(), 'provider-attempt', 'ok', null, 'openai', 200);
    await monitor.runAll();
    expect(alerts.active()).toHaveLength(0);
  });

  it('ignores a single failure and failures older than the window', async () => {
    const db = makeDb();
    const old = new Date(clock.t - 3_600_000).toISOString();
    const ins = db.prepare('INSERT INTO call_trace_events (call_id, at, stage, status, provider, http_status) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run('c', new Date(clock.t).toISOString(), 'provider-attempt', 'failed', 'groq', 500);
    ins.run('c', old, 'provider-attempt', 'failed', 'groq', 500);
    ins.run('c', old, 'provider-attempt', 'failed', 'groq', 500);
    expect((await providersCheck({ db, now }).run()).status).toBe('ok');
  });
});

describe('database and background checks', () => {
  it('detects a database behind the application and one that cannot be read', async () => {
    const db = makeDb();
    db.prepare('INSERT INTO _schema_migrations VALUES (10, ?)').run('x');
    expect((await databaseCheck({ db, expectedSchema: 10, now }).run()).status).toBe('ok');
    expect((await databaseCheck({ db, expectedSchema: 11, now }).run()).alert?.key).toBe('database:migration');
    db.close();
    expect((await databaseCheck({ db, expectedSchema: 10, now }).run()).alert?.key).toBe('database:unavailable');
  });

  it('flags a paused campaign and repeated analysis failures', async () => {
    const db = makeDb();
    expect((await backgroundCheck({ db, campaignPaused: () => '3 calls failed in a row', now }).run()).alert?.key).toBe('background:campaign-paused');
    const ins = db.prepare("INSERT INTO call_analyses (status, created_at) VALUES ('failed', ?)");
    for (let i = 0; i < 3; i++) ins.run(new Date(clock.t).toISOString());
    expect((await backgroundCheck({ db, campaignPaused: () => null, now }).run()).alert?.key).toBe('background:analysis-failing');
  });
});

describe('network check', () => {
  it('turns a network conclusion into an alert and marks a stale reading', async () => {
    const reading = (csq: string, cs: number) => {
      const parts = { sim: parseSimState('+CPIN: READY'), signal: signalFromCsq(csq), registration: { cs: parseRegistration(`+CREG: 0,${cs}`, 'CREG'), eps: parseRegistration(`+CEREG: 0,${cs}`, 'CEREG'), ps: parseRegistration(null, 'CGREG') } };
      return { takenAt: new Date(clock.t).toISOString(), source: 'hardware' as const, skippedBecause: null, ...parts, operator: null, verdict: assess(parts) };
    };
    const run = (s: ReturnType<typeof reading> | null, ready = true) => networkCheck({ snapshot: () => s, modemReady: () => ready, simulated: false, now }).run();
    const lost = await run(reading('+CSQ: 20,0', 0));
    expect(lost.status).toBe('error');
    expect(lost.alert?.key).toBe('network:no_network');
    expect((await run(reading('+CSQ: 3,0', 1))).alert?.key).toBe('network:weak_signal');
    expect((await run(reading('+CSQ: 20,0', 1))).status).toBe('ok');
    expect((await run(null, false)).status).toBe('unknown');
    clock.t += 20 * 60_000;
    expect((await run(reading('+CSQ: 20,0', 1))).status).toBe('ok'); // fresh relative to its own time
  });
});

describe('support bundle safety', () => {
  it('only lets allow-listed, non-secret configuration through', () => {
    const out = safeConfig({ host: '127.0.0.1', port: 4000, gatewayApiKey: 'secret-key-value', sqliteDbPath: 'C:/x', modemDriver: 'hardware', apiSecret: 'x' });
    expect(Object.keys(out).sort()).toEqual(['host', 'modemDriver', 'port']);
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('redacts strings but leaves numbers (such as byte counts) alone', () => {
    const out = redactStrings({ free: 17000000000, line: 'ATD919876543210; ok', nested: ['api_key=abc123def456'] }) as { free: number; line: string; nested: string[] };
    expect(out.free).toBe(17000000000);
    expect(out.line).not.toContain('919876543210');
    expect(out.nested[0]).not.toContain('abc123def456');
  });
});
