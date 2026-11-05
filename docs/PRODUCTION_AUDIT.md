# Production-readiness audit

Date: 2026-11-04. Scope: gateway, dashboard, shared, tools, docs, dependencies. Method: reading the code and running `npm audit`; nothing was run against the modem. Every finding below was seen in the code unless it says "not verified".

## What already exists (reuse, do not rebuild)

- API-key authentication on every `/api` route and on Socket.IO, constant-time comparison (`api/middleware/auth.ts`). In hardware mode the gateway refuses to start with a placeholder key.
- Binds to `127.0.0.1` by default, CORS limited to one origin, JSON body limit 1 MB, secrets redacted in logs, diagnostic text redaction (dialled digits, DTMF, tokens).
- Cross-process COM-port ownership lock (`core/instance-lock.ts`), serialized AT command queue (`adapters/modem/at-command-queue.ts`), auto port discovery from the modem's USB identity.
- Hardware status already queries `AT+CPIN?`, `AT+CSQ`, `AT+CEREG?`/`AT+CREG?`, `AT+COPS?`; an authenticated `AT+CEER` endpoint exists (refused during a call).
- Model/provider secrets are encrypted at rest (`ai/secrets.ts`); recordings are served only with the API key; CSV and IVR WAV uploads have size and format rules.
- An alert event (`gateway:alert`) and a dashboard context that receives it; `tools/ai-caller.ps1` operations menu; DB backups are possible with SQLite's own backup API.

## Findings

### P0 — security or data loss

| # | Finding | Evidence |
|---|---|---|
| P0-1 | Next.js 14.2.35 has many published advisories (rated critical by npm: request smuggling, cache poisoning, several denial-of-service issues). The fix is a major version (15/16). | `npm audit --omit=dev` |
| P0-2 | `body-parser` 1.20.8 (high: denial of service via a compressed body) and `qs`, `uuid`, `postcss`, `zod` advisories. `body-parser`, `qs`, `uuid` have non-breaking fixes. The `zod` advisory (high, fixed in 4.x) is a major bump: not applied blindly. | `npm audit` |
| P0-3 | Customer data lives inside the application folder (`./data/gateway.sqlite`, `./audio-dumps`, recordings beside the database). An update that replaces the folder can destroy it. | `config/index.ts` defaults |
| P0-4 | No application-level backup or restore feature (a manual copy only). A corrupt database has no recovery path. | no backup code |
| P0-5 | The dashboard keeps the gateway API key in the browser (`localStorage`) or in a `NEXT_PUBLIC_` build variable, which would be baked into the public bundle. Acceptable on one local PC, wrong for a distributable. | `dashboard/src/lib/config.ts` |

### P1 — production-breaking reliability

| # | Finding |
|---|---|
| P1-1 | No supervisor. The gateway runs as `tsx watch`/a terminal process. If it crashes it stays down until someone notices. Nothing detects a crash loop. |
| P1-2 | No unauthenticated liveness endpoint, so a supervisor or the dashboard cannot tell "gateway down" from "wrong key". |
| P1-3 | No central health model. Pieces exist (hardware status, AI readiness, recorder status) but nothing combines gateway, modem, SIM/network, providers, database, storage, disk and background jobs into one state with history. |
| P1-4 | Alerts are transient events. Nothing persists them, de-duplicates them, resolves them on recovery or keeps a history. |
| P1-5 | Logs go to the console and a 500-line in-memory buffer only. No file, no rotation, no retention. A support request has nothing to attach after a restart. |
| P1-6 | Per-call failure facts (modem result, network cause, signal, registration at the time) are not saved with the call. "Busy" cannot be explained afterwards. |
| P1-7 | No disk-space monitoring (no free-space check anywhere) although recordings and the database grow without a ceiling other than retention settings. |
| P1-8 | There is no install, uninstall, upgrade or rollback path. The product only runs from a developer checkout with Node and npm. |

### P2 — usability and operations

- No first-run setup wizard; setup is editing `.env`.
- No version or compatibility surface between gateway and dashboard; no update status.
- No rate limiting on failed API-key attempts, and no security headers (`helmet`-style) on API responses.
- No support-bundle export.
- Connection-loss handling in the dashboard is partial (stale data is not labelled as stale).
- `AT+CGREG?` and `AT+CLCC` are not part of any diagnostic.

### P3 — polish and maintainability

- Developer wording in several screens (port names, "mock", raw codes) with no plain-language layer.
- `tools/` PowerShell scripts are the only operator interface outside the dashboard.
- Documentation describes a developer setup only.

## Not verified (needs the physical modem, or was not examined)

