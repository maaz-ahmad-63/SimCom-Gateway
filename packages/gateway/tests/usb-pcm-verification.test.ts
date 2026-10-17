import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { Sim7600HardwareAudioAdapter } from '../src/adapters/audio/hardware-audio.js';
import { FakeSerialTransport } from '../src/adapters/modem/serial-transport.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { CallSessionManager } from '../src/core/call-session-manager.js';
import {
  analyzePcm,
  buildWav,
  buildWavHeader,
  generateTone,
  sweepCandidateFormats,
  VerifiedPcmFormat,
} from '../src/diagnostics/pcm-tools.js';
import {
  CAPTURE_MAX_BYTES,
  TONE_MAX_BYTES,
  UsbPcmTestError,
  UsbPcmVerifier,
} from '../src/diagnostics/usb-pcm-verification.js';

const LE8K = { sampleRate: 8000, channels: 1, bitDepth: 16 as const, endianness: 'little-endian' as const };

describe('pcm-tools', () => {
  it('detects a known tone only under the correct byte order', () => {
    const tone = generateTone(LE8K, 1000, 500, 0.5);
    const right = analyzePcm(tone, LE8K);
    expect(right.dominantHz).toBe(1000);
    expect(right.durationMs).toBe(500);

    const swapped = analyzePcm(tone, { ...LE8K, endianness: 'big-endian' });
    expect(right.toneConcentration).toBeGreaterThan(0.9);
    expect(swapped.toneConcentration).toBeLessThan(right.toneConcentration * 0.75);
    expect(sweepCandidateFormats(tone)[0].format).toEqual(LE8K);
  });

  it('keeps generated tones low-volume', () => {
    const tone = generateTone(LE8K, 1000, 100, 0.05);
    expect(analyzePcm(tone, LE8K).peak).toBeLessThanOrEqual(0.0501);
  });

  it('writes a correct WAV header and byte-swaps big-endian data', () => {
    const format: VerifiedPcmFormat = { ...LE8K, verified: true };
    const header = buildWavHeader(format, 16000);
    expect(header.toString('ascii', 0, 4)).toBe('RIFF');
    expect(header.readUInt32LE(4)).toBe(36 + 16000);
    expect(header.readUInt16LE(20)).toBe(1);
    expect(header.readUInt16LE(22)).toBe(1);
    expect(header.readUInt32LE(24)).toBe(8000);
    expect(header.readUInt32LE(28)).toBe(16000);
    expect(header.readUInt16LE(32)).toBe(2);
    expect(header.readUInt16LE(34)).toBe(16);
    expect(header.readUInt32LE(40)).toBe(16000);

    const wav = buildWav(Buffer.from([0x12, 0x34]), { ...format, endianness: 'big-endian' });
    expect(wav.subarray(44)).toEqual(Buffer.from([0x34, 0x12]));
  });

  it('refuses a WAV header for an unverified format', () => {
    expect(() => buildWavHeader({ ...LE8K, verified: false } as unknown as VerifiedPcmFormat, 0)).toThrow(
      /unverified/
    );
  });
});

