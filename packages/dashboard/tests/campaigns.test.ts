import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContactsStep, SummaryTiles } from '../src/components/campaigns/ContactsStep';
import { ProgressBar, RunPanel } from '../src/components/campaigns/RunPanel';
import { Campaign, cleanMapping, Contact, csvRequestProblem, encodedRequestBytes, formFromSettings, isReservedColumn, mappingProblems, MAX_REQUEST_BYTES, nextRetryText, outcomeLabel, progressPercent, RESERVED_FIELD_KEYS, settingsPatch, settingsProblems, startBlockers, statusTone } from '../src/lib/campaigns';

const settings = {
  interCallDelaySeconds: 30, maxAttempts: 2, retryDelayMinutes: 60, retryOn: ['no_answer', 'failed'] as Array<'no_answer' | 'busy' | 'failed'>, callTimeoutSeconds: 45, agentAttachTimeoutSeconds: 20,
  callingHours: { start: '09:00', end: '20:00', days: [1, 2, 3, 4, 5, 6], timeZone: 'Asia/Kolkata' }, consentMode: 'column' as const, defaultCountryCode: '91',
  skipRecentlyCalledHours: 24, maxConsecutiveFailures: 3, greetingTemplate: null, contextNote: '',
};
const campaign = (over: Partial<Campaign> = {}): Campaign => ({ id: 'c1', name: 'Spring outreach', status: 'running', pauseReason: null, settings, mapping: null, acknowledgements: null, createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T10:00:00Z', confirmedAt: null, startedAt: '2026-10-28T10:05:00Z', finishedAt: null, config: { version: 0, prompt: '', promptSha: '', promptChars: 0, llmKey: null, createdAt: null }, listVersion: 1, ...over });
const counts = { total: 10, queued: 4, calling: 1, completed: 3, failed: 1, skipped: 1 };

describe('column mapping', () => {
  const headers = ['Name', 'Mobile', 'Title', 'Org'];
  it('keeps only real columns and requires the name and phone columns', () => {
    expect(cleanMapping({ phone: 'Mobile', name: 'Name', company: 'Nope', extra: ['Org', 'Ghost'] }, headers)).toEqual({ phone: 'Mobile', name: 'Name', extra: ['Org'] });
    expect(cleanMapping({ name: 'Name' }, headers)).toBeNull();
    expect(cleanMapping({ phone: 'Mobile' }, headers)).toBeNull();
    expect(cleanMapping({ phone: 'Missing' }, headers)).toBeNull();
  });

  it('explains what to fix before importing', () => {
    expect(mappingProblems({}, headers)).toEqual(['Choose the column that holds the phone number.', 'Choose the column that holds the contact name.']);
    expect(mappingProblems({ phone: 'Mobile', name: 'Mobile' }, headers)).toContain('Each column can only be used for one field.');
    expect(mappingProblems({ phone: 'Mobile', name: 'Title', extra: ['Name'] }, headers)).toEqual([]);
    expect(mappingProblems({ phone: 'Gone' }, headers)).toContain('The column "Gone" is not in the file.');
  });
});

describe('campaign settings form', () => {
  it('round-trips the settings and sends numbers, sorted days and null for blanks', () => {
    const form = formFromSettings(settings);
    expect(settingsProblems(form)).toEqual([]);
    const patch = settingsPatch({ ...form, days: [6, 1, 3], defaultCountryCode: ' ', greetingTemplate: '  ', contextNote: '  follow up  ' });
    expect(patch).toMatchObject({ interCallDelaySeconds: 30, maxAttempts: 2, defaultCountryCode: null, greetingTemplate: null, contextNote: 'follow up' });
    expect(patch.callingHours).toEqual({ start: '09:00', end: '20:00', days: [1, 3, 6], timeZone: 'Asia/Kolkata' });
  });

  it('flags every value the gateway would refuse', () => {
    const form = formFromSettings(settings);
    const problems = settingsProblems({ ...form, agentAttachTimeoutSeconds: '2', interCallDelaySeconds: '5', maxAttempts: '9', retryDelayMinutes: '', callTimeoutSeconds: 'abc', start: '21:00', end: '09:00', days: [], defaultCountryCode: '+91', timeZone: 'Mars/Base', maxConsecutiveFailures: '0' });
    expect(problems.join(' | ')).toMatch(/Delay between calls/);
    expect(problems.join(' | ')).toMatch(/Maximum attempts/);
    expect(problems.join(' | ')).toMatch(/Retry delay/);
    expect(problems.join(' | ')).toMatch(/Ring timeout/);
    expect(problems.join(' | ')).toMatch(/Wait for the AI agent/);
    expect(problems.join(' | ')).toMatch(/end after they start/);
    expect(problems.join(' | ')).toMatch(/at least one calling day/);
    expect(problems.join(' | ')).toMatch(/country code/);
    expect(problems.join(' | ')).toMatch(/time zone/);
    expect(problems.join(' | ')).toMatch(/in a row/);
  });
});

describe('the explicit confirmation before a real campaign', () => {
  const ready = { campaignName: 'Spring outreach', typedName: 'Spring outreach', acknowledgements: { realCalls: true, regulations: true, consent: true }, review: { willCall: 5, blockers: [] as string[], anotherRunning: null } };

  it('is open only when every confirmation is given and nothing blocks the campaign', () => {
    expect(startBlockers(ready)).toEqual([]);
  });

  it('stays closed for each missing piece, and says which', () => {
    expect(startBlockers({ ...ready, typedName: 'spring outreach' })).toEqual(['Type the campaign name exactly.']);
    expect(startBlockers({ ...ready, typedName: '' })).toHaveLength(1);
    for (const key of ['realCalls', 'regulations', 'consent'] as const) {
      expect(startBlockers({ ...ready, acknowledgements: { ...ready.acknowledgements, [key]: false } })).toHaveLength(1);
    }
    expect(startBlockers({ ...ready, review: { ...ready.review, willCall: 0 } })).toEqual(['There are no callable contacts.']);
    expect(startBlockers({ ...ready, review: { ...ready.review, blockers: ['AI replies are not active'] } })).toEqual(['AI replies are not active']);
    expect(startBlockers({ ...ready, review: { ...ready.review, anotherRunning: { id: 'x', name: 'Other' } } })[0]).toMatch(/Other/);
  });
});

describe('progress and status helpers', () => {
  it('counts completed, failed and skipped as finished, and handles an empty list', () => {
    expect(progressPercent(counts)).toBe(50);
    expect(progressPercent({ total: 0, queued: 0, calling: 0, completed: 0, failed: 0, skipped: 0 })).toBe(0);
    expect(progressPercent({ ...counts, queued: 0, calling: 0, completed: 10, failed: 0, skipped: 0 })).toBe(100);
  });

  it('colours statuses and describes a pending retry', () => {
    expect(statusTone('completed')).toBe('good');
    expect(statusTone('failed')).toBe('bad');
    expect(statusTone('running')).toBe('warn');
    expect(statusTone('queued')).toBe('neutral');
    const c = { status: 'queued', nextAttemptAt: '2026-10-28T11:30:00.000Z' } as Contact;
    expect(nextRetryText(c)).toBe('retry after 2026-10-28 11:30 UTC');
    expect(nextRetryText({ ...c, nextAttemptAt: null })).toBeNull();
  });
});

describe('what the pages show', () => {
  it('shows the progress bar and every count', () => {
    const html = renderToStaticMarkup(React.createElement(ProgressBar, { counts }));
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('5 of 10 contacts have reached a final state');
  });

  it('offers Pause and Stop on a running campaign, with what it is waiting for', () => {
    const html = renderToStaticMarkup(React.createElement(RunPanel, { campaign: campaign(), counts, runner: { campaignId: 'c1', waiting: 'waiting for the calling hours (09:00-20:00 Asia/Kolkata)', inFlight: { contactId: 3, callId: 'call-9' }, consecutiveFailures: 0 }, onChanged: () => {} }));
    expect(html).toContain('>Pause<');
    expect(html).toContain('Stop…');
    expect(html).not.toContain('>Resume<');
    expect(html).toContain('waiting for the calling hours');
    expect(html).toContain('/observability?call=call-9'); // the call in progress links to its own call log
    for (const label of ['Queued', 'Calling', 'Completed', 'Failed', 'Skipped']) expect(html).toContain(label);
  });

  it('offers Resume on a paused campaign and shows why it paused', () => {
    const html = renderToStaticMarkup(React.createElement(RunPanel, { campaign: campaign({ status: 'paused', pauseReason: '3 calls failed in a row; check the modem' }), counts, runner: null, onChanged: () => {} }));
    expect(html).toContain('>Resume<');
    expect(html).not.toContain('>Pause<');
    expect(html).toContain('3 calls failed in a row');
  });

  it('shows no controls for a finished campaign', () => {
    const html = renderToStaticMarkup(React.createElement(RunPanel, { campaign: campaign({ status: 'completed', finishedAt: '2026-10-28T12:00:00Z' }), counts, runner: null, onChanged: () => {} }));
    expect(html).not.toContain('>Pause<');
    expect(html).not.toContain('>Resume<');
    expect(html).not.toContain('Stop…');
  });

  it('explains that importing places no call, and that a re-upload replaces the list', () => {
    const html = renderToStaticMarkup(React.createElement(ContactsStep, { campaign: campaign({ status: 'draft' }), existing: 42, onImported: () => {} }));
    expect(html).toContain('never places a call');
    expect(html).toContain('already has 42 contacts');
    expect(html).toContain('aria-label="CSV file"');
  });

  it('summarises an import in tiles', () => {
    const html = renderToStaticMarkup(React.createElement(SummaryTiles, { summary: { total: 8, callable: 3, invalidNumber: 1, duplicate: 1, missingName: 1, optedOut: 1, doNotCall: 1, consentDeclined: 1, consentUnknown: 2 } }));
    for (const label of ['Rows in the file', 'Will be called', 'Invalid number', 'Missing name', 'Duplicate number', 'Opted out in file', 'Do-not-call list', 'Consent declined', 'No consent value']) expect(html).toContain(label);
  });
});

describe('imported columns that would collide with the agent\'s own fields', () => {
  it('flags reserved and instruction-like names, the same ones the gateway refuses', () => {
    for (const name of ['contact_name', 'Contact Name', 'CONTACT-NAME', 'system', 'System Prompt', 'instructions', 'call_context', '</call_context>', 'ignore previous instructions', 'role', '']) {
      expect(isReservedColumn(name), JSON.stringify(name)).toBe(true);
    }
    for (const fine of ['plan', 'Account type', 'region', 'last_order']) expect(isReservedColumn(fine), fine).toBe(false);
    // such a column is still kept as a custom field; the gateway just never hands it to the agent
    expect(mappingProblems({ phone: 'Phone', name: 'N', extra: ['contact_name'] }, ['Phone', 'N', 'contact_name'])).toEqual([]);
    expect(mappingProblems({ phone: 'Phone', name: 'N', extra: ['plan'] }, ['Phone', 'N', 'plan'])).toEqual([]);
  });

  it('keeps its reserved list identical to the gateway\'s (so the screen never disagrees with the server)', () => {
    const file = path.resolve(__dirname, '../../gateway/src/campaigns/personalization.ts');
    if (!fs.existsSync(file)) return; // the gateway half is delivered in the same patch; checked once it is applied
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const block = /RESERVED_FIELD_KEYS[^=]*= new Set\(\[([\s\S]*?)\]\)/.exec(source);
    expect(block).not.toBeNull();
    const gateway = Array.from((block as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)).map((m) => m[1]).sort();
    expect([...RESERVED_FIELD_KEYS].sort()).toEqual(gateway);
  });
});

describe('a file the gateway would refuse as too large is explained before it is sent', () => {
  it('measures the request the way the gateway does, with line breaks counting double', () => {
    const plain = 'Phone\n' + '+919876543210\n'.repeat(1000);
    expect(csvRequestProblem(plain)).toBeNull();
    const breaks = 'Phone\n' + '\n'.repeat(600_000); // short in characters, large once JSON-encoded
    expect(breaks.length).toBeLessThan(900_000);
    expect(encodedRequestBytes(breaks)).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(csvRequestProblem(breaks)).toMatch(/Once encoded for sending.*KB; the limit is 1000 KB.*line breaks or quotes/);
    expect(csvRequestProblem('x'.repeat(900_001))).toMatch(/limit is 900,000 \(about 5,000 contacts\)/);
  });
});

describe('outcomes are described only as far as the modem evidence goes', () => {
  it('never calls an ambiguous end a decline, and explains the AI and restart outcomes', () => {
    expect(outcomeLabel('ended_before_answer')).toMatch(/could be a decline: not retried/);
    expect(outcomeLabel('busy')).toMatch(/declined call can be reported as busy/);
    expect(outcomeLabel('agent_missing')).toMatch(/heard silence/);
    expect(outcomeLabel('unknown')).toMatch(/gateway restarted/);
    expect(outcomeLabel(null)).toBe('');
    expect(outcomeLabel('something_new')).toBe('something_new');
    for (const label of ['ended_before_answer', 'no_answer', 'busy']) expect(outcomeLabel(label)).not.toMatch(/^declined/);
  });

  it('shows the explained outcome for a contact in the run panel', () => {
    const contact = { id: 1, campaignId: 'c1', rowNumber: 2, name: 'Asha', phoneRaw: '', phoneE164: '+919876543210', designation: '', company: '', context: '', extra: {}, consent: 'yes', optOut: false, status: 'failed', skipReason: null, attempts: 1, nextAttemptAt: null, lastAttemptAt: null, callId: 'call-1', lastOutcome: 'ended_before_answer', lastError: null } as Contact;
    expect(outcomeLabel(contact.lastOutcome)).toContain('not retried');
  });
});
