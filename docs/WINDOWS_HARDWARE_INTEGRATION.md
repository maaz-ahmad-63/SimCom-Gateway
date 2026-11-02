# Windows Hardware Integration & Validation Guide
## SIMCOM SIM7600EI Cellular Gateway (Phase 4 Readiness)

This document provides the exact requirements, driver setup, and manual validation checklist for transitioning the SIM7600EI Cellular Gateway from macOS mock mode to physical hardware on the production Windows PC host.

---

## 1. Hardware Specifications & Prerequisites

### Physical Setup
- **Modem**: SIMCOM SIM7600EI 4G LTE USB Dongle / Development Board.
- **SIM Card**: Active **Vi India** 4G LTE SIM card with voice service enabled.
- **Antenna**: Dedicated cellular omni/paddle antenna securely connected to the `MAIN` SMA port.
- **Host PC**: Windows 10/11 64-bit machine with USB 2.0/3.0 port providing at least 1.5A–2.0A power (or powered USB hub to prevent modem rebooting during cellular transmit bursts).

### Windows COM Port Identification
When the SIM7600EI is plugged in and drivers are installed, Windows Device Manager exposes multiple virtual serial ports under **Ports (COM & LPT)**:

| Port | Config Name | Windows Device Manager name | Purpose |
|---|---|---|---|
| **AT Command Interface** | `MODEM_AT_PORT` | `Simcom HS-USB AT PORT 9001` | AT commands, call setup, URCs, network status, DTMF (115200 8-N-1) |
| **USB Audio** | `MODEM_AUDIO_PORT` | `Simcom HS-USB Audio 9001` | Serial byte stream observed during active calls; codec, framing, and playback direction are not verified |
| **NMEA / Diagnostics** | — | `Simcom HS-USB NMEA 9001`, `Simcom HS-USB Diagnostics 9001` | GNSS output and firmware diagnostic logs; not used by the gateway |

**No COM number is assumed anywhere in the code.** Windows reassigns COM numbers
whenever the USB composite device re-enumerates, and leaves stale entries behind.
With `MODEM_DRIVER=hardware` the gateway refuses to start unless both
`MODEM_AT_PORT` and `MODEM_AUDIO_PORT` are set (and different). Find the live
ports with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\inspect-sim7600-windows.ps1 -List
```

Observed on this PC on 2026-10-16 (present devices only; the Device Manager also
lists many stale, not-present `Simcom ... (COM8/9/10/11/12/13/14/15/17/18/19/20)` entries
that must be ignored): AT = `COM22`, NMEA = `COM23`, Diagnostics = `COM24`,
USB Audio = `COM26` (USB interface `VID_1E0E&PID_9001&MI_04`). Re-check after any
re-plug; the previously documented `COM20`/`COM19` are stale entries.

### When COM22/COM26 close on their own

The gateway only closes a COM port on shutdown and (audio port) at the end of a call. If both
ports vanish together, check whether Windows lost the modem from the USB bus:

```powershell
Get-WinEvent -FilterHashtable @{ LogName='Microsoft-Windows-Kernel-PnP/Device Management'; StartTime=(Get-Date).AddHours(-12) } |
  Where-Object { $_.Message -match 'VID_1E0E' } | Select-Object TimeCreated, Id, Message | Format-Table -Wrap
