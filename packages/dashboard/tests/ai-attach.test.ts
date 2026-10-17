import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AiReadinessView } from '@sim-gateway/shared';
import { attachControlState } from '../src/lib/ai-readiness';
import { AttachControl } from '../src/components/ai/AttachControl';

const readiness = (over: Partial<AiReadinessView> = {}): AiReadinessView => ({
  passiveOk: true,
  ok: false,
  checkedAt: '2026-10-17T00:00:00.000Z',
  checks: [],
  blockers: ['outbound-audio: unverified'],
  passiveBlockers: [],
  mode: 'passive',
  simulatedHardware: false,
  ...over,
});

describe('attach control decisions', () => {
  it('is absent only when there is no call, and says so', () => {
    for (const call of [null, { state: 'IDLE' }]) {
      const s = attachControlState(call, readiness(), false);
      expect(s).toMatchObject({ visible: false, enabled: false });
      expect(s.reason).toMatch(/No call is in progress/);
    }
  });

  it('is visible but disabled for every non-ACTIVE call state, with a reason that names the state', () => {
    const dialing = attachControlState({ state: 'DIALING' }, readiness(), false);
    expect(dialing).toMatchObject({ visible: true, mode: 'attach', enabled: false });
    expect(dialing.reason).toMatch(/still dialing.*ACTIVE.*answers/);
    expect(attachControlState({ state: 'OUTBOUND_RINGING' }, readiness(), false).reason).toMatch(/ringing/);
    expect(attachControlState({ state: 'INBOUND_RINGING' }, readiness(), false).reason).toMatch(/Answer it first/);
    expect(attachControlState({ state: 'TERMINATING' }, readiness(), false)).toMatchObject({ visible: true, enabled: false });
    expect(attachControlState({ state: 'SOMETHING_NEW' }, readiness(), false).reason).toMatch(/SOMETHING_NEW/);
  });

  it('enables attach on an ACTIVE call only when the gateway says passive transcription may start', () => {
    expect(attachControlState({ state: 'ACTIVE' }, readiness(), false)).toEqual({ visible: true, mode: 'attach', enabled: true, reason: null });

    const noAudio = attachControlState(
      { state: 'ACTIVE' },
      readiness({ passiveOk: false, passiveBlockers: ["inbound-wire: the USB audio stream is 'unverified', not flowing"] }),
      false
    );
    expect(noAudio).toMatchObject({ visible: true, enabled: false });
    expect(noAudio.reason).toMatch(/Caller audio arriving: the USB audio stream is 'unverified', not flowing/);

    const modem = attachControlState({ state: 'ACTIVE' }, readiness({ passiveOk: false, passiveBlockers: ['modem: connection state INITIALIZING'] }), false);
    expect(modem.reason).toMatch(/Modem ready: connection state INITIALIZING/);

    expect(attachControlState({ state: 'ACTIVE' }, readiness({ mode: 'off', passiveOk: false }), false).reason).toMatch(/AI is off/);
    expect(attachControlState({ state: 'ACTIVE' }, null, false).reason).toMatch(/Waiting for the gateway/);
  });

  it('simulated hardware stays disabled and says why', () => {
    const s = attachControlState(
      { state: 'ACTIVE' },
      readiness({ passiveOk: false, simulatedHardware: true, passiveBlockers: ['hardware: the modem or audio adapter is simulated (mock driver); readiness can only be established on real hardware'] }),
      false
    );
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/Real modem hardware: the modem or audio adapter is simulated/);
  });

  it('offers detach once a session is attached, whatever the call state', () => {
    expect(attachControlState({ state: 'ACTIVE' }, readiness(), true)).toMatchObject({ mode: 'detach', enabled: true });
    expect(attachControlState({ state: 'TERMINATING' }, readiness(), true)).toMatchObject({ mode: 'detach', enabled: true });
  });

  it('follows the call through the transitions the socket reports', () => {
    const steps = ['DIALING', 'ACTIVE'].map((state) => attachControlState({ state }, readiness(), false).enabled);
    expect(steps).toEqual([false, true]);
  });
});

describe('attach control rendering', () => {
  const render = (state: string | null, ready: AiReadinessView | null, attached = false) => {
    const control = attachControlState(state ? { state } : null, ready, attached);
    return renderToStaticMarkup(
      React.createElement(AttachControl, { callId: state ? 'call-1' : null, callState: state, control, onAttach: vi.fn(), onDetach: vi.fn() })
    );
  };

  it('renders nothing without a call', () => {
    expect(render(null, readiness())).toBe('');
  });

  it('renders a disabled Attach button and the call state while dialing', () => {
    const html = render('DIALING', readiness());
    expect(html).toContain('Attach to this call');
    expect(html).toContain('call DIALING');
    expect(html).toMatch(/<button[^>]* disabled=""/);
    expect(html).toContain('title="The call is still dialing');
  });

  it('renders an enabled Attach button for a ready ACTIVE call, and Detach once attached', () => {
    const ready = render('ACTIVE', readiness());
    expect(ready).toContain('call ACTIVE');
    expect(ready).not.toMatch(/<button[^>]* disabled=""/);
    const attached = render('ACTIVE', readiness(), true);
    expect(attached).toContain('Detach from call');
    expect(attached).not.toContain('Attach to this call');
  });

  it('renders ACTIVE-but-not-ready as disabled with the audio reason as the tooltip', () => {
    const html = render('ACTIVE', readiness({ passiveOk: false, passiveBlockers: ["inbound-wire: the USB audio stream is 'unverified', not flowing"] }));
    expect(html).toMatch(/<button[^>]* disabled=""/);
    expect(html).toContain('Caller audio arriving');
  });
});
