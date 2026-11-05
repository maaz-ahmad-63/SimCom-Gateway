import type { ComponentHealth, NetworkReading, OpsHealth } from './ops';

/**
 * The first-run checklist. Each step is judged from what the gateway already reports (health, hardware, network, AI readiness); the
 * wizard changes nothing and never places a call. A step is "done", "todo" (something to fix, with what to do), "waiting" (not known
 * yet) or "skipped" (not applicable). The product is "ready" only when no step needs attention.
 */

export type StepState = 'done' | 'todo' | 'waiting' | 'skipped';

export interface SetupStep {
  id: string;
  title: string;
  state: StepState;
  detail: string;
  /** What to do, when the step is not done. */
  action?: string;
  /** Where to do it. */
  href?: string;
}

export interface SetupInput {
  /** Whether the gateway answered at all. */
  reachable: boolean;
  health: OpsHealth | null;
  network: NetworkReading | null;
  /** From the gateway's hardware status. */
  hardware: { simulated: boolean; atPort: string | null; audioPort: string | null; discoveryOk: boolean | null } | null;
  /** From the AI state. */
  ai: { ok: boolean; blockers: string[]; checks: Array<{ id?: string; label?: string; ok: boolean; detail?: string }> } | null;
}

const component = (h: OpsHealth | null, id: string): ComponentHealth | undefined => h?.components.find((c) => c.id === id);

