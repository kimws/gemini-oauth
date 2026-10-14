# gemini-oauth

**Gemini CLI OAuth → local OpenAI-compatible API**

[한국어 문서](README.ko.md)

gemini-oauth is an unofficial local proxy that reuses an authenticated Gemini CLI / Google Code Assist OAuth session and exposes a small OpenAI-compatible API for local clients. It is useful when a tool already speaks the OpenAI Chat Completions API but you want requests to use an eligible Google account's Gemini CLI / Code Assist access instead of an API key.

```
$ gemini-oauth --detach --port 18080

Gemini OAuth proxy started in background
  url: http://127.0.0.1:18080/v1
```

> **Unofficial project.** This project is not affiliated with, sponsored by, or endorsed by Google LLC, Gemini, Gemini CLI, or Antigravity. Read the legal and licensing notes before using it.

## What the project does

Gemini CLI normally stores a Google OAuth session in ~/.gemini/oauth_creds.json. This project:

1. reads that session, or a supported Antigravity macOS keychain session;
2. refreshes an OAuth access token when it is close to expiry;
3. resolves or uses a Cloud Code Assist project ID;
4. converts OpenAI-style messages, tools, images, and generation settings into the Code Assist request format;
5. calls the Code Assist private upstream endpoint; and
6. converts the result back to OpenAI Chat Completions or a minimal Responses-shaped result.

The proxy is local and stateless: the client must send the conversation history with every request. No hosted service, database, or separate GEMINI_API_KEY is required.

### Main capabilities

- Browser OAuth login with PKCE, plus a headless/device-style flow for SSH sessions.
- Reuse of an existing official Gemini CLI login.
- Automatic access-token refresh and one retry after an upstream 401.
- Foreground mode or a detached background daemon with status, logs, and stop commands.
- OpenAI-compatible chat/completions with non-streaming and SSE streaming responses.
- Minimal /v1/responses compatibility for non-streaming requests.
- Function/tool-call conversion and data-URL image input conversion.
- Configurable model allowlist, port, host, auth file, and Code Assist project.
- Request validation and a default 10 MiB JSON request-body limit.
- TypeScript library exports for embedding the auth store, upstream client, and HTTP server.

The default upstream is the Code Assist private API at https://daily-cloudcode-pa.googleapis.com/v1internal. Enterprise and corporate Code Assist subscriptions are provisioned on the production endpoint (https://cloudcode-pa.googleapis.com/v1internal), which can be selected via `--url` or the `CODE_ASSIST_URL` environment variable. It is not the public Gemini API and it has no stability guarantee from this project.

## Requirements

- Node.js 20 or newer.
- An eligible Google account with Gemini CLI / Code Assist access.
- An existing official Gemini CLI login, or the gemini-oauth login flow.
- curl is useful for smoke testing; jq and Python are optional helpers.

The official Gemini CLI is not installed by this package. Install it separately if you want to authenticate with gemini first.

## Installation

The package is not currently published to the npm registry. Install it from source:

```bash
git clone https://github.com/kimws/gemini-oauth.git
cd gemini-oauth
npm ci
```

### Install the CLI globally

The global-install script builds the TypeScript sources and installs the package:

```bash
npm run install:global

# Equivalent commands:
npm run build
npm install -g .
```

If the npm global directory is not writable, configure a user-owned npm prefix or use the local commands below. The proxy itself does not need root privileges.

### Create and install a local package tarball

```bash
npm ci
npm pack
npm install -g ./gemini-oauth-0.1.0.tgz
```

The generated filename contains the version from package.json.

## Authentication

### Reuse an existing Gemini CLI session

If the official Gemini CLI is already signed in, no second login is normally needed:

```bash
gemini-oauth status
gemini-oauth --detach
```

The default credentials file is ~/.gemini/oauth_creds.json.

### Sign in with this CLI

Browser-based loopback OAuth:

```bash
gemini-oauth login
```

SSH or headless environment:

```bash
gemini-oauth login --device
```

Print the authorization URL without opening a browser:

```bash
gemini-oauth login --no-open
```

The login flow uses OAuth with PKCE, saves credentials to the Gemini CLI-compatible file, and attempts to resolve the Code Assist project. If automatic project resolution is unavailable, set a project explicitly as described below.

On macOS, the library also checks for an Antigravity session in the OS keychain by default. gemini-oauth logout does not remove that session; manage it with the corresponding Antigravity tooling.

## Running the proxy

### Foreground

