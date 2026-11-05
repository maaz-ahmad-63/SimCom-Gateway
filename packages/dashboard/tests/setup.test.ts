import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SetupList } from '../src/components/ops/SetupList';
import { OpsHealth } from '../src/lib/ops';
import { setupSteps, setupSummary } from '../src/lib/setup';

const comp = (id: string, status: OpsHealth['components'][number]['status'] = 'ok', summary = 'fine') => ({ id, label: id, status, summary, observedAt: '2026-11-04T10:00:00.000Z' });
const health = (over: Record<string, OpsHealth['components'][number]['status']> = {}): OpsHealth => ({
  overall: 'ok',
  generatedAt: '2026-11-04T10:00:00.000Z',
  alerts: 0,
  components: ['gateway', 'modem', 'network', 'providers', 'database', 'storage', 'background'].map((id) => comp(id, over[id] ?? 'ok')),
});
const reading = (over: Record<string, unknown> = {}) =>
  ({
    takenAt: '2026-11-04T10:00:00.000Z',
    source: 'hardware',
    skippedBecause: null,
    sim: { state: 'ready', raw: null },
    signal: { rssi: 20, ber: 0, dbm: -73, level: 'excellent', text: 'excellent', raw: null },
    registration: { cs: { stat: 1, registered: true, text: 'registered', raw: null }, eps: { stat: 1, registered: true, text: 'registered', raw: null }, ps: { stat: null, registered: false, text: '', raw: null } },
    operator: 'Vi',
    verdict: { code: 'ok', severity: 'ok', title: 'Mobile network ready', explanation: 'Registered.', action: '', uncertain: false },
    ...over,
  }) as never;
const ready = { reachable: true, health: health(), network: reading(), hardware: { simulated: false, atPort: 'COM20', audioPort: 'COM19', discoveryOk: true }, ai: { ok: true, blockers: [], checks: [] } };
const byId = (steps: ReturnType<typeof setupSteps>, id: string) => steps.find((s) => s.id === id)!;

describe('first-run checklist', () => {
  it('is ready only when every step is done, and never places a call', () => {
    const steps = setupSteps(ready);
    expect(setupSummary(steps)).toMatchObject({ ready: true, label: 'Ready' });
    expect(byId(steps, 'testcall').detail).toMatch(/never placed from this page/);
    expect(byId(steps, 'testcall').href).toBe('/dialer');
  });

  it('says what to do when the gateway cannot be reached', () => {
    const steps = setupSteps({ reachable: false, health: null, network: null, hardware: null, ai: null });
    expect(byId(steps, 'app')).toMatchObject({ state: 'todo' });
    expect(byId(steps, 'app').action).toMatch(/Start SIZH IT Solution/);
    expect(setupSummary(steps).ready).toBe(false);
  });

  it('flags a missing modem, a SIM that is not ready, no network and missing AI keys, each with an action', () => {
    expect(byId(setupSteps({ ...ready, health: health({ modem: 'critical' }) }), 'modem')).toMatchObject({ state: 'todo' });
    expect(byId(setupSteps({ ...ready, hardware: { simulated: false, atPort: null, audioPort: null, discoveryOk: false } }), 'ports').action).toMatch(/modem USB driver/);
    const pin = setupSteps({ ...ready, network: reading({ sim: { state: 'pin_required', raw: null }, verdict: { code: 'sim_not_ready', severity: 'critical', title: 'SIM not ready', explanation: 'The SIM is asking for its PIN.', action: 'Unlock the SIM.', uncertain: false } }) });
    expect(byId(pin, 'sim')).toMatchObject({ state: 'todo', action: 'Unlock the SIM.' });
    const none = setupSteps({
      ...ready,
      network: reading({
        registration: { cs: { stat: 0, registered: false, text: 'x', raw: null }, eps: { stat: 0, registered: false, text: 'x', raw: null }, ps: { stat: null, registered: false, text: '', raw: null } },
        verdict: { code: 'no_network', severity: 'error', title: 'Not registered on a mobile network', explanation: 'e', action: 'Check the antenna.', uncertain: false },
      }),
    });
    expect(byId(none, 'network').state).toBe('todo');
    const noAi = setupSteps({ ...ready, ai: { ok: false, blockers: ['Deepgram key missing'], checks: [] } });
    expect(byId(noAi, 'ai')).toMatchObject({ state: 'todo', detail: 'Deepgram key missing' });
    expect(setupSummary(noAi).label).toBe('Not ready: 1 thing to fix');
    expect(byId(noAi, 'testcall').state).toBe('todo');
  });

  it('waits rather than guessing when something has not been read, and skips hardware steps for a simulated modem', () => {
    const waiting = setupSteps({ ...ready, network: reading({ source: 'skipped', skippedBecause: 'A call is in progress.' }) });
    expect(byId(waiting, 'sim')).toMatchObject({ state: 'waiting', detail: 'A call is in progress.' });
    expect(setupSummary(waiting).label).toBe('Checking…');
    const sim = setupSteps({ ...ready, hardware: { simulated: true, atPort: null, audioPort: null, discoveryOk: null }, network: null });
    expect(byId(sim, 'modem')).toMatchObject({ state: 'todo' }); // a simulated modem can never take a real call
    expect(['ports', 'audio', 'sim', 'network'].every((id) => byId(sim, id).state === 'skipped')).toBe(true);
  });

  it('draws every state', () => {
    const html = renderToStaticMarkup(React.createElement(SetupList, { steps: setupSteps({ ...ready, ai: { ok: false, blockers: ['x'], checks: [] } }) }));
    expect(html).toContain('data-state="done"');
    expect(html).toContain('data-state="todo"');
    expect(html).toContain('What to do:');
  });
});
