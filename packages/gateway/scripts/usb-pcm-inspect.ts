/**
 * Inspect a raw USB PCM capture (.bin) written by the opt-in capture test.
 *
 *   analyze <file.bin>
 *       Prints stats for each candidate format. If the remote party played a steady known
 *       tone during the capture, the correct format is the one whose dominantHz matches it
 *       with a high toneConcentration (close to 1). This is evidence, not proof.
 *
 *   wav <file.bin> <out.wav> --rate N --bits 8|16 --channels N --endian little|big --i-verified-format
 *       Writes a WAV only when every format field is given explicitly and the operator
 *       confirms the format was verified. Play the result in any audio player.
 *
 *   wav <file.bin> <out.wav> --rate N --bits 16 --channels 1 --endian little --candidate-unverified
 *       Same, for LISTENING to a candidate format before it is verified. The file is named
 *       <out>.CANDIDATE.wav. Hearing intelligible speech is how a candidate becomes verified.
 */
import fs from 'node:fs';
import {
  analyzePcm,
  buildWav,
  speechIndicators,
  sweepCandidateFormats,
  VerifiedPcmFormat,
} from '../src/diagnostics/pcm-tools.js';

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const [command, input, output, ...rest] = process.argv.slice(2);
if (!command || !input) fail('usage: analyze <file.bin> | wav <file.bin> <out.wav> --rate N --bits 8|16 --channels N --endian little|big --i-verified-format');
const data = fs.readFileSync(input);

if (command === 'analyze') {
  console.log(`bytes=${data.length}`);
  for (const a of sweepCandidateFormats(data)) {
    console.log(
      [
        `${a.format.sampleRate}Hz/${a.format.bitDepth}bit/${a.format.endianness}`,
        `durationMs=${a.durationMs}`,
        `rms=${a.rms.toFixed(4)}`,
        `peak=${a.peak.toFixed(4)}`,
        `dc=${a.dcOffset.toFixed(4)}`,
        `clipped=${(a.clippedRatio * 100).toFixed(1)}%`,
        `silent=${(a.silentRatio * 100).toFixed(1)}%`,
        `dominantHz=${a.dominantHz}`,
        `toneConcentration=${a.toneConcentration.toFixed(3)}`,
      ].join('  ')
    );
    if (a.format.bitDepth === 16) {
      const speech = speechIndicators(data, a.format);
      console.log(
        `    speech indicator: energetic=${speech.energeticFrames} voiced=${speech.voicedFrames} (${(speech.voicedRatio * 100).toFixed(0)}%) medianPitchHz=${speech.medianPitchHz?.toFixed(0) ?? '-'}  (a hint, not proof: listen to a WAV)`
      );
    }
  }
} else if (command === 'wav') {
  if (!output) fail('wav needs an output path');
  const rate = Number(flag(rest, '--rate'));
  const bits = Number(flag(rest, '--bits'));
  const channels = Number(flag(rest, '--channels'));
  const endian = flag(rest, '--endian');
  if (!Number.isInteger(rate) || rate <= 0) fail('--rate is required');
  if (bits !== 8 && bits !== 16) fail('--bits must be 8 or 16');
  if (!Number.isInteger(channels) || channels < 1) fail('--channels is required');
  if (endian !== 'little' && endian !== 'big') fail('--endian must be little or big');
  const verified = rest.includes('--i-verified-format');
  const candidate = rest.includes('--candidate-unverified');
  if (!verified && !candidate) {
    fail('Refusing to write a WAV: pass --i-verified-format after the format was verified, or --candidate-unverified to listen to a candidate (see docs)');
  }
  const format: VerifiedPcmFormat = {
    sampleRate: rate,
    channels,
    bitDepth: bits,
    endianness: endian === 'little' ? 'little-endian' : 'big-endian',
    verified: true,
  };
  const target = verified ? output : output.replace(/(\.wav)?$/i, '.CANDIDATE.wav');
  fs.writeFileSync(target, buildWav(data, format));
  const a = analyzePcm(data, format);
  console.log(`wrote ${target} durationMs=${a.durationMs} rms=${a.rms.toFixed(4)} dominantHz=${a.dominantHz}`);
} else {
  fail(`unknown command: ${command}`);
}
