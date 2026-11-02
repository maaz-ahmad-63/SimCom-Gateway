import { AiInspectorEvent } from '@sim-gateway/shared';
import type { TraceInput } from './conversation.js';

const PER_CALL_LIMIT = 400;
const CALLS_KEPT = 5;

/**
 * In-memory inspector feed. Events are published live (Socket.IO `ai:event`) and the latest few
 * hundred per call are kept so a dashboard that connects or reconnects mid-call can catch up.
 * Recognized and spoken text is removed here unless the operator turned transcripts on, so no
 * subscriber, buffer or log below this point ever holds text the operator did not opt into.
 */
export class TraceHub {
  private seq = 0;
  private readonly byCall = new Map<string, AiInspectorEvent[]>();

  constructor(
    private readonly sink: (event: AiInspectorEvent) => void,
    private readonly showTranscripts: () => boolean,
    /** Where every event is also written (the observability store). Must not throw; a throw is swallowed anyway. */
    private readonly persist?: (callId: string, event: AiInspectorEvent) => void
  ) {}

  publish(callId: string, input: TraceInput): AiInspectorEvent {
    const event: AiInspectorEvent = {
      ...input,
      seq: ++this.seq,
      callId,
      timestamp: new Date().toISOString(),
    };
    if (event.text !== undefined && !this.showTranscripts()) {
      delete event.text;
      event.data = { ...event.data, textHidden: true };
    }
    let list = this.byCall.get(callId);
    if (!list) {
      list = [];
      this.byCall.set(callId, list);
      while (this.byCall.size > CALLS_KEPT) this.byCall.delete(this.byCall.keys().next().value as string);
    }
    list.push(event);
    if (list.length > PER_CALL_LIMIT) list.splice(0, list.length - PER_CALL_LIMIT);
    try {
      this.persist?.(callId, event);
    } catch {
      // Telemetry must never break the call pipeline.
    }
    try {
      this.sink(event);
    } catch {
      // A broken subscriber must not break the call pipeline.
    }
    return event;
  }

  recent(callId?: string): AiInspectorEvent[] {
    if (callId) return [...(this.byCall.get(callId) ?? [])];
    return [...this.byCall.values()].flat().sort((a, b) => a.seq - b.seq);
  }

  /** Forget a call's buffered events (retention: nothing outlives what the operator can see). */
  clear(): void {
    this.byCall.clear();
  }
}
