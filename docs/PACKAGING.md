# Packaging, installation and updates

## Decision: one Windows installer. No Docker image.

The product's value is a physical SIM7600 modem on the customer's PC. Windows reaches its COM ports and USB audio directly. Docker Desktop on Windows runs Linux containers inside a WSL2 virtual machine, and a Windows COM port or USB audio device is not visible there. The only route is forwarding USB devices into WSL2 with `usbipd-win`: a separate driver, an administrator command for every plug-in, and it breaks whenever Windows re-enumerates the modem (which this project already handles with automatic port discovery). It would also sit in the middle of the audio path, the most timing-sensitive part of the product.

Docker was **not built and not tested** here. This is a judgement from how Docker Desktop and the modem work, not a measurement. If a Linux host with a USB-serial modem ever becomes a target, that is a separate evaluation.

## The actual architecture (checked in the code, not assumed)

Everything the product runs is **TypeScript on Node.js**. There is **no Python** in it: the repository has no `.py` file, no `requirements.txt` and no `pyproject.toml`, and nothing in the gateway or dashboard source starts Python. Python appears only in the documentation, as the *reference* project (`labs-sizh-voicely`, a Python/LiveKit service) that the AI agent was ported from. A test now fails if a Python file, a Python runtime or a driver file ever appears in the repository.

| Process | Entry point | What it is |
|---|---|---|
| Gateway (includes the **AI voice agent**) | `packages/gateway/src/index.ts` (`tsx watch` in development, `dist/index.js` when built) | Express + Socket.IO API, modem and audio adapters, call manager, campaigns, IVR, and the TypeScript AI agent (`src/ai/*`: orchestrator, runtime, providers for speech-to-text, language model and text-to-speech). The agent runs **inside the gateway process**; it is not a separate program. |
| Dashboard | `packages/dashboard` (Next.js; a self-contained server in the package) | The web interface. |
| Supervisor (customer package only) | `gateway/dist/supervisor/main.js` | Starts and watches the two above. |

Runtime dependencies of the gateway (production only): `express`, `cors`, `socket.io`, `zod`, `dotenv`, `uuid`, and two with native Windows code, `better-sqlite3` (the database) and `serialport` (the COM ports); plus `@sim-gateway/shared`. The only program the gateway launches is Windows' own `tasklist` (a stale-lock check). Development scripts `ai-loop.ts` and `usb-pcm-inspect.ts` are not part of the product.

**Included in the package:** the bundled `node.exe`, the built gateway and its production dependencies, the built dashboard server, the supervisor, the launcher scripts and the modem/driver check.
**Not included, on purpose:** a modem driver (below), the Microsoft Visual C++ runtime (the check script reports it if missing), Python, `.env` files, keys, databases, recordings.

## The modem driver is NOT included

What was established, from this PC's installed driver and from the web:

| Question | Answer |
|---|---|
| Hardware IDs | The installed package matches `USB\VID_1E0E&PID_9001` interfaces `MI_00`…`MI_05` (diagnostics, NMEA, **AT = MI_02**, modem, **audio = MI_04**, WWAN). Its INFs also list many other SIMCom product IDs. |
| Architecture and Windows | The INFs declare `NTamd64` (and `NTx86`, `NTarm`, `NTia64` in one) and, for two of them, Windows 10.0 sections. This PC is Windows 11 64-bit. SIMCom's product page lists "Microsoft Windows 7/8/10" for the USB driver; **Windows 11 is not listed there**. |
| Signature | The installed catalogs (`qcser.cat`, `qcfilter.cat`, `qcwwan.cat`) are valid and carry a timestamp, signed by "Microsoft Windows Hardware Compatibility Publisher". Version 2.1.3.8 / 1.0.6.1 / 4.0.6.1, dated 2019-11-20, provider "Qualcomm". |
| Redistribution permission | **Not established.** The only license text in the installed package is "Copyright (c) 2018 Qualcomm Technologies, Inc. All rights reserved." There is no license or readme file. SIMCom's product page and download center show no driver license or terms, and no driver download link. |

Because permission to redistribute could not be verified, **no driver is bundled** and the installer never downloads one. It runs a guided check instead.

