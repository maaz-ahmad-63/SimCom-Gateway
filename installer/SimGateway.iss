; Inno Setup script (6.3 or newer, or 7) for the SIZH IT Solution customer installer.
; Customer-visible names say SIZH IT Solution. AppId, SimGateway* folders/files and SimGatewaySecrets are internal and stay the same so upgrades work.
; Build with:  powershell -File installer\build-package.ps1   (it assembles installer\stage\app first, then calls ISCC.exe)
;
; Rules this script follows:
;   - PER-USER install: no administrator prompt, ever. Program files go in %LOCALAPPDATA%\Programs\SIZH IT Solution, a folder only this Windows
;     user can write, so the product can replace its own files when it updates itself. Customer data stays in %ProgramData%\SimGateway (and
;     the key in %ProgramData%\SimGatewaySecrets), exactly where earlier versions kept it, and is NEVER installed over, overwritten or removed by an
;     upgrade. The uninstaller removes it only if the customer explicitly says so.
;   - An earlier ALL-USERS install (Program Files) cannot be upgraded in place without administrator rights: setup stops and says how to remove
;     it first, keeping the data. The AppId is unchanged, so later upgrades of the per-user install are ordinary upgrades.
;   - Every shortcut goes through a small guard in %LOCALAPPDATA%\SIZH IT Solution, outside the program folder, which repairs an interrupted
;     automatic update before starting the product.
;   - Before an upgrade replaces program files, the running product is stopped cleanly and the database is copied aside.
;   - No .env file, key or database is part of the installer (the build script refuses to package any).
;   - Nothing here opens the modem or places a call.
; The modem driver is NOT included: no redistribution license for the modem maker's driver could be verified. After installing, the setup runs a
; read-only check (check-modem-driver.ps1: it asks Windows, never the modem) and explains what to do if the driver is missing.
; VALIDATED SO FAR: it compiles with Inno Setup 7.1.1 (checked against a scratch stage). It has NOT been run on a clean customer machine.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F2A9C1E-5B7D-4C3A-9E48-2D7A41B8C0F3}
AppName=SIZH IT Solution
AppVersion={#AppVersion}
AppPublisher=SIZH IT Solution
DefaultDirName={localappdata}\Programs\SIZH IT Solution
DisableDirPage=yes
DefaultGroupName=SIZH IT Solution
DisableProgramGroupPage=yes
OutputBaseFilename=SimGateway-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=no
UninstallDisplayName=SIZH IT Solution
WizardStyle=modern

[Dirs]
; The data folder: created if missing, its contents never touched by an upgrade. Setup is not elevated, so it sets no permissions here (that
; needs administrator rights). A folder created by a normal user inside %ProgramData% belongs to that user. For a NEW folder, the Run section
; below then limits it to this user, SYSTEM and Administrators; an existing folder keeps the permissions it already has (it is customer data).
Name: "{commonappdata}\SimGateway"
Name: "{commonappdata}\SimGateway\config"
Name: "{commonappdata}\SimGateway\backups"
Name: "{commonappdata}\SimGateway\logs"
; The encryption key for saved API keys lives in its own folder, NOT inside the data folder. The product itself restricts the key FILE to this
; user and SYSTEM when it creates it.
Name: "{commonappdata}\SimGatewaySecrets"
; The start guard lives here, outside the program folder, so it still exists if an update is interrupted.
Name: "{localappdata}\SIZH IT Solution"

[InstallDelete]
; Names used before the SIZH IT Solution branding, in case an earlier per-user build left them: one set of shortcuts after an upgrade.
Type: filesandordirs; Name: "{userprograms}\SIM Gateway"
Type: files; Name: "{userdesktop}\SIM Gateway.lnk"
; The PowerShell/cmd launchers of the first installer are replaced by SimGateway.js and the bundled launcher.
Type: files; Name: "{app}\start-product.cmd"
Type: files; Name: "{app}\ensure-running.ps1"
Type: files; Name: "{app}\stop-product.ps1"

[Files]
Source: "stage\app\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "guard\SimGatewayStart.js"; DestDir: "{localappdata}\SIZH IT Solution"; Flags: ignoreversion

[Icons]
Name: "{group}\SIZH IT Solution"; Filename: "{sys}\wscript.exe"; Parameters: "//B //Nologo ""{localappdata}\SIZH IT Solution\SimGatewayStart.js"""; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"; Comment: "Start SIZH IT Solution and open the dashboard"
Name: "{group}\Check the modem and driver"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -NoExit -File ""{app}\check-modem-driver.ps1"""; WorkingDir: "{app}"; Comment: "Checks that the modem and its driver are in place (read only)"
Name: "{group}\Stop SIZH IT Solution"; Filename: "{sys}\wscript.exe"; Parameters: "//B //Nologo ""{localappdata}\SIZH IT Solution\SimGatewayStart.js"" --stop"; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"; Comment: "Stop SIZH IT Solution cleanly (refuses while a call is in progress)"
Name: "{group}\Reset saved API keys"; Filename: "{sys}\wscript.exe"; Parameters: "//B //Nologo ""{localappdata}\SIZH IT Solution\SimGatewayStart.js"" --reset-secrets"; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"; Comment: "Only if SIZH IT Solution says its API-key encryption key is missing or damaged (asks first; saved keys must then be entered again)"
Name: "{group}\Uninstall SIZH IT Solution"; Filename: "{uninstallexe}"
Name: "{autodesktop}\SIZH IT Solution"; Filename: "{sys}\wscript.exe"; Parameters: "//B //Nologo ""{localappdata}\SIZH IT Solution\SimGatewayStart.js"""; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"; Tasks: desktopicon
; Start at sign-in, silently (no browser). A Startup shortcut needs no administrator rights (a scheduled task at sign-in does). The supervisor
; refuses a second copy, so this can never start two gateways.
Name: "{userstartup}\SIZH IT Solution"; Filename: "{sys}\wscript.exe"; Parameters: "//B //Nologo ""{localappdata}\SIZH IT Solution\SimGatewayStart.js"" --no-browser"; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"; Tasks: autostart

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "autostart"; Description: "Start SIZH IT Solution automatically when I sign in to Windows"; GroupDescription: "Startup:"

[Run]
; A NEW data or secrets folder is limited to this user, SYSTEM and Administrators (other Windows users cannot read the API key or the
; recordings). Existing folders are left exactly as they are: they are customer data from an earlier install.
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\SimGateway"" /inheritance:r /grant:r ""{username}:(OI)(CI)F"" ""*S-1-5-18:(OI)(CI)F"" ""*S-1-5-32-544:(OI)(CI)F"" /Q"; Flags: runhidden; Check: DataIsNew
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\SimGatewaySecrets"" /inheritance:r /grant:r ""{username}:(OI)(CI)F"" ""*S-1-5-18:(OI)(CI)F"" ""*S-1-5-32-544:(OI)(CI)F"" /Q"; Flags: runhidden; Check: SecretsAreNew
; Start now, as this user, and open the dashboard.
Filename: "{sys}\wscript.exe"; Parameters: "//B //Nologo ""{localappdata}\SIZH IT Solution\SimGatewayStart.js"""; Description: "Start SIZH IT Solution now and open the dashboard"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\gateway\dist\supervisor\launch.js"" --stop --force"; Flags: runhidden; RunOnceId: "StopGateway"

[UninstallDelete]
; The start guard, and anything an automatic update left beside the program folder. Customer data is NOT listed here.
Type: filesandordirs; Name: "{localappdata}\SIZH IT Solution"
Type: filesandordirs; Name: "{app}.backup"
Type: filesandordirs; Name: "{app}.new"
Type: filesandordirs; Name: "{app}.failed"

[Code]
const
  DataDir = '{commonappdata}\SimGateway';
  OldMachineKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F2A9C1E-5B7D-4C3A-9E48-2D7A41B8C0F3}_is1';