```

Event 1010 ("surprise removed as it is reported as missing on the bus") or 1011/1040/1041
(failing / platform-level reset) at the same time as a gateway `Serial transport failure` means the
modem disconnected from the PC, not that the gateway closed it. On 2026-10-16 this PC logged a dozen
such removals for `USB\VID_1E0E&PID_9001`, plus `Microsoft-Windows-USB-USBHUB3` events 196/205
("USB device draining system power when system is idle", "Re-enumerating a DRIPS blocking device").
Things to try, none verified as a fix: connect the modem directly to a rear/powered USB port with a
short cable, turn off "Allow the computer to turn off this device to save power" for the Simcom
composite device and its USB root hub, and stop the PC entering Modern Standby while the gateway runs.
After a USB drop the radio call may survive, but the audio port and `AT+CPCMREG` registration are not
re-established by the gateway, so treat any call that lived through a drop as having no valid audio.

Only one gateway may own the ports. At startup (hardware mode) the gateway records its PID for each
port in `%TEMP%\sim-gateway-locks\<PORT>.lock` and refuses to start if a live process already owns
one, naming its PID. A lock left by a crashed process is replaced automatically.

### Hardware Operations (dashboard `/hardware` and `tools/ai-caller.ps1`)

`.	oolsi-caller.ps1` with no arguments opens the **AI Caller Operations Menu** (health, port detection, modem
info, logs, report, start gateway/dashboard, USB audio status/activate/deactivate). Direct commands still work:

```powershell
.	oolsi-caller.ps1 status | health | ports | modem-info | logs | report
.	oolsi-caller.ps1 start-gateway | start-dashboard | start-all
.	oolsi-caller.ps1 usb-status | usb-activate | usb-deactivate
```

Port open, USB audio registration and fresh PCM are reported as separate layers; playback is never marked verified.
The tool uses only the gateway HTTP API (never a COM port), never prints the API key, never edits `.env`, and
never dials or answers. `modem-info` is refused during a call. `usb-activate` needs an ACTIVE call and a typed
`ACTIVATE`; `usb-deactivate` is refused while any call exists and needs a typed `DEACTIVATE`. Tests (fake gateway,
no hardware): `powershell -NoProfile -File tools	estsi-caller.tests.ps1`.

### Read-only hardware identification

From the repository root, run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\tools\inspect-sim7600-windows.ps1
```

The script reports Windows descriptions, manufacturers, status, filtered USB
VID/PID hardware IDs, and the modem responses to `AT`, `ATI`, `AT+CGMM`, and
`AT+CGMR`. It does not issue call-control, SMS, network-write, audio-write,
IMEI, IMSI, or phone-number commands. Its output redacts long numeric
identifiers and sensitive-looking response lines.

The repository-confirmed facts are only the SIMCOM SIM7600EI family and the
115200 serial setting. The exact carrier-board model, physical modem firmware
revision, and official SIMCom USB audio-interface specification must come from
this diagnostic and the board/modem documentation.

---

## 2. Windows Environment Setup

### 1. Install Node.js & Build Tools
Node.js LTS (v20+ recommended) is required. The serial transport (`serialport`) and database (`better-sqlite3`) packages use native C++ addons:

```powershell
# Open PowerShell as Administrator
# Install Node.js via winget or nodejs.org
winget install OpenJS.NodeJS.LTS

# Install Visual Studio C++ Build Tools (required for native addons)
# Option A: Visual Studio Installer -> Desktop development with C++
# Option B: Visual Studio Build Tools 2022
```

### 2. Configure Windows Defender Firewall
To allow the macOS dashboard to communicate with the Windows Gateway over your local Wi-Fi / Ethernet LAN:

```powershell
# In Administrator PowerShell: Allow TCP port 4000
New-NetFirewallRule -DisplayName "SIM7600 Gateway API" -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow -Profile Private
```

### 3. Environment Configuration (`.env`)
Create `.env` in the root of the project on the Windows PC:

```env
# Network Binding (listen on all local network interfaces only when explicitly enabled)
PORT=4000
HOST=0.0.0.0
NODE_ENV=production

# Mandatory Security Token (Must be at least 8 characters; never use development placeholders)
GATEWAY_API_KEY=your-secure-production-secret-token-32chars
CORS_ORIGIN=http://192.168.1.50:3000

# HOST defaults to 127.0.0.1 when omitted; use 0.0.0.0 only for private-LAN access

# Physical Modem Driver (Strictly selects Sim7600HardwareAdapter - no mock fallback)
MODEM_DRIVER=hardware
MODEM_AT_PORT=COM22   # required in hardware mode; see -List above
MODEM_AT_BAUD=115200
MODEM_AUDIO_PORT=COM26   # required in hardware mode; no default is assumed
MODEM_AUDIO_BAUD=115200

# Command Timeouts & Resiliency
MODEM_COMMAND_TIMEOUT_MS=5000
MODEM_DIAL_TIMEOUT_MS=20000
MODEM_AUTO_RECONNECT=true

# Audio Diagnostic Capture (Unvalidated Raw Stream)
AUDIO_SAMPLE_RATE=8000
AUDIO_CHANNELS=1
AUDIO_BIT_DEPTH=16
AUDIO_ENABLE_RAW_DUMP=false
AUDIO_DUMP_DIRECTORY=./audio-dumps
# Must be explicitly enabled for the manual CPCMREG diagnostic
AUDIO_USB_DIAGNOSTIC_ENABLED=false

# Database Persistence
SQLITE_DB_PATH=./data/gateway.sqlite
```

