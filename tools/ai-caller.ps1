<#
.SYNOPSIS
  AI Caller Operations Menu: one entry point for gateway/dashboard hardware operations (Windows PowerShell 5.1+).

.DESCRIPTION
  Run with no arguments for the interactive menu, or pass a command:

    status | health | ports | modem-info | logs | report
    start-gateway | start-dashboard | start-all
    usb-status | usb-activate | usb-deactivate | menu | help

  Safety rules (enforced here AND by the gateway):
    - Uses the gateway's own HTTP API and x-api-key. It never opens a COM port and never sends AT commands itself.
    - Reads and health checks are AT-free (status, health, ports, usb-status, logs, report).
    - modem-info sends AT queries through the gateway and is refused while any call exists.
    - usb-activate / usb-deactivate need a typed confirmation. Activation is only allowed on an ACTIVE call (the
      gateway enforces the same rule); deactivation is refused while any call exists.
    - Never dials, answers, restarts the gateway, or edits .env. The API key is never printed.

.EXAMPLE
  .\tools\ai-caller.ps1
  .\tools\ai-caller.ps1 status
  .\tools\ai-caller.ps1 health
  .\tools\ai-caller.ps1 logs -Level error
  .\tools\ai-caller.ps1 report -OutFile report.txt
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('menu', 'status', 'health', 'ports', 'modem-info', 'logs', 'report', 'start-gateway', 'start-dashboard', 'start-all', 'usb-status', 'usb-activate', 'usb-deactivate', 'help')]
  [string]$Command,
  [string]$GatewayUrl,
  [string]$DashboardUrl,
  [string]$ApiKey,
  [ValidateSet('info', 'warn', 'error')][string]$Level = 'warn',
  [int]$Limit = 100,
  [string]$OutFile
)

$ErrorActionPreference = 'Stop'
$script:Root = Split-Path $PSScriptRoot -Parent
$script:KnownSecret = $null
$script:Placeholder = 'change-this-to-a-secure-random-token'

# ---------------------------------------------------------------- configuration (values never printed)

function Read-DotEnv([string]$Path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $Path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $v = $Matches[2].Trim()
      if ($v -match '^"(.*)"') { $v = $Matches[1] }
      elseif ($v -match "^'(.*)'") { $v = $Matches[1] }
      else { $v = ($v -replace '\s+#.*$', '').Trim() }
      $map[$Matches[1]] = $v
    }
  }
  return $map
}

function Get-Setting([string]$Name) {
  $fromProc = [Environment]::GetEnvironmentVariable($Name)
  if ($fromProc) { return $fromProc }
  $dotenv = Read-DotEnv (Join-Path $script:Root '.env')
  if ($dotenv.ContainsKey($Name)) { return $dotenv[$Name] }
  return $null
}

function Get-GatewayBase {
  if ($GatewayUrl) { return $GatewayUrl.TrimEnd('/') }
  if ($env:GATEWAY_URL) { return $env:GATEWAY_URL.TrimEnd('/') }
  $port = Get-Setting 'PORT'
  if (-not $port) { $port = '4000' }
  return "http://127.0.0.1:$port"
}

function Get-DashboardBase {
  if ($DashboardUrl) { return $DashboardUrl.TrimEnd('/') }
  if ($env:DASHBOARD_URL) { return $env:DASHBOARD_URL.TrimEnd('/') }
  return 'http://127.0.0.1:3000'
}

function Get-Key {
  $key = $ApiKey
  if (-not $key) { $key = $env:GATEWAY_API_KEY }
  if (-not $key) { $key = (Read-DotEnv (Join-Path $script:Root '.env'))['GATEWAY_API_KEY'] }
  if (-not $key) { throw 'No gateway API key: pass -ApiKey, set GATEWAY_API_KEY, or add it to .env.' }
  if ($key.Length -ge 8) { $script:KnownSecret = $key }
  return $key
}

# ---------------------------------------------------------------- redaction and output

