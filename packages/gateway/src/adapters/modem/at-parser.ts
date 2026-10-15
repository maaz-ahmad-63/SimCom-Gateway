import {
  ModemDeviceInfo,
  ModemNetworkStatus,
  ModemSignalQuality,
  NetworkRegistrationStatus,
  SimPinStatus,
  ClipUrcEvent,
  CallEndUrcEvent,
  UrcEvent,
} from '@sim-gateway/shared';

export interface TerminalStatus {
  isTerminal: boolean;
  isSuccess: boolean;
  status: 'OK' | 'ERROR' | 'BUSY' | 'NO_CARRIER' | 'NO_DIALTONE' | 'NO_ANSWER' | null;
  errorMessage?: string;
}

export class AtParser {
  /**
   * Determine if a trimmed line is a final terminal response for an AT command.
   * Note: Call progress codes (BUSY, NO CARRIER, etc.) are ONLY terminal responses
   * for call control commands (ATD, ATA, ATH, AT+CHUP). For general commands (AT+CSQ,
   * AT+COPS?, etc.), they are cellular network events/URCs, NOT command terminations.
   */
  static isTerminalResponse(line: string, command?: string): TerminalStatus {
    const trimmed = line.trim();

    if (trimmed === 'OK') {
      return { isTerminal: true, isSuccess: true, status: 'OK' };
    }

    if (trimmed === 'ERROR') {
      return { isTerminal: true, isSuccess: false, status: 'ERROR', errorMessage: 'AT ERROR' };
    }

    if (trimmed.startsWith('+CME ERROR:')) {
      const msg = trimmed.substring('+CME ERROR:'.length).trim();
      return { isTerminal: true, isSuccess: false, status: 'ERROR', errorMessage: `CME ERROR: ${msg}` };
    }

    if (trimmed.startsWith('+CMS ERROR:')) {
      const msg = trimmed.substring('+CMS ERROR:'.length).trim();
      return { isTerminal: true, isSuccess: false, status: 'ERROR', errorMessage: `CMS ERROR: ${msg}` };
    }

    // Call progress codes are ONLY terminal for call control commands
    const isCallControl =
      command &&
      (command.startsWith('ATD') ||
        command === 'ATA' ||
        command === 'ATH' ||
        command.startsWith('AT+CHUP'));

    if (isCallControl) {
      if (trimmed === 'BUSY') {
        return { isTerminal: true, isSuccess: false, status: 'BUSY', errorMessage: 'Line Busy' };
      }

      if (trimmed === 'NO CARRIER') {
        return { isTerminal: true, isSuccess: false, status: 'NO_CARRIER', errorMessage: 'No Carrier' };
      }

      if (trimmed === 'NO DIALTONE') {
        return { isTerminal: true, isSuccess: false, status: 'NO_DIALTONE', errorMessage: 'No Dialtone' };
      }

      if (trimmed === 'NO ANSWER') {
        return { isTerminal: true, isSuccess: false, status: 'NO_ANSWER', errorMessage: 'No Answer' };
      }
    }

    return { isTerminal: false, isSuccess: false, status: null };
  }