```bash
npm start
# or, after building:
node dist/cli.js --port 18080
```

### Background daemon

```bash
gemini-oauth --detach
gemini-oauth --detach --port 18080
```

Manage the daemon with:

```bash
gemini-oauth status
gemini-oauth logs --follow
gemini-oauth stop
```

The default base URL is http://127.0.0.1:10551/v1. A custom port changes the base URL; use the URL printed at startup or by status.

### CLI options

| Option | Default | Description |
| --- | --- | --- |
| --host <host> | 127.0.0.1 | Bind address. Non-loopback addresses require --allow-remote. |
| --allow-remote | off | Acknowledge the risk of exposing an unauthenticated proxy. This does not add API authentication. |
| --port <port> | 10551 | Listening port. GEMINI_OAUTH_PORT can also set the default. |
| --auth-file <path> | ~/.gemini/oauth_creds.json | Gemini CLI-compatible OAuth credential file. |
| --project <id> | automatic | Override the Code Assist / GCP project ID. |
| --models <ids> | built-in allowlist | Comma-separated model IDs returned by /v1/models. |
| --url <url> | https://daily-cloudcode-pa.googleapis.com/v1internal | Upstream Code Assist endpoint URL (e.g. production https://cloudcode-pa.googleapis.com/v1internal). |
| --detach, -d | off | Start a background daemon. |
| --device | off | Use the headless login flow. |
| --no-open | off | Do not open a browser during login. |
| --follow, -f | off | Follow the daemon log with logs. |
| --force | off | Allow a second foreground process when intentionally using another port. |

### Project selection

Project resolution follows this order:

1. --project;
2. GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID;
3. a cached project in ~/.gemini/gemini-oauth.json;
4. a project obtained through Code Assist loadCodeAssist / onboardUser.

If the account requires a user-owned GCP project:

```bash
export GOOGLE_CLOUD_PROJECT=my-gcp-project
gemini-oauth --detach

# Or for one invocation:
gemini-oauth --project my-gcp-project --detach
```

The project must be valid for the signed-in account and relevant Google service policies.

## API compatibility

| Method | Path | Support |
| --- | --- | --- |
| GET | / or /health | Local health and basic runtime information. |
| GET | /v1/models | Configured model allowlist; not live model discovery. |
| POST | /v1/chat/completions | OpenAI-style chat requests; streaming is supported. |
| POST | /v1/responses | Minimal Responses-shaped compatibility; non-streaming only. |

Common chat fields include model, messages, stream, temperature, top_p, stop, max_tokens, max_completion_tokens, tools, and tool-call messages. Content arrays support text and data-URL image_url blocks. This is an interoperability subset, not complete OpenAI API parity.

Important behavior:

- /v1/responses with stream: true returns 400 unsupported_parameter; use /v1/chat/completions for SSE.
- /v1/models returns the configured allowlist, not every model available to the account.
- A listed model may still be unavailable to the account or tier; availability and quotas are controlled upstream.
- Request bodies are limited to 10 MiB by default.
- The proxy does not persist prompts, conversation history, or responses. Requests still go to the upstream Google service under its terms and data handling rules.

## Usage examples

Start the proxy first, then choose a model permitted for the signed-in account.

### curl

```bash
export BASE=http://127.0.0.1:10551/v1

curl -sS "$BASE/models"

curl -sS "$BASE/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Reply with exactly: PONG"}],
    "stream": false
  }'
```

Streaming:

```bash
curl -N -sS "$BASE/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Write a haiku about proxies."}],
    "stream": true
  }'
```

### OpenAI Node SDK

```bash
npm install openai
```

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "gemini-oauth", // The local proxy does not validate this value.
  baseURL: "http://127.0.0.1:10551/v1",
});

const result = await client.chat.completions.create({
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: "Hello from Node" }],
});

console.log(result.choices[0]?.message?.content);
```

### OpenAI Python SDK

```bash
python -m pip install openai
```

```python
from openai import OpenAI

client = OpenAI(
    api_key="gemini-oauth",
    base_url="http://127.0.0.1:10551/v1",
)

result = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello from Python"}],
)

print(result.choices[0].message.content)
```

The repository includes equivalent examples in the examples directory: curl.sh, fetch.mjs, openai-sdk.mjs, and openai_python.py.

## Use as a TypeScript library

```ts
import {
  GeminiAuthStore,
  GeminiUpstream,
  startGeminiOAuthServer,
} from "gemini-oauth";

const auth = new GeminiAuthStore();
const server = await startGeminiOAuthServer({
  auth,
  port: 10551,
});

