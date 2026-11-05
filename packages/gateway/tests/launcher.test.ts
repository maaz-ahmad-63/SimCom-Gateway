import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadAiConfig } from '../src/ai/config.js';
import { buildDashboardEnv, buildGatewayEnv, buildSpecs, PACKAGED_AI_DEFAULTS, defaultDataDir, ensureConfigFile, parseEnvFile, preflight, resolveLayout } from '../src/supervisor/launcher.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  dirs.push(d);
  return d;
};

describe('where the product keeps things', () => {
  it('keeps customer data apart from the program, in a data folder that an update never touches', () => {
    expect(defaultDataDir({ ProgramData: 'C:\\ProgramData' }, 'win32')).toBe(path.join('C:\\ProgramData', 'SimGateway'));
    expect(defaultDataDir({ SIMGW_DATA_DIR: 'D:\\Calls' }, 'win32')).toBe(path.resolve('D:\\Calls'));
    const layout = resolveLayout(path.join('C:\\Program Files', 'SimGateway'), { ProgramData: 'C:\\ProgramData' }, 'win32');
    expect(layout.dataDir.startsWith(layout.appDir)).toBe(false);
    const env = buildGatewayEnv(layout, { PATH: 'x' }, {});
    for (const key of ['SQLITE_DB_PATH', 'CALL_RECORDING_DIR', 'AUDIO_DUMP_DIRECTORY', 'LOG_DIR']) expect(env[key]!.startsWith(layout.dataDir), key).toBe(true);
    expect(env.NODE_ENV).toBe('production');
  });

  it('lets the customer\'s file decide settings, but not by accident move data into the program folder', () => {
    const layout = resolveLayout('/app', { SIMGW_DATA_DIR: '/data' }, 'linux');
    const env = buildGatewayEnv(layout, {}, { PORT: '4100', MODEM_DRIVER: 'mock' });
    expect(env).toMatchObject({ PORT: '4100', MODEM_DRIVER: 'mock' });
    expect(env.SQLITE_DB_PATH).toBe(path.join(path.resolve('/data'), 'gateway.sqlite'));
  });
});

describe('the customer configuration', () => {
  it('is created once with a fresh random key and never overwritten by an upgrade', () => {
    const file = path.join(tmp(), 'config', 'gateway.env');
    expect(ensureConfigFile(file)).toEqual({ created: true });
    const first = parseEnvFile(fs.readFileSync(file, 'utf8'));
    expect(first.GATEWAY_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toMatchObject({ HOST: '127.0.0.1', MODEM_DRIVER: 'hardware' });
    fs.appendFileSync(file, 'PORT=4100\n');
    expect(ensureConfigFile(file)).toEqual({ created: false });
    expect(parseEnvFile(fs.readFileSync(file, 'utf8'))).toMatchObject({ GATEWAY_API_KEY: first.GATEWAY_API_KEY, PORT: '4100' });
    const second = path.join(tmp(), 'gateway.env');
    ensureConfigFile(second);
    expect(parseEnvFile(fs.readFileSync(second, 'utf8')).GATEWAY_API_KEY).not.toBe(first.GATEWAY_API_KEY); // two installs never share a key
  });

  it('binds to the local computer by default and never carries a development key', () => {
    const file = path.join(tmp(), 'gateway.env');
    ensureConfigFile(file);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/change-this|dev-secret/);
    expect(parseEnvFile(text).HOST).toBe('127.0.0.1');
  });

  it('parses comments, quotes and bad lines safely', () => {
    expect(parseEnvFile('# c\nA=1\nB="two"\nbad line\nlower=3\n=x\nC=a=b')).toEqual({ A: '1', B: 'two', C: 'a=b' });
  });
});

