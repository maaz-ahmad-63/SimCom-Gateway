import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { AuthFailureLimiter, limitAuthFailures, securityHeaders } from '../src/api/middleware/security.js';
import { createAuthMiddleware } from '../src/api/middleware/auth.js';
import { RotatingFileLog } from '../src/core/log-file.js';
import { applyPendingRestore, BackupError, BackupService, checkBackupFile } from '../src/ops/backup.js';
import { CallDiagnosticsStore, explainCall, parseCeer, recordCallEnd } from '../src/ops/call-diagnostics.js';
import { assess, parseRegistration, parseSimState, signalFromCsq } from '../src/ops/network.js';
import { OPS_SCHEMA_SQL } from '../src/ops/schema.js';
import { compatibility } from '../src/ops/version.js';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const reading = (csq: string, cs: number, ageMs = 1000) => {
  const parts = { sim: parseSimState('+CPIN: READY'), signal: signalFromCsq(csq), registration: { cs: parseRegistration(`+CREG: 0,${cs}`, 'CREG'), eps: parseRegistration(`+CEREG: 0,${cs}`, 'CEREG'), ps: parseRegistration(null, 'CGREG') } };
  return { snapshot: { takenAt: new Date(Date.now() - ageMs).toISOString(), source: 'hardware' as const, skippedBecause: null, ...parts, operator: null, verdict: assess(parts) }, ageMs };
};
const facts = (over: Record<string, unknown>) => ({ callId: 'c1', finalStatus: 'busy', terminationReason: null, answered: false, ceer: null, network: null, networkAgeMs: null, ...over }) as Parameters<typeof explainCall>[0];

describe('busy is not blindly blamed on the destination or on the signal', () => {
  it('says plainly that an unexplained BUSY could be several things', () => {
    const e = explainCall(facts({}));
    expect(e).toMatchObject({ certainty: 'uncertain', failureStage: 'ringing', retryHint: 'unknown' });
    expect(e.explanation).toMatch(/busy line, a declined call and a carrier rejection/);
  });

  it('trusts the network cause when the modem gives one', () => {
    expect(explainCall(facts({ ceer: parseCeer('+CEER: User busy (cause 17)') }))).toMatchObject({ certainty: 'certain', explanation: 'The network reported that the destination was busy.' });
    const rejected = explainCall(facts({ ceer: parseCeer('+CEER: 21') }));
    expect(rejected.explanation).toMatch(/rejected/);
    expect(parseCeer('+CEER: Normal call clearing (16)').code).toBe(16);
    expect(parseCeer('OK').code).toBeNull();
  });

  it('does not blame the destination when the modem was not registered', () => {
    const r = reading('+CSQ: 20,0', 0);
    const e = explainCall(facts({ network: r.snapshot, networkAgeMs: r.ageMs }));
    expect(e.certainty).toBe('uncertain');
    expect(e.explanation).toMatch(/not registered on the mobile network/);
    expect(e.explanation).toMatch(/may not have been busy at all/);
    expect(e.retryHint).toBe('not_recommended');
  });

  it('ignores a network reading that is too old to be evidence, and mentions weak signal only as a possible factor', () => {
    const old = reading('+CSQ: 20,0', 0, 20 * 60_000);
    expect(explainCall(facts({ network: old.snapshot, networkAgeMs: old.ageMs })).explanation).not.toMatch(/not registered/);
    const weak = reading('+CSQ: 3,0', 1);
    const e = explainCall(facts({ network: weak.snapshot, networkAgeMs: weak.ageMs }));
    expect(e.explanation).toMatch(/signal was also weak/);
    expect(e.certainty).toBe('uncertain');
  });

  it('explains the other endings in plain words', () => {
    expect(explainCall(facts({ finalStatus: 'completed' })).explanation).toBe('The call connected and ended normally.');
    expect(explainCall(facts({ finalStatus: 'no_answer', terminationReason: 'Dial timeout exceeded' })).explanation).toMatch(/rang but nobody answered/);
    expect(explainCall(facts({ finalStatus: 'no_answer', terminationReason: 'NO CARRIER' })).certainty).toBe('uncertain');
    expect(explainCall(facts({ finalStatus: 'failed', terminationReason: 'Serial port closed during dial' })).explanation).toBe('The modem disconnected while the call was being set up.');
    expect(explainCall(facts({ finalStatus: 'failed', terminationReason: 'ERROR' })).explanation).toMatch(/did not report a more specific cause/);
    const none = reading('+CSQ: 20,0', 0);
    expect(explainCall(facts({ finalStatus: 'failed', network: none.snapshot, networkAgeMs: none.ageMs })).explanation).toBe('The call could not be placed because the modem was not registered on the mobile network (not registered on a mobile network).');
  });
});

