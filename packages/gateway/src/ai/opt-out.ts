/**
 * Recognises a caller clearly asking not to be called again, in English. It is deliberately conservative about what it
 * calls an opt-out only in one direction that matters: a false positive just stops future calls to that number, a false
 * negative would keep calling someone who asked. Other languages are not recognised (the operator can still mark a contact
 * as opted out by hand), and this never ends or changes the call itself: it only records the request.
 */
const PATTERNS: RegExp[] = [
  /\b(do not|don'?t|dont|never)\s+(?:ever\s+)?(call|phone|ring|contact|text|message)\s+(me|us|this number)\b/,
  /\b(do not|don'?t|dont|never)\s+(?:ever\s+)?(call|phone|ring|contact)\b.{0,20}\b(again|anymore|any more)\b/,
  /\bstop\s+(calling|phoning|ringing|contacting)\b/,
  /\b(remove|take|delete|erase|put)\s+(me|my number|this number|my name)\s+(from|off|on)\b.{0,30}\b(list|calls?|database|register|registry)\b/,
  /\btake me off\b/,
  /\bunsubscribe\b/,
  /\bdo not call (list|registry|register)\b/,
  /\bno more calls\b/,
  /\bstop (these|the) calls\b/,
  /\bleave me alone\b/,
];

/** "please don't stop calling" asks the opposite. */
const NEGATED = /\b(do not|don'?t|dont|never)\s+stop\s+(calling|phoning|ringing|contacting)\b/;

export function detectOptOut(transcript: string): boolean {
  const text = (transcript ?? '').toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (text === '' || NEGATED.test(text)) return false;
  return PATTERNS.some((p) => p.test(text));
}
