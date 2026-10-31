/**
 * What the caller has already told us in this call (their name, phone number and email address), kept deterministically from
 * the recognised text, so the agent neither asks for it again nor "fixes" it, and nothing is treated as right until the caller
 * has agreed to a read-back.
 *
 * Why: on call 503ec8b2 the caller spoke their number twice and was asked to repeat it five times. The digits were in the
 * history only as words ("six two eight eight. Zero eight..."), with one unclear token, and nothing told the model what had
 * been heard or confirmed.
 *
 * This reads spoken digits, spoken emails ("john dot smith at gmail dot com") and the caller's name, keeps one candidate of
 * each with its state (heard, read back, confirmed), and gives the model a short block every turn: what is known, what is still
 * unconfirmed and how to confirm it. It never guesses: an unclear digit stays a "?", an email is only what was spelled out, and
 * nothing is confirmed until the caller says yes to a read-back. English words only.
 */
const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', nought: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
const REPEAT_WORDS: Record<string, number> = { double: 2, triple: 3 };
/** Spoken hesitations inside a number that do not end it. */
const FILLERS = new Set(['uh', 'um', 'er', 'erm', 'ah', 'hmm', 'mm', 'and']);

export interface SpokenNumber {
  /** The digits in order; an unclear token inside the number is a "?". */
  digits: string;
  /** How many of them are real digits (not "?"). */
  known: number;
  unclear: number;
}