describe('a diagnosis is saved with every call', () => {
  it('stores the evidence, never throws, and asks for the network cause only for calls that did not complete', async () => {
    const db = new Database(':memory:');
    db.exec(OPS_SCHEMA_SQL);
    const store = new CallDiagnosticsStore(db);
    const asked: number[] = [];
    const deps = { store, network: () => reading('+CSQ: 12,0', 1).snapshot, readCeer: async () => (asked.push(1), '+CEER: 17') };
    await recordCallEnd(deps, { id: 'ok-call', outcome: 'completed' });
    expect(asked).toHaveLength(0);
    const busy = await recordCallEnd(deps, { id: 'busy-call', outcome: 'busy', terminationReason: 'BUSY' });
    expect(asked).toHaveLength(1);
    expect(busy).toMatchObject({ causeCode: 17, certainty: 'certain', sim: 'ready', signal: { dbm: -89, level: 'fair' } });
    expect(store.get('busy-call')).toMatchObject({ finalStatus: 'busy', rawCeer: expect.stringContaining('+CEER') });
    expect(store.get('ok-call')).toMatchObject({ failureStage: 'none', retryHint: 'not_applicable' });
    // a failing AT query or a failing store must not escape into call cleanup
    expect(await recordCallEnd({ ...deps, readCeer: async () => { throw new Error('queue busy'); } }, { id: 'x', outcome: 'failed' })).not.toBeNull();
    expect(await recordCallEnd({ ...deps, store: { save: () => { throw new Error('disk full'); } } as never }, { id: 'y', outcome: 'busy' })).toBeNull();
    db.close();
  });
});