function Protect-Text([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  $t = $Text
  if ($script:KnownSecret) { $t = $t.Replace($script:KnownSecret, '[REDACTED]') }
  $t = [regex]::Replace($t, '(?i)bearer\s+\S+', 'Bearer [REDACTED]')
  $t = [regex]::Replace($t, '(?i)(x-api-key|api[-_]?key|authorization|token|secret|password)(\s*[=:]\s*)\S+', '$1$2[REDACTED]')
  $t = [regex]::Replace($t, '(?i)\b(sk|gsk|pk)[-_][A-Za-z0-9_-]{8,}', '[REDACTED]')
  return $t
}

$script:Tally = @{ PASS = 0; WARN = 0; FAIL = 0 }

function Write-Result([string]$State, [string]$Name, [string]$Detail) {
  if ($script:Tally.ContainsKey($State)) { $script:Tally[$State]++ }
  $color = switch ($State) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } 'FAIL' { 'Red' } default { 'Gray' } }
  Write-Host ('[{0,-4}] {1}: {2}' -f $State, $Name, (Protect-Text $Detail)) -ForegroundColor $color
}

function Write-Info([string]$Text) { Write-Host (Protect-Text $Text) }
function Write-Err([string]$Text) { Write-Host ('ERROR: ' + (Protect-Text $Text)) -ForegroundColor Red }

# Indirection so tests can supply scripted input.
function Read-Input([string]$Prompt) { return Read-Host $Prompt }

# ---------------------------------------------------------------- gateway access (never throws)

function Invoke-Gateway([string]$Path, [string]$Method = 'GET', $Body = $null, [int]$TimeoutSec = 15) {
  $r = [pscustomobject]@{ Ok = $false; Status = 0; Data = $null; Error = $null; Code = $null }
  try { $key = Get-Key } catch { $r.Error = $_.Exception.Message; $r.Code = 'NO_KEY'; return $r }
  $p = @{ Uri = (Get-GatewayBase) + $Path; Method = $Method; Headers = @{ 'x-api-key' = $key }; TimeoutSec = $TimeoutSec; UseBasicParsing = $true }
  if ($null -ne $Body) { $p.Body = ($Body | ConvertTo-Json -Compress); $p.ContentType = 'application/json' }
  try {
    $resp = Invoke-WebRequest @p
    $r.Status = [int]$resp.StatusCode
    $r.Ok = $true
    if ($resp.Content) { try { $r.Data = $resp.Content | ConvertFrom-Json } catch { $r.Data = $resp.Content } }
  } catch {
    $ex = $_.Exception
    $text = $null
    if ($ex.Response) {
      try { $r.Status = [int]$ex.Response.StatusCode.value__ } catch { $r.Status = 0 }
      try { $text = (New-Object IO.StreamReader($ex.Response.GetResponseStream())).ReadToEnd() } catch { $text = $null }
    }
    if (-not $text -and $_.ErrorDetails -and $_.ErrorDetails.Message) { $text = $_.ErrorDetails.Message }
    $body = $null
    if ($text) { try { $body = $text | ConvertFrom-Json } catch { $body = $null } }
    if ($r.Status -gt 0) {
      $r.Code = if ($body -and $body.code) { [string]$body.code } elseif ($r.Status -eq 401) { 'UNAUTHORIZED' } else { "HTTP_$($r.Status)" }
      $r.Error = if ($body -and $body.error) { [string]$body.error } else { "HTTP $($r.Status)" }
      $r.Data = $body
    } elseif ($ex.Message -match 'timed out|timeout') {
      $r.Code = 'TIMEOUT'; $r.Error = "The gateway at $(Get-GatewayBase) did not answer within $TimeoutSec s."
    } else {
      $r.Code = 'UNREACHABLE'; $r.Error = "Could not reach the gateway at $(Get-GatewayBase): $($ex.Message)"
    }
  }
  $r.Error = Protect-Text $r.Error
  return $r
}

