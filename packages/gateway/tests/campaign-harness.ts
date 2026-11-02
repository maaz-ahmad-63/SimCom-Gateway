import Database from 'better-sqlite3';
import { afterEach } from 'vitest';
import { CallContextRegistry } from '../src/campaigns/call-context.js';
import { CallEnd, CampaignDialer, PlacedCall } from '../src/campaigns/dialer.js';
import { analyzeRows } from '../src/campaigns/import.js';
import { parseCsv } from '../src/campaigns/csv.js';
import { CampaignSettings } from '../src/campaigns/policy.js';
import { CampaignRunner, RunnerDeps } from '../src/campaigns/runner.js';
import { CampaignStore } from '../src/campaigns/store.js';
import { runMigrations } from '../src/db/migrations.js';

const open: Database.Database[] = [];
afterEach(() => open.splice(0).forEach((d) => d.open && d.close()));

/** A dialer that never touches a modem: each call follows a script, and none can be hung up by the campaign. */
export class FakeDialer implements CampaignDialer {
  idle = true;
  readonly placed: Array<{ e164: string; metadata: Record<string, unknown>; at: number }> = [];
  script: Array<Partial<CallEnd> & { throws?: Error; hold?: Promise<void>; answered?: boolean }> = [];
  inFlight = 0;
  constructor(private readonly clock: { now: number }) {}
  isIdle() {
    return this.idle;
  }
  async dial(e164: string, options: { timeoutSeconds: number; metadata: Record<string, unknown> & { campaignContactId: number } }): Promise<PlacedCall> {
    const step = this.script.shift() ?? { outcome: 'completed' };
    if (step.throws) throw step.throws;
    this.placed.push({ e164, metadata: options.metadata, at: this.clock.now });
    this.inFlight++;
    const ended = (async () => {
      await step.hold;
      this.inFlight--;
      return { outcome: step.outcome ?? 'completed', reason: step.reason ?? null, durationSeconds: step.durationSeconds ?? 12 } as CallEnd;
    })();
    const answered = (step.answered ?? (step.outcome ?? 'completed') === 'completed') ? Promise.resolve() : new Promise<void>(() => {});
    return { callId: `call-${this.placed.length}`, ended, answered };
  }
}

export const FIVE = ['Name,Phone,Consent', 'A,+919876543210,yes', 'B,+14155550132,yes', 'C,+447911123456,yes', 'D,+61412345678,yes', 'E,+6591234567,yes'].join('\n');
export const MAP = { phone: 'Phone', name: 'Name', consent: 'Consent' };

export function makeHarness(over: { settings?: Partial<CampaignSettings>; csv?: string; runner?: Partial<RunnerDeps>; db?: Database.Database } = {}) {
  const clock = { now: Date.parse('2026-10-28T10:00:00.000Z') }; // a Wednesday, 10:00 UTC
  const db = over.db ?? new Database(':memory:');
  if (!over.db) runMigrations(db);
  open.push(db);
  const store = new CampaignStore(db, () => new Date(clock.now));
  const dialer = new FakeDialer(clock);
  const contexts = new CallContextRegistry();
  const alerts: Array<{ level: string; message: string }> = [];
  const runner = new CampaignRunner({ store, dialer, contexts, blockers: () => [], now: () => new Date(clock.now), alert: (level, message) => alerts.push({ level, message }), ...over.runner });
  const settings = { interCallDelaySeconds: 10, callingHours: { start: '09:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'UTC' }, ...over.settings };
  const campaign = store.create('Spring outreach', settings);
  const analysis = analyzeRows(parseCsv(over.csv ?? FIVE), MAP, campaign.settings, (e) => store.isDoNotCall(e));
  store.importContacts(campaign.id, analysis.rows, MAP);
  const advance = (ms: number) => (clock.now += ms);
  return { db, store, dialer, contexts, runner, campaign, clock, advance, alerts };
}
