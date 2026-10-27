<#
  Tests for tools/ai-caller.ps1 against a FAKE gateway (a local HttpListener). No real gateway, modem, COM port or
  service is touched. Run:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\tests\ai-caller.tests.ps1
#>
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'ai-caller.ps1'
$KEY = 'test-key-9f8e7d6c5b4a'

# ---- fake gateway ------------------------------------------------------------------------------------------
$listener = New-Object Net.HttpListener
$tmp = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0); $tmp.Start(); $port = $tmp.LocalEndpoint.Port; $tmp.Stop()
$listener.Prefixes.Add("http://127.0.0.1:$port/"); $listener.Start()
$state = [hashtable]::Synchronized(@{ status = $null; hits = (New-Object System.Collections.ArrayList); ai = $null })
$rs = [runspacefactory]::CreateRunspace(); $rs.Open(); $rs.SessionStateProxy.SetVariable('listener', $listener); $rs.SessionStateProxy.SetVariable('state', $state); $rs.SessionStateProxy.SetVariable('KEY', $KEY)
$ps = [powershell]::Create(); $ps.Runspace = $rs
[void]$ps.AddScript({
  while ($listener.IsListening) {
    try { $ctx = $listener.GetContext() } catch { break }
    $req = $ctx.Request; $res = $ctx.Response
    $path = $req.Url.AbsolutePath
    $body = ''
    if ($req.HasEntityBody) { $body = (New-Object IO.StreamReader($req.InputStream)).ReadToEnd() }
    [void]$state.hits.Add("$($req.HttpMethod) $path $body")
    $code = 200; $out = '{}'
    if ($path -eq '/') { $out = '<html>dashboard</html>' }
    elseif ($req.Headers['x-api-key'] -ne $KEY) { $code = 401; $out = '{"error":"Invalid API key","code":"UNAUTHORIZED"}' }
    elseif ($path -eq '/api/gateway/hardware/status') { $out = $state.status }
    elseif ($path -eq '/api/gateway/hardware/ports') { $out = '{"configured":{"at":"COM22","audio":"COM26"},"ports":[{"path":"COM22","interface":"02","role":"at"}],"findings":[{"level":"info","message":"AT port COM22 matches"}],"suggestedEnv":null}' }
    elseif ($path -eq '/api/gateway/hardware/modem-info') {
      $s = $state.status | ConvertFrom-Json
      if ($s.call) { $code = 409; $out = '{"error":"A call is in progress","code":"CALL_IN_PROGRESS"}' } else { $out = '{"signal":{"rssi":21},"simStatus":"READY"}' }
    }
    elseif ($path -eq '/api/gateway/hardware/logs') { $out = '{"entries":[{"at":"t","level":"warn","line":"warn line Authorization: Bearer abc123secret"}]}' }
    elseif ($path -eq '/api/gateway/hardware/report') { $out = ('{"report":"report header key=' + $KEY + ' Bearer abc123secret"}') }
    elseif ($path -eq '/api/ai/readiness') { $out = $state.ai }
    elseif ($path -eq '/api/gateway/audio/usb-diagnostic') { $out = '{"command":"AT+CPCMREG","response":"OK"}' }
    else { $code = 404; $out = '{"error":"not found"}' }
    $bytes = [Text.Encoding]::UTF8.GetBytes($out)
    $res.StatusCode = $code; $res.ContentType = 'application/json'; $res.OutputStream.Write($bytes, 0, $bytes.Length); $res.Close()
  }
})
$handle = $ps.BeginInvoke()

# ---- load the script's functions only -----------------------------------------------------------------------
$env:AI_CALLER_NO_MAIN = '1'
. $scriptPath -ApiKey $KEY -GatewayUrl "http://127.0.0.1:$port" -DashboardUrl "http://127.0.0.1:$port"
$script:Inputs = New-Object System.Collections.Queue
function Read-Input([string]$Prompt) { if ($script:Inputs.Count -eq 0) { return $null }; return [string]$script:Inputs.Dequeue() }

