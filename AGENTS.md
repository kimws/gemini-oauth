# gemini-oauth agent notes

This proxy is unofficial. It exposes a loopback OpenAI-compatible API for a Gemini CLI / Antigravity OAuth session. Do not log, print, commit, or copy credential files.

## Which session to use

`agy` stores the working consumer session in the OS keyring. `~/.gemini/oauth_creds.json` is a different Gemini CLI OAuth client. `/v1/models` can succeed with that file while `/v1/chat/completions` returns HTTP 403 `PERMISSION_DENIED`.

Prefer the keyring session when it is present and unexpired.

| Platform | Store | Item |
| --- | --- | --- |
| macOS | Keychain (`/usr/bin/security find-generic-password`) | service `gemini`, account `antigravity` |
| Linux | Secret Service (`secret-tool` or `gi.repository.Secret`) | attributes `service=gemini`, `username=antigravity` |

macOS stores `<prefix>:<base64 json>`. Linux stores raw JSON:

```json
{ "token": { "access_token": "...", "refresh_token": "...", "token_type": "Bearer", "expiry": "2026-11-25T02:02:35.811Z" } }
```

Parser: `src/antigravity-keyring.ts`. A flat `{ "access_token": "..." }` object is also accepted.

## Refresh

Do not send the Antigravity refresh token to the Gemini CLI OAuth client inside this package. That client returns `unauthorized_client`.

When the keyring access token is near expiry or an upstream call returns 401, run `agy models` as the same OS user and read the keyring again. `agy` rewrites the keyring item. The session object passed to the proxy omits `refresh_token`.

Consumer Antigravity accounts must call Code Assist with project `default-cli-project`. A cached GCP project id often returns HTTP 403.

## Checked model behavior

The static `/v1/models` allowlist is not proof that Code Assist accepts the id. On the checked consumer account, `gemini-3.1-flash-lite` and `gemini-2.5-flash` returned Korean text. `gemini-3.6-flash-low` was listed and then returned HTTP 404 `NOT_FOUND`.

## Install

`npm install github:kimws/gemini-oauth` runs `prepare`, which builds `dist/`. Keep the process bound to `127.0.0.1`. `gemini-oauth logout` does not delete the keyring item.
