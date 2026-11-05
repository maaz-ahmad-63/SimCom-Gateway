import type { CallSession, ICallSessionManager } from '@sim-gateway/shared';
import type { AgentAudioSink, PlayResult } from '../ai/audio.js';
import type { TraceInput } from '../ai/conversation.js';
import type { GatewayEventBus } from '../core/event-bus.js';
import { createLogger } from '../core/logger.js';
import type { IvrCallHandler, IvrCallOwner } from './ownership.js';
import type { IvrSnapshot } from './store.js';

/**
 * The IVR for one call at a time: deterministic call control, nothing else. It plays the announcements of the call's SNAPSHOT through
 * its own sink, listens for a key, and runs the configured action. It never touches the AI; handing a call over goes through the
 * ownership layer (`owner`), which releases the call and arms the existing AI.
 *
 *   welcome -> menu prompt -> listen -> (a key)  -> the option's action
 *                                    -> (wrong key) -> invalid announcement -> menu again   } each is a mistake;
 *                                    -> (no key)    -> timeout announcement -> menu again   } more than maxRetries -> final action
 *
 * Rules that make it safe on a live call:
 *  - ONE writer to the audio port: the IVR plays one announcement at a time, and before it lets the call go (to the AI, or to a
 *    hang-up) any announcement in progress has been stopped AND has finished. The AI cannot attach until the call is released.
 *  - It never leaves the caller in an IVR that has stopped working: any failure releases the call (to the AI if it can answer,
 *    otherwise the call is ended), through the ownership layer.
 *  - A caller who hangs up stops everything at once: playback is aborted, timers are cleared, nothing more is written.
 *  - What it records about a caller's choice is the option's POSITION and action, never the key that was pressed.
 */

const DEFAULT_HANDOFF_SETTLE_MS = 400;
const DEFAULT_DEBOUNCE_MS = 600;

export interface IvrControllerDeps {
  manager: Pick<ICallSessionManager, 'getCurrentCall' | 'hangup'>;
  /** Used for `call:ended`. */
  eventBus: GatewayEventBus;
  /**
   * Subscribe to the keys the caller presses (one callback per press event from the modem). The returned function unsubscribes.
   * The listener is given the key itself, so nothing on this path may log it.
   */
  onDtmf: (listener: (key: string) => void) => () => void;
  /** This call's own sink. Never shared with the AI. Null when the gateway has no audio path configured. */
  createSink: (call: CallSession, snapshot: IvrSnapshot) => AgentAudioSink | null;
  /** Why the IVR cannot play audio right now (audio not confirmed, not streaming, wrong rate), or null when it can. */
  audioProblem: (snapshot: IvrSnapshot) => string | null;
  /** Writes a line to the call's inspector trace and the persisted call log. */
  mark: (callId: string, event: TraceInput) => void;
  /** Quiet time between the caller's key press and handing the call to the AI, so the tone is not heard as speech. Default 400 ms. */
  handoffSettleMs?: number;
  /** A repeat of the same key within this long of the previous event counts as the same press (a held key repeats). Default 600 ms. */
  debounceMs?: number;
  now?: () => number;
}

type Played = 'done' | 'key' | 'ended';
type Heard = { key: string } | 'timeout' | 'ended';

