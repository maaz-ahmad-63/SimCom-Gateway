# AI voice agent

An optional layer that turns the gateway into a phone-call agent:

```
caller audio -> audio source -> endpointer -> pre-STT gate -> STT -> LLM -> TTS -> audio sink -> caller
```

It is **off by default**, runs inside the existing gateway process, and talks to the modem only through
the gateway's own `IAudioAdapter` and call events. It never answers, dials, hangs up (unless you opt in,
see below), sends an AT command, or touches `AT+CPCMREG`.

**Status: the AI loop is verified offline (mocks only). Nothing here has been run on a real call.**
Live handling stays blocked until incoming speech and outgoing playback are proven on the hardware
(`docs/USB_PCM_HARDWARE_RESULTS.md`).

## Where it came from

The source project (`labs-sizh-voicely`) is a Python/LiveKit-agents service: WebRTC rooms, SIP trunks,
Supabase/Firebase, Twilio billing. None of that applies to a USB modem, and its LiveKit plugins cannot be
called from Node. What was reusable was its **decisions**, so those were ported to TypeScript:

| Source | Ported to | Notes |
|---|---|---|
| `stt_config.py`, `llm_config.py`, `service_factory.py`, `tts/*.py` | `src/ai/catalog.ts` | Slugs, model ids, voices, aliases and per-family request parameters verbatim |
| `deepgram_stt.py`, `groqwhisper_stt.py` | `providers/stt.ts` | One request per utterance instead of LiveKit streaming; AU/global Deepgram endpoints as in the source |
| `groq_llm.py`, `openai_llm.py`, `telnyx_llm.py` | `providers/llm.ts` | One OpenAI-compatible streaming client; Telnyx `region`/`mode`/thinking options from the source |
| `cartesia_tts.py`, `deepgram_tts.py` | `providers/tts.ts` | Raw 16-bit PCM requested at the sink's exact rate |
| `prompts/system_prompt.txt` | `src/ai/prompt.ts` | Rules kept; caller-phone-number block and booking rules dropped |
| `output_filter.py` | `src/ai/text.ts` | Ported with one bug fixed (see below) |
| `agent_models.strip_end_call` | `src/ai/text.ts` | Text after `END_CALL` is now discarded, as the prompt requires |
| Turn handling (VAD, 1.0-3.0 s endpointing, VAD interruption) | `src/ai/endpointer.ts`, `conversation.ts` | Energy VAD instead of Silero/ONNX (no new dependency) |

Not ported (so the gateway says so instead of falling back): AssemblyAI, Deepgram Flux, Soniox, Cartesia
STT; Gemini; ElevenLabs, Inworld, Murf, Sarvam, Soniox TTS; Deepgram's `flux-*` v2 voices; the
idle-follow-up manager; fallback chains; Supabase/Firebase/Twilio/LiveKit/SIP/recording/ledger code.

