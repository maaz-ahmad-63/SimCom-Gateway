/**
 * +CMS ERROR codes (3GPP TS 27.005, section 3.2.5). The SIM7600 AT manual lists the same numbers; this table is the
 * standard one and has NOT been compared line by line with SIMCom's manual for this firmware. The gateway sets
 * AT+CMEE=2 at start-up, so the modem normally reports the text, not the number; both forms are understood.
 */
export const CMS_ERRORS: Readonly<Record<number, string>> = {
  300: 'ME failure',
  301: 'SMS service of ME reserved',
  302: 'operation not allowed',
  303: 'operation not supported',
  304: 'invalid PDU mode parameter',
  305: 'invalid text mode parameter',
  310: 'SIM not inserted',
  311: 'SIM PIN required',
  312: 'PH-SIM PIN required',
  313: 'SIM failure',
  314: 'SIM busy',
  315: 'SIM wrong',
  316: 'SIM PUK required',
  317: 'SIM PIN2 required',
  318: 'SIM PUK2 required',
  320: 'memory failure',
  321: 'invalid memory index',
  322: 'memory full',
  330: 'SMSC address unknown',
  331: 'no network service',
  332: 'network timeout',
  340: 'no +CNMA acknowledgement expected',
  500: 'unknown error',
};

export interface CmsError {
  code: number | null;
  text: string;
}

/** "CMS ERROR: 305", "CMS ERROR: Invalid text mode parameter" or a message that contains either. Null when it is not a CMS error. */
export function parseCmsError(message: string): CmsError | null {
  const match = /CMS ERROR:\s*(.*)$/im.exec(message);
  if (!match) return null;
  const detail = match[1].trim();
  const numeric = /^\d+$/.test(detail) ? Number(detail) : null;
  if (numeric !== null) return { code: numeric, text: CMS_ERRORS[numeric] ?? 'unrecognised error code' };
  const lower = detail.toLowerCase();
  const found = Object.entries(CMS_ERRORS).find(([, text]) => text.toLowerCase() === lower);
  return { code: found ? Number(found[0]) : null, text: detail || 'unknown error' };
}

/** What to look at for the common failures. These are pointers for the operator; nothing here changes the modem. */
export function cmsHint(code: number | null): string | null {
  switch (code) {
    case 305:
      return (
        'The modem rejected the text-mode parameters. In text mode the message is built from AT+CSMP? (first octet, validity period, ' +
        'protocol id, data coding scheme), AT+CSCS? (character set) and AT+CSCA? (service centre). An inconsistent AT+CSMP? ' +
        '(for example a validity period that does not match the format flags, or a reserved data coding scheme) is the usual cause. ' +
        'GET /api/gateway/sms/status shows all of them. The gateway did not change any of them and did not retry.'
      );
    case 304:
      return 'The modem is not in text mode (AT+CMGF=1) or rejected the message format.';
    case 330:
      return 'The modem does not know the SMS service centre number. Check AT+CSCA? (GET /api/gateway/sms/status); the number is carrier-specific and is not set automatically.';
    case 331:
      return 'No network service. Check signal and registration (GET /api/gateway/hardware/modem-info).';
    case 332:
      return 'The network timed out. The message may or may not have been sent; do not retry blindly.';
    case 311:
    case 312:
    case 316:
      return 'The SIM needs a PIN or PUK.';
    case 313:
    case 314:
    case 315:
    case 310:
      return 'SIM problem (not inserted, failed, busy or wrong).';
    case 320:
    case 322:
      return 'SMS storage problem (memory failure or full).';
    case 321:
      return 'There is no message at that index in the current storage (AT+CPMS?).';
    case 302:
      return 'The modem refused the operation in its current state.';
    default:
      return null;
  }
}