The gateway defaults to `HOST=127.0.0.1` when `HOST` is omitted. Set
`HOST=0.0.0.0` only on the private Windows LAN host when remote dashboard
access is required. API-key authentication remains mandatory for every
`/api` route and Socket.IO connection; binding to `0.0.0.0` does not disable
authentication. Restrict the Windows firewall rule to the trusted private
network where possible.

The sample rate, channel count, and bit depth above are target configuration
values only. The repository does not include a SIM7600EI audio protocol
definition proving that the USB audio port carries linear PCM, a framed codec, or
host-to-modem playback. Do not send arbitrary audio bytes to it until the
manual bidirectional test confirms the transport and format.

Boolean variables (`AUDIO_USB_DIAGNOSTIC_ENABLED`, `AUDIO_ENABLE_RAW_DUMP`,
`MODEM_AUTO_RECONNECT`, and the two PCM test flags) accept
`true/false/1/0/yes/no/on/off` (case-insensitive). A blank value means "unset"
and uses the default; any other value stops the gateway at startup.

> **Changed:** previously the string `false` was parsed as `true` (so
> `AUDIO_USB_DIAGNOSTIC_ENABLED=false` enabled the diagnostic), and
> `AUDIO_ENABLE_RAW_DUMP` defaulted to on. It now defaults to **off**. The
> unrestricted whole-call dump (`unvalidated_raw_audio_*.bin`, no size or time limit)
> is only written when you set `AUDIO_ENABLE_RAW_DUMP=true`; use the bounded
> capture test below for format verification. Any copy of `.env` that relied on the
> old behaviour must set it explicitly.

The USB-audio diagnostic is disabled by default. When explicitly enabled, the
authenticated endpoint `POST /api/gateway/audio/usb-diagnostic` accepts
`{"action":"activate"}` or `{"action":"deactivate"}`. Activation is allowed
only while the call is ACTIVE and issues `AT+CPCMREG=1` through the existing
AT-port queue. Call cleanup issues `AT+CPCMREG=0` once when activation
succeeded. No audio payload is written.

Stopping is truthful about failure: the activation is only ended when the module accepts `AT+CPCMREG=0`.
If the stop is rejected, times out or the AT port drops, the activation stays on record as **unverified**
(`audio.state: unverified`, `lastDeactivation: { ok: false, ... }`) while the call lasts, and once the call has
ended the doubt is carried forward as `registrationUncertain: true` instead of being cleared. The next call
does not inherit "active", the operator can activate it afresh (`AT+CPCMREG=1`, no toggle), and the
dashboard says why the audio check is blocked instead of reporting a plain `not-expected`.

### Opt-in USB PCM verification tests

Two separate, default-off tests reuse the audio adapter's single open handle on
the USB audio port (no second handle is ever opened). Both need an ACTIVE call
and a successful `activate` above, run one at a time, and are stopped by hangup
or an audio error.

```text
AUDIO_USB_DIAGNOSTIC_ENABLED=true            # existing flag
AUDIO_USB_PCM_CAPTURE_TEST_ENABLED=true      # inbound capture (<= 5 s, <= 160000 bytes)
AUDIO_USB_PCM_OUTBOUND_TONE_TEST_ENABLED=true  # outbound tone (<= 1 s, <= 16000 bytes, amplitude <= 0.1)
```


Endpoints (authenticated): `POST /api/gateway/audio/usb-pcm/capture`,
`POST /api/gateway/audio/usb-pcm/tone` with
`{"assumedFormat":{"sampleRate":8000,"endianness":"little-endian"},"frequencyHz":1000,"durationMs":500,"amplitude":0.05}`,
and `POST /api/gateway/audio/usb-pcm/abort`. The capture writes
`<AUDIO_DUMP_DIRECTORY>/usb_pcm_capture_<callId>_<ts>.bin` plus a `.json` sidecar
(sizes and timing only; audio content is never logged). The `assumedFormat` of the
tone test is an unverified guess supplied by the operator, never a default.

