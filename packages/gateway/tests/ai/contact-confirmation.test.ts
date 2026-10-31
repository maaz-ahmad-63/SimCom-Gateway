import { describe, expect, it } from 'vitest';
import { CollectingAudioSink } from '../../src/ai/audio.js';
import { ContactDetails, parseSpokenEmail, spellEmailForReadBack } from '../../src/ai/contact-details.js';
import { ConversationSession } from '../../src/ai/conversation.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { FORMAT_8K, makeConfig, speechPcm } from './helpers.js';

describe('spoken email addresses: only what was said, never guessed', () => {
  it.each([
    ['my email is john dot smith at gmail dot com', 'john.smith@gmail.com'],
    ['j o h n at example dot com', 'john@example.com'],
    ["it's m a z a one two three at outlook dot com", 'maza123@outlook.com'],
    ['sure, it is anita underscore rao at company dot co dot in', 'anita_rao@company.co.in'],
    ['you can write down sam dash lee at proton dot me', 'sam-lee@proton.me'],
    ['john@example.com', 'john@example.com'],
    ['It is Priya.K@Sizh.io', 'priya.k@sizh.io'],
    ['my email is john dot smith at gmail dot com and my phone is nine eight seven six', 'john.smith@gmail.com'],
    ['john at the rate gmail dot com', 'john@gmail.com'],
  ])('reads %j as %s', (said, email) => {
    expect(parseSpokenEmail(said)?.email).toBe(email);
  });

  it.each([
    'I will call you at five dot thirty',
    'meet me at the office',
    'at gmail dot com', // no local part
    'john at gmail', // no domain ending
    'john at gmail dot', // a domain that stops short
    'john at gmail dot something', // not a top-level domain it knows: not guessed
    'call me at nine',
    'Hello?',
    '',
  ])('finds no email in %j', (said) => {
    expect(parseSpokenEmail(said)).toBeNull();
  });

  it('spells an address the way it should be read back', () => {
    expect(spellEmailForReadBack('john.smith@gmail.com')).toBe('j o h n dot s m i t h at gmail dot com');
    expect(spellEmailForReadBack('anita_rao@company.co.in')).toBe('a n i t a underscore r a o at company dot co dot in');
  });
});

