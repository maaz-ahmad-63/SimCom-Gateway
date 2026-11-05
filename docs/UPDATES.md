# Automatic updates

Status: implemented and unit-tested. **Not yet proven by a real update between two packaged versions** (see "What is not proven").

## Publisher (release machine, not customers)
1. `node tools/release/release.mjs keygen --key <file outside the repo> --public installer/update/public-key.pem` (once). Back the private key up offline. Commit only the public key.
2. Build the package (`installer/build-package.ps1`), then `node tools/release/release.mjs publish --key <file> --app installer/stage/app --base-url https://<host>/<dir>/ --out <folder outside the repo>`.
3. Upload the zip, then `latest.json` and `latest.json.sig` to the base URL.

## Customer installation
- Set the address in `config\gateway.env` as `UPDATE_URL=https://<host>/<dir>/latest.json` (or the `SIMGW_UPDATE_URL` environment variable). Without an address or without `update\public-key.pem` in the program folder the dashboard says updates are not set up.
- The installation must be in a folder the Windows user can write next to (for example under `%LOCALAPPDATA%\Programs`). In `Program Files` the dashboard explains that the newer installer is needed once.

## Flow
dashboard (Settings > Software updates, banner) → `/api/update*` (loopback, same-origin, dashboard header) → supervisor `127.0.0.1:4010/update*` (token file) →
`check`: fetch `latest.json` + `.sig` over https, verify Ed25519 signature with the pinned public key, product id, expiry, version newer, minimum version.
`apply`: refuse during a call (or when it cannot tell) → download (https only, size capped) → SHA-256 + size equal to the signed manifest → list archive entries and refuse
unsafe ones (`..`, drive paths, config, `.env`, sqlite, keys, unknown top-level names) → extract to `<app>.new` → require a complete program of the announced version →
copy runner + node.exe to `<data>\updates\runner` → start it detached → supervisor stops the dashboard and gateway cleanly and exits.
runner: wait for the supervisor to exit → `<app>` → `<app>.backup`, `<app>.new` → `<app>` → start the new program → healthy only if the supervisor reports the new version and
the gateway `/health` and the dashboard answer → otherwise stop it, put `<app>.backup` back, start the old program, record why. Result in `<data>\updates\result.json`, shown in the dashboard.

Customer data (database, recordings, `config\gateway.env`, prompts stored in the database, the encryption key under `SimGatewaySecrets`) is outside the program folder and never in a package.

## What is not proven
- A real update from one packaged version to another on a clean machine (needs two installers, a signing key and an https host).
- The runner restarting the product through the real Windows process tree (unit tests use fakes for process start and health).
