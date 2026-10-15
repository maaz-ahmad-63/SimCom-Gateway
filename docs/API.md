# SIM7600EI Cellular Gateway - API & Real-Time Specification

## 1. Authentication & Security Model

All REST API endpoints under `/api/*` and all Socket.IO connections require API Key authentication.

### Methods
1. **Header `x-api-key`**:
   ```http
   x-api-key: your-secure-api-key
   ```
2. **Header `Authorization: Bearer`**:
   ```http
   Authorization: Bearer your-secure-api-key
   ```
3. **Socket.IO Handshake Auth**:
   ```javascript
   const socket = io('http://127.0.0.1:4000', {
     auth: { token: 'your-secure-api-key' }
   });
   ```

### Timing-Safe Verification
Keys are hashed with SHA-256 and compared using constant-time `crypto.timingSafeEqual` to prevent timing attacks.

---

## 2. Standard Error Response Format

All error responses adhere to a consistent JSON structure:

```json
{
  "success": false,
  "error": "Human-readable error description",
  "code": "ERROR_CODE",
  "details": []
}
```

### Standard Error Codes
| Code | HTTP Status | Description |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `VALIDATION_ERROR` | 400 | Request body failed Zod validation (e.g. invalid phone number) |
| `INVALID_STATE_TRANSITION` | 400 | State machine rejected transition (e.g. answering when not ringing) |
| `NOT_FOUND` | 404 | Target resource not found (e.g. unknown call ID) |
| `MOCK_DISABLED` | 403 | Mock endpoints accessed while running on physical hardware |
| `GATEWAY_BUSY` | 409 | Single concurrency conflict: gateway is already handling an active call |
| `MODEM_ERROR` | 502 | Upstream serial port or AT command execution error |
| `INTERNAL_SERVER_ERROR` | 500 | Unhandled internal exception |

---

## 3. REST API Endpoints

### 3.1 Gateway Health
`GET /api/gateway/health`

Returns gateway telemetry, modem state, active call, and simulation flags. Never returns API keys or credentials.

**Response (200 OK):**
```json
{
  "gatewayVersion": "0.1.0",
  "uptimeSeconds": 142,
  "isSimulated": true,
  "driverType": "mock",
  "modem": {
    "connectionState": "READY",
    "info": {
      "manufacturer": "SIMCOM",
      "model": "SIMCOM_SIM7600EI",
      "firmwareRevision": "SIM7600M21-A_V1.1",
      "isSimulated": true
    },
    "signal": {
      "rssi": 24,
      "ber": 99,
      "dBm": -65,
      "bars": 4,
      "timestamp": "2026-10-14T12:00:00.000Z"
    },
    "network": {
      "registration": "REGISTERED_HOME",
      "operatorName": "Vi India",
      "accessTechnology": "LTE",
      "timestamp": "2026-10-14T12:00:00.000Z"
    },
    "atPort": "COM14",
    "audioPort": "COM13"
  },
  "activeCall": null,
  "audioStreaming": false,
  "system": {
    "platform": "darwin",
    "nodeVersion": "v20.14.0",
    "memoryUsageMb": 54
  },
  "timestamp": "2026-10-14T12:00:05.000Z"
}
```

---

### 3.2 List Calls (History)
`GET /api/calls?limit=20&offset=0`

Returns paginated list of calls stored in SQLite.

**Query Parameters:**
- `limit` (optional, default: 20, max: 100)
- `offset` (optional, default: 0)

