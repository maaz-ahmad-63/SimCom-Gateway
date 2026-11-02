/**
 * Finds the SIM7600EI's AT and USB-audio serial interfaces from what Windows reports about its serial ports. It opens no
 * port and sends nothing: listing ports (SerialPort.list) only reads the device registry.
 *
 * Windows renumbers COM ports when the modem re-enumerates, and the AT and audio numbers are not consecutive or even in order
 * (COM20 = AT and COM19 = audio has been seen on this PC). What stays the same is the USB identity of each interface:
 *
 *   pnpId  USB\VID_1E0E&PID_9001&MI_02\6&3A1B2C4D&0&0002
 *              vendor    product  ^interface  ^parent instance prefix (shared by every interface of one physical modem)
 *
 * So interfaces are grouped into physical modems by VID/PID plus the parent instance prefix, and each interface's role comes
 * from its interface number (MI_xx), cross-checked with the driver's port name when Windows provides one. A modem is used only
 * when its identity is unambiguous: with two modems and no selector, nothing is chosen.
 *
 * The result lists every modem found with its own interfaces. One gateway uses one of them today; a future coordinator can run
 * one driver, AT queue, audio session and SMS inbox per entry of `modems`.
 */

export const SIMCOM_VID = '1E0E';

export type PortRole = 'at' | 'audio' | 'diagnostics' | 'nmea' | 'modem' | 'unknown';

/**
 * The USB interface order of this SIM7600EI (VID_1E0E&PID_9001), observed on this PC and recorded in
 * docs/WINDOWS_HARDWARE_INTEGRATION.md. Other firmware or USB compositions may differ, which is why the port name is checked too.
 */
export const INTERFACE_ROLE: Record<string, { role: PortRole; basis: string }> = {
  MI_00: { role: 'diagnostics', basis: 'USB interface 00 (diagnostics on this module)' },
  MI_01: { role: 'nmea', basis: 'USB interface 01 (NMEA on this module)' },
  MI_02: { role: 'at', basis: 'USB interface 02 (AT port on this module, observed 2026-10-16)' },
  MI_03: { role: 'modem', basis: 'USB interface 03 (modem port on this module)' },
  MI_04: { role: 'audio', basis: 'USB interface 04 (USB audio, documented in docs/WINDOWS_HARDWARE_INTEGRATION.md)' },
};

/** What SerialPort.list() returns on Windows (fields other than `path` may be missing). */
export interface SerialInterfaceInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  friendlyName?: string;
  vendorId?: string;
  productId?: string;
}

export interface DiscoveredInterface {
  path: string;
  vendorId: string | null;
  productId: string | null;
  interface: string | null;
  role: PortRole;
  roleBasis: string;
  /** The parent device this interface belongs to (null when Windows gave no usable identity). */
  deviceKey: string | null;
  name: string | null;
}

export interface ModemCandidate {
  /** Stable while the modem stays on the same USB socket: VID:PID:parent-instance. Never a COM number. */
  id: string;
  vendorId: string;
  productId: string | null;
  at: string | null;
  audio: string | null;
  interfaces: DiscoveredInterface[];
  /** Why this modem cannot be used as it is (missing or duplicated interfaces). Empty when it can. */
  problems: string[];
}

/** USB\VID_1E0E&PID_9001&MI_02\6&3A1B2C4D&0&0002 -> vid, pid, interface and the parent device key. */
export function parsePnpId(pnpId: string | undefined): { vid: string | null; pid: string | null; iface: string | null; deviceKey: string | null } {
  const pnp = (pnpId ?? '').trim();
  const vid = pnp.match(/VID_([0-9A-F]{4})/i)?.[1]?.toUpperCase() ?? null;
  const pid = pnp.match(/PID_([0-9A-F]{4})/i)?.[1]?.toUpperCase() ?? null;
  const iface = pnp.match(/MI_([0-9A-F]{2})/i)?.[0]?.toUpperCase() ?? null;
  const instance = pnp.split('\\')[2]?.trim().toUpperCase() || null;
  // The interfaces of one composite device share the instance prefix; the last "&xxxx" segment numbers the interface.
  const deviceKey = instance ? (iface ? instance.replace(/&[0-9A-F]{4}$/i, '') : instance) : null;
  return { vid, pid, iface, deviceKey };
}

/** The role the Windows port name suggests ("SimTech HS-USB AT Port 9001 (COM20)"), or null when it says nothing usable. */
function roleFromName(name: string | null): PortRole | null {
  if (!name) return null;
  if (/\bAT\s*Port\b/i.test(name)) return 'at';
  if (/\baudio\b/i.test(name)) return 'audio';
  if (/diagnostic/i.test(name)) return 'diagnostics';
  if (/\bNMEA\b/i.test(name)) return 'nmea';
  if (/\bmodem\b/i.test(name)) return 'modem';
  return null;
}