describe('UsbPcmVerifier', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const createHarness = async (
    flags: { capture?: boolean; tone?: boolean } = {},
    options: { activateDiagnostic?: boolean; answerCall?: boolean } = {}
  ) => {
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const audio = new MockAudioAdapter();
    const callManager = new CallSessionManager({ modem, audio, enableUsbAudioDiagnostic: true });
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-pcm-'));
    dirs.push(outputDir);
    const verifier = new UsbPcmVerifier({
      audio,
      callManager,
      outputDir,
      captureEnabled: flags.capture ?? true,
      outboundToneEnabled: flags.tone ?? true,
    });
    await modem.initialize();
    if (options.answerCall !== false) {
      await callManager.dial({ phoneNumber: '+919876543210' });
      modem.emit('urc', {
        raw: 'VOICE CALL: BEGIN',
        type: 'VOICE_CALL_BEGIN',
        timestamp: new Date().toISOString(),
        isSimulated: true,
      });
      if (options.activateDiagnostic !== false) await callManager.activateUsbAudioDiagnostic();
    }
    return { modem, audio, callManager, verifier, outputDir };
  };

  const tone = { assumedFormat: { sampleRate: 8000, endianness: 'little-endian' as const }, durationMs: 100 };

  it('is disabled by default', async () => {
    const { verifier, callManager } = await createHarness({ capture: false, tone: false });
    await expect(verifier.captureInbound()).rejects.toMatchObject({ status: 404 });
    await expect(verifier.playOutboundTone(tone)).rejects.toMatchObject({ status: 404 });
    await callManager.hangup();
  });

  it('requires an ACTIVE call with the USB audio diagnostic activated', async () => {
    const idle = await createHarness({}, { answerCall: false });
    await expect(idle.verifier.captureInbound()).rejects.toThrow(/ACTIVE call/);
    await expect(idle.verifier.playOutboundTone(tone)).rejects.toThrow(/ACTIVE call/);

    const inactive = await createHarness({}, { activateDiagnostic: false });
    await expect(inactive.verifier.captureInbound()).rejects.toThrow(/CPCMREG=1/);
    await expect(inactive.verifier.playOutboundTone(tone)).rejects.toThrow(/CPCMREG=1/);
    await inactive.callManager.hangup();
  });

  it('captures at most 5 seconds to a binary file without a WAV header or logged audio', async () => {
    const { verifier, callManager, outputDir } = await createHarness();
    const logged: string[] = [];
    for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.join(' '));
      });
    }

    const result = await verifier.captureInbound();

    expect(result.stopReason).toBe('duration');
    expect(result.durationMs).toBeGreaterThanOrEqual(4900);
    expect(result.durationMs).toBeLessThan(6000);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.bytes).toBeLessThanOrEqual(CAPTURE_MAX_BYTES);
    expect(result.formatVerified).toBe(false);

    const file = fs.readFileSync(result.filePath);
    expect(file.length).toBe(result.bytes);
    expect(file.subarray(0, 4).toString('ascii')).not.toBe('RIFF');
    const metadata = JSON.parse(fs.readFileSync(result.metadataPath, 'utf8'));
    expect(metadata).toMatchObject({ formatVerified: false, bytes: result.bytes });
    expect(JSON.stringify(metadata)).not.toContain(file.subarray(0, 32).toString('hex'));
    expect(logged.join('\n')).not.toContain(file.subarray(0, 32).toString('hex'));
    await callManager.hangup();
  }, 15_000);

  it('stops capturing when the call ends', async () => {
    const { verifier, callManager } = await createHarness();
    const pending = verifier.captureInbound();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await callManager.hangup();
    const result = await pending;

    expect(result.stopReason).toBe('call-ended');
    expect(result.durationMs).toBeLessThan(2000);
  });

  it('rejects out-of-range tone requests before touching the audio port', async () => {
    const { verifier, audio, callManager } = await createHarness();
    const write = vi.spyOn(audio, 'writeAudioChunk');

    await expect(verifier.playOutboundTone({} as never)).rejects.toMatchObject({ status: 400 });
    await expect(verifier.playOutboundTone({ ...tone, amplitude: 0.5 })).rejects.toMatchObject({ status: 400 });
    await expect(verifier.playOutboundTone({ ...tone, durationMs: 5000 })).rejects.toMatchObject({ status: 400 });
    await expect(verifier.playOutboundTone({ ...tone, frequencyHz: 10 })).rejects.toBeInstanceOf(UsbPcmTestError);
    await expect(
      verifier.playOutboundTone({ ...tone, assumedFormat: { sampleRate: 48000, endianness: 'little-endian' }, durationMs: 1000 })
    ).rejects.toThrow(/byte limit/);
    expect(write).not.toHaveBeenCalled();
    await callManager.hangup();
  });

  it('writes a bounded, low-volume tone through the existing audio adapter only', async () => {
    const { verifier, audio, callManager } = await createHarness();
    const written: Buffer[] = [];
    const original = audio.writeAudioChunk.bind(audio);
    vi.spyOn(audio, 'writeAudioChunk').mockImplementation(async (chunk) => {
      written.push(Buffer.from(chunk));
      return original(chunk);
    });

    const result = await verifier.playOutboundTone({ ...tone, durationMs: 200, amplitude: 0.1 });

    expect(result.stopReason).toBe('completed');
    expect(result.audibleTransmissionVerified).toBe(false);
    expect(result.bytesWritten).toBe(3200);
    expect(result.bytesWritten).toBeLessThanOrEqual(TONE_MAX_BYTES);
    const all = Buffer.concat(written);
    expect(all.length).toBe(result.bytesWritten);
    expect(analyzePcm(all, LE8K).peak).toBeLessThanOrEqual(0.1001);
    expect(analyzePcm(all, LE8K).dominantHz).toBe(1000);
    expect(audio.getStats().bytesSent).toBe(result.bytesWritten);
    await callManager.hangup();
  });

  it('stops the tone immediately on hangup', async () => {
    const { verifier, callManager } = await createHarness();
    const pending = verifier.playOutboundTone({ ...tone, durationMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await callManager.hangup();
    const result = await pending;

    expect(result.stopReason).toBe('call-ended');
    expect(result.bytesWritten).toBeLessThan(16_000);
  });

  it('stops the tone when the audio write fails', async () => {
    const { verifier, audio, callManager } = await createHarness();
    vi.spyOn(audio, 'writeAudioChunk').mockRejectedValue(new Error('serial glitch'));

    const result = await verifier.playOutboundTone(tone);

    expect(result.stopReason).toBe('audio-error');
    expect(result.bytesWritten).toBe(0);
    await callManager.hangup();
  });

  describe('with the real hardware audio adapter over a fake serial port', () => {
    class CountingTransport extends FakeSerialTransport {
      opens = 0;
      async open(): Promise<void> {
        this.opens++;
        await super.open();
      }
    }

    const createHardwareHarness = async () => {
      const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
      const transport = new CountingTransport('COM-AUDIO-TEST', 115200);
      const audio = new Sim7600HardwareAudioAdapter({ audioPort: 'COM-AUDIO-TEST', transport });
      const callManager = new CallSessionManager({ modem, audio, enableUsbAudioDiagnostic: true });
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-pcm-hw-'));
      dirs.push(outputDir);
      const verifier = new UsbPcmVerifier({
        audio,
        callManager,
        outputDir,
        captureEnabled: true,
        outboundToneEnabled: true,
      });
      await modem.initialize();
      await callManager.dial({ phoneNumber: '+919876543210' });
      modem.emit('urc', {
        raw: 'VOICE CALL: BEGIN',
        type: 'VOICE_CALL_BEGIN',
        timestamp: new Date().toISOString(),
        isSimulated: false,
      });
      await callManager.activateUsbAudioDiagnostic();
      return { transport, audio, callManager, verifier };
    };

    it('captures and plays a tone over the single already-open handle', async () => {
      const { transport, callManager, verifier } = await createHardwareHarness();
      expect(transport.opens).toBe(1);

      const capture = verifier.captureInbound();
      await new Promise((resolve) => setTimeout(resolve, 50));
      transport.feedIncomingData(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
      transport.feedIncomingData(Buffer.from([9, 10]));
      await new Promise((resolve) => setTimeout(resolve, 20));
      verifier.abort();
      const captured = await capture;
      expect(captured.stopReason).toBe('aborted');
      expect(fs.readFileSync(captured.filePath)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

      const toneResult = await verifier.playOutboundTone({ ...tone, durationMs: 100 });
      expect(toneResult.stopReason).toBe('completed');
      expect(toneResult.bytesWritten).toBe(1600);
      expect(transport.getWrittenHistory()).toHaveLength(toneResult.chunksWritten);

      expect(transport.opens).toBe(1);
      await callManager.hangup();
    });

    it('stops the tone on hangup and writes nothing to the closed port afterwards', async () => {
      const { transport, audio, callManager, verifier } = await createHardwareHarness();

      const pending = verifier.playOutboundTone({ ...tone, durationMs: 1000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await callManager.hangup();
      const result = await pending;
      const writesAtStop = transport.getWrittenHistory().length;
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(result.stopReason).toBe('call-ended');
      expect(result.bytesWritten).toBeLessThan(16_000);
      expect(result.bytesWritten).toBe(audio.getStats().bytesSent);
      expect(transport.getWrittenHistory()).toHaveLength(writesAtStop);
      expect(transport.getWrittenHistory()).toHaveLength(result.chunksWritten);
      expect(transport.isOpen()).toBe(false);
      expect(transport.opens).toBe(1);
    });

    it('reports a port that closed mid-call instead of failing silently', async () => {
      const { transport, audio, callManager, verifier } = await createHardwareHarness();
      const errors: Error[] = [];
      audio.on('error', (error) => errors.push(error));
      expect(audio.getStats().isStreaming).toBe(true);

      transport.simulateDisconnect();

      expect(audio.getStats().isStreaming).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/closed: device disconnected.*while the session was streaming/);
      await expect(verifier.captureInbound()).rejects.toThrow(/not streaming/);
      await expect(verifier.playOutboundTone(tone)).rejects.toThrow(/not streaming/);
      await callManager.hangup();
    });

    it('does not treat a normal hangup as a port failure', async () => {
      const { audio, callManager } = await createHardwareHarness();
      const errors: Error[] = [];
      audio.on('error', (error) => errors.push(error));

      await callManager.hangup();

      expect(errors).toHaveLength(0);
      expect(audio.getStats().isStreaming).toBe(false);
    });

    it('is not streaming when the audio port cannot be opened', async () => {
      const transport = new FakeSerialTransport('COM-AUDIO-TEST', 115200);
      transport.open = async () => {
        throw new Error('Access denied');
      };
      const audio = new Sim7600HardwareAudioAdapter({ audioPort: 'COM-AUDIO-TEST', transport });
      const errors: Error[] = [];
      audio.on('error', (error) => errors.push(error));

      await audio.startSession('call-open-fail');

      expect(audio.getStats().isStreaming).toBe(false);
      expect(errors[0]?.message).toMatch(/Could not open audio port/);
    });

    it('fails a capture window that delivered zero bytes instead of reporting success', async () => {
      const { transport, callManager, verifier } = await createHardwareHarness();
      vi.useFakeTimers();
      try {
        const pending = verifier.captureInbound();
        await vi.advanceTimersByTimeAsync(5100);
        const result = await pending;

        expect(result.bytes).toBe(0);
        expect(result.stopReason).toBe('no-data');
        expect(JSON.parse(fs.readFileSync(result.metadataPath, 'utf8')).stopReason).toBe('no-data');
      } finally {
        vi.useRealTimers();
      }
      expect(transport.opens).toBe(1);
      await callManager.hangup();
    });

    it('does not report a tone as completed when the adapter wrote nothing', async () => {
      const { audio, callManager, verifier } = await createHardwareHarness();
      vi.spyOn(audio, 'writeAudioChunk').mockResolvedValue(undefined);

      const result = await verifier.playOutboundTone(tone);

      expect(result.bytesWritten).toBe(0);
      expect(result.stopReason).toBe('not-written');
      await callManager.hangup();
    });

    it('does not count a failed serial write as written', async () => {
      const { transport, audio, callManager, verifier } = await createHardwareHarness();
      vi.spyOn(transport, 'write').mockRejectedValue(new Error('serial glitch'));
      audio.on('error', () => {});

      const result = await verifier.playOutboundTone(tone);

      expect(result.stopReason).toBe('audio-error');
      expect(result.bytesWritten).toBe(0);
      expect(audio.getStats().droppedFrames).toBe(1);
      await callManager.hangup();
    });
  });

  it('allows only one test at a time', async () => {
    const { verifier, callManager } = await createHarness();
    const first = verifier.playOutboundTone({ ...tone, durationMs: 200 });
    await expect(verifier.captureInbound()).rejects.toThrow(/already running/);
    await first;
    await callManager.hangup();
  });
});