**The link you supplied** (`waveshare.com/wiki/File:SIMCOM_Windows_USB_Drivers_V1.0.2.zip`) was examined, never installed:
- It is a reseller's wiki upload (uploader "Eng26", July 2022, 1.72 MB), not SIMCom's site. The page has no description, license, redistribution terms or signing notes.
- The zip holds one file: an **NSIS installer for 32-bit Windows** (`SIMCOM_Windows_USB_Drivers_V1.0.2.exe`, SHA-256 `79A924E7254D4C98…`; the zip's is `298f145261309daf55fb65c6201b1f8740c520c9792965afafbe4c7fb2489a01`).
- That installer is **not digitally signed**, has **no version or publisher metadata** and contains no readable license text.
- Its driver files (hardware IDs, architecture, catalog signatures) could **not** be inspected, because that needs 7-Zip or running the installer; neither was done.
- So it fails the "signed" and "redistribution permitted" checks for use inside this product. It is not referenced by the installer or by the product's messages. A customer may still choose to use it, at their own judgement; check that its SHA-256 matches the value above, and that Windows then shows the signed drivers listed in the table.

**What the product does instead.** After installing, and on demand from the Start menu ("Check the modem and driver"), `check-modem-driver.ps1` asks Windows (never the modem) whether: a SIM7600 is on USB; every one of its interfaces has a working driver; the **AT port (MI_02)** and the **USB audio port (MI_04)** both appear as COM ports; the drivers are signed; and the Visual C++ runtime is present. If not, it says which, and points to SIMCom or the modem's seller for the official driver. It cannot prove audio works: only a real call does.

## What the installer puts where

| Where | What | Replaced by an update? |
|---|---|---|
| `C:\Program Files\SimGateway\` | the program: bundled `node.exe`, gateway, dashboard (self-contained Next.js server), production dependencies, the launcher | yes |
| `C:\ProgramData\SimGateway\` | **customer data**: `gateway.sqlite`, `recordings\`, `audio-dumps\`, `logs\`, `backups\`, `registry\`, `ivr\`, `config\gateway.env`, `first-run.done` | **never** |

The data folder is writable by **every Windows user** of the PC (`Users: Modify`). The product runs as whoever clicks the icon, a normal non-administrator included, so it has to be. The trade-off: any local Windows user can read the configuration (it holds the API key) and the recordings. The product is meant for a PC dedicated to it; the gateway listens on `127.0.0.1` only by default.

The installer does not contain a `.env` file, an API key, a database or a recording. The build script (`installer\build-package.ps1`) stops if it finds one. The development `.env` is not read by the packaged product (the supervisor passes every setting in explicitly).

## What the icon does (one click)

The Start-menu and desktop icons run `wscript.exe //B //Nologo SimGateway.js`: a 40-line stub that runs the **bundled** Node on `gateway\dist\supervisor\launch.js` with no console window. The customer types nothing and installs nothing. `launch.js`:

1. checks that the data folder can be written (if not: says so, starts nothing);
2. asks the supervisor's status page whether a copy is already running. If so, it starts nothing and only waits (a second click never starts a second copy; two quick clicks are handled too);
3. otherwise checks that ports 3000 (dashboard), 4000 (gateway) and 4010 (status) are free, and if one is taken says which program holds it;
4. starts the supervisor in the background;
5. waits until **both** the gateway (`/health` says ok) **and** the dashboard answer, showing a small "Starting SIM Gateway…" window meanwhile;
6. **only then** opens the browser: the **Setup** page the first time, the dashboard afterwards;
7. if anything fails (the supervisor ends at once, a service crash-loops, 2 minutes pass) it shows a message with the last log lines and offers to open the log folder, `C:\ProgramData\SimGateway\logs`. It never opens a dead page.

At Windows sign-in the same launcher runs with `--no-browser` (nothing opens, errors go to the log). "Stop SIM Gateway" runs `launch.js --stop`: it refuses while a call is in progress, and otherwise asks the supervisor to stop through a token-protected local request; the gateway then finishes its own graceful shutdown (the supervisor starts it through `gateway-entry.js`, which answers the supervisor's shutdown message).

The supervisor (`gateway\dist\supervisor\main.js`):
- creates `config\gateway.env` on first start with a new random API key (never overwritten afterwards, so an upgrade keeps it);
- refuses a second copy (lock file; exit code 3), so two gateways can never open the modem's COM ports;
- restarts a crashed service after 1, 2, 4, 8, 16, 30, 60 seconds; after 5 crashes in 10 minutes it stops trying, marks the service failed ("crash loop") and says so on `http://127.0.0.1:4010/status`;
- never restarts a service that is only slow: a gateway that does not answer `/health` is stopped only after 3 minutes of silence;
- never sends a command to the modem.

Windows' own PowerShell is still used, invisibly, for two courtesy windows (the starting window and the error message box) and for the install-time driver check. The customer types no command. If PowerShell is blocked on a PC, those windows do not appear; the problem is still written to the log.

### Why the first installer showed ERR_CONNECTION_REFUSED

Two defects, one of which was reproduced:

1. **The data folder was locked to Administrators and SYSTEM.** A normal (non-elevated) user, which is who clicks an icon, could not write there, so the supervisor failed on its very first file (`EPERM` on `supervisor.lock`) and exited; nothing was left listening. This was reproduced in an isolated folder with the same permissions. It was not observed on the customer's clean PC itself, so it is the most likely cause, not a proven one.
2. **The icon opened the browser without waiting for anything.** Its launcher only waited a few seconds for the supervisor's own status page (never for the dashboard to listen) and then opened `http://127.0.0.1:3000` whether or not anything had started. Even a healthy start can take a few seconds, so a click could show a refused connection.

Both are fixed above. Also fixed: the packaging build used to rewrite `packages\shared\dist`, which a running development gateway imports, so building the installer restarted it. The build now compiles into `installer\stage\_build`, never writes to the development folders, and fails if `packages\shared\dist` changes.

## API keys: added in the dashboard, never in a file

The customer adds, updates and removes provider API keys on the **AI Agent → API Keys** page. Each provider shows **Configured** or **Not configured** (or **Saved key unreadable**, below), and a saved key is never shown again, not even its last characters. The customer never edits `.env`, runs a command or touches a gateway file.

**How the encryption key is provided.** Saved keys are encrypted in the database (AES-256-GCM, a key derived from a master key with scrypt and a per-value salt) by code that already existed; it reads the master key from the `AI_SECRETS_MASTER_KEY` variable when the gateway starts. In the installed product the **supervisor** provides it, so the gateway code did not change:

- On the first start it makes a random 256-bit key and saves it as `C:\ProgramData\SimGatewaySecrets\master.key`. This folder is outside the data folder on purpose: the installer repairs permissions on the data folder recursively and must never touch this file.
- The file is created with exclusive-create, and its permissions are restricted **before** the key is written, to the Windows user who made it and SYSTEM only (no inheritance; administrators and other users are not listed, though an administrator can still take ownership, as Windows always allows). If the permissions cannot be restricted, no key is made at all.
- On every later start, and on every upgrade, the same file is read and the same key is given to the gateway before it builds its encrypted store. It is **never regenerated**.
- A key already set in the environment (the development `.env`) or in `config\gateway.env` is respected and nothing is generated, so development works as before. A too-short configured value is reported and not passed on (the gateway would otherwise refuse to start).
- The Google Sheets service-account key is stored under the same master key.

**When the key file cannot be used, nothing is replaced.** The supervisor reports the state on its local status page, the dashboard shows it with what to do (never an instruction to edit a file), and the gateway starts without key storage:

| State | Meaning | What the customer is told |
|---|---|---|
| key file missing, but keys were saved earlier | a new key would orphan them | restore the file from a backup, or reset |
| key file unreadable | for example it belongs to another Windows user | sign in as the user who first started SIM Gateway, or restore it; do not delete it |
| key file damaged | wrong format or empty | restore from a backup, or reset |
| could not restrict permissions / could not create | the disk or folder rights | run the installer again |

The only way to replace a key is the Start-menu item **Reset saved API keys**. It asks first (default No), refuses during a call, renames the old key file to `master.key.replaced-<time>` (never deleted), makes a new key and starts SIM Gateway; the saved keys can then no longer be read and are entered again.

**Limits to know.** The key file is readable only by the Windows user who first started the product, so a different Windows user on the same PC sees "cannot read" until they sign in as that user. The key is not part of the database backup (so a copied database cannot be opened by whoever copies it); moving a database to another PC means entering the keys again there. Uninstalling keeps the key unless the customer also chooses to delete their data. The API still sends the last four characters of a saved key; the dashboard does not display them (removing that needs a gateway change, which would restart a running development gateway, so it has not been made).

## Hardware requirements for a customer

- Windows 10 or 11, 64-bit; about 600 MB of disk for the program plus room for recordings (about 1 MB per minute of call, see retention in Settings).
- A SIMCom SIM7600EI on USB with its Windows driver (Windows usually installs it by itself; the Hardware page lists the COM ports it finds).
- A SIM with voice service, an antenna with signal, and internet for the AI providers.
- The customer's own keys for the AI services they choose (entered on the AI Agent page; stored encrypted, never shown again).

## Customer installation and first launch

1. Run `SimGateway-Setup-<version>.exe` (administrator approval is asked once). It stops any older copy safely first (and refuses while a call is in progress), copies the database aside, repairs the data folder permissions, and installs.
2. Plug in the modem. Tick "Start SIM Gateway automatically when I sign in" if wanted. The installer checks the modem driver (read only) and explains anything missing.
3. Finish with "Start SIM Gateway now". It starts as the user who ran the installer, the same way the icon does, and the browser opens on the **Setup** page once both services are ready.
4. **Setup** lists, in order: application health, gateway, database and storage, modem, COM ports, audio, SIM, mobile network, AI providers, AI credentials, and whether a test call can be made. Each step that is not done says what to do.
5. On **AI Agent → API Keys**, add the provider keys and use the test buttons. Keys are stored encrypted and never shown again; nobody edits a file.
6. When Setup says **Ready**, place a test call yourself from the **Dialer** to your own number. Setup never places a call.

## Updates, rollback and uninstall

- **Upgrade in place:** run the newer setup program over the old one (same application id). The old copy is stopped cleanly (the launcher's stop, or for an installation made by the first installer, the stop script it came with), the database is copied to `backups\pre-update-<version>-<time>.sqlite`, program files are replaced, old launcher files are removed, the data folder permissions are repaired (including files already in it), and **nothing in `C:\ProgramData\SimGateway` is deleted or overwritten**. Database changes are additive migrations applied at start; a database from a newer version is refused.
- **Upgrading the existing test installation (0.1.0 → 0.1.1):** just run `SimGateway-Setup-0.1.1.exe` on that PC. If the old install never managed to start, nothing is running and nothing needs stopping. Its data folder (created with the restrictive permissions) is repaired by the installer, and any configuration it already created (`config\gateway.env`, with its API key) is kept. If a call were in progress the installer would refuse and ask you to end it. To be extra careful, first copy `C:\ProgramData\SimGateway` somewhere safe; the installer does not need that, it is only a precaution.
- **Rollback:** reinstall the previous setup program, then (only if the data has to go back too) use **System health → Backups → Restore**. A restore is staged and applied at the next start, and the data it replaces is kept as `pre-restore-<time>.sqlite`.
- **Uninstall** removes the program and the start-at-sign-in task, after stopping the product. It asks whether to delete the data; the default answer is **No, keep it**.
- The dashboard and the gateway report an API version. A mismatch is shown on the System health page.

## Build

On a Windows build machine with Node and Inno Setup 7 (or 6.3+): `powershell -File installer\build-package.ps1`. It does not touch the development folders, a running development gateway or its dependencies. Without Inno Setup the script still assembles `installer\stage\app` (add `-SkipInstaller`) and says so. The result is `installer\out\SimGateway-Setup-<version>.exe`; the version comes from the root `package.json`.

## Verification status (be honest about it)

| Item | Status |
|---|---|
| Package folder assembled; no `.env`, key, database, recording, driver or Python inside; every entry point the launcher needs exists | **verified** (build script checks, every build) |
| Packaged program started from the bundled Node (mock modem, isolated ports): both services healthy in about 2 seconds, setup page chosen first time | **verified** on this PC, as an automated test (`tests/packaged-startup.e2e.test.ts`, needs the built package folder) |
| A second click reuses the running copy; two quick clicks are handled | **verified** (end-to-end and unit tests) |
| Clean stop: the gateway finishes by itself, nothing left listening | **verified** end to end (the dashboard is force-stopped after 2 seconds because it keeps no state) |
| Port in use, unwritable data folder, gateway crash loop: plain message, log tail, no dead page | **verified** end to end and in unit tests |
| Building the package leaves a running development gateway alone | **verified**: PID and uptime unchanged across two builds |
| The reproduced permission failure of the first installer | **reproduced** in an isolated folder; its fix is in the installer script (not run) |
| Inno Setup script **compiles** (Inno Setup 7.1.1) | **verified** |
| The installer **run**: install, shortcuts, post-install start as the original user, auto-start task, upgrade over 0.1.0, uninstall and the data choice | **not verified**: needs a clean Windows PC |
| Master key created once, protected to the current user and SYSTEM (real Windows permissions checked), never regenerated or overwritten, every bad state reported | **verified** by tests (`tests/master-key.test.ts`) |
| Add / update / remove a key through the real gateway API; survives restarts; unreadable after a replaced key; nothing in responses, logs or the database file in plaintext | **verified** by tests (`tests/api-key-workflow.test.ts`) |
| The installed product doing the above on a clean PC, and the Start-menu reset | **not verified** (the installer has not been rebuilt or run since this change) |
| Real modem under the packaged build; audio on a real call | **not verified** (needs the physical hardware and your approval) |
| Modem driver check on this PC: AT port COM20 and audio port COM19 found, all drivers signed | **verified** (read only; no COM port opened) |
| The same check for no modem, missing driver, no AT port, no audio port, unsigned driver, missing runtime | **verified** with saved descriptions |
| Any driver bundled in the package | **none** |
| Official SIMCom driver download location and redistribution license | **not found / not verified** |
| Whether the bundled `node.exe` needs the Visual C++ runtime on a clean PC | **not verified** (the icon stub and the driver check both explain it if it is missing) |
| The installer is code-signed | **no**: Windows SmartScreen will warn |
| A clean customer PC without Node or development tools (no Python is used anywhere) | **not verified** |
