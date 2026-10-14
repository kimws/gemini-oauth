#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GeminiAuthStore } from "./auth.js";
import {
  CODE_ASSIST_BASE,
  DEFAULT_AUTH_FILE,
  DEFAULT_HOST,
  DEFAULT_PORT,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  normalizeBaseUrl,
} from "./constants.js";
import {
  DAEMON_LOG_FILE,
  getRunningDaemon,
  spawnDetachedServer,
  stopDaemon,
} from "./daemon.js";
import { login } from "./oauth-login.js";
import { startGeminiOAuthServer } from "./server.js";

const help = `
${PACKAGE_NAME} v${PACKAGE_VERSION}

Turn your Gemini CLI (Google Code Assist OAuth) session into a local
OpenAI-compatible API — the Gemini analogue of openai-oauth / grok-oauth.

Usage:
  gemini-oauth [serve|start] [options]   Start local OpenAI-compatible proxy
  gemini-oauth stop                      Stop detached background server
  gemini-oauth status [options]          Auth + server process status
  gemini-oauth logs [--follow]           Show detached server log
  gemini-oauth login [options]           Sign in via browser (or device/headless)
  gemini-oauth logout                    Clear stored credentials
  gemini-oauth help                      Show this help

Serve options:
  --host <host>          Bind address (default: ${DEFAULT_HOST})
  --port <port>          Bind port (default: ${DEFAULT_PORT}, or $GEMINI_OAUTH_PORT)
  --auth-file <path>     Path to oauth_creds.json (default: ${DEFAULT_AUTH_FILE})
  --models <ids>         Comma-separated model allowlist
  --project <id>         Override GCP / Code Assist project id
  --url <url>            Upstream Code Assist endpoint URL (default: ${CODE_ASSIST_BASE})
  --detach, -d           Run in background (daemon)
  --foreground           Force foreground (used by daemon child)
  --force                Ignore daemon guard for a foreground second instance
  --allow-remote         Required with a non-loopback --host (unsafe)
  --no-open              (login) Print URL only, do not open browser
  --device               (login) Headless code paste flow (SSH)
  --timeout-ms <ms>      (login) Login timeout
  --follow, -f           (logs) Follow log file

Port notes:
  Default port is ${DEFAULT_PORT}. Env: GEMINI_OAUTH_PORT=18080 gemini-oauth

Examples:
  gemini-oauth --detach --port 18080
  gemini-oauth status
  curl http://127.0.0.1:18080/v1/models
  gemini-oauth stop
`.trim();

const isPortOpen = (
  host: string,
  port: number,
  timeoutMs = 400,
): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

const print = (msg: string) => process.stdout.write(`${msg}\n`);
const fail = (msg: string, code = 1): never => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

const cliEntry = fileURLToPath(import.meta.url);