function Test-Tcp([string]$HostName, [int]$Port, [int]$TimeoutMs = 800) {
  $c = New-Object Net.Sockets.TcpClient
  try {
    $a = $c.BeginConnect($HostName, $Port, $null, $null)
    return ($a.AsyncWaitHandle.WaitOne($TimeoutMs) -and $c.Connected)
  } catch { return $false } finally { $c.Close() }
}

function Test-Url([string]$Url) {
  $u = [uri]$Url
  return (Test-Tcp $u.Host $u.Port)
}

function Get-Status {
  $s = Invoke-Gateway '/api/gateway/hardware/status'
  if (-not $s.Ok) { Write-Err "$($s.Code): $($s.Error)"; return $null }
  return $s.Data
}

# ---------------------------------------------------------------- read-only commands

function Show-Status {
  $s = Get-Status
  if (-not $s) { return }
  $call = if ($s.call) { "$($s.call.state) ($($s.call.direction))" } else { 'none' }
  Write-Info "Call: $call   Modem: $($s.modem.connectionState) (AT $($s.modem.atStatus))   Driver: $($s.gateway.driverType)$(if ($s.gateway.isSimulated) { ' [SIMULATED]' })"
  Write-Info "Configured ports: AT=$($s.modem.configuredAtPort) audio=$($s.modem.configuredAudioPort)"
  foreach ($l in $s.layers) { Write-Info ('{0,-8} {1}: {2}' -f $l.state.ToUpper(), $l.label, $l.detail) }
  if ($s.modem.reconnect -and $s.modem.reconnect.lastFailure) { Write-Info "Last failure: $($s.modem.reconnect.lastFailure.message)" }
}

function Show-Ports {
  $p = Invoke-Gateway '/api/gateway/hardware/ports'
  if (-not $p.Ok) { Write-Err "$($p.Code): $($p.Error)"; return }
  if (-not $p.Data.ports -or @($p.Data.ports).Count -eq 0) { Write-Info 'No serial ports were listed by Windows.' }
  foreach ($x in $p.Data.ports) { Write-Info ('{0,-8} MI_{1,-3} {2}' -f $x.path, $x.interface, $x.role) }
  foreach ($f in $p.Data.findings) { Write-Info "[$($f.level)] $($f.message)" }
  if ($p.Data.suggestedEnv) {
    Write-Info 'Suggested .env change (apply manually; nothing is changed here):'
    $p.Data.suggestedEnv.PSObject.Properties | ForEach-Object { Write-Info "  $($_.Name)=$($_.Value)" }
  }
}

function Show-ModemInfo {
  $s = Get-Status
  if (-not $s) { return }
  if ($s.call) { Write-Info "Blocked: a call is $($s.call.state). AT queries are not sent during a call. Nothing was sent."; return }
  $r = Invoke-Gateway '/api/gateway/hardware/modem-info'
  if (-not $r.Ok) { Write-Err "$($r.Code): $($r.Error)"; return }
  Write-Info ($r.Data | ConvertTo-Json -Depth 6)
}

function Show-Logs {
  $r = Invoke-Gateway "/api/gateway/hardware/logs?level=$Level&limit=$Limit"
  if (-not $r.Ok) { Write-Err "$($r.Code): $($r.Error)"; return }
  if (-not $r.Data.entries -or @($r.Data.entries).Count -eq 0) { Write-Info "No $Level-level log lines are buffered."; return }
  foreach ($e in $r.Data.entries) { Write-Info $e.line }
}

function Show-Report {
  $r = Invoke-Gateway '/api/gateway/hardware/report'
  if (-not $r.Ok) { Write-Err "$($r.Code): $($r.Error)"; return }
  $text = Protect-Text ([string]$r.Data.report)
  $footer = "`nOperator tool: gateway=$(Get-GatewayBase) dashboard=$(Get-DashboardBase) host=$env:COMPUTERNAME powershell=$($PSVersionTable.PSVersion)"
  $text = $text + $footer
  if ($OutFile) { Set-Content -Path $OutFile -Value $text -Encoding UTF8; Write-Info "Report written to $OutFile" } else { Write-Host $text }
}

