import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sim7600HardwareAudioAdapter } from '../src/adapters/audio/hardware-audio.js';
import { playPcmPaced } from '../src/adapters/audio/paced-playback.js';
import { AtCommandQueue } from '../src/adapters/modem/at-command-queue.js';
import { AtParser } from '../src/adapters/modem/at-parser.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { describeClose, FakeSerialTransport } from '../src/adapters/modem/serial-transport.js';
import { createGatewayRouter } from '../src/api/routes/gateway.js';
import { CallSessionManager } from '../src/core/call-session-manager.js';
import { GatewayEventBus } from '../src/core/event-bus.js';
import { speechIndicators } from '../src/diagnostics/pcm-tools.js';
import { UsbPcmVerifier } from '../src/diagnostics/usb-pcm-verification.js';
import { AtCommandError, CallSession, SerialPortDisconnectedError, UsbAudioRecoveryReport } from '@sim-gateway/shared';

const LE8K = { sampleRate: 8000, channels: 1, bitDepth: 16 as const, endianness: 'little-endian' as const };
const ACTIVE_CALL = '+CLCC: 1,0,0,0,0,"+910000000000",145\nOK';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('PCM helpers', () => {
  it('parses AT+CLCC without returning the remote number', () => {
    const calls = AtParser.parseClcc('+CLCC: 1,1,0,0,0,"+910000000000",145\n+CLCC: 2,0,1,0,0\nOK');
    expect(calls).toEqual([
      { index: 1, direction: 1, status: 0, mode: 0 },
      { index: 2, direction: 0, status: 1, mode: 0 },
    ]);
    expect(JSON.stringify(calls)).not.toContain('910000000000');
    expect(AtParser.parseClcc('OK')).toEqual([]);
  });

  it('parses the module PCM queries documented in the AT manual', () => {
    expect(AtParser.parsePrefixedIntegers('+CPCMREG: 1\nOK', 'CPCMREG')).toEqual([1]);
    expect(AtParser.parsePrefixedIntegers('+CPCMFRM: 0\nOK', 'CPCMFRM')).toEqual([0]);
    expect(AtParser.parsePrefixedIntegers('+CPCMBANDWIDTH: 1,0\nOK', 'CPCMBANDWIDTH')).toEqual([1, 0]);
    expect(AtParser.parsePrefixedIntegers('ERROR', 'CPCMREG')).toBeNull();
  });

  it('flags voiced speech-like audio but not noise or a byte-swapped decode of it', () => {
    // 120 Hz glottal-pulse train with a few harmonics, gated like syllables.
    const voiced = Buffer.alloc(8000 * 2);
    for (let i = 0; i < 8000; i++) {
      const gate = Math.floor(i / 800) % 2 === 0 ? 1 : 0;
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * 120 * h * i) / 8000) / h;
      voiced.writeInt16LE(Math.round(v * 3000 * gate), i * 2);
    }
    const hint = speechIndicators(voiced, LE8K);
    expect(hint.energeticFrames).toBeGreaterThan(10);
    expect(hint.voicedRatio).toBeGreaterThan(0.8);
    expect(hint.medianPitchHz).toBeGreaterThan(110);
    expect(hint.medianPitchHz).toBeLessThan(130);

    const noise = Buffer.alloc(8000 * 2);
    let seed = 12345;
    for (let i = 0; i < 8000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise.writeInt16LE((seed % 6000) - 3000, i * 2);
    }
    expect(speechIndicators(noise, LE8K).voicedRatio).toBeLessThan(0.3);
    expect(speechIndicators(Buffer.alloc(16000), LE8K).energeticFrames).toBe(0);
  });
});

