import { END_CALL_PATTERN } from './catalog.js';

/**
 * Suppresses provider control syntax across arbitrary streaming chunk boundaries.
 * Port of labs-sizh-voicely services/llm/output_filter.py (ProtocolTextFilter).
 */
export class ProtocolTextFilter {
  private static readonly MARKERS = ['<|', '<tool_call', '<function=', '[tool_calls]', 'call tool='];
  private pending = '';
  private blocked = false;

  feed(chunk: string): string {
    if (this.blocked) return '';
    this.pending += chunk ?? '';
    const lower = this.pending.toLowerCase();
    const positions = ProtocolTextFilter.MARKERS.map((m) => lower.indexOf(m)).filter((p) => p >= 0);
    if (positions.length > 0) {
      const safe = this.pending.slice(0, Math.min(...positions));
      this.pending = '';
      this.blocked = true;
      return safe;
    }
    // Hold back a possible marker prefix until a later chunk disambiguates it.
    let held = 0;
    for (const marker of ProtocolTextFilter.MARKERS) {
      for (let size = 1; size <= Math.min(marker.length, lower.length); size++) {
        if (lower.endsWith(marker.slice(0, size))) held = Math.max(held, size);
      }
    }
    if (held > 0) {
      const safe = this.pending.slice(0, this.pending.length - held);
      this.pending = this.pending.slice(this.pending.length - held);
      return safe;
    }
    const safe = this.pending;
    this.pending = '';
    return safe;
  }

  finish(): string {
    if (this.blocked) return '';
    const safe = this.pending;
    this.pending = '';
    // An incomplete control TAG must stay private too. Only tag openers count: the plain-text marker
    // 'call tool=' is a prefix of ordinary words, and the source's equivalent rule swallowed a reply
    // ending in "call" (or the "CALL" of END_CALL) as an unfinished marker.
    const lowered = safe.toLowerCase();
    if (safe.length >= 2 && ProtocolTextFilter.MARKERS.some((m) => (m.startsWith('<') || m.startsWith('[')) && m.startsWith(lowered))) {
      this.blocked = true;
      return '';
    }
    return safe;
  }
}

const GLOBAL_END_CALL = new RegExp(END_CALL_PATTERN.source, 'gi');

/**
 * agent_models.strip_end_call, plus whether a token was present. The system prompt says "after
 * END_CALL, output no more text", so anything after the first token is discarded, not spoken.
 */
export function extractEndCall(text: string): { text: string; endRequested: boolean } {
  const match = new RegExp(END_CALL_PATTERN.source, 'i').exec(text);
  if (!match) return { text: text.replace(GLOBAL_END_CALL, ' ').replace(/\s+/g, ' ').trim(), endRequested: false };
  return { text: text.slice(0, match.index).replace(/\s+/g, ' ').trim(), endRequested: true };
}

/**
 * Turns a token stream into whole sentences so TTS can start before the model has finished.
 * Very short fragments are held back so TTS is not called for "Hi." alone, except at the end.
 */
export class SentenceSplitter {
  private buffer = '';
  private emitted = 0;

  /**
   * `firstMinChars` applies to the first sentence of a reply only: a short opener such as "Sure." can start playing
   * while the rest is still being written. Later sentences keep the longer minimum so TTS is not called for fragments.
   */
  constructor(
    private readonly minChars = 24,
    private readonly firstMinChars = minChars,
    /** When > 0, the first chunk may also end at a clause boundary (comma, semicolon, colon, dash) once it is this long. */
    private readonly firstClauseChars = 0
  ) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    // A sentence ends at . ! ? (or newline) followed by whitespace; decimals like 3.5 do not split.
    const boundary = /([.!?]+["')\]]*|\n)\s+/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      const candidate = this.buffer.slice(start, end).trim();
      if (candidate.length >= (this.emitted === 0 ? this.firstMinChars : this.minChars)) {
        out.push(candidate);
        this.emitted++;
        start = end;
      }
    }
    this.buffer = this.buffer.slice(start);
    // Phrase-level start: nothing has been emitted and no sentence has ended yet, but a clause is already long enough to
    // speak. Only the first chunk of a reply is ever cut this way; every later chunk waits for a sentence end.
    if (this.emitted === 0 && out.length === 0 && this.firstClauseChars > 0) {
      const clause = /([,;:]|[—–])\s+/g;
      let m: RegExpExecArray | null;
      while ((m = clause.exec(this.buffer)) !== null) {
        const end = m.index + m[0].length;
        const candidate = this.buffer.slice(0, end).trim();
        if (candidate.length >= this.firstClauseChars) {
          out.push(candidate);
          this.emitted++;
          this.buffer = this.buffer.slice(end);
          break;
        }
      }
    }
    return out;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) this.emitted++;
    return rest ? [rest] : [];
  }
}

/** Any speakable letter or digit; used to drop transcripts that are only punctuation or fillers. */
export function hasSpeechContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
