import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AudioVerificationInput, verifyInboundAudio, verifyOutboundAudio } from '../src/ai/audio-verification.js';

/**
 * Two things are pinned. (1) Manual mode, where a person must confirm, says exactly what readiness.ts says today, so extracting the logic
 * into this file changes nothing for anyone who keeps the manual flow. (2) Automatic mode passes only on live evidence from this call,
 * never on a flag nobody set, and never when the stream is not healthy.
 */
const base: AudioVerificationInput = { hasAudioAdapter: true, callActive: true, wireState: 'flowing', isStreaming: true, confirmedByPerson: false, autoVerify: false };
const input = (over: Partial<AudioVerificationInput>): AudioVerificationInput => ({ ...base, ...over });

describe('manual mode is unchanged', () => {
  it('needs the person\'s confirmation: without it, inbound and outbound are unverified', () => {
    expect(verifyInboundAudio(input({}))).toMatchObject({ status: 'unverified', basis: 'none' });
    expect(verifyOutboundAudio(input({}))).toMatchObject({ status: 'unverified', basis: 'none' });
  });

  it('with the confirmation, still requires a healthy stream during an active call', () => {
    expect(verifyInboundAudio(input({ confirmedByPerson: true }))).toMatchObject({ status: 'pass', basis: 'person' });
    expect(verifyInboundAudio(input({ confirmedByPerson: true, wireState: 'not-expected' }))).toMatchObject({ status: 'fail', detail: "verified flag is set but the wire shows 'not-expected'" });
    expect(verifyInboundAudio(input({ confirmedByPerson: true, callActive: false }))).toMatchObject({ status: 'unverified' });
    expect(verifyOutboundAudio(input({ confirmedByPerson: true }))).toMatchObject({ status: 'pass', basis: 'person' });
    expect(verifyOutboundAudio(input({ confirmedByPerson: true, isStreaming: false }))).toMatchObject({ status: 'fail', detail: 'verified flag is set but the audio port is not streaming' });
    expect(verifyOutboundAudio(input({ confirmedByPerson: true, callActive: false, isStreaming: false })).status).toBe('pass'); // as readiness.ts has always done
  });

  it('fails when there is no audio adapter, whatever else is set', () => {
    for (const over of [{}, { confirmedByPerson: true }, { autoVerify: true }]) {
      expect(verifyInboundAudio(input({ ...over, hasAudioAdapter: false })).status).toBe('fail');
      expect(verifyOutboundAudio(input({ ...over, hasAudioAdapter: false })).status).toBe('fail');
    }
  });

  it('uses the same wording as readiness.ts, so the two cannot drift apart', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/ai/readiness.ts'), 'utf8');
    const manual = [
      verifyInboundAudio(input({})).detail,
      verifyInboundAudio(input({ confirmedByPerson: true })).detail,
      verifyInboundAudio(input({ confirmedByPerson: true, callActive: false })).detail,
      verifyOutboundAudio(input({})).detail,
      verifyOutboundAudio(input({ confirmedByPerson: true })).detail,
      'verified flag is set but the audio port is not streaming',
    ];
    for (const text of manual) expect(source, text).toContain(text);
  });
});

describe('automatic mode rests on live evidence from this call', () => {
  const auto = (over: Partial<AudioVerificationInput> = {}) => input({ autoVerify: true, ...over });

  it('passes when bytes are flowing in and the audio port accepts writes, and says it was automatic', () => {
    expect(verifyInboundAudio(auto())).toMatchObject({ status: 'pass', basis: 'automatic' });
    expect(verifyOutboundAudio(auto())).toMatchObject({ status: 'pass', basis: 'automatic' });
    expect(verifyInboundAudio(auto()).detail).toMatch(/verified automatically/);
    expect(verifyInboundAudio(auto()).detail).toMatch(/flowing is not speech/); // it does not claim to have heard anything
  });

  it('does not pass before the call is active: there is nothing to measure yet', () => {
    expect(verifyInboundAudio(auto({ callActive: false, wireState: undefined }))).toMatchObject({ status: 'unverified', basis: 'automatic' });
    expect(verifyOutboundAudio(auto({ callActive: false, isStreaming: false }))).toMatchObject({ status: 'unverified', basis: 'automatic' });
  });

  it('fails, with the reason, when the stream is not healthy', () => {
    for (const wireState of ['not-expected', 'silent', 'unverified', undefined]) {
      const r = verifyInboundAudio(auto({ wireState }));
      expect(r.status, String(wireState)).toBe('fail');
      expect(r.detail).toContain(`'${wireState ?? 'unknown'}'`);
    }
    expect(verifyOutboundAudio(auto({ isStreaming: false })).status).toBe('fail');
  });

  it('uses the person\'s confirmation when there is one (and it is stricter or equal), and falls back to measurement when there is none', () => {
    expect(verifyInboundAudio(auto({ confirmedByPerson: true })).basis).toBe('person');
    expect(verifyInboundAudio(auto({ confirmedByPerson: true, wireState: 'not-expected' })).status).toBe('fail');
    expect(verifyInboundAudio(auto({ confirmedByPerson: false })).basis).toBe('automatic');
  });

  it('is not on by itself: with the setting off, nothing passes without a person', () => {
    expect(verifyInboundAudio(input({ autoVerify: false })).status).toBe('unverified');
    expect(verifyOutboundAudio(input({ autoVerify: false })).status).toBe('unverified');
  });
});