var
  DataWasMissing, SecretsWereMissing: Boolean;

function DataIsNew: Boolean;
begin
  Result := DataWasMissing;
end;

function SecretsAreNew: Boolean;
begin
  Result := SecretsWereMissing;
end;

function InitializeSetup: Boolean;
begin
  Result := True;
  DataWasMissing := not DirExists(ExpandConstant(DataDir));
  SecretsWereMissing := not DirExists(ExpandConstant('{commonappdata}\SimGatewaySecrets'));
  { An all-users install (made by the earlier, administrator-level setup) is registered under HKLM. Installing beside it would leave two
    copies fighting over one modem and one data folder, and replacing it needs administrator rights, so setup stops and says what to do. }
  if RegKeyExists(HKLM64, OldMachineKey) or RegKeyExists(HKLM32, OldMachineKey) then begin
    MsgBox('An earlier version of this product is installed for all users on this computer.' + #13#10#13#10 +
      'Please remove it first: open Windows Settings > Apps > Installed apps, choose SIZH IT Solution (or SIM Gateway) and click Uninstall. ' +
      'When it asks whether to delete your data, choose NO. Your call history, settings, prompts and saved keys are then kept.' + #13#10#13#10 +
      'Then run this setup again. This version installs just for you and does not need administrator rights.', mbInformation, MB_OK);
    Result := False;
  end;
