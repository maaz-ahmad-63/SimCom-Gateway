<#
.SYNOPSIS
  Single entry point for AI Caller hardware operations. Read-only: it only calls the gateway's
  /api/gateway/hardware/* GET endpoints.

.DESCRIPTION
  Never opens a COM port itself, never sends AT commands directly, never dials, answers, restarts the
  gateway or changes USB audio registration. The gateway refuses AT queries (modem-info) during a call.
  The API key is read from -ApiKey, $env:GATEWAY_API_KEY, or the repo .env, and is never printed.

.EXAMPLE
  .\tools\ai-caller.ps1 status
  .\tools\ai-caller.ps1 ports
  .\tools\ai-caller.ps1 modem-info
  .\tools\ai-caller.ps1 logs -Level error
  .\tools\ai-caller.ps1 report -OutFile report.txt
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet('status', 'ports', 'modem-info', 'logs', 'report', 'help')][string]$Command = 'help',
  [string]$GatewayUrl = $(if ($env:GATEWAY_URL) { $env:GATEWAY_URL } else { 'http://127.0.0.1:4000' }),
  [string]$ApiKey,
  [ValidateSet('info', 'warn', 'error')][string]$Level = 'warn',
  [int]$Limit = 100,
  [string]$OutFile
)

$ErrorActionPreference = 'Stop'

function Get-Key {
  if ($ApiKey) { return $ApiKey }
  if ($env:GATEWAY_API_KEY) { return $env:GATEWAY_API_KEY }
  $envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*GATEWAY_API_KEY\s*=' } | Select-Object -First 1
    if ($line) { return ($line -replace '^\s*GATEWAY_API_KEY\s*=\s*', '').Trim().Trim('"').Trim("'") }
  }
  throw 'No gateway API key: pass -ApiKey, set GATEWAY_API_KEY, or add it to .env.'
}

function Invoke-Hw([string]$Path) {
  $uri = ($GatewayUrl.TrimEnd('/')) + '/api/gateway/hardware' + $Path
  try {
    Invoke-RestMethod -Uri $uri -Method Get -Headers @{ 'x-api-key' = (Get-Key) } -TimeoutSec 20
  } catch {
    $detail = $_.ErrorDetails.Message
    if ($detail) { throw "Gateway refused: $detail" }
    throw "Could not reach the gateway at $GatewayUrl : $($_.Exception.Message)"
  }
}

switch ($Command) {
  'status' {
    $s = Invoke-Hw '/status'
    "Call: $(if ($s.call) { $s.call.state } else { 'none' })   Modem: $($s.modem.connectionState) (AT $($s.modem.atStatus))"
    "Configured ports: AT=$($s.modem.configuredAtPort) audio=$($s.modem.configuredAudioPort)"
    foreach ($l in $s.layers) { '{0,-8} {1}: {2}' -f $l.state.ToUpper(), $l.label, $l.detail }
    if ($s.modem.reconnect.lastFailure) { "Last failure: $($s.modem.reconnect.lastFailure.message)" }
  }
  'ports' {
    $p = Invoke-Hw '/ports'
    foreach ($x in $p.ports) { '{0,-8} MI_{1,-3} {2}' -f $x.path, $x.interface, $x.role }
    foreach ($f in $p.findings) { "[$($f.level)] $($f.message)" }
    if ($p.suggestedEnv) { 'Suggested .env change (apply manually; nothing is changed here):'; $p.suggestedEnv.PSObject.Properties | ForEach-Object { "  $($_.Name)=$($_.Value)" } }
  }
  'modem-info' { Invoke-Hw '/modem-info' | ConvertTo-Json -Depth 6 }
  'logs' { (Invoke-Hw "/logs?level=$Level&limit=$Limit").entries | ForEach-Object { $_.line } }
  'report' {
    $r = (Invoke-Hw '/report').report
    if ($OutFile) { Set-Content -Path $OutFile -Value $r -Encoding utf8; "Report written to $OutFile" } else { $r }
  }
  default { Get-Help $PSCommandPath -Full }
}