# ---------------------------------------------------------------- health

function Invoke-HealthCheck {
  $script:Tally = @{ PASS = 0; WARN = 0; FAIL = 0 }
  Write-Info "Gateway $(Get-GatewayBase)   Dashboard $(Get-DashboardBase)"
  $s = Invoke-Gateway '/api/gateway/hardware/status' 'GET' $null 10
  if (-not $s.Ok) {
    $hint = switch ($s.Code) {
      'UNAUTHORIZED' { 'the API key was rejected (check GATEWAY_API_KEY matches the running gateway)' }
      'NO_KEY' { $s.Error }
      'UNREACHABLE' { 'is the gateway running? use menu option 7' }
      'TIMEOUT' { 'the gateway is not answering' }
      default { $s.Error }
    }
    Write-Result 'FAIL' 'Gateway API' "$($s.Code): $hint"
    Write-Result 'INFO' 'Skipped' 'modem, audio and AI checks need the gateway'
  } else {
    $d = $s.Data
    Write-Result 'PASS' 'Gateway API' "reachable and authenticated; uptime $($d.gateway.uptimeSeconds)s, driver $($d.gateway.driverType)"
    if ($d.gateway.isSimulated) { Write-Result 'WARN' 'Modem driver' 'SIMULATED (mock) driver: nothing here proves real hardware works' }
    switch ($d.modem.connectionState) {
      'READY' { Write-Result 'PASS' 'Modem' "READY (AT $($d.modem.atStatus))" }
      { $_ -in 'DISCONNECTED', 'ERROR' } {
        $why = if ($d.modem.reconnect -and $d.modem.reconnect.lastFailure) { "; last failure: $($d.modem.reconnect.lastFailure.message)" } else { '' }
        Write-Result 'FAIL' 'Modem' "$($d.modem.connectionState)$why"
      }
      default { Write-Result 'WARN' 'Modem' "$($d.modem.connectionState) (not READY yet)" }
    }
    if ($d.call) { Write-Result 'INFO' 'Call' "$($d.call.state) ($($d.call.direction)); AT queries are skipped" } else { Write-Result 'INFO' 'Call' 'none' }

    $ports = Invoke-Gateway '/api/gateway/hardware/ports' 'GET' $null 10
    if (-not $ports.Ok) { Write-Result 'WARN' 'COM ports' "could not list: $($ports.Error)" }
    else {
      $bad = @($ports.Data.findings | Where-Object { $_.level -ne 'info' })
      if ($bad.Count -eq 0) { Write-Result 'PASS' 'COM ports' "configured AT=$($ports.Data.configured.at) audio=$($ports.Data.configured.audio) match what Windows lists" }
      foreach ($f in $bad) { Write-Result $(if ($f.level -eq 'error') { 'FAIL' } else { 'WARN' }) 'COM ports' $f.message }
    }

    # Audio is judged per layer. An open port alone is never healthy.
    $byKey = @{}; foreach ($layer in $d.layers) { $byKey[$layer.key] = $layer }
    if ($byKey['audioPortOpen'] -and $byKey['freshPcm']) {
      $open = $byKey['audioPortOpen'].state; $reg = $byKey['usbAudioRegistered'].state; $pcm = $byKey['freshPcm'].state
      if (-not $d.call) {
        Write-Result 'WARN' 'Audio streaming' 'no call: port, registration and PCM freshness can only be judged during a call'
      } else {
        Write-Result $(if ($open -eq 'ok') { 'PASS' } else { 'FAIL' }) 'Audio port open' $byKey['audioPortOpen'].detail
        Write-Result $(if ($reg -eq 'ok') { 'PASS' } elseif ($reg -eq 'unknown') { 'WARN' } else { 'FAIL' }) 'USB audio registered' $byKey['usbAudioRegistered'].detail
        if ($pcm -eq 'ok') { Write-Result 'PASS' 'Fresh PCM frames' $byKey['freshPcm'].detail }
        elseif ($open -eq 'ok') { Write-Result 'FAIL' 'Fresh PCM frames' "port is open but no fresh frames: $($byKey['freshPcm'].detail)" }
        else { Write-Result 'FAIL' 'Fresh PCM frames' $byKey['freshPcm'].detail }
      }
      Write-Result 'WARN' 'Playback verified' 'NOT VERIFIED: bytes written never prove the other party heard anything'
    }

    $ai = Invoke-Gateway '/api/ai/readiness' 'GET' $null 10
    if (-not $ai.Ok) { Write-Result 'WARN' 'AI readiness' "$($ai.Code): $($ai.Error)" }
    else {
      $a = $ai.Data
      if ($a.mode -eq 'off') { Write-Result 'WARN' 'AI readiness' 'AI is off (AI_ENABLED=false or mode off)' }
      elseif ($a.simulatedHardware -and -not $a.ok) { Write-Result 'WARN' 'AI readiness' 'simulated hardware can never make the agent ready' }
      elseif ($a.ok) { Write-Result 'PASS' 'AI readiness' 'every readiness check passed' }
      elseif ($a.passiveOk) { Write-Result 'WARN' 'AI readiness' "passive only; replies blocked: $(@($a.blockers)[0])" }
      elseif (-not $d.call) { Write-Result 'WARN' 'AI readiness' "cannot be fully judged without a call (agent is configured; first blocker: $(@($a.passiveBlockers + $a.blockers)[0]))" }
      else { Write-Result 'FAIL' 'AI readiness' "blocked: $(@($a.passiveBlockers + $a.blockers)[0])" }
    }
  }

  if ($s.Ok) {
    $rec = Invoke-Gateway '/api/gateway/recordings' 'GET' $null 10
    if ($rec.Ok -and $rec.Data.status) {
      $rs = $rec.Data.status
      if ($rs.lastError) { Write-Result 'WARN' 'Call recording' "error: $($rs.lastError)" }
      elseif ($rs.inactiveReason) { Write-Result 'INFO' 'Call recording' $rs.inactiveReason }
      else { Write-Result 'PASS' 'Call recording' "armed; $(@($rec.Data.recordings).Count) saved" }
    }
  }

  if (Test-Url (Get-DashboardBase)) {
    try { $w = Invoke-WebRequest -Uri (Get-DashboardBase) -UseBasicParsing -TimeoutSec 8; Write-Result 'PASS' 'Dashboard' "serving $(Get-DashboardBase) (HTTP $([int]$w.StatusCode))" }
    catch { Write-Result 'WARN' 'Dashboard' "port is open but the page failed: $($_.Exception.Message)" }
  } else { Write-Result 'WARN' 'Dashboard' "nothing listening at $(Get-DashboardBase) (menu option 8 starts it)" }

  $t = $script:Tally
  Write-Host ''
  $verdict = if ($t.FAIL -gt 0) { 'NOT HEALTHY' } elseif ($t.WARN -gt 0) { 'OK WITH WARNINGS' } else { 'HEALTHY' }
  Write-Info "Summary: $($t.PASS) pass, $($t.WARN) warn, $($t.FAIL) fail -> $verdict"
}