No new npm dependency was added (Node 22's `fetch`, `FormData`, `AbortSignal.any` are enough).

**Licence:** the source has no LICENSE file. It is treated as your own code.

## Files

`packages/gateway/src/ai/`: `catalog.ts`, `config.ts`, `prompt.ts`, `text.ts`, `audio.ts`, `endpointer.ts`,
`conversation.ts` (one session per call), `orchestrator.ts` (binds sessions to gateway calls),
`readiness.ts`, `gateway-adapters.ts` (the only SIM7600EI-specific code), `providers/{types,http,stt,llm,tts,mock,index}.ts`.
Also `src/api/routes/ai.ts`, `scripts/ai-loop.ts`, and small hooks in `server.ts` and
`diagnostics/usb-pcm-verification.ts`. Tests: `tests/ai/*.test.ts`.

## Stages

**A. Independent loop (no modem, no call).** `npm run ai:loop` below. Providers are fully mockable.

**B. Gateway integration.** An agent attaches to a call only if AI is enabled and configured, the call is
the current ACTIVE call, readiness passes, and the call is either armed by you
(`POST /api/ai/calls/:id/arm`) or matches `AI_AUTO_HANDLE` (default `off`). One agent, one call: history,
tasks and audio are keyed by call id; frames are dropped unless that call is still ACTIVE.

**C. Audio validation.** The engine accepts only 16-bit mono little-endian PCM at a rate you configure
(`AI_AUDIO_SAMPLE_RATE`, never defaulted). Before any paid STT request an utterance must be non-empty,
long enough, above the line's noise floor, and (optionally) show a pitch; **this is a hint that speech is
plausible, never proof it is intelligible.** TTS is requested in the sink's exact format and validated
(whole samples; a WAV reply must declare exactly that format). Playback is paced against a real-time clock
and counted from the audio adapter, so a dropped chunk is not reported as played.

**D. Readiness.** `GET /api/ai/readiness` reads state only (no network, no AT command, no audio) and
passes only when: AI is enabled and valid; provider keys are set; the modem is READY; a call is ACTIVE; the
audio format is configured; **and** `AI_AUDIO_INBOUND_VERIFIED` / `AI_AUDIO_OUTBOUND_VERIFIED` are set *and*
USB audio is observed flowing on the wire. A flag alone, or bytes alone, never passes. Default result: **not
ready**.

## Configure and run (Windows)

Add the `AI_*` and provider key entries from `.env.example` to your `.env` (existing entries are untouched;
this was not edited for you). Minimum for the offline loop with real providers:

```powershell
AI_ENABLED=true
AI_STT=nova-3
AI_LLM=groq_qwen_3_8_27b
AI_TTS=cartesia
AI_TTS_VOICE=katie
DEEPGRAM_API_KEY=...
GROQ_API_KEY=...
CARTESIA_API_KEY=...
```

Test without a phone call (from `packages\gateway`):

```powershell
npm run ai:loop -- --mock                                   # offline, no keys, no network
npm run ai:loop -- --live --text "What are your opening hours?"   # real LLM + TTS, STT skipped (costs money)
npm run ai:loop -- --live --input .\caller.wav               # real STT + LLM + TTS (costs money)
```
It writes `ai-loop-reply.wav` so you can listen to the reply. `--live` is required for any real request.

Gateway endpoints (existing API-key auth): `GET /api/ai/readiness`, `GET /api/ai/status`,
`POST /api/ai/calls/:id/arm`, `POST /api/ai/calls/:id/disarm`.

## Behaviour you can rely on

- **No automatic call control.** `END_CALL` raises an alert; it hangs up only with `AI_ALLOW_AGENT_HANGUP=true`,
  and then it is attempted once and never retried.
- **Failures stay inside the AI.** A provider error fails that turn only. After
  `AI_MAX_CONSECUTIVE_FAILURES` the agent stops answering and raises one alert; the call is untouched.
  Retries are bounded (`AI_MAX_RETRIES`) and only for idempotent provider requests.
- **Cancellation.** A new caller utterance (barge-in) or the call ending cancels STT/LLM/TTS requests and
  playback in flight; utterances that pile up are merged into one turn, so one caller turn never gets two replies.
- **Privacy and cost.** No raw audio is recorded unless you turn on diagnostic recording in the dashboard (off by
  default, bounded, local files only). Transcripts are not logged or shown unless `AI_LOG_TRANSCRIPTS=true` or the
  dashboard's "Show recognized and generated text" is on.
  Keys are read only when a call attaches and are redacted from errors. Per-turn timings and token/character/
  audio-second counts are in `/api/ai/status`.
- **COM26 is shared safely.** The AI agent and the PCM verification tests refuse to run at the same time.

## Control center (dashboard: AI Agent page)

The dashboard's **AI Agent** page (`/ai`) manages everything above without editing `.env`. It extends the
existing dashboard and gateway; no new service, and it never touches the modem (no AT commands, no call
control, no PCM registration).

| Tab | What it does |
| --- | --- |
| Overview | Readiness checklist (what is needed to *transcribe* vs to *reply*), mode, live session meters, the two audio confirmations, provider health, today's usage |
| Live Inspector | Every caller turn through 8 stages: PCM captured, PCM validated, sent to STT, STT result, LLM request, LLM response, TTS generated, playback. Each has its own status, timestamp, latency and failure reason |
| Speech-to-Text | Provider/model, language, timeouts, live audio meters and recent results, test with a saved recording |
| Language Model | Model, max tokens, fixed per-model parameters (read-only), latency/tokens/cost, text-only test |
| Text-to-Speech | Provider, voice, gateway sample rate, compatibility with the phone line, browser-only preview |
| Agent | The single agent profile: name, enabled, instructions, greeting, language, allow hang-up |
| API Keys | Add/replace/check/remove provider keys (write-only) |
| Usage & Logs | Totals and estimated cost, turn log, clear logs, optional diagnostic recording |

**Modes.** `Off` does nothing. `Passive` (the default whenever AI is enabled) transcribes caller audio and shows
it in the inspector; the LLM and TTS stages show **not run** and nothing is ever generated or sent to the caller.
`Active` (replies) needs *every* readiness check to pass, applies to the current call only, and returns to
passive when the call ends or the gateway restarts.

**Readiness never comes from mock mode.** On the mock driver the `hardware` check fails and replies stay
blocked. Replies also need two confirmations that only you can make: (1) a real passive call produced a live
transcript that matched what the caller said (the gateway refuses the confirmation until it has recorded a
transcript from a real, non-simulated call with a real provider), and (2) a remote party heard a blind tone
written to the audio port. Changing the gateway sample rate removes both confirmations.

**Keys.** Stored encrypted (AES-256-GCM) in the gateway's SQLite database, using `AI_SECRETS_MASTER_KEY` from
`.env`. They are never returned by any endpoint, never logged and never put in an error. A key saved in the
dashboard takes precedence over `.env`; removing it falls back to `.env`. Status is reported as three separate
facts: present (`missing` / `.env` / `stored`), and the last check (`not checked` / `ok` / `rejected` /
`unreachable`). "Check with provider" makes one read-only request to the provider's own listing endpoint.
Those endpoints (Deepgram `/v1/projects`, Groq and OpenAI `/models`, Telnyx `/v2/ai/openai/models`, Cartesia
`/voices`) were chosen from provider conventions and are **not yet exercised against a live account**.

**Limits worth knowing.** STT is batch (one request per finished utterance): there are no partial transcripts.
Only providers marked implemented can be selected; the others are listed with "not ported". The model
parameters the dashboard can change are `max tokens` and the timeouts; temperature and reasoning settings are
fixed per model family by the gateway. Costs are *estimates* from the source project's price table and show
`n/a` when any used model has no price. Mock-provider runs are never counted as usage.

**Settings precedence and timing.** Values saved in the dashboard live in the database and override `.env`.
A change applies to the next call; a call already in progress keeps the settings it started with. Transcript
text is shown and stored only while "Show recognized and generated text" is on (default off).

**API** (all under `/api/ai`, API-key protected): `GET /state`, `/catalog`, `/settings`, `/agent`, `/credentials`,
`/events`, `/sessions`, `/usage`, `/turns`, `/recordings`, `/test/tts/compatibility`; `PUT /settings`, `/agent`,
`/credentials/:name`; `POST /mode`, `/attestations/:inbound|outbound`, `/credentials/:name/validate`,
`/test/stt|llm|tts` (each requires `confirmBilling: true`), `/calls/:id/arm|disarm`; `DELETE /credentials/:name`,
`/attestations/:kind`, `/turns`. Live events: Socket.IO `ai:event`.

### Windows: first real session

1. In `packages\gateway\.env` add `AI_SECRETS_MASTER_KEY=<16+ random characters>` (once, never change it). You do
   not need `AI_ENABLED=true`: the agent is enabled from the dashboard. Also set `AUDIO_USB_DIAGNOSTIC_ENABLED=true`
   (the activate route is refused without it) and, for the tone test in step 7,
   `AUDIO_USB_PCM_OUTBOUND_TONE_TEST_ENABLED=true`. The gateway must run with `MODEM_DRIVER=hardware`: on the mock
   driver every check that depends on real hardware fails by design. Restart the gateway.
2. Dashboard → **AI Agent → API Keys**: add the Deepgram key (and Groq/OpenAI/Telnyx and Cartesia keys for the
   models you will use). Press **Check with provider** for each and read the result.
3. **Text-to-Speech** tab: set the gateway audio sample rate (use the rate you verified; 8000 is SIMCom's
   documented rate, not a proven one). **Agent** tab: tick *Agent enabled*, write instructions, save.
4. **Speech-to-Text** tab → test with an existing recording (it is billed; it does not count as live evidence).
5. **Language Model** tab → run the text-only test. **Text-to-Speech** tab → generate a browser preview. These
   are separate from any call and send nothing to the modem.
6. Place or answer a real call as usual and activate USB audio for it with the existing documented step
   (`POST /api/gateway/audio/usb-diagnostic {"action":"activate"}`, see `docs/WINDOWS_HARDWARE_INTEGRATION.md`;
   the dashboard never sends it because it changes the modem's PCM registration). On **Overview**, once
   *Caller audio arriving* passes, press **Attach to this call** (passive). Turn on *Show
   recognized and generated text* in the inspector, talk, and read each stage. If STT results do not match what
   was said, stop: the audio path is not proven and nothing below should be done. In the live meters, compare
   *Observed rate* with the assumed rate (they must agree) and the RMS with the *Speech level threshold* on the
   Speech-to-Text tab. Speech on this modem is quiet (about 0.005 RMS); the default threshold is 0.003, and audio
   below it is never sent to the provider. The inspector shows PCM received, audio submitted and the provider's
   result as separate stages; only you can judge whether the words are right.
7. Only if the transcripts matched: confirm *Caller audio is intelligible* with a note. Run the blind tone test
   with the existing USB PCM tools and a second phone; only if it was heard, confirm *Agent audio is audible*.
8. With every check passing, **Enable replies** (two clicks) on a call you control. It reverts to passive when
   the call ends.

### One-shot test response (does the AI's voice reach the other party?)

On **Overview**, during an ACTIVE call with the AI attached in passive mode, **Generate & Play Test Response**
makes exactly one reply: the caller's latest voiced transcript (at most 60 s old) goes to the configured LLM,
the reply to the configured TTS, and the audio through the same paced USB playback the live pipeline uses.
It is a separate gate from "Enable replies": it does not need the outbound confirmation (it is how you get
it), but it needs a real ACTIVE call, an attached passive session, a recent voiced transcript, all provider
keys, audio bytes flowing (so the USB registration is valid), and a PCM rate that agrees with what the module
reports (`AT+CPCMFRM`) and with the rate actually arriving. Results are shown for LLM, TTS, playback
submission (some bytes accepted by the port) and playback completion (all bytes written in real time)
separately. None of them means the other party heard it: after the test, ask them, and confirm *Agent audio is
audible* only if they did. The test never changes the mode, hangs up, repeats, or marks anything verified.
API: `POST /api/ai/calls/:id/test-response` with `confirmBilling` and `confirmPlayToCaller` both `true`;
readiness is `testResponse` in `GET /api/ai/state`.

## Hands-free calling (incoming call to hang-up)

Reference audit (`labs-sizh-voicely-main`, Python on LiveKit Agents): its transport is LiveKit rooms/SIP and its
turn handling is Silero VAD with 1.0–3.0 s endpointing and VAD interruption (`services/llm/agent_service.py`
~1308–1371). Neither LiveKit nor WebRTC is used here: the modem's audio is already raw PCM in the gateway process,
so a bridge would only add a server, a codec hop and latency. Reused/adapted:

| Reference | Here |
| --- | --- |
| `AgentSession` conversation loop, VAD endpointing (1.0 s silence), barge-in | `ConversationSession` + `EnergyEndpointer` (already ported earlier) |
| `services/llm/idle_manager.py` + follow-up/goodbye tables in `llm_config.py` | **new** `src/ai/idle.ts` (same 15 s / 9 s / 8 s stages, en/ar/hi lines) |
| END_CALL protocol, output filter, prompt, provider tables | already ported |
| Streaming STT plugins | not ported: one request per utterance is bounded, testable offline and fast enough on 8 kHz phone audio; a WebSocket STT is a later, separately verified step |

New in the gateway: `src/ai/automation.ts` answers after N rings (counting each ring/caller-ID cycle once, including
the first), activates USB audio once when an eligible call becomes ACTIVE, and waits for real bytes. The
orchestrator then attaches (listening only) and, when automatic replies are on and every readiness check passes,
the agent speaks. It also starts the idle follow-ups, enforces the per-call AI time limit, and retries one turn after
a provider-failure cool-down. Pending caller audio is capped at 30 s.

All switches are off by default (dashboard Agent tab → Call automation, or `AI_AUTO_*` in `.env`).
**Automatic replies cannot be saved until both audio confirmations exist**, are withdrawn if a confirmation is
removed or the sample rate changes, and even when on they only apply while the *entire* readiness check passes
right now; otherwise the call is attached passively. Manual attach, passive mode and the one-shot test are unchanged.

What the inspector reports separately, per turn: audio received (meters), transcription completed, LLM generated,
TTS generated, playback written ("written to the audio port; whether the caller heard it is not verified"). *Caller
heard it* exists only as your confirmation on the Overview tab; no write, byte count or completed playback sets it.

### Conversation mode (operator-enabled, per call)

On **Overview → Conversation mode**, **Start conversation** (two-step confirmation) makes the AI answer every
finished caller utterance on that call, with no click per turn: listening → transcribing → generating reply →
speaking → listening again. It attaches the AI first if needed. It is per call: it never carries over to the next
call, **Stop conversation** (or hang-up) ends it at once including speech in progress, and the persistent
mode, the audio confirmations and the one-shot test response are untouched. Passive transcription stays the
default. API: `POST /api/ai/calls/:id/conversation` with `{ "enabled": true, "confirmBilling": true,
"confirmPlayToCaller": true }` (disable needs only `{ "enabled": false }`); readiness is `conversation` in
`GET /api/ai/state` and per-session phase, last-turn stage timings and last error are
`sessions[].conversation`.

It needs the same output-path checks as the test response (real ACTIVE call, valid config and all keys, audio
bytes flowing, PCM rate agreeing with the module) but not a fresh transcript; the operator's explicit click is the
permission for this call. It never marks "agent audio audible" as verified.

**Half-duplex turn-taking (default).** The gateway's audio port reads and writes independently (code-verified:
`hardware-audio.ts` writes playback and reads capture on separate paths, so frames keep arriving during
playback), but what comes back on the downlink while the agent speaks is **not verified on this hardware**:
the caller's phone can feed the agent's voice back. So while the agent plays audio (and for
`AI_PLAYBACK_GUARD_MS`, default 500 ms, after) caller audio is measured but not transcribed, and any half-heard
utterance is dropped. The caller therefore has to wait for the agent to finish; barge-in during speech is off.
Barge-in remains available only with `AI_HALF_DUPLEX=false`, which should be switched on only after a real call shows
the agent does not hear itself. If the caller speaks while the agent is still *generating* (before it speaks), the
newest utterance wins and the earlier turn is cancelled and merged, so one caller turn never gets two replies.

### Safe real-hardware plan (do in order; stop at the first surprise)

1. Rebuild and restart with everything off (outside a call). Confirm Agent tab → Call automation shows
   "Never speaks by itself".
2. **Passive auto-attach only.** Turn on *Activate USB audio automatically*, set *Attach automatically* to Incoming
   calls, leave *Answer automatically* and replies off. Call the SIM from another phone and answer by hand. Expect
   inspector markers: "USB audio activated automatically", "Audio bytes are flowing", "AI attached". Speak; read the
   transcripts. Hang up from the far end: the AI must detach, no further provider requests.
3. **Auto-answer.** Enable *Answer incoming calls automatically* (2 rings). Call again: it should answer after two
   rings and attach as above. Check the call list shows one answered call, and that a second ring burst does not answer twice.
4. **Prove outbound audio first.** With a call up, run the one-shot test response and the blind tone test with a person
   on the far end. Only if they clearly heard it, confirm both Overview confirmations.
5. **Automatic replies.** Enable *Let the agent speak without a click*. Call, hold 3–4 exchanges, interrupt it
   mid-sentence, stay silent for 30 s (expect two follow-ups, then a goodbye; it hangs up only if *Let the agent end the
   call* is on), then hang up from the far end mid-reply. Confirm: playback stops, the AI detaches, no more LLM/TTS calls.
6. Watch for: audio bytes arriving at the assumed rate (Observed rate tile), modem drops mid-call (USB recovery re-checks
   the registration), and the per-call time limit (the AI detaches, the call continues).

Blockers that remain until you test them: uplink audibility on this firmware (unverified), behaviour of
`AT+CPCMREG` re-registration after a mid-call USB drop (the earlier hardware returned an AT error), and real
provider latency on a phone line.

## Notes on the port

- **Output-filter bug fixed.** The source's `ProtocolTextFilter.finish()` treats any trailing text that is a
  prefix of `call tool=` as an unfinished control tag, so a reply ending in "call" (including the `CALL` of
  `END_CALL`) was silently dropped. Only `<` and `[` tag openers are withheld now.
- **Groq Whisper bills a minimum of 10 s per request**, so very short utterances cost the same as 10 s.
- **STT is per utterance, not streaming**, which adds latency (roughly the STT round trip) compared with the
  source; it is the simplest thing that can be bounded, cancelled and tested.
- Provider request shapes were checked against each provider's published reference where it states them;
  Deepgram's TTS reference does not list the `linear16`/8 kHz values, so its reply is validated, not trusted.
  Groq's page does not state the auth header; `Authorization: Bearer` is the OpenAI-compatible convention.
  None of this has been exercised against a live account.


## Hands-free inbound calls and call recording

### Why three manual steps were needed
Everything below already exists and is opt-in, each step at most once per call:

| Manual step | Automatic equivalent | Gate that kept it manual |
|---|---|---|
| `POST /api/gateway/audio/usb-diagnostic {"action":"activate"}` | `AI_AUTO_ACTIVATE_USB_AUDIO=true` | Only runs on an ACTIVE call that the AI is allowed to handle (`AI_ENABLED`, `AI_AUTO_HANDLE` covering the direction, provider keys). With auto-answer off, someone must answer first. |
| Connect the AI to the call | `AI_AUTO_HANDLE=inbound` (or `all`) | Default `off`. Attaches only after real audio bytes are flowing. |
| Dashboard "Start AI replies" | `AI_AUTO_REPLIES=true` | Refused until BOTH audio paths are confirmed (`AI_AUDIO_INBOUND_VERIFIED` / `AI_AUDIO_OUTBOUND_VERIFIED` or the dashboard attestations). Until then the agent stays passive. This is deliberate: a successful write is not proof the caller heard anything. |
| Answer the call | `AI_AUTO_ANSWER=true`, `AI_AUTO_ANSWER_RINGS=2` | Default off. Never answers when off. |

### Recording
Set `CALL_RECORDING_ENABLED=true` and `CALL_RECORDING_CONSENT_ACKNOWLEDGED=true` (see `.env.example`). Each call that
becomes ACTIVE is saved as two mono 16-bit PCM WAV files plus `recording.json`; the headers are refreshed every
5 s and finalized when the call ends or the gateway shuts down, so a crash leaves playable files. The sample rate is
the configured gateway rate, not something the module reported. "agent" is what was written to the audio port:
a successful write is not proof the caller heard it. Gaps are filled with silence so both tracks share the call's
timeline. API: `GET /api/gateway/recordings` and `GET /api/gateway/recordings/<callId>/<caller|agent>.wav` (API key
required). The dashboard shows them on AI Agent > Overview. Retention only ever deletes finished recordings that
this feature made, and only when `CALL_RECORDING_RETENTION_DAYS` is above 0.

## Turn-taking, latency and memory

Everything here is on the existing pipeline (audio port, energy endpointer, Groq Whisper, Groq Qwen, Cartesia). No
provider was replaced. Defaults are listed so you can see what changes on the next restart.

### Where the time goes, and how it is measured
Each spoken reply writes one line to the Call events, for example
`First audio written 1180 ms after the caller stopped talking (silence wait 800, transcript ready at 905 ms (speculative), first words from the model at 1075 ms, first synthesized audio at 1160 ms)`.
The clock starts when the caller's speech ended (the last loud 20 ms window), not when the turn began, so the
silence wait is counted. "Written" means handed to the audio port: it is not proof the caller heard it, and the
line, network and handset add delay that cannot be measured from here. The gateway log has the same figure as
`firstAudioAfterCallerStopped`, and `gapRiskFrames` counts frames that went out later than the write-ahead covers
(an audible gap is possible), separately from ordinary timer jitter (`lateFrames`).

### What each setting does
| Setting | Default | Meaning |
|---|---|---|
| `AI_VAD_MIN_SILENCE_MS` | 1000 | Silence that ends a caller turn. With adaptive on this is the ceiling. |
| `AI_VAD_ADAPTIVE` | false | Learns this caller's mid-sentence pause length (never below `AI_VAD_MIN_SILENCE_FLOOR_MS`, default 450) and raises the loudness threshold on a hissy line. **Off by default**: it only ever saw pauses shorter than its own current wait (a longer pause ended the utterance and was never learned), so its wait ratcheted down to the floor and callers were cut off mid-sentence. With it off the wait is exactly `AI_VAD_MIN_SILENCE_MS`. |
| `AI_VAD_ONSET_HANGOVER_MS` | 100 | Before speech has lasted `AI_VAD_MIN_SPEECH_MS`, a quiet gap up to this long does not restart the count, and short bursts are kept as pre-roll. A short first word ("I", "yes") followed by a brief gap is no longer thrown away; a lone click still does not open an utterance. |
| `AI_STT_STREAMING` | false (also a dashboard setting: AI Agent > Speech-to-text) | Streams caller audio (8 kHz mono, declared as 8 kHz) to Deepgram over a WebSocket while they speak, using the source project's model, language, AU/global endpoint rule and keyterms. Only FINAL text, requested at the confirmed end of the utterance, is used; an interim hypothesis never starts a reply. If the stream fails or times out (`AI_STT_STREAM_FINALIZE_MS`, 1500) the batch provider chosen by `AI_STT` transcribes the audio. Needs `DEEPGRAM_API_KEY`; without it the batch provider is used and an alert says so. While a stream is active the speculative batch request and `AI_EARLY_COMMIT` are not used. **Not yet exercised against the real Deepgram service.** |
| `AI_FIRST_CLAUSE_MIN_CHARS` | 32 | The first chunk of a reply may end at a comma, semicolon, colon or dash once it is this many characters long, so speech synthesis starts before the first sentence is finished. Only the first chunk of a reply is cut this way. `0` restores sentence-end-only behaviour. |
| `AI_VAD_ENGINE` | energy | `silero` uses the Silero model as the speech detector (`AI_VAD_SILERO_MODEL`, `AI_VAD_SILERO_THRESHOLD` 0.5). It needs `onnxruntime-node` and the model file, neither of which is in the repository; if either is missing the gateway says what is missing and keeps the energy detector. 8 kHz audio is given to the model as 8 kHz. **Not yet exercised against the real model or runtime.** |
| `AI_SPECULATIVE_STT` | true | After `AI_VAD_SOFT_SILENCE_MS` (350) of silence, transcribe what was said so far. If the caller was finished the turn reuses it (one request); if they carry on it is withdrawn. A request is never a turn: only the real end of the utterance starts one. |
| `AI_EARLY_COMMIT` | false | Answer as soon as the speculative transcript is a finished sentence (ends in . ? !, 3+ words, 1+ s of speech), without waiting out the rest of the silence. If the caller was not done, they interrupt like any barge-in and the two parts are merged. Try it on a supervised call first. |
| `AI_BARGE_IN_WHILE_SPEAKING` | true | Half-duplex used to discard caller audio while the agent spoke, so an interruption could never be heard. Now that audio is watched for sustained speech (`AI_BARGE_IN_MS`, 300) well above the line's own level (`AI_BARGE_IN_ECHO_MULT`, 2.5x). Set false for strict half-duplex. |
| `AI_BARGE_IN_MAX_FALSE` | 2 | Interruptions in a row that contained no speech before detection switches itself off for the call (with an alert). |
| `AI_PLAYBACK_LEAD_FRAMES` | 2 | 20 ms frames written ahead of real time. More absorbs timer jitter but cannot be taken back when the caller interrupts. |
| `AI_PLAYBACK_PREROLL_MS` | 150 | Audio buffered before a streamed reply starts. |
| `AI_FIRST_SENTENCE_MIN_CHARS` | 24 | Lower it (e.g. 6) to let a short opener such as "Sure." play on its own. |
| `AI_LLM_MAX_TOKENS` | 220 | Cap on a reply (a spoken answer is a sentence or two). |
| `AI_CALL_NOTES` | true | See "Memory". |
| `AI_KNOWLEDGE_DIR` | unset | See "Company knowledge". |

### Interruptions
When the caller talks over the agent: speech is stopped (queued sentences are dropped, the language-model and
text-to-speech requests for the rest are cancelled), the gateway stops being deaf at once, and the last 800 ms of
audio (including the first words) is handed to the endpointer. Detection calibrates on the first 600 ms of each
stretch of agent speech, so steady echo that is already present does not trigger it. Echo that arrives later is
caught by a second check: an utterance that began as an interruption and whose words are almost all words the agent
had just said is dropped as the agent's own voice and never answered. This cannot be proven without the real line:
see the validation steps below.

### History, memory and what was actually said
* One assistant message per reply (never one per sentence).
* Only what was spoken is recorded. Whole sentences played to the end, plus the words of an interrupted sentence that
  went out before the interruption, followed by an ellipsis. The prompt tells the model an ellipsis means the caller
  cut it off. Sentences that were never played are not in the history.
* Two caller messages in a row (the first got no reply) are merged into one.
* **Memory.** The history is a window (`AI_MAX_HISTORY_MESSAGES`, 20). Turns that scroll out of it are folded, in the
  background and never blocking a reply, into short call notes (name, what they want, numbers, decisions, promises)
  that ride in the system prompt. If the model cannot summarise, a shortened form of the dropped lines is kept. Notes
  live only for the call.

### Company knowledge (retrieval)
Put the facts you have verified (services, pricing, hours, policies, contact details) in `.md` or `.txt` files in a
folder and set `AI_KNOWLEDGE_DIR`. Each caller question retrieves the one to three best passages (BM25, a few
milliseconds, abandoned after 150 ms) and only those go into that turn's prompt, labelled as the only source for
company facts. Whenever a folder is configured the prompt also says: if the passages do not cover it, say you do not
have that detail and offer a follow-up; never invent a service, price or promise. Nothing is sent anywhere new: the
passages go to the same language model. To use a vector store or a service instead, implement `KnowledgeProvider`
(`retrieve(query, {topK, maxChars})`) in `src/ai/knowledge.ts` and pass it as the orchestrator's `knowledge`
dependency; nothing else changes. Write short, factual, self-contained passages; keep one fact per paragraph.

### Hardware validation (not possible from code)
1. Restart the gateway with no call active. Make one supervised call and read the "First audio written" lines.
2. Barge-in: let the agent start a long answer and talk over it. It should stop within about 0.4 s and answer you.
   Then stay silent while it talks: it must not interrupt itself. If it ever answers its own words, set
   `AI_BARGE_IN_WHILE_SPEAKING=false` and tell us what the log said.
3. Compare `gapRiskFrames` over several replies. If it is regularly above 0, try `AI_PLAYBACK_LEAD_FRAMES=3`.
4. Try `AI_EARLY_COMMIT=true` on a test call before relying on it.

## Turn timing, fallbacks and empty replies

Each turn's `call` event on the timeline carries one set of figures, all measured from the end of the caller's speech on the
monotonic clock: transcript ready, first model token, model done, first synthesized audio, **first audio written to the modem port**
(`firstAudioLatencyMs`, what the caller waits), and **playback duration** (`playbackMs`, how long the reply took to speak: not
waiting time). A write is not a sound heard. The same event names what stalled the loop during the turn: `loopLagMaxMs` (the
event loop), `gcMaxMs` (garbage collection), `maxWriteMs` (the slowest single write to the audio port) and `syncIoMaxMs` with
`syncIoLabel` (the slowest synchronous disk write, for example a call recording write).

When the Deepgram stream's words are not used the speech-to-text result says why (`streamFallbackReason`, also in the timeline text and
the gateway log): the stream failed (with the provider's error), no final text arrived (with how the wait ended and how long it was),
it returned no words for speech-like audio, no stream was open, or audio from an interrupted turn was merged so the whole audio was
transcribed in one request. The stream is only treated as finished when the server has actually answered; silence alone is not an answer.

A model reply with no text is never spoken. It is asked for once more, and if that is empty too the turn fails with
`reason: llm-empty` and the cause in the telemetry (for instance "the token budget ran out before any reply text"); at most two model
requests are made. `AI_LLM_REASONING_EFFORT` (default `low`) and `AI_LLM_REASONING_TOKENS` (default 1024) apply to the gpt-oss models,
whose hidden reasoning counts against the token budget. `AI_CONTACT_DETAILS` (default on) tracks the name, phone number and email address the caller
gives and tells the model, every turn, what is known and what is still unconfirmed. Each is confirmed explicitly: it is read back once
(a phone number in small groups, an email spelled letter by letter with "at" and "dot", a name said back with an offer to spell
it) and counts as confirmed only when the caller agrees to that read-back. Nothing is guessed: an unclear digit stays a `?`, an
email is only what was said (no completed domain, no corrected spelling), a correction replaces the old value and starts
unconfirmed, and only one detail is read back at a time. English words only.

## Campaigns

The Campaigns page (`/campaigns`) runs an outbound list through the same call lifecycle as the dial pad. A campaign is started from an idle gateway, so the check is limited to what can be known without a call: the AI is enabled with its
keys, the hardware and modem are ready, automatic replies are on, automatic handling includes outbound calls
(`AI_AUTO_HANDLE=outbound` or `all`, or the equivalent dashboard setting), and both audio paths have been confirmed. Anything missing
is named and the start is refused, because otherwise the person would hear silence. The checks that need a live call (audio
flowing, the call being active) happen when the call is answered: if the agent then does not join, the campaign pauses and alerts. Each contact's details reach the agent as per-call context; the global
prompt is never changed. See `docs/API.md` (Campaigns) for the endpoints and the rules the engine applies before every call.
Calling hours, consent and do-not-call handling are settings you configure; they are not legal advice, and you remain responsible
for following the rules that apply where you and your contacts are.

Campaign calls do not hang up on their own account. If a call is answered and the agent never joins, or never reports its end, the
campaign pauses and raises an alert; hang up from the Dialer page. Declined calls cannot be told apart from other calls that end
before an answer, so those are not retried. A clear spoken request not to be called again is added to the do-not-call list.

## Inbound and outbound agents, tool calling and Google Sheets

### Separate inbound and outbound configuration

One voice engine, two configurations. The speech recognizer, the model, the voice, the built-in call rules, the call lifecycle and
the campaign context are shared; only the operator's **instructions** and the **greeting** can differ by call direction. They are
set on the dashboard's Agent tab (Inbound calls / Outbound campaign calls) or in `.env` (`AI_INBOUND_INSTRUCTIONS`,
`AI_INBOUND_GREETING`, `AI_OUTBOUND_INSTRUCTIONS`, `AI_OUTBOUND_GREETING`).

