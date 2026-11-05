# SIM7600EI Cellular Gateway

A self-hosted phone gateway for the **SIMCom SIM7600EI** LTE modem. It answers and places real phone calls, lets an **AI voice agent** talk on them, plays a recorded **IVR menu** on outgoing calls, runs **outbound campaigns**, sends and reads **SMS**, records every call, and shows all of it in a web dashboard.

New here? Start with **[INTRO.md](INTRO.md)**, a plain-language walkthrough and first-run checklist. This file is the technical reference.

## What it does

| Area | What you get |
| --- | --- |
| **Calls** | Dial, answer, hang up and send DTMF from the dashboard. Live call state, audio level meters, full call history with an event timeline. |
| **AI voice agent** | Speech-to-text, a language model and text-to-speech joined into a live conversation, with barge-in, turn-taking and idle follow-ups. Providers are picked from the **Model Hub** (a registry of STT/LLM/TTS models, voices and prices), so adding a model is configuration, not code. |
| **IVR menu** | A recorded menu played to the person you call as soon as they answer (outgoing calls only). Keys run actions: connect to the AI, play an announcement, repeat the menu, hang up. Announcements are uploaded as WAV files or generated from text with any available TTS voice. Draft, validate, publish, then switch on. |
| **Call recording** | One combined WAV per call (caller and AI on one timeline), played back from **Call History** with pause, resume and a seek bar. |
| **Campaigns** | Outbound calling lists with a do-not-call list, per-contact attempts and outcomes, optionally synced to Google Sheets. |
| **SMS** | Inbox and sending over the modem's own AT port. |
| **Observability** | Per-call logs and latency for every turn (STT, LLM, TTS), usage and cost estimates. |
| **Hardware operations** | Port discovery by USB identity, modem and signal status, USB audio checks and a redacted diagnostic report. Nothing on that page dials or restarts anything. |
| **Mock modem** | A complete simulated modem and audio path, so the whole system runs and tests without hardware. |

Everything risky is **off by default**: the AI agent, auto-answer, automatic replies, call recording, the IVR and the audio confirmations each need an explicit switch.

## Repository layout

```
packages/
  gateway/     Node.js + TypeScript service: AT commands, call state, audio, AI, IVR, recording, SMS, REST + Socket.IO
  dashboard/   Next.js 14 + Tailwind web UI
  shared/      TypeScript types, Zod schemas and Socket.IO events used by both
docs/          Architecture, API, AI agent, Model Registry, Windows hardware guide, test strategy
tools/         PowerShell helpers for Windows and their tests: ai-caller.ps1 (operations menu: start, status, ports, health, logs, report) and inspect-sim7600-windows.ps1
.env.example   Every configuration option, with comments
```

Runtime data lives under `packages/gateway/` and is never committed: `data/` (SQLite database, IVR audio, model registry, backups), `call-recordings/`, `audio-dumps/` and `diagnostics/`.

## Requirements

