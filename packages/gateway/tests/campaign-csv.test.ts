import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCampaignsRouter } from '../src/api/routes/campaigns.js';
import { parseCsv } from '../src/campaigns/csv.js';
import { detectColumns, isUsableName, looksLikePhone } from '../src/campaigns/detect.js';
import { analyzeRows, validateMapping } from '../src/campaigns/import.js';
import { makeHarness } from './campaign-harness.js';

/**
 * Flexible CSV import. Only a contact name and a phone number are required; every other column is kept as that contact's custom
 * fields, whatever the customer called it and in whatever order. The detection is only ever a suggestion: when it is not sure, the
 * person is asked.
 */

const SETTINGS = { defaultCountryCode: '91', consentMode: 'attested' as const };
const detect = (csv: string) => {
  const parsed = parseCsv(csv);
  return { parsed, ...detectColumns(parsed.headers, parsed.rows) };
};
const importAll = (csv: string, mapping: Parameters<typeof analyzeRows>[1]) => analyzeRows(parseCsv(csv), mapping, SETTINGS, () => false);

describe('different customers, different files: the four example layouts', () => {
  const FILES = {
    A: { csv: 'Name,Phone,Hospital\nRahul Sharma,9876543210,Apollo Hospital', name: 'Name', phone: 'Phone', custom: { Hospital: 'Apollo Hospital' } },
    B: { csv: 'Full Name,Mobile Number,City,Department,Notes\nRahul Sharma,9876543210,Delhi,Cardiology,Interested in appointment automation', name: 'Full Name', phone: 'Mobile Number', custom: { City: 'Delhi', Department: 'Cardiology' } },
    C: { csv: 'Contact Name,Contact Number,Company,Requirement,Custom Field 1\nRahul Sharma,9876543210,Apollo,Scheduling,Priority', name: 'Contact Name', phone: 'Contact Number', custom: { Requirement: 'Scheduling', 'Custom Field 1': 'Priority' } },
    D: { csv: 'Hospital Name,Telephone,Location,Speciality,Website\nApollo Hospital,9876543210,Delhi,Cardiology,apollo.example', name: 'Hospital Name', phone: 'Telephone', custom: { Location: 'Delhi', Speciality: 'Cardiology', Website: 'apollo.example' } },
  };

  for (const [label, f] of Object.entries(FILES)) {
    it(`CSV ${label}: finds the name and phone columns by itself, and keeps every other column as custom fields`, () => {
      const d = detect(f.csv);
      expect(d.mapping).toMatchObject({ name: f.name, phone: f.phone });
      expect(d.ambiguous).toBe(false); // no question to ask: the person can import straight away
      const result = analyzeRows(d.parsed, d.mapping as never, SETTINGS, () => false);
      expect(result.summary).toMatchObject({ total: 1, callable: 1, invalidNumber: 0, missingName: 0 });
      const row = result.rows[0];
      expect(row).toMatchObject({ status: 'queued', phoneE164: '+919876543210' });
      expect(row.extra).toMatchObject(f.custom);
    });
  }

  it('keeps the notes column as the contact\'s notes (so the agent sees it), and the rest as named custom fields', () => {
    const d = detect(FILES.B.csv);
    const row = analyzeRows(d.parsed, d.mapping as never, SETTINGS, () => false).rows[0];
    expect(row.context).toBe('Interested in appointment automation');
    expect(Object.keys(row.extra).sort()).toEqual(['City', 'Department']);
  });
});