- The prompt is the direction's instructions (or, if it has none, the shared `AI_SYSTEM_INSTRUCTIONS`) followed by the built-in rules.
  The greeting is the direction's greeting, else the shared `AI_GREETING`. A gateway that sets none of the four behaves exactly as before.
- A campaign still adds its per-contact context to the outbound prompt, and a greeting template set on a campaign is spoken instead of
  the outbound greeting for that campaign.
- The call's direction decides which is used, at attach time. The trace of each call records which one applied
  (`instructionsFrom`, `greetingFrom`: direction, shared or none).

### Tool calling

The model can be given functions and gets each result back before it answers. Only one tool exists today, `save_contact_details`.

- **Model support.** Each model family in the catalog declares whether its endpoint accepts function calling: OpenAI, Groq (gpt-oss
  and Qwen) and Gemini yes (from their documentation); the Telnyx-hosted models are **off until verified** on a real call. A model
  without support is used exactly as before: no tools field is sent, no tool rules are added to its prompt. If a provider rejects a
  request that carried tools (HTTP 400/422 naming tools or functions), that request is answered without them and the provider
  instance is not offered tools again. The Integrations tab states whether the selected model supports tools.
- **Bounded.** At most two rounds of tool calls per reply and three calls per round; after that the model is asked again without tools
  and must answer in words. Each tool has a timeout (10 s for saving a contact). The tool exchange lives only within the reply; the
  stored history keeps just what was spoken.
