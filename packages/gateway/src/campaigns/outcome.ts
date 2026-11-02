/**
 * What a finished outbound call tells us, and no more than that.
 *
 * The modem reports how a call ended in a few ways, and only some of them mean one thing:
 *   - "NO ANSWER", or our own hang-up when the ring timeout ran out: it rang and nobody picked up        -> no_answer
 *   - "BUSY": the line was busy. A network may also report a declined call as busy, so a busy result may
 *     be a decline; it is kept separate from no_answer and is only retried if the operator chooses to       -> busy
 *   - "NO CARRIER" (or any other end) before the call was answered: this is what a declined call, an
 *     unreachable number, a dropped network and an early hang-up by the other side all look like. The
 *     modem cannot tell them apart, so this is NOT treated as a no-answer and is never retried            -> ended_before_answer
 *   - answered at all                                                                                      -> answered
 * A decline is therefore never claimed to be detected: the only safe handling of an ambiguous end is to not call again.
 *
 * The strings below are the termination reasons the call manager records; a test pins them to the manager's source.
 */
export type EndKind = 'answered' | 'no_answer' | 'busy' | 'ended_before_answer' | 'failed';

export const NO_ANSWER_REASONS = ['Dial timeout exceeded', 'Remote party did not answer'] as const;

export function classifyEnd(evidence: { outcome: string | null; reason: string | null }): EndKind {
  switch (evidence.outcome) {
    case 'completed':
      return 'answered';
    case 'busy':
      return 'busy';
    case 'failed':
      return 'failed';
    case 'no_answer':
      return NO_ANSWER_REASONS.some((r) => (evidence.reason ?? '').startsWith(r)) ? 'no_answer' : 'ended_before_answer';
    default:
      return 'ended_before_answer';
  }
}

export const AMBIGUOUS_END_NOTE =
  'The call ended before it was answered. The modem cannot tell a declined call from an unreachable number or a network drop, so it is not retried automatically.';
