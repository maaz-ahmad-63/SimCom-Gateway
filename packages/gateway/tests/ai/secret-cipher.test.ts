import { describe, expect, it } from 'vitest';
import { SecretCipher } from '../../src/ai/secrets.js';

describe('SecretCipher', () => {
  const master = 'a-long-master-key-for-tests-only';

  it('round-trips, and a different master key still cannot read the value', () => {
    const blob = new SecretCipher(master).encrypt('sk-live-value-1234567890');
    expect(blob).not.toContain('sk-live');
    expect(new SecretCipher(master).decrypt(blob)).toBe('sk-live-value-1234567890');
    expect(() => new SecretCipher('another-long-master-key-0000').decrypt(blob)).toThrow(/could not be decrypted/);
  });

  it('derives each stored value once per process, so listing keys does not stall the event loop', () => {
    const writer = new SecretCipher(master);
    const blobs = Array.from({ length: 3 }, (_, i) => writer.encrypt(`key-number-${i}-abcdefghij`));
    const reader = new SecretCipher(master); // a fresh process: nothing cached
    const first = Date.now();
    for (const b of blobs) reader.decrypt(b);
    const cold = Date.now() - first;
    const again = Date.now();
    for (let i = 0; i < 100; i++) for (const b of blobs) reader.decrypt(b);
    const warm = Date.now() - again;
    expect(reader.decrypt(blobs[1])).toBe('key-number-1-abcdefghij');
    // 300 repeat decrypts would cost ~15 s if each ran scrypt; cached they are effectively free.
    expect(warm).toBeLessThan(Math.max(250, cold));
  });

  it('never caches a failure', () => {
    const c = new SecretCipher(master);
    const blob = c.encrypt('value-value-value-1');
    const tampered = blob.slice(0, -2) + 'AA';
    expect(() => new SecretCipher(master).decrypt(tampered)).toThrow();
  });
});
