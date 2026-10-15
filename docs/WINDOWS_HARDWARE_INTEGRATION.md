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

| Port | Config Name | Verified COM (Current Windows Host) | Purpose |
|---|---|---|---|
| **AT Command Interface** | `MODEM_AT_PORT` | `COM20` | AT commands, call setup, URCs, network status, DTMF (115200 8-N-1) |
| **Virtual Audio / NMEA** | `MODEM_AUDIO_PORT` | `COM19` | Serial byte stream observed during active calls; codec, framing, and playback direction are not verified |
| **Diagnostics / Modem** | — | — | Qualcomm/SIMCOM firmware flashing and diagnostic logs |

*Note: The project records COM20 as the AT interface and COM19 as the audio/NMEA
interface, but it does not record the physical USB VID/PID, carrier-board model,
or a verified audio protocol. Run the read-only inspection script below on the
Windows host before treating these mappings as hardware evidence.*

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

The repository-confirmed facts are only the SIMCOM SIM7600EI family, the
configured COM20/COM19 assignments, and the 115200 serial setting. The exact
carrier-board model, USB identity, physical modem firmware revision, and
official SIMCom COM19 audio-interface specification must come from this
diagnostic and the board/modem documentation.

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
# Network Binding (Listen on all local network interfaces)
PORT=4000
HOST=0.0.0.0
NODE_ENV=production

# Mandatory Security Token (Must be at least 8 characters; never use development placeholders)
GATEWAY_API_KEY=your-secure-production-secret-token-32chars
CORS_ORIGIN=http://192.168.1.50:3000

# Physical Modem Driver (Strictly selects Sim7600HardwareAdapter - no mock fallback)
MODEM_DRIVER=hardware
MODEM_AT_PORT=COM20
MODEM_AT_BAUD=115200
MODEM_AUDIO_PORT=COM19
MODEM_AUDIO_BAUD=115200

# Command Timeouts & Resiliency
MODEM_COMMAND_TIMEOUT_MS=5000
MODEM_DIAL_TIMEOUT_MS=20000
MODEM_AUTO_RECONNECT=true

# Audio Diagnostic Capture (Unvalidated Raw Stream)
AUDIO_SAMPLE_RATE=8000
AUDIO_CHANNELS=1
AUDIO_BIT_DEPTH=16
AUDIO_ENABLE_RAW_DUMP=true
AUDIO_DUMP_DIRECTORY=./audio-dumps
# Must be explicitly enabled for the manual CPCMREG diagnostic
AUDIO_USB_DIAGNOSTIC_ENABLED=false

# Database Persistence
SQLITE_DB_PATH=./data/gateway.sqlite
```

The sample rate, channel count, and bit depth above are target configuration
values only. The repository does not include a SIM7600EI audio protocol
definition proving that COM19 carries linear PCM, a framed codec, or
host-to-modem playback. Do not send arbitrary audio bytes to COM19 until the
manual bidirectional test confirms the transport and format.

The USB-audio diagnostic is disabled by default. When explicitly enabled, the
authenticated endpoint `POST /api/gateway/audio/usb-diagnostic` accepts
`{"action":"activate"}` or `{"action":"deactivate"}`. Activation is allowed
only while the call is ACTIVE and issues `AT+CPCMREG=1` through the existing
COM20 AT queue. Call cleanup issues `AT+CPCMREG=0` once when activation
succeeded. No audio payload is written.

---

## 3. Verified Modem Hardware Baseline (PowerShell)

The following baseline has already been confirmed on the physical Windows PC via PowerShell terminal before running the service:

```text
Port: COM20 at 115200 baud
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
[Gateway] Physical AT Port: COM20 @ 115200 baud
[Gateway] Physical Audio Port: COM19 @ 115200 baud
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
    "atPort": "COM20",
    "audioPort": "COM19",
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

## 5. Manual COM19 Audio Qualification (No Automatic Dial)

Start the gateway with debug logging, then place one authorized call manually
through the existing dashboard or API. During the active call, verify that the
gateway reports inbound byte counts on COM19. If testing playback, use only
known test data after confirming the modem documentation and endpoint format;
do not infer PCM from byte counts alone. Record whether the remote party hears
the playback and stop the call manually.

The gateway diagnostics record timestamps, chunk sizes, write success/failure,
stream errors, and aggregate statistics. They do not log audio content, phone
numbers, or API credentials. A successful serial write alone does not prove
that the modem transmitted audible audio.

## 6. Connecting from the macOS Dashboard

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