describe('names, phone numbers and emails are each confirmed explicitly, one at a time', () => {
  const say = (c: ContactDetails, ...texts: string[]) => texts.forEach((t) => c.noteCaller(t));

  it('an email is unconfirmed until it is read back and the caller agrees; the block says how to read it back', () => {
    const c = new ContactDetails();
    say(c, 'my email is john dot smith at gmail dot com');
    expect(c.snapshot.email).toMatchObject({ heard: 'john.smith@gmail.com', confirmed: false, readBack: false });
    expect(c.promptBlock()).toMatch(/email address: heard as john\.smith@gmail\.com\. NOT confirmed\. Read it back once, spelling the part before the @ letter by letter.*j o h n dot s m i t h at gmail dot com/);
    expect(c.promptBlock()).toMatch(/never assume a domain/i);
    say(c, 'yes'); // a yes before any read-back confirms nothing
    expect(c.snapshot.email?.confirmed).toBe(false);
    c.noteAgent('Let me check that: j o h n dot s m i t h at gmail dot com. Is that right?');
    expect(c.snapshot.email?.readBack).toBe(true);
    expect(c.promptBlock()).toMatch(/You have read it back: wait for the caller to confirm or correct it/);
    say(c, 'Yes, that is correct.');
    expect(c.snapshot.email).toMatchObject({ confirmed: true });
    expect(c.promptBlock()).toMatch(/email address: john\.smith@gmail\.com, confirmed by the caller/);
  });

  it('a corrected email replaces the old one and starts unconfirmed; a refusal withdraws the read-back', () => {
    const c = new ContactDetails();
    say(c, 'john dot smith at gmail dot com');
    c.noteAgent('j o h n dot s m i t h at gmail dot com, is that right?');
    say(c, 'No.');
    expect(c.snapshot.email).toMatchObject({ readBack: false, confirmed: false });
    say(c, 'it is john dot smyth at gmail dot com');
    expect(c.snapshot.email).toMatchObject({ heard: 'john.smyth@gmail.com', confirmed: false, readBack: false });
  });

  it('a name is heard, said back, and only then confirmed; a refused name is replaced by the correction, not guessed', () => {
    const c = new ContactDetails();
    say(c, 'My name is Maza.');
    expect(c.snapshot).toMatchObject({ name: 'Maza', nameConfirmed: false, nameReadBack: false });
    expect(c.promptBlock()).toMatch(/name: Maza \(heard, not confirmed\)\. When it fits, say it back once.*offer to spell it/);
    c.noteAgent('Thanks, Maza. Did I get your name right?');
    expect(c.snapshot.nameReadBack).toBe(true);
    say(c, 'No.');
    expect(c.snapshot).toMatchObject({ name: 'Maza', nameReadBack: false });
    say(c, "It's Mazza.");
    expect(c.snapshot).toMatchObject({ name: 'Mazza', nameConfirmed: false });
    c.noteAgent('Is it Mazza, with two zs?');
    say(c, 'Yes.');
    expect(c.snapshot).toMatchObject({ name: 'Mazza', nameConfirmed: true });
    expect(c.promptBlock()).toMatch(/name: Mazza, confirmed by the caller/);
  });

  it('a bare capitalised word is a name only right after a refused read-back, never otherwise', () => {
    const c = new ContactDetails();
    say(c, 'Hello?', 'Stripe.', "I'm still applying"); // from the real call: none of these is a name
    expect(c.snapshot.name).toBeNull();
    say(c, 'My name is Maza.');
    say(c, 'Stripe.'); // no read-back was refused, so this is not a correction
    expect(c.snapshot.name).toBe('Maza');
  });

  it('a yes confirms only what was read back, not what is merely known', () => {
    const c = new ContactDetails();
    say(c, 'my name is Maza', 'six two eight eight zero eight zero one nine eight', 'maza at outlook dot com');
    c.noteAgent('Is your number six two eight eight, zero eight zero, one nine eight?');
    say(c, 'Yes.');
    expect(c.snapshot.phone?.confirmed).toBe(true);
    expect(c.snapshot.email?.confirmed).toBe(false); // never read back
    expect(c.snapshot.nameConfirmed).toBe(false);
    const block = c.promptBlock();
    expect(block).toMatch(/phone number: 6 2 8 8 0 8 0 1 9 8, confirmed by the caller/);
    expect(block).toMatch(/email address: heard as maza@outlook\.com\. NOT confirmed/);
    expect(block).toMatch(/read back only one detail at a time/);
  });

  it('carries all three into the model\'s prompt on every later turn, so nothing is asked for twice', async () => {
    const providers = createMockProviders({
      stt: ['my name is Maza', 'my email is maza at outlook dot com', 'yes that is right'],
      llm: ['Nice to meet you, Maza. And your email?', 'Let me check: m a z a at outlook dot com. Is that right?', 'Thanks. And a phone number?'],
    });
    const session = new ConversationSession({ callId: 'c', config: makeConfig(), providers, sink: new CollectingAudioSink(FORMAT_8K) });
    for (const id of ['a', 'b', 'c']) await session.handleUtterance(speechPcm(1200), id);
    const [one, two, three] = providers.llm.requests.map((r) => r.system);
    expect(one).toMatch(/name: Maza \(heard, not confirmed\)/);
    expect(two).toMatch(/email address: heard as maza@outlook\.com\. NOT confirmed/);
    expect(three).toMatch(/email address: maza@outlook\.com, confirmed by the caller\. Do not ask for it again/);
    expect(three).toMatch(/name: Maza \(heard, not confirmed\)/); // the agent never said the name back, so it is still open
  });
});
