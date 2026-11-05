import fs from 'node:fs';
import path from 'node:path';

/** The version the packaged program was built as (VERSION.json, written by installer\build-package.ps1). '0.0.0' when it cannot be read. */
export function readVersion(appDir: string): string {
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(appDir, 'VERSION.json'), 'utf8').replace(/^﻿/, '')) as { version?: string }).version;
    return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
