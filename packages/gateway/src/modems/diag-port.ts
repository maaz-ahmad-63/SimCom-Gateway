import type { PortLister } from '../hardware/port-discovery.js';

export interface DiagPortInfo {
  path: string;
  role: 'diagnostics';
  /** Whether Windows lists the port. Listing opens nothing. */
  present: boolean;
  /** Always false: the diagnostics port is identified from the Windows port list and never opened or sent AT commands. */
  opened: false;
  friendlyName: string | null;
  manufacturer: string | null;
  pnpId: string | null;
}

/** Report the diagnostics port from the OS port list only. Makes no assumption that it understands AT commands. */
export async function identifyDiagPort(list: PortLister, path: string): Promise<DiagPortInfo> {
  let ports: Awaited<ReturnType<PortLister>> = [];
  try {
    ports = await list();
  } catch {
    // an unreadable list is reported as "not present"
  }
  const found = ports.find((p) => p.path.toUpperCase() === path.toUpperCase());
  return {
    path,
    role: 'diagnostics',
    present: !!found,
    opened: false,
    friendlyName: found?.friendlyName ?? null,
    manufacturer: found?.manufacturer ?? null,
    pnpId: found?.pnpId ?? null,
  };
}
