// SIZH IT Solution launcher stub. Run by wscript.exe (the Start-menu and desktop icons), so the customer sees no console window and types no
// command. It runs the real launcher with the Node that is bundled in the program folder, waits for it, and explains the one thing it
// cannot: Node itself failing to start. Everything else (readiness, errors, the log location) is the launcher's job.
//
// Usage (from the icons):  SimGateway.js [--no-browser | --stop [--force]]
var shell = new ActiveXObject('WScript.Shell');
var fso = new ActiveXObject('Scripting.FileSystemObject');
var appDir = fso.GetParentFolderName(WScript.ScriptFullName);
var node = appDir + '\\runtime\\node.exe';
var launch = appDir + '\\gateway\\dist\\supervisor\\launch.js';

var extra = [];
for (var i = 0; i < WScript.Arguments.length; i++) extra.push(WScript.Arguments(i));
var stopping = extra.join(' ').indexOf('--stop') >= 0;

function say(text, icon, seconds) {
  // 16 = error, 64 = information; the window closes itself after `seconds` (0 = stays).
  shell.Popup(text, seconds || 0, 'SIZH IT Solution', icon);
}

if (!fso.FileExists(node) || !fso.FileExists(launch)) {
  say('SIZH IT Solution\'s program files are missing.\n\nRun the SIZH IT Solution installer again to repair it.', 16);
  WScript.Quit(2);
}

shell.Environment('Process')('SIMGW_APP_DIR') = appDir;
// Window style 0 = hidden; true = wait for it to finish.
var code = shell.Run('"' + node + '" "' + launch + '"' + (extra.length ? ' ' + extra.join(' ') : ''), 0, true);

if (stopping) {
  if (code === 0) say('SIZH IT Solution has stopped.', 64, 5);
  else if (code === 3) say('A call is in progress, so SIZH IT Solution was not stopped. End the call first.', 64);
  else say('SIZH IT Solution could not be stopped cleanly (code ' + code + '). Restarting the computer will stop it.', 16);
} else if (code !== 0 && code !== 1) {
  // The launcher itself shows its own messages for code 1. Any other code means the bundled Node did not even start.
  var hex = (code >>> 0).toString(16).toUpperCase();
  say('SIZH IT Solution could not start (system error 0x' + hex + ').\n\nIf Windows mentions "VCRUNTIME140.dll" or "MSVCP140.dll", install "Microsoft Visual C++ Redistributable 2015-2022 (x64)" from Microsoft and try again.\n\nOtherwise run the SIZH IT Solution installer again to repair it.', 16);
}
WScript.Quit(code);
