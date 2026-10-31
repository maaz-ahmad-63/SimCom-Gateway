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

### 3.9 SMS (send, list, read)
All SMS endpoints are authenticated like every `/api` route. They use the modem's own AT port (COM14) through the same serialized
AT queue as call control and never touch the audio port. **They are refused while any call exists** (`409 CALL_IN_PROGRESS`), while
the modem is not READY (`409 MODEM_NOT_READY`), and while another SMS operation is running (`409 SMS_BUSY`): a send occupies the AT
port until the network accepts the message (up to `SMS_SEND_TIMEOUT_MS`, default 30000), and a call cannot be answered or hung up by AT
command during that time. No request is ever retried automatically.

Text mode is required. If the modem reports PDU mode the gateway switches it with `AT+CMGF=1` and says so in `settingsChanged`.
That is the only setting ever written. The service-centre number (`AT+CSCA`), the text-mode parameters (`AT+CSMP`), the character
set (`AT+CSCS`), the storage (`AT+CPMS`) and the new-message indication (`AT+CNMI`) are read and reported, never changed.

#### `POST /api/gateway/sms/send`
```json
{ "to": "+91XXXXXXXXXX", "message": "Your order is ready." }
```
`to` is international format only (`+` and 7-15 digits). `message` is one SMS (160 characters) of text the modem's current character
set can carry: with `GSM` letters, digits, spaces and `. , ! ? ' " ( ) - / : ; + * & % # = < >`; with `IRA` printable ASCII.
Unsupported characters are refused, not sent as something else.

**200:** `{ "success": true, "to": "+91...", "messageReference": 7, "characters": 20, "settingsChanged": [], "warnings": [], "isSimulated": false }`

**Errors** (`{ "success": false, "error": "...", "code": "...", "details": { ... } }`):

