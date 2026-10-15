# Test Strategy: SIM7600EI Cellular Gateway

## 1. Overview & Objectives

The test strategy ensures that all gateway logic, state machines, AT parsers, audio stream handlers, and API endpoints are thoroughly validated before any physical deployment onto the Windows host.

Because development occurs on macOS without physical hardware, the test suite relies on deterministic simulation and strict mock adherence, followed by an automated Hardware-in-the-Loop (HIL) qualification suite when connected to the Windows PC.

---

## 2. Test Pyramid & Tooling

```
               / \
              /   \
             / HIL \           (Hardware-in-the-Loop: Windows PC + SIM7600EI)
            /-------\
           /   E2E   \         (Dashboard + Gateway API + Mock Modem)
          /-----------\
         / Integration \       (Express REST + Socket.IO + SQLite + Mock Modem)
        /---------------\
       /      Unit       \     (AT Parser, State Machine, Concurrency, Zod, Chunker)
      /-------------------\
```

- **Test Runner**: Vitest (`vitest`)
- **Assertions**: Native Vitest `expect`
- **HTTP Integration**: `supertest`
- **Socket Integration**: `socket.io-client`
- **Mocking**: Vitest mocks (`vi.fn()`, `vi.useFakeTimers()`)
- **Coverage Tool**: Vitest `@vitest/coverage-v8` with minimum 90% threshold for core business logic.

---

## 3. Unit Test Suites

### 3.1 Call State Machine & Concurrency Guard (`packages/gateway/tests/unit/call-state-machine.test.ts`)
- **Initial State**: Verifies initial state is `IDLE`.
- **Valid Outbound Lifecycle**: `IDLE -> DIALING -> OUTBOUND_RINGING -> ACTIVE -> TERMINATING -> IDLE`.
- **Valid Inbound Lifecycle**: `IDLE -> INBOUND_RINGING -> ACTIVE -> TERMINATING -> IDLE`.
- **Illegal Transitions**: Asserts that invalid transitions throw `InvalidStateTransitionError` (e.g. attempting to answer while in `IDLE`, or dialing while `ACTIVE`).
- **Single Concurrency Lock**:
  - Outbound dial while `ACTIVE` is rejected immediately with `GatewayBusyError`.
  - Inbound ring received while `ACTIVE` triggers modem `REJECT` and records `BUSY_REJECTED` in DB without altering active call.
- **Timers**: Verifies accurate calculation of `durationSeconds` (from `answered_at` to `ended_at`).

### 3.2 AT Command Parser & URC Tokenizer (`packages/gateway/tests/unit/at-parser.test.ts`)
- **Stream Fragmentation**: Feeds AT response split across arbitrary chunks (e.g., `["\r\n+", "CLIP: \"+", "919876543210\",14", "5\r\n"]`) and asserts proper reassembly into a single URC event.
- **Noise Filtering**: Verifies garbage characters before or after standard lines are ignored.
- **Command Response Matching**: Ensures command callbacks resolve only on terminal tokens (`OK`, `ERROR`, `CME ERROR: <code`).
- **AT Injection Prevention**: Validates that phone numbers containing `\r`, `\n`, `;`, or additional AT strings fail Zod validation before reaching the serial write buffer.

### 3.3 Audio Stream Chunker & Diagnostics (`packages/gateway/tests/unit/audio-chunker.test.ts`)
- **Buffer Slicing**: Slices arbitrary byte streams (e.g., 100 bytes, 500 bytes) into uniform 320-byte (20ms) frames without dropping bytes.
- **Zero-Assumption Audio Handling**: Asserts that raw byte buffers are captured without assuming format, endianness, or sample rate.
- **Raw Diagnostic Writer**: Verifies raw audio buffers are written to disk along with JSON metadata describing byte count, start time, and active call ID.

---

## 4. Integration Test Suites

### 4.1 Mock Modem Full Call Lifecycle (`packages/gateway/tests/integration/mock-modem-call.test.ts`)
- **Outbound Flow**:
  1. Trigger `callManager.dial("+919876543210")`.
  2. Verify state progresses `DIALING` -> `OUTBOUND_RINGING` -> `ACTIVE`.
  3. Verify audio stream starts delivering mock audio packets.
  4. Trigger `callManager.hangup()`.
  5. Verify audio stream closes, state returns to `IDLE`, and call record is written to SQLite.
- **Inbound Flow**:
  1. Trigger `mockModem.simulateInboundCall("+919123456789")`.
  2. Verify `INBOUND_RINGING` event emitted with caller ID.
  3. Trigger `callManager.answer()`.
  4. Verify state becomes `ACTIVE`.
  5. Verify mock hangup returns state to `IDLE`.

### 4.2 REST API & Security (`packages/gateway/tests/integration/api.test.ts`)
- **Authentication**: Requests without `X-API-Key` or `Authorization: Bearer <token>` return `401 Unauthorized`.
- **Validation**: `POST /api/calls/dial` with invalid phone number returns `400 Bad Request` with Zod validation details.
- **Concurrency Conflict**: Calling `POST /api/calls/dial` while a call is active returns `409 Conflict`.
- **Health Check**: `GET /api/gateway/health` returns `200 OK` with `isSimulated: true`, modem status, and signal metrics.

### 4.3 Socket.IO Real-Time Hub (`packages/gateway/tests/integration/socket.test.ts`)
- Connects a real `socket.io-client` with auth token.
- Verifies reception of `call:state_changed` events in exact order.
- Verifies reception of `modem:telemetry` heartbeat events.

---

## 5. Hardware-in-the-Loop (HIL) Test Harness (Windows Deployment)

For deployment on the Windows PC with the SIM7600EI modem:

```bash
# Run physical hardware qualification suite on Windows host
npm run test:hil -- --port COM14 --audio-port COM13 --test-number +91XXXXXXXXXX
```

1. **Port Availability & Lock Test**: Asserts `COM14` and `COM13` can be opened exclusively and fails gracefully if another process has them open.
2. **Modem Ping & Firmware Verification**: Asserts `ATI` returns `SIMCOM_SIM7600EI` and firmware `SIM7600M21-A_V1.1`.
3. **SIM Card & Carrier Registration**: Verifies `AT+CPIN?` is `READY` and `AT+COPS?` reports `Vi India`.
4. **Signal Quality Check**: Verifies `AT+CSQ` returns RSSI >= 12.
5. **Physical Call Verification**:
   - Automated outbound ring test to test mobile number.
   - Verified audio data reception on `COM13`.
   - Automatic termination after 5 seconds of active state.
   - Raw audio dump generated in `audio-dumps/` for manual audio listening verification.
