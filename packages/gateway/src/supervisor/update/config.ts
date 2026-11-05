/**
 * Where the product looks for updates. The default is the project's public GitHub Releases: `releases/latest/download/<asset>` always
 * resolves to the newest PUBLISHED release (never a draft), and the signature is read from the same address plus `.sig`. The default can be
 * replaced in config\gateway.env (UPDATE_URL=...) or with the SIMGW_UPDATE_URL environment variable, for a mirror or a test server; an empty
 * value switches checking back to the default, and a non-https value is ignored by the updater (it only ever talks https).
 */
export const DEFAULT_UPDATE_URL = 'https://github.com/maaz-ahmad-63/SimCom-Gateway/releases/latest/download/latest.json';

export function resolveUpdateUrl(env: NodeJS.ProcessEnv, fileValues: Record<string, string>): string {
  return (env.SIMGW_UPDATE_URL?.trim() || fileValues.UPDATE_URL?.trim() || DEFAULT_UPDATE_URL).trim();
}