| Status | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_DESTINATION`, `INVALID_MESSAGE`, `MESSAGE_TOO_LONG`, `UNSUPPORTED_CHARACTERS` | The request is wrong. Nothing was sent to the modem. |
| 409 | `CALL_IN_PROGRESS`, `MODEM_NOT_READY`, `SMS_BUSY` | Not now. Nothing was sent. |
| 409 | `SMSC_NOT_SET`, `SMS_PARAMS_INVALID`, `UNSUPPORTED_CHARSET` | The modem's own settings would make it reject the message (found by reading them first). Nothing was sent or changed; `details` shows what to fix. |
| 502 | `SMS_CMS_ERROR` | The modem answered `+CMS ERROR`. `details`: `cmsCode`, `cmsText`, a `hint`, and the settings that were read (`snapshot`). |
| 502 | `MODEM_ERROR` | `ERROR` or `+CME ERROR`. |
| 504 | `SMS_PROMPT_TIMEOUT` | The modem never asked for the text. Nothing was sent; the gateway cancelled text entry. |
| 504 | `SMS_OUTCOME_UNKNOWN` | The text was sent but no result came back. **The message may have been sent**; check before sending again. |
| 504 / 503 | `MODEM_TIMEOUT`, `MODEM_DISCONNECTED` | The AT port did not answer, or dropped. |

`+CMS ERROR: Invalid text mode parameter` is code 305. In text mode the message is built from `AT+CSMP?` (first octet, validity period,
protocol id, data coding scheme), `AT+CSCS?` and `AT+CSCA?`, so those are what to look at; `GET /api/gateway/sms/status` shows them.

#### `GET /api/gateway/sms`
Stored messages. `?status=all|unread|read|unsent|sent` (default `all`). By default the modem is asked not to change a message's status
(`AT+CMGL="ALL",1`); `?markRead=true` uses the plain command, which turns unread messages into read ones. The no-change option is a
documented SIMCom parameter that has not been verified on this firmware: if the modem rejects it the error says so, and nothing is retried.

**200:** `{ "success": true, "count": 1, "messages": [ { "index": 1, "status": "REC UNREAD", "direction": "received", "address": "+91...", "timestamp": "2026-10-27T18:00:00+05:30", "text": "..." } ], "storage": { "name": "ME", "used": 1, "total": 100 }, "markedRead": false, "settingsChanged": [], "isSimulated": false }`

#### `GET /api/gateway/sms/:index`
One stored message by its index (1-999) in the current storage. `404 SMS_NOT_FOUND` if there is none. Same `?markRead=true` option.
**200:** `{ "success": true, "message": { ...as above... }, "markedRead": false, "settingsChanged": [], "isSimulated": false }`

#### `POST /api/gateway/sms/text-parameters`
The one operation that changes the modem's SMS parameters: writes the standard text-mode values `AT+CSMP=17,167,0,0` (SMS-SUBMIT with a
relative validity period of one day, protocol id 0, plain GSM text). Use it when `GET /api/gateway/sms/status` reports a problem with
`AT+CSMP?` (for example data coding scheme 246, which is 8-bit data, class 2) or a send fails with `+CMS ERROR: 305`.

It must be authorized with the exact text below, is refused during a call or while the modem is not READY, runs alone on the AT queue,
reads `AT+CSMP?` before and after, and verifies the read-back. It changes nothing else (not the service centre, character set, storage or
indication settings) and is never retried. It is not saved to the modem's non-volatile memory (no `AT+CSAS`), so a modem reset may
restore the previous values.
```json
{ "confirm": "APPLY AT+CSMP=17,167,0,0" }
```
**200:** `{ "success": true, "changed": true, "verified": true, "command": "AT+CSMP=17,167,0,0", "old": { "fo": 17, "vp": 11, "pid": 0, "dcs": 246 }, "new": { "fo": 17, "vp": 167, "pid": 0, "dcs": 0 }, "persisted": false }`
(`changed: false, command: null` when the values were already standard.)
**Errors:** `400 CONFIRMATION_REQUIRED`; `409 CALL_IN_PROGRESS | MODEM_NOT_READY | SMS_BUSY`; `502 SMS_CMS_ERROR | MODEM_ERROR` (the write was refused; `details.old` is the value that was read); `502 CSMP_VERIFY_FAILED` (the modem answered OK but `AT+CSMP?` does not show the requested values; `details` has `old`, `requested`, `actual`); `502 CSMP_READBACK_FAILED` (the read-back failed, so the current value is unknown); `504 MODEM_TIMEOUT`.

#### `GET /api/gateway/sms/status`
Read-only configuration check: text mode, service centre (set or not), `AT+CSMP?` values, character set, storage, `AT+CNMI?`, and the
modem's own lists of supported values (`AT+CMGL=?`, `AT+CSMP=?`), with the raw replies and an `assessment` (`canSend`, `problems`,
`warnings`). Changes nothing. Run it before the first send.

#### `GET /api/gateway/sms/inbox`
The gateway's stored copy of messages (SQLite `sms_messages`, kept across restarts). **Database only: no modem command is sent**, so it is
safe to call at any time, including during a call, and it never changes a message's read/unread status. Query: `direction`
(`received` or `sent`), `limit` (1-200, default 50), `offset`. Response: `{ messages, total, unread, inbox }`, where each message has
`id`, `direction`, `source` (`modem` or `gateway`), `storage`, `index`, `address` (sender or recipient), `text`, `time`, `modemStatus`,
`read` (`null` for sent messages), `sendStatus` (`sent`, `unknown` or `failed` for sent messages), `onModem` (false once the modem no
longer has it; the stored copy is kept) and `errorCode`/`errorMessage`. `inbox` is the watcher state (below). `400 INVALID_DIRECTION`;
`501 SMS_STORE_UNAVAILABLE`.

Sent messages are recorded only when the request reached the modem. `sendStatus: "unknown"` is the `SMS_OUTCOME_UNKNOWN` case and is
never retried by the gateway or the dashboard.

Incoming messages that the modem does not announce (its `AT+CNMI` does not route `+CMTI`, or the firmware sends URCs to another
USB port) are still picked up: until the first `+CMTI` has arrived, the watcher reads the storage every `SMS_FALLBACK_POLL_MS`
(default 120000, `0` = off), only while no call exists. After a notification has arrived, notifications drive the reads.
`inbox.polling` says which applies: `{ mode: 'interval' | 'fallback' | 'off', intervalMs }`. After a modem reconnect the watcher
reads the storage again and re-reads `AT+CNMI?`; messages are de-duplicated, so a reconnect or restart never stores one twice.

#### `POST /api/gateway/sms/sync`
Reads the modem's storage now (instead of waiting for the next `+CMTI`) and stores anything new. Returns `{ success, listed, added, storage, storageFull, inbox }`.
Same protection as every SMS operation: `409 CALL_IN_PROGRESS | MODEM_NOT_READY | SMS_BUSY`, `502`/`504` for modem errors.

#### Incoming messages
The modem announces a new message with `+CMTI: "<storage>",<index>`. The gateway parses it as a `modem:urc` event
(`{ kind: "sms-indication", storage, index }`); it is never mixed up with call events, and message bodies inside `AT+CMGL`/`AT+CMGR`
replies are not interpreted as URCs. The `SmsInbox` watcher then, after a short debounce (1.5 s):

- waits without sending any AT command while a call is in progress (plus 3 s after it ends), the modem is not READY, or another SMS
  operation is running;
- reads the storage through the normal serialized AT queue with `AT+CMGL="ALL",1` (mode 1: does not change the read status) and stores
  new messages, de-duplicated by storage, index, sender, timestamp and text (a repeated `+CMTI` or a restart adds nothing);
- retries a failed read after 5 s, 30 s and 120 s, then stops and raises a warning (`Refresh` in the dashboard tries again);
- at startup reads once; optionally polls every `SMS_POLL_INTERVAL_MS` (off by default, minimum 60000).

It never deletes messages (no `AT+CMGD`) and never writes `AT+CPMS`, `AT+CNMI` or `AT+CSCA`. A full storage, a `+CMTI` for a storage other
than the one read, or a modem that does not announce messages (`AT+CNMI` second value is not 1) is reported as a `gateway:alert`
(`SMS: ...`) and in `inbox`; the dashboard shows it. New messages raise an info alert `SMS: N new message(s) received` over Socket.IO.

`inbox` fields: `running`, `syncing`, `pending`, `waiting` (`call`, `modem`, `busy` or `null`), `lastSyncAt`, `lastSuccessAt`,
`lastError`, `consecutiveFailures`, `storage` (`name`, `used`, `total`), `storageFull`, `indications` (`cnmi`, `notifies`),
`notificationsSeen`, `storageMismatch`.

Environment: `SMS_INBOX_ENABLED=false` turns the watcher off (the other SMS endpoints keep working); `SMS_POLL_INTERVAL_MS` as above.

### 3.10 Dashboard relay (`/api/sms/*` on the dashboard server)
The dashboard's SMS page does not call the gateway directly and the browser never holds `GATEWAY_API_KEY`. The dashboard server
(Next.js route handler) adds the key from its own environment and forwards only: `GET /api/sms/inbox`, `GET /api/sms/status`,
`GET /api/sms/:index`, `POST /api/sms/sync` and `POST /api/sms/send`. The text-parameters write is deliberately not reachable.

Server environment (not `NEXT_PUBLIC_`, never sent to the browser). The dashboard server looks first in its own environment
(`packages/dashboard/.env.local`, because Next.js reads `.env` files from that folder only), then in the repository root `.env`
the gateway uses when the dashboard runs from the same checkout. From that file it takes only `GATEWAY_API_KEY`,
`GATEWAY_INTERNAL_URL` and `PORT`; nothing else is copied. Variables: `GATEWAY_API_KEY` (same value as the gateway),
`GATEWAY_INTERNAL_URL` (default `http://127.0.0.1:<PORT>`, 4000 if unknown; set it when the gateway is on another machine),
`DASHBOARD_SMS_ALLOW_REMOTE=true`, and `DASHBOARD_USE_REPOSITORY_ENV=false` to turn the repository fallback off. Example keys
(`change-this-to-a-secure-random-token`) are ignored. By default the relay answers only
when the page is opened through `localhost`, `127.0.0.1` or `[::1]` (`403 PROXY_FORBIDDEN_HOST` otherwise), because anyone who can
reach it can send an SMS from the SIM. It requires a same-origin `POST` with a JSON body and the `x-dashboard-sms: 1` header. Relay
error codes: `PROXY_NOT_CONFIGURED` (503), `PROXY_KEY_REJECTED`, `GATEWAY_UNREACHABLE`, `PROXY_TIMEOUT` and `PROXY_UNCERTAIN` (a send
whose answer was lost: treat as `SMS_OUTCOME_UNKNOWN`). The relay never retries.

`GET /api/gateway-status` on the dashboard server is read-only and AT-free: it relays the gateway's `GET /api/gateway/hardware/status`
(driver type, simulated or not, the configured COM ports, modem connection state) and answers `200 { relay, gateway }`, where
`relay` is `{ gatewayUrl, keyConfigured, keySource, urlSource }` (where the key came from, never the key) and `gateway` is
`{ ok: true, status }` or `{ ok: false, code, error }` (`PROXY_NOT_CONFIGURED`, `PROXY_KEY_REJECTED`, `GATEWAY_UNREACHABLE`,
`GATEWAY_TIMEOUT`, `GATEWAY_BAD_RESPONSE`). It lets the header's hardware badge and the COM-port lines come from the gateway while the
browser itself cannot reach it. It also needs the `x-dashboard-sms: 1` header and a same-site request, but unlike the SMS relay it
answers a dashboard opened by LAN address, because it can change nothing.

The gateway's `GET /api/gateway/hardware/status` (AT-free) includes `discovery` in hardware mode: `{ mode: 'explicit' | 'discovery',
explicit, selector, lastScanAt, ok, code, message, warnings, at, audio, device: { id, vendorId, productId }, modems: [{ id, at, audio,
problems, interfaces }] }`. `code` is one of `NO_MODEM`, `MULTIPLE_MODEMS`, `SELECTOR_NO_MATCH`, `INTERFACE_MISSING`,
`EXPLICIT_PORT_UNIDENTIFIED`, `LIST_FAILED`. `modem.configuredAtPort` / `configuredAudioPort` are the ports in use (`auto` until a
modem is found). `GET /api/gateway/hardware/ports` adds `mode` and `modems`; in discovery mode `suggestedEnv` is always `null`.

---

### 3.x Call observability (read-only, API-key protected)

Persisted telemetry for every AI-attached call, written event by event as the pipeline runs (table `call_trace_events`, plus
the per-turn `ai_turns` log). All list endpoints are paginated (`page`, `pageSize` up to 100) and share these filters:
`from`, `to` (ISO), `status` (a call outcome, `in_progress`, or `ai_error`), `direction`, `provider`, `model`, `q` (call id or
prefix), `simulated` (`only` | `exclude`).

| Endpoint | Returns |
|---|---|
| `GET /api/observability/overview` | call counts, turn error rate, avg/p50/p95 for end-to-end, TFT, STT, LLM, TTS (each with `n`), per-provider breakdown |
| `GET /api/observability/latency` | the latency and provider parts of the overview |
| `GET /api/observability/calls` | call history rows: status, providers/models, turns, average latencies |
| `GET /api/observability/calls/:id` | the call, its turns (latency breakdown, failing stage, retries, events) and call-level events |
| `GET /api/observability/calls/:id/turns/:turnId` | the chronological events of one turn |
| `GET /api/observability/errors` | failed stages and failed/retried provider attempts, newest first |
| `GET /api/observability/status` | trace event count, oldest event, failed telemetry writes, and the retention settings in force |

Durations come from the gateway's monotonic clock; timestamps are UTC. A measurement that does not exist is `null`
(never `0`): time-to-first-token is `null` for a model that does not stream, and end-to-end is `null` when the endpointer gave
no end-of-speech time. End-to-end means *end of the caller's speech to the first reply audio written to the modem audio port*;
the line and the caller's phone add delay that cannot be measured at the gateway. Raw audio and credentials are never stored;
what was said is stored only with `AI_OBSERVABILITY_STORE_TEXT=true`.

Retention removes only `call_trace_events` rows: older than `AI_OBSERVABILITY_RETENTION_DAYS` (default 30; 0 keeps all) and, above `AI_OBSERVABILITY_MAX_EVENTS` (default 1,000,000; 0 = no cap), the oldest first. It never touches `calls`, `call_events`, or `ai_turns`, skips events of a call still in progress, runs in small chunks, and does nothing while a call is live. It first runs a minute after start, then every 6 hours. `ai_turns.stt_mode` says what an STT time measured (`batch`, `speculative`, or `stream`), because those are different quantities. Playback jitter (`max_late_ms`, `late_frames`, `risk_frames`), the longest event-loop stall during the turn (`loop_lag_max_ms`) and who cancelled a turn (`cancel_source`) are stored per turn. End-to-end figures come from completed turns only: a cancelled or failed turn is never reported as a response time.

### 3.y Campaigns (API-key protected)

Outbound call lists with per-contact context for the voice agent. Uploading, previewing and importing a CSV only parse and store
rows; **no call is placed until `POST /api/campaigns/:id/start` succeeds**, which needs the explicit confirmation below.

| Endpoint | Purpose |
|---|---|
| `GET /api/campaigns`, `POST /api/campaigns` | list (with counts) / create a draft `{ name, settings? }` |
| `GET/PATCH/DELETE /api/campaigns/:id` | detail with counts and runner status / rename and change settings (draft or paused) / delete (not while running or paused) |
| `POST /api/campaigns/preview-csv` | `{ csv }`: headers, a 10-row sample, warnings and a suggested column mapping. Stores nothing. |
| `POST /api/campaigns/:id/import` | `{ csv, mapping }`: validate every row and store them as the draft's contacts (replacing an earlier import). Bad rows are stored as skipped with the reason. |
| `GET /api/campaigns/:id/contacts` | `status`, `q`, `page`, `pageSize`; each contact has its status, attempts, last outcome/error and latest `callId` |
| `GET /api/campaigns/:id/contacts/:contactId` | the contact and every attempt with its `callId` (each has its own call log) |
| `POST /api/campaigns/:id/contacts/:contactId/opt-out` | add the number to the global do-not-call list |
| `GET /api/campaigns/:id/review` | what will be called, what will not and why, AI blockers, whether it is inside the calling hours now |
| `POST /api/campaigns/:id/start` | `{ confirm: true, confirmName, acknowledgements: { realCalls, regulations, consent } }`, all required; `confirmName` must equal the campaign name |
| `POST /api/campaigns/:id/pause`, `/resume`, `/stop` | `pause`/`stop` never hang up a call in progress; `stop` marks waiting contacts skipped |
| `GET /api/campaigns/readiness` | why the AI cannot take outbound calls right now (empty = it can) |
| `GET/POST/DELETE /api/campaigns/do-not-call` | the global opt-out list |

Calls are placed one at a time through the existing call manager. Before **every** call the engine re-checks: the AI is ready for
outbound replies, the time is inside the calling hours (in the campaign's time zone), the modem is idle, the pacing delay has
passed, and the contact is still callable (valid E.164 number, not opted out, not on the do-not-call list, consent in order, not
called by any campaign within `skipRecentlyCalledHours`). A contact is claimed with a conditional update, so it cannot be dialled
twice, and the database refuses a second row for the same number in a campaign. Retries follow `maxAttempts`, `retryDelayMinutes`
and `retryOn`; an answered call is never retried, and neither is a call that ended before it was answered (see "Outcomes and retries" below). After `maxConsecutiveFailures` failed calls in a row the
campaign pauses itself. Progress is stored per contact; after a gateway restart a running campaign is **paused** (never resumed
automatically) and a contact that was mid-call is settled from the call log or marked failed with the outcome unknown.

The contact's name, designation, company, notes and any extra mapped columns are given to the agent as a delimited
`<call_context>` block appended to that call's system prompt only (labelled as data, control characters and angle brackets removed,
lengths capped, phone number omitted). The stored agent prompt is never modified. A campaign may also set a greeting template
(`{name}`, `{designation}`, `{company}`) used for its calls instead of the global greeting.

Call-log endpoints (`/api/observability/calls`, `/calls/:id`) now also return, per turn, the caller transcript and agent reply
**when stored** (null when transcripts are off), a call-level `errors` list, `totals`, and a `campaign` reference on campaign calls.

#### Phone numbers, outcomes and safety rules

**Phone numbers.** A number is dialled only in E.164 form. `+<digits>` and `00<digits>` are taken as written (and, for the countries
the gateway knows, must be a valid national number). Anything else is a *local* number for the campaign's `defaultCountryCode`: the
code is prepended, never assumed to be present, so an Indian mobile that begins with 91 stays local. A local number must have that
country's exact length and leading digits (one trunk 0 is allowed); a number whose `+` was lost is accepted only when its length is
exactly code + national length. Known countries: 91, 1, 44, 61, 65, 971; for any other default country code numbers must be written
with `+` or `00`. Anything that cannot be placed unambiguously is rejected with the reason, never guessed.

**Outcomes and retries.** The modem cannot tell a declined call from an unreachable number or a network drop. The gateway therefore
records only what the evidence supports: `answered`; `no_answer` (the modem said NO ANSWER, or the ring timeout ran out); `busy` (a
declined call can be reported as busy); `ended_before_answer` (any other end before an answer, which includes declines); `failed`.
`retryOn` defaults to `no_answer` and `failed`; `busy` is opt-in; `ended_before_answer` is never retried automatically. After a
restart an interrupted attempt follows the same rules only when the call log gives a reliable `no_answer` or `busy`; anything else
is marked failed and not redialled.

**Answered calls with no AI agent.** If the other side answers and the AI agent has not attached within `agentAttachTimeoutSeconds`
(default 20), the attempt is recorded as `agent_missing` (not retried), the campaign pauses and a gateway alert says why. The
campaign never hangs up a call: the operator hangs up from the Dialer page, fixes the setup and resumes. A call that does not report
its end within 20 minutes pauses the campaign the same way (`no_end_report`). The gateway verifies that the agent attached, not that
anything was audible to the person.

**Start.** A refused start (no callable contacts, another campaign running) changes nothing. When it goes ahead, skipping the contacts
the rules refuse and the change of state happen in one transaction. The acknowledgements, the consent mode, the number of contacts and
the time are stored with the campaign. The consent mode and the default country code cannot be changed after the start.

**Opt-outs.** The per-contact opt-out button, the CSV opt-out column and the global do-not-call list are always enforced, at import and
again before every dial. If the person on a campaign call clearly asks not to be called again (English phrases only), the number is
added to the global list at once, with source `spoken`; the call itself is not ended or changed. The agent is told to confirm politely
and wrap up. A spoken opt-out in another language is not detected: add the number by hand.

**CSV extras.** Extra columns reach the agent as `extra_<name>` lines. A column named like one of the agent's own fields or like an
instruction (`contact_name`, `system`, `instructions`, `call_context`, and similar) is refused at import with a clear error.

**Request size.** The gateway accepts request bodies up to 1 MB once JSON-encoded, and answers an oversized one with HTTP 413
(`PAYLOAD_TOO_LARGE`). A CSV under the 900,000-character limit can still exceed that when it has many line breaks or quotes; the
dashboard checks the encoded size before sending and says so.

### 3.z Integrations: Google Sheets (API-key protected)

Settings for the agent's save-to-Google-Sheets tool. The service account key is accepted once and **never returned**; responses carry
only whether a key is stored and the account's email (what the sheet is shared with).

| Method and path | Body | Result |
|---|---|---|
| `GET /api/integrations/google-sheets` | | `{ config, credential: { stored, serviceAccountEmail, undecryptable }, secretStorageAvailable, lastTest, columns, modelTools: { model, provider, supported } }` |
| `PUT /api/integrations/google-sheets` | any of `enabled, spreadsheetId, sheetName, inboundTools, outboundTools, logOutcomes` | the status above. 409 when enabling without a key or a spreadsheet; 400 for an invalid ID or tab name |
| `PUT /api/integrations/google-sheets/credential` | `{ serviceAccountJson }` (the key file text) | the status. 400 `invalid_credential` for anything that is not a service account key; 409 without `AI_SECRETS_MASTER_KEY` |
| `DELETE /api/integrations/google-sheets/credential` | | the status; also switches the integration off |
| `POST /api/integrations/google-sheets/test` | | `{ result: { ok, at, steps[], advice }, status }`. Read-only: never writes to the sheet |

`PUT /api/ai/agent` and `PUT /api/ai/settings` (`agent`) also accept `inboundInstructions`, `inboundGreeting`, `outboundInstructions`
and `outboundGreeting` (instructions up to 8000 characters, greetings up to 500; empty means use the shared value).

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
