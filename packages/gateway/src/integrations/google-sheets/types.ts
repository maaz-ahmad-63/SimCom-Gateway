/** What the operator configures. The credential is stored separately and encrypted; it is never part of this. */
export interface SheetsConfig {
  /** Master switch. Off: no tool is offered to the model and nothing is ever written. */
  enabled: boolean;
  spreadsheetId: string;
  /** The tab (worksheet) that records go to. */
  sheetName: string;
  /** The save-contact tool is offered on inbound calls. */
  inboundTools: boolean;
  /** The save-contact tool is offered on outbound (campaign) calls. */
  outboundTools: boolean;
  /** Each finished campaign call writes one outcome row. */
  logOutcomes: boolean;
}

export const DEFAULT_SHEETS_CONFIG: SheetsConfig = {
  enabled: false,
  spreadsheetId: '',
  sheetName: 'Calls',
  inboundTools: true,
  outboundTools: true,
  logOutcomes: false,
};

/** The columns, in order. The first row of the tab is written with these on first use, and must match them afterwards. */
export const SHEET_COLUMNS = ['record_key', 'recorded_at', 'type', 'call_id', 'campaign_id', 'contact_id', 'direction', 'name', 'phone', 'email', 'outcome', 'detail'] as const;

export type SheetRecordType = 'contact' | 'outcome';

/** One row. Absent details are null and written as empty cells: nothing is ever filled in. */
export interface SheetRecord {
  /** Identifies the record: saving the same key again corrects that row instead of adding another. */
  key: string;
  type: SheetRecordType;
  recordedAt: string;
  callId: string;
  campaignId: string | null;
  contactId: number | null;
  direction: 'inbound' | 'outbound';
  name: string | null;
  phone: string | null;
  email: string | null;
  outcome: string | null;
  detail: string | null;
}

/** `ok: true` only when Google's own response confirmed the row was written (or was already exactly this). */
export type SaveResult =
  | { ok: true; status: 'created' | 'updated' | 'unchanged'; row: number }
  | { ok: false; code: string; message: string };

export interface SheetsTestStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SheetsTestResult {
  ok: boolean;
  at: string;
  steps: SheetsTestStep[];
  /** What to do next, when the test failed. */
  advice: string | null;
}

/** What the dashboard may see. No private key, no token: the service account's email is not a secret and is what the sheet is shared with. */
export interface SheetsStatus {
  config: SheetsConfig;
  credential: { stored: boolean; serviceAccountEmail: string | null; undecryptable: boolean };
  secretStorageAvailable: boolean;
  lastTest: SheetsTestResult | null;
  columns: readonly string[];
}

export class SheetsError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'SheetsError';
  }
}