Inspect a capture (`packages/gateway`):

```powershell
npm run usb-pcm:inspect -- analyze <file.bin>
npm run usb-pcm:inspect -- wav <file.bin> <out.wav> --rate N --bits 16 --channels 1 --endian little --i-verified-format
```

`analyze` prints stats for each candidate format. Have the remote party hold a
steady known tone (for example 1000 Hz from a tone-generator app) during the
capture: the format is plausible only when `dominantHz` equals that tone and
`toneConcentration` is near 1. The sample rate is confirmed by that match (and by
`durationMs` equalling the 5 s wall clock); byte order is only weakly separated,
so also listen to the WAV. `wav` refuses to run without `--i-verified-format`.
No local speech-recognition engine exists in this repository.

Keep `AUDIO_ENABLE_RAW_DUMP=false` (the default) while testing: when enabled it
separately dumps the whole call's raw stream to `unvalidated_raw_audio_*.bin`,
which is not bounded to 5 seconds.

#### What SIMCom documents, and what it does not

Sources: *SIM7100_SIM7500_SIM7600_SIM7800 Series USB AUDIO Application Note* V1.03 and V2.00, and the
*SIM7500_SIM7600 Series AT Command Manual* V1.12 (sections 6.26 AT+CPCMREG, 6.44 AT+CPCMFRM,
6.47 AT+CPCMBANDWIDTH).

| Topic | Documented | Not documented (still unverified here) |
|---|---|---|
| Ports | AT commands on "AT Port 9001", PCM on "Audio 9001" | - |
| Start | After `VOICE CALL: BEGIN`, send `AT+CPCMREG=1`; then "the external MPU and the module can exchange software PCM data until the call is hung up" (both directions, raw PCM) | Whether the module needs host writes before it sends |
| Stop | After `VOICE CALL: END:`, send `AT+CPCMREG=0` (manual also lists `AT+CPCMREG=0,1`); `AT+CPCMREG?` returns `+CPCMREG: <mode>` | What happens to the registration when USB resets |
| Format | "8K sample rate, 16 bit linear"; `AT+CPCMFRM=1` selects 16 kHz (8k to 16k only, not saved across reset). `AT+CPCMBANDWIDTH=<volte>,<novolte>` sets the PCM rate per bearer, **defaults 0 (16 kHz) for VoLTE and 1 (8 kHz) otherwise** | Byte order, channel count, frame size, write chunk size, pacing, buffering |

So the 16-bit linear sample width is documented, the byte order is not, and the rate depends on the
bearer: a VoLTE call may be 16 kHz. Activation (`activate`) therefore also runs the read-only queries
`AT+CPCMFRM?` and `AT+CPCMBANDWIDTH?` and returns what the module reports in `moduleAudioFormat`.
The 20 ms frame and 40 ms write-ahead used for playback are engineering choices, not requirements.

Offline findings from the captures already on this PC (not proof): the audio port delivers exactly
16,000 bytes/s, consistent with 8 kHz 16-bit mono; the 168 s call dump has 5.7 s of energetic frames
of which 95 % show a clear pitch period (median 125 Hz) when read as 8 kHz little-endian, while the
byte-swapped reading does not. That says the incoming stream carries voiced speech-like audio. Whether
it is intelligible, and whose voice it is, needs a person to listen:

```powershell
cd packages\gateway
npm run usb-pcm:inspect -- wav <capture.bin> .\listen.wav --rate 8000 --bits 16 --channels 1 --endian little --candidate-unverified
Start-Process .\listen.CANDIDATE.wav
```

#### After Windows removes the modem from USB

**Established (2026-10-16, IST):** the COM22 close logged at 12:40:15.129 UTC is 18:10:15 local, the same
second Windows logged event 1010 "surprise removed as it is reported as missing on the bus" for
`USB\VID_1E0E&PID_9001`; the same device was removed at 18:09:07 and 18:09:17 as well. serialport 12.0
reports a removal as a `close` carrying a Disconnect error (`err.disconnected === true`) and a host-requested
close as a plain `close`; the gateway used to discard that argument, so the two could not be told apart.
Nothing in the gateway calls close on COM22 except shutdown. **Not established:** why the device leaves the
bus (power management, USB power sag, cable/port, firmware reset).

