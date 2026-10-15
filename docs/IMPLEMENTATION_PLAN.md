# Phased Implementation Plan: SIM7600EI Cellular Gateway

This document outlines the step-by-step phased roadmap for engineering the SIM7600EI Cellular Gateway. Each phase builds upon verified previous deliverables without assuming premature access to physical hardware.

---

## Phase 1: Foundation, Core Abstractions, Types & Mock Modem (CURRENT MILESTONE)

**Goal**: Establish the repository foundation, complete TypeScript contracts across all layers, implement the single-call state machine, and construct the high-fidelity mock modem adapter with Vitest coverage.

### Deliverables:
1. **Shared Contract Package (`packages/shared`)**:
   - Complete TypeScript interfaces for Modem, Call Control, Audio, AI Providers, Gateway State, and Socket.IO Events.
   - Zod validation schemas for phone numbers, dial requests, DTMF, configuration, and API payloads.
2. **Call Session Manager & State Machine (`packages/gateway/src/core`)**:
   - Single concurrent call lock ensuring atomic call transitions.
   - Timers for ringing timeout, answer detection, and duration computation.
   - In-memory event bus decoupling state transitions from transport.
3. **High-Fidelity Mock Modem Engine (`packages/gateway/src/adapters/modem/mock`)**:
   - Command parser matching SIM7600EI AT syntax (`AT`, `ATI`, `AT+CSQ`, `AT+CREG?`, `ATD<num>;`, `ATA`, `ATH`, `AT+CPIN?`).
   - Asynchronous URC generation (`RING`, `+CLIP`, `NO CARRIER`, `BUSY`).
   - Scriptable scenarios: inbound ringing, remote answering, remote busy, remote rejection, network drop.
   - Injected simulation metadata (`isSimulated: true`) on all outputs.
4. **Mock Audio Stream Generator (`packages/gateway/src/adapters/audio/mock`)**:
   - Generates synthetic 20ms audio chunks (sine wave test tone / silent frames) when a call is `ACTIVE`.
5. **Automated Unit & Scenario Tests (`packages/gateway/tests`)**:
   - State machine transition tests.
   - Concurrency guard tests (verifying 2nd call rejection).
   - Mock modem call lifecycle execution via Vitest.

**Exit Criteria**:
- `npm run test` passes 100% on macOS.
- Complete call lifecycles (dial -> answer -> hangup, and inbound ring -> answer -> hangup) successfully executed and verified entirely in simulation.

---

## Phase 2: Gateway API, Real-Time Socket.IO, & SQLite Persistence

**Goal**: Expose REST endpoints, implement real-time bidirectional Socket.IO event hub, and persist call history and gateway telemetry to SQLite.

### Deliverables:
1. **SQLite Database Layer (`packages/gateway/src/db`)**:
   - SQLite initialization via `better-sqlite3` with WAL mode.
   - Migration runner and schema definitions: `calls`, `call_events`, `gateway_telemetry`.
   - Data access objects (DAOs) for recording call start, status transitions, duration, audio dump paths, and outcomes.
2. **REST API Server (`packages/gateway/src/api`)**:
   - Express server with JSON parser and error-handling middleware.
   - API key authentication middleware (`Authorization: Bearer <token>` or `X-API-Key`).
   - Dial, Answer, Hangup, DTMF, Call History, and Gateway Health endpoints.
   - Development mock trigger endpoints (`POST /api/mock/trigger-inbound`, `POST /api/mock/simulate-disconnect`).
3. **Socket.IO Real-Time Gateway (`packages/gateway/src/api/socket`)**:
   - Socket.IO server bound to HTTP server with typed event schemas.
   - Authentication middleware validating API key during connection handshake.
   - Subscriptions to CallSessionManager events broadcasting state changes, telemetry, and audio levels to connected dashboards.
4. **Integration Tests**:
   - Supertest + Socket.IO client tests verifying REST operations and real-time event delivery.

**Exit Criteria**:
- REST endpoints and Socket.IO events verified via automated integration tests.
- Call records and state transitions persisted and queryable from SQLite.

---

## Phase 3: Hardware Drivers (Windows COM14 AT & COM13 Audio Transport)

**Goal**: Implement physical serial port drivers for the SIM7600EI modem on Windows with exclusive locking and resilient reconnection logic.

