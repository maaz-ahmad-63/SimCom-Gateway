import { z } from 'zod';

/** A Google spreadsheet ID: the long token in its URL between /d/ and /edit. */
export const SpreadsheetIdSchemaPart = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{20,100}$/, 'spreadsheetId must be the ID from the sheet URL (the part between /d/ and /edit), not the whole link');
