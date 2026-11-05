// SIZH IT Solution start guard. Installed OUTSIDE the program folder (%LOCALAPPDATA%\SIZH IT Solution) and used by every shortcut, because
// the program folder can be briefly absent if an automatic update was interrupted (a crash or power loss between its two renames), and a
// shortcut that points into it would then do nothing. The guard first repairs an interrupted update, then runs the real launcher.
//
// It never touches the modem, the database or any setting. Usage (from the icons):  SimGatewayStart.js [--no-browser | --stop [--force] | --reset-secrets]
var shell = new ActiveXObject('WScript.Shell');
var fso = new ActiveXObject('Scripting.FileSystemObject');
var sysEnv = shell.Environment('Process');

function say(text, icon) {
  shell.Popup(text, 0, 'SIZH IT Solution', icon);
}

var local = shell.ExpandEnvironmentStrings('%LOCALAPPDATA%');
var appDir = sysEnv('SIMGW_APP_DIR') || (local + '\\Programs\\SIZH IT Solution'); // the variable is only set by tests
var dataDir = sysEnv('SIMGW_DATA_DIR') || (shell.ExpandEnvironmentStrings('%ProgramData%') + '\\SimGateway');
var target = appDir + '\\SimGateway.js';
var updates = dataDir + '\\updates';

var extra = [];
for (var i = 0; i < WScript.Arguments.length; i++) extra.push(WScript.Arguments(i));

// An update that was started and never finished leaves a journal. Repair it with the copy of Node and the runner that the update itself
// saved in the data folder (the program folder may not exist right now). Exit 2 = an update is still being installed; 3 = nothing usable.
if (fso.FileExists(updates + '\\journal.json') && fso.FileExists(updates + '\\runner\\node.exe') && fso.FileExists(updates + '\\runner\\update-runner.mjs')) {
  var fixed = shell.Run('"' + updates + '\\runner\\node.exe" "' + updates + '\\runner\\update-runner.mjs" --recover "' + dataDir + '"', 0, true);
  if (fixed === 2) {
    say('An update is being installed. Please try again in a minute.', 64);
    WScript.Quit(2);
  }
  if (fixed === 3) {
    say('An interrupted update could not be repaired automatically.\n\nRun the SIZH IT Solution installer again. Your data, settings and saved keys are kept.', 16);
    WScript.Quit(2);
  }
}

if (!fso.FileExists(target)) {
  say('SIZH IT Solution\'s program files are missing.\n\nRun the SIZH IT Solution installer again to repair it. Your data, settings and saved keys are kept.', 16);
  WScript.Quit(2);
}

// 0 = hidden window; true = wait. The real launcher shows its own messages.
WScript.Quit(shell.Run('"' + shell.ExpandEnvironmentStrings('%SystemRoot%') + '\\System32\\wscript.exe" //B //Nologo "' + target + '"' + (extra.length ? ' ' + extra.join(' ') : ''), 0, true));