Logs now say which it was: `closed: device disconnected (...)`, `closed by the gateway`, or
`closed without a disconnect error`.

When the modem leaves READY during an ACTIVE call the gateway marks the call and the USB audio registration
**unverified** (`isUsbAudioDiagnosticActive` is false; the PCM tests refuse to run). The modem flaps, so
recovery starts only after it has stayed READY for 3 s, restarts that wait on every flap, and a recovery
that the modem outlives is discarded and run again. It then checks, in order, and reports each result:

1. `AT+CLCC`: does the module still list a voice call? If it lists none, the stale gateway call is ended
   (`failed`, "Call lost during modem reconnect") and `AT+CPCMREG=0` is sent. If the query fails the call
   is `unknown` and nothing else is touched. **No hang-up command is ever sent by recovery.**
2. COM26 is reopened first (once), if it had closed, so any registration is made against the handle that
   will receive the bytes.
3. `AT+CPCMREG?`, only if the operator had activated USB audio: `1` = `verified`, `0` = re-issued with
   `AT+CPCMREG=1`. A failure caused by the AT port dropping again is `unknown`, never "the module said no".
4. Real bytes: at least 3,200 PCM bytes (about 200 ms) must arrive within 2 s. A registration flag of 1 is
   not a stream. If the module says it is registered and nothing arrives on the fresh handle, recovery reports
   **"Registered but no PCM bytes received"** and leaves the session unhealthy. It does **not** toggle the
   registration: SIMCom documents `AT+CPCMREG=0` only after the call has stopped, and this module answers it
   with `ERROR` mid-call, so the earlier stop/start retry could never run its second half. The only
   registration command recovery still sends is the documented start, `AT+CPCMREG=1`, when `AT+CPCMREG?`
   says `0`; a re-issue that still brings no bytes is likewise reported as not recovered.

Anything not proven by bytes leaves the session unhealthy (`needsRecovery: true`, status
`audio.state: unverified`). `{"action":"status"}` shows the wire: `flowing` (bytes in the last 500 ms),
`stalled` (registered and streaming, but silent), `unverified`, `not-streaming` or `not-expected`; even
`flowing` says nothing about speech. `{"action":"recover"}` runs the same procedure on demand. Whether a
live radio call really survives a USB reset is not documented; only a real call can show it.

#### Serial port lifecycle (COM ports, reconnects)

Each COM port (AT and audio) is wrapped by one transport that follows these rules:

- **One handle at a time.** Open and close requests run strictly in order, and a reopen waits (up to 1.5 s) for the
  previous handle to release the port, because Windows ports are opened exclusively. Concurrent opens share one.
- **Events belong to the handle that produced them.** A late `close`, `error` or `data` from a replaced handle
  is ignored, so it can no longer mark the new connection failed.
- **A fatal driver error kills the handle even if it still says it is open.** A port `error` event, or a write
  that fails with a device-gone error such as Windows "Unknown error code 31" (also 55 and 1167), is announced once as a
  disconnect, `isOpen()` becomes false, and the next open destroys that handle before creating a new one. Ordinary
  write errors (for example EAGAIN) do not drop the connection.
- **The modem adapter releases a failed handle before reconnecting**, never reuses one, and runs one initialization
  at a time (a manual start and a scheduled reconnect share the same run). Retries still back off
  (`reconnectIntervalMs` times the attempt, up to 4) and stop after `maxReconnectAttempts`.

This changes only the serial layer: the AT command set, dialing, answering and USB audio recovery are untouched.
Which Windows error codes mean "device gone" is general Windows knowledge, not something SIMCom documents.

#### Real-hardware runbook (PowerShell)

Mock and fake-serial tests prove only the gateway logic. They do not show what the
USB audio port carries or whether written bytes reach the caller.

