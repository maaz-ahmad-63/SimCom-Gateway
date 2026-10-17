'use client';

import React, { useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { conversationControl } from '../../lib/ai-readiness';
import { useAi } from '../../lib/context/AiContext';
import { useGateway } from '../../lib/context/GatewayContext';
import { ConversationPanel } from './ConversationPanel';
import { ActionNote, Card, useAction } from './ui';

export function ConversationCard() {
  const { state, refresh } = useAi();
  const { activeCall } = useGateway();
  const [action, run] = useAction();
  const [confirming, setConfirming] = useState(false);
  if (!state) return null;
  const session = state.sessions.find((s) => s.callId === activeCall?.id) ?? null;
  const control = conversationControl(activeCall, session?.conversation ?? null, state.conversation);
  if (!control.visible || !activeCall) return null;
  return (
    <Card
      title="Conversation mode"
      subtitle="Hands-off for one call: the AI listens, transcribes, answers and speaks, then listens again, with no click per turn. Off by default; the manual test response below stays available."
    >
      <ConversationPanel
        control={control}
        conversation={session?.conversation ?? null}
        confirming={confirming}
        busy={action.status === 'running'}
        onAsk={() => setConfirming(true)}
        onCancel={() => setConfirming(false)}
        onStart={async () => {
          setConfirming(false);
          await run(() => apiClient.setAiConversation(activeCall.id, true), 'Conversation mode is on for this call');
          await refresh();
        }}
        onStop={async () => {
          await run(() => apiClient.setAiConversation(activeCall.id, false), 'Conversation mode is off');
          await refresh();
        }}
      />
      <ActionNote state={action} />
    </Card>
  );
}