export function classifyInterface(raw: SerialInterfaceInfo): DiscoveredInterface {
  const parsed = parsePnpId(raw.pnpId);
  const vid = (raw.vendorId ?? parsed.vid ?? '').toUpperCase() || null;
  const pid = (raw.productId ?? parsed.pid ?? '').toUpperCase() || null;
  const name = raw.friendlyName?.trim() || null;
  const base = { path: raw.path, vendorId: vid, productId: pid, interface: parsed.iface, deviceKey: parsed.deviceKey, name };
  if (vid !== SIMCOM_VID) return { ...base, role: 'unknown', roleBasis: 'not a SIMCom device port' };

  const byInterface = parsed.iface ? INTERFACE_ROLE[parsed.iface] : undefined;
  const byName = roleFromName(name);
  if (byInterface && byName && byInterface.role !== byName) {
    // Two sources disagree: do not pick one.
    return { ...base, role: 'unknown', roleBasis: `${byInterface.basis}, but Windows names it "${name}" (${byName}); not used automatically` };
  }
  if (byInterface) return { ...base, role: byInterface.role, roleBasis: byName ? `${byInterface.basis}; Windows name "${name}" agrees` : byInterface.basis };
  if (byName) return { ...base, role: byName, roleBasis: `Windows names it "${name}" (interface number unknown)` };
  return { ...base, role: 'unknown', roleBasis: 'a SIMCom port whose interface is not recognised' };
}

/** Group SIMCom interfaces into physical modems. Interfaces without a usable device identity are left out (never guessed). */
export function groupModems(raw: SerialInterfaceInfo[]): { modems: ModemCandidate[]; unidentified: DiscoveredInterface[] } {
  const groups = new Map<string, DiscoveredInterface[]>();
  const unidentified: DiscoveredInterface[] = [];
  for (const info of raw) {
    const port = classifyInterface(info);
    if (port.vendorId !== SIMCOM_VID) continue;
    if (!port.deviceKey) {
      unidentified.push(port);
      continue;
    }
    const id = `${port.vendorId}:${port.productId ?? '----'}:${port.deviceKey}`;
    groups.set(id, [...(groups.get(id) ?? []), port]);
  }
  const modems: ModemCandidate[] = [];
  for (const [id, interfaces] of groups) {
    interfaces.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    const problems: string[] = [];
    const pick = (role: PortRole, label: string): string | null => {
      const found = interfaces.filter((i) => i.role === role);
      if (found.length === 1) return found[0].path;
      problems.push(found.length === 0 ? `no ${label} interface was found` : `several ${label} interfaces were found (${found.map((f) => f.path).join(', ')})`);
      return null;
    };
    const at = pick('at', 'AT');
    const audio = pick('audio', 'USB audio');
    modems.push({ id, vendorId: interfaces[0].vendorId!, productId: interfaces[0].productId, at, audio, interfaces, problems });
  }
  modems.sort((a, b) => a.id.localeCompare(b.id));
  return { modems, unidentified };
}

export type ResolutionCode =
  | 'NO_MODEM'
  | 'MULTIPLE_MODEMS'
  | 'SELECTOR_NO_MATCH'
  | 'INTERFACE_MISSING'
  | 'EXPLICIT_PORT_UNIDENTIFIED'
  | 'LIST_FAILED';

export type PortResolution =
  | {
      ok: true;
      mode: 'explicit' | 'discovered' | 'mixed';
      at: string;
      audio: string;
      device: ModemCandidate | null;
      warnings: string[];
      modems: ModemCandidate[];
    }
  | { ok: false; code: ResolutionCode; message: string; warnings: string[]; modems: ModemCandidate[] };

export interface ResolveInput {
  /** MODEM_AT_PORT / MODEM_AUDIO_PORT. When set they are used as given (the operator decides); discovery only warns. */
  explicitAt?: string | null;
  explicitAudio?: string | null;
  /** MODEM_DEVICE: which modem to use when several are present (its id, or a unique part of it). */
  selector?: string | null;
  /** The modem used before (a reconnect prefers the same physical device). */
  previousId?: string | null;
}

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toUpperCase() === b.toUpperCase();

function explicitWarnings(label: string, path: string, role: PortRole, raw: DiscoveredInterface[]): string[] {
  const port = raw.find((p) => same(p.path, path));
  if (!port) return [`${label} ${path} (set explicitly) is not present in Windows right now; the gateway keeps retrying it`];
  if (port.vendorId !== SIMCOM_VID) return [`${label} ${path} (set explicitly) is not a SIMCom port`];
  if (port.role !== role && port.role !== 'unknown') return [`${label} ${path} (set explicitly) looks like the module's ${port.role} interface, not its ${role} interface`];
  return [];
}

