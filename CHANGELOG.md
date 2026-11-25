# Changelog

All notable changes to this project are documented here.

## 0.1.1 - 2026-11-25

- Read the Antigravity (`agy`) OAuth session from the macOS Keychain and the Linux Secret Service. Both use service `gemini` and account `antigravity`.
- Prefer that session over `~/.gemini/oauth_creds.json`. The Gemini CLI OAuth client can list models and still receive HTTP 403 from consumer Code Assist.
- Do not refresh the Antigravity refresh token with the Gemini CLI OAuth client. That refresh returns `unauthorized_client`. Near expiry, run `agy models` and read the keyring again. Proxy credentials copied from the keyring contain only the access token.
- `prepare` now builds TypeScript so a GitHub install exposes `dist/cli.js`.

## 0.1.0 - 2026-08-04

- Added the Gemini OAuth-backed OpenAI-compatible local proxy and CLI daemon.
- Added strict request validation and a 10 MiB default request-body limit.
- Added safe OAuth callback state/error handling and token response validation.
- Added tool-call name/finish-reason conversion and stable streaming call IDs.
- Added SSE fragmentation, backpressure, cancellation, and malformed-event handling.
- Added daemon process identity checks, startup locking, and health-based readiness.
- Added Node test coverage, publish-safe npm metadata, and package documentation.
