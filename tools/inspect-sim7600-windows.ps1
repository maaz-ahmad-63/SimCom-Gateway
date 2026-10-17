[CmdletBinding()]
param(
    # Defaults come from MODEM_AT_PORT / MODEM_AUDIO_PORT; no COM number is assumed.
    [string]$AtPort = $env:MODEM_AT_PORT,
    [string]$AudioPort = $env:MODEM_AUDIO_PORT,
    [int]$BaudRate = 115200,
    [int]$ReadTimeoutMs = 1500,
    # List the COM ports Windows currently has present (nothing is opened) and exit.
    [switch]$List
)

$ErrorActionPreference = 'Stop'

function Get-PresentPorts {
    # Win32_SerialPort can be empty for USB composite ports, so use the PnP "Ports" class.
    # -PresentOnly hides stale entries left behind by earlier USB enumerations.
    Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue |
        Where-Object { $_.FriendlyName -match '\((COM\d+)\)\s*$' } |
        ForEach-Object {
            [pscustomobject]@{
                Port = $Matches[1]
                FriendlyName = [string]$_.FriendlyName
                Status = [string]$_.Status
                InstanceId = [string]$_.InstanceId
            }
        } |
        Sort-Object { [int]($_.Port -replace '\D', '') }
}

function Get-PortDevice {
    param([string]$PortName)

    $device = Get-PresentPorts | Where-Object { $_.Port -eq $PortName } | Select-Object -First 1
    if ($null -eq $device) {
        return $null
    }

    $hardwareIds = @()
    try {
        $properties = Get-PnpDeviceProperty -InstanceId $device.InstanceId `
            -KeyName 'DEVPKEY_Device_HardwareIds' -ErrorAction Stop
        foreach ($value in @($properties.Data)) {
            if ($value -match '(?i)USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}(?:&(?:REV_[0-9A-F]{4}|MI_[0-9A-F]{2}))?') {
                $hardwareIds += $Matches[0].ToUpperInvariant()
            }
        }
    } catch {
        # Some Windows driver packages do not expose PnP properties.
    }

    [pscustomobject]@{
        Port = $PortName
        Description = $device.FriendlyName
        Manufacturer = ''
        Status = $device.Status
        HardwareIds = @($hardwareIds | Sort-Object -Unique)
    }
}

function Read-AtResponse {
    param(
        [System.IO.Ports.SerialPort]$Port,
        [string]$Command
    )

    $Port.DiscardInBuffer()
    $Port.Write("$Command`r")
    $deadline = [DateTime]::UtcNow.AddMilliseconds($ReadTimeoutMs)
    $lines = New-Object System.Collections.Generic.List[string]

    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $line = $Port.ReadLine().Trim()
            if ($line.Length -gt 0 -and $line -ne $Command) {
                $lines.Add($line)
            }
            if ($line -eq 'OK' -or $line -eq 'ERROR' -or $line -like '+CME ERROR:*') {
                break
            }
        } catch [System.TimeoutException] {
            break
        }
    }

    return @($lines)
}

function Redact-AtLine {
    param([string]$Line)

    # Firmware strings are retained, but long numeric identifiers are not.
    $safe = $Line -replace '\b\d{10,}\b', '[REDACTED_NUMERIC_ID]'
    if ($safe -match '(?i)IMEI|IMSI|ICCID|phone|number') {
        return '[REDACTED_SENSITIVE_RESPONSE]'
    }
    return $safe
}

if ($List) {
    Write-Output 'COM ports currently present (nothing opened):'
    Get-PresentPorts | ForEach-Object { Write-Output ("  {0,-6} {1}" -f $_.Port, $_.FriendlyName) }
    Write-Output ''
    Write-Output 'Set MODEM_AT_PORT to the "AT PORT" entry and MODEM_AUDIO_PORT to the "Audio" entry.'
    exit 0
}

if ([string]::IsNullOrWhiteSpace($AtPort) -or [string]::IsNullOrWhiteSpace($AudioPort)) {
    Write-Output 'Set MODEM_AT_PORT and MODEM_AUDIO_PORT (or pass -AtPort / -AudioPort). Present ports:'
    Get-PresentPorts | ForEach-Object { Write-Output ("  {0,-6} {1}" -f $_.Port, $_.FriendlyName) }
    exit 2
}

Write-Output 'SIM7600EI Windows hardware inspection (read-only)'
Write-Output "Requested AT port: $AtPort"
Write-Output "Requested audio port: $AudioPort"
Write-Output ''

foreach ($portName in @($AtPort, $AudioPort)) {
    $device = Get-PortDevice -PortName $portName
    if ($null -eq $device) {
        Write-Output "${portName}: not present (use -List to see present ports)"
        continue
    }

    Write-Output "${portName}:"
    Write-Output "  Description: $($device.Description)"
    Write-Output "  Manufacturer: $($device.Manufacturer)"
    Write-Output "  Status: $($device.Status)"
    if ($device.HardwareIds.Count -eq 0) {
        Write-Output '  USB hardware IDs: unavailable'
    } else {
        Write-Output "  USB hardware IDs: $($device.HardwareIds -join ', ')"
    }
}

$serialPort = New-Object System.IO.Ports.SerialPort $AtPort, $BaudRate, None, 8, One
$serialPort.ReadTimeout = 250
$serialPort.WriteTimeout = 1000
try {
    $serialPort.Open()
    Write-Output ''
    Write-Output "AT identification via ${AtPort}:"
    foreach ($command in @('AT', 'ATI', 'AT+CGMM', 'AT+CGMR')) {
        Write-Output "  $command"
        foreach ($line in (Read-AtResponse -Port $serialPort -Command $command)) {
            Write-Output "    $(Redact-AtLine -Line $line)"
        }
    }
} catch {
    Write-Output "AT identification unavailable: $($_.Exception.Message)"
} finally {
    if ($serialPort.IsOpen) {
        $serialPort.Close()
    }
    $serialPort.Dispose()
}

Write-Output ''
Write-Output 'No call-control, SMS, network-write, audio-write, IMEI, IMSI, or phone-number commands were issued.'
