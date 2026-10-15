import { describe, expect, it } from 'vitest';
import { formatDuration, getOutcomeBadge, validatePhoneNumber } from '../src/lib/utils';

describe('Dashboard Utils', () => {
  it('formats duration in seconds to mm:ss format correctly', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(5)).toBe('00:05');
    expect(formatDuration(59)).toBe('00:59');
    expect(formatDuration(60)).toBe('01:00');
    expect(formatDuration(125)).toBe('02:05');
    expect(formatDuration(-10)).toBe('00:00');
    expect(formatDuration(NaN)).toBe('00:00');
  });

  it('maps call outcomes to human-readable badges with dark styling', () => {
    const completed = getOutcomeBadge('completed');
    expect(completed.label).toBe('Completed');
    expect(completed.className).toContain('emerald');

    const missed = getOutcomeBadge('missed');
    expect(missed.label).toBe('Missed');
    expect(missed.className).toContain('amber');

    const busyRejected = getOutcomeBadge('busy_rejected');
    expect(busyRejected.label).toContain('Auto-Rejected');

    const unknown = getOutcomeBadge(null);
    expect(unknown.label).toBe('Unknown');
  });

  it('validates E.164 phone numbers with 7 to 15 digits', () => {
    expect(validatePhoneNumber('+919876543210')).toBe(true);
    expect(validatePhoneNumber('9876543210')).toBe(true);
    expect(validatePhoneNumber('+14155552671')).toBe(true);

    // Invalid numbers
    expect(validatePhoneNumber('')).toBe(false);
    expect(validatePhoneNumber('123')).toBe(false);
    expect(validatePhoneNumber('+91abc')).toBe(false);
    expect(validatePhoneNumber('+919876543210;AT+CFUN=0')).toBe(false);
  });
});