describe('column order, extra columns and gaps do not matter', () => {
  it('finds the same columns whatever their order', () => {
    const a = detect('Notes,Mobile,Region,Full Name,Plan\nn,9876543210,r,Asha,Gold');
    const b = detect('Plan,Full Name,Region,Mobile,Notes\nGold,Asha,r,9876543210,n');
    expect(a.mapping).toMatchObject({ name: 'Full Name', phone: 'Mobile' });
    expect(b.mapping).toMatchObject({ name: 'Full Name', phone: 'Mobile' });
  });

  it('keeps every unrecognised column, drops empty optional values, and never invents a field', () => {
    const csv = ['Name,Phone,Spec,Budget,Website,Rank', 'Asha,9876543210,Cardiology,,https://a.example,1', 'Bo,9123456789,,50k,,'].join('\n');
    const d = detect(csv);
    const rows = analyzeRows(d.parsed, d.mapping as never, SETTINGS, () => false).rows;
    expect(rows[0].extra).toEqual({ Spec: 'Cardiology', Website: 'https://a.example', Rank: '1' }); // the empty Budget is simply absent
    expect(rows[1].extra).toEqual({ Budget: '50k' });
    expect(rows.every((r) => r.status === 'queued')).toBe(true); // empty optional values are not a reason to reject a contact
  });

  it('handles a file with many columns, quoted values with commas, and a semicolon separator', () => {
    const wide = `Name,Phone,${Array.from({ length: 25 }, (_, i) => `Extra ${i + 1}`).join(',')}\n"Verma, Asha",9876543210,${Array.from({ length: 25 }, (_, i) => `v${i + 1}`).join(',')}`;
    const r = importAll(wide, { phone: 'Phone', name: 'Name' });
    expect(r.rows[0].name).toBe('Verma, Asha');
    expect(Object.keys(r.rows[0].extra)).toHaveLength(25);
    expect(r.customColumns).toHaveLength(25);
    const semi = detect('Name;Phone;City\nAsha;9876543210;Pune');
    expect(semi.mapping).toMatchObject({ name: 'Name', phone: 'Phone' });
  });

  it('stores what the agent should be told as the contact\'s own fields, not as columns of the database', () => {
    const r = importAll('Name,Phone,Anything You Like\nAsha,9876543210,some value', { phone: 'Phone', name: 'Name' });
    expect(r.rows[0].extra).toEqual({ 'Anything You Like': 'some value' });
  });
});

describe('rows without a usable name or phone are rejected, with the reason', () => {
  it('sets aside a row with no name, a placeholder name, or no usable phone, and says which', () => {
    const csv = ['Name,Phone', 'Asha,9876543210', ',9123456789', 'N/A,9988776655', '---,9811122233', 'Bo,', 'Cy,12', 'Di,abc'].join('\n');
    const r = importAll(csv, { phone: 'Phone', name: 'Name' });
    expect(r.summary).toMatchObject({ total: 7, callable: 1, missingName: 3, invalidNumber: 3 });
    const byRow = Object.fromEntries(r.rows.map((x) => [x.rowNumber, x.skipReason]));
    expect(byRow[3]).toBe('missing contact name');
    expect(byRow[4]).toBe('missing contact name');
    expect(byRow[5]).toBe('missing contact name');
    expect(byRow[6]).toMatch(/phone number is empty/);
    expect(byRow[7]).toMatch(/too short|not a valid/);
    expect(byRow[8]).toMatch(/characters other than digits/);
    expect(r.rows.filter((x) => x.status === 'queued').map((x) => x.name)).toEqual(['Asha']);
  });

  it('a row with no name does not claim its number, so a later good row with that number is not called a duplicate', () => {
    const r = importAll('Name,Phone\n,9876543210\nAsha,9876543210', { phone: 'Phone', name: 'Name' });
    expect(r.rows.map((x) => [x.name, x.status])).toEqual([['', 'skipped'], ['Asha', 'queued']]);
  });

  it('the mapping needs both a name and a phone column', () => {
    expect(validateMapping(['Name', 'Phone'], { phone: 'Phone' }).join(' ')).toMatch(/contact name/);
    expect(validateMapping(['Name', 'Phone'], { name: 'Name' }).join(' ')).toMatch(/phone number/);
    expect(validateMapping(['Name', 'Phone'], { phone: 'Phone', name: 'Name' })).toEqual([]);
    expect(isUsableName('Dr. Asha')).toBe(true);
    expect(isUsableName('Apollo 24x7')).toBe(true);
    expect(isUsableName('N/A')).toBe(false);
  });
});