function New-Status([string]$CallState, [bool]$Registered, [string]$Pcm = 'ok', [bool]$Sim = $false, [string]$Conn = 'READY') {
  $call = if ($CallState) { @{ state = $CallState; direction = 'inbound' } } else { $null }
  $layers = @(
    @{ key = 'atPort'; label = 'AT port'; state = 'ok'; detail = 'ready' },
    @{ key = 'audioPortOpen'; label = 'Audio port open'; state = $(if ($CallState) { 'ok' } else { 'unknown' }); detail = 'open for the call' },
    @{ key = 'usbAudioRegistered'; label = 'USB audio registered'; state = $(if ($Registered) { 'ok' } elseif ($CallState) { 'bad' } else { 'unknown' }); detail = 'registration' },
    @{ key = 'freshPcm'; label = 'Fresh PCM'; state = $(if ($CallState) { $Pcm } else { 'unknown' }); detail = 'frames' },
    @{ key = 'playbackVerified'; label = 'Playback verified'; state = 'unknown'; detail = 'never inferred' })
  $o = @{ gateway = @{ version = '0.1.0'; uptimeSeconds = 5; platform = 'win32'; driverType = 'hardware'; isSimulated = $Sim; usbAudioDiagnosticEnabled = $true }
    call = $call; modem = @{ connectionState = $Conn; atStatus = 'OK'; configuredAtPort = 'COM22'; configuredAudioPort = 'COM26'; reconnect = $null }
    usbAudio = @{ registrationActive = $Registered; needsRecovery = $false }; audio = @{ bytesReceived = 640; framesReceived = 2; msSinceLastFrame = 900 }; layers = $layers }
  $state.status = $o | ConvertTo-Json -Depth 6 -Compress
}
$AI_OK = '{"ok":false,"passiveOk":true,"mode":"auto","simulatedHardware":false,"blockers":["inbound-wire: not flowing"],"passiveBlockers":[]}'
$state.ai = $AI_OK

function Capture([scriptblock]$Block) { (& $Block 6>&1 | Out-String) }
function Posts { @($state.hits | Where-Object { $_ -like 'POST *' }) }
function Hits([string]$Like) { @($state.hits | Where-Object { $_ -like $Like }) }

$fail = 0
function Check([bool]$Cond, [string]$Name) {
  if ($Cond) { Write-Host "ok   $Name" -ForegroundColor Green } else { Write-Host "FAIL $Name" -ForegroundColor Red; $script:fail++ }
}