class IvrCallRun {
  private readonly logger = createLogger('IvrController');
  private readonly runAbort = new AbortController();
  private playing: { abort: AbortController; interruptible: boolean; done: Promise<unknown> } | null = null;
  private waiter: ((key: string) => void) | null = null;
  /** A key that stopped an announcement (barge-in): it is the caller's answer, taken as soon as the announcement has stopped. */
  private pendingKey: string | null = null;
  private lastKey: string | null = null;
  private lastKeyAt = 0;
  private accepting = true;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly call: CallSession,
    private readonly snapshot: IvrSnapshot,
    private readonly owner: IvrCallOwner,
    private readonly sink: AgentAudioSink,
    private readonly deps: IvrControllerDeps,
    private readonly onFinished: () => void
  ) {}

  get id(): string {
    return this.call.id;
  }

  private get cfg() {
    return this.snapshot.config;
  }

  private mark(detail: string, status: 'ok' | 'failed' | 'skipped' = 'ok', data?: Record<string, string | number | boolean | null>): void {
    this.deps.mark(this.call.id, { turnId: null, stage: 'call', status, detail: `IVR: ${detail}`, ...(data ? { data: { ivr: true, ...data } } : {}) });
  }

  /** Entry point; never rejects. */
  async go(): Promise<void> {
    this.unsubscribe = this.deps.onDtmf((key) => this.press(key));
    try {
      await this.run();
    } catch (error) {
      await this.fail(`the IVR hit an error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.onFinished();
    }
  }

  /** The caller hung up (or the gateway is stopping): everything stops now. */
  end(): void {
    if (this.runAbort.signal.aborted) return;
    this.accepting = false;
    this.runAbort.abort();
    this.mark('the caller hung up; the IVR stopped', 'ok');
  }

  // ---- input -----------------------------------------------------------------------------------------------------------

  private press(key: string): void {
    if (!this.accepting || this.runAbort.signal.aborted) return;
    const now = (this.deps.now ?? Date.now)();
    const gap = this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const repeat = key === this.lastKey && now - this.lastKeyAt < gap;
    // The window slides with every event: a key held down keeps repeating and stays one press until it stops.
    this.lastKey = key;
    this.lastKeyAt = now;
    if (repeat) return;
    if (this.waiter) {
      const deliver = this.waiter;
      this.waiter = null;
      deliver(key);
    } else if (this.playing?.interruptible) {
      this.pendingKey = key;
      this.playing.abort.abort(); // barge-in: the announcement stops, and the key is the answer
    }
    // Any other moment (a key during an announcement that cannot be interrupted, or while the IVR is acting) is not a choice.
  }

  private takeKey(): string | null {
    const key = this.pendingKey;
    this.pendingKey = null;
    return key;
  }

  private listen(ms: number): Promise<Heard> {
    if (this.runAbort.signal.aborted) return Promise.resolve('ended');
    return new Promise<Heard>((resolve) => {
      const finish = (result: Heard) => {
        clearTimeout(timer);
        this.runAbort.signal.removeEventListener('abort', onAbort);
        this.waiter = null;
        resolve(result);
      };
      const timer = setTimeout(() => finish('timeout'), ms);
      const onAbort = () => finish('ended');
      this.runAbort.signal.addEventListener('abort', onAbort, { once: true });
      this.waiter = (key) => finish({ key });
    });
  }

  // ---- output ----------------------------------------------------------------------------------------------------------

  /** Play one announcement, to its end or until a key (when allowed) or the end of the call stops it. */
  private async play(assetId: string | null, step: string, interruptible: boolean): Promise<Played> {
    if (assetId === null) return 'done';
    if (this.runAbort.signal.aborted) return 'ended';
    const pcm = this.snapshot.pcm(assetId);
    if (!pcm) throw new Error(`the audio for the ${step} is missing from this call's snapshot`);
    const abort = new AbortController();
    const playback = this.sink.play(pcm, AbortSignal.any([this.runAbort.signal, abort.signal]));
    this.playing = { abort, interruptible: interruptible && this.cfg.allowBargeIn, done: playback.catch(() => undefined) };
    this.mark(`playing the ${step}`, 'ok', { step });
    let result: PlayResult;
    try {
      result = await playback; // resolved only when the sink has stopped writing: this is what "await playback" means at a handoff
    } finally {
      this.playing = null;
    }
    if (this.runAbort.signal.aborted) return 'ended';
    if (this.pendingKey !== null) return 'key';
    if (!result.completed) {
      if (result.stoppedBy === 'call-ended') return 'ended';
      throw new Error(`the ${step} stopped early (${result.stoppedBy ?? 'unknown reason'})`);
    }
    return 'done';
  }

  /** Stop whatever is playing and wait until the sink has really stopped writing. */
  private async quiesce(): Promise<void> {
    const playing = this.playing;
    if (!playing) return;
    playing.abort.abort();
    await playing.done;
  }

  // ---- the menu --------------------------------------------------------------------------------------------------------

  private async run(): Promise<void> {
    const cfg = this.cfg;
    this.mark(`menu started (published configuration version ${this.snapshot.version})`, 'ok', { version: this.snapshot.version });
    const hasOptions = cfg.options.length > 0;

    let key: string | null = null;
    let played = await this.play(cfg.welcome.assetId, 'welcome announcement', hasOptions);
    if (played === 'ended') return;
    if (played === 'key') key = this.takeKey();

    if (!hasOptions) {
      // Nothing to press: announce, then do the final action.
      played = await this.play(cfg.menu.assetId, 'menu announcement', false);
      if (played === 'ended') return;
      this.mark('no options are configured; running the final action', 'ok', { action: cfg.finalAction.type });
      return this.runFinal();
    }

    let mistakes = 0;
    for (;;) {
      if (key === null) {
        played = await this.play(cfg.menu.assetId, 'menu prompt', true);
        if (played === 'ended') return;
        if (played === 'key') key = this.takeKey();
      }
      if (key === null) {
        const heard = await this.listen(cfg.inputTimeoutMs);
        if (heard === 'ended') return;
        if (heard === 'timeout') {
          mistakes++;
          this.mark(`no key within ${Math.round(cfg.inputTimeoutMs / 1000)} s (mistake ${mistakes} of ${cfg.maxRetries + 1} allowed before the final action)`, 'ok', { event: 'timeout', mistakes });
          if (mistakes > cfg.maxRetries) return this.runFinal();
          played = await this.play(cfg.timeout.assetId, 'timeout announcement', true);
          if (played === 'ended') return;
          if (played === 'key') key = this.takeKey();
          continue;
        }
        key = heard.key;
      }

      const pressed = key;
      key = null;
      const index = cfg.options.findIndex((o) => o.key === pressed);
      if (index < 0) {
        mistakes++;
        this.mark(`a key that is not one of the options (mistake ${mistakes} of ${cfg.maxRetries + 1} allowed before the final action)`, 'ok', { event: 'invalid', mistakes });
        if (mistakes > cfg.maxRetries) return this.runFinal();
        played = await this.play(cfg.invalid.assetId, 'invalid-input announcement', true);
        if (played === 'ended') return;
        if (played === 'key') key = this.takeKey();
        continue;
      }

      const action = cfg.options[index].action;
      this.mark(`the caller chose option ${index + 1} (${action.type})`, 'ok', { event: 'option', option: index + 1, action: action.type });
      switch (action.type) {
        case 'connect-ai':
          return this.handOff('the caller chose the AI');
        case 'repeat-menu':
          break; // the menu plays again; this is not a mistake
        case 'play-announcement': {
          played = await this.play(action.assetId, 'announcement', true);
          if (played === 'ended') return;
          if (action.then === 'hang-up') return this.hangUp(null, 'the announcement was the last step');
          if (played === 'key') key = this.takeKey(); // it skipped the announcement, and it is also the next choice
          break;
        }
        case 'hang-up':
          return this.hangUp(action.goodbyeAssetId, 'the caller chose to end the call');
      }
    }
  }

  private runFinal(): Promise<void> {
    const action = this.cfg.finalAction;
    this.mark(`running the final action (${action.type})`, 'ok', { event: 'final', action: action.type });
    return action.type === 'connect-ai' ? this.handOff('the menu ran out of retries') : this.hangUp(action.goodbyeAssetId, 'the menu ran out of retries');
  }

  // ---- ways out --------------------------------------------------------------------------------------------------------

  private async handOff(why: string): Promise<void> {
    this.accepting = false; // from here the caller's keys are not choices (the tone of the last one is still dying away)
    await this.quiesce(); // the announcement has stopped, and the sink has stopped writing
    const settleMs = this.deps.handoffSettleMs ?? DEFAULT_HANDOFF_SETTLE_MS;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, settleMs);
      this.runAbort.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
    if (this.runAbort.signal.aborted) return; // the caller left during the settle
    this.mark(`handing the call to the AI (${why})`, 'ok', { event: 'handoff' });
    await this.owner.handOffToAi(this.call.id); // releases the call, then arms the AI; falls back to a hang-up if the AI cannot take it
  }

  private async hangUp(goodbyeAssetId: string | null, why: string): Promise<void> {
    this.accepting = false;
    try {
      await this.play(goodbyeAssetId, 'goodbye announcement', false);
    } catch (error) {
      this.mark(`the goodbye could not be played (${error instanceof Error ? error.message : String(error)}); ending the call anyway`, 'failed');
    }
    if (this.runAbort.signal.aborted) return;
    this.mark(`ending the call (${why})`, 'ok', { event: 'hangup' });
    try {
      await this.deps.manager.hangup('The IVR finished');
    } catch (error) {
      await this.fail(`the call could not be ended: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async fail(reason: string): Promise<void> {
    this.accepting = false;
    if (this.runAbort.signal.aborted) return; // the caller already left: nothing to release
    try {
      await this.quiesce();
    } catch (error) {
      this.logger.warn(`Stopping the IVR's playback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.owner.fail(this.call.id, reason); // to the AI if it can answer, otherwise the call is ended cleanly
  }
}

export class IvrController implements IvrCallHandler {
  private readonly logger = createLogger('IvrController');
  private readonly runs = new Map<string, IvrCallRun>();
  private readonly onEnded = (session: CallSession) => this.runs.get(session.id)?.end();

  constructor(private readonly deps: IvrControllerDeps) {
    deps.eventBus.on('call:ended', this.onEnded);
  }

  /** Calls the IVR is running right now. */
  get activeCalls(): string[] {
    return [...this.runs.keys()];
  }

  /** Called by the ownership layer once audio is flowing for a call the IVR owns. Returns at once; the menu runs in the background. */
  start(call: CallSession, snapshot: IvrSnapshot, owner: IvrCallOwner): void {
    if (this.runs.has(call.id)) return;
    const problem = this.deps.audioProblem(snapshot);
    if (problem) {
      void owner.fail(call.id, `audio is not ready for the IVR: ${problem}`);
      return;
    }
    const sink = this.deps.createSink(call, snapshot);
    if (!sink) {
      void owner.fail(call.id, 'the gateway has no audio path configured for the IVR');
      return;
    }
    const run = new IvrCallRun(call, snapshot, owner, sink, this.deps, () => this.runs.delete(call.id));
    this.runs.set(call.id, run);
    void run.go().catch((error: unknown) => this.logger.error(`IVR run for call ${call.id} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Stop every menu now (the gateway is shutting down). */
  stop(): void {
    this.deps.eventBus.off('call:ended', this.onEnded);
    for (const run of [...this.runs.values()]) run.end();
  }
}
