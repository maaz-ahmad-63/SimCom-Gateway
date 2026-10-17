/**
 * Pure PCM helpers for the opt-in USB PCM verification tests.
 *
 * Nothing here knows the real SIM7600 USB-audio wire format. Every function takes the
 * format as an explicit argument so an unverified assumption can never be applied silently.
 */

export type PcmEndianness = 'little-endian' | 'big-endian';

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitDepth: 8 | 16;
  endianness: PcmEndianness;
}

export interface PcmAnalysis {
  format: PcmFormat;
  sampleCount: number;
  durationMs: number;
  rms: number;
  peak: number;
  dcOffset: number;
  clippedRatio: number;
  silentRatio: number;
  dominantHz: number;
  /** Goertzel peak power divided by the mean power of the 100 Hz-3.8 kHz scan grid. */
  peakToMean: number;
  /**
   * Fraction (0-1) of the signal's total energy sitting at the dominant frequency.
   * ~1 for a clean tone decoded with the right format; much lower when the byte order,
   * bit depth or channel layout is wrong, because the energy smears across the spectrum.
   */
  toneConcentration: number;
}

/** Decode the first channel of an interleaved buffer to floats in [-1, 1]. */
export function decodePcm(data: Buffer, format: PcmFormat): Float64Array {
  const bytesPerSample = format.bitDepth / 8;
  const frameBytes = bytesPerSample * format.channels;
  const frames = Math.floor(data.length / frameBytes);
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const offset = i * frameBytes;
    if (format.bitDepth === 8) {
      out[i] = (data[offset] - 128) / 128;
    } else {
      const value =
        format.endianness === 'little-endian' ? data.readInt16LE(offset) : data.readInt16BE(offset);
      out[i] = value / 32768;
    }
  }
  return out;
}

function goertzelPower(samples: Float64Array, sampleRate: number, hz: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

export function analyzePcm(data: Buffer, format: PcmFormat): PcmAnalysis {
  const samples = decodePcm(data, format);
  const n = samples.length;
  let sumSq = 0;
  let sum = 0;
  let peak = 0;
  let clipped = 0;
  let silent = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    sum += v;
    sumSq += v * v;
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
    if (abs >= 0.99) clipped++;
    if (abs < 0.001) silent++;
  }

  let dominantHz = 0;
  let peakPower = 0;
  let powerSum = 0;
  let gridCount = 0;
  const maxHz = Math.min(3800, format.sampleRate / 2 - 100);
  if (n > 0) {
    for (let hz = 100; hz <= maxHz; hz += 10) {
      const power = goertzelPower(samples, format.sampleRate, hz);
      powerSum += power;
      gridCount++;
      if (power > peakPower) {
        peakPower = power;
        dominantHz = hz;
      }
    }
  }
  const meanPower = gridCount > 0 ? powerSum / gridCount : 0;

  return {
    format,
    sampleCount: n,
    durationMs: format.sampleRate > 0 ? Math.round((n / format.sampleRate) * 1000) : 0,
    rms: n > 0 ? Math.sqrt(sumSq / n) : 0,
    peak,
    dcOffset: n > 0 ? sum / n : 0,
    clippedRatio: n > 0 ? clipped / n : 0,
    silentRatio: n > 0 ? silent / n : 0,
    dominantHz,
    peakToMean: meanPower > 0 ? peakPower / meanPower : 0,
    toneConcentration: sumSq > 0 ? Math.min(1, peakPower / ((n * sumSq) / 2)) : 0,
  };
}

/** Candidate formats tried by the inspector; a hint for a human, never proof. */
export const CANDIDATE_FORMATS: PcmFormat[] = [
  { sampleRate: 8000, channels: 1, bitDepth: 16, endianness: 'little-endian' },
  { sampleRate: 8000, channels: 1, bitDepth: 16, endianness: 'big-endian' },
  { sampleRate: 16000, channels: 1, bitDepth: 16, endianness: 'little-endian' },
  { sampleRate: 16000, channels: 1, bitDepth: 16, endianness: 'big-endian' },
  { sampleRate: 8000, channels: 1, bitDepth: 8, endianness: 'little-endian' },
];

export function sweepCandidateFormats(data: Buffer): PcmAnalysis[] {
  return CANDIDATE_FORMATS.map((format) => analyzePcm(data, format)).sort(
    (a, b) => b.toneConcentration - a.toneConcentration
  );
}

