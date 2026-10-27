import { createLogger } from '../core/logger.js';
import { ChatMessage, LlmProvider } from './providers/types.js';

/**
 * Call notes: what a conversation keeps of the turns that have scrolled out of the recent history.
 *
 * The history sent to the model is a window of the last few messages. Without this, a caller's name, a budget or a
 * promise made ten turns ago simply disappears. When messages leave the window they are folded, in the background,
 * into a short plain-text set of notes that rides along in the system prompt. It never delays a reply: a fold runs
 * after the turn, one at a time, and a reply uses whatever notes exist at that moment.
 *
 * The notes are model-written and are told to record only what was actually said. If the model fails, the dropped
 * lines are kept in a crude shortened form instead, so facts are never silently lost.
 */
const NOTES_SYSTEM =
  'You keep short notes about a phone call so an assistant remembers it. Update the notes with any NEW facts from the transcript: ' +
  "the caller's name, what they want, numbers, dates, budgets, decisions, promises the assistant made, and open questions. " +
  'Drop small talk and anything already in the notes. Never invent or infer anything. Keep the whole notes under 90 words, as short plain sentences. ' +
  'Output only the notes.';

export interface CallNotesOptions {
  enabled: boolean;
  /** Notes never grow beyond this (default 700 characters). */
  maxChars?: number;
  /** One summarisation request may take this long (default 6000 ms). */
  timeoutMs?: number;
}

export class CallNotes {
  private readonly logger = createLogger('CallNotes');
  private notes = '';
  private pending: ChatMessage[] = [];
  private running: Promise<void> | null = null;

  constructor(private readonly options: CallNotesOptions) {}

  get text(): string {
    return this.notes;
  }

  /** The system prompt with the notes appended, or the prompt unchanged when there are none. */
  withNotes(systemPrompt: string): string {
    if (!this.notes) return systemPrompt;
    return `${systemPrompt}\n\nCALL NOTES (facts from earlier in this call, for your memory; never read them out as a list):\n${this.notes}`;
  }

  /** Messages that just left the history window. Returns immediately; the folding happens in the background. */
  fold(dropped: ChatMessage[], llm: LlmProvider): void {
    if (!this.options.enabled || dropped.length === 0) return;
    this.pending.push(...dropped.map((m) => ({ ...m })));
    if (this.running === null) {
      this.running = this.drain(llm).finally(() => {
        this.running = null;
      });
    }
  }

  /** Resolves when every fold requested so far has finished (used by tests and at the end of a call). */
  async settled(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  clear(): void {
    this.notes = '';
    this.pending = [];
  }

  private async drain(llm: LlmProvider): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.pending.length);
      const max = this.options.maxChars ?? 700;
      try {
        this.notes = (await this.summarise(llm, batch)).slice(0, max);
      } catch (error) {
        this.logger.warn(`Call notes could not be updated by the model (${(error as Error).message}); keeping a short form of the dropped lines`);
        this.notes = this.crude(batch, max);
      }
    }
  }

  private async summarise(llm: LlmProvider, batch: ChatMessage[]): Promise<string> {
    const transcript = batch.map((m) => `${m.role === 'user' ? 'caller' : 'assistant'}: ${m.content}`).join('\n');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 6000);
    timer.unref?.();
    let out = '';
    try {
      for await (const chunk of llm.stream(
        {
          system: NOTES_SYSTEM,
          messages: [{ role: 'user', content: `CURRENT NOTES:\n${this.notes || '(none)'}\n\nNEW TRANSCRIPT:\n${transcript}\n\nUPDATED NOTES:` }],
        },
        controller.signal
      )) {
        if (chunk.delta) out += chunk.delta;
      }
    } finally {
      clearTimeout(timer);
    }
    const cleaned = out.replace(/\s+/g, ' ').trim();
    if (!cleaned) throw new Error('the model returned no notes');
    return cleaned;
  }

  /** The dropped lines, shortened, appended to what was already known; the oldest text goes first when it is too long. */
  private crude(batch: ChatMessage[], max: number): string {
    const lines = batch.filter((m) => m.role === 'user').map((m) => `Caller said: ${m.content.slice(0, 120)}`);
    const joined = [this.notes, ...lines].filter(Boolean).join(' ');
    return joined.length <= max ? joined : joined.slice(joined.length - max);
  }
}
