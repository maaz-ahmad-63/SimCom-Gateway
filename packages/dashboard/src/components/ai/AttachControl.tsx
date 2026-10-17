'use client';

import React from 'react';
import { Mic } from 'lucide-react';
import type { AttachState } from '../../lib/ai-readiness';
import { Badge, Button } from './ui';

/**
 * The attach / detach control for the current call. Presentational: the decision of what is allowed
 * comes from attachControlState(), which mirrors the gateway's rules.
 */
export function AttachControl({
  callId,
  callState,
  control,
  busy,
  onAttach,
  onDetach,
}: {
  callId: string | null;
  callState: string | null;
  control: AttachState;
  busy?: boolean;
  onAttach: (callId: string) => void;
  onDetach: (callId: string) => void;
}) {
  if (!control.visible || !callId) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {callState && <Badge tone={callState === 'ACTIVE' ? 'good' : 'warn'}>call {callState}</Badge>}
      {control.mode === 'detach' ? (
        <Button onClick={() => onDetach(callId)} busy={busy}>
          Detach from call
        </Button>
      ) : (
        <Button
          variant="primary"
          onClick={() => onAttach(callId)}
          disabled={!control.enabled}
          busy={busy}
          aria-disabled={!control.enabled}
          title={control.reason ?? undefined}
        >
          <Mic className="w-3.5 h-3.5" /> Attach to this call
        </Button>
      )}
    </div>
  );
}