describe('what each service is given', () => {
  it('hands the dashboard the local key hand-off, loopback only, and the gateway its own file values', () => {
    const dir = tmp();
    const layout = resolveLayout(path.join(dir, 'app'), { SIMGW_DATA_DIR: path.join(dir, 'data') }, 'linux');
    ensureConfigFile(layout.configFile);
    const specs = buildSpecs(layout, { PATH: 'x' });
    expect(specs.gateway.env.GATEWAY_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(specs.dashboard.env).toMatchObject({ HOSTNAME: '127.0.0.1', SIMGW_LOCAL_CONFIG: '1', SIMGW_GATEWAY_URL: 'http://127.0.0.1:4000' });
    expect(specs.dashboard.env.SIMGW_CONFIG_FILE).toBe(layout.configFile);
    expect(buildDashboardEnv(layout, {}, { PORT: '4100' }).GATEWAY_INTERNAL_URL).toBe('http://127.0.0.1:4100');
    expect(specs.gateway.args[0]).toBe(layout.gatewayEntry);
  });

  it('says in sentences what is missing before starting anything', () => {
    const layout = resolveLayout('/nowhere', { SIMGW_DATA_DIR: '/d', SIMGW_NODE: '/nowhere/node' }, 'linux');
    const problems = preflight(layout, () => false);
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toMatch(/Reinstall/);
    expect(preflight(layout, () => true)).toEqual([]);
  });
});

describe('what the installed product does out of the box (the AI agent attaches by itself)', () => {
  const layout = resolveLayout('/app', { SIMGW_DATA_DIR: '/d' }, 'linux');
  // The consumer: the gateway's own configuration parser. Testing against it (not against our own constants) catches a misspelt variable,
  // which would otherwise silently do nothing.
  const read = (env: NodeJS.ProcessEnv) => loadAiConfig(env as Record<string, string | undefined>);

  it('turns on attachment to every call, answering after two rings, audio activation and replies, at the configured 8000 Hz', () => {
    const { config, errors } = read(buildGatewayEnv(layout, {}, {}));
    expect(errors.filter((e) => /AUTO|AI_ENABLED|SAMPLE_RATE/.test(e))).toEqual([]);
    expect(config).toMatchObject({ enabled: true, autoHandle: 'all' });
    expect(config.automation).toMatchObject({ autoAnswer: true, autoAnswerRings: 2, autoActivateUsbAudio: true, autoReplies: true });
    expect(config.audio.format).toMatchObject({ sampleRate: 8000 });
    expect(Object.keys(PACKAGED_AI_DEFAULTS).sort()).toEqual(['AI_AUDIO_AUTO_VERIFY', 'AI_AUDIO_SAMPLE_RATE', 'AI_AUTO_ACTIVATE_USB_AUDIO', 'AI_AUTO_ANSWER', 'AI_AUTO_ANSWER_RINGS', 'AI_AUTO_HANDLE', 'AI_AUTO_REPLIES', 'AI_ENABLED']);
  });

  it('never sets the audio confirmations by itself: nothing here claims a person confirmed anything', () => {
    const env = buildGatewayEnv(layout, {}, {});
    expect(env.AI_AUDIO_INBOUND_VERIFIED).toBeUndefined();
    expect(env.AI_AUDIO_OUTBOUND_VERIFIED).toBeUndefined();
  });

  it('lets an explicit environment variable and then the customer\'s config file override each default', () => {
    expect(buildGatewayEnv(layout, { AI_AUTO_ANSWER: 'false' }, {}).AI_AUTO_ANSWER).toBe('false');
    expect(buildGatewayEnv(layout, { AI_AUTO_ANSWER: 'false' }, { AI_AUTO_ANSWER: 'true' }).AI_AUTO_ANSWER).toBe('true'); // the file is higher
    const off = read(buildGatewayEnv(layout, {}, { AI_AUTO_HANDLE: 'off', AI_AUTO_ANSWER_RINGS: '4' }));
    expect(off.config.autoHandle).toBe('off');
    expect(off.config.automation.autoAnswerRings).toBe(4);
  });
});

describe('modem ports in the packaged product', () => {
  const layout = () => resolveLayout(tmp(), { ProgramData: tmp() }, 'win32');

  it('a newly created gateway.env leaves both COM ports empty, which means automatic discovery', () => {
    const file = path.join(tmp(), 'gateway.env');
    ensureConfigFile(file);
    const values = parseEnvFile(fs.readFileSync(file, 'utf8'));
    expect(values.MODEM_AT_PORT).toBe('');
    expect(values.MODEM_AUDIO_PORT).toBe('');
    expect(values.MODEM_DRIVER).toBe('hardware');
  });

  it('the gateway reads those empty values as automatic, through the real configuration loader', async () => {
    const file = path.join(tmp(), 'gateway.env');
    ensureConfigFile(file);
    const env = buildGatewayEnv(layout(), { PATH: 'x' }, parseEnvFile(fs.readFileSync(file, 'utf8')));
    const { loadConfig, isAutoPort } = await import('../src/config/index.js');
    const keep = { ...process.env };
    try {
      for (const k of ['MODEM_AT_PORT', 'MODEM_AUDIO_PORT', 'MODEM_DRIVER', 'GATEWAY_API_KEY']) process.env[k] = env[k] ?? '';
      const config = loadConfig();
      expect(isAutoPort(config.atPort)).toBe(true);
      expect(isAutoPort(config.audioPort)).toBe(true);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
      Object.assign(process.env, keep);
    }
  });

  it('does not inherit COM ports from the environment that started the product, but honours the customer file', () => {
    expect(buildGatewayEnv(layout(), { MODEM_AT_PORT: 'COM20', MODEM_AUDIO_PORT: 'COM19' }, {}).MODEM_AT_PORT).toBe('');
    expect(buildGatewayEnv(layout(), { MODEM_AT_PORT: 'COM20', MODEM_AUDIO_PORT: 'COM19' }, {}).MODEM_AUDIO_PORT).toBe('');
    const pinned = buildGatewayEnv(layout(), {}, { MODEM_AT_PORT: 'COM7', MODEM_AUDIO_PORT: 'COM8' });
    expect([pinned.MODEM_AT_PORT, pinned.MODEM_AUDIO_PORT]).toEqual(['COM7', 'COM8']);
  });

  it('an existing customer gateway.env is never rewritten by the product', () => {
    const file = path.join(tmp(), 'gateway.env');
    fs.writeFileSync(file, 'GATEWAY_API_KEY=customer-key-1234\nMODEM_AT_PORT=COM5\n');
    expect(ensureConfigFile(file).created).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toContain('COM5');
  });

  it('gives the dashboard the supervisor address and token file for updates', () => {
    const l = layout();
    const env = buildDashboardEnv(l, {}, { GATEWAY_API_KEY: 'k'.repeat(20) });
    expect(env.SIMGW_SUPERVISOR_URL).toBe('http://127.0.0.1:4010');
    expect(env.SIMGW_SUPERVISOR_TOKEN_FILE).toBe(path.join(l.dataDir, 'supervisor.token'));
  });
});