export function setupSteps(i: SetupInput): SetupStep[] {
  const steps: SetupStep[] = [];
  const gw = component(i.health, 'gateway');
  const modem = component(i.health, 'modem');
  const storage = component(i.health, 'storage');
  const db = component(i.health, 'database');

  steps.push(
    i.reachable && i.health
      ? { id: 'app', title: 'Application health', state: i.health.overall === 'critical' ? 'todo' : 'done', detail: i.health.overall === 'ok' ? 'Everything the product depends on is working.' : 'The application is running, but some parts need attention (see below).', action: i.health.overall === 'critical' ? 'Open System health and fix the critical problem first.' : undefined, href: '/health' }
      : { id: 'app', title: 'Application health', state: 'todo', detail: 'The dashboard cannot reach the gateway.', action: 'Start SIZH IT Solution from the Start menu. If it was already started, wait a few seconds and refresh.' }
  );
  steps.push(gw ? { id: 'gateway', title: 'Gateway', state: gw.status === 'ok' ? 'done' : 'todo', detail: gw.summary } : { id: 'gateway', title: 'Gateway', state: 'waiting', detail: 'Waiting for the gateway to answer.' });
  steps.push(db && storage
    ? { id: 'storage', title: 'Database and storage', state: db.status === 'ok' && (storage.status === 'ok' || storage.status === 'warning') ? 'done' : 'todo', detail: `${db.summary}. ${storage.summary}.`, action: db.status === 'ok' && storage.status !== 'ok' ? 'Free up disk space before making many calls.' : undefined, href: '/health' }
    : { id: 'storage', title: 'Database and storage', state: 'waiting', detail: 'Waiting for the gateway to answer.' });

  if (i.hardware?.simulated) {
    steps.push({ id: 'modem', title: 'Modem', state: 'todo', detail: 'The product is running with a simulated modem, so no real call can be made.', action: 'Set the modem driver to hardware in the configuration, then restart SIZH IT Solution.' });
  } else {
    steps.push(modem ? { id: 'modem', title: 'Modem detection', state: modem.status === 'ok' ? 'done' : 'todo', detail: modem.summary, action: modem.status === 'ok' ? undefined : 'Plug in the modem into a USB port. Windows must show its COM ports (see Hardware).', href: '/hardware' } : { id: 'modem', title: 'Modem detection', state: 'waiting', detail: 'Waiting for the gateway to answer.' });
  }

  const hw = i.hardware;
  steps.push(
    !hw
      ? { id: 'ports', title: 'COM ports', state: 'waiting', detail: 'Waiting for the hardware status.' }
      : hw.simulated
        ? { id: 'ports', title: 'COM ports', state: 'skipped', detail: 'Not used with a simulated modem.' }
        : hw.atPort && hw.audioPort
          ? { id: 'ports', title: 'COM ports', state: 'done', detail: `Command port ${hw.atPort}, audio port ${hw.audioPort}${hw.discoveryOk ? ' (found automatically)' : ''}.` }
          : { id: 'ports', title: 'COM ports', state: 'todo', detail: 'The modem\'s command and audio ports were not both found.', action: 'Check that the modem USB driver is installed and the modem is plugged in. The Hardware page lists what Windows sees.', href: '/hardware' }
  );
  steps.push(
    !hw
      ? { id: 'audio', title: 'Audio interface', state: 'waiting', detail: 'Waiting for the hardware status.' }
      : hw.simulated
        ? { id: 'audio', title: 'Audio interface', state: 'skipped', detail: 'Not used with a simulated modem.' }
        : hw.audioPort
          ? { id: 'audio', title: 'Audio interface', state: 'done', detail: `The audio port ${hw.audioPort} is present. Audio quality is only proven by a real call.` }
          : { id: 'audio', title: 'Audio interface', state: 'todo', detail: 'No audio port was found.', action: 'See the Hardware page.', href: '/hardware' }
  );

  const net = i.network;
  const simOk = net?.source === 'hardware' ? net.sim.state === 'ready' : null;
  steps.push(
    hw?.simulated
      ? { id: 'sim', title: 'SIM card', state: 'skipped', detail: 'Not used with a simulated modem.' }
      : net?.source === 'hardware'
        ? { id: 'sim', title: 'SIM card', state: simOk ? 'done' : 'todo', detail: simOk ? 'The SIM is ready.' : net.verdict.explanation, action: simOk ? undefined : net.verdict.action, href: '/health' }
        : { id: 'sim', title: 'SIM card', state: 'waiting', detail: net?.skippedBecause ?? 'The SIM has not been read yet.' }
  );
  const registered = net?.source === 'hardware' ? net.registration.cs.registered || net.registration.eps.registered : null;
  steps.push(
    hw?.simulated
      ? { id: 'network', title: 'Mobile network', state: 'skipped', detail: 'Not used with a simulated modem.' }
      : net?.source === 'hardware'
        ? {
            id: 'network',
            title: 'Mobile network registration',
            state: registered && net.verdict.severity !== 'warning' && net.verdict.severity !== 'error' && net.verdict.severity !== 'critical' ? 'done' : 'todo',
            detail: `${net.verdict.title}. ${net.verdict.explanation}`,
            action: net.verdict.action || undefined,
            href: '/health',
          }
        : { id: 'network', title: 'Mobile network registration', state: 'waiting', detail: net?.skippedBecause ?? 'The network has not been read yet.' }
  );

  steps.push(
    !i.ai
      ? { id: 'ai', title: 'AI provider configuration', state: 'waiting', detail: 'Waiting for the AI status.' }
      : i.ai.ok
        ? { id: 'ai', title: 'AI provider configuration', state: 'done', detail: 'The speech, language and voice services are set up and their keys are present.' }
        : { id: 'ai', title: 'AI provider configuration', state: 'todo', detail: i.ai.blockers[0] ?? 'The AI agent is not ready yet.', action: 'Open AI Agent and enter the keys for the services you chose. Keys are stored encrypted and are never shown again.', href: '/ai' }
  );
  const providers = component(i.health, 'providers');
  steps.push(
    !providers
      ? { id: 'credentials', title: 'AI credentials work', state: 'waiting', detail: 'Waiting for the gateway to answer.' }
      : providers.status === 'ok'
        ? { id: 'credentials', title: 'AI credentials work', state: 'done', detail: 'No recent provider errors. Use "Test response" on the AI Agent page to prove each key.', href: '/ai' }
        : { id: 'credentials', title: 'AI credentials work', state: 'todo', detail: providers.summary, action: 'Open AI Agent, check the keys and use the test buttons.', href: '/ai' }
  );

  const needs = steps.filter((s) => s.state === 'todo').length;
  const waiting = steps.filter((s) => s.state === 'waiting').length;
  steps.push({
    id: 'testcall',
    title: 'Ready for a test call',
    state: needs === 0 && waiting === 0 ? 'done' : needs > 0 ? 'todo' : 'waiting',
    detail:
      needs === 0 && waiting === 0
        ? 'Everything above is ready. A test call is never placed from this page: open the Dialer, enter your own number and confirm the call yourself.'
        : needs > 0
          ? `${needs} step${needs === 1 ? '' : 's'} need attention before a test call.`
          : 'Still checking.',
    href: needs === 0 && waiting === 0 ? '/dialer' : undefined,
  });
  return steps;
}

export function setupSummary(steps: SetupStep[]): { ready: boolean; label: string; todo: number } {
  // The last step only summarises the others, so it is not counted as a thing to fix of its own.
  const real = steps.filter((s) => s.id !== 'testcall');
  const todo = real.filter((s) => s.state === 'todo').length;
  const waiting = real.filter((s) => s.state === 'waiting').length;
  if (todo > 0) return { ready: false, label: `Not ready: ${todo} thing${todo === 1 ? '' : 's'} to fix`, todo };
  if (waiting > 0) return { ready: false, label: 'Checking…', todo: 0 };
  return { ready: true, label: 'Ready', todo: 0 };
}
