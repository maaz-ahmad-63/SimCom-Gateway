import { createLogger } from '../core/logger.js';
import { redactSecrets } from '../ai/providers/http.js';
import { snapshotForCall } from './campaign-agent.js';
import { CallContextRegistry } from './call-context.js';
import { CampaignDialer, CallEnd } from './dialer.js';
import { AMBIGUOUS_END_NOTE, classifyEnd } from './outcome.js';
import { buildCallContext, ContactDetails, renderGreeting } from './personalization.js';
import { shouldRetry, skipReason, withinCallingHours } from './policy.js';
import { CampaignStore, ContactRecord } from './store.js';

/** What the runner knows when a campaign call is over. Handed to an observer; it is never used to decide anything. */
export interface AttemptFinished {
  campaignId: string;
  contactId: number;
  callId: string | null;
  attempt: number;
  outcome: string;
  /** Why it did not connect, when the runner has a reason. */
  detail: string | null;
  phoneE164: string | null;
  at: string;
}

export type TickResult = 'idle' | 'waiting' | 'skipped' | 'dialed' | 'paused' | 'completed' | 'busy';

export interface RunnerDeps {
  store: CampaignStore;
  dialer: CampaignDialer;
  contexts: CallContextRegistry;
  /** Why the AI cannot take outbound calls right now; empty when it can. Checked before every call. */
  blockers: () => string[];
  /** Whether the AI agent is attached to a call. Absent means the check is not made (tests of other behaviour). */
  agent?: { attached: (callId: string) => boolean };
  /** Tells the operator about something that needs a person (shown as a gateway alert). */
  alert?: (level: 'info' | 'warn' | 'error', message: string) => void;
  now?: () => Date;
  /** The longest an answered call with the agent attached is waited for before the runner stops waiting and pauses (default 20 min). */
  hardCapMs?: number;
  /** How often the agent's attachment is looked at while waiting for it. */
  agentPollMs?: number;
  /** Told after each finished attempt (for the Google Sheets outcome log). Fire and forget: its failure never reaches the campaign. */
  onAttemptFinished?: (info: AttemptFinished) => void | Promise<void>;
  /** Overrides the campaign's attach wait (a test seam; production uses the setting). */
  agentAttachTimeoutMs?: number;
  pollMs?: number;
}

