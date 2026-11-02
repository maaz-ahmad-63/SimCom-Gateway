import { IAudioAdapter, ICallSessionManager, IModemAdapter } from '@sim-gateway/shared';
import { AiConfigResult, readProviderKey } from './config.js';

export type CheckStatus = 'pass' | 'fail' | 'unverified';

/** The module's documented PCM rates over USB audio: AT+CPCMFRM 0 = 8 kHz, 1 = 16 kHz. */
export const CPCMFRM_RATE: Record<number, number> = { 0: 8000, 1: 16000 };

export interface ReadinessCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Required for passive transcription too (the rest only gate an agent that replies). */
  passive: boolean;
}

export interface AiReadiness {
  /** True only when every check passed. 'unverified' blocks exactly like 'fail'. Gates an agent that replies. */
  ok: boolean;
  /** Every check marked `passive` passed: caller audio may be transcribed, nothing is sent to the caller. */
  passiveOk: boolean;
  checkedAt: string;
  checks: ReadinessCheck[];
  blockers: string[];
  passiveBlockers: string[];
  /** The modem or audio adapter is a mock. Simulated hardware can never make the agent ready. */
  simulatedHardware: boolean;
}

export interface ReadinessInput {
  configResult: AiConfigResult;
  modem: IModemAdapter;
  manager: ICallSessionManager;
  audio?: IAudioAdapter;
  env?: Record<string, string | undefined>;
  /** Test seam only: let a mock modem/audio adapter pass. Never set in production wiring. */
  allowSimulatedHardware?: boolean;
}

/**
 * Can a live AI agent safely take this call? Reads state only: no network, no provider request, no AT
 * command, no audio. Every claim that this transport works must come from an operator-set flag backed
 * by evidence AND from what the wire shows now; a flag alone or bytes alone never pass.
 *
 * Two levels: `passiveOk` (transcribe caller audio only) and `ok` (an agent that speaks to the caller).
 * Only `ok` needs the audio attestations; neither level can pass on simulated hardware.
 */