**Response (200 OK):**
```json
{
  "success": true,
  "calls": [
    {
      "id": "78a9c3b1-382a-446f-bf3a-96e00b39e6a1",
      "direction": "outbound",
      "remoteNumber": "+919876543210",
      "state": "IDLE",
      "startedAt": "2026-10-14T12:00:00.000Z",
      "answeredAt": "2026-10-14T12:00:03.000Z",
      "endedAt": "2026-10-14T12:00:45.000Z",
      "durationSeconds": 42,
      "outcome": "completed",
      "isSimulated": true
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

---

### 3.3 Get Call Details
`GET /api/calls/:id`

Returns a single call record and its full event timeline.

**Response (200 OK):**
```json
{
  "success": true,
  "call": {
    "id": "78a9c3b1-382a-446f-bf3a-96e00b39e6a1",
    "direction": "outbound",
    "remoteNumber": "+919876543210",
    "state": "IDLE",
    "durationSeconds": 42,
    "outcome": "completed",
    "isSimulated": true
  },
  "events": [
    {
      "id": 1,
      "callId": "78a9c3b1-382a-446f-bf3a-96e00b39e6a1",
      "eventType": "CALL_STARTED",
      "previousState": null,
      "currentState": "DIALING",
      "timestamp": "2026-10-14T12:00:00.000Z"
    },
    {
      "id": 2,
      "callId": "78a9c3b1-382a-446f-bf3a-96e00b39e6a1",
      "eventType": "STATE_CHANGED",
      "previousState": "DIALING",
      "currentState": "ACTIVE",
      "timestamp": "2026-10-14T12:00:03.000Z"
    },
    {
      "id": 3,
      "callId": "78a9c3b1-382a-446f-bf3a-96e00b39e6a1",
      "eventType": "CALL_ENDED",
      "previousState": "TERMINATING",
      "currentState": "IDLE",
      "timestamp": "2026-10-14T12:00:45.000Z"
    }
  ]
}
```

---

### 3.4 Dial Outbound Call
`POST /api/calls/dial`

Initiates an outbound call. Enforces single concurrency.

**Request Body:**
```json
{
  "phoneNumber": "+919876543210",
  "timeoutSeconds": 45,
  "metadata": { "userId": "usr_123" }
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "call": {
    "id": "78a9c3b1-382a-446f-bf3a-96e00b39e6a1",
    "direction": "outbound",
    "remoteNumber": "+919876543210",
    "state": "DIALING",
    "startedAt": "2026-10-14T12:00:00.000Z",
    "isSimulated": true
  }
}
```

---

### 3.5 Answer Incoming Call
`POST /api/calls/answer`

Answers an incoming call in `INBOUND_RINGING` state.

**Response (200 OK):**
```json
{
  "success": true,
  "call": {
    "id": "78a9c3b1-382a-446f-bf3a-96e00b39e6a1",
    "state": "ACTIVE",
    "answeredAt": "2026-10-14T12:00:03.000Z"
  }
}
```

---

### 3.6 Hangup Call
`POST /api/calls/hangup`

Terminates active or ringing call.

**Request Body (optional):**
```json
{
  "reason": "Agent finished conversation"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Call terminated"
}
```

---

### 3.7 Send DTMF
`POST /api/calls/dtmf`

Sends DTMF tone on active call.

**Request Body:**
```json
{
  "digit": "5",
  "durationMs": 200
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "digit": "5"
}
```

---

### 3.8 Trigger Simulated Inbound Call (Dev Mock Only)
`POST /api/mock/trigger-inbound`

Triggers simulated incoming ringing call. Strictly returns `403 MOCK_DISABLED` if executed against physical modem hardware.

**Request Body:**
```json
{
  "phoneNumber": "+919876543210",
  "ringCount": 5
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Simulated inbound call triggered",
  "phoneNumber": "+919876543210",
  "ringCount": 5
}
```

---

## 4. Socket.IO Real-Time Hub

### Connection
- Path: `/socket.io/`
- Handshake auth: `{ auth: { token: "API_KEY" } }`

### Server -> Client Events
- `gateway:health` `(GatewayHealthStatus)`: Emitted on initial connection and status updates.
- `call:started` `(CallSession)`: Emitted when an inbound or outbound call begins.
- `call:state_changed` `(CallStateChangeEvent)`: Emitted on any state transition (`DIALING`, `OUTBOUND_RINGING`, `INBOUND_RINGING`, `ACTIVE`, `TERMINATING`, `IDLE`).
- `call:ended` `(CallSession)`: Emitted when call terminates, with finalized duration and outcome.
- `audio:level` `({ inboundRms: number, outboundRms: number, timestamp: number })`: Emitted at 10Hz during active calls for live dashboard VU meters.
- `modem:urc` `(UrcEvent)`: Emitted when unsolicited result codes are processed.
- `modem:telemetry` `({ signal, network })`: Emitted when signal or registration changes.
- `gateway:alert` `({ level: 'info'|'warn'|'error', message: string, timestamp: string })`: Emitted for system warnings (e.g. concurrent call auto-rejected).

### Client -> Server Events (with Callback Acknowledgements)
- `call:dial` `(DialRequest, (res: { success: boolean, data?: CallSession, error?: string }) => void)`
- `call:answer` `((res: { success: boolean, data?: CallSession, error?: string }) => void)`
- `call:hangup` `((res: { success: boolean, error?: string }) => void)`
- `call:dtmf` `(DtmfRequest, (res: { success: boolean, error?: string }) => void)`
- `mock:trigger_inbound` `({ phoneNumber: string, ringCount?: number }, (res: { success: boolean, error?: string }) => void)`

---

## 5. SQLite Persistence Schema

### Database Configuration
- Engine: `better-sqlite3`
- Journal Mode: `WAL` (Write-Ahead Logging)
- Foreign Keys: `ON`
- Busy Timeout: 5000ms
- Synchronous: `NORMAL`

### Tables
1. **`calls`**:
   - `id` (TEXT, PK, UUID)
   - `direction` ('inbound' | 'outbound')
   - `remote_number` (E.164 string)
   - `state` ('IDLE' | 'DIALING' | 'OUTBOUND_RINGING' | 'INBOUND_RINGING' | 'ACTIVE' | 'TERMINATING')
   - `started_at`, `answered_at`, `ended_at` (ISO 8601 strings)
   - `duration_seconds` (INTEGER)
   - `outcome` ('completed' | 'missed' | 'rejected' | 'busy' | 'busy_rejected' | 'failed' | 'no_answer')
   - `termination_reason` (TEXT)
   - `is_simulated` (INTEGER, 0 or 1)
   - `audio_dump_path` (TEXT)
   - `metadata` (JSON TEXT)
   - Indexes: `idx_calls_started_at`, `idx_calls_state`, `idx_calls_remote_number`, `idx_calls_outcome`
2. **`call_events`**:
   - `id` (INTEGER, PK, AUTOINCREMENT)
   - `call_id` (TEXT, FK -> `calls.id` ON DELETE CASCADE)
   - `event_type` (TEXT)
   - `previous_state`, `current_state` (TEXT)
   - `payload` (JSON TEXT)
   - `timestamp` (ISO 8601 string)
   - Index: `idx_call_events_call_id`
3. **`gateway_settings`**:
   - `key` (TEXT, PK)
   - `value` (TEXT)
   - `updated_at` (ISO 8601 string)

---

## 6. Cross-Platform & Native Module Requirements

- **macOS (Development)**:
  `better-sqlite3` prebuilds install automatically on Apple Silicon (`darwin-arm64`).
- **Windows (Production Gateway Host)**:
  - When deploying to the Windows PC, run `npm install` directly on the Windows host.
  - **Do NOT copy `node_modules` from macOS to Windows**. `better-sqlite3` is a native C++ Node addon that requires Windows-specific binaries (`win32-x64`).
  - Prebuilt binaries for Node 20.x are downloaded automatically by `prebuild-install` on Windows.
  - If compiling from source on Windows, install Visual Studio C++ Build Tools (`npm install --global --production windows-build-tools` or install via VS Installer).