try {
  # status
  New-Status $null $false
  $o = Capture { Show-Status }
  Check ($o -match 'Call: none' -and $o -match 'Audio port open' -and $o -match 'Playback verified') 'status lists layers'
  Check ($o -notmatch [regex]::Escape($KEY)) 'status never prints the key'

  # health: nothing listening
  $dead = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0); $dead.Start(); $deadPort = $dead.LocalEndpoint.Port; $dead.Stop()
  $saveUrl = $GatewayUrl; $GatewayUrl = "http://127.0.0.1:$deadPort"
  $o = Capture { Invoke-HealthCheck }
  $GatewayUrl = $saveUrl
  Check ($o -match '\[FAIL\] Gateway API: UNREACHABLE' -and $o -match 'NOT HEALTHY') 'health: stopped gateway is FAIL with a summary'

  # health: wrong key
  $saveKey = $ApiKey; $ApiKey = 'wrong-key-wrong-key'
  $o = Capture { Invoke-HealthCheck }
  $ApiKey = $saveKey; $script:KnownSecret = $null
  Check ($o -match 'UNAUTHORIZED' -and $o -match '\[FAIL\]') 'health: rejected key is FAIL'

  # health: idle
  $state.hits.Clear(); New-Status $null $false
  $o = Capture { Invoke-HealthCheck }
  Check ($o -match '\[WARN\] Audio streaming: no call' -and $o -match 'NOT VERIFIED') 'health: no call -> audio WARN, playback not verified'
  Check ((Hits '* /modem-info*').Count -eq 0) 'health sends no AT query'
  Check ($o -match 'Summary:') 'health prints a summary'
  Check ($o -match '\[WARN\] AI readiness' -and $o -notmatch '\[FAIL\] AI readiness') 'health: AI blocked only by having no call is a WARN, not a FAIL'

  # health: port open + registered but stalled PCM -> never PASS
  New-Status 'ACTIVE' $true 'bad'
  $o = Capture { Invoke-HealthCheck }
  Check ($o -match '\[PASS\] Audio port open' -and $o -match '\[FAIL\] Fresh PCM frames: port is open but no fresh frames') 'health: open port with stalled PCM is FAIL'
  Check ((Hits '* /modem-info*').Count -eq 0) 'health during a call sends no AT query'
  New-Status 'ACTIVE' $true 'ok'
  $o = Capture { Invoke-HealthCheck }
  Check ($o -match '\[PASS\] Fresh PCM frames' -and $o -match '\[WARN\] Playback verified') 'health: fresh PCM passes, playback still unverified'

  # modem-info
  $state.hits.Clear(); New-Status 'ACTIVE' $true
  $o = Capture { Show-ModemInfo }
  Check ($o -match 'Blocked' -and (Hits '* /modem-info*').Count -eq 0) 'modem-info blocked during a call, nothing requested'
  New-Status $null $false
  $o = Capture { Show-ModemInfo }
  Check ($o -match 'READY' -and (Hits 'GET /api/gateway/hardware/modem-info*').Count -eq 1) 'modem-info runs when idle'

  # logs / report / ports redaction
  $o = Capture { Show-Logs }
  Check ($o -match 'warn line' -and $o -notmatch 'abc123secret') 'logs are redacted'
  $o = Capture { Show-Report }
  Check ($o -match 'report header' -and $o -notmatch 'abc123secret' -and $o -notmatch [regex]::Escape($KEY)) 'report is redacted'
  $o = Capture { Show-Ports }
  Check ($o -match 'COM22' -and $o -match 'matches') 'ports shown from the API'

  # usb activate
  $state.hits.Clear(); New-Status $null $false
  $o = Capture { Invoke-UsbToggle 'activate' }
  Check ($o -match 'only valid on an ACTIVE call' -and @(Posts).Count -eq 0) 'activate refused with no call'
  New-Status 'DIALING' $false
  $o = Capture { Invoke-UsbToggle 'activate' }
  Check (@(Posts).Count -eq 0) 'activate refused while dialing'
  New-Status 'ACTIVE' $true
  $o = Capture { Invoke-UsbToggle 'activate' }
  Check ($o -match 'already registered' -and @(Posts).Count -eq 0) 'activate refused when already registered'
  New-Status 'ACTIVE' $false
  $script:Inputs.Enqueue('yes')
  $o = Capture { Invoke-UsbToggle 'activate' }
  Check ($o -match 'Cancelled' -and @(Posts).Count -eq 0) 'activate cancelled without the typed word'
  $script:Inputs.Enqueue('ACTIVATE')
  $o = Capture { Invoke-UsbToggle 'activate' }
  Check (@(Posts).Count -eq 1 -and @(Posts)[0] -like '*"action":"activate"*') 'activate posts exactly once after confirmation'
  Check ($o -match 'only means the modem acknowledged' -and $o -notmatch 'verified playback') 'activate does not claim audio works'

  # usb deactivate
  $state.hits.Clear(); New-Status 'ACTIVE' $true
  $o = Capture { Invoke-UsbToggle 'deactivate' }
  Check ($o -match 'Blocked' -and @(Posts).Count -eq 0) 'deactivate refused during a call'
  New-Status $null $false
  $o = Capture { Invoke-UsbToggle 'deactivate' }
  Check ($o -match 'Nothing to deactivate' -and @(Posts).Count -eq 0) 'deactivate no-op when not registered'
  New-Status $null $true
  $script:Inputs.Enqueue('nope')
  $o = Capture { Invoke-UsbToggle 'deactivate' }
  Check (@(Posts).Count -eq 0) 'deactivate needs the typed word'
  $script:Inputs.Enqueue('DEACTIVATE')
  $o = Capture { Invoke-UsbToggle 'deactivate' }
  Check (@(Posts).Count -eq 1 -and @(Posts)[0] -like '*"action":"deactivate"*') 'deactivate posts once after confirmation'
  New-Status $null $true; $state.hits.Clear()
  $sim = New-Status $null $true '' $true
  $o = Capture { Invoke-UsbToggle 'deactivate' }
  Check ($o -match 'simulated' -and @(Posts).Count -eq 0) 'USB toggles blocked on the simulated driver'

  # usb-status never posts
  $state.hits.Clear(); New-Status 'ACTIVE' $true
  $o = Capture { Show-UsbStatus }
  Check ($o -match 'Fresh PCM' -and @(Posts).Count -eq 0) 'usb-status is read-only'

  # menu navigation
  New-Status $null $false
  foreach ($i in '99', '', '1', '', '0') { $script:Inputs.Enqueue($i) }
  $o = Capture { Start-Menu }
  $menuCount = ([regex]::Matches($o, 'AI Caller Operations Menu')).Count
  Check ($menuCount -ge 3 -and $o -match 'Please choose' -and $o -match 'Call: none' -and $o -match 'Goodbye') 'menu loops, rejects bad input, runs an option, exits on 0'
  foreach ($n in 1..12) { Check ((Capture { Show-Menu }) -match "(?m)^\s*$n\s") "menu lists option $n" }

  # services: already running is detected; placeholder key blocks start
  $script:Inputs.Enqueue('NO')
  $o = Capture { Start-DashboardService }
  Check ($o -match 'already running') 'dashboard already running is detected, not duplicated'
  $envBackup = $env:GATEWAY_API_KEY
  $env:GATEWAY_API_KEY = 'change-this-to-a-secure-random-token'
  $o = Capture { Start-GatewayService }
  $env:GATEWAY_API_KEY = $envBackup
  Check ($o -match 'GATEWAY_API_KEY' -and $o -match 'FAIL|not found' -and $o -match 'not started|not found') 'gateway start validates env before launching'
  $o = Capture { Write-Result 'FAIL' 'x' "Authorization: Bearer abc123secret key=$KEY" }
  Check ($o -notmatch 'abc123secret' -and $o -notmatch [regex]::Escape($KEY)) 'Write-Result redacts secrets'
}
finally {
  $listener.Stop(); $listener.Close(); $ps.Dispose(); $rs.Dispose()
  Remove-Item Env:AI_CALLER_NO_MAIN -ErrorAction SilentlyContinue
}

if ($fail -gt 0) { Write-Host "$fail check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host 'all checks passed' -ForegroundColor Green