describe('backup and restore', () => {
  function setup(schema = 10) {
    const dir = tmp();
    const dbPath = path.join(dir, 'gateway.sqlite');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE _schema_migrations (version INTEGER PRIMARY KEY, name TEXT); INSERT INTO _schema_migrations VALUES (${schema}, 'x'); CREATE TABLE notes (t TEXT); INSERT INTO notes VALUES ('before');`);
    const svc = new BackupService({ db, dbPath, expectedSchema: 10, free: () => 10 * 1024 ** 3 });
    return { dir, dbPath, db, svc };
  }

  it('makes a checked copy and lists it', async () => {
    const { db, svc } = setup();
    const b = await svc.create('manual');
    expect(b.name).toMatch(/^manual-\d{14}\.sqlite$/);
    expect(svc.list().map((x) => x.name)).toContain(b.name);
    db.close();
  });

  it('refuses when there is no room, and refuses a name that escapes the folder', async () => {
    const { db, svc, dir } = setup();
    const full = new BackupService({ db, dbPath: path.join(dir, 'gateway.sqlite'), expectedSchema: 10, free: () => 1024 });
    await expect(full.create()).rejects.toThrow(/not enough free disk space/);
    for (const bad of ['../gateway.sqlite', '..\\x.sqlite', 'a/b.sqlite', 'x.txt', '']) expect(() => svc.stageRestore(bad)).toThrow(BackupError);
    expect(() => svc.stageRestore('nope.sqlite')).toThrow(/not found/);
    db.close();
  });

  it('stages a restore without touching the live database, then applies it at start with the old data kept', async () => {
    const { db, svc, dbPath, dir } = setup();
    const backup = await svc.create('manual');
    db.exec("INSERT INTO notes VALUES ('after')");
    expect(svc.stageRestore(backup.name)).toMatchObject({ requiresRestart: true });
    expect(svc.pending()?.name).toBe(backup.name);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 2 }); // untouched while running
    db.close();
    expect(applyPendingRestore(dbPath, 10)).toEqual({ applied: true });
    const restored = new Database(dbPath, { readonly: true });
    expect(restored.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 1 });
    restored.close();
    const kept = fs.readdirSync(path.join(dir, 'backups')).filter((n) => n.startsWith('pre-restore-'));
    expect(kept).toHaveLength(1); // the data that was replaced is still on disk
    const old = new Database(path.join(dir, 'backups', kept[0]), { readonly: true });
    expect(old.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 2 });
    old.close();
    expect(applyPendingRestore(dbPath, 10)).toEqual({ applied: false });
  });

  it('rejects damaged, foreign and too-new backups, and a cancelled restore leaves nothing behind', async () => {
    const { db, svc, dir, dbPath } = setup();
    const broken = path.join(dir, 'backups');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'manual-broken.sqlite'), 'this is not a database');
    expect(() => svc.stageRestore('manual-broken.sqlite')).toThrow(/could not be opened/);
    const foreign = new Database(path.join(broken, 'manual-foreign.sqlite'));
    foreign.exec('CREATE TABLE other (a TEXT)');
    foreign.close();
    expect(() => svc.stageRestore('manual-foreign.sqlite')).toThrow(/not a backup of this application/);
    const newer = new Database(path.join(broken, 'manual-newer.sqlite'));
    newer.exec("CREATE TABLE _schema_migrations (version INTEGER PRIMARY KEY, name TEXT); INSERT INTO _schema_migrations VALUES (99, 'future')");
    newer.close();
    expect(checkBackupFile(path.join(broken, 'manual-newer.sqlite'), 10)).toMatchObject({ ok: false });
    const good = await svc.create('manual');
    svc.stageRestore(good.name);
    expect(svc.cancelRestore()).toBe(true);
    expect(svc.pending()).toBeNull();
    // a staged file that went bad is discarded and the database stays as it was
    fs.writeFileSync(path.join(dir, 'restore-pending.sqlite'), 'garbage');
    expect(applyPendingRestore(dbPath, 10)).toMatchObject({ applied: false });
    expect(fs.existsSync(path.join(dir, 'restore-pending.sqlite'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 1 });
    db.close();
  });

  it('keeps only the newest automatic backups and never removes manual ones', async () => {
    const { db, dir, dbPath } = setup();
    let t = Date.parse('2026-11-04T10:00:00Z');
    const svc = new BackupService({ db, dbPath, expectedSchema: 10, keepAutomatic: 2, now: () => new Date((t += 1000)), free: () => 10 * 1024 ** 3 });
    const manual = await svc.create('manual');
    for (let i = 0; i < 4; i++) await svc.create('automatic');
    const names = fs.readdirSync(path.join(dir, 'backups'));
    expect(names.filter((n) => n.startsWith('auto-'))).toHaveLength(2);
    expect(names).toContain(manual.name);
    db.close();
  });
});

describe('log files', () => {
  it('writes one JSON object per line and rotates by size, keeping a bounded number of files', async () => {
    const dir = tmp();
    const log = new RotatingFileLog({ dir, maxBytes: 600, maxFiles: 3 });
    for (let i = 0; i < 60; i++) log.write({ ts: new Date().toISOString(), level: 'info', component: 'T', msg: `line ${i} ${'x'.repeat(40)}`, callId: 'c1' });
    await log.close();
    const files = fs.readdirSync(dir).filter((n) => n.startsWith('gateway.log'));
    expect(files.length).toBeLessThanOrEqual(4); // the current file and three rotated ones
    expect(files).toContain('gateway.log');
    const first = fs.readFileSync(path.join(dir, 'gateway.log'), 'utf8').trim().split('\n')[0];
    expect(JSON.parse(first)).toMatchObject({ level: 'info', component: 'T', callId: 'c1' });
    expect(fs.readdirSync(dir).every((n) => fs.statSync(path.join(dir, n)).size < 2000)).toBe(true);
  });

  it('removes rotated files past the retention period and survives an unwritable folder', () => {
    const dir = tmp();
    const old = path.join(dir, 'gateway.log.1');
    fs.writeFileSync(old, 'old');
    fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
    new RotatingFileLog({ dir, retentionDays: 14 });
    expect(fs.existsSync(old)).toBe(false);
    const errors: string[] = [];
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const broken = new RotatingFileLog({ dir: path.join(file, 'sub'), onError: (m) => errors.push(m) });
    expect(() => broken.write({ ts: 't', level: 'info', component: 'T', msg: 'm' })).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});

describe('api hardening', () => {
  function app(max: number) {
    let t = 0;
    const limiter = new AuthFailureLimiter(max, 60_000, () => t);
    const a = express();
    a.use(securityHeaders());
    a.use('/api', limitAuthFailures(createAuthMiddleware('correct-horse-battery'), limiter));
    a.get('/api/ping', (_q, r) => r.json({ ok: true }));
    return { a, advance: (ms: number) => (t += ms) };
  }

  it('sets security headers and never caches an API answer', async () => {
    const { a } = app(5);
    const res = await request(a).get('/api/ping').set('x-api-key', 'correct-horse-battery');
    expect(res.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  });

  it('blocks a client that keeps guessing, says when to retry, and lets the right key through before and after', async () => {
    const { a, advance } = app(3);
    expect((await request(a).get('/api/ping').set('x-api-key', 'correct-horse-battery')).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await request(a).get('/api/ping').set('x-api-key', `wrong-${i}`)).status).toBe(401);
    const blocked = await request(a).get('/api/ping').set('x-api-key', 'correct-horse-battery');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    advance(61_000);
    expect((await request(a).get('/api/ping').set('x-api-key', 'correct-horse-battery')).status).toBe(200);
  });

  it('resets the count after a correct key', async () => {
    const { a } = app(3);
    for (let i = 0; i < 2; i++) await request(a).get('/api/ping').set('x-api-key', 'bad');
    expect((await request(a).get('/api/ping').set('x-api-key', 'correct-horse-battery')).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await request(a).get('/api/ping').set('x-api-key', 'bad')).status).toBe(401);
  });
});

describe('version compatibility', () => {
  it('says whether a dashboard can talk to this gateway', () => {
    expect(compatibility(1).compatible).toBe(true);
    expect(compatibility(null).compatible).toBe(true);
    expect(compatibility(2)).toMatchObject({ compatible: false });
  });
});
