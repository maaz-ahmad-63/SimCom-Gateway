# SIM7600EI Cellular Gateway - Architecture Specification

## 1. Executive Overview

The **SIM7600EI Cellular Gateway** is a modular, high-reliability gateway service designed to interface a host PC with a SIMCOM SIM7600EI 4G LTE cellular modem for voice calls, audio capture/playback, and future AI voice agent interactions.

### Deployment Topologies
- **Production Environment**: Windows PC directly connected via USB to the physical SIM7600EI modem (modem AT control on `COM14`, USB audio virtual serial stream on `COM13`, Vi India SIM card).
- **Development & Control Environment**: macOS (Apple Silicon) or any workstation running a mock modem adapter and/or remote dashboard connecting over local network (LAN) or secure tunnel.
- **Future AI Integration**: Isolated via clean provider-agnostic interfaces ready for VART-AI or custom STT/LLM/TTS pipelines.

```
+---------------------------------------------------------------------------------------+
|                                    REMOTE CLIENT                                      |
|  +---------------------------------------------------------------------------------+  |
|  |                     Next.js Dark Dashboard (Mac / Web)                          |  |
|  |       [Dialer / Live Call UI] [Modem Telemetry] [Audio Inspector] [History]     |  |
|  +---------------------------------------------------------------------------------+  |
+------------------------------------------+--------------------------------------------+
                                           |
                                  HTTPS & WSS (Socket.IO)
                                  [API Key Authentication]
                                           |
+------------------------------------------v--------------------------------------------+
|                                GATEWAY SERVICE CORE                                   |
|                                (Node.js + TypeScript)                                 |
|                                                                                       |
|  +---------------------------+  +-------------------------+  +---------------------+  |
|  |     Express REST API      |  |  Socket.IO Event Hub    |  | SQLite Local Store  |  |
|  |  (Zod validated routes)   |  | (Live event broadcast)  |  | (WAL Mode, History) |  |
|  +-------------+-------------+  +------------+------------+  +----------+----------+  |
|                |                             |                          |             |
|  +-------------v-----------------------------v--------------------------v----------+  |
|  |                             Call Session Manager                                |  |
|  |     - Strict Single-Call Concurrency Guard     - Call State Machine             |  |
|  |     - Timers, Duration, State Tracking         - Event Bus & Router             |  |
|  +-------------------+-----------------------+--------------------+----------------+  |
|                      |                       |                    |                   |
|  +-------------------v---+   +---------------v---+   +------------v----------------+  |
|  |     Modem Adapter     |   |   Audio Adapter   |   |      Voice AI Adapter       |  |
|  |     (IModemAdapter)   |   |  (IAudioAdapter)  |   |     (IVoiceAIAdapter)       |  |
|  +-----------+-----------+   +---------+---------+   +------------+----------------+  |
|              |                         |                          |                   |
+--------------|-------------------------|--------------------------|-------------------+
               |                         |                          |
    +----------+----------+    +---------+---------+     +----------+---------+
    |                     |    |                   |     |                    |
    v                     v    v                   v     v                    v
+--------+            +------+ +--------+       +------+ +--------+       +-------+
| COM14  |            | Mock | | COM13  |       | Mock | |  STT   |       |  TTS  |
| Serial |            | AT   | | Serial |       | Audio| | Deepgram/      | Cartesia/
| (Win)  |            | Modm | | (Win)  |       | Tone | | Whisper|       | 11Labs|
+--------+            +------+ +--------+       +------+ +--------+       +-------+
```

---

## 2. Core Architectural Principles

1. **Hardware Independence & Mock Fidelity**:
   Business logic must never import serial port libraries or depend on physical devices. All hardware interaction is encapsulated behind interface contracts (`IModemAdapter`, `IAudioAdapter`). The mock driver precisely emulates AT commands, response timing, and unsolicited result codes (URCs).
