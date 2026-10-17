'use client';

import React from 'react';
import { MessageSquare } from 'lucide-react';
import type { AiConversationView } from '@sim-gateway/shared';
import { formatLatency } from '../../lib/ai-inspector';
import { conversationLatencies, PHASE_LABELS } from '../../lib/ai-readiness';
import type { ConversationControl } from '../../lib/ai-readiness';
import type { Tone } from '../../lib/ai-secrets';
import { Badge, Button, Tile } from './ui';

const PHASE_TONE: Record<AiConversationView['phase'], Tone> = {
  stopped: 'neutral',
  listening: 'good',
  transcribing: 'warn',
  generating: 'warn',
  speaking: 'warn',
};

/** Presentational: the per-call conversation switch, the live pipeline phase, and the last turn's timings. */
export function ConversationPanel({
  control,
  conversation,
  confirming,
  busy,
  onAsk,
  onCancel,
  onStart,
  onStop,
}: {
  control: ConversationControl;
  conversation: AiConversationView | null;
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  if (!control.visible) return null;
  return (
    <div className="space-y-4" aria-label="Conversation mode">
      <div className="flex flex-wrap items-center gap-2">
        {conversation && <Badge tone={PHASE_TONE[conversation.phase]}>{PHASE_LABELS[conversation.phase]}</Badge>}
        {control.mode === 'stop' ? (
          <Button onClick={onStop} busy={busy}>
            Stop conversation
          </Button>
        ) : confirming ? (
          <>
            <Button variant="danger" onClick={onStart} busy={busy}>
              Yes: let the AI talk to the caller on this call
            </Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        ) : (
          <Button variant="primary" onClick={onAsk} disabled={!control.enabled} busy={busy} title={control.reason ?? undefined}>
            <MessageSquare className="w-3.5 h-3.5" /> Start conversation
          </Button>
        )}
      </div>
      {confirming && control.mode === 'start' && (
        <p className="text-xs text-rose-200">
          From now on every finished thing the caller says is sent to your speech, language and voice providers (billed) and the reply is spoken to them,
          until you stop it or the call ends. It applies to this call only.
        </p>
      )}
      {!control.enabled && control.mode === 'start' && control.reason && (
        <p className="text-xs text-amber-300" role="status">
          {control.reason}
        </p>
      )}
      {conversation?.enabled && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {conversationLatencies(conversation).map((row) => (
              <Tile key={row.label} label={row.label}>
                {formatLatency(row.ms)}
              </Tile>
            ))}
          </div>
          {conversation.lastTurn && (
            <p className="text-[11px] text-slate-400 font-mono">
              Last turn: {conversation.lastTurn.status}
              {conversation.lastTurn.reason ? ` (${conversation.lastTurn.reason})` : ''}
            </p>
          )}
          {conversation.lastTurn && conversation.lastTurn.firstAudioMs !== null && (
            <p className="text-[11px] text-slate-400">
              The caller waited about {formatLatency(conversation.endpointSilenceMs + conversation.lastTurn.firstAudioMs)} between finishing a sentence and the first reply audio being written
              ({formatLatency(conversation.endpointSilenceMs)} pause + {formatLatency(conversation.lastTurn.firstAudioMs)} processing). “Whole turn” also counts the time spent speaking.
            </p>
          )}
          {conversation.lastTurn && conversation.lastTurn.lateFrames > 0 && (
            <p role="alert" className="text-xs text-amber-300">
              {conversation.lastTurn.lateFrames} audio frame(s) were written late in the last reply, so the caller may have heard gaps.
            </p>
          )}
          {conversation.lastError && (
            <p role="alert" className="text-xs text-rose-300 font-mono break-words">
              Last error — {conversation.lastError.stage}: {conversation.lastError.message}
            </p>
          )}
          <p className="text-[11px] text-slate-500 leading-relaxed">
            {conversation.halfDuplex
              ? `Half-duplex: the AI does not hear the caller while it is speaking (and for a moment after), so it cannot answer its own voice. The caller should wait for it to finish. Ignored while speaking so far: ${conversation.ignoredWhileSpeakingSeconds} s.`
              : 'Full duplex: the caller can talk over the AI. Not verified on this hardware; echo can make the AI answer itself.'}
          </p>
          <p className="text-[11px] text-slate-500">Playback written means the gateway sent the audio to the modem. Whether the caller heard it is not verified.</p>
        </div>
      )}
    </div>
  );
}