```powershell
# 0. Once per shell: load the API key into memory without printing it.
Set-Location "C:\Users\Admin\OneDrive\Desktop\AI Caller"
$key  = ((Get-Content .env | Where-Object { $_ -match '^GATEWAY_API_KEY=' } | Select-Object -First 1) -replace '^GATEWAY_API_KEY=', '').Trim().Trim('"')
$h    = @{ 'x-api-key' = $key }
$base = 'http://127.0.0.1:4000'

# 1. Confirm live ports, then set MODEM_AT_PORT / MODEM_AUDIO_PORT in .env and
#    add AUDIO_USB_DIAGNOSTIC_ENABLED=true plus the PCM flags you need. Restart the gateway.
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\inspect-sim7600-windows.ps1 -List
npm run build
npm run start:gateway          # keep this window open

# 2. In a second window (repeat step 0 there): check the ports the gateway is using.
Invoke-RestMethod "$base/api/gateway/health" -Headers $h |
  Select-Object driverType, @{n='state';e={$_.modem.connectionState}}, @{n='at';e={$_.modem.atPort}}, @{n='audio';e={$_.modem.audioPort}}

# 3a. Inbound capture. Call the SIM from another phone, then answer:
Invoke-RestMethod -Method Post "$base/api/calls/answer" -Headers $h | Select-Object id, state
#     As soon as it is ACTIVE, have the caller play a steady 1000 Hz tone near their
#     phone microphone (any tone-generator app), then run:
Invoke-RestMethod -Method Post "$base/api/gateway/audio/usb-diagnostic" -Headers $h -ContentType 'application/json' -Body '{"action":"activate"}'
$cap = Invoke-RestMethod -Method Post "$base/api/gateway/audio/usb-pcm/capture" -Headers $h -TimeoutSec 20
$cap | Format-List          # bytes, durationMs (~5000), stopReason (duration), filePath
Invoke-RestMethod -Method Post "$base/api/calls/hangup" -Headers $h | Out-Null

# 3b. Inspect it. filePath is relative to the gateway's working directory, which is
#     packages\gateway when started with npm run (default folder: packages\gateway\audio-dumps).
Set-Location packages\gateway
npm run usb-pcm:inspect -- analyze $cap.filePath
#     Only after a format row shows dominantHz = 1000 and toneConcentration near 1:
npm run usb-pcm:inspect -- wav $cap.filePath .\capture.wav --rate 8000 --bits 16 --channels 1 --endian little --i-verified-format
Start-Process .\capture.wav   # listen: you must hear the tone/speech, not noise
Set-Location ..\..

# 4. Outbound tone (separate flag AUDIO_USB_PCM_OUTBOUND_TONE_TEST_ENABLED=true).
#    Place or answer a call to a phone you hold, ACTIVE, then:
Invoke-RestMethod -Method Post "$base/api/gateway/audio/usb-diagnostic" -Headers $h -ContentType 'application/json' -Body '{"action":"activate"}'
$tone = '{"assumedFormat":{"sampleRate":8000,"endianness":"little-endian"},"frequencyHz":1000,"durationMs":500,"amplitude":0.05}'
Invoke-RestMethod -Method Post "$base/api/gateway/audio/usb-pcm/tone" -Headers $h -ContentType 'application/json' -Body $tone -TimeoutSec 10 | Format-List
Invoke-RestMethod -Method Post "$base/api/calls/hangup" -Headers $h | Out-Null
# Emergency stop of a running test: Invoke-RestMethod -Method Post "$base/api/gateway/audio/usb-pcm/abort" -Headers $h
```

Real-hardware observations still required before any claim is made:

1. `AT+CPCMREG=1` returns `OK` on the AT port and bytes then arrive on the audio port.
2. The sample rate, bit depth, channel count and byte order of those bytes, shown by a
   known remote tone (`dominantHz`, `toneConcentration`, `durationMs`) and by listening to the WAV.
3. Whether the stream is continuous raw PCM or framed/packetised (look for periodic headers).
4. Whether bytes written to the audio port are transmitted to the remote party: the person
   holding the other phone must hear the tone. A successful serial write proves nothing.
5. If the tone is not heard, whether another `AT+CPCMREG` mode or SIMCom's documented
   direction/format is required (the repository contains no such specification).
6. That the capture and tone stop cleanly on hangup, with `AT+CPCMREG=0` issued afterwards.

---

## 3. Verified Modem Hardware Baseline (PowerShell)