2. **Simulation Transparency**:
   Simulated data is NEVER passed off as real hardware data. Every status update, call event, and database record carries an explicit `isSimulated: boolean` flag and driver identifier (`mock` vs `hardware`).
3. **Single Concurrent Call Guard**:
   The gateway enforces a strict lock: exactly one active call (inbound ringing, dialing, active, or terminating) can exist at any given time. Attempting an outbound call while a call is active returns HTTP `409 Conflict`. Inbound calls received while busy automatically trigger an immediate modem reject (`ATH` or `AT+CHUP`) and record a `busy_rejected` outcome.
4. **Zero-Assumption Audio Pipeline**:
   The SIM7600EI COM13 virtual audio stream receives data during calls, but the exact format (PCM 8kHz 16-bit mono, AMR-NB, IMA ADPCM, or custom SIMCOM framing) is unvalidated. The audio adapter treats the stream as a raw byte stream with configurable frame chunking, raw circular buffer recording, and diagnostic file dumping for frequency and header inspection.
5. **Port Exclusivity and Failure Recovery on Windows**:
   When running on Windows, the gateway opens `COM14` and `COM13` with exclusive OS locks (`lock: true`). If a port is disconnected, the modem adapter transitions to `DISCONNECTED` state, triggers visual dashboard alerts, and executes exponential backoff reconnection.
6. **Network Security & Remote Dashboard**:
   The gateway server defaults to binding to `127.0.0.1` in development. In remote mode (e.g. Windows gateway host serving a macOS dashboard), it binds to `0.0.0.0` or a specific LAN IP, enforces an `X-API-Key` on all HTTP routes and Socket.IO handshake auth, and restricts CORS to specified origins.

---

## 3. System Components & Layer Boundaries

### 3.1 Gateway Core (`packages/gateway/src/core`)
- **CallSessionManager**: Holds the authoritative active call state, coordinates modem dialing/answering, connects audio streams upon answer, and stops audio on termination.
- **CallStateMachine**: Strict finite state machine (FSM) enforcing valid state transitions:
  `IDLE -> DIALING -> OUTBOUND_RINGING -> ACTIVE -> TERMINATING -> IDLE`
  `IDLE -> INBOUND_RINGING -> ACTIVE -> TERMINATING -> IDLE`
  `* -> FAILED / REJECTED -> IDLE`
- **GatewayEventBus**: In-process typed event emitter (`TypedEventEmitter`) distributing events between adapters, state machine, SQLite logger, and Socket.IO broadcaster.

### 3.2 Modem Layer (`packages/gateway/src/adapters/modem`)
- **Interface**: `IModemAdapter`
- **Implementations**:
  - `Sim7600HardwareAdapter`: Manages `COM14` using Node `serialport` with readline/raw parsers, command execution queue with timeouts, and continuous URC listener for:
    - Ringing & Caller ID: `RING`, `+CLIP: "+919876543210",145`
    - Call Progress: `+CLCC`, `VOICE CALL: BEGIN`, `VOICE CALL: END: <duration>`
    - Signal & Network: `+CSQ`, `+CREG`, `+COPS`
  - `MockModemAdapter`: In-memory simulator executing identical AT command sequences, configurable simulated network latency, simulated inbound ring triggers, and error injection.

### 3.3 Audio Layer (`packages/gateway/src/adapters/audio`)
- **Interface**: `IAudioAdapter`
- **Implementations**:
  - `Sim7600UsbAudioAdapter`: Connects to `COM13` (opened only when a call enters `ACTIVE` state or on warm standby). Captures raw buffers, slices them into uniform millisecond frames (e.g. 20ms chunks), emits `audio_frame` events, and routes inbound/outbound audio streams.
  - `MockAudioAdapter`: Generates synthetic audio packets (e.g. 8kHz 16-bit sine wave test tone or silence) matching the expected frame interval to test downstream pipelines.