describe('paced PCM playback', () => {
  it('keeps real-time pace instead of drifting like a per-chunk timer', async () => {
    const times: number[] = [];
    const result = await playPcmPaced(async () => void times.push(performance.now()), Buffer.alloc(320 * 25), {
      sampleRate: 8000,
    });

    expect(result).toMatchObject({ framesWritten: 25, bytesWritten: 8000, stoppedBy: null });
    // 3 frames go out immediately (write-ahead), then one per 20 ms: about 22 * 20 = 440 ms.
    const spread = times[times.length - 1] - times[0];
    expect(spread).toBeGreaterThan(380);
    expect(spread).toBeLessThan(560);
  });

  it('writes a short final frame as is', async () => {
    const sizes: number[] = [];
    await playPcmPaced(async (chunk) => void sizes.push(chunk.length), Buffer.alloc(700), { sampleRate: 8000 });
    expect(sizes).toEqual([320, 320, 60]);
  });

  it('stops as soon as asked and reports why', async () => {
    let frames = 0;
    const result = await playPcmPaced(async () => void frames++, Buffer.alloc(320 * 50), {
      sampleRate: 8000,
      shouldStop: () => (frames >= 5 ? 'call-ended' : null),
    });
    expect(result).toMatchObject({ framesWritten: 5, stoppedBy: 'call-ended' });
  });

  it('reports lateness when the port cannot keep up', async () => {
    const result = await playPcmPaced(() => sleep(45), Buffer.alloc(320 * 8), { sampleRate: 8000 });
    expect(result.lateFrames).toBeGreaterThan(0);
    expect(result.maxLateMs).toBeGreaterThan(20);
  });
});

describe('who closed the port', () => {
  it('tells a device removal from a host close in the error that reaches the queue', async () => {
    for (const [close, expected] of [
      [(t: FakeSerialTransport) => t.simulateDisconnect(), /closed: device disconnected/],
      [(t: FakeSerialTransport) => void t.close(), /closed by the gateway/],
    ] as const) {
      const transport = new FakeSerialTransport('COM22', 115200);
      await transport.open();
      const queue = new AtCommandQueue(transport);
      queue.on('error', () => {});
      const pending = queue.execute('AT+CSQ', 5000);
      close(transport);
      await expect(pending).rejects.toThrow(expected);
    }
  });

  it('describes the three kinds of close', () => {
    expect(describeClose(undefined)).toBe('closed');
    expect(describeClose({ disconnected: true, requestedByHost: false, detail: 'gone' })).toBe(
      'closed: device disconnected (gone)'
    );
    expect(describeClose({ disconnected: false, requestedByHost: true })).toBe('closed by the gateway');
    expect(describeClose({ disconnected: false, requestedByHost: false })).toBe('closed without a disconnect error');
  });
});