describe('ambiguous files ask the person; they are never silently guessed', () => {
  it('two columns that could both be the name: ambiguous, with the candidates', () => {
    const d = detect('Name,Full Name,Phone\nA,Asha Verma,9876543210');
    expect(d.name.ambiguous).toBe(true);
    expect([d.name.column, ...d.name.candidates].sort()).toEqual(['Full Name', 'Name']);
    expect(d.ambiguous).toBe(true);
  });

  it('two phone columns that could both be it (Phone and Mobile): ambiguous', () => {
    const d = detect('Name,Phone,Mobile\nAsha,9876543210,9123456789');
    expect(d.phone.ambiguous).toBe(true);
    expect([d.phone.column, ...d.phone.candidates].sort()).toEqual(['Mobile', 'Phone']);
  });

  it('a primary phone plus alternate/office/fax columns is NOT ambiguous: the primary wins', () => {
    const d = detect('Name,Phone,Alt Phone,Office Phone,Fax\nAsha,9876543210,9123456789,02012345678,02098765432');
    expect(d.phone).toMatchObject({ column: 'Phone', ambiguous: false });
  });

  it('no column that looks like a name: nothing is chosen for the person, and it asks', () => {
    const d = detect('Phone,Code\n9876543210,1234');
    expect(d.name).toMatchObject({ column: null, ambiguous: true, confidence: 'none' });
    expect(d.ambiguous).toBe(true);
  });

  it('no header says phone, but one column is full of numbers: it is found by its values', () => {
    const d = detect('Who,Reach me\nAsha Verma,+91 98765 43210\nBo Lee,+1 415 555 0132\nCy Ng,+44 20 7123 4567');
    expect(d.phone).toMatchObject({ column: 'Reach me', basis: 'content', ambiguous: false });
    expect(d.name).toMatchObject({ column: 'Who', ambiguous: true }); // by its values only, so the person confirms it
  });

  it('a header that says phone over cells that are not numbers, with a real number column elsewhere: asks', () => {
    const d = detect('Name,Phone,Direct line\nAsha,call later,9876543210\nBo,n/a,9123456789\nCy,tbd,9988776655');
    expect(d.phone.ambiguous).toBe(true);
  });

  it('recognises phone-looking values only when they are', () => {
    for (const ok of ['9876543210', '+91 98765-43210', '(415) 555-0132', '="9876543210"', '+4915112345678']) expect(looksLikePhone(ok), ok).toBe(true);
    for (const no of ['', 'Delhi', '12', '1234567890123456', 'a@b.com', '12/05/2026 10:00']) expect(looksLikePhone(no), no).toBe(false);
  });
});

describe('the person can map the columns by hand', () => {
  it('imports with the mapping they chose, not the detected one', () => {
    const csv = 'Name,Full Name,Phone\nA,Asha Verma,9876543210';
    const chosen = importAll(csv, { phone: 'Phone', name: 'Full Name' });
    expect(chosen.rows[0].name).toBe('Asha Verma');
    expect(chosen.rows[0].extra).toEqual({ Name: 'A' }); // the column they did not choose is still kept
  });

  it('a mapping that names a column the file does not have, or uses one column twice, is refused', () => {
    expect(validateMapping(['Name', 'Phone'], { phone: 'Mobile', name: 'Name' }).join(' ')).toMatch(/not in the file/);
    expect(validateMapping(['Name', 'Phone'], { phone: 'Phone', name: 'Phone' }).join(' ')).toMatch(/only be used for one field/);
  });
});

describe('phone numbers: international ones are accepted, the original is kept, duplicates are set aside', () => {
  it('accepts valid international numbers from many countries and normalises them to E.164', () => {
    const csv = ['Name,Phone', 'In,9876543210', 'Us,+1 (415) 555-0132', 'Uk,+44 20 7123 4567', 'Ae,+971 50 123 4567', 'Sg,+65 9123 4567', 'De,+49 151 12345678', 'Jp,+81 90 1234 5678', 'Br,+55 11 91234 5678', 'Za,+27 82 123 4567', 'Oo,0044 20 7946 0958'].join('\n');
    const r = importAll(csv, { phone: 'Phone', name: 'Name' });
    expect(r.summary).toMatchObject({ total: 10, callable: 10, invalidNumber: 0 });
    expect(r.rows.map((x) => x.phoneE164)).toEqual(['+919876543210', '+14155550132', '+442071234567', '+971501234567', '+6591234567', '+4915112345678', '+819012345678', '+5511912345678', '+27821234567', '+442079460958']);
  });

  it('keeps the number exactly as written next to the normalised one', () => {
    const r = importAll('Name,Phone\nAsha,"  +91 98765-43210 "', { phone: 'Phone', name: 'Name' });
    expect(r.rows[0]).toMatchObject({ phoneRaw: '+91 98765-43210', phoneE164: '+919876543210' });
  });

  it('rejects a number that cannot be placed, with the reason, rather than dialling something else', () => {
    const r = importAll(['Name,Phone', 'A,+12', 'B,+0123456789', 'C,5555', 'D,+91 12345 67890', 'E,+91 98765 43210 ext 5'].join('\n'), { phone: 'Phone', name: 'Name' });
    expect(r.summary.invalidNumber).toBe(5);
    expect(r.summary.callable).toBe(0);
  });

  it('sets aside a second row with the same number, however it is written, and leaves the first row to be called', () => {
    const r = importAll(['Name,Phone', 'First,9876543210', 'Second,+91 98765 43210', 'Third,09876543210', 'Other,9123456789'].join('\n'), { phone: 'Phone', name: 'Name' });
    expect(r.summary).toMatchObject({ callable: 2, duplicate: 2 });
    expect(r.rows.filter((x) => x.status === 'queued').map((x) => x.name)).toEqual(['First', 'Other']);
    expect(r.rows[1].skipReason).toBe('duplicate of row 2');
  });

  it('lets the existing campaign rules handle duplicates and opted-out numbers safely: the database refuses a second live row for a number', () => {
    const h = makeHarness();
    const dup = analyzeRows(parseCsv('Name,Phone,Consent\nA,+919876543210,yes\nB,+919876543210,yes'), { phone: 'Phone', name: 'Name', consent: 'Consent' }, h.campaign.settings, () => false);
    expect(dup.rows.filter((x) => x.status === 'queued')).toHaveLength(1);
    expect(() => h.store.importContacts(h.campaign.id, dup.rows, { phone: 'Phone', name: 'Name' })).not.toThrow();
  });
});