# ---------------------------------------------------------------- starting services

function Test-GatewayEnv {
  $ok = $true
  $envPath = Join-Path $script:Root '.env'
  if (-not (Test-Path -LiteralPath $envPath)) { Write-Result 'FAIL' 'Gateway .env' ".env not found at the repo root; copy .env.example yourself (this tool never writes .env)"; return $false }
  $key = Get-Setting 'GATEWAY_API_KEY'
  if (-not $key) { Write-Result 'FAIL' 'GATEWAY_API_KEY' 'not set'; $ok = $false }
  elseif ($key -eq $script:Placeholder -or $key.Length -lt 8) { Write-Result 'FAIL' 'GATEWAY_API_KEY' 'is the placeholder or shorter than 8 characters'; $ok = $false }
  else { Write-Result 'PASS' 'GATEWAY_API_KEY' 'set' }
  $driver = Get-Setting 'MODEM_DRIVER'
  if ($driver -eq 'hardware') {
    foreach ($n in 'MODEM_AT_PORT', 'MODEM_AUDIO_PORT') {
      if (Get-Setting $n) { Write-Result 'PASS' $n 'set' } else { Write-Result 'FAIL' $n 'not set (required for MODEM_DRIVER=hardware; run the ports command)'; $ok = $false }
    }
  } else { Write-Result 'INFO' 'MODEM_DRIVER' "$(if ($driver) { $driver } else { 'unset (mock)' })" }
  return $ok
}