- **Diagnostics**:
  - `AudioDumpService`: Automatically writes raw `.bin`/`.pcm` and diagnostic headers to `audio-dumps/call_<id>_<timestamp>.raw` for analysis with Audacity/FFmpeg.

### 3.4 Voice AI Layer (`packages/gateway/src/adapters/ai`)
- **Interface**: `IVoiceAIAdapter`, `ISTTProvider`, `ILLMProvider`, `ITTSProvider`
- Decoupled from hardware: accepts audio stream chunks from `IAudioAdapter` and produces audio chunks to feed back to `IAudioAdapter`.
- Designed for plug-and-play integration with VART-AI or cloud providers (OpenAI Realtime, Deepgram, Cartesia, ElevenLabs).

### 3.5 Storage Layer (`packages/gateway/src/db`)
- SQLite database via `better-sqlite3` operating in Write-Ahead Logging (`WAL`) mode.
- Tables:
  - `calls`: Records `id`, `direction`, `remote_number`, `started_at`, `answered_at`, `ended_at`, `duration_seconds`, `status`, `termination_reason`, `is_simulated`.
  - `call_events`: Granular timeline of AT events, URCs, audio states, and errors per call.
  - `gateway_config`: Dynamic configuration key-values (audio sample rates, mock triggers, carrier settings).

### 3.6 Communication Layer (`packages/gateway/src/api`)
- **REST API (Express)**:
  - `POST /api/calls/dial`: Initiate outbound call (validated with Zod).
  - `POST /api/calls/answer`: Answer incoming call.
  - `POST /api/calls/hangup`: Terminate active or ringing call.
  - `POST /api/calls/dtmf`: Send DTMF tone.
  - `GET /api/calls/current`: Get current active call session.
  - `GET /api/calls/history`: Query paginated call history.
  - `GET /api/gateway/health`: Modem connection, signal quality, port status, simulation flag.
  - `POST /api/mock/trigger-inbound`: Trigger simulated incoming call (dev only).
- **Real-Time Hub (Socket.IO)**:
  - Namespace: `/events`
  - Typed server-to-client events: `call:state_changed`, `modem:telemetry`, `modem:urc`, `audio:level`, `gateway:alert`.

### 3.7 Dashboard (`packages/dashboard`)
- Built with Next.js (App Router), TypeScript, Tailwind CSS, and shadcn/ui.
- Aesthetic: Deep charcoal dark theme, neon amber/emerald status accents, high-contrast monospace telemetries.
- Runs natively on macOS development machine or deployed standalone, connecting to the Windows Gateway host via configurable URL and API token.

---

## 4. Concurrency & State Machine

```
               [IDLE]
                 |
        +--------+--------+
        |                 |
  (Initiate Dial)    (URC: RING / CLIP)
        v                 v
   [DIALING]       [INBOUND_RINGING]
        |                 |
(URC: Alerting)      (API: Answer)
        v                 |
[OUTBOUND_RINGING]        |
        |                 |
  (Remote Answer)         |
        +--------+--------+
                 |
                 v
              [ACTIVE]  <--->  [COM13 Audio Streaming]
                 |
     (Remote Hangup / API Hangup / Error)
                 v
           [TERMINATING]
                 |
           (Audio Closed, Modem Idle)
                 v
               [IDLE]
```

---

## 5. Security & Network Hardening

1. **Authentication**: All endpoints and Socket.IO connections require `Authorization: Bearer <token>` or `X-API-Key: <token>`.
2. **Safe Defaults**: If `GATEWAY_API_KEY` is not provided or equals default placeholder in production, the service refuses to start.
3. **CORS Restrictions**: Configured strictly to the dashboard's URL.
4. **Input Sanitization**: Phone numbers are validated via E.164 regex format `^\+?[1-9]\d{1,14}$` using Zod before reaching the AT command builder, preventing AT command injection (e.g. `ATD+919876543210;\r\nAT+CFUN=0`).