/** The longest run of spoken or written digits in a piece of recognised speech, or null when there is none of 4 or more. */
export function parseSpokenDigits(text: string): SpokenNumber | null {
  const tokens = (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9'?\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let best: SpokenNumber | null = null;
  let run = '';
  let repeat = 1;
  const close = () => {
    const trimmed = run.replace(/^\?+|\?+$/g, '');
    const known = trimmed.replace(/\?/g, '').length;
    if (known >= 4 && (!best || trimmed.length > best.digits.length)) best = { digits: trimmed, known, unclear: trimmed.length - known };
    run = '';
    repeat = 1;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const digit = /^\d+$/.test(t) ? t : DIGIT_WORDS[t];
    if (digit !== undefined) {
      run += repeat > 1 && digit.length === 1 ? digit.repeat(repeat) : digit;
      repeat = 1;
      continue;
    }
    if (REPEAT_WORDS[t] && i + 1 < tokens.length && (DIGIT_WORDS[tokens[i + 1]] || /^\d$/.test(tokens[i + 1]))) {
      repeat = REPEAT_WORDS[t];
      continue;
    }
    if (run && FILLERS.has(t)) continue;
    // A single stray letter between digits ("three e eight") is a digit the recogniser did not catch: keep its place as "?".
    const next = tokens[i + 1];
    if (run && /^[a-z]$/.test(t) && next !== undefined && (DIGIT_WORDS[next] !== undefined || /^\d+$/.test(next))) {
      run += '?';
      continue;
    }
    if (run) close();
  }
  if (run) close();
  return best;
}

// ---------------------------------------------------------------------------------------------------- email

/** Words that end the stretch of speech that can belong to an email's local part when read backwards from "at". */
const NOT_EMAIL_WORDS = new Set([
  'is', 'am', 'are', 'was', 'my', 'email', 'e-mail', 'mail', 'address', 'id', 'the', 'yes', 'yeah', 'yep', 'okay', 'ok', 'so', 'well',
  'uh', 'um', 'hmm', 'please', 'sure', 'its', "it's", 'it', 'i', 'you', 'can', 'will', 'send', 'write', 'down', 'here', 'that', 'this',
  'number', 'phone', 'name', 'and', 'then', 'also', 'or', 'but', 'just', 'actually', 'at', 'to', 'on', 'for',
]);
const TLDS = new Set(['com', 'org', 'net', 'edu', 'gov', 'io', 'co', 'in', 'uk', 'us', 'au', 'ca', 'de', 'info', 'biz', 'me', 'ai', 'app', 'dev', 'tech']);
const SYMBOL_WORDS: Record<string, string> = { dot: '.', period: '.', underscore: '_', dash: '-', hyphen: '-', plus: '+' };
/** Digit words inside an email. A spoken "o" (or "oh") is a letter there: "j o h n" is john, not j0hn. */
const EMAIL_DIGITS: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const LITERAL_EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/;

export interface SpokenEmail {
  email: string;
}

/** A piece of an email from consecutive tokens: single letters/digits join into one piece ("g m a i l" is "gmail"). */
function joinPiece(tokens: string[]): string {
  return tokens.map((t) => EMAIL_DIGITS[t] ?? SYMBOL_WORDS[t] ?? t).join('');
}

/**
 * An email address from recognised speech, or null. Accepts one already written ("john@example.com") or spoken with "at" and
 * "dot" ("john dot smith at gmail dot com", "j o h n at example dot com"). Only what was said is used: nothing is added,
 * corrected or completed, and a name or domain that is not there means no email.
 */
export function parseSpokenEmail(text: string): SpokenEmail | null {
  const lower = (text ?? '').toLowerCase();
  const written = LITERAL_EMAIL.exec(lower.replace(/\s*@\s*/g, '@'));
  if (written) return { email: written[0].replace(/[._-]+$/, '') };

  const tokens = lower
    .replace(/\bat the rate( of)?\b|\bat sign\b|@/g, ' at ')
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (let at = tokens.length - 1; at > 0; at--) {
    if (tokens[at] !== 'at') continue;
    // Domain: pieces separated by "dot", ending in something that looks like a top-level domain.
    const domain: string[] = [];
    let j = at + 1;
    for (;;) {
      const piece: string[] = [];
      while (j < tokens.length && tokens[j] !== 'dot' && tokens[j] !== 'period' && tokens[j] !== 'at') {
        const t = tokens[j];
        if (piece.length > 0 && t.length > 1 && !EMAIL_DIGITS[t] && piece.every((p) => p.length === 1)) break; // a word after spelled letters
        if (piece.length > 0 && piece.some((p) => p.length > 1 && !EMAIL_DIGITS[p]) && !(t.length === 1 || EMAIL_DIGITS[t])) break; // two words in a row
        piece.push(t);
        j++;
      }
      if (piece.length === 0) break;
      domain.push(joinPiece(piece));
      if (j < tokens.length && (tokens[j] === 'dot' || tokens[j] === 'period')) {
        j++;
        continue;
      }
      break;
    }
    if (domain.length < 2 || !TLDS.has(domain[domain.length - 1])) continue;
    // Local part: read backwards from "at" until a word that cannot be part of an address.
    const local: string[] = [];
    for (let k = at - 1; k >= 0 && local.length < 14; k--) {
      const t = tokens[k];
      if (NOT_EMAIL_WORDS.has(t)) break;
      local.unshift(t);
    }
    const localPart = joinPiece(local).replace(/^[._+-]+|[._+-]+$/g, '');
    const email = `${localPart}@${domain.join('.')}`;
    if (localPart.length >= 2 && /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) return { email };
  }
  return null;
}

/** How to say an address aloud so it can be checked: the part before the @ letter by letter, then the domain. */
export function spellEmailForReadBack(email: string): string {
  const [local, domain] = email.split('@');
  const say = (s: string) => s.split('').map((c) => (c === '.' ? 'dot' : c === '_' ? 'underscore' : c === '-' ? 'dash' : c === '+' ? 'plus' : c)).join(' ');
  return `${say(local)} at ${domain.split('.').join(' dot ')}`;
}

const squash = (s: string) => s.toLowerCase().replace(/\b(dot|period|at|underscore|dash|hyphen|plus)\b/g, '').replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------------------------------------------- state

const spaced = (digits: string) => digits.split('').join(' ');
const AFFIRM = /^(uh |um |oh )?(yes|yeah|yep|yup|correct|right|exactly|perfect|that'?s (right|correct|it)|that is (right|correct)|haan|ha|ji|sahi)\b/;
const NEGATE = /\b(no|nope|not|wrong|incorrect|galat|nahi)\b/;
const NAME = /\b(?:my name is|my name's|call me)\s+([A-Za-z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30})?)/i;
const NOT_A_NAME = new Set(['not', 'the', 'a', 'an', 'calling', 'looking', 'just', 'actually', 'still', 'here', 'from', 'with']);
/** A bare name given as a correction ("It's Maza." / "Mazza."), only accepted right after a read-back was refused. */
const BARE_NAME = /^(?:[Nn]o[,.\s]+)?(?:(?:[Ii]t'?s|[Ii]t is|[Tt]hat'?s|[Tt]hat is) )?([A-Z][a-z-]{1,20}(?: [A-Z][a-z-]{1,20})?)[.!]?$/;

interface Item {
  readBack: boolean;
  confirmed: boolean;
}

export interface ContactState {
  name: string | null;
  nameConfirmed: boolean;
  nameReadBack: boolean;
  phone: { heard: string; known: number; unclear: number; times: number; readBack: boolean; confirmed: boolean } | null;
  email: { heard: string; times: number; readBack: boolean; confirmed: boolean } | null;
}

export class ContactDetails {
  private name: ({ value: string } & Item) | null = null;
  private phone: ContactState['phone'] = null;
  private email: ContactState['email'] = null;
  /** The last read-back was refused: the next bare name is a correction. */
  private nameRefused = false;

  constructor(private readonly enabled = true) {}

  get snapshot(): ContactState {
    return {
      name: this.name?.value ?? null,
      nameConfirmed: this.name?.confirmed ?? false,
      nameReadBack: this.name?.readBack ?? false,
      phone: this.phone ? { ...this.phone } : null,
      email: this.email ? { ...this.email } : null,
    };
  }

  /** Something the caller said (a committed transcript). */
  noteCaller(text: string): void {
    if (!this.enabled || !text) return;
    let learned = false;

    const name = NAME.exec(text)?.[1]?.replace(/[.,!?]+$/, '').trim();
    const bare = this.nameRefused ? BARE_NAME.exec(text.trim())?.[1] : undefined;
    const candidate = name && !NOT_A_NAME.has(name.split(' ')[0].toLowerCase()) ? name : bare;
    if (candidate) {
      if (this.name?.value.toLowerCase() !== candidate.toLowerCase()) this.name = { value: candidate, readBack: false, confirmed: false };
      this.nameRefused = false;
      learned = true;
    }

    const number = parseSpokenDigits(text);
    if (number && number.known >= 7) {
      if (this.phone && this.phone.heard === number.digits) this.phone.times++;
      // A new or corrected number replaces the old candidate; it is unconfirmed until read back and agreed.
      else this.phone = { heard: number.digits, known: number.known, unclear: number.unclear, times: 1, readBack: false, confirmed: false };
      learned = true;
    }

    const mail = parseSpokenEmail(text);
    if (mail) {
      if (this.email && this.email.heard === mail.email) this.email.times++;
      else this.email = { heard: mail.email, times: 1, readBack: false, confirmed: false };
      learned = true;
    }
    if (learned) return;

    // No new detail: this is an answer to a read-back, if one is waiting. A yes confirms what was read back; a no withdraws it.
    const said = text.toLowerCase().trim();
    const waiting = this.waiting();
    if (waiting.length === 0) return;
    if (NEGATE.test(said)) {
      for (const item of waiting) item.readBack = false;
      if (this.name && waiting.includes(this.name)) this.nameRefused = true;
    } else if (AFFIRM.test(said)) {
      for (const item of waiting) item.confirmed = true;
    }
  }

  /** The items the agent has read back that the caller has not yet agreed to. */
  private waiting(): Item[] {
    return [this.name, this.phone, this.email].filter((i): i is NonNullable<typeof i> => i !== null && i.readBack && !i.confirmed);
  }

  /** What the agent said (the words that were actually played). */
  noteAgent(text: string): void {
    if (!this.enabled || !text) return;
    const phone = this.phone;
    if (phone && !phone.confirmed && phone.unclear === 0) {
      // A read-back is the agent saying the same digits, as words or numerals, anywhere in its reply.
      const digits = (text.toLowerCase().match(/\d|\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g) ?? []).map((d) => DIGIT_WORDS[d] ?? d).join('');
      if (digits.includes(phone.heard)) phone.readBack = true;
    }
    const email = this.email;
    if (email && !email.confirmed && squash(text).includes(squash(email.heard))) email.readBack = true;
    const name = this.name;
    if (name && !name.confirmed && text.toLowerCase().includes(name.value.toLowerCase())) {
      const sentences = text.split(/(?<=[.!?])\s+/);
      const nameQuestion = sentences.some((x) => x.includes('?') && x.toLowerCase().includes(name.value.toLowerCase()));
      const checkQuestion = sentences.some((x) => x.includes('?') && /\b(name|spell|spelling|right|correct)\b/i.test(x));
      if (nameQuestion || checkQuestion) name.readBack = true;
    }
  }

  /** The block for the system prompt; empty when nothing has been collected. */
  promptBlock(): string {
    if (!this.enabled) return '';
    const { name, phone, email } = this;
    if (!name && !phone && !email) return '';
    const lines = ["CALL DETAILS GIVEN SO FAR (recognised from the caller's speech in this call; use them and do not ask for them again):"];
    if (name) {
      if (name.confirmed) lines.push(`- name: ${name.value}, confirmed by the caller.`);
      else if (name.readBack) lines.push(`- name: ${name.value}. You have said it back: wait for the caller to confirm or correct it.`);
      else lines.push(`- name: ${name.value} (heard, not confirmed). When it fits, say it back once and ask if it is right; offer to spell it if you are unsure. Never change the spelling yourself.`);
    }
    if (phone) {
      const heard = `heard as ${spaced(phone.heard)} (${phone.known} digit${phone.known === 1 ? '' : 's'}${phone.unclear ? `, ${phone.unclear} unclear` : ''})`;
      if (phone.confirmed) lines.push(`- phone number: ${spaced(phone.heard)}, confirmed by the caller. Do not ask for it again.`);
      else if (phone.unclear > 0)
        lines.push(`- phone number: ${heard}. NOT confirmed. The digit shown as ? was not clear: ask only about that part, then read the whole number back once. Never guess, add, drop or reorder digits.`);
      else if (phone.readBack) lines.push(`- phone number: ${heard}. You have read it back: wait for the caller to confirm or correct it. Do not ask for the whole number again.`);
      else
        lines.push(
          `- phone number: ${heard}. NOT confirmed. Read these digits back once, in small groups, and ask the caller to confirm or correct them.` +
            (phone.times > 1 ? ` The caller has already said this number ${phone.times} times: do not ask them to repeat it.` : ' Do not ask for it again from the start.') +
            ' Never guess, add, drop or reorder digits.'
        );
    }
    if (email) {
      const say = spellEmailForReadBack(email.heard);
      if (email.confirmed) lines.push(`- email address: ${email.heard}, confirmed by the caller. Do not ask for it again.`);
      else if (email.readBack) lines.push(`- email address: ${email.heard}. You have read it back: wait for the caller to confirm or correct it. Do not ask for the whole address again.`);
      else
        lines.push(
          `- email address: heard as ${email.heard}. NOT confirmed. Read it back once, spelling the part before the @ letter by letter and saying "at" and "dot" (${say}), and ask the caller to confirm or spell any correction.` +
            ' Never guess, complete or correct a spelling yourself, and never assume a domain.'
        );
    }
    lines.push('Ask only for details that are still missing or unconfirmed, one question per turn, and read back only one detail at a time.');
    return lines.join('\n');
  }
}
