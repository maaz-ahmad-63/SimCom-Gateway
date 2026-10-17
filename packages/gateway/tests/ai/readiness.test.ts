import { describe, expect, it } from 'vitest';
import { loadAiConfig } from '../../src/ai/config.js';
import { checkAiReadiness } from '../../src/ai/readiness.js';
import { aiEnv, SECRET } from './helpers.js';

const status = (name: string, readiness: ReturnType<typeof checkAiReadiness>) =>
  readiness.checks.find((c) => c.name === name)?.status;

function build(options: {
  env?: Record<string, string | undefined>;
  modemState?: string;
  call?: { state: string } | null;
  wire?: string;
  streaming?: boolean;
}) {
  const env = aiEnv({ AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true', ...options.env });
  return checkAiReadiness({
    configResult: loadAiConfig(env),
    env,
    modem: { getConnectionState: () => options.modemState ?? 'READY' } as never,
    manager: {
      getCurrentCall: () => (options.call === undefined ? { state: 'ACTIVE' } : options.call),
      getUsbAudioStatus: () => ({ audio: { state: options.wire ?? 'flowing', msSinceLastFrame: 5 } }),
    } as never,
    audio: { getStats: () => ({ isStreaming: options.streaming ?? true }) } as never,
  });
}

describe('AI readiness check', () => {
  it('passes only when everything is configured, verified and observed on the wire', () => {
    const readiness = build({});
    expect(readiness.blockers).toEqual([]);
    expect(readiness.ok).toBe(true);
  });

  it('is not ready by default: nothing about this hardware has been verified', () => {
    const readiness = build({ env: { AI_AUDIO_INBOUND_VERIFIED: undefined, AI_AUDIO_OUTBOUND_VERIFIED: undefined } });
    expect(readiness.ok).toBe(false);
    expect(status('inbound-audio', readiness)).toBe('unverified');
    expect(status('outbound-audio', readiness)).toBe('unverified');
  });

  it('does not let a verified flag stand in for the wire', () => {
    expect(status('inbound-audio', build({ wire: 'stalled' }))).toBe('fail');
    expect(status('inbound-audio', build({ wire: 'unverified' }))).toBe('fail');
    expect(status('inbound-audio', build({ wire: 'not-streaming' }))).toBe('fail');
    expect(status('outbound-audio', build({ streaming: false }))).toBe('fail');
  });

  it('does not let flowing bytes stand in for the verified flag', () => {
    const readiness = build({ env: { AI_AUDIO_INBOUND_VERIFIED: undefined }, wire: 'flowing' });
    expect(status('inbound-audio', readiness)).toBe('unverified');
    expect(readiness.ok).toBe(false);
  });

  it('cannot confirm audio without a call, so it blocks', () => {
    const readiness = build({ call: null });
    expect(status('call', readiness)).toBe('unverified');
    expect(status('inbound-audio', readiness)).toBe('unverified');
    expect(readiness.ok).toBe(false);
  });

  it('fails on an unavailable modem, missing sample rate, disabled AI and missing keys', () => {
    expect(status('modem', build({ modemState: 'ERROR' }))).toBe('fail');
    expect(status('audio-format', build({ env: { AI_AUDIO_SAMPLE_RATE: undefined } }))).toBe('fail');
    expect(status('ai-config', build({ env: { AI_ENABLED: 'false' } }))).toBe('fail');
    const keys = build({ env: { GROQ_API_KEY: undefined } });
    expect(status('provider-keys', keys)).toBe('fail');
    expect(keys.checks.find((c) => c.name === 'provider-keys')!.detail).toBe('missing: GROQ_API_KEY');
  });

  it('never reveals a credential', () => {
    expect(JSON.stringify(build({}))).not.toContain(SECRET);
    expect(JSON.stringify(build({ env: { GROQ_API_KEY: undefined } }))).not.toContain(SECRET);
  });
});

describe('AI readiness: inbound wire explanations', () => {
  const wire = (state: string) => build({ wire: state }).checks.find((c) => c.name === 'inbound-wire')!;

  it('explains that USB audio was never activated instead of calling it a stream fault, and still blocks', () => {
    const check = wire('not-expected');
    expect(check.status).toBe('fail');
    expect(check.passive).toBe(true);
    expect(check.detail).toMatch(/has not been activated for this call/);
    expect(build({ wire: 'not-expected' }).passiveOk).toBe(false);
  });

  it('keeps the plain stream wording for real stream faults, and passes only when bytes flow', () => {
    for (const state of ['stalled', 'unverified', 'not-streaming']) {
      expect(wire(state).status).toBe('fail');
      expect(wire(state).detail).toBe(`the USB audio stream is '${state}', not flowing`);
    }
    expect(wire('flowing').status).toBe('pass');
    expect(build({ wire: 'flowing' }).passiveOk).toBe(true);
  });

  it('does not treat an open audio port as flowing audio', () => {
    // health.audioStreaming mirrors "port open"; readiness must look at the wire state instead
    const readiness = build({ wire: 'not-expected', streaming: true });
    expect(readiness.passiveOk).toBe(false);
  });
});

describe('AI readiness: a registration that could not be stopped', () => {
  const wireCheck = (usb: Record<string, unknown>) => {
    const env = aiEnv({ AI_AUDIO_INBOUND_VERIFIED: 'true', AI_AUDIO_OUTBOUND_VERIFIED: 'true' });
    const readiness = checkAiReadiness({
      configResult: loadAiConfig(env),
      env,
      modem: { getConnectionState: () => 'READY' } as never,
      manager: { getCurrentCall: () => ({ state: 'ACTIVE' }), getUsbAudioStatus: () => usb } as never,
      audio: { getStats: () => ({ isStreaming: true }) } as never,
    });
    return readiness.checks.find((c) => c.name === 'inbound-wire')!;
  };

  it('explains a leftover registration on the next call instead of calling it a stream fault, and still blocks', () => {
    const check = wireCheck({ audio: { state: 'not-expected', msSinceLastFrame: null }, registrationUncertain: true });
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/may still hold a registration from the previous call/);
    expect(check.detail).toMatch(/AT\+CPCMREG=0/);
  });

  it('explains a rejected stop during a call as unknown audio state, and still blocks', () => {
    const check = wireCheck({ audio: { state: 'unverified', msSinceLastFrame: 100 }, lastDeactivation: { ok: false, at: 'x', error: 'AT ERROR' } });
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/could not be stopped .* audio state is unknown/);
  });

  it('keeps the plain wording for an ordinary unverified drop', () => {
    const check = wireCheck({ audio: { state: 'unverified', msSinceLastFrame: 100 }, lastDeactivation: { ok: true, at: 'x' } });
    expect(check.detail).toBe("the USB audio stream is 'unverified', not flowing");
  });
});