describe('USB drop recovery', () => {
  class CountingTransport extends FakeSerialTransport {
    opens = 0;
    async open(): Promise<void> {
      this.opens++;
      await super.open();
    }
  }

  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
    vi.restoreAllMocks();
  });

  interface Script {
    clcc: string | Error | (() => Promise<string>);
    cpcmreg: string | Error;
    cpcmfrm: string | Error;
    cpcmbandwidth: string | Error;
    /** The answer to AT+CPCMREG=0. */
    deactivate: string | Error;
  }

  const CALL_CONTROL = ['AT+CHUP', 'ATH', 'ATA'];
  const expectNoCallControl = (commands: string[]) => {
    for (const command of commands) {
      expect(CALL_CONTROL.includes(command) || command.startsWith('ATD')).toBe(false);
    }
  };

  const createHarness = async (
    options: { activate?: boolean; stableMs?: number; script?: Partial<Script>; streamOn?: boolean } = {}
  ) => {
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const transport = new CountingTransport('COM-AUDIO-TEST', 115200);
    const audio = new Sim7600HardwareAudioAdapter({ audioPort: 'COM-AUDIO-TEST', transport });
    const eventBus = new GatewayEventBus();
    const manager = new CallSessionManager({
      modem,
      audio,
      eventBus,
      enableUsbAudioDiagnostic: true,
      usbRecoveryStableMs: options.stableMs ?? 0,
    });
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-recovery-'));
    cleanup.push(() => fs.rmSync(outputDir, { recursive: true, force: true }));
    const verifier = new UsbPcmVerifier({
      audio,
      callManager: manager,
      outputDir,
      captureEnabled: true,
      outboundToneEnabled: true,
    });

    const script: Script = {
      clcc: ACTIVE_CALL,
      cpcmreg: '+CPCMREG: 0\nOK',
      cpcmfrm: '+CPCMFRM: 0\nOK',
      cpcmbandwidth: '+CPCMBANDWIDTH: 0,1\nOK',
      deactivate: 'OK',
      ...options.script,
    };
    /** Whether the simulated module is currently putting PCM on COM26. */
    const stream = { on: options.streamOn ?? true };
    const commands: string[] = [];
    const original = modem.executeCommand.bind(modem);
    const answer = async (value: string | Error | (() => Promise<string>)): Promise<string> => {
      if (value instanceof Error) throw value;
      return typeof value === 'function' ? value() : value;
    };
    modem.executeCommand = async (command, timeoutMs) => {
      commands.push(command);
      if (command === 'AT+CLCC') return answer(script.clcc);
      if (command === 'AT+CPCMREG?') return answer(script.cpcmreg);
      if (command === 'AT+CPCMFRM?') return answer(script.cpcmfrm);
      if (command === 'AT+CPCMBANDWIDTH?') return answer(script.cpcmbandwidth);
      if (command === 'AT+CPCMREG=0') return answer(script.deactivate);
      return original(command, timeoutMs);
    };

    const ended: CallSession[] = [];
    eventBus.on('call:ended', (session) => ended.push(session));

    await modem.initialize();
    await manager.dial({ phoneNumber: '+919876543210' });
    modem.emit('urc', {
      raw: 'VOICE CALL: BEGIN',
      type: 'VOICE_CALL_BEGIN',
      timestamp: new Date().toISOString(),
      isSimulated: false,
    });
    const activation = options.activate === false ? null : await manager.activateUsbAudioDiagnostic();

    const feeder = setInterval(() => {
      if (stream.on) transport.feedIncomingData(Buffer.alloc(320, 1));
    }, 20);
    cleanup.push(() => clearInterval(feeder));

    const waitForReport = async (
      accept: (report: UsbAudioRecoveryReport) => boolean = () => true
    ): Promise<UsbAudioRecoveryReport> => {
      await vi.waitFor(
        () => {
          const report = manager.getUsbAudioStatus().lastRecovery;
          expect(report && accept(report)).toBeTruthy();
        },
        { timeout: 6000 }
      );
      return manager.getUsbAudioStatus().lastRecovery!;
    };
    /** USB reset: COM22 drops; COM26 closes with it unless `audioPortCloses` is false. */
    const usbDrop = (audioPortCloses = true) => {
      if (audioPortCloses) transport.simulateDisconnect();
      modem.emit('connection_state', 'ERROR');
    };
    const modemBack = () => modem.emit('connection_state', 'READY');

    return { modem, transport, audio, manager, verifier, commands, ended, activation, script, stream, waitForReport, usbDrop, modemBack };
  };

  it('does not trust the registration after a drop, then reissues it, reopens COM26 and sees PCM bytes', async () => {
    const h = await createHarness({ script: { cpcmreg: '+CPCMREG: 0\nOK' } });
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(true);
    expect(h.transport.opens).toBe(1);

    h.usbDrop();
    // Reconnecting nothing yet: the registration must not be believed.
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(false);
    expect(h.manager.getUsbAudioStatus().needsRecovery).toBe(true);
    expect(h.manager.getUsbAudioStatus().audio.state).toBe('unverified');
    expect(h.audio.getStats().isStreaming).toBe(false);

    h.commands.length = 0;
    h.modemBack();
    const report = await h.waitForReport();

    expect(report).toMatchObject({
      trigger: 'modem-reconnected',
      call: 'usable',
      registration: 'reissued',
      audioPort: 'reopened',
      audioFlowing: true,
    });
    expect(h.commands.filter((c) => c.startsWith('AT+CLCC') || c.startsWith('AT+CPCMREG'))).toEqual([
      'AT+CLCC',
      'AT+CPCMREG?',
      'AT+CPCMREG=1',
    ]);
    expectNoCallControl(h.commands);
    expect(h.transport.opens).toBe(2);
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(true);
    expect(h.manager.getCurrentCall()?.state).toBe('ACTIVE');
    expect(h.ended).toHaveLength(0);

    // Capture works again on the reopened handle, with no third open.
    const capture = h.verifier.captureInbound();
    await sleep(120);
    h.verifier.abort();
    const captured = await capture;
    expect(captured.bytes).toBeGreaterThan(0);
    expect(h.transport.opens).toBe(2);
    await h.manager.hangup();
  });

  it('leaves a registration that survived untouched when bytes do arrive', async () => {
    const h = await createHarness({ script: { cpcmreg: '+CPCMREG: 1\nOK' } });
    h.usbDrop();
    h.commands.length = 0;
    h.modemBack();
    const report = await h.waitForReport();

    expect(report).toMatchObject({ call: 'usable', registration: 'verified', audioPort: 'reopened', audioFlowing: true });
    expect(h.commands).not.toContain('AT+CPCMREG=1');
    expect(h.commands).not.toContain('AT+CPCMREG=0');
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(true);
    await h.manager.hangup();
  });

  it('does not accept CPCMREG? = 1 as proof of audio, and sends no stop/start toggle when no bytes arrive', async () => {
    // The module says it is registered, but nothing arrives on the reopened handle.
    const h = await createHarness({ script: { cpcmreg: '+CPCMREG: 1\nOK' } });
    h.usbDrop();
    h.stream.on = false;
    h.commands.length = 0;
    h.modemBack();
    const report = await h.waitForReport();

    // Only the read-only query: no AT+CPCMREG=0 (documented only after the call stops) and no AT+CPCMREG=1.
    expect(h.commands.filter((c) => c.startsWith('AT+CPCMREG'))).toEqual(['AT+CPCMREG?']);
    expect(report).toMatchObject({ call: 'usable', registration: 'verified', audioPort: 'reopened', audioFlowing: false });
    expect(report.notes.join(' ')).toMatch(/Registered but no PCM bytes received/);
    expect(report.notes.join(' ')).toMatch(/not recovered/);
    // No false success: unhealthy, flagged for recovery, PCM tests refused, call untouched.
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(false);
    expect(h.manager.getUsbAudioStatus()).toMatchObject({ needsRecovery: true, audio: { state: 'unverified' } });
    await expect(h.verifier.captureInbound()).rejects.toThrow(/must be activated first/);
    expectNoCallControl(h.commands);
    expect(h.manager.getCurrentCall()?.state).toBe('ACTIVE');
    await h.manager.hangup();
  });

  it('after a documented re-issue (registration was 0), still reports no recovery without fresh PCM bytes', async () => {
    const h = await createHarness({ script: { cpcmreg: '+CPCMREG: 0\nOK' } });
    h.usbDrop();
    h.stream.on = false;
    h.commands.length = 0;
    h.modemBack();
    const report = await h.waitForReport();

    expect(h.commands.filter((c) => c.startsWith('AT+CPCMREG'))).toEqual(['AT+CPCMREG?', 'AT+CPCMREG=1']);
    expect(report).toMatchObject({ registration: 'reissued', audioPort: 'reopened', audioFlowing: false });
    expect(report.notes.join(' ')).toMatch(/Registration was re-issued .* but no PCM bytes received/);
    expect(h.manager.getUsbAudioStatus()).toMatchObject({ needsRecovery: true, audio: { state: 'unverified' } });
    await h.manager.hangup();
  });

  it('never attempts a mid-call stop, however many recoveries run', async () => {
    const h = await createHarness({ script: { cpcmreg: '+CPCMREG: 1\nOK' } });
    h.stream.on = false;
    for (let i = 0; i < 2; i++) {
      const previous = h.manager.getUsbAudioStatus().lastRecovery?.finishedAt ?? '';
      h.usbDrop();
      h.modemBack();
      await h.waitForReport((r) => r.finishedAt !== previous);
    }
    expect(h.commands.filter((c) => c === 'AT+CPCMREG=0')).toEqual([]);
    expect(h.commands.filter((c) => c === 'AT+CPCMREG=1')).toHaveLength(1); // only the operator's own activation
    await h.manager.hangup();
  }, 20_000);

  describe('stopping USB audio (AT+CPCMREG=0)', () => {
    const rejected = new AtCommandError('AT+CPCMREG=0', 'ERROR', 'AT ERROR');

    it('an accepted stop ends the activation and leaves nothing uncertain', async () => {
      const h = await createHarness();
      await h.manager.deactivateUsbAudioDiagnostic();
      expect(h.manager.isUsbAudioDiagnosticActive()).toBe(false);
      expect(h.manager.getUsbAudioStatus()).toMatchObject({ registrationUncertain: false, lastDeactivation: { ok: true } });
      await h.manager.hangup();
    });

    it('a rejected stop during a call keeps the activation on record as unverified, never "not-expected"', async () => {
      const h = await createHarness({ script: { deactivate: rejected } });
      await expect(h.manager.deactivateUsbAudioDiagnostic()).rejects.toThrow(/AT ERROR/);
      const status = h.manager.getUsbAudioStatus();
      expect(status.audio.state).toBe('unverified');
      expect(status).toMatchObject({ needsRecovery: true, lastDeactivation: { ok: false, error: expect.stringContaining('AT ERROR') } });
      expect(h.manager.isUsbAudioDiagnosticActive()).toBe(false); // not healthy
      // The flag is still on record, so a later activation is the way to settle it, not a silent clear.
      await expect(h.manager.activateUsbAudioDiagnostic()).resolves.toMatchObject({ command: 'AT+CPCMREG=1' });
      expect(h.manager.getUsbAudioStatus()).toMatchObject({ needsRecovery: false, registrationUncertain: false });
      await h.manager.hangup();
    });

    it('a rejected stop at hang-up is carried to the next call as doubt, not as an active or cleared registration', async () => {
      const h = await createHarness({ script: { deactivate: rejected } });
      await h.manager.hangup('operator');
      expect(h.manager.getCurrentCall()).toBeNull();
      const after = h.manager.getUsbAudioStatus();
      expect(after).toMatchObject({ registrationActive: false, registrationUncertain: true, lastDeactivation: { ok: false } });
      expect(after.audio.state).toBe('not-expected'); // truthful: there is no call

      // Next call: does not inherit "active", and activation is allowed (it is not "already active").
      await h.manager.dial({ phoneNumber: '+919876543210' });
      h.modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
      expect(h.manager.getUsbAudioStatus()).toMatchObject({ registrationActive: false, registrationUncertain: true });
      expect(h.manager.getUsbAudioStatus().audio.state).toBe('not-expected');
      const before = h.commands.filter((c) => c === 'AT+CPCMREG=0').length;
      await h.manager.activateUsbAudioDiagnostic();
      expect(h.commands.filter((c) => c === 'AT+CPCMREG=0')).toHaveLength(before); // no stop/start toggle
      expect(h.manager.getUsbAudioStatus()).toMatchObject({ registrationActive: true, registrationUncertain: false });
      await vi.waitFor(() => expect(h.manager.getUsbAudioStatus().audio.state).toBe('flowing'));
      await h.manager.hangup();
    });

    it('a rejected stop after the remote hangs up (stop still in flight when the call ends) ends up the same way', async () => {
      const h = await createHarness({ script: { deactivate: rejected } });
      h.modem.emit('urc', { raw: 'VOICE CALL: END: 5', type: 'VOICE_CALL_END', durationSeconds: 5, timestamp: new Date().toISOString(), isSimulated: false });
      await vi.waitFor(() => expect(h.manager.getUsbAudioStatus().registrationUncertain).toBe(true));
      expect(h.manager.getCurrentCall()).toBeNull();
      expect(h.manager.isUsbAudioDiagnosticActive()).toBe(false);
      expect(h.manager.getUsbAudioStatus().lastDeactivation).toMatchObject({ ok: false });
    });

    it('an AT port that drops during the stop is treated the same: unknown, not stopped', async () => {
      const h = await createHarness({ script: { deactivate: new SerialPortDisconnectedError('COM-AT-TEST', 'port closed') } });
      await expect(h.manager.deactivateUsbAudioDiagnostic()).rejects.toThrow(/port closed/);
      expect(h.manager.getUsbAudioStatus().audio.state).toBe('unverified');
      await h.manager.hangup();
      expect(h.manager.getUsbAudioStatus().registrationUncertain).toBe(true);
    });
  });

  it('ends the stale gateway call when the module no longer lists a voice call', async () => {
    const h = await createHarness({ script: { clcc: 'OK' } });
    h.usbDrop();
    h.commands.length = 0;
    h.modemBack();
    const report = await h.waitForReport();

    expect(report.call).toBe('lost');
    expect(h.manager.getCurrentCall()).toBeNull();
    expect(h.ended).toHaveLength(1);
    expect(h.ended[0]).toMatchObject({ outcome: 'failed', terminationReason: 'Call lost during modem reconnect' });
    expect(h.commands).toContain('AT+CPCMREG=0');
    expect(h.commands).not.toContain('AT+CPCMREG=1');
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(false);
    expect(h.transport.isOpen()).toBe(false);
  });

  it('claims nothing, and never hangs up, when the call list cannot be read', async () => {
    const h = await createHarness({ script: { clcc: new Error('timeout') } });
    h.usbDrop();
    h.commands.length = 0;
    h.modemBack();
    const report = await h.waitForReport();

    expect(report).toMatchObject({ call: 'unknown', registration: 'not-applicable', audioPort: 'not-applicable' });
    expect(report.audioFlowing).toBeNull();
    expect(h.commands.some((c) => c.startsWith('AT+CPCMREG'))).toBe(false);
    expectNoCallControl(h.commands);
    expect(h.transport.opens).toBe(1);
    expect(h.manager.getCurrentCall()?.state).toBe('ACTIVE');
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(false);
    expect(h.manager.getUsbAudioStatus().needsRecovery).toBe(true);
    await h.manager.hangup();
  });

  it('reports a COM26 that will not reopen after exactly one attempt, and stays unhealthy', async () => {
    const h = await createHarness({ script: { cpcmreg: '+CPCMREG: 1\nOK' } });
    h.usbDrop();
    let attempts = 0;
    h.transport.open = async () => {
      attempts++;
      throw new Error('Access denied');
    };
    h.modemBack();
    const report = await h.waitForReport();

    expect(report).toMatchObject({ call: 'usable', registration: 'verified', audioPort: 'failed' });
    expect(report.audioFlowing).toBeNull();
    expect(report.notes.join(' ')).toMatch(/could not be reopened: Access denied/);
    expect(attempts).toBe(1);
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(false);
    await h.manager.hangup();
  });

  it('does not enable USB audio that the operator never activated', async () => {
    const h = await createHarness({ activate: false });
    h.usbDrop();
    h.commands.length = 0;
    h.modemBack();
    const report = await h.waitForReport();

    expect(report).toMatchObject({ call: 'usable', registration: 'not-applicable', audioPort: 'reopened' });
    expect(report.audioFlowing).toBeNull();
    expect(h.commands.some((c) => c.startsWith('AT+CPCMREG'))).toBe(false);
    await h.manager.hangup();
  });

  it('does not reopen a COM26 that never closed', async () => {
    const h = await createHarness({ script: { cpcmreg: '+CPCMREG: 1\nOK' } });
    h.usbDrop(false);
    h.modemBack();
    const report = await h.waitForReport();

    expect(report).toMatchObject({ audioPort: 'still-open', registration: 'verified', audioFlowing: true });
    expect(h.transport.opens).toBe(1);
    await h.manager.hangup();
  });

  it('does nothing when the modem reconnects with no call', async () => {
    const h = await createHarness({ activate: false });
    await h.manager.hangup();
    h.commands.length = 0;
    h.modemBack();
    await sleep(100);

    expect(h.commands).toEqual([]);
    expect(h.manager.getUsbAudioStatus().lastRecovery).toBeNull();
  });

  it('shares one in-flight recovery between concurrent requests', async () => {
    const h = await createHarness({ script: { cpcmreg: '+CPCMREG: 1\nOK' } });
    h.usbDrop();
    h.commands.length = 0;
    const [first, second] = await Promise.all([h.manager.recoverUsbAudio('manual'), h.manager.recoverUsbAudio('manual')]);
    expect(second).toBe(first);
    expect(h.commands.filter((c) => c === 'AT+CLCC')).toHaveLength(1);
    await h.manager.hangup();
  });

  it('waits for the modem to stay READY and restarts the wait on every flap', async () => {
    const h = await createHarness({ stableMs: 300, script: { cpcmreg: '+CPCMREG: 1\nOK' } });
    h.usbDrop();
    h.commands.length = 0;

    h.modemBack();
    await sleep(150);
    h.modem.emit('connection_state', 'INITIALIZING'); // flaps before the quiet period ends
    await sleep(50);
    h.modemBack();
    await sleep(200);
    expect(h.commands).toEqual([]); // 200 ms after the last READY: still waiting

    const report = await h.waitForReport();
    expect(report.call).toBe('usable');
    expect(h.commands.filter((c) => c === 'AT+CLCC')).toHaveLength(1);
    await h.manager.hangup();
  });

  it('voids a recovery that the modem outlives, then verifies again once it settles', async () => {
    let slow = true;
    const h = await createHarness({
      script: {
        cpcmreg: '+CPCMREG: 1\nOK',
        clcc: async () => {
          if (slow) await sleep(150);
          return ACTIVE_CALL;
        },
      },
    });
    h.usbDrop();
    h.commands.length = 0;
    h.modemBack();
    await sleep(40);
    h.usbDrop(false); // dropped again while the first recovery is still asking for the call list
    slow = false;
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(false);

    await vi.waitFor(() => expect(h.manager.getUsbAudioStatus().lastRecovery?.notes.join(' ')).toMatch(/dropped again/), {
      timeout: 4000,
    });
    // The voided run must not have declared anything healthy.
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(false);
    expect(h.commands.filter((c) => c.startsWith('AT+CPCMREG'))).toEqual([]);

    h.modemBack();
    const report = await h.waitForReport((r) => r.notes.length === 0);
    expect(report).toMatchObject({ call: 'usable', registration: 'verified', audioFlowing: true });
    expect(h.commands.filter((c) => c === 'AT+CLCC')).toHaveLength(2);
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(true);
    await h.manager.hangup();
  });

  it('keeps the operator\'s activation when a drop interrupts the registration check', async () => {
    const h = await createHarness({
      script: { cpcmreg: new SerialPortDisconnectedError('COM22', 'closed: device disconnected') },
    });
    h.usbDrop();
    h.modemBack();
    const first = await h.waitForReport();

    expect(first.registration).toBe('unknown'); // an AT port drop is not an answer from the module
    expect(first.audioFlowing).toBeNull();
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(false);
    expect(h.manager.getUsbAudioStatus().needsRecovery).toBe(true);

    h.script.cpcmreg = '+CPCMREG: 1\nOK';
    const second = await h.manager.recoverUsbAudio('manual');
    expect(second).toMatchObject({ registration: 'verified', audioFlowing: true });
    expect(h.manager.isUsbAudioDiagnosticActive()).toBe(true);
    await h.manager.hangup();
  });

  it('reports stream health from the wire, not from a flag', async () => {
    const h = await createHarness({ script: { cpcmreg: '+CPCMREG: 1\nOK' } });
    await vi.waitFor(() => expect(h.manager.getUsbAudioStatus().audio.state).toBe('flowing'));

    h.stream.on = false; // module goes quiet while isStreaming stays true
    expect(h.audio.getStats().isStreaming).toBe(true);
    await vi.waitFor(() => expect(h.manager.getUsbAudioStatus().audio.state).toBe('stalled'), { timeout: 3000 });
    expect(h.manager.getUsbAudioStatus().audio.msSinceLastFrame).toBeGreaterThan(500);

    await h.manager.hangup();
    expect(h.manager.getUsbAudioStatus().audio.state).toBe('not-expected');
  });

  it('records what the module says about its own PCM format at activation', async () => {
    const h = await createHarness();
    expect(h.activation?.moduleAudioFormat).toEqual({ cpcmfrm: 0, cpcmbandwidth: { volte: 0, novolte: 1 } });
    await h.manager.hangup();

    const failing = await createHarness({
      script: { cpcmfrm: new Error('ERROR'), cpcmbandwidth: new Error('ERROR') },
    });
    expect(failing.activation?.moduleAudioFormat).toEqual({ cpcmfrm: null, cpcmbandwidth: null });
    await failing.manager.hangup();
  });

  it('exposes recover and status through the diagnostic endpoint only when enabled', async () => {
    const report: UsbAudioRecoveryReport = {
      trigger: 'manual',
      startedAt: 'a',
      finishedAt: 'b',
      callId: null,
      call: 'none',
      registration: 'not-applicable',
      audioPort: 'not-applicable',
      audioFlowing: null,
      notes: [],
    };
    const callManager = {
      recoverUsbAudio: vi.fn(async () => report),
      getUsbAudioStatus: vi.fn(() => ({
        registrationActive: false,
        needsRecovery: true,
        lastRecovery: null,
        audio: { state: 'unverified', msSinceLastFrame: null },
      })),
    };
    const build = (enabled: boolean) =>
      express()
        .use(express.json())
        .use(
          '/api/gateway',
          createGatewayRouter({
            modem: new MockModemAdapter(),
            callManager: callManager as never,
            config: { enableUsbAudioDiagnostic: enabled } as never,
          })
        );

    const on = build(true);
    const recovered = await request(on).post('/api/gateway/audio/usb-diagnostic').send({ action: 'recover' });
    expect(recovered.body).toEqual(report);
    expect(callManager.recoverUsbAudio).toHaveBeenCalledWith('manual');
    const status = await request(on).post('/api/gateway/audio/usb-diagnostic').send({ action: 'status' });
    expect(status.body).toMatchObject({ needsRecovery: true, audio: { state: 'unverified' } });

    const off = await request(build(false)).post('/api/gateway/audio/usb-diagnostic').send({ action: 'recover' });
    expect(off.status).toBe(404);
  });
});