/**
 * Decide which ports to open. Never guesses: explicit settings are used as given; otherwise exactly one complete modem (or the
 * one the selector or the previous connection names) is required.
 */
export function resolveModemPorts(input: ResolveInput, raw: SerialInterfaceInfo[]): PortResolution {
  const { modems } = groupModems(raw);
  const all = raw.map(classifyInterface);
  const explicitAt = input.explicitAt?.trim() || null;
  const explicitAudio = input.explicitAudio?.trim() || null;
  const deviceOf = (path: string) => modems.find((m) => m.interfaces.some((i) => same(i.path, path))) ?? null;

  if (explicitAt && explicitAudio) {
    const warnings = [...explicitWarnings('AT port', explicitAt, 'at', all), ...explicitWarnings('Audio port', explicitAudio, 'audio', all)];
    const dAt = deviceOf(explicitAt);
    const dAudio = deviceOf(explicitAudio);
    if (dAt && dAudio && dAt.id !== dAudio.id) warnings.push(`MODEM_AT_PORT and MODEM_AUDIO_PORT belong to two different modems (${dAt.id} and ${dAudio.id})`);
    return { ok: true, mode: 'explicit', at: explicitAt, audio: explicitAudio, device: dAt ?? dAudio, warnings, modems };
  }

  if (explicitAt || explicitAudio) {
    // One is set: the other must come from the same physical modem, or nothing is opened.
    const given = (explicitAt ?? explicitAudio)!;
    const device = deviceOf(given);
    const missing = explicitAt ? 'audio' : 'at';
    const found = device ? device[missing] : null;
    if (!device || !found) {
      return {
        ok: false,
        code: 'EXPLICIT_PORT_UNIDENTIFIED',
        message: `${explicitAt ? 'MODEM_AT_PORT' : 'MODEM_AUDIO_PORT'}=${given} is set but the matching ${missing === 'audio' ? 'USB audio' : 'AT'} interface of the same modem could not be identified${device ? ` (${device.problems.join('; ')})` : ''}. Set ${explicitAt ? 'MODEM_AUDIO_PORT' : 'MODEM_AT_PORT'} too, or unset both to discover them.`,
        warnings: [],
        modems,
      };
    }
    return { ok: true, mode: 'mixed', at: explicitAt ?? found, audio: explicitAudio ?? found, device, warnings: explicitWarnings(explicitAt ? 'AT port' : 'Audio port', given, explicitAt ? 'at' : 'audio', all), modems };
  }

  const describe = (list: ModemCandidate[]) => list.map((m) => `${m.id} (AT ${m.at ?? '?'}, audio ${m.audio ?? '?'})`).join('; ');
  let candidates = modems;
  const selector = input.selector?.trim().toUpperCase() || null;
  if (selector) {
    candidates = modems.filter((m) => m.id.toUpperCase() === selector || m.id.toUpperCase().includes(selector));
    if (candidates.length !== 1) {
      return {
        ok: false,
        code: candidates.length === 0 ? 'SELECTOR_NO_MATCH' : 'MULTIPLE_MODEMS',
        message: `MODEM_DEVICE=${input.selector} matches ${candidates.length === 0 ? 'no' : 'more than one'} connected modem${modems.length ? `. Connected: ${describe(modems)}` : ''}.`,
        warnings: [],
        modems,
      };
    }
  } else if (modems.length > 1) {
    const previous = input.previousId ? modems.find((m) => m.id === input.previousId) : undefined;
    if (!previous) {
      return {
        ok: false,
        code: 'MULTIPLE_MODEMS',
        message: `${modems.length} SIMCom modems are connected; the gateway does not guess which one to open. Set MODEM_DEVICE to one of: ${describe(modems)}.`,
        warnings: [],
        modems,
      };
    }
    candidates = [previous];
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'NO_MODEM',
      message: 'No SIMCom modem (USB VID 1E0E) is connected. Check the USB cable and that the SIMCom drivers are installed (Device Manager > Ports).',
      warnings: [],
      modems,
    };
  }
  const device = candidates[0];
  if (!device.at || !device.audio) {
    return {
      ok: false,
      code: 'INTERFACE_MISSING',
      message: `Modem ${device.id} was found but ${device.problems.join(' and ')}. Its interfaces: ${device.interfaces.map((i) => `${i.path}=${i.role}`).join(', ')}. Set MODEM_AT_PORT and MODEM_AUDIO_PORT explicitly if this USB composition differs.`,
      warnings: [],
      modems,
    };
  }
  const warnings = input.previousId && input.previousId !== device.id ? [`The modem now appears as ${device.id} (it was ${input.previousId}); it was moved to another USB socket or re-enumerated`] : [];
  return { ok: true, mode: 'discovered', at: device.at, audio: device.audio, device, warnings, modems };
}