### Deliverables:
1. **Physical Modem Adapter (`packages/gateway/src/adapters/modem/hardware`)**:
   - Serial communication via `serialport` library with exclusive port locking (`lock: true`).
   - Line-delimited AT command queue with customizable timeouts per command.
   - Continuous background URC demultiplexer extracting `RING`, `+CLIP`, `+CSQ`, `+CREG`, `+CMTE`.
   - Initial modem bootstrap sequence: echo off (`ATE0`), caller ID enable (`AT+CLIP=1`), signal reporting (`AT+AUTOCSQ=1,1`), audio channel config.
   - Automatic reconnect and port recovery on USB disconnect or driver re-enumeration.
2. **Physical USB Audio Adapter (`packages/gateway/src/adapters/audio/hardware`)**:
   - Dedicated connection to `COM13` with exclusive port lock.
   - Raw binary stream capture into circular byte buffer.
   - Audio frame slicer delivering fixed 20ms chunks regardless of serial buffer fragmentation.
   - Continuous audio file recorder saving raw byte streams to `audio-dumps/` with timestamp and metadata file for offline analysis.
3. **Audio Diagnostic CLI Tool**:
   - Standalone CLI utility to inspect captured COM13 bytes, detect entropy/bit depth, and generate test WAV headers for Audacity playback.

**Exit Criteria**:
- Clean abstraction switch between `MODEM_DRIVER=mock` and `MODEM_DRIVER=hardware` via configuration.
- Robust handling of port locks and serial connection drops.

---

## Phase 4: Modern Web Dashboard (Next.js, Tailwind CSS, shadcn/ui)

**Goal**: Build a dark, responsive dashboard running on macOS (or any browser) connecting remotely to the Windows Gateway.

### Deliverables:
1. **Next.js Dashboard App (`packages/dashboard`)**:
   - App Router architecture, TypeScript, Tailwind CSS, Lucide icons, and shadcn/ui components.
   - Dark mode design system: obsidian/slate background, neon status indicators (emerald for active call, amber for ringing, ruby for errors, cyan for mock mode).
2. **Key Views**:
   - **Live Call & Dialer**: Interactive dial pad, active call card with live timer, caller ID display, answer/hangup buttons, DTMF keypad.
   - **Modem Telemetry Bar**: Real-time signal strength (CSQ / dBm), carrier name (Vi India), registration status (4G VoLTE), hardware vs simulated badge.
   - **Audio Stream Inspector**: Live VU meter showing inbound audio activity, raw buffer bitrate, and one-click diagnostic recording downloads.
   - **Call History Table**: Paginated history with direction badges, duration, outcome, timestamps, and detail inspector.
   - **Gateway Configuration & Mock Controller**: Dev panel to trigger mock inbound calls or simulate network scenarios directly from the UI.
3. **Resilient Network Client**:
   - Auto-reconnecting Socket.IO client with connection status banner.
   - Secure token storage and configurable gateway remote host URL.

**Exit Criteria**:
- Dashboard operates smoothly on macOS, connects to the gateway backend, reflects call state in real time with zero page reloads, and permits full call management.

---

## Phase 5: Voice AI Adapter Integration

**Goal**: Implement the isolated AI voice bridge connecting the call audio streams with STT, LLM, and TTS providers.

### Deliverables:
1. **Audio Duplex Pipeline**:
   - Bidirectional stream routing: COM13 raw audio -> STT provider; TTS audio chunk stream -> COM13 raw playback.
2. **Pluggable AI Interfaces**:
   - `ISTTProvider`: Streaming speech-to-text (e.g. Deepgram Nova-2, Whisper).
   - `ILLMProvider`: Streaming conversational intelligence with function calling and interruption handling.
   - `ITTSProvider`: Low-latency streaming text-to-speech (e.g. Cartesia, ElevenLabs).
3. **Full-Duplex Session Manager**:
   - Turn detection, barge-in / interruption handling (stopping TTS playback when user speaks), conversation memory.

**Exit Criteria**:
- Mock AI conversation loop tested against mock audio stream in unit tests.

---

## Phase 6: End-to-End Validation & Hardening on Windows PC

**Goal**: Deploy onto physical Windows hardware, validate with SIMCOM SIM7600EI and Vi India SIM, and verify physical audio exchange.

### Deliverables:
1. **Windows Deployment Package**:
   - Production setup script, Windows service runner (e.g. via `node-windows` or PM2), and automated port detection.
2. **Hardware Acceptance Testing**:
   - Outbound physical call to phone with live duration and tear-down.
   - Inbound call from phone with live ring detection, caller ID (+CLIP), and gateway answering.
   - Capture of COM13 USB audio during physical call, format verification (PCM/WAV/AMR), and verified two-way audio transmission.
3. **Operational Hardening**:
   - Crash restart policies, log rotation, and memory leak checks over 24-hour soak test.