  /**
   * Identifies whether an incoming line is an Unsolicited Result Code (URC).
   */
  static isUrc(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed === 'RING' || trimmed.startsWith('+CRING:')) return true;
    if (trimmed.startsWith('+CLIP:')) return true;
    if (trimmed === 'VOICE CALL: BEGIN') return true;
    if (trimmed.startsWith('VOICE CALL: END')) return true;
    if (trimmed === 'NO CARRIER') return true;
    if (trimmed === 'BUSY') return true;
    if (trimmed === 'ALERTING') return true;
    if (trimmed.startsWith('+CEREG:') && !trimmed.includes('?')) return true;
    if (trimmed.startsWith('+CREG:') && !trimmed.includes('?')) return true;
    return false;
  }

  /**
   * Parse a raw URC line into a typed UrcEvent object.
   */
  static parseUrc(line: string): UrcEvent | null {
    const trimmed = line.trim();

    // 1. RING / CRING
    if (trimmed === 'RING' || trimmed.startsWith('+CRING:')) {
      return {
        raw: trimmed,
        type: 'RING',
        timestamp: new Date().toISOString(),
        isSimulated: false,
      };
    }

    // 2. Caller Line Identification (+CLIP: "+919876543210",145,,,,0)
    if (trimmed.startsWith('+CLIP:')) {
      const parsed = AtParser.parseClip(trimmed);
      if (parsed) {
        const clipEvent: ClipUrcEvent = {
          raw: trimmed,
          type: 'CLIP',
          phoneNumber: parsed.phoneNumber,
          typeOfAddress: parsed.typeOfAddress,
          timestamp: new Date().toISOString(),
          isSimulated: false,
        };
        return clipEvent;
      }
    }

    // 3. Voice Call Begin (SIM7600 standard)
    if (trimmed === 'VOICE CALL: BEGIN') {
      return {
        raw: trimmed,
        type: 'VOICE_CALL_BEGIN',
        timestamp: new Date().toISOString(),
        isSimulated: false,
      };
    }

    // 4. Voice Call End (SIM7600 standard, e.g. "VOICE CALL: END: 15")
    if (trimmed.startsWith('VOICE CALL: END')) {
      const parsed = AtParser.parseVoiceCallEnd(trimmed);
      const callEndEvent: CallEndUrcEvent = {
        raw: trimmed,
        type: 'VOICE_CALL_END',
        durationSeconds: parsed?.durationSeconds,
        timestamp: new Date().toISOString(),
        isSimulated: false,
      };
      return callEndEvent;
    }

    // 5. NO CARRIER
    if (trimmed === 'NO CARRIER') {
      return {
        raw: trimmed,
        type: 'NO_CARRIER',
        timestamp: new Date().toISOString(),
        isSimulated: false,
      };
    }

    // 6. BUSY
    if (trimmed === 'BUSY') {
      return {
        raw: trimmed,
        type: 'BUSY',
        timestamp: new Date().toISOString(),
        isSimulated: false,
      };
    }

    // 7. ALERTING
    if (trimmed === 'ALERTING') {
      return {
        raw: trimmed,
        type: 'CUSTOM',
        payload: { status: 'alerting' },
        timestamp: new Date().toISOString(),
        isSimulated: false,
      };
    }

    // 8. CEREG/CREG registration update
    if (trimmed.startsWith('+CEREG:') || trimmed.startsWith('+CREG:')) {
      const status = AtParser.parseCregOrCereg(trimmed);
      return {
        raw: trimmed,
        type: 'REGISTRATION_UPDATE',
        payload: { status },
        timestamp: new Date().toISOString(),
        isSimulated: false,
      };
    }

    return null;
  }

  /**
   * Parse caller ID from "+CLIP: "+919876543210",145..."
   */
  static parseClip(line: string): { phoneNumber: string; typeOfAddress: number } | null {
    const match = line.match(/\+CLIP:\s*"([^"]+)",(\d+)/i);
    if (!match) return null;
    return {
      phoneNumber: match[1],
      typeOfAddress: parseInt(match[2], 10),
    };
  }

  /**
   * Parse call end duration from "VOICE CALL: END: 24"
   */
  static parseVoiceCallEnd(line: string): { durationSeconds?: number } | null {
    const match = line.match(/VOICE CALL:\s*END(?::\s*(\d+))?/i);
    if (!match) return null;
    return {
      durationSeconds: match[1] ? parseInt(match[1], 10) : undefined,
    };
  }

  /**
   * Parse signal quality response: "+CSQ: 24,99"
   */
  static parseCsq(response: string): ModemSignalQuality {
    const match = response.match(/\+CSQ:\s*(\d+),(\d+)/i);
    const rssi = match ? parseInt(match[1], 10) : 99;
    const ber = match ? parseInt(match[2], 10) : 99;

    const dBm = rssi === 99 ? null : -113 + rssi * 2;
    const bars = rssi === 99 ? 0 : Math.min(5, Math.max(0, Math.round((rssi / 31) * 5)));

    return {
      rssi,
      ber,
      dBm,
      bars,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Parse SIM PIN status: "+CPIN: READY"
   */
  static parseCpin(response: string): SimPinStatus {
    const match = response.match(/\+CPIN:\s*([^\r\n]+)/i);
    if (!match) {
      if (response.includes('ERROR') || response.includes('+CME ERROR')) {
        return 'ERROR';
      }
      return 'UNKNOWN';
    }

    const status = match[1].trim().toUpperCase();
    if (status === 'READY') return 'READY';
    if (status.includes('SIM PIN')) return 'SIM_PIN';
    if (status.includes('SIM PUK')) return 'SIM_PUK';
    return 'UNKNOWN';
  }

  /**
   * Parse Network Registration status (+CEREG? or +CREG?)
   * Examples:
   * "+CEREG: 0,1" -> stat=1 (HOME)
   * "+CEREG: 2,1,"1A2B","01234567",7" -> stat=1 (HOME), LTE
   */
  static parseCregOrCereg(response: string): NetworkRegistrationStatus {
    const match = response.match(/\+(?:CE?REG):\s*(?:\d+,)?(\d+)/i);
    if (!match) return 'UNKNOWN';

    const stat = parseInt(match[1], 10);
    switch (stat) {
      case 0:
        return 'NOT_REGISTERED';
      case 1:
        return 'REGISTERED_HOME';
      case 2:
        return 'SEARCHING';
      case 3:
        return 'REGISTRATION_DENIED';
      case 4:
        return 'UNKNOWN';
      case 5:
        return 'REGISTERED_ROAMING';
      default:
        return 'UNKNOWN';
    }
  }

  /**
   * Parse Operator response: "+COPS: 0,0,"Vi India",7"
   * Access technologies:
   * 0 = GSM, 2 = UTRAN (3G), 7 = E-UTRAN (LTE)
   */
  static parseCops(response: string): {
    operatorName: string | null;
    accessTechnology: 'GSM' | 'UMTS' | 'LTE' | 'UNKNOWN';
  } {
    const match = response.match(/(?:\+COPS:\s*\d+,\d+,)?\s*"([^"]+)"(?:,(\d+))?/i);
    if (!match) {
      return { operatorName: null, accessTechnology: 'UNKNOWN' };
    }

    const rawOperator = match[1].trim();
    // Normalize repeated carrier labels (e.g. "Vi India Vi India" -> "Vi India")
    const operatorName = rawOperator.replace(/^(.+)\s+\1$/, '$1');
    const actCode = match[2] ? parseInt(match[2], 10) : null;

    let accessTechnology: 'GSM' | 'UMTS' | 'LTE' | 'UNKNOWN' = 'UNKNOWN';
    if (actCode === 7) {
      accessTechnology = 'LTE';
    } else if (actCode === 2) {
      accessTechnology = 'UMTS';
    } else if (actCode === 0) {
      accessTechnology = 'GSM';
    }

    return { operatorName, accessTechnology };
  }

  /**
   * Parse device identification info from ATI or AT+CGMI/MM/MR responses
   */
  static parseDeviceInfo(
    atiResponse: string,
    imeiResponse?: string,
    imsiResponse?: string
  ): ModemDeviceInfo {
    let manufacturer = 'SIMCOM';
    let model = 'SIMCOM_SIM7600EI';
    let firmwareRevision = 'SIM7600M21-A_V1.1';

    const mfgMatch = atiResponse.match(/Manufacturer:\s*([^\r\n]+)/i);
    if (mfgMatch) manufacturer = mfgMatch[1].trim();

    const modelMatch = atiResponse.match(/Model:\s*([^\r\n]+)/i);
    if (modelMatch) model = modelMatch[1].trim();

    const revMatch = atiResponse.match(/Revision:\s*([^\r\n]+)/i);
    if (revMatch) firmwareRevision = revMatch[1].trim();

    // Clean up IMEI/IMSI if provided
    const imei = imeiResponse ? imeiResponse.replace(/[\r\n\sOK]/g, '').trim() : undefined;
    const imsi = imsiResponse ? imsiResponse.replace(/[\r\n\sOK]/g, '').trim() : undefined;

    return {
      manufacturer,
      model,
      firmwareRevision,
      imei: imei && imei.length >= 14 ? imei : undefined,
      imsi: imsi && imsi.length >= 14 ? imsi : undefined,
      isSimulated: false,
    };
  }
}
