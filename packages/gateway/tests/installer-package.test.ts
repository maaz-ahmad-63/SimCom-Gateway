import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The installer and the packaging build, pinned by the mistakes of the first installer:
 *  - its data folder allowed only Administrators and SYSTEM, so a normal user's supervisor could not write its first file and nothing started;
 *  - its icon opened the browser without waiting for anything, so a service that never started showed ERR_CONNECTION_REFUSED;
 *  - its build rewrote packages\shared\dist, which restarted a running development gateway.
 * These read the real files; the packaged program itself is exercised by the manual end-to-end run described in docs/PACKAGING.md.
 */
const root = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const iss = read('installer/SimGateway.iss');
const build = read('installer/build-package.ps1');

describe('the installer script', () => {
  const GUARD = '\\{localappdata\\}\\\\SIZH IT Solution\\\\SimGatewayStart\\.js';

  it('installs per user: no administrator rights, in %LOCALAPPDATA%, with the same AppId', () => {
    expect(iss).toMatch(/^PrivilegesRequired=lowest$/m);
    expect(iss).not.toMatch(/PrivilegesRequired=admin/);
    expect(iss).toMatch(/^DefaultDirName=\{localappdata\}\\Programs\\SIZH IT Solution$/m);
    expect(iss).toMatch(/^DisableDirPage=yes$/m);
    expect(iss).toMatch(/^AppId=\{\{6F2A9C1E-5B7D-4C3A-9E48-2D7A41B8C0F3\}$/m);
    // nothing in a per-user setup may need elevation
    expect(iss).not.toMatch(/Permissions: /);
    expect(iss).not.toMatch(/schtasks/);
    expect(iss).not.toMatch(/\{autopf\}|\{commonprograms\}|\{commondesktop\}|\{pf\}/);
  });

  it('keeps customer data where earlier versions kept it, and only restricts a data folder that setup itself is creating', () => {
    for (const dir of ['', '\\config', '\\backups', '\\logs']) expect(iss).toContain(`Name: "{commonappdata}\\SimGateway${dir}"\n`);
    const grants = iss.split('\n').filter((l) => l.includes('icacls.exe'));
    expect(grants).toHaveLength(2);
    for (const g of grants) {
      expect(g).toContain('/inheritance:r');
      expect(g).toContain('{username}:(OI)(CI)F');
      expect(g).toMatch(/Check: (DataIsNew|SecretsAreNew)/); // an existing folder is never re-permissioned
      expect(g).not.toContain('/T'); // and no existing file is walked
    }
    expect(iss).toMatch(/DataWasMissing := not DirExists/);
  });

  it('stops with an explanation when an earlier all-users install is present, instead of installing beside it', () => {
    expect(iss).toMatch(/function InitializeSetup[\s\S]*RegKeyExists\(HKLM64, OldMachineKey\)[\s\S]*Result := False/);
    expect(iss).toContain('{6F2A9C1E-5B7D-4C3A-9E48-2D7A41B8C0F3}_is1');
    expect(iss).toMatch(/choose NO/);
  });

  it('starts the program through the guard outside the program folder, never through a batch or PowerShell script that opens the browser at once', () => {
    const icons = iss.split('[Icons]')[1].split('\n[')[0];
    expect(icons).toMatch(new RegExp(`Name: "\\{group\\}\\\\SIZH IT Solution"; Filename: "\\{sys\\}\\\\wscript\\.exe"; Parameters: "//B //Nologo ""${GUARD}"""`));
    expect(icons).toMatch(/Name: "\{autodesktop\}\\SIZH IT Solution"; Filename: "\{sys\}\\wscript\.exe"/);
    expect(icons).toMatch(/Stop SIZH IT Solution[^\n]*SimGatewayStart\.js""\s*--stop/);
    expect(icons).not.toMatch(/\{app\}\\SimGateway\.js/); // every shortcut survives the program folder being briefly absent
    expect(iss).toMatch(/Source: "guard\\SimGatewayStart\.js"; DestDir: "\{localappdata\}\\SIZH IT Solution"/);
    // the only PowerShell shortcut left is the read-only modem and driver check, which the customer chooses to run
    const powershell = icons.split('\n').filter((l) => /powershell\.exe/.test(l));
    expect(powershell).toHaveLength(1);
    expect(powershell[0]).toContain('check-modem-driver.ps1');
    for (const gone of ['start-product.cmd', 'ensure-running.ps1']) expect(iss.replace(/\[InstallDelete\][\s\S]*?\n\n/, '')).not.toContain(gone);
  });

  it('starts the product after install, and at sign-in without a browser through a Startup shortcut', () => {
    expect(iss).toMatch(/SimGatewayStart\.js"""; Description: "Start SIZH IT Solution now[^\n]*Flags: postinstall nowait skipifsilent/);
    expect(iss).not.toMatch(/runasoriginaluser/); // setup is not elevated, so there is no other user to return to
    expect(iss).toMatch(/Name: "\{userstartup\}\\SIZH IT Solution"[^\n]*--no-browser[^\n]*Tasks: autostart/);
  });

  it('stops the running product cleanly (and refuses during a call) before an upgrade replaces files, also for an older installation', () => {
    expect(iss).toContain("gateway\\dist\\supervisor\\launch.js')");
    expect(iss).toContain(`'" --stop'`);
    expect(iss).toMatch(/stop-product\.ps1/); // an installation made by the first installer is stopped with the script it has
    expect(iss).toMatch(/PrepareToInstall[\s\S]*StopRunningProduct[\s\S]*BackUpDatabase/);
    expect(iss).toMatch(/launch\.js""\s*--stop --force[^\n]*RunOnceId: "StopGateway"/);
  });

  it('never deletes customer data on upgrade, and asks before removing it on uninstall (default: keep)', () => {
    expect(iss).not.toMatch(/\[InstallDelete\][\s\S]*SimGateway\\(gateway|recordings|config)/);
    expect(iss).toMatch(/MB_YESNO or MB_DEFBUTTON2/);
    // the uninstall list holds only the guard folder and update leftovers beside the program folder
    const deletes = iss.split('[UninstallDelete]')[1].split('\n[')[0].split('\n').filter((l) => l.startsWith('Type:'));
    expect(deletes.map((l) => l.replace(/^.*Name: /, ''))).toEqual(['"{localappdata}\\SIZH IT Solution"', '"{app}.backup"', '"{app}.new"', '"{app}.failed"']);
    for (const l of deletes) expect(l).not.toMatch(/commonappdata/);
  });

  it('contains no stray control characters (a broken path escape once split a line in two)', () => {
    // eslint-disable-next-line no-control-regex
    expect(iss).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
    expect(iss).not.toMatch(/\{app\}\s*\n\s*untime/);
    for (const script of ['installer/scripts/SimGateway.js', 'installer/guard/SimGatewayStart.js', 'installer/build-package.ps1']) expect(read(script)).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
  });

  it('keeps every section in its own place (a comment mentioning a section name once swallowed the real ones)', () => {
    const order = [...iss.matchAll(/^\[(\w+)\]$/gm)].map((m) => m[1]);
    expect(order).toEqual(['Setup', 'Dirs', 'InstallDelete', 'Files', 'Icons', 'Tasks', 'Run', 'UninstallRun', 'UninstallDelete', 'Code']);
  });

  it('keeps the encryption key for saved API keys in its own folder, and never ships or auto-deletes it', () => {
    expect(iss).toContain('Name: "{commonappdata}\\SimGatewaySecrets"\n');
    const secretsGrant = iss.split('\n').find((l) => l.includes('icacls.exe') && l.includes('SimGatewaySecrets'))!;
    expect(secretsGrant).toContain('/inheritance:r');
    expect(secretsGrant).not.toContain('/T');
    expect(secretsGrant).not.toContain('S-1-5-32-545'); // not open to every user
    // uninstall removes the key only together with the data, after an explicit Yes (default No)
    const code = iss.split('[Code]')[1];
    const yes = code.slice(code.indexOf('= IDYES then'), code.indexOf('= IDYES then') + 400);
    expect(yes).toContain('SimGatewaySecrets');
    expect(code.replace(yes, '')).not.toMatch(/DelTree[^\n]*SimGatewaySecrets/);
    expect(iss).toMatch(/Reset saved API keys"; Filename: "\{sys\}\\wscript\.exe"; Parameters: "\/\/B \/\/Nologo ""\{localappdata\}\\SIZH IT Solution\\SimGatewayStart\.js"" --reset-secrets"/);
  });

  it('does not bundle a driver', () => {
    expect(iss).not.toMatch(/\.(inf|sys|cat)"/i);
  });
});

describe('the packaging build', () => {
  it('never rebuilds the development folders (packages\\shared\\dist is imported by a running development gateway)', () => {
    expect(build).not.toMatch(/npm['"]?\s+@\('run', 'build', '--workspace=@sim-gateway\/(shared|gateway)'\)/);
    expect(build).toMatch(/'-p', 'packages\\shared', '--outDir'/);
    expect(build).toMatch(/'-p', 'packages\\gateway', '--outDir'/);
    expect(build).toMatch(/LastWriteTimeUtc -ne \$sharedStamp\) \{ throw/); // and it checks that it did not
    expect(build).toContain("Copy-Item (Join-Path $Build 'gateway') (Join-Path $Gw 'dist')");
    expect(build).not.toContain("Join-Path $Root 'packages\\gateway\\dist'");
    expect(build).not.toContain("Join-Path $Root 'packages\\shared\\dist\\*'");
  });

  it('refuses to produce a package that cannot start: every entry point the launcher needs must exist', () => {
    for (const entry of ['launch.js', 'main.js', 'gateway-entry.js', 'SimGateway.js', 'server.js', 'better_sqlite3.node', 'win32-x64']) expect(build).toContain(entry);
    expect(build).toMatch(/The package is incomplete/);
  });

  it('keeps the private-file and no-Python/no-driver checks, and reports the version it was built as', () => {
    expect(build).toMatch(/\.env/);
    expect(build).toMatch(/'\.inf', '\.sys', '\.cat', '\.py'/);
    expect(build).toMatch(/must never be shipped/);
    expect(build).toMatch(/\$gwPkg\.version = \$version/);
  });

  it('refuses to package an encryption key or anything from the secrets folder', () => {
    expect(build).toContain('SimGatewaySecrets');
    expect(build).toContain("master\\.key");
    expect(build).toContain('SIMGATEWAY-SECRETS-KEY-V1:[0-9a-f]{64}');
  });

  it('writes the staged package.json without a byte-order mark, so the program reports its version (the 0.0.0 bug)', () => {
    expect(build).toMatch(/WriteAllText\(\(Join-Path \$Gw 'package\.json'\)[^\n]*UTF8Encoding \$false/);
    expect(build).not.toMatch(/Set-Content \(Join-Path \$Gw 'package\.json'\)/);
  });

  it('detects Inno Setup 7 and 6', () => {
    expect(build).toContain('Inno Setup 7\\ISCC.exe');
    expect(build).toContain('Inno Setup 6\\ISCC.exe');
  });
});

describe('the files the icons run', () => {
  it('has a hidden launcher stub that runs the bundled Node (no console, no PowerShell, no typed commands)', () => {
    const stub = read('installer/scripts/SimGateway.js');
    expect(stub).toContain('runtime\\\\node.exe');
    expect(stub).toContain('gateway\\\\dist\\\\supervisor\\\\launch.js');
    expect(stub).toMatch(/\.Run\([\s\S]*?, 0, true\)/); // hidden window, waits
    expect(stub).toMatch(/VCRUNTIME140/); // explains the one failure it can see itself
    expect(stub).not.toMatch(/powershell/i);
    for (const gone of ['start-product.cmd', 'ensure-running.ps1', 'stop-product.ps1']) expect(fs.existsSync(path.join(root, 'installer/scripts', gone)), gone).toBe(false);
  });

  it('starts the gateway through the wrapper that answers the supervisor\'s shutdown message, and never edits the development entry', () => {
    const launcher = read('packages/gateway/src/supervisor/launcher.ts');
    expect(launcher).toContain("'supervisor', 'gateway-entry.js'");
    const entry = read('packages/gateway/src/supervisor/gateway-entry.ts');
    expect(entry).toMatch(/import '\.\.\/index\.js'/);
    expect(entry).toMatch(/type !== 'shutdown'/);
    expect(read('packages/gateway/src/index.ts')).not.toMatch(/process\.on\('message'/); // the development entry is untouched
  });
});

describe('SIZH IT Solution branding of the installer', () => {
  const iss = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'installer', 'SimGateway.iss'), 'utf8');
  it('names the product SIZH IT Solution but keeps the internal identifiers upgrades depend on', () => {
    expect(iss).toMatch(/^AppName=SIZH IT Solution$/m);
    expect(iss).toMatch(/^AppId=\{\{6F2A9C1E-5B7D-4C3A-9E48-2D7A41B8C0F3\}$/m);
    expect(iss).toContain('SimGatewaySecrets');
    expect(iss).toContain('OutputBaseFilename=SimGateway-Setup-');
  });
  it('removes shortcuts under the old product name so an upgrade does not leave two', () => {
    expect(iss).toMatch(/\[InstallDelete\][\s\S]*userprograms\}\\SIM Gateway/);
    expect(iss).toMatch(/userdesktop\}\\SIM Gateway\.lnk/);
  });
  it('shows no old name or modem model in customer text', () => {
    const customer = iss.split('\n').filter((l) => !/^\s*;/.test(l) && !/userprograms\}\\SIM Gateway|userdesktop\}\\SIM Gateway\.lnk|choose SIZH IT Solution \(or SIM Gateway\)/.test(l)).join('\n');
    expect(customer).not.toMatch(/SIM Gateway|SIM7600/);
  });
});
