# Automatic updates (GitHub Releases)

Status: implemented and tested end to end on Windows with a throwaway key and a local https server (`tools/update-test/e2e.mjs`: 60 checks —
failed update undone, update A→B, crash in the window between the two folder renames repaired, unconfirmed new version undone, customer data and
encrypted keys intact, no administrator rights). **No real release has been published, no production signing key exists and nothing has been
tested against github.com itself.** The GitHub behaviour (redirects to asset storage, 404 before the first release) is exercised with a scripted
fetch in `tests/updater-github.test.ts`.

## How a customer's copy finds an update
1. The product fetches `latest.json` and `latest.json.sig` from the configured update address, following redirects **by hand, https only**.
2. It verifies the Ed25519 signature with the public key bundled at `update\public-key.pem`, then the product id, expiry, version newer than the
   installed one, and the minimum version.
3. On **Update now** (never during a call): it downloads the ZIP named in the signed manifest, checks size and SHA-256 against the manifest,
   refuses unsafe archive entries, stages `<app>.new`, and hands over to a runner that swaps folders, checks health and rolls back on failure.
   An interrupted swap is repaired by the start guard (`installer\guard\SimGatewayStart.js`) the next time the product starts.

Customer data (database, recordings, `config\gateway.env`, prompts, the encryption key) lives outside the program folder and is never in a package.

## Configure the address (not baked in)
In `config\gateway.env` (or the `SIMGW_UPDATE_URL` environment variable):

```
UPDATE_URL=https://github.com/<owner>/<repo>/releases/latest/download/latest.json
```

`releases/latest/download/<asset>` always resolves to the newest **published, non-draft, non-pre-release** release, so a draft or a pre-release is
never offered to customers. The signature is fetched from the same address plus `.sig`. The packaged default is a commented placeholder; no
production address is assumed.

> The release repository must be **public** (or the assets otherwise reachable without a login). GitHub does not serve a private repository's
> release assets to anonymous clients, and the product deliberately sends no credentials. If the source repository is private, publish releases to
> a separate public repository (for example `<owner>/sizh-releases`) and use that in `UPDATE_URL`.

## Publishing a release (exact workflow)
One time, on the release machine (never on a customer machine, never inside the repository):
```
node tools/release/release.mjs keygen --key "%USERPROFILE%\SIZH-release\update-signing.key" --public installer\update\public-key.pem
```
Back the private key up offline. Commit **only** `installer\update\public-key.pem`. The tool refuses a key path inside the repository, and
`.gitignore` blocks `*.key`. Losing the key means installed copies can never be updated again; leaking it lets anyone ship code to every customer.

For each release:
1. Raise the version in the root `package.json` (for example `0.2.0`; it must be higher than every installed version).
2. Build the program folder: `powershell -File installer\build-package.ps1 -SkipInstaller` (the first customer release also needs the setup program).
3. Sign and package, writing outside the repository:
   ```
   node tools/release/release.mjs publish --key "%USERPROFILE%\SIZH-release\update-signing.key" --app installer\stage\app ^
        --github <owner>/<repo> --out "%USERPROFILE%\SIZH-release\0.2.0" --notes "What changed, in a sentence"
   ```
   This writes `SIZH-IT-Solution-0.2.0.zip`, `latest.json` and `latest.json.sig` and **uploads nothing**. The manifest points at
   `https://github.com/<owner>/<repo>/releases/download/v0.2.0/SIZH-IT-Solution-0.2.0.zip`.
4. Stage a **draft** release with the three assets (the tool prints this command; draft releases are invisible to customers):
   ```
   gh release create v0.2.0 --repo <owner>/<repo> --draft --title "SIZH IT Solution 0.2.0" --notes-file notes.md ^
        "%USERPROFILE%\SIZH-release\0.2.0\SIZH-IT-Solution-0.2.0.zip" "%USERPROFILE%\SIZH-release\0.2.0\latest.json" "%USERPROFILE%\SIZH-release\0.2.0\latest.json.sig"
   ```
   The three asset names must be exactly those: the product asks for `latest.json` and `latest.json.sig`.
5. Publish only when you intend every customer to receive it (this is the moment `releases/latest` moves):
   `gh release edit v0.2.0 --repo <owner>/<repo> --draft=false --latest`
6. Confirm the public copy the way a customer's copy will read it:
   `node tools/release/release.mjs verify --url https://github.com/<owner>/<repo>/releases/latest/download/latest.json --public installer\update\public-key.pem`
7. Do not delete or replace assets of a published release; publish a new, higher version instead. To withdraw a bad release, mark it
   pre-release or delete the release so `latest` falls back (installed copies that already updated stay on that version; ship a higher fixed one).

Manifests expire (`--days`, default 365): publish at least once a year, or pass a longer `--days`.

## What is not proven yet
- A real update against github.com (redirect hosts, rate limiting). A draft release is not reachable anonymously, so this needs a throwaway public
  test repository (or a published release) before the first customer release.
- A clean-machine run of the per-user installer (`installer\SimGateway.iss` compiles with Inno Setup 7.1.1 but has not been run).
- A setup program that already contains `update\public-key.pem` — the key does not exist yet, so packages built now cannot verify updates.
