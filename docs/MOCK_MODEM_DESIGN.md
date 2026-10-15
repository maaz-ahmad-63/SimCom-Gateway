# Mock Modem Adapter Design: SIM7600EI Cellular Gateway

## 1. Objectives & Design Principles

The `MockModemAdapter` allows complete development, debugging, and end-to-end verification of the cellular gateway on macOS (or any machine) without physical hardware.

### Key Guarantees:
1. **Interface Equivalence**: Implements the identical `IModemAdapter` interface as the physical hardware driver. The `CallSessionManager` interacts with both identically.
2. **AT Protocol Emulation**: Supports sending AT command strings and receiving realistic text responses (`OK`, `ERROR`, `+CSQ: 24,99`, etc.) with asynchronous timing delays.
3. **Realistic URC Simulation**: Automatically generates unsolicited result codes (`RING`, `+CLIP`, `NO CARRIER`) adhering to SIM7600EI timing specifications (e.g., standard 3-second GSM ring intervals).
4. **Anti-Confusion Guarantee**: All status events, health metrics, and database entries emitted while using the mock adapter are strictly tagged with `isSimulated: true` and `driverType: "mock"`.
5. **Scenario Scriptability**: Exposes programmatic and REST-controllable hooks to trigger specific phone call scenarios (inbound calls, remote rejections, signal drops, busy signals, audio noise).

---

## 2. Architecture & Internal State Machine

```
                            +------------------------------------+
                            |         MockModemAdapter           |
                            +-----------------+------------------+
                                              |
                     +------------------------+------------------------+
                     |                                                 |
         +-----------v------------+                       +------------v-------------+
         |   AT Command Engine    |                       |      URC Event Engine    |
         |  - Command Router      |                       |  - Ring Timer (3000ms)   |
         |  - Parameter Extractor |                       |  - Caller ID Formatter   |
         |  - Response Synthesizer|                       |  - Signal Fluctuation    |
         +-----------+------------+                       +------------+-------------+
                     |                                                 |
                     +------------------------+------------------------+
                                              |
                                 +------------v-------------+
                                 |   Virtual Modem State    |
                                 |  - Registration: Home 4G |
                                 |  - Signal (CSQ): 24      |
                                 |  - Call State: IDLE/RING |
                                 |  - Audio Ch: Enabled     |
                                 +--------------------------+
```

### Virtual State Variables:
- `registrationState`: `NOT_REGISTERED (0)` | `REGISTERED_HOME (1)` | `SEARCHING (2)` | `DENIED (3)` | `ROAMING (5)`. Default: `REGISTERED_HOME`.
- `signalRssi`: 0 to 31 (default: 24, representing ~ -65 dBm).
- `pinStatus`: `READY` | `SIM_PIN` | `SIM_PUK`. Default: `READY`.
- `callState`: `IDLE` | `DIALING` | `ALERTING` | `INBOUND_RINGING` | `ACTIVE` | `HANGING_UP`.
- `remotePartyNumber`: Current caller / callee string.
- `ringCounter`: Counts rings before auto-timeout if un-answered.
- `audioActive`: Boolean indicating if virtual COM13 audio stream is streaming.

---

## 3. Emulated SIM7600EI AT Command Set

| Command | Emulated Behavior / Output | Typical Latency |
|---|---|---|
| `AT` | Returns `OK` | 30ms |
| `ATE0` / `ATE1` | Toggles command echo; returns `OK` | 30ms |
| `ATI` | Returns `Manufacturer: SIMCOM\nModel: SIMCOM_SIM7600EI\nRevision: SIM7600M21-A_V1.1\nOK` | 50ms |
| `AT+CPIN?` | Returns `+CPIN: READY\nOK` | 40ms |
| `AT+CSQ` | Returns `+CSQ: <rssi>,99\nOK` (with configurable random RSSI drift ±2) | 50ms |
| `AT+CREG?` | Returns `+CREG: 0,1\nOK` (Network registered, home network) | 50ms |
| `AT+COPS?` | Returns `+COPS: 0,0,"Vi India",7\nOK` (Vi India, LTE mode 7) | 80ms |
| `AT+CLIP=1` | Enables incoming caller ID display; returns `OK` | 40ms |
| `ATD<number>;` | Validates E.164 number. If already in a call, returns `BUSY`. Otherwise returns `OK` and begins dialing sequence. | 100ms |
| `ATA` | If state is `INBOUND_RINGING`, stops ring timer, transitions to `ACTIVE`, returns `OK`. If `IDLE`, returns `ERROR`. | 80ms |
| `ATH` / `AT+CHUP` | If in call or ringing, terminates call, emits `VOICE CALL: END: <duration>`, transitions to `IDLE`, returns `OK`. | 60ms |
| `AT+VTS=<digit>` | Emits DTMF tone event; returns `OK` | 40ms |
| `AT+CPCMREG=1` | Simulates enabling PCM/USB audio streaming on COM13; returns `OK` | 50ms |
| `AT+CLCC` | Returns current call list: `+CLCC: 1,<dir>,<state>,0,0,"<number>",145\nOK` | 50ms |

---

## 4. Scriptable Simulation Scenarios

The `MockModemAdapter` provides a programmatic API (`mockModem.simulateScenario(...)`) and dev REST endpoints:

### Scenario 1: Outbound Call Answered (Normal Flow)
1. Application issues `dial("+919876543210")`.
2. Mock returns `OK`, state becomes `DIALING`.
3. After 1500ms delay, mock emits alerting state (`OUTBOUND_RINGING`).
4. After 2500ms delay (configurable via `MOCK_OUTBOUND_AUTO_ANSWER_DELAY_MS`), mock emits `VOICE CALL: BEGIN` event.
5. State transitions to `ACTIVE`. Virtual COM13 audio stream starts.
6. User can click Hangup or trigger remote hangup: mock emits `NO CARRIER` and `VOICE CALL: END: 28`.

### Scenario 2: Outbound Call Busy / Rejected
1. Application issues `dial("+919876543210")`.
2. Mock returns `OK`.
3. After 2000ms delay, mock emits `BUSY` and transitions to `IDLE` with outcome `busy`.

### Scenario 3: Inbound Call Answered
1. Triggered via `mockModem.simulateInboundCall("+919123456789")`.
2. Mock emits `RING` and `+CLIP: "+919123456789",145`.
3. Mock repeats `RING` every 3000ms up to 6 times.
4. Application issues `answer()`.
5. Mock stops ring timer, emits `VOICE CALL: BEGIN`, state becomes `ACTIVE`.
6. Virtual COM13 audio stream starts delivering test audio frames.

### Scenario 4: Inbound Call Missed / Rejected
1. Inbound call triggered. Rings 4 times without answer.
2. Mock emits `NO CARRIER` and transitions back to `IDLE` with outcome `missed`.

### Scenario 5: Network Disconnect / Hardware Drop
1. Triggered via `mockModem.simulatePortDisconnect()`.
2. Mock simulates port loss (`Error: Port closed unexpectedly`).
3. Gateway triggers reconnection loop, updating status to `DISCONNECTED`.

---

## 5. Mock Audio Data Generation

During an active mock call, the `MockAudioAdapter` generates standard test audio chunks to emulate COM13 activity:
- Chunk size: 320 bytes (representing 20ms of 8000Hz, 16-bit mono audio).
- Audio payload: Synthesized 440Hz sine wave tone or low-amplitude white noise.
- Cadence: Emits an `audio_frame` event every 20ms using `setInterval`.
- Buffer verification: Audio inspector on dashboard can verify frame rate (50 fps) and compute RMS level to animate audio VU meters.