async function cmdAuthStatus(
  authFile: string,
  project?: string,
  url?: string,
): Promise<void> {
  const store = new GeminiAuthStore({
    authFilePath: authFile,
    projectId: project,
    url,
  });
  if (!store.hasCredentials()) {
    print(`Auth: not signed in (${authFile})`);
    print(`Run: gemini   or   gemini-oauth login`);
  } else {
    try {
      const session = await store.getSession();
      print(`Auth: signed in`);
      if (session.email) print(`  email:      ${session.email}`);
      if (session.expiresAt)
        print(`  expires_at: ${session.expiresAt.toISOString()}`);
      print(`  auth_file:  ${authFile}`);
      print(`  token:      available`);
      print(`  upstream:   ${url ?? CODE_ASSIST_BASE}`);
      try {
        const projectId = await store.ensureProjectId();
        print(`  project:    ${projectId}`);
      } catch (err) {
        print(
          `  project:    (unresolved) ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      print(`Auth: error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const daemon = getRunningDaemon();
  if (daemon) {
    print(`Server: running`);
    print(`  pid:        ${daemon.pid}`);
    print(`  url:        ${daemon.url}`);
    if (daemon.upstreamUrl) print(`  upstream:   ${daemon.upstreamUrl}`);
    print(`  started_at: ${daemon.startedAt}`);
    print(`  log_file:   ${daemon.logFile}`);
  } else {
    print(`Server: not running (detached)`);
    print(`  start with: gemini-oauth --detach`);
  }
}

async function cmdLogin(opts: {
  authFile: string;
  open: boolean;
  device: boolean;
  timeoutMs?: number;
  project?: string;
  url?: string;
}): Promise<void> {
  const store = new GeminiAuthStore({
    authFilePath: opts.authFile,
    projectId: opts.project,
    url: opts.url,
  });
  await login({
    store,
    open: opts.open,
    device: opts.device,
    timeoutMs: opts.timeoutMs,
    onMessage: print,
  });
}

function printExistingServer(existing: {
  pid: number;
  url: string;
  port: number;
  logFile: string;
  startedAt: string;
  upstreamUrl?: string;
}): void {
  print(`Server already running (detached daemon)`);
  print(`  pid:        ${existing.pid}`);
  print(`  url:        ${existing.url}`);
  print(`  port:       ${existing.port}`);
  if (existing.upstreamUrl) print(`  upstream:   ${existing.upstreamUrl}`);
  print(`  started_at: ${existing.startedAt}`);
  print(`  log_file:   ${existing.logFile}`);
  print(``);
  print(`Use this base URL (not the default ${DEFAULT_PORT}):`);
  print(`  ${existing.url}`);
  print(``);
  print(`  gemini-oauth status`);
  print(`  gemini-oauth logs --follow`);
  print(`  gemini-oauth stop`);
  print(`  gemini-oauth --force --port <other>  # foreground second instance`);
}

const waitForDaemonReady = async (
  state: { url: string },
  timeoutMs = 30_000,
): Promise<boolean> => {
  const healthUrl = `${state.url.replace(/\/v1\/?$/, "")}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!getRunningDaemon()) return false;
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(750),
      });
      const body = (await response.json()) as { ok?: boolean; name?: string };
      if (response.ok && body.ok === true && body.name === PACKAGE_NAME) {
        return true;
      }
    } catch {
      // The child may still be resolving auth/project state before listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
};

async function cmdServe(opts: {
  host: string;
  port: number;
  authFile: string;
  models?: string[];
  project?: string;
  url?: string;
  detach: boolean;
  foreground: boolean;
  force: boolean;
  allowRemote: boolean;
  portExplicit: boolean;
  rawServeArgs: string[];
}): Promise<void> {
  const isDaemonChild =
    opts.foreground || process.env.GEMINI_OAUTH_DAEMON === "1";
  const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(opts.host);

  if (!isLoopback && !opts.allowRemote) {
    fail(
      `Refusing non-loopback host ${opts.host} without --allow-remote. ` +
        `${PACKAGE_NAME} does not authenticate proxy clients.`,
    );
  }

  if (!isDaemonChild && !opts.force) {
    const existing = getRunningDaemon();
    if (existing) {
      printExistingServer(existing);
      if (opts.port !== existing.port) {
        print(``);
        print(
          `Note: you requested port ${opts.port}, but the daemon is on ${existing.port}.`,
        );
        print(
          `Stop it first (\`gemini-oauth stop\`) if you want port ${opts.port}.`,
        );
      }
      return;
    }
  }

  if (!isLoopback) {
    print(
      `WARNING: ${PACKAGE_NAME} has no proxy API-key check; binding ${opts.host} can expose your Google OAuth quota to the network.`,
    );
  }

  if (opts.detach && !opts.foreground) {
    if (opts.force && getRunningDaemon()) {
      fail(
        "Only one detached server can be tracked. Stop the existing daemon, " +
          "or use --force without --detach on a different port.",
      );
    }
    const store = new GeminiAuthStore({
      authFilePath: opts.authFile,
      projectId: opts.project,
      url: opts.url,
    });
    if (!store.hasCredentials()) {
      print(`No credentials found. Run login first:\n  gemini-oauth login\n`);
      fail("Cannot start detached server without credentials.");
    }
    await store.getSession();

    const state = spawnDetachedServer({
      cliEntry,
      serveArgs: opts.rawServeArgs,
      host: opts.host,
      port: opts.port,
      authFile: opts.authFile,
      upstreamUrl: opts.url,
    });

    const ready = await waitForDaemonReady(state);
    if (!ready) {
      const log = existsSync(DAEMON_LOG_FILE)
        ? readFileSync(DAEMON_LOG_FILE, "utf8").slice(-1500)
        : "";
      await stopDaemon(2000);
      fail(
        `Server did not become healthy within 30 seconds. Check logs: gemini-oauth logs\n${log}`,
      );
    }

    print(`Gemini OAuth proxy started in background`);
    print(`  pid: ${state.pid}`);
    print(`  url: ${state.url}`);
    print(`  port: ${state.port}`);
    if (state.upstreamUrl) print(`  upstream: ${state.upstreamUrl}`);
    print(`  log: ${state.logFile}`);
    print(``);
    print(`  gemini-oauth status`);
    print(`  gemini-oauth logs --follow`);
    print(`  gemini-oauth stop`);
    return;
  }

  if (await isPortOpen(opts.host, opts.port)) {
    const existing = getRunningDaemon();
    if (existing && existing.port === opts.port) {
      printExistingServer(existing);
      return;
    }
    fail(
      `Port ${opts.host}:${opts.port} is already in use.\n` +
        `  lsof -nP -iTCP:${opts.port} -sTCP:LISTEN\n` +
        `  Or: gemini-oauth status / gemini-oauth stop`,
    );
  }

  const store = new GeminiAuthStore({
    authFilePath: opts.authFile,
    projectId: opts.project,
    url: opts.url,
  });
  if (!store.hasCredentials()) {
    if (process.env.GEMINI_OAUTH_DAEMON === "1") {
      fail("No credentials found for daemon server.");
    }
    print(`No credentials found. Starting login…\n`);
    await login({ store, onMessage: print });
  } else {
    await store.getSession();
  }

  let running;
  try {
    running = await startGeminiOAuthServer({
      host: opts.host,
      port: opts.port,
      auth: store,
      models: opts.models,
      url: opts.url,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EADDRINUSE")) {
      fail(
        `Port ${opts.host}:${opts.port} is already in use (EADDRINUSE).\n` +
          `  gemini-oauth status\n  gemini-oauth stop\n  Or pick another port: --port <n>`,
      );
    }
    throw err;
  }

  print("");
  print(`Gemini OAuth proxy ready at ${running.url}`);
  print(`  host:     ${running.host}`);
  print(`  port:     ${running.port}`);
  print(`  upstream: ${running.upstreamUrl}`);
  if (!opts.portExplicit && running.port === DEFAULT_PORT) {
    print(
      `  (default port ${DEFAULT_PORT}; override with --port or GEMINI_OAUTH_PORT)`,
    );
  }
  print(`Use this as your OpenAI base URL. No API key is required.`);
  print(
    `Available models: ${running.models.length ? running.models.join(", ") : "(none)"}`,
  );
  print("");
  print(`Examples:`);
  print(`  curl ${running.url}/models`);
  print(
    `  curl ${running.url}/chat/completions -H 'Content-Type: application/json' -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"hi"}]}'`,
  );
  if (process.env.GEMINI_OAUTH_DAEMON === "1") {
    print(`(detached daemon mode — stop with: gemini-oauth stop)`);
  } else {
    print("");
    print(`Press Ctrl+C to stop.`);
  }

  const shutdown = async () => {
    print("\nShutting down…");
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise<void>(() => {
    // keep alive until signal
  });
}

async function cmdLogs(follow: boolean): Promise<void> {
  const daemon = getRunningDaemon();
  const logFile = daemon?.logFile ?? DAEMON_LOG_FILE;
  if (!existsSync(logFile)) {
    fail(`No log file at ${logFile}`);
  }

  if (!follow) {
    process.stdout.write(readFileSync(logFile, "utf8"));
    return;
  }

  const { spawn } = await import("node:child_process");
  const child = spawn("tail", ["-n", "50", "-f", logFile], {
    stdio: "inherit",
  });
  const stop = () => {
    child.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "auth-file": { type: "string" },
      models: { type: "string" },
      project: { type: "string" },
      url: { type: "string" },
      endpoint: { type: "string" },
      open: { type: "boolean", default: true },
      "no-open": { type: "boolean", default: false },
      device: { type: "boolean", default: false },
      "timeout-ms": { type: "string" },
      detach: { type: "boolean", short: "d", default: false },
      foreground: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "allow-remote": { type: "boolean", default: false },
      follow: { type: "boolean", short: "f", default: false },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    print(help);
    return;
  }
  if (values.version) {
    print(`${PACKAGE_NAME} ${PACKAGE_VERSION}`);
    return;
  }

  const command = (positionals[0] ?? "serve").toLowerCase();
  if (positionals.length > 1) {
    fail(`Unexpected positional arguments: ${positionals.slice(1).join(" ")}`);
  }
  const authFile = values["auth-file"] ?? DEFAULT_AUTH_FILE;
  const open = values["no-open"] ? false : values.open !== false;
  const project = values.project;

  const rawUrl =
    values.url ??
    values.endpoint ??
    process.env.CODE_ASSIST_URL ??
    process.env.CODE_ASSIST_ENDPOINT;
  if (values.url !== undefined || values.endpoint !== undefined) {
    const inputUrl = (values.url ?? values.endpoint)!;
    try {
      const parsed = new URL(inputUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        fail(`Invalid --url: ${inputUrl} (must be http:// or https://)`);
      }
    } catch {
      fail(`Invalid --url: ${inputUrl}`);
    }
  }
  const url = rawUrl ? normalizeBaseUrl(rawUrl) : undefined;

  if (command === "help") {
    print(help);
    return;
  }

  if (command === "login") {
    const timeoutMs = values["timeout-ms"]
      ? Number(values["timeout-ms"])
      : undefined;
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    ) {
      fail(`Invalid --timeout-ms: ${values["timeout-ms"]}`);
    }
    await cmdLogin({
      authFile,
      open,
      device: Boolean(values.device),
      timeoutMs,
      project,
      url,
    });
    return;
  }

  if (command === "logout") {
    const store = new GeminiAuthStore({ authFilePath: authFile });
    store.clear();
    print(`Cleared Gemini CLI credentials at ${authFile}`);
    print(
      "Note: the Antigravity OS-keyring session is managed separately and was not removed.",
    );
    return;
  }

  if (command === "status") {
    await cmdAuthStatus(authFile, project, url);
    return;
  }

  if (command === "stop") {
    const stopped = await stopDaemon();
    if (!stopped) {
      print("No detached server is running.");
      return;
    }
    print(`Stopped server pid ${stopped.pid} (${stopped.url})`);
    return;
  }

  if (command === "logs") {
    await cmdLogs(Boolean(values.follow));
    return;
  }

  if (command === "serve" || command === "start" || command === "proxy") {
    const portExplicit = Boolean(values.port || process.env.GEMINI_OAUTH_PORT);
    const rawPort = values.port ?? process.env.GEMINI_OAUTH_PORT;
    const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
      fail(`Invalid --port: ${rawPort}`);
    }
    const host = values.host ?? DEFAULT_HOST;

    const rawServeArgs: string[] = [];
    if (values.host) rawServeArgs.push("--host", values.host);
    rawServeArgs.push("--port", String(port));
    if (values["auth-file"])
      rawServeArgs.push("--auth-file", values["auth-file"]);
    if (values.models) rawServeArgs.push("--models", values.models);
    if (values.project) rawServeArgs.push("--project", values.project);
    if (values["allow-remote"]) rawServeArgs.push("--allow-remote");
    if (values.url) rawServeArgs.push("--url", values.url);
    else if (values.endpoint) rawServeArgs.push("--url", values.endpoint);

    await cmdServe({
      host,
      port,
      authFile,
      models: values.models
        ? values.models
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      project,
      url,
      detach: Boolean(values.detach),
      foreground: Boolean(values.foreground),
      force: Boolean(values.force),
      allowRemote: Boolean(values["allow-remote"]),
      portExplicit,
      rawServeArgs,
    });
    return;
  }

  fail(`Unknown command: ${command}\n\n${help}`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack ?? err.message : String(err));
});
