# USB PCM hardware verification results

Fill this in from the runbook in `WINDOWS_HARDWARE_INTEGRATION.md` ("Real-hardware runbook").
Leave a field as `NOT OBSERVED` rather than guessing. Do not paste API keys, phone numbers or audio bytes.
No STT/LLM/TTS work starts until every row in the gate below is filled in.

| Field | Value |
|---|---|
| Date / operator | |
| Gateway commit + `git status` clean? | |
| `MODEM_AT_PORT` / `MODEM_AUDIO_PORT` (from `-List`) | COM22 / COM26 expected |
| Raw dump disabled (`AUDIO_ENABLE_RAW_DUMP=false`), no new `unvalidated_raw_audio_*` files | |
| Gateway log: raw dump line, ports, `READY` | |

## Inbound capture

| Observation | Value |
|---|---|
| `AT+CPCMREG=1` response and `moduleAudioFormat` (`cpcmfrm`, `cpcmbandwidth`) | |
| Capture 1 (1 kHz tone): `bytes`, `durationMs`, `stopReason` | |
| Bytes per second (`bytes / (durationMs/1000)`) | 16000 = 8 kHz 16-bit mono; 32000 = 16 kHz mono or 8 kHz stereo |
| `analyze` winning row: rate / bits / endian / `dominantHz` / `toneConcentration` | |
| Capture 2 (tone off, same call): best `toneConcentration` and `rms` | |
| Capture 3 (spoken digits): `speech indicator` voiced %, and intelligible when you listen to the candidate WAV? | |
| Periodic headers or framing seen in the first bytes? | |
| Format supported by the evidence (rate, bits, channels, byte order) | |
| Ambiguities left (e.g. 16 kHz mono vs 8 kHz stereo, byte order) | |

## Outbound tone (blind trials)

| Trial | Sent? (answer key) | Remote heard a beep? |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |

| Observation | Value |
|---|---|
| `assumedFormat` used (from the inbound result) | |
| Tone results: `stopReason`, `bytesWritten` per sent trial | |
| Remote heard sent trials and none of the silent ones? | |
| Pitch/level as the remote described it | |

A successful serial write is **not** evidence. Only the remote party's blind reports count.

## USB drop recovery (only if a drop happens during the test call)

| Observation | Value |
|---|---|
| Recovery report: `call`, `registration`, `audioPort`, `audioFlowing` | |
| Did incoming speech and outgoing tone still work after recovery? | |

## Shutdown

| Observation | Value |
|---|---|
| Gateway log shows `USB audio diagnostic deactivated` after hangup | |
| Any manual `AT+CPCMREG=0` needed? | |

## Gate (all must be filled before Milestone 3)

- [ ] Inbound tone found at 1000 Hz in exactly one candidate format, with a tone-off control that does not match
- [ ] Rate, bit depth, channels and byte order stated, with the cross-check (bytes/s and WAV listening)
- [ ] Outbound blind trials: remote heard every sent trial and no silent trial, or a clear negative result
- [ ] USB audio deactivated cleanly after every call