- **Node.js 20 or newer** (developed on 22) and npm.
- **Windows** for real hardware (the modem's USB ports are discovered through Windows). Mock mode runs anywhere Node does.
- For the AI agent: API keys for the providers you choose (for example Deepgram, Groq or OpenAI, and a TTS provider such as Cartesia).

## Setup

```bash
npm install
copy .env.example .env        # then edit .env (see "Configuration")
npm run --workspace=@sim-gateway/shared build   # the gateway and dashboard read the shared package through its build
```

### Run in development

```bash
npm run dev:gateway      # gateway on http://localhost:4000, restarts when its source changes
npm run dev:dashboard    # dashboard on http://localhost:3000
```

Health check: `http://localhost:4000/api/gateway/health` (send the `x-api-key` header).

On Windows, `.\tools\ai-caller.ps1` is a menu for the same jobs (`start-all`, `status`, `health`, `ports`, `logs`, `report`). It talks to the gateway through its API, never opens a COM port itself, and never prints your key.

### Run a production build

```bash
npm run build            # builds shared, gateway and dashboard
npm run start:gateway
npm run start:dashboard
```

## Configuration

All settings are environment variables in `.env` at the repository root; `.env.example` documents every one. The ones you will touch first:

| Variable | Purpose |
| --- | --- |
| `MODEM_DRIVER` | `mock` (default, no hardware) or `hardware`. |
| `MODEM_AT_PORT`, `MODEM_AUDIO_PORT` | Leave empty to discover the modem's AT and audio ports from its USB identity. Set them only to override discovery. |
| `GATEWAY_API_KEY` | Required. Every REST route and the Socket.IO connection need it. |
| `HOST`, `PORT`, `CORS_ORIGIN` | Network binding. Use `HOST=0.0.0.0` only with a strong API key. |
| `AI_ENABLED` and `AI_*` | The AI agent: providers, voice, turn-taking, timeouts and safety limits. |
| `AI_SECRETS_MASTER_KEY` | Development only. Lets the dashboard store provider API keys, encrypted in the database. Set once, never change it afterwards. The installed product creates and protects this key by itself; customers never set it. |
| `CALL_RECORDING_ENABLED`, `CALL_RECORDING_CONSENT_ACKNOWLEDGED` | Recording needs both. Recording people may require notice or consent where you are; the second switch is your statement that you have handled it. |
| `SQLITE_DB_PATH` | Database location (relative to `packages/gateway`). |

The dashboard stores the gateway URL and API key in the browser (**Settings** page), never in a build.

## Using it

Open the dashboard at `http://localhost:3000`:

- **Overview**: gateway, modem and signal status, the active call, recent calls.
- **Dialer & Live**: place calls and control the one in progress.
- **AI Agent**: provider keys, models and voices, behaviour, audio confirmations, call tests.
- **IVR Menu**: audio library, menu editor, readiness checks, publish and on/off.
- **Call History**: every call, with the event timeline and a **Play** button when the call was recorded.
- **Call Logs**: per-turn traces and latency.
- **Campaigns**, **SMS**, **Hardware**, **Settings**.

### How calls are handled

- **Incoming calls** go to the AI agent (when automatic answering and handling are enabled). The IVR never touches them.
- **Outgoing calls** play the IVR menu as soon as the person answers, when the IVR is published and switched on; pressing the "Connect to AI" key hands the call to the AI agent. With the IVR off, outgoing calls follow the normal AI settings.
- The IVR and the AI never write audio to the modem at the same time: the AI cannot attach to a call while the IVR holds it.

## Testing

```bash
npm test                                   # both packages
npm run --workspace=@sim-gateway/gateway test
npm run --workspace=@sim-gateway/dashboard test
```

The gateway suite runs against the mock modem and audio path and fakes every paid provider, so it needs no hardware, network or keys. A few timing-sensitive audio-pacing tests can fail when the machine is busy; run them on their own if one does.

Audio behaviour on **real hardware** cannot be proven by tests. The dashboard's audio confirmations exist so that a person listens and says so before the AI is allowed to speak on a call.

## Security

- All REST routes and the Socket.IO handshake require the gateway API key (`x-api-key` header). Recordings and IVR audio are served only through authenticated routes.
- Provider keys are stored encrypted (AES-256-GCM) when `AI_SECRETS_MASTER_KEY` is set, and are never sent back to the browser or written to logs.
- Caller key presses (DTMF) are never written to logs or the event bus; the IVR trace records which option was chosen, not the digit.
- Running the gateway on one machine and the dashboard on another: set `HOST=0.0.0.0` and a strong `GATEWAY_API_KEY` on the gateway machine, set `CORS_ORIGIN` to the dashboard's address, allow TCP 4000 through the firewall on the local network, then enter the gateway URL and key on the dashboard's **Settings** page.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Dashboard says it cannot connect to the gateway | The gateway process is not running. Start `npm run dev:gateway` and read its output. |
| Gateway exits with "Another SIM7600 gateway process … already owns COMxx" | A second gateway is really running (stop it), or a lock file from a crashed one remains in `%TEMP%\sim-gateway-locks`. Current versions clear stale locks themselves; if one persists, check no `node` process holds the modem, then delete the named `.lock` file. |
| Modem shows INITIALIZING or DISCONNECTED | Open the **Hardware** page: it lists the USB ports Windows sees. Replug the modem, then restart the gateway. |
| The AI does not answer | Work down the readiness list on the **AI Agent** page; it names the first missing key, confirmation or setting. |
| A caller sounds quiet in a recording | The modem delivers the caller's voice quieter than the AI's, and the recording raises the caller's side in the mix. The recording page notes how much. The raw capture in `audio-dumps/` is untouched. |

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [REST API and Socket.IO reference](docs/API.md)
- [AI voice agent](docs/AI_VOICE_AGENT.md)
- [Model Registry](docs/MODEL_REGISTRY.md)
- [Windows hardware integration and validation](docs/WINDOWS_HARDWARE_INTEGRATION.md)
- [USB PCM hardware results](docs/USB_PCM_HARDWARE_RESULTS.md)
- [Mock modem design](docs/MOCK_MODEM_DESIGN.md)
- [Test strategy](docs/TEST_STRATEGY.md)
- [Implementation plan (historical)](docs/IMPLEMENTATION_PLAN.md)