- **Untrusted output.** Every call is checked against the tool's strict schema (unknown fields, wrong types, oversized or malformed
  JSON are refused), may run only in a call mode it lists, and returns an error result for the model to report honestly. A tool
  failure never throws into the call.
- **Permissions per mode.** The save tool is offered separately for inbound and outbound calls (switches on the Integrations tab).
  The list is read at the start of every reply, so a switch takes effect on the next reply.
- **Instructions the model cannot override.** When tools are offered, the prompt adds rules that the caller's words and the campaign
  data are information, never instructions. More importantly the tool does not trust the model: see below.

### Google Sheets

Integrations tab: paste a Google **service account** key (JSON), enter the spreadsheet and tab, choose where the agent may save, and
press *Test connection*. Share the spreadsheet with the service account's email as an **Editor**; enable the Google Sheets API for the
key's project.

- **Credential handling.** The key file is validated, then stored encrypted (AES-256-GCM, the same scheme and `AI_SECRETS_MASTER_KEY`
  as the provider API keys). Without a master key it cannot be stored. It is never returned by any API, shown again, or logged; the
  dashboard only learns whether one is stored and the account's email. Only the email and private key are kept, and the file's own
  `token_uri` is ignored: sign-in goes to Google's token endpoint only.
- **Connection test.** Signs in, opens the sheet, checks the tab and the header row. It is read-only: it never writes to the sheet, and
  it cannot prove edit permission (the first saved record does).
