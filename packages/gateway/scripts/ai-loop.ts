/**
 * Stage A: run the AI loop (caller audio -> STT -> LLM -> TTS -> audio file) with NO phone call, no
 * modem and no gateway server.
 *
 *   npm run ai:loop -- --mock
 *       Offline. Scripted providers, a generated stand-in for caller audio, no keys, no network.
 *
 *   npm run ai:loop -- --live --input caller.wav            (or caller.pcm --rate 8000)
 *       REAL provider requests (they cost money) with the providers chosen by the AI_* variables.
 *
 *   npm run ai:loop -- --live --text "What are your opening hours?"
 *       Skips STT (no STT cost): the text is the caller's turn; LLM and TTS are real.
 *
 *   Options: --rate N   PCM sample rate for .pcm input and for the reply audio
 *            --out reply.wav   write the reply audio (default: ai-loop-reply.wav)
 *
 * Real requests are made only with --live. Nothing here touches COM ports or a call. Prints the
 * transcript and reply because you asked for this run; the gateway itself never logs them by default.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CollectingAudioSink, toWav, unwrapWav } from '../src/ai/audio.js';
import { loadAiConfig } from '../src/ai/config.js';
import { ConversationSession } from '../src/ai/conversation.js';
import { createProviders } from '../src/ai/providers/index.js';
import { createMockProviders, ScriptedStt } from '../src/ai/providers/mock.js';
import { generateTone } from '../src/diagnostics/pcm-tools.js';

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const args = process.argv.slice(2);
const live = args.includes('--live');
const mock = args.includes('--mock');
if (live === mock) fail('Pass exactly one of --mock (offline) or --live (real, billable provider requests).');

const env = { ...process.env, AI_ENABLED: 'true', AI_LOG_TRANSCRIPTS: 'true' } as Record<string, string | undefined>;
const rateArg = flag(args, '--rate');
if (rateArg) env.AI_AUDIO_SAMPLE_RATE = rateArg;
env.AI_AUDIO_SAMPLE_RATE ??= '8000'; // offline default only; a live phone call never defaults the rate
const result = mock ? loadAiConfig({ ...env, AI_STT: 'nova-3', AI_TTS: 'cartesia', DEEPGRAM_API_KEY: 'x', CARTESIA_API_KEY: 'x', GROQ_API_KEY: 'x' }) : loadAiConfig(env);
if (result.errors.length > 0) fail(`Configuration problems:\n - ${result.errors.join('\n - ')}`);
const config = result.config;
const format = config.audio.format!;

// --- caller audio ------------------------------------------------------------
const textArg = flag(args, '--text');
const inputArg = flag(args, '--input');
let callerPcm: Buffer;
let sttOverride: ScriptedStt | null = null;
if (textArg) {
  // A steady placeholder so the pre-STT gate has something to look at; STT is replaced by the text.
  callerPcm = generateTone(format, 180, 900, 0.2);
  sttOverride = new ScriptedStt([textArg]);
} else if (inputArg) {
  const raw = fs.readFileSync(inputArg);
  if (inputArg.toLowerCase().endsWith('.wav')) {
    const rate = raw.readUInt32LE(24);
    callerPcm = unwrapWav(raw, { sampleRate: rate, channels: 1, bitDepth: 16, endianness: 'little-endian' });
    if (rate !== format.sampleRate) fail(`WAV is ${rate} Hz but the loop is configured for ${format.sampleRate} Hz; pass --rate ${rate}`);
  } else {
    callerPcm = raw;
  }
} else if (mock) {
  callerPcm = generateTone(format, 180, 900, 0.2);
} else {
  fail('Give --input <file.wav|file.pcm> or --text "<what the caller says>".');
}

// --- providers ---------------------------------------------------------------
const providers = mock
  ? createMockProviders({ stt: ['Hi, what are your opening hours?'], llm: ['We are open from nine to five, Monday to Friday. Is there anything else I can help you with?'] })
  : createProviders(config, { env });
const stt = sttOverride ?? providers.stt;

const sink = new CollectingAudioSink(format);
const session = new ConversationSession({
  callId: 'ai-loop',
  config,
  providers: { ...providers, stt },
  sink,
  emit: (event) => {
    if (event.type === 'error') console.error(`  ! ${event.stage} error: ${event.message}`);
  },
});

console.log(`Mode: ${mock ? 'MOCK (offline)' : 'LIVE (real provider requests)'}   format: ${format.sampleRate} Hz 16-bit mono LE`);
if (!mock) console.log(`Providers: stt=${sttOverride ? '(text given)' : config.stt.key} llm=${config.llm.key} tts=${config.tts.key}/${config.tts.voice}`);

const turn = await session.handleUtterance(callerPcm, 'ai-loop:1');
await session.close('done');

const m = turn.metrics;
const ms = (value: number | null) => (value === null ? '-' : `${Math.round(value)} ms`);
console.log(`Result: ${turn.status}${turn.reason ? ` (${turn.reason})` : ''}`);
if (turn.transcript !== undefined) console.log(`Caller: ${turn.transcript}`);
if (turn.reply !== undefined) console.log(`Agent:  ${turn.reply}`);
console.log(`Timing: stt ${ms(m.sttMs)}, llm first token ${ms(m.llmFirstTokenMs)}, llm total ${ms(m.llmTotalMs)}, tts first ${ms(m.ttsFirstMs)}, total ${ms(m.totalMs)}`);
if (m.usage) console.log(`Usage:  ${m.usage.promptTokens} prompt + ${m.usage.completionTokens} completion tokens; ${m.ttsChars} TTS characters; ${(m.utteranceMs / 1000).toFixed(1)} s of audio to STT`);
console.log(`Reply audio: ${sink.totalBytes} bytes (${((sink.totalBytes / 2 / format.sampleRate)).toFixed(1)} s)`);

if (sink.totalBytes > 0) {
  const out = path.resolve(flag(args, '--out') ?? 'ai-loop-reply.wav');
  fs.writeFileSync(out, toWav(Buffer.concat(sink.played), format));
  console.log(`Wrote ${out}  (play it to hear the reply)`);
}
process.exit(turn.status === 'completed' ? 0 : 1);
