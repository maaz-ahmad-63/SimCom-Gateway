<#
.SYNOPSIS
  Builds the customer package: a self-contained folder (installer\stage\app) and, when Inno Setup 7 (or 6.3+) is installed, the setup program.

.DESCRIPTION
  Run from the repository root on a Windows build machine:   powershell -File installer\build-package.ps1
  Add -SkipInstaller to only assemble the folder (what the setup program installs).

  What goes into the package, and what never does:
    IN : the built gateway, the built dashboard (a self-contained Next.js server), PRODUCTION dependencies only (with the
         Windows native modules), the supervisor, and a copy of node.exe (so the customer installs no Node.js).
    OUT: .env files, API keys, the development database, recordings, audio dumps, logs, tests, source maps of private data.
  The script refuses to finish if it finds an .env file, a database file or anything that looks like a key in the folder.

  It never starts, stops or restarts the live gateway, never touches the modem, and writes only inside installer\stage and
  installer\out, plus build output folders that are already ignored (dist, .next-package).
#>
[CmdletBinding()]
param(
  [switch]$SkipInstaller,
  [string]$NodeExe = (Get-Command node).Source,
  # Authenticode signing of the setup program and its uninstaller. A trusted code-signing certificate (from a certificate authority) must be
  # installed in the Windows certificate store; give its SHA-1 thumbprint here or in SIMGW_SIGN_THUMBPRINT. signtool.exe comes from the
  # Windows SDK (or SIMGW_SIGNTOOL). Without a certificate the setup program is built UNSIGNED and the script says so.
  [string]$SignThumbprint = $env:SIMGW_SIGN_THUMBPRINT,
  [string]$TimestampUrl = $(if ($env:SIMGW_SIGN_TIMESTAMP_URL) { $env:SIMGW_SIGN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }),
  # A release build: refuse to finish unless the setup program is validly signed.
  [switch]$RequireSigning
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Stage = Join-Path $PSScriptRoot 'stage'
$App = Join-Path $Stage 'app'
$Out = Join-Path $PSScriptRoot 'out'

function Step([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Run([string]$exe, [string[]]$a, [string]$cwd = $Root, [hashtable]$env = @{}) {
  $old = @{}
  foreach ($k in $env.Keys) { $old[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $env[$k]) }
  Push-Location $cwd
  try { & $exe @a; if ($LASTEXITCODE -ne 0) { throw "$exe $($a -join ' ') failed with exit code $LASTEXITCODE" } }
  finally { Pop-Location; foreach ($k in $env.Keys) { [Environment]::SetEnvironmentVariable($k, $old[$k]) } }
}

$version = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
Step "Building SIZH IT Solution $version"

Step 'Check the build tree: every node_modules must be a real folder, not a link'
# Next.js copies the dashboard's runtime dependencies (next, react, ...) into its self-contained folder by tracing which files it loads. When
# node_modules is a junction or symbolic link (for example a git worktree borrowing another checkout's node_modules), those files resolve to a
# path OUTSIDE this checkout and are silently left out. The packaged dashboard then stops at once with "Cannot find module 'next'" (exit 1).
foreach ($nm in 'node_modules', 'packages\dashboard\node_modules', 'packages\gateway\node_modules', 'packages\shared\node_modules') {
  $p = Join-Path $Root $nm
  if (Test-Path $p) {
    $item = Get-Item -LiteralPath $p -Force
    if ($item.LinkType) { throw "$nm is a $($item.LinkType) (to $($item.Target)). Build from a checkout with its own 'npm install': a linked node_modules makes the packaged dashboard miss its dependencies. Nothing was packaged." }
  }
}

Step 'Clean staging folder (installer\stage only)'
if (Test-Path $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $App, $Out | Out-Null

Step 'Build shared and gateway (TypeScript) into installer\stage\_build, NOT into their normal dist folders'
# A running development gateway (tsx watch) imports packages\shared\dist, so rebuilding it there restarts that gateway. The package is therefore
# compiled into its own folder and the development folders are never written to. (Only if packages\shared\dist does not exist at all, which
# means no development gateway can be running from this checkout, is it built there, because the gateway's type check needs it.)
$Build = Join-Path $Stage '_build'
$Tsc = Join-Path $Root 'node_modules\typescript\bin\tsc'
$sharedIndex = Join-Path $Root 'packages\shared\dist\index.js'
if (-not (Test-Path $sharedIndex)) { Run 'node' @($Tsc, '-p', 'packages\shared') }
$sharedStamp = (Get-Item $sharedIndex).LastWriteTimeUtc
Run 'node' @($Tsc, '-p', 'packages\shared', '--outDir', (Join-Path $Build 'shared'))
Run 'node' @($Tsc, '-p', 'packages\gateway', '--outDir', (Join-Path $Build 'gateway'))

Step 'Build the dashboard as a self-contained server (own folder, does not disturb a running dev server)'
Run 'npm' @('run', 'build', '--workspace=@sim-gateway/dashboard') $Root @{ SIMGW_PACKAGE_BUILD = '1'; NEXT_TELEMETRY_DISABLED = '1' }
if ((Get-Item $sharedIndex).LastWriteTimeUtc -ne $sharedStamp) { throw 'packages\shared\dist was rewritten during packaging. That would restart a running development gateway. Packaging must never write there.' }

Step 'Production dependencies only, installed in a throw-away workspace so the real node_modules is untouched'
$Deps = Join-Path $Stage '_deps'
New-Item -ItemType Directory -Force -Path (Join-Path $Deps 'packages\gateway'), (Join-Path $Deps 'packages\shared') | Out-Null
Copy-Item (Join-Path $Root 'package.json'), (Join-Path $Root 'package-lock.json') $Deps
Copy-Item (Join-Path $Root 'packages\gateway\package.json') (Join-Path $Deps 'packages\gateway')
Copy-Item (Join-Path $Root 'packages\shared\package.json') (Join-Path $Deps 'packages\shared')
# Only the gateway and shared workspaces: the dashboard brings its own minimal dependencies in its standalone folder.
$rootPkg = Get-Content (Join-Path $Deps 'package.json') -Raw | ConvertFrom-Json
$rootPkg.workspaces = @('packages/gateway', 'packages/shared')
$rootPkg | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $Deps 'package.json') -Encoding utf8
Run 'npm' @('install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts=false') $Deps

Step 'Assemble the program folder'
$Gw = Join-Path $App 'gateway'
New-Item -ItemType Directory -Force -Path $Gw, (Join-Path $App 'runtime'), (Join-Path $App 'dashboard') | Out-Null
Copy-Item $NodeExe (Join-Path $App 'runtime\node.exe')
Copy-Item (Join-Path $Build 'gateway') (Join-Path $Gw 'dist') -Recurse
Copy-Item (Join-Path $Root 'packages\gateway\package.json') $Gw
# The program reports the version it was built as, not the development checkout's.
$gwPkg = Get-Content (Join-Path $Gw 'package.json') -Raw | ConvertFrom-Json
$gwPkg.version = $version
# Written without a byte-order mark (Windows PowerShell's -Encoding utf8 adds one), which the program's version reader cannot parse.
[IO.File]::WriteAllText((Join-Path $Gw 'package.json'), ($gwPkg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
Copy-Item (Join-Path $Deps 'node_modules') (Join-Path $Gw 'node_modules') -Recurse
# Workspace links become real folders, so the package has no link back to the build machine.
$sharedLink = Join-Path $Gw 'node_modules\@sim-gateway\shared'
if (Test-Path $sharedLink) { Remove-Item -LiteralPath $sharedLink -Recurse -Force }
New-Item -ItemType Directory -Force -Path $sharedLink | Out-Null
Copy-Item (Join-Path $Build 'shared\*') $sharedLink -Recurse
Copy-Item (Join-Path $Root 'packages\shared\package.json') $sharedLink
$gwLink = Join-Path $Gw 'node_modules\@sim-gateway\gateway'
if (Test-Path $gwLink) { Remove-Item -LiteralPath $gwLink -Recurse -Force }

$dashStandalone = Join-Path $Root 'packages\dashboard\.next-package\standalone'
Copy-Item "$dashStandalone\*" (Join-Path $App 'dashboard') -Recurse
$dashHome = Join-Path $App 'dashboard\packages\dashboard'
New-Item -ItemType Directory -Force -Path (Join-Path $dashHome '.next-package') | Out-Null
Copy-Item (Join-Path $Root 'packages\dashboard\.next-package\static') (Join-Path $dashHome '.next-package\static') -Recurse
if (Test-Path (Join-Path $Root 'packages\dashboard\public')) { Copy-Item (Join-Path $Root 'packages\dashboard\public') (Join-Path $dashHome 'public') -Recurse }

Copy-Item (Join-Path $PSScriptRoot 'scripts\*') $App
# The publisher's PUBLIC update key (the private key never enters this repository). Without it the product runs but reports that updates are not set up.
$updKey = Join-Path $PSScriptRoot 'update\public-key.pem'
if (Test-Path $updKey) { New-Item -ItemType Directory -Force -Path (Join-Path $App 'update') | Out-Null; Copy-Item $updKey (Join-Path $App 'update\public-key.pem') } else { Write-Host '  note: installer\update\public-key.pem not found; this package cannot verify updates' -ForegroundColor Yellow }
@{ name = 'SIZH IT Solution'; version = $version; builtAt = (Get-Date).ToUniversalTime().ToString('o'); node = (& $NodeExe --version) } | ConvertTo-Json | ForEach-Object { [IO.File]::WriteAllText((Join-Path $App 'VERSION.json'), $_, (New-Object Text.UTF8Encoding $false)) }
Remove-Item -LiteralPath $Deps -Recurse -Force
Remove-Item -LiteralPath $Build -Recurse -Force

Step 'Check the program starts from these files: every entry point the launcher and the supervisor need must exist'
$mustExist = 'runtime\node.exe', 'SimGateway.js', 'check-modem-driver.ps1', 'gateway\dist\supervisor\launch.js', 'gateway\dist\supervisor\main.js', 'gateway\dist\supervisor\update\runner.js', 'gateway\dist\supervisor\gateway-entry.js', 'gateway\dist\index.js', 'dashboard\packages\dashboard\server.js', 'dashboard\packages\dashboard\.next-package\static', 'gateway\node_modules\better-sqlite3\build\Release\better_sqlite3.node', 'gateway\node_modules\@serialport\bindings-cpp\prebuilds\win32-x64\node.napi.node', 'gateway\node_modules\@sim-gateway\shared\index.js'
$missing = $mustExist | Where-Object { -not (Test-Path (Join-Path $App $_)) }
if ($missing) { $missing | ForEach-Object { Write-Host "  missing: $_" -ForegroundColor Red }; throw 'The package is incomplete. Nothing was packaged.' }
Write-Host '  complete' -ForegroundColor Green

Step 'Check the packaged dashboard: its runtime dependencies resolve, and it really starts and answers'
$dashDir = Join-Path $App 'dashboard\packages\dashboard'
$bundledNode = Join-Path $App 'runtime\node.exe'
# The same resolution the dashboard does at start, from its own folder, with the bundled Node (not this machine's).
Push-Location $dashDir
try {
  & $bundledNode -e "for (const m of ['next', 'react', 'react-dom']) { try { require.resolve(m) } catch { console.error('missing: ' + m); process.exitCode = 3 } }"
  $resolved = $LASTEXITCODE
} finally { Pop-Location }
if ($resolved -ne 0) { throw 'The packaged dashboard cannot load its own dependencies (see "missing:" above). The installed dashboard would stop at start with exit code 1. Nothing was packaged.' }
$smokePort = 39871
while (Get-NetTCPConnection -LocalPort $smokePort -State Listen -ErrorAction SilentlyContinue) { $smokePort++ }
$smokeErr = Join-Path $Stage 'dashboard-smoke.err'
$smokeOut = Join-Path $Stage 'dashboard-smoke.out'
$hadCache = Test-Path (Join-Path $dashDir '.next-package\cache')
$saved = @{}; foreach ($k in 'PORT', 'HOSTNAME', 'NODE_ENV') { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
[Environment]::SetEnvironmentVariable('PORT', "$smokePort"); [Environment]::SetEnvironmentVariable('HOSTNAME', '127.0.0.1'); [Environment]::SetEnvironmentVariable('NODE_ENV', 'production')
try {
  $proc = Start-Process -FilePath $bundledNode -ArgumentList 'server.js' -WorkingDirectory $dashDir -PassThru -WindowStyle Hidden -RedirectStandardError $smokeErr -RedirectStandardOutput $smokeOut
} finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
$answered = $false
try {
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$smokePort/" -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 5 -ErrorAction Stop
      if ($r.StatusCode -lt 500) { $answered = $true; break }
    } catch {
      $code = $_.Exception.Response.StatusCode.value__
      if ($code -and $code -lt 500) { $answered = $true; break }
    }
    Start-Sleep -Milliseconds 500
  }
} finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
if (-not $hadCache) { Remove-Item -LiteralPath (Join-Path $dashDir '.next-package\cache') -Recurse -Force -ErrorAction SilentlyContinue }
if (-not $answered) {
  $why = if (Test-Path $smokeErr) { (Get-Content $smokeErr -Tail 15) -join "`n" } else { '' }
  throw "The packaged dashboard did not start and answer on port $smokePort (exit code $(if ($proc.HasExited) { $proc.ExitCode } else { 'none: no answer in 60 s' })).`n$why`nNothing was packaged."
}
Remove-Item -LiteralPath $smokeErr, $smokeOut -Force -ErrorAction SilentlyContinue
Write-Host "  the packaged dashboard started with the bundled Node and answered on port $smokePort" -ForegroundColor Green

Step 'Safety check: nothing private may be in the package'
$bad = @()
$bad += Get-ChildItem $App -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\.env($|\.)' -or $_.Extension -in '.sqlite', '.sqlite-wal', '.sqlite-shm', '.pcm', '.wav' -or $_.FullName -match '\\(recordings|call-recordings|audio-dumps|data\\backups)\\' }
# No modem driver (no redistribution license could be verified) and no Python: the agent is TypeScript, run by the bundled Node.
$bad += Get-ChildItem $App -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.inf', '.sys', '.cat', '.py', '.pyc', '.pyd' -or $_.Name -match '^python\d*(\.exe|\.dll)?$' -or $_.Name -match '^requirements.*\.txt$' }
# No encryption key for saved API keys may ever ship: it is made on the customer's PC at first start.
$bad += Get-ChildItem $App -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^master\.key' -or $_.FullName -match 'SimGatewaySecrets' }
$keyPattern = '(sk-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|GATEWAY_API_KEY=[0-9a-f]{32,}|SIMGATEWAY-SECRETS-KEY-V1:[0-9a-f]{64})'
$bad += Get-ChildItem $App -Recurse -Force -File -Include *.js, *.json, *.env, *.cmd, *.ps1, *.mjs -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 2MB } | Select-String -Pattern $keyPattern -List | ForEach-Object { Get-Item $_.Path }
if ($bad.Count -gt 0) { $bad | ForEach-Object { Write-Host "  private file: $($_.FullName)" -ForegroundColor Red }; throw 'The package contains files that must never be shipped. Nothing was packaged.' }
Write-Host '  clean' -ForegroundColor Green

if ($SkipInstaller) { Step "Package folder ready: $App"; return }

Step 'Compile the setup program (Inno Setup)'
# Inno Setup 7 is preferred; Inno Setup 6 (6.3 or newer, for x64compatible) still works. The first compiler found is used.
$iscc = @("$env:ProgramFiles\Inno Setup 7\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 7 (or 6.3 or newer) is not installed on this machine, so the setup program cannot be compiled. The package folder was assembled in installer\stage\app. Install Inno Setup (free) and run this script again.' }
Write-Host "  using $iscc"
$isccArgs = @("/DAppVersion=$version", "/O$Out")
if ($SignThumbprint) {
  $signtool = if ($env:SIMGW_SIGNTOOL) { $env:SIMGW_SIGNTOOL } else {
    Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $signtool -or -not (Test-Path $signtool)) { throw 'A signing certificate was given but signtool.exe was not found. Install the Windows SDK (Signing Tools) or set SIMGW_SIGNTOOL. Nothing was signed.' }
  $cert = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My -CodeSigningCert -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $SignThumbprint.Replace(' ', '').ToUpper() } | Select-Object -First 1
  if (-not $cert) { throw "No code-signing certificate with thumbprint $SignThumbprint is installed for this user or this computer. Nothing was signed." }
  if ($cert.NotAfter -lt (Get-Date)) { throw "The code-signing certificate expired on $($cert.NotAfter.ToString('yyyy-MM-dd')). Nothing was signed." }
  Write-Host "  signing with: $($cert.Subject) (valid until $($cert.NotAfter.ToString('yyyy-MM-dd')))"
  # SHA-256 file digest, RFC 3161 timestamp (the signature stays valid after the certificate expires).
  $isccArgs += @('/DSignBuild=1', "/Ssizh=`"$signtool`" sign /fd sha256 /tr $TimestampUrl /td sha256 /sha1 $($cert.Thumbprint) `$f")
} elseif ($RequireSigning) {
  throw 'This is a release build (-RequireSigning) but no code-signing certificate was given (-SignThumbprint or SIMGW_SIGN_THUMBPRINT). Nothing was built.'
}
Run $iscc ($isccArgs + @((Join-Path $PSScriptRoot 'SimGateway.iss')))
$setupExe = Join-Path $Out "SimGateway-Setup-$version.exe"
$signature = Get-AuthenticodeSignature $setupExe
if ($signature.Status -eq 'Valid') {
  Write-Host "  signed: $($signature.SignerCertificate.Subject); timestamped: $([bool]$signature.TimeStamperCertificate)" -ForegroundColor Green
} elseif ($SignThumbprint -or $RequireSigning) {
  throw "The setup program is not validly signed (signature status: $($signature.Status)). Do not release it."
} else {
  Write-Host '  UNSIGNED: no code-signing certificate was configured. Windows SmartScreen will show "Windows protected your PC" for this setup program.' -ForegroundColor Yellow
}
Step "Setup program: $setupExe"