The following baseline has already been confirmed on the physical Windows PC via PowerShell terminal before running the service:

```text
Port: <MODEM_AT_PORT> at 115200 baud
Command:  AT
Response: OK

Command:  AT+CPIN?
Response: +CPIN: READY
          OK

Command:  AT+CEREG?
Response: +CEREG: 0,1
          OK (Registered on Home LTE Network)

Command:  AT+CSQ
Response: +CSQ: 23,99
          OK (Strong 4G RF signal, RSSI 23)

Command:  AT+COPS?
Response: +COPS: 0,0,"Vi India Vi India",7
          OK (Carrier Vi India, Access Technology 7 = LTE)
```

---

## 4. Safe Initial Gateway Startup Procedure

Follow these steps to safely start the gateway service without placing unwanted phone calls or altering modem NVRAM settings:

### Step 1: Install Dependencies & Build
On the Windows PC, open PowerShell inside the project directory:

```powershell
# Install dependencies across all workspaces
npm install

# Build shared contracts and backend
npm run build
```

### Step 2: Start the Gateway Service
Run the compiled gateway service (or dev mode with hot reload):

```powershell
# Option A: Production execution (recommended for hardware run)
npm run start:gateway

# Option B: Development mode with tsx hot-reload
npm run dev:gateway
```

Expected Terminal Output on successful hardware initialization:
```text
[Gateway] SIM7600EI Gateway service listening on http://0.0.0.0:4000
[Gateway] Driver: HARDWARE (Simulated: false)
[Gateway] Physical AT Port: <MODEM_AT_PORT> @ 115200 baud
[Gateway] Physical Audio Port: <MODEM_AUDIO_PORT> @ 115200 baud
```

*Safety Note*: At startup, the gateway only executes read/status commands (`AT`, `ATE0`, `AT+CMEE=2`, `AT+CLIP=1`, `AT+CRC=1`, `AT+CPIN?`). It will **never** dial a number, transmit audio, or modify cellular network profiles automatically.

### Step 3: Verify Gateway Health via HTTP
In a separate PowerShell window or browser:

```powershell
# Query health endpoint with the mandatory security header
Invoke-RestMethod -Uri "http://localhost:4000/api/gateway/health" -Headers @{"x-api-key"="your-secure-production-secret-token-32chars"}
```

Expected JSON Response:
```json
{
  "gatewayVersion": "0.1.0",
  "isSimulated": false,
  "driverType": "hardware",
  "modem": {
    "connectionState": "READY",
    "atPort": "<MODEM_AT_PORT>",
    "audioPort": "<MODEM_AUDIO_PORT>",
    "signal": {
      "rssi": 23,
      "ber": 99,
      "dBm": -67,
      "bars": 4
    },
    "network": {
      "registration": "REGISTERED_HOME",
      "operatorName": "Vi India",
      "accessTechnology": "LTE"
    }
  },
  "activeCall": null
}
```

---

## 5. Manual USB Audio Port Qualification (No Automatic Dial)

Start the gateway with debug logging, then place one authorized call manually
through the existing dashboard or API. During the active call, verify that the
gateway reports inbound byte counts on the audio port. If testing playback, use only
known test data after confirming the modem documentation and endpoint format;
do not infer PCM from byte counts alone. Record whether the remote party hears
the playback and stop the call manually.

The gateway diagnostics record timestamps, chunk sizes, write success/failure,
stream errors, and aggregate statistics. They do not log audio content, phone
numbers, or API credentials. A successful serial write alone does not prove
that the modem transmitted audible audio.

## 6. Connecting from the macOS Dashboard

### Finding the modem's ports automatically

`MODEM_AT_PORT` and `MODEM_AUDIO_PORT` are optional. When they are empty, the gateway lists the serial ports Windows reports
(this opens none of them) every time it is about to open the modem, and picks the AT and USB-audio interfaces from their USB
identity: vendor `1E0E`, interface `MI_02` (AT) and `MI_04` (audio), confirmed against the driver's port name, and grouped into
one physical modem by the parent instance prefix in the PnP id. COM numbers do not matter, need not be consecutive, and may change
on every replug; nothing is written back to `.env`.