end;

function StopRunningProduct: Boolean;
var
  ResultCode: Integer;
  Launch, OldScript: String;
begin
  Result := True;
  Launch := ExpandConstant('{app}\gateway\dist\supervisor\launch.js');
  OldScript := ExpandConstant('{app}\stop-product.ps1');
  { Without --force: refuses while a call is in progress, so an upgrade never cuts a call off. }
  if FileExists(Launch) and FileExists(ExpandConstant('{app}\runtime\node.exe')) then begin
    if Exec(ExpandConstant('{app}\runtime\node.exe'), '"' + Launch + '" --stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then Result := (ResultCode = 0);
  end else if FileExists(OldScript) then begin
    { An installation made by the first installer: stop it with the script it came with. }
    if Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + OldScript + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then Result := (ResultCode = 0);
  end;
end;

procedure BackUpDatabase;
var
  Db, Target: String;
begin
  Db := ExpandConstant(DataDir + '\gateway.sqlite');
  if not FileExists(Db) then exit;
  ForceDirectories(ExpandConstant(DataDir + '\backups'));
  Target := ExpandConstant(DataDir + '\backups\pre-update-' + '{#AppVersion}' + '-' + GetDateTimeString('yyyymmdd-hhnnss', #0, #0) + '.sqlite');
  { A plain file copy is safe here because the product was stopped first. The write-ahead files are copied with it. }
  FileCopy(Db, Target, False);
  if FileExists(Db + '-wal') then FileCopy(Db + '-wal', Target + '-wal', False);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not StopRunningProduct then
    Result := 'SIZH IT Solution is busy (a call may be in progress) and could not be stopped safely. End the call, close SIZH IT Solution, and run this setup again. Nothing was changed.';
  if Result = '' then BackUpDatabase;
end;

procedure CheckModemDriver;
var
  ResultCode: Integer;
  Msg: String;
begin
  { Read only: Windows is asked, the modem is not. A problem here does not fail the install (the modem may simply not be plugged in yet). }
  if not Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\check-modem-driver.ps1') + '" -Json', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then exit;
  case ResultCode of
    0: exit;
    10: Msg := 'No modem was found on USB. Plug it in (directly into the computer), then run "Check the modem and driver" from the Start menu.';
    11, 12, 13, 14: Msg := 'The modem is not fully set up: Windows is missing a working driver for it (or for its AT or USB audio port).' + #13#10#13#10 + 'SIZH IT Solution does not include a modem driver. Install the official Windows USB driver for your modem, which the modem maker provides (or the seller of your modem), then unplug and re-plug the modem and run "Check the modem and driver" from the Start menu. Do not use a driver from an unofficial site.';
    15: Msg := 'The Microsoft Visual C++ Redistributable 2015-2022 (x64) is not installed. Install it from Microsoft, then start SIZH IT Solution.';
  else
    Msg := 'The modem check reported a problem (code ' + IntToStr(ResultCode) + '). Run "Check the modem and driver" from the Start menu for details.';
  end;
  MsgBox(Msg, mbInformation, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then CheckModemDriver;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if CurUninstallStep = usPostUninstall then begin
    Data := ExpandConstant(DataDir);
    if DirExists(Data) then begin
      { The default is to KEEP the customer's data. It is removed only after an explicit Yes. }
      if MsgBox('Do you also want to delete your data (call history, recordings, campaigns, settings, saved API keys and backups) in' + #13#10 + Data + '?' + #13#10#13#10 + 'Choose No to keep it. A later reinstall will find it again.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      begin
        DelTree(Data, True, True, True);
        { the key that protects saved API keys goes with the data it protected, and only then }
        DelTree(ExpandConstant('{commonappdata}\SimGatewaySecrets'), True, True, True);
      end;
    end;
  end;
end;
