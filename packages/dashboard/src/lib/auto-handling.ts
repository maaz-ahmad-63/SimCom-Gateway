/**
 * What the AI will do with calls, and why, from the gateway's own state (settings, confirmations, readiness, sessions). Pure:
 * no network. It never treats arriving audio bytes as speech, and never says the AI will speak unless every check passed.
 */
import type { AiReadinessView, AiSessionView, AiSettingsView } from '@sim-gateway/shared';

export type HandlingTone = 'good' | 'warn' | 'neutral';

export interface AutoHandlingView {
  tone: HandlingTone;
  title: string;
  lines: string[];
}

type Attestation = AiSettingsView['attestations']['inbound'] & { stale?: boolean; staleReason?: string | null };
interface CallLike {
  id: string;
  state: string;
  direction?: string;
}

const HOW_TO_ENABLE = 'To have the AI greet and answer callers by itself, turn on Automatic replies (Agent tab, Automation).';

export function autoHandling(input: {
  settings: AiSettingsView;
  readiness: AiReadinessView;
  sessions: AiSessionView[];
  call: CallLike | null;
}): AutoHandlingView {
  const { settings, readiness, sessions, call } = input;
  const { autoReplies } = settings.automation;
  const inbound = settings.attestations.inbound as Attestation;
  const outbound = settings.attestations.outbound as Attestation;
  const confirmed = inbound.confirmed && outbound.confirmed;
  const confirmationNote = confirmed
    ? null
    : [inbound, outbound].some((a) => a.stale)
      ? `Automatic replies need both audio confirmations at the current sample rate: ${(inbound.stale ? inbound.staleReason : outbound.staleReason) ?? 're-verify them on the Overview tab'}`
      : 'Automatic replies need both audio confirmations first (Overview tab: caller audio intelligible, agent audio audible).';

  if (settings.mode === 'off' || !settings.agent.enabled) {
    return { tone: 'neutral', title: 'AI is off', lines: ['Calls are not attached and nothing is transcribed or said.'] };
  }
  if (settings.autoHandle === 'off') {
    return { tone: 'neutral', title: 'Automatic attachment is off', lines: ['The AI attaches only when you press Attach on a call ("Attach the AI automatically" is off).'] };
  }

  const session = call ? (sessions.find((s) => s.callId === call.id) ?? null) : null;
  const covers = (direction: string | undefined) => settings.autoHandle === 'all' || settings.autoHandle === direction;

  if (call && call.state === 'ACTIVE') {
    if (session) {
      if (session.mode === 'active') return { tone: 'good', title: 'Attached: the AI is answering this call', lines: ['It greets the caller, then answers each finished sentence.'] };
      if (session.conversation?.enabled) return { tone: 'good', title: 'Attached: conversation mode is on for this call', lines: [] };
      const lines = ['Passive: it transcribes the caller and says nothing. Audio arriving is not proof of intelligible speech; check the live transcript.'];
      if (!autoReplies) lines.push(`It stays passive because Automatic replies are off. ${HOW_TO_ENABLE} You can also start Conversation mode for this call.`);
      else lines.push(`Automatic replies are on, but not every check passed when it attached: ${readiness.blockers.join(' | ') || 'see the readiness list'}`);
      if (confirmationNote) lines.push(confirmationNote);
      return { tone: 'warn', title: 'Attached in passive mode', lines };
    }
    if (call.direction && !covers(call.direction)) {
      return { tone: 'neutral', title: 'Not attached', lines: [`Automatic attachment covers ${settings.autoHandle} calls only; press Attach to use the AI on this one.`] };
    }
    return {
      tone: 'warn',
      title: 'Waiting to attach',
      lines: [
        readiness.passiveBlockers.length > 0
          ? `Not attached yet: ${readiness.passiveBlockers.join(' | ')}`
          : 'The checks pass; the AI attaches within a second or two.',
        'USB audio is activated a moment after the call is answered, so a short wait is normal.',
      ],
    };
  }

  // No call: what the next call will get.
  if (autoReplies && confirmed) {
    return { tone: 'good', title: 'Ready: the AI answers calls automatically', lines: [`Eligible ${settings.autoHandle === 'all' ? '' : `${settings.autoHandle} `}calls are attached once audio flows, and the AI greets and answers (all readiness checks must pass on the call).`] };
  }
  const lines = [`Eligible ${settings.autoHandle === 'all' ? '' : `${settings.autoHandle} `}calls are attached automatically in passive mode: transcription only, no greeting, no replies.`];
  if (!autoReplies) lines.push(HOW_TO_ENABLE);
  if (confirmationNote) lines.push(confirmationNote);
  return { tone: autoReplies ? 'warn' : 'neutral', title: 'Automatic attachment: passive', lines };
}