describe('the preview over the API stores nothing and shows what an import would do', () => {
  const app = () => {
    const h = makeHarness();
    const a = express();
    a.use(express.json());
    a.use('/api/campaigns', createCampaignsRouter({ store: h.store, runner: h.runner, blockers: () => [], now: () => new Date(h.clock.now) }));
    return { h, a };
  };
  const CSV = ['Full Name,Mobile Number,City,Department,Consent', 'Asha Verma,+919876543210,Delhi,Cardiology,yes', ',+919123456789,Pune,ENT,yes', 'Cy,12345,Goa,,yes', 'Asha Again,+919876543210,Delhi,,yes'].join('\n');

  it('reports the detection, then (given a mapping) the valid, invalid and duplicate counts, the custom columns and the first contacts', async () => {
    const { h, a } = app();
    const before = h.store.counts(h.campaign.id).total;
    const first = await request(a).post('/api/campaigns/preview-csv').send({ csv: CSV, campaignId: h.campaign.id });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ambiguous: false, totalRows: 4, suggestedMapping: { name: 'Full Name', phone: 'Mobile Number', consent: 'Consent' } });
    expect(first.body.analysis).toBeUndefined(); // no mapping sent yet: only the detection

    const second = await request(a).post('/api/campaigns/preview-csv').send({ csv: CSV, campaignId: h.campaign.id, mapping: first.body.suggestedMapping });
    expect(second.body.analysis.summary).toMatchObject({ total: 4, callable: 1, missingName: 1, invalidNumber: 1, duplicate: 1 });
    expect(second.body.analysis.customColumns).toEqual(['City', 'Department']);
    expect(second.body.analysis.contacts[0]).toMatchObject({ name: 'Asha Verma', phoneE164: '+919876543210', status: 'queued', customFields: { City: 'Delhi', Department: 'Cardiology' } });
    expect(h.store.counts(h.campaign.id).total).toBe(before); // nothing was stored by looking
  });

  it('refuses a mapping that is not usable, naming what to fix, and still stores nothing', async () => {
    const { h, a } = app();
    const res = await request(a).post('/api/campaigns/preview-csv').send({ csv: CSV, mapping: { phone: 'Mobile Number' } });
    expect(res.body.mappingErrors.join(' ')).toMatch(/contact name/);
    expect(h.store.counts(h.campaign.id).total).toBe(5);
  });

  it('imports all other columns as custom fields without a column list, and the contact list shows them', async () => {
    const { h, a } = app();
    const draft = h.store.create('Fresh draft');
    const res = await request(a).post(`/api/campaigns/${draft.id}/import`).send({ csv: CSV, mapping: { phone: 'Mobile Number', name: 'Full Name', consent: 'Consent' } });
    expect(res.status).toBe(200);
    expect(res.body.customColumns).toEqual(['City', 'Department']);
    const list = (await request(a).get(`/api/campaigns/${draft.id}/contacts`)).body.items;
    const asha = list.find((c: { name: string }) => c.name === 'Asha Verma');
    expect(asha.extra).toEqual({ City: 'Delhi', Department: 'Cardiology' });
  });
});
