# Introduction: your phone gateway in plain words

## What is this?

A small phone system that runs on your own computer. A SIM card sits in a **SIMCom SIM7600EI USB modem**, and this software turns it into something that can:

- **take calls and talk back** with an AI voice assistant,
- **make calls** and greet the person with a recorded menu ("press 1 to talk to our assistant"),
- **run calling campaigns** from a list of numbers,
- **send and read text messages**,
- **record every call** so you can play it back later,

all controlled from a web page on your computer.

It has three parts that work together:

| Part | What it is | Where you see it |
| --- | --- | --- |
| **Gateway** | The engine. Talks to the modem, handles calls and audio, runs the AI. | A console window; `http://localhost:4000` |
| **Dashboard** | The web page you click around in. | `http://localhost:3000` |
| **Shared** | The common definitions both use. You never touch it. | nowhere |

## What you need

- A Windows PC with the modem plugged in by USB and a working SIM.
- **Node.js** (version 20 or newer) installed.
- For the AI: API keys from the services you choose. You enter them later on the dashboard's **AI Agent** page.

No modem yet? The project includes a **mock modem**, so you can try everything on screen without hardware.

## First run

1. **Install:** open a terminal in the project folder and run `npm install`, then `npm run --workspace=@sim-gateway/shared build`.
2. **Create your settings file:** copy `.env.example` to `.env`. Set `GATEWAY_API_KEY` to a long random password. Set `MODEM_DRIVER=hardware` for the real modem, or leave `mock` to try it without one. Leave the modem port settings empty; the gateway finds the modem by itself.
3. **Start the gateway:** `npm run dev:gateway`. Wait for the line saying it is listening on port 4000.
4. **Start the dashboard:** in a second terminal, `npm run dev:dashboard`, then open `http://localhost:3000`.
5. **Connect them:** on the **Settings** page enter `http://localhost:4000` and your `GATEWAY_API_KEY`.
6. **Check the modem:** the **Overview** and **Hardware** pages should show the modem as **READY** with signal bars. If not, see "When something looks wrong" below.

Prefer a menu? On Windows, `.\tools\ai-caller.ps1` starts the gateway and dashboard and shows status, ports, health and logs without you typing the commands above.

## Your first calls

Do these in order. Nothing here spends money until you add provider keys.

1. **Place a plain call** from **Dialer & Live** to your own mobile. Answer it, press a key, hang up. Open **Call History**: the call is listed with its timeline.
2. **Add the AI:** on **AI Agent**, enter your provider keys and pick a speech-to-text, language and voice model. The page lists exactly what is still missing.
3. **Confirm the audio by listening.** The AI is only allowed to speak once you have confirmed that audio really reaches the other person. Use the page's audio tests, and confirm only after hearing it.
4. **Let the AI take calls:** switch on automatic answering and replies when you are ready, and call the SIM from your mobile.
5. **Try the IVR:** on **IVR Menu**, upload or generate a short welcome and menu announcement, add the keys you want (for example 1 = talk to the AI, 9 = hang up), check the readiness panel, **Save**, **Publish**, then switch it on. Place a call out to your mobile: when you answer you hear the menu, and pressing the keys runs your options. The first test is also how you confirm that each key reaches the option you set.
6. **Listen back:** on **Call History**, press **Play** next to the call.

## Good to know

- **The IVR is for outgoing calls only.** Incoming calls always go straight to the AI.
- **Almost everything is off until you switch it on:** the AI, auto-answer, replies, recording and the IVR. A fresh install does nothing surprising.
- **Recording needs two switches** in `.env` (`CALL_RECORDING_ENABLED` and `CALL_RECORDING_CONSENT_ACKNOWLEDGED`). Recording calls can require telling people or getting consent where you live; the second switch is you saying you have dealt with that.
- **Keys you press on a call are never logged.** The call log shows which menu option was chosen, not the digit.
- **Your data stays on your computer**, in `packages/gateway/` (database, recordings, IVR audio). Back that folder up if the call history matters to you.

## Where things live

| What | Where |
| --- | --- |
| Your settings | `.env` (project root) |
| Call history, settings, IVR audio, model list | `packages/gateway/data/` |
| Call recordings | `packages/gateway/call-recordings/` |
| Raw audio captures (diagnostics) | `packages/gateway/audio-dumps/` |
| Technical documentation | `docs/` |

## When something looks wrong

- **"Failed to connect to Gateway" on the dashboard:** the gateway is not running. Start it (`npm run dev:gateway`) and read what it prints.
- **Gateway says "Another SIM7600 gateway process … already owns COM…":** either a second gateway really is running (stop it), or a crash left a stale lock file. Current versions clean stale locks automatically after a reboot; if it persists, delete the named `.lock` file in `%TEMP%\sim-gateway-locks`.
- **Modem not READY:** unplug and replug the USB cable, check the **Hardware** page lists the modem's ports, then restart the gateway.
- **The AI stays silent:** the **AI Agent** page shows a readiness list; the first red item is what to fix.
- **A recording sounds quiet on the caller's side:** that is how the modem delivers it. The recording already raises the caller's side; the recording's details say by how much.

## Going further

The [README](README.md) has the technical overview, configuration table and test commands. The `docs/` folder has the architecture, the full API reference, the AI agent guide, the Model Registry and the Windows hardware guide.
