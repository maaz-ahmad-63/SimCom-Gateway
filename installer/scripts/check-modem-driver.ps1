<#
.SYNOPSIS
  Checks that the SIM7600EI and its Windows driver are in place: the modem is on USB, its AT and USB audio interfaces both have a
  working, signed driver, and each shows up as a COM port. READ ONLY.

.DESCRIPTION
  This script asks Windows (the Plug and Play and driver databases) what it knows. It never opens a COM port, never sends an AT
  command, never touches the modem, never installs or changes a driver, and never needs administrator rights.

  The product does NOT ship a modem driver. SIMCom's driver package carries no redistribution license that could be verified, so the
  customer installs the driver that SIMCom (or the modem's seller) provides, and this script says whether that worked.

  Interfaces (USB vendor 1E0E, as the gateway's own port discovery uses them): MI_02 = AT command port, MI_04 = USB audio port.

  Exit codes:  0 ready | 10 no modem on USB | 11 modem found but a driver is missing or in error | 12 no AT port
               13 no USB audio port | 14 driver not signed | 15 the Visual C++ runtime the product needs is missing (checked last)

.PARAMETER Json
  Print one JSON object instead of text.
.PARAMETER FromJson
  Evaluate a saved description instead of asking Windows (used by the tests).
#>
[CmdletBinding()]
param([switch]$Json, [string]$FromJson)

$ErrorActionPreference = 'Stop'
$VendorId = '1E0E'
$AtInterface = '02'
$AudioInterface = '04'

function Get-ModemDevices {
  $pnp = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match "^USB\\VID_$VendorId&PID_[0-9A-F]{4}&MI_\d\d\\" })
  $signed = @{}
  foreach ($d in Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue) { if ($d.DeviceID -match "VID_$VendorId") { $signed[$d.DeviceID] = $d } }
  $pnp | ForEach-Object {
    $problem = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction SilentlyContinue).Data
    $s = $signed[$_.InstanceId]
    [pscustomobject]@{
      InstanceId = $_.InstanceId
      FriendlyName = $_.FriendlyName
      Status = [string]$_.Status
      Problem = [int]($problem | ForEach-Object { $_ })
      Provider = $s.DriverProviderName
      Version = $s.DriverVersion
      Date = if ($s.DriverDate) { $s.DriverDate.ToString('yyyy-MM-dd') } else { $null }
      Signer = $s.Signer
      IsSigned = [bool]$s.IsSigned
    }
  }
}

function Test-VcRuntime { Test-Path (Join-Path $env:WINDIR 'System32\vcruntime140.dll') }

if ($FromJson) {
  $fixture = Get-Content -LiteralPath $FromJson -Raw | ConvertFrom-Json
  $devices = @($fixture.devices)
  $vc = [bool]$fixture.vcRuntime
} else {
  $devices = @(Get-ModemDevices)
  $vc = Test-VcRuntime
}

function Interface-Of($d) { if ($d.InstanceId -match '&MI_(\d\d)\\') { $Matches[1] } else { $null } }
function Port-Of($d) { if ($d -and $d.FriendlyName -match '\((COM\d+)\)') { $Matches[1] } else { $null } }

$at = $devices | Where-Object { (Interface-Of $_) -eq $AtInterface } | Select-Object -First 1
$audio = $devices | Where-Object { (Interface-Of $_) -eq $AudioInterface } | Select-Object -First 1
$broken = @($devices | Where-Object { $_.Problem -ne 0 -or ($_.Status -and $_.Status -ne 'OK') })
$unsigned = @($devices | Where-Object { $_.Provider -and -not $_.IsSigned })

$code = 0; $state = 'ready'; $messages = @()
if ($devices.Count -eq 0) {
  $code = 10; $state = 'no_modem'
  $messages += 'No SIM7600 modem was found on USB. Plug the modem into a USB port (use a port on the computer itself, not an unpowered hub), wait ten seconds and check again.'
} elseif ($broken.Count -gt 0) {
  $code = 11; $state = 'driver_missing'
  $messages += "The modem is connected, but Windows has no working driver for $($broken.Count) of its parts ($((($broken | ForEach-Object { $_.FriendlyName }) -join ', '))). Install the official Windows USB driver for the SIM7600 series (see below), then unplug and re-plug the modem."
} elseif (-not $at -or -not (Port-Of $at)) {
  $code = 12; $state = 'no_at_port'
  $messages += 'The modem is connected, but its AT command port (interface MI_02) did not appear as a COM port. The driver may be incomplete or the modem may be in a different USB mode.'
} elseif (-not $audio -or -not (Port-Of $audio)) {
  $code = 13; $state = 'no_audio_port'
  $messages += 'The modem is connected and the AT port is present, but the USB audio port (interface MI_04) did not appear as a COM port. Calls with the AI voice agent need it. The driver may be incomplete, or the modem is not set to its USB audio mode.'
} elseif ($unsigned.Count -gt 0) {
  $code = 14; $state = 'driver_unsigned'
  $messages += 'A modem driver is installed but Windows does not report it as signed. Replace it with the official, signed driver package.'
} elseif (-not $vc) {
  $code = 15; $state = 'vc_runtime_missing'
  $messages += 'The Microsoft Visual C++ runtime that the product needs (vcruntime140.dll) was not found. Install "Microsoft Visual C++ Redistributable 2015-2022 (x64)" from Microsoft.'
} else {
  $messages += 'The modem, its AT port and its USB audio port are all present with signed drivers. This only proves the drivers are in place; the modem itself is not queried here.'
}

if ($code -ge 10 -and $code -le 14) {
  $messages += 'Where to get the driver: SIMCom, the maker of the SIM7600, provides the Windows USB driver for the SIM7600 series (its product page lists Windows 7/8/10 support). Download it from SIMCom or from the seller of your modem, and install it with its own installer. This product does not include or download a driver, because a license that allows redistributing it could not be verified. Do not use a driver from an unofficial site.'
}

$result = [ordered]@{
  state = $state
  exitCode = $code
  modemAccess = 'none'
  ports = [ordered]@{ at = (Port-Of $at); audio = (Port-Of $audio) }
  vcRuntime = $vc
  interfaces = @($devices | ForEach-Object { [ordered]@{ interface = (Interface-Of $_); name = $_.FriendlyName; status = $_.Status; problemCode = $_.Problem; provider = $_.Provider; version = $_.Version; date = $_.Date; signer = $_.Signer; signed = $_.IsSigned } })
  messages = $messages
}

if ($Json) {
  $result | ConvertTo-Json -Depth 5
} else {
  Write-Host ''
  Write-Host 'SIM7600 modem and driver check (read only: Windows is asked, the modem is not)' -ForegroundColor Cyan
  Write-Host ("  AT command port : {0}" -f $(if ($result.ports.at) { $result.ports.at } else { 'not found' }))
  Write-Host ("  USB audio port  : {0}" -f $(if ($result.ports.audio) { $result.ports.audio } else { 'not found' }))
  foreach ($i in $result.interfaces) { Write-Host ("  MI_{0}  {1}  [{2}]  {3} {4}  signed={5}" -f $i.interface, $i.name, $i.status, $i.provider, $i.version, $i.signed) }
  Write-Host ''
  $color = if ($code -eq 0) { 'Green' } else { 'Yellow' }
  $messages | ForEach-Object { Write-Host $_ -ForegroundColor $color; Write-Host '' }
}
exit $code