- Whether any network-diagnostic poll interferes with an active call or the audio port (the design below avoids polling during a call; behaviour on hardware is unproven).
- Docker access to the COM and USB audio interfaces (see the packaging decision: not attempted, and not expected to work).
- Real weak-signal, unregistered-SIM and carrier-busy behaviour.
- Every route's authorization and every upload path were not individually penetration-tested; the checks above are from reading the code and its existing tests.

## Packaging decision

**Recommendation: one Windows installer. Do not use Docker.**

- Docker Desktop on Windows runs Linux containers inside a WSL2 virtual machine. A Windows COM port and a USB audio class device are not visible inside it. The only route is `usbipd-win` forwarding of USB devices into WSL2, which needs a separate driver install, an administrator command per plug-in, and breaks when Windows re-enumerates the modem (which this project already has to handle). The SIM7600's PCM audio passthrough would add latency risk to the most timing-sensitive part of the product.
- The product's value is the physical modem. Windows services reach COM ports natively.
- Internal design: one installer that lays down a bundled Node runtime, the built gateway, the built dashboard (Next.js standalone output), a small supervisor/launcher, and a data folder under `%ProgramData%`; one Start-menu entry opens the dashboard. Customer data is separate from the program folder and is never touched by upgrades or uninstall unless the customer chooses.
- This needs, on a build machine: an installer toolchain (Inno Setup or WiX) and a Node single-executable or portable runtime. Whether those are installed on this PC has not been checked.

## Implementation stages

1. **Stage A — gateway foundations** (touches the gateway, so one reload): health model and `/health` liveness, persistent alert store and history, failure diagnostics saved per call, network diagnostics service (idle-only, through the existing AT queue), disk monitoring, structured file logs with rotation, backup/restore, support bundle, auth-failure rate limiting and security headers, non-breaking dependency fixes.
2. **Stage B — dashboard**: alert centre (banner, history, details, acknowledge), health page, connection-loss/stale handling, network diagnostics panel, backup and support-bundle controls.
3. **Stage C — packaging**: data directory relocation (`DATA_DIR`), supervisor with bounded restarts and crash-loop detection, installer build, first-run wizard, versioning.
4. **Stage D — verification**: automated tests, failure simulation in software, a written list of tests that still need the physical modem.

The voice pipeline (AT communication, PCM, buffers, pacing, STT/TTS, LLM lifecycle, barge-in, recording capture, call termination) is not part of any stage. The only place a stage touches modem code is reading the failure facts already available at call end (Stage A); that is additive and will be explained before it is made.

---

## Implementation status (end of this pass)

Implemented and tested in software (see the final report for numbers):

| Audit item | Status |
|---|---|
| P0-2 body-parser, qs, postcss advisories | **fixed** with non-breaking updates (`npm audit` now reports 4: Next.js, postcss inside Next.js, uuid, zod, all needing major upgrades) |
| P0-3 data inside the program folder | **fixed for the packaged product** (data folder `%ProgramData%\SimGateway`, set by the supervisor). The development install on this PC still uses `packages/gateway/data`; nothing was moved |
| P0-4 backup and restore | **done**: online backup with integrity check, daily automatic backup while idle, staged restore applied at start, nothing deleted |
| P0-5 key in the browser bundle | **mitigated for the packaged product**: no key in any bundle; a loopback-only route hands the generated key to the local browser once. The dashboard still keeps the key in `localStorage` after that |
| P1-1 supervisor | **done** (bounded restarts, crash-loop detection, single instance). Graceful gateway stop needs one gateway edit, pending approval |
| P1-2 liveness | **done**: `GET /health`, no key, no data |
| P1-3 health model | **done**: gateway, modem, SIM/network, AI providers, database, storage/recordings, background jobs |
| P1-4 alerts | **done**: de-duplicated, severity, component, time, action, acknowledge/dismiss, history, auto-resolve |
| P1-5 logs | **done**: JSON lines, rotation by size, retention by age, redacted |
| P1-6 call failure diagnostics | **done** in software; `AT+CEER` is only asked after a call that did not complete, through the modem queue, only when no call exists. **Unproven on real hardware** |
| P1-7 disk space | **done**: warning at 2 GB, error at 500 MB, critical at 100 MB |
| P1-8 install path | **partly**: package assembly and supervisor verified; installer **not compiled** |
| P2 rate limiting, security headers, support bundle, setup wizard, version/compatibility | **done** |
| P2 `AT+CGREG?` | **done** (added to the network reading); `AT+CLCC` is **not** used |

Found while testing the live configuration (not changed, because it is your `.env`):
- `HOST=0.0.0.0` makes the gateway answer on every network interface (the code default is `127.0.0.1`). The API key is still required, and failed keys are now rate limited, but anything on the LAN can reach the port.
- `AUDIO_ENABLE_RAW_DUMP` is on and "unbounded": `packages/gateway/audio-dumps` was already 133 MB.

Still open (blockers for a commercial release): see the final report.
