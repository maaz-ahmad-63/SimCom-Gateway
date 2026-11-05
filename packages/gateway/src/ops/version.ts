import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The API contract version. A dashboard that expects a different major version is told the gateway is incompatible instead of failing oddly. */
export const API_VERSION = 1;

export function appVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../../package.json', '../../../package.json']) {
      const f = path.resolve(here, rel);
      if (fs.existsSync(f)) {
        const v = (JSON.parse(fs.readFileSync(f, 'utf8')) as { version?: string }).version;
        if (v) return v;
      }
    }
  } catch {
    /* the version is informational */
  }
  return '0.0.0';
}

/** Whether a dashboard built for `dashboardApi` can talk to this gateway. */
export function compatibility(dashboardApi: number | null): { compatible: boolean; message: string } {
  if (dashboardApi === null) return { compatible: true, message: 'The dashboard did not say which version it expects.' };
  if (dashboardApi === API_VERSION) return { compatible: true, message: 'The dashboard and the gateway are compatible.' };
  return { compatible: false, message: `This dashboard expects gateway API version ${dashboardApi} but the gateway provides version ${API_VERSION}. Update the one that is older.` };
}