function Test-DashboardEnv {
  $files = @((Join-Path $script:Root 'packages\dashboard\.env.local'), (Join-Path $script:Root 'packages\dashboard\.env'))
  $vals = @{}
  foreach ($f in $files) { $m = Read-DotEnv $f; foreach ($k in $m.Keys) { if (-not $vals.ContainsKey($k)) { $vals[$k] = $m[$k] } } }
  foreach ($n in 'NEXT_PUBLIC_GATEWAY_URL', 'NEXT_PUBLIC_GATEWAY_API_KEY') {
    $v = if ($vals[$n]) { $vals[$n] } else { [Environment]::GetEnvironmentVariable($n) }
    if (-not $v) { Write-Result 'WARN' $n 'not set; the dashboard falls back to defaults or the browser Settings page' }
    elseif ($v -eq $script:Placeholder) { Write-Result 'WARN' $n 'still the placeholder value' }
    else { Write-Result 'PASS' $n 'set' }
  }
  return $true
}

function Start-ProjectService([string]$Name, [string]$Url, [string]$NpmScript) {
  $u = [uri]$Url
  if (Test-Tcp $u.Host $u.Port) { Write-Result 'INFO' $Name "already running at $Url (not starting a duplicate)"; return }
  $logDir = Join-Path $script:Root 'logs'
  if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
  $log = Join-Path $logDir ("{0}-{1}.log" -f $Name.ToLower(), (Get-Date -Format 'yyyyMMdd-HHmmss'))
  $inner = "`$Host.UI.RawUI.WindowTitle = 'AI Caller $Name'; Set-Location -LiteralPath '$($script:Root)'; cmd /c `"npm run $NpmScript 2>&1`" | Tee-Object -FilePath '$log'"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit', '-NoProfile', '-EncodedCommand', $encoded) -WorkingDirectory $script:Root | Out-Null
  Write-Info "Starting $Name in its own window (npm run $NpmScript). Log: $log"
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 1; if (Test-Tcp $u.Host $u.Port) { Write-Result 'PASS' $Name "listening at $Url"; return } }
  Write-Result 'WARN' $Name "not listening at $Url after 30 s; check the new window and $log"
}

function Start-GatewayService {
  $script:Tally = @{ PASS = 0; WARN = 0; FAIL = 0 }
  if (-not (Test-GatewayEnv)) { Write-Err 'Gateway not started: fix the items above.'; return }
  $dist = Join-Path $script:Root 'packages\gateway\dist\index.js'
  if (-not (Test-Path -LiteralPath $dist)) { Write-Result 'FAIL' 'Gateway build' "missing packages\gateway\dist\index.js; run: npm run build"; return }
  $newest = Get-ChildItem -Path (Join-Path $script:Root 'packages\gateway\src'), (Join-Path $script:Root 'packages\shared\src') -Recurse -Filter *.ts -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newest -and $newest.LastWriteTime -gt (Get-Item -LiteralPath $dist).LastWriteTime) {
    Write-Result 'WARN' 'Gateway build' "dist is older than source ($($newest.Name)); it will run the OLD build. Build first with: npm run build"
    if ((Read-Input 'Start the older build anyway? (type YES)') -ne 'YES') { Write-Info 'Not started.'; return }
  }
  Start-ProjectService 'Gateway' (Get-GatewayBase) 'start:gateway'
}

function Start-DashboardService {
  $script:Tally = @{ PASS = 0; WARN = 0; FAIL = 0 }
  [void](Test-DashboardEnv)
  $npm = 'start:dashboard'
  if (-not (Test-Path -LiteralPath (Join-Path $script:Root 'packages\dashboard\.next\BUILD_ID'))) {
    Write-Result 'WARN' 'Dashboard build' 'no production build found (packages\dashboard\.next\BUILD_ID); using the dev server (dev:dashboard). Run npm run build for production.'
    $npm = 'dev:dashboard'
  }
  Start-ProjectService 'Dashboard' (Get-DashboardBase) $npm
}

# ---------------------------------------------------------------- USB audio (existing gateway diagnostic endpoint only)

function Show-UsbStatus {
  $s = Get-Status
  if (-not $s) { return }
  Write-Info "Call: $(if ($s.call) { $s.call.state } else { 'none' })   USB audio diagnostic endpoint: $(if ($s.gateway.usbAudioDiagnosticEnabled) { 'enabled' } else { 'DISABLED (ENABLE_USB_AUDIO_DIAGNOSTIC)' })"
  foreach ($k in 'audioPortOpen', 'usbAudioRegistered', 'freshPcm', 'playbackVerified') {
    $l = $s.layers | Where-Object { $_.key -eq $k }
    if ($l) { Write-Info ('{0,-8} {1}: {2}' -f $l.state.ToUpper(), $l.label, $l.detail) }
  }
  if ($s.audio) { Write-Info "PCM received: $($s.audio.bytesReceived) bytes / $($s.audio.framesReceived) frames; last frame $(if ($null -eq $s.audio.msSinceLastFrame) { 'never' } else { "$($s.audio.msSinceLastFrame) ms ago" })" }
  if ($s.usbAudio) { Write-Info ('USB audio state: ' + ($s.usbAudio | ConvertTo-Json -Depth 4 -Compress)) }
  Write-Info 'Port open, registration and fresh PCM are separate facts; playback is never marked verified here.'
}

function Invoke-UsbToggle([ValidateSet('activate', 'deactivate')][string]$Action) {
  $s = Get-Status
  if (-not $s) { return }
  if ($s.gateway.isSimulated) { Write-Info 'Blocked: the gateway is using the simulated driver.'; return }
  if (-not $s.gateway.usbAudioDiagnosticEnabled) { Write-Info 'Blocked: the gateway has the USB audio diagnostic disabled (ENABLE_USB_AUDIO_DIAGNOSTIC).'; return }
  $registered = ($s.usbAudio -and $s.usbAudio.registrationActive -eq $true)
  if ($Action -eq 'activate') {
    if (-not $s.call -or $s.call.state -ne 'ACTIVE') { Write-Info "Blocked: activation is only valid on an ACTIVE call (the gateway enforces this). Current call: $(if ($s.call) { $s.call.state } else { 'none' }). Nothing was sent."; return }
    if ($registered) { Write-Info 'Blocked: USB audio is already registered. Nothing was sent.'; return }
    Write-Info 'This sends AT+CPCMREG=1 on the LIVE call through the gateway. It does not hang up or dial.'
    $word = 'ACTIVATE'
  } else {
    if ($s.call) { Write-Info "Blocked: a call is $($s.call.state). Deactivating USB audio mid-call would cut the audio. Nothing was sent."; return }
    if (-not $registered) { Write-Info 'Nothing to deactivate: USB audio is not registered.'; return }
    Write-Info 'This sends AT+CPCMREG=0 through the gateway.'
    $word = 'DEACTIVATE'
  }
  if ((Read-Input "Type $word to continue, anything else cancels") -ne $word) { Write-Info 'Cancelled. Nothing was sent.'; return }
  # Re-check immediately before acting: the call may have changed while the prompt was open.
  $again = Get-Status
  if (-not $again) { return }
  if ($Action -eq 'activate' -and (-not $again.call -or $again.call.state -ne 'ACTIVE')) { Write-Info 'Blocked: the call is no longer ACTIVE. Nothing was sent.'; return }
  if ($Action -eq 'deactivate' -and $again.call) { Write-Info 'Blocked: a call started. Nothing was sent.'; return }
  $r = Invoke-Gateway '/api/gateway/audio/usb-diagnostic' 'POST' @{ action = $Action } 30
  if (-not $r.Ok) { Write-Err "$($r.Code): $($r.Error)"; return }
  Write-Info "Gateway accepted '$Action'. That only means the modem acknowledged the command; check fresh PCM below."
  if ($Action -eq 'activate') { Start-Sleep -Seconds 2 }
  Show-UsbStatus
}

# ---------------------------------------------------------------- menu

function Show-Menu {
  Write-Host ''
  Write-Host '=== AI Caller Operations Menu ===' -ForegroundColor Cyan
  Write-Host ' 1  Gateway health and status'
  Write-Host ' 2  Full system health check'
  Write-Host ' 3  Detect modem COM ports'
  Write-Host ' 4  Modem information (AT queries; blocked during a call)'
  Write-Host ' 5  Recent gateway logs'
  Write-Host ' 6  Generate diagnostic report'
  Write-Host ' 7  Start gateway'
  Write-Host ' 8  Start dashboard'
  Write-Host ' 9  Start gateway and dashboard'
  Write-Host '10  USB audio status and diagnostics'
  Write-Host '11  Activate USB PCM audio (needs ACTIVE call + confirmation)'
  Write-Host '12  Deactivate USB PCM audio (no call + confirmation)'
  Write-Host ' 0  Exit'
}

function Invoke-MenuChoice([string]$Choice) {
  switch ($Choice.Trim()) {
    '1' { Show-Status }
    '2' { Invoke-HealthCheck }
    '3' { Show-Ports }
    '4' { Show-ModemInfo }
    '5' { Show-Logs }
    '6' { Show-Report }
    '7' { Start-GatewayService }
    '8' { Start-DashboardService }
    '9' { Start-GatewayService; Start-DashboardService }
    '10' { Show-UsbStatus }
    '11' { Invoke-UsbToggle 'activate' }
    '12' { Invoke-UsbToggle 'deactivate' }
    default { Write-Host 'Please choose a number from the menu.' -ForegroundColor Yellow }
  }
}

function Start-Menu {
  while ($true) {
    Show-Menu
    $choice = Read-Input 'Select an option'
    if ($null -eq $choice) { return }
    if ($choice.Trim() -eq '0') { Write-Host 'Goodbye.'; return }
    try { Invoke-MenuChoice $choice } catch { Write-Err $_.Exception.Message }
    if ($null -eq (Read-Input 'Press Enter to return to the menu')) { return }
  }
}

# ---------------------------------------------------------------- entry

function Test-Interactive {
  try { return ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) } catch { return $false }
}

if ($env:AI_CALLER_NO_MAIN -eq '1') { return }

if (-not $Command) { $Command = if (Test-Interactive) { 'menu' } else { 'help' } }

try {
  switch ($Command) {
    'menu' { Start-Menu }
    'status' { Show-Status }
    'health' { Invoke-HealthCheck }
    'ports' { Show-Ports }
    'modem-info' { Show-ModemInfo }
    'logs' { Show-Logs }
    'report' { Show-Report }
    'start-gateway' { Start-GatewayService }
    'start-dashboard' { Start-DashboardService }
    'start-all' { Start-GatewayService; Start-DashboardService }
    'usb-status' { Show-UsbStatus }
    'usb-activate' { Invoke-UsbToggle 'activate' }
    'usb-deactivate' { Invoke-UsbToggle 'deactivate' }
    default { Get-Help $PSCommandPath -Full }
  }
} catch {
  Write-Err $_.Exception.Message
  exit 1
}