- **One modem:** used. The Hardware page shows the ports and the modem id (`1E0E:9001:<parent>`).
- **No modem, or one missing its AT or audio interface:** nothing is opened; the reason is on the Hardware page and the gateway keeps
  looking (it also notices a modem plugged back in after its own reconnect attempts ran out).
- **Two or more modems:** nothing is opened and the gateway does not guess. Set `MODEM_DEVICE` to the id shown on the Hardware page.
- **One port set, the other empty:** the other is taken from the same physical modem, or nothing is opened.
- **Both set:** used exactly as given; the Hardware page only warns if they look wrong.

Limits: whether a port is free (not held by another program) can only be learned by opening it, which discovery never does; the open
itself then fails and is retried. A modem moved to another USB socket gets a new id; with one modem it is adopted (and reported),
with several you choose again. The interface numbers are those observed on this SIM7600EI; another firmware or USB composition may
differ, in which case set the ports explicitly.

### Which machine runs what (read this first)

Two programs, two separate environments. The **gateway** reads the repository's root `.env` on the machine that has the modem.
The **dashboard** (Next.js) reads `.env` files from `packages/dashboard/` only, and its browser pages additionally keep an
address and key entered on the Settings page. Hardware settings (COM ports, audio rate, driver) live only in the gateway's `.env`;
the dashboard displays what the gateway reports and cannot change it.

| Layout | Dashboard server needs | Gateway `.env` needs | Browser (`/settings`) |
| --- | --- | --- | --- |
| **A.** Gateway and dashboard on the Windows PC, browser on that PC (`http://localhost:3000`) | Nothing. With no key of its own it uses `GATEWAY_API_KEY` and `PORT` from the repository `.env` and contacts `http://127.0.0.1:<PORT>` | `HOST=0.0.0.0` or `127.0.0.1`, `GATEWAY_API_KEY`, default `CORS_ORIGIN=http://localhost:3000` | Gateway URL `http://localhost:4000` (the default) and the API key |
| **B.** Both on the Windows PC, browser on the Mac (`http://<PC_IP>:3000`) | Nothing, plus `DASHBOARD_SMS_ALLOW_REMOTE=true` in `packages/dashboard/.env.local` to use the SMS page from the Mac | `HOST=0.0.0.0`, `CORS_ORIGIN=http://<PC_IP>:3000` | Gateway URL `http://<PC_IP>:4000` (the default when the page was opened by that address) and the API key |
| **C.** Dashboard on the Mac, gateway on the Windows PC | `packages/dashboard/.env.local` on the Mac: `GATEWAY_API_KEY=<the gateway's key>` and `GATEWAY_INTERNAL_URL=http://<PC_IP>:4000` | `HOST=0.0.0.0`, default `CORS_ORIGIN=http://localhost:3000` | Gateway URL `http://<PC_IP>:4000` and the API key |

`<PC_IP>` is the Windows PC's private LAN address (`ipconfig`). Do not expose port 4000 beyond the private network: restrict the
firewall rule to the local subnet (`-RemoteAddress LocalSubnet`, `-Profile Private`), and never forward it on a router.

What the header shows, and what it means: `PHYSICAL HARDWARE` / `MOCK SIMULATION` is what the gateway itself reports. `HARDWARE
UNKNOWN` means the gateway has not answered at all (it says nothing about a mock). `KEY REQUIRED` means the gateway is running
but refused the key saved in this browser. `NO ROUTE` means the dashboard server can reach the gateway but this browser cannot
(wrong address in Settings, or `CORS_ORIGIN` does not match the page's address). `OFFLINE` means no gateway is answering at the
address shown on hover. COM ports read "unknown" until the gateway answers, and "not configured on the gateway" only if the
gateway reported none.

1. On your macOS development machine, start the dashboard:
   ```bash
   npm run dev:dashboard
   ```
2. Navigate to `http://localhost:3000/settings`.
3. Set **Gateway API URL** to: `http://<WINDOWS_PC_LAN_IP>:4000`.
4. Enter your **Gateway API Key**.
5. Click **Test API Connection**:
   - Status badge turns green: `ONLINE (hardware)`.
   - The Overview page will now display live RSSI signal bars (4 bars, RSSI 23), Vi India carrier (LTE), and real physical incoming and outgoing calls!