/** Format claimed as verified by the operator; required before any WAV header is written. */
export interface VerifiedPcmFormat extends PcmFormat {
  verified: true;
}

export function buildWavHeader(format: VerifiedPcmFormat, dataBytes: number): Buffer {
  if (format.verified !== true) {
    throw new Error('Refusing to write a WAV header for an unverified PCM format');
  }
  const blockAlign = (format.channels * format.bitDepth) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // integer PCM
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(format.bitDepth, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** WAV PCM is little-endian, so big-endian 16-bit captures are byte-swapped. */
export function buildWav(data: Buffer, format: VerifiedPcmFormat): Buffer {
  let body = data;
  if (format.bitDepth === 16 && format.endianness === 'big-endian') {
    body = Buffer.from(data.subarray(0, data.length - (data.length % 2)));
    body.swap16();
  }
  return Buffer.concat([buildWavHeader(format, body.length), body]);
}

/** Generate a 16-bit mono sine tone. Amplitude is a fraction of full scale. */
export function generateTone(
  format: PcmFormat,
  frequencyHz: number,
  durationMs: number,
  amplitude: number
): Buffer {
  if (format.bitDepth !== 16 || format.channels !== 1) {
    throw new Error('Tone generation supports 16-bit mono only');
  }
  const sampleCount = Math.round((format.sampleRate * durationMs) / 1000);
  const out = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / format.sampleRate) * amplitude * 32767);
    if (format.endianness === 'little-endian') out.writeInt16LE(value, i * 2);
    else out.writeInt16BE(value, i * 2);
  }
  return out;
}

/**
 * SIMCom USB Audio Application Note V1.03 / V2.00, section 2.3: "USB audio PCM data format is 8K
 * sample rate, 16 bit linear" (16 kHz after AT+CPCMFRM=1). The note does NOT state byte order,
 * channel count or frame size: little-endian mono is the usual convention, not a documented fact,
 * so it still has to be confirmed by listening.
 */
export const USB_AUDIO_DOCUMENTED_DEFAULT = { sampleRate: 8000, bitDepth: 16 } as const;

export interface SpeechIndicators {
  /** 30 ms frames above the noise floor (rms >= 120 of 32768, about -49 dBFS). */
  energeticFrames: number;
  /** Energetic frames with a clear pitch period between 70 and 400 Hz. */
  voicedFrames: number;
  voicedRatio: number;
  medianPitchHz: number | null;
}

/**
 * Objective hint that a 16-bit mono stream holds voiced speech. It is an indicator only: noise
 * decoded with the wrong byte order can also look "energetic", and nothing here can establish
 * that speech is intelligible. A person has to listen to the WAV.
 */
export function speechIndicators(data: Buffer, format: PcmFormat): SpeechIndicators {
  if (format.bitDepth !== 16) {
    return { energeticFrames: 0, voicedFrames: 0, voicedRatio: 0, medianPitchHz: null };
  }
  const samples = decodePcm(data, format);
  const frame = Math.round(format.sampleRate * 0.03);
  const minLag = Math.round(format.sampleRate / 400);
  const maxLag = Math.round(format.sampleRate / 70);
  let energetic = 0;
  const pitches: number[] = [];

  for (let start = 0; start + frame <= samples.length; start += frame) {
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += samples[start + i] * samples[start + i];
    if (Math.sqrt(energy / frame) * 32768 < 120) continue;
    energetic++;

    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag && lag < frame; lag++) {
      let cross = 0;
      let a = 0;
      let b = 0;
      for (let i = 0; i + lag < frame; i++) {
        const x = samples[start + i];
        const y = samples[start + i + lag];
        cross += x * y;
        a += x * x;
        b += y * y;
      }
      const r = cross / Math.sqrt(a * b + 1e-12);
      if (r > best) {
        best = r;
        bestLag = lag;
      }
    }
    if (best > 0.5) pitches.push(format.sampleRate / bestLag);
  }

  pitches.sort((p, q) => p - q);
  return {
    energeticFrames: energetic,
    voicedFrames: pitches.length,
    voicedRatio: energetic > 0 ? pitches.length / energetic : 0,
    medianPitchHz: pitches.length > 0 ? pitches[pitches.length >> 1] : null,
  };
}