// ------------------------------------------------------------------------------------------------ stateful discovery

export type PortLister = () => Promise<SerialInterfaceInfo[]>;

export interface DiscoveryStatus {
  mode: 'explicit' | 'discovery';
  explicit: { at: string | null; audio: string | null };
  selector: string | null;
  lastScanAt: string | null;
  ok: boolean | null;
  code: ResolutionCode | null;
  message: string | null;
  warnings: string[];
  at: string | null;
  audio: string | null;
  device: { id: string; vendorId: string; productId: string | null } | null;
  modems: Array<{ id: string; at: string | null; audio: string | null; problems: string[]; interfaces: Array<{ path: string; interface: string | null; role: PortRole; name: string | null }> }>;
}

/**
 * The gateway's single source of "which ports are this modem's now". The adapters ask it just before they open a port, so a
 * renumbered COM port is followed on the next (re)connect, and nothing is ever opened while discovery is ambiguous.
 */
export class PortDiscovery {
  private last: PortResolution | null = null;
  private lastScanAt: string | null = null;
  private deviceId: string | null = null;
  private current: { at: string | null; audio: string | null } = { at: null, audio: null };
  private present = new Set<string>();

  constructor(
    private readonly lister: PortLister,
    private readonly options: { explicitAt?: string | null; explicitAudio?: string | null; selector?: string | null; now?: () => Date } = {}
  ) {
    this.current = { at: options.explicitAt?.trim() || null, audio: options.explicitAudio?.trim() || null };
  }

  get isExplicit(): boolean {
    return Boolean(this.options.explicitAt?.trim() && this.options.explicitAudio?.trim());
  }

  /** List the ports (opens none) and resolve. Never throws: a listing failure is a resolution error. */
  async scan(): Promise<PortResolution> {
    let raw: SerialInterfaceInfo[];
    try {
      raw = await this.lister();
    } catch (error) {
      this.last = { ok: false, code: 'LIST_FAILED', message: `Could not list the serial ports: ${(error as Error).message}`, warnings: [], modems: [] };
      this.lastScanAt = (this.options.now?.() ?? new Date()).toISOString();
      return this.last;
    }
    this.present = new Set(raw.map((r) => r.path.toUpperCase()));
    const result = resolveModemPorts(
      { explicitAt: this.options.explicitAt, explicitAudio: this.options.explicitAudio, selector: this.options.selector, previousId: this.deviceId },
      raw
    );
    this.last = result;
    this.lastScanAt = (this.options.now?.() ?? new Date()).toISOString();
    if (result.ok) {
      if (result.device) this.deviceId = result.device.id;
      this.current = { at: result.at, audio: result.audio };
    }
    return result;
  }

  /** The AT port to open now. Throws an actionable error when it cannot be decided (the adapter then retries later). */
  async resolveAt(): Promise<string> {
    const result = await this.scan();
    if (result.ok === false) throw new PortDiscoveryError(result.code, result.message);
    return result.at;
  }

  async resolveAudio(): Promise<string> {
    const result = await this.scan();
    if (result.ok === false) throw new PortDiscoveryError(result.code, result.message);
    return result.audio;
  }

  /** Whether Windows listed this port in the last scan. */
  isPresent(path: string | null): boolean {
    return !!path && this.present.has(path.toUpperCase());
  }

  /** The ports in use (or about to be used), as last resolved. Null before the first successful resolution. */
  ports(): { at: string | null; audio: string | null } {
    return { ...this.current };
  }

  status(): DiscoveryStatus {
    const r = this.last;
    return {
      mode: this.isExplicit ? 'explicit' : 'discovery',
      explicit: { at: this.options.explicitAt?.trim() || null, audio: this.options.explicitAudio?.trim() || null },
      selector: this.options.selector?.trim() || null,
      lastScanAt: this.lastScanAt,
      ok: r ? r.ok : null,
      code: r && r.ok === false ? r.code : null,
      message: r && r.ok === false ? r.message : null,
      warnings: r?.warnings ?? [],
      at: this.current.at,
      audio: this.current.audio,
      device: r && r.ok && r.device ? { id: r.device.id, vendorId: r.device.vendorId, productId: r.device.productId } : null,
      modems: (r?.modems ?? []).map((m) => ({
        id: m.id,
        at: m.at,
        audio: m.audio,
        problems: m.problems,
        interfaces: m.interfaces.map((i) => ({ path: i.path, interface: i.interface, role: i.role, name: i.name })),
      })),
    };
  }
}

export class PortDiscoveryError extends Error {
  constructor(
    readonly code: ResolutionCode,
    message: string
  ) {
    super(message);
    this.name = 'PortDiscoveryError';
  }
}