export function checkAiReadiness(input: ReadinessInput): AiReadiness {
  const { configResult, modem, manager, audio } = input;
  const env = input.env ?? process.env;
  const { config } = configResult;
  const checks: ReadinessCheck[] = [];
  const add = (name: string, status: CheckStatus, detail: string, passive = false) =>
    checks.push({ name, status, detail, passive });
  const simulatedHardware = modem.isSimulated === true || audio?.isSimulated === true;

  // 1. Configuration (the selection itself; credentials are separate checks)
  if (!config.enabled) {
    add('ai-config', 'fail', 'AI is not enabled', true);
  } else if (configResult.selectionErrors.length > 0) {
    add('ai-config', 'fail', configResult.selectionErrors.join('; '), true);
  } else {
    add('ai-config', 'pass', `stt=${config.stt.key} llm=${config.llm.key} tts=${config.tts.key}`, true);
  }

  // 2. Provider credentials (names only, never values)
  const sttKeyMissing = configResult.sttKeyEnv !== null && !readProviderKey(env, configResult.sttKeyEnv);
  add(
    'stt-key',
    configResult.sttKeyEnv !== null && !sttKeyMissing ? 'pass' : 'fail',
    configResult.sttKeyEnv === null
      ? 'the selected STT provider has no key mapping'
      : sttKeyMissing
        ? `missing: ${configResult.sttKeyEnv}`
        : `${configResult.sttKeyEnv} set`,
    true
  );
  const missing = config.requiredKeyEnv.filter((name) => !readProviderKey(env, name));
  add(
    'provider-keys',
    missing.length === 0 ? 'pass' : 'fail',
    missing.length === 0 ? `${config.requiredKeyEnv.join(', ')} set` : `missing: ${missing.join(', ')}`
  );

  // 3. Hardware must be real: a mock modem or audio adapter proves nothing about the SIM7600EI path
  if (simulatedHardware && !input.allowSimulatedHardware) {
    add(
      'hardware',
      'fail',
      'the modem or audio adapter is simulated (mock driver); readiness can only be established on real hardware',
      true
    );
  } else {
    add('hardware', 'pass', simulatedHardware ? 'simulated hardware allowed by a test seam' : 'real hardware adapters', true);
  }

  // 4. Modem
  const modemState = modem.getConnectionState();
  add('modem', modemState === 'READY' ? 'pass' : 'fail', `connection state ${modemState}`, true);

  // 5. Call state
  const call = manager.getCurrentCall();
  add(
    'call',
    call?.state === 'ACTIVE' ? 'pass' : 'unverified',
    call ? `current call is ${call.state}` : 'no active call; audio can only be confirmed during one',
    true
  );

  // 6. Audio format
  if (!config.audio.format) {
    add('audio-format', 'fail', 'the gateway audio sample rate is not set (TTS tab, or AI_AUDIO_SAMPLE_RATE in .env); the rate is never assumed', true);
  } else {
    const f = config.audio.format;
    add(
      'audio-format',
      'pass',
      `${f.sampleRate} Hz, ${f.bitDepth}-bit, mono, little-endian (as configured, not as proven)`,
      true
    );
  }

  // 7. Wire state: bytes are arriving now (passive transcription needs this; it proves nothing about speech)
  const usb = manager.getUsbAudioStatus?.();
  if (!audio) {
    add('inbound-wire', 'fail', 'no audio adapter', true);
  } else if (call?.state !== 'ACTIVE') {
    add('inbound-wire', 'unverified', 'the stream can only be checked during an active call', true);
  } else if (usb?.audio.state !== 'flowing') {
    const wireState = usb?.audio.state ?? 'unknown';
    add(
      'inbound-wire',
      'fail',
      wireState === 'not-expected'
        ? usb?.registrationUncertain
          ? "USB audio has not been activated for this call, and the module may still hold a registration from the previous call (its stop command, AT+CPCMREG=0, was rejected). Activate it with the documented step; this check passes only once bytes are flowing"
          : "USB audio has not been activated for this call (the gateway has not registered it with the module), so no audio bytes arrive. Activate it with the documented step; this check passes only once bytes are flowing"
        : wireState === 'unverified' && usb?.lastDeactivation && !usb.lastDeactivation.ok
          ? "the USB audio registration could not be stopped (AT+CPCMREG=0 was rejected), so the module's audio state is unknown and no stream is trusted"
          : `the USB audio stream is '${wireState}', not flowing`,
      true
    );
  } else {
    add('inbound-wire', 'pass', 'PCM bytes are flowing now (flowing is not speech)', true);
  }

  // 7b. The module's own rate. The gateway writes frames at the configured rate and the module plays them at its own, so
  // a disagreement (16 kHz audio into a module still at 8 kHz) plays at the wrong speed and breaks up, and caller audio
  // would be labelled with the wrong rate for speech recognition. Compared only once the module has said which it uses.
  if (config.audio.format) {
    const cpcmfrm = usb?.moduleAudioFormat?.cpcmfrm;
    const moduleRate = cpcmfrm === null || cpcmfrm === undefined ? null : (CPCMFRM_RATE[cpcmfrm] ?? null);
    if (moduleRate !== null && cpcmfrm !== null && cpcmfrm !== undefined) {
      const configured = config.audio.format.sampleRate;
      if (moduleRate === configured) {
        add('audio-rate', 'pass', `the module and the gateway both use ${configured} Hz`, true);
      } else {
        add(
          'audio-rate',
          'fail',
          `the module reports ${moduleRate} Hz (AT+CPCMFRM=${cpcmfrm}) but the gateway is set to ${configured} Hz; speech would play at the wrong speed and break up. Set the gateway sample rate to ${moduleRate} Hz (TTS tab), or put the module on ${configured} Hz, before the call`,
          true
        );
      }
    }
  }

  // 8. Incoming audio: evidence flag AND live wire state
  if (!audio) {
    add('inbound-audio', 'fail', 'no audio adapter');
  } else if (!config.audio.inboundVerified) {
    add(
      'inbound-audio',
      'unverified',
      'intelligible caller speech over the USB audio port has not been confirmed; confirm it from the dashboard only after a real call produced a correct live transcript'
    );
  } else if (call?.state === 'ACTIVE' && usb?.audio.state !== 'flowing') {
    add('inbound-audio', 'fail', `verified flag is set but the wire shows '${usb?.audio.state ?? 'unknown'}'`);
  } else if (call?.state !== 'ACTIVE') {
    add('inbound-audio', 'unverified', 'verified flag is set; the stream can only be checked during an active call');
  } else {
    add('inbound-audio', 'pass', 'verified flag set and PCM bytes are flowing now (flowing is not speech)');
  }

  // 9. Playback
  if (!audio) {
    add('outbound-audio', 'fail', 'no audio adapter');
  } else if (!config.audio.outboundVerified) {
    add(
      'outbound-audio',
      'unverified',
      'audibility of written PCM on the call has not been confirmed; confirm it from the dashboard only after a remote party heard blind test tones'
    );
  } else if (call?.state === 'ACTIVE' && !audio.getStats().isStreaming) {
    add('outbound-audio', 'fail', 'verified flag is set but the audio port is not streaming');
  } else {
    add('outbound-audio', 'pass', 'verified flag set and the audio port accepts writes');
  }

  const describe = (c: ReadinessCheck) => `${c.name}: ${c.detail}`;
  const blockers = checks.filter((c) => c.status !== 'pass').map(describe);
  const passiveBlockers = checks.filter((c) => c.passive && c.status !== 'pass').map(describe);
  return {
    ok: blockers.length === 0,
    passiveOk: passiveBlockers.length === 0,
    checkedAt: new Date().toISOString(),
    checks,
    blockers,
    passiveBlockers,
    simulatedHardware,
  };
}