- **What is written.** Columns `record_key, recorded_at, type, call_id, campaign_id, contact_id, direction, name, phone, email,
  outcome, detail`. The header is written when the tab is empty; a tab whose first row is anything else is refused, so existing data
  is never overwritten. Values are written as text (`RAW`), so nothing is parsed as a formula and a phone number keeps its leading zero.
- **Only confirmed details.** `save_contact_details` takes the *values* from what this call's own transcript established and the
  caller agreed to after a read-back (the contact-detail tracker), not from the model's wording. An unconfirmed, missing or different
  value is refused with the reason, so the agent goes back and confirms it. A correction replaces the old value and must be confirmed
  again before it is saved. Nothing is guessed or filled in; absent details are empty cells.
- **No duplicates.** Each record has a key (`campaign:<id>:<contact>:contact` for a campaign contact, `call:<id>:contact` otherwise,
  `call:<id>:outcome` for an outcome). Saving the same key again does nothing if identical, or corrects that row (keeping details
  confirmed earlier). Writes run one at a time, so two cannot race for one row, and a retry after a lost response finds the row.
- **Success means Google said so.** A save is reported as done only when Google's response confirms the row was written; any other
  answer is "not saved", and the agent is told not to claim otherwise.
- **Campaign outcomes.** With *Log a campaign outcome row* on, each finished campaign call writes one row (answered, no_answer, busy,
  ended_before_answer, failed, or opted_out). A person who asked not to be called is logged with no name and no number. A Google
  failure is logged and never affects the campaign.
- **Consent and do-not-call.** Nothing is saved after the caller says they do not want to be contacted (on any call), and nothing is
  saved for a campaign contact who is on the do-not-call list, has opted out or declined consent. A detail saved before such a request
  stays in the sheet: remove it there by hand.

### Not verified against the real services

Everything above is tested with mocks (a scripted model, a fake Google, the mock modem). Still to confirm live: that each provider's
real endpoint accepts and honours `tools` for the model you use; a real service account against a real spreadsheet (permissions,
quota, the first write); the agent's behaviour on a real call (it asks for confirmation before saving, and waits for the tool); and
that the pause while a save completes (about a second or two) sounds acceptable.