console.log(server.url);

const upstream = new GeminiUpstream({ auth });
const result = await upstream.chatCompletions({
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: "Hello" }],
});

console.log(result);
```

The package exports the auth store, server, upstream client, OAuth login helpers, daemon helpers, project resolution helpers, and TypeScript types. See src/index.ts for the complete export surface.

## Files and credential handling

| Path | Purpose |
| --- | --- |
| ~/.gemini/oauth_creds.json | Gemini CLI-compatible access and refresh tokens; written with restrictive 0600 permissions where supported. |
| ~/.gemini/gemini-oauth.json | Local project ID, account email, and tier cache. |
| ~/.gemini/oauth-proxy/state.json | Detached daemon state. |
| ~/.gemini/oauth-proxy/server.pid | Detached daemon PID. |
| ~/.gemini/oauth-proxy/server.log | Detached daemon log. |

Treat OAuth credentials as passwords. Do not commit, paste, upload, log, share, or resell them. If a credential is exposed, revoke it through the relevant Google account tooling and sign in again.

gemini-oauth logout clears the configured file-based credential and local state. It does not clear an Antigravity OS-keychain session.

## Development and verification

```bash
npm ci
npm run typecheck
npm test
npm run check
npm pack --dry-run
```

npm test builds the project and runs the Node test suite. The tests cover request-size and input validation, OAuth state/error/token handling, project and auth behavior, tool-call conversion, SSE fragmentation and cancellation, Responses streaming rejection, IPv6 URLs, daemon safety, CLI options, and package metadata.

For a live-account smoke test:

```bash
npm run build
node dist/cli.js --detach
./examples/curl.sh
node dist/cli.js stop
```

The smoke test requires a valid account session and a model available to that account. Do not add real credentials or live responses to the repository.

## Limitations and troubleshooting

### No credentials found

Run gemini to sign in with the official CLI, or run gemini-oauth login. Check the selected path with:

```bash
gemini-oauth status
```

### Project resolution fails

The account may require a user-defined GCP project, or the account/tier may not be eligible for Code Assist. Set GOOGLE_CLOUD_PROJECT or pass --project, then retry. The upstream private API can also change independently of this repository.

### The port is already in use

Use gemini-oauth status and gemini-oauth stop, or choose another port with --port. A foreground second instance requires --force and should normally use a different port.

### Remote clients cannot connect

The default host is intentionally 127.0.0.1. If remote access is genuinely required, use --host with --allow-remote and put a properly authenticated, encrypted reverse proxy or private network in front of it. gemini-oauth itself has no API-key or user authentication layer.

## License and legal notes

### This repository's license

The original source code and documentation in this repository are released under the MIT License, copyright © 2026 gemini-oauth contributors. MIT permits use, copying, modification, distribution, sublicensing, and sale of the licensed project code, provided that the copyright and license notice are retained. The software is provided “as is”, without warranty.

The MIT license applies to this repository's material only. It does not grant any right to:

- use Google's names, logos, trademarks, or branding;
- access or redistribute Google accounts, OAuth credentials, Code Assist quotas, or subscriptions;
- treat the Code Assist private endpoint as a public or supported API;
- bypass account, product, rate, safety, or regional restrictions; or
- redistribute another person's credentials or model access.

### Third-party service and account responsibility

This tool interacts with Google OAuth, Gemini CLI / Code Assist services, and possibly Antigravity tooling. Those services have their own terms, acceptable-use rules, privacy policies, product limitations, and account policies, which can change over time. Review the current terms that apply to your account and region before using this proxy, especially if you plan to use a subscription or managed Code Assist entitlement through a third-party client.

You are responsible for:

- using your own authorized account and keeping its credentials private;
- complying with Google's current terms, API/service policies, Gemini CLI / Code Assist rules, organizational policies, and applicable law;
- understanding how prompts, files, images, tool inputs, and outputs are handled by the upstream service;
- paying or monitoring any applicable quota or billing consequences; and
- ensuring that your use and distribution of this software do not imply Google endorsement.

Because the proxy uses a private upstream protocol and compatible client metadata, Google may change or restrict it at any time. This project makes no promise of continued access, model availability, quota, compatibility, or account safety. Use it only where you have confirmed that your use is permitted.

## Disclaimer

This is an unofficial, community-maintained project. It is provided as-is, without warranty or support. The maintainers are not responsible for account suspension, quota consumption, data loss, service changes, or any other consequence of using the software.