export interface RunnerStatus {
  campaignId: string | null;
  waiting: string | null;
  inFlight: { contactId: number; callId: string | null } | null;
  consecutiveFailures: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Places a campaign's calls one at a time, and only when every rule allows it at that moment: the AI can take the call, it is
 * inside the calling hours, the modem is idle, the pacing delay has passed, and the contact is still callable (not opted out,
 * not on the do-not-call list, consent in order, not called recently). It uses the existing call manager and never touches the
 * modem itself. It never hangs up a call: pause and stop take effect before the next call, and a call that is answered but gets
 * no AI agent pauses the campaign and alerts the operator, who hangs up from the Dialer.
 */
export class CampaignRunner {
  private readonly logger = createLogger('Campaigns');
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private lastEndedAt = 0;
  private consecutiveFailures = 0;
  private waiting: string | null = null;
  private inFlight: RunnerStatus['inFlight'] = null;
  private activeCampaignId: string | null = null;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  status(): RunnerStatus {
    return { campaignId: this.activeCampaignId, waiting: this.waiting, inFlight: this.inFlight, consecutiveFailures: this.consecutiveFailures };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (error) {
        this.logger.warn(`Campaign step failed: ${redactSecrets((error as Error).message)}`);
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => void loop(), this.deps.pollMs ?? 2000);
        this.timer.unref?.();
      }
    };
    this.timer = setTimeout(() => void loop(), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One decision: place at most one call, and return once its result has been recorded. Never overlaps itself. */
  async tick(): Promise<TickResult> {
    if (this.running) return 'busy';
    this.running = true;
    try {
      return await this.step();
    } finally {
      this.running = false;
    }
  }

  private async step(): Promise<TickResult> {
    const { store, dialer } = this.deps;
    const campaign = store.running();
    this.activeCampaignId = campaign?.id ?? null;
    if (!campaign) {
      this.waiting = null;
      this.consecutiveFailures = 0;
      return 'idle';
    }
    const settings = campaign.settings;
    const now = this.now();

    const blockers = this.deps.blockers();
    if (blockers.length > 0) {
      this.waiting = `waiting: ${blockers[0]}`;
      return 'waiting';
    }
    if (!withinCallingHours(now, settings.callingHours)) {
      this.waiting = `waiting for the calling hours (${settings.callingHours.start}-${settings.callingHours.end} ${settings.callingHours.timeZone})`;
      return 'waiting';
    }
    if (!dialer.isIdle()) {
      this.waiting = 'waiting: the gateway is handling another call';
      return 'waiting';
    }
    if (this.lastEndedAt > 0 && now.getTime() - this.lastEndedAt < settings.interCallDelaySeconds * 1000) {
      this.waiting = `waiting: ${settings.interCallDelaySeconds} s between calls`;
      return 'waiting';
    }

    const contact = store.nextDue(campaign.id);
    if (!contact) {
      const counts = store.counts(campaign.id);
      if (counts.queued === 0 && counts.calling === 0) {
        store.complete(campaign.id);
        this.waiting = null;
        return 'completed';
      }
      const retry = store.nextRetryAt(campaign.id);
      this.waiting = retry ? `waiting for the next retry at ${retry}` : 'waiting';
      return 'waiting';
    }

    // The rules are applied again here, immediately before dialling, not only when the campaign was started.
    const refusal =
      skipReason({ phoneE164: contact.phoneE164, consent: contact.consent, optOut: contact.optOut }, settings, contact.phoneE164 ? store.isDoNotCall(contact.phoneE164) : false) ??
      (contact.phoneE164 && contact.attempts === 0 && store.recentlyCalled(contact.phoneE164, settings.skipRecentlyCalledHours, contact.id) ? `this number was called within the last ${settings.skipRecentlyCalledHours} hours` : null);
    if (refusal) {
      store.markSkipped(contact.id, refusal);
      return 'skipped';
    }

    const claim = store.claim(contact.id);
    if (!claim) return 'skipped'; // someone else took it: never dial twice
    this.waiting = null;
    return this.place(campaign.id, contact, claim.attempt);
  }

  /** Resolves once the agent is attached to the answered call, the call ends, or the time runs out. */
  private async waitForAgent(callId: string, ended: Promise<CallEnd>, timeoutMs: number): Promise<'attached' | 'ended' | 'missing'> {
    const agent = this.deps.agent;
    if (!agent) return 'attached';
    let over = false;
    const endedFirst = ended.then(() => 'ended' as const);
    const deadline = Date.now() + timeoutMs;
    const poll = (async () => {
      while (!over) {
        if (agent.attached(callId)) return 'attached' as const;
        if (Date.now() >= deadline) return 'missing' as const;
        await sleep(Math.max(5, Math.min(this.deps.agentPollMs ?? 250, deadline - Date.now())));
      }
      return 'ended' as const;
    })();
    const result = await Promise.race([endedFirst, poll]);
    over = true;
    return result;
  }

  /** The call needs a person (nothing was dialled again, nothing was hung up): record it, pause the campaign, alert. */
  private needsAttention(campaignId: string, contact: ContactRecord, outcome: string, error: string, pauseReason: string): TickResult {
    const { store, contexts } = this.deps;
    store.finishAttempt(contact.id, { outcome, error, next: 'failed' });
    contexts.clear(contact.id);
    this.inFlight = null;
    this.lastEndedAt = this.now().getTime();
    if (store.require(campaignId).status === 'running') store.pause(campaignId, pauseReason);
    this.deps.alert?.('error', `Campaign paused: ${pauseReason}`);
    return 'paused';
  }

  private async place(campaignId: string, contact: ContactRecord, attempt: number): Promise<TickResult> {
    const { store, dialer, contexts } = this.deps;
    const campaign = store.require(campaignId);
    const settings = campaign.settings;
    const details: ContactDetails = { name: contact.name, designation: contact.designation, company: contact.company, context: contact.context, extra: contact.extra };
    // Registered before the dial: the call carries the contact id in its metadata, and the AI looks the context up from there.
    // Everything this call will be told is fixed here, from the configuration in force at this moment, and held for this call alone.
    const snapshot = snapshotForCall(campaign, details);
    contexts.register({
      contactId: contact.id,
      campaignId,
      contextBlock: snapshot.contactBlock ?? buildCallContext(details, settings),
      greeting: renderGreeting(settings.greetingTemplate, details),
      llmKey: snapshot.llmKey,
      configVersion: snapshot.configVersion,
      promptSha: snapshot.promptSha,
      ...(snapshot.systemPrompt ? { systemPrompt: snapshot.systemPrompt, promptCacheKey: snapshot.promptCacheKey } : {}),
    });
    store.setAttemptSnapshot(contact.id, { configVersion: snapshot.configVersion, promptSha: snapshot.promptSha, llmKey: snapshot.llmKey });
    this.inFlight = { contactId: contact.id, callId: null };

    let end: CallEnd | null = null;
    let error: string | null = null;
    try {
      const placed = await dialer.dial(contact.phoneE164 as string, { timeoutSeconds: settings.callTimeoutSeconds, metadata: { campaignId, campaignContactId: contact.id, campaignAttempt: attempt } });
      store.setCallId(contact.id, placed.callId);
      this.inFlight = { contactId: contact.id, callId: placed.callId };

      const first = await Promise.race([placed.ended.then((e) => ({ ended: e })), placed.answered.then(() => ({ answered: true as const }))]);
      if ('ended' in first) {
        end = first.ended;
      } else {
        // Answered. The person must hear the agent: if it does not attach in time they are hearing silence.
        const agent = await this.waitForAgent(placed.callId, placed.ended, this.deps.agentAttachTimeoutMs ?? settings.agentAttachTimeoutSeconds * 1000);
        if (agent === 'missing') {
          return this.needsAttention(
            campaignId,
            contact,
            'agent_missing',
            `The call was answered but the AI agent did not attach within ${settings.agentAttachTimeoutSeconds} s, so the person heard silence. It is not retried automatically.`,
            `a call was answered but the AI agent did not attach (it is still connected: hang up from the Dialer page, fix the audio or AI setup, then resume)`
          );
        }
        end = await Promise.race([placed.ended, sleep(this.deps.hardCapMs ?? 1_200_000).then(() => null)]);
        if (!end) {
          return this.needsAttention(
            campaignId,
            contact,
            'no_end_report',
            'The call did not report that it ended within the maximum time. It is not retried automatically.',
            'a call has not ended after the maximum time (it may still be connected: check the Dialer page, then resume)'
          );
        }
      }
    } catch (e) {
      const message = redactSecrets((e as Error).message ?? 'dial failed');
      if ((e as Error).name === 'GatewayBusyError' || /already active/i.test(message)) {
        // The gateway took another call between our check and the dial: nothing was dialled, so the attempt is given back.
        store.release(contact.id);
        contexts.clear(contact.id);
        this.inFlight = null;
        this.waiting = 'waiting: the gateway is handling another call';
        return 'busy';
      }
      error = message;
    }

    const kind = end ? classifyEnd(end) : 'failed';
    const finished = this.now();
    this.lastEndedAt = finished.getTime();
    const failedHard = error !== null || kind === 'failed';
    this.consecutiveFailures = failedHard ? this.consecutiveFailures + 1 : 0;

    const retry = kind !== 'answered' && shouldRetry(kind, attempt, settings);
    store.finishAttempt(contact.id, {
      outcome: kind,
      error: error ?? (kind === 'ended_before_answer' ? AMBIGUOUS_END_NOTE : kind === 'answered' ? null : (end?.reason ?? null)),
      next: kind === 'answered' ? 'completed' : retry ? { retryAt: new Date(finished.getTime() + settings.retryDelayMinutes * 60_000).toISOString() } : 'failed',
    });
    contexts.clear(contact.id);
    this.inFlight = null;
    if (this.deps.onAttemptFinished) {
      const info: AttemptFinished = {
        campaignId,
        contactId: contact.id,
        callId: store.getContact(contact.id)?.callId ?? null,
        attempt,
        outcome: kind,
        detail: error ?? (kind === 'ended_before_answer' ? AMBIGUOUS_END_NOTE : kind === 'answered' ? null : (end?.reason ?? null)),
        phoneE164: contact.phoneE164,
        at: finished.toISOString(),
      };
      try {
        void Promise.resolve(this.deps.onAttemptFinished(info)).catch((e) => this.logger.warn(`Outcome log failed: ${redactSecrets((e as Error).message ?? '')}`));
      } catch (e) {
        this.logger.warn(`Outcome log failed: ${redactSecrets((e as Error).message ?? '')}`);
      }
    }
    // Stopped while the call was running: a retry must not stay queued in a campaign that no longer exists as a queue.
    if (retry && store.require(campaignId).status === 'stopped') store.markSkipped(contact.id, 'campaign stopped');

    if (failedHard && this.consecutiveFailures >= settings.maxConsecutiveFailures && store.require(campaignId).status === 'running') {
      store.pause(campaignId, `${this.consecutiveFailures} calls failed in a row; check the modem and the network, then resume`);
      this.consecutiveFailures = 0;
      return 'paused';
    }
    return 'dialed';
  }
}
