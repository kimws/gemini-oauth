import {
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export type DaemonState = {
  pid: number;
  host: string;
  port: number;
  url: string;
  startedAt: string;
  logFile: string;
  authFile?: string;
  cliEntry?: string;
  processStartMarker?: string;
  upstreamUrl?: string;
  logLevel?: string;
};

export const DAEMON_HOME = join(homedir(), ".gemini", "oauth-proxy");
export const DAEMON_STATE_FILE = join(DAEMON_HOME, "state.json");
export const DAEMON_LOG_FILE = join(DAEMON_HOME, "server.log");
export const DAEMON_PID_FILE = join(DAEMON_HOME, "server.pid");
export const DAEMON_LOCK_FILE = join(DAEMON_HOME, "start.lock");

export function ensureDaemonHome(): void {
  mkdirSync(DAEMON_HOME, { recursive: true, mode: 0o700 });
}

export function readDaemonState(): DaemonState | null {
  try {
    if (!existsSync(DAEMON_STATE_FILE)) return null;
    const raw = JSON.parse(
      readFileSync(DAEMON_STATE_FILE, "utf8"),
    ) as DaemonState;
    if (
      !raw ||
      typeof raw.pid !== "number" ||
      typeof raw.host !== "string" ||
      !Number.isInteger(raw.port) ||
      raw.port <= 0 ||
      raw.port > 65535 ||
      typeof raw.url !== "string" ||
      typeof raw.startedAt !== "string" ||
      typeof raw.logFile !== "string"
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function writeDaemonState(state: DaemonState): void {
  ensureDaemonHome();
  writeFileSync(DAEMON_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(DAEMON_PID_FILE, `${state.pid}\n`, { mode: 0o600 });
}

export function clearDaemonState(): void {
  for (const file of [DAEMON_STATE_FILE, DAEMON_PID_FILE]) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // ignore
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const readProcessField = (
  pid: number,
  field: "command" | "lstart",
): string | null => {
  if (process.platform === "win32") return null;
  try {
    return execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", `${field}=`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      },
    ).trim();
  } catch {
    return null;
  }
};

const isExpectedDaemonProcess = (state: DaemonState): boolean => {
  if (!isProcessAlive(state.pid)) return false;
  if (process.platform === "win32") return true;

  const command = readProcessField(state.pid, "command");
  if (!command) return false;
  const entryMatches = state.cliEntry
    ? command.includes(state.cliEntry)
    : command.includes("gemini-oauth") || command.includes("/dist/cli.js");
  if (
    !entryMatches ||
    !/(?:^|\s)serve(?:\s|$)/.test(command) ||
    !command.includes("--foreground")
  ) {
    return false;
  }

  if (state.processStartMarker) {
    const actualStart = readProcessField(state.pid, "lstart");
    if (!actualStart || actualStart !== state.processStartMarker) return false;
  }
  return true;
};

export function getRunningDaemon(): DaemonState | null {
  const state = readDaemonState();
  if (!state) return null;
  if (!isExpectedDaemonProcess(state)) {
    clearDaemonState();
    return null;
  }
  return state;
}

/**
 * Spawn a detached child that runs the same CLI in foreground server mode.
 */
export function spawnDetachedServer(opts: {
  cliEntry: string;
  nodeArgs?: string[];
  serveArgs: string[];
  host: string;
  port: number;
  authFile?: string;
  logFile?: string;
  upstreamUrl?: string;
  logLevel?: string;
}): DaemonState {
  ensureDaemonHome();
  let lockFd: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lockFd = openSync(DAEMON_LOCK_FILE, "wx", 0o600);
      writeFileSync(lockFd, `${process.pid}\n`);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const ownerPid = Number(
        existsSync(DAEMON_LOCK_FILE)
          ? readFileSync(DAEMON_LOCK_FILE, "utf8").trim()
          : "",
      );
      if (attempt === 0 && !isProcessAlive(ownerPid)) {
        try {
          unlinkSync(DAEMON_LOCK_FILE);
        } catch {
          // Another starter may have replaced it; retry once.
        }
        continue;
      }
      throw new Error("Another gemini-oauth server start is already in progress");
    }
  }

  try {
    const existing = getRunningDaemon();
    if (existing) {
      throw new Error(
        `Already running (pid ${existing.pid}) at ${existing.url}. Stop it first: gemini-oauth stop`,
      );
    }

    const logFile = opts.logFile ?? DAEMON_LOG_FILE;
    const logFd = openSync(logFile, "a");
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          ...(opts.nodeArgs ?? []),
          opts.cliEntry,
          "serve",
          "--foreground",
          ...opts.serveArgs,
        ],
        {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: {
            ...process.env,
            GEMINI_OAUTH_DAEMON: "1",
          },
        },
      );
    } finally {
      closeSync(logFd);
    }

    if (!child.pid) {
      throw new Error("Failed to spawn detached server process");
    }

    const state: DaemonState = {
      pid: child.pid,
      host: opts.host,
      port: opts.port,
      url: `http://${opts.host.includes(":") ? `[${opts.host}]` : opts.host}:${opts.port}/v1`,
      startedAt: new Date().toISOString(),
      logFile,
      authFile: opts.authFile,
      cliEntry: opts.cliEntry,
      processStartMarker: readProcessField(child.pid, "lstart") ?? undefined,
      upstreamUrl: opts.upstreamUrl,
      logLevel: opts.logLevel,
    };
    try {
      writeDaemonState(state);
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
    child.unref();
    return state;
  } finally {
    if (lockFd !== undefined) closeSync(lockFd);
    try {
      if (existsSync(DAEMON_LOCK_FILE)) unlinkSync(DAEMON_LOCK_FILE);
    } catch {
      // best-effort lock cleanup
    }
  }
}

export async function stopDaemon(
  timeoutMs = 8000,
): Promise<DaemonState | null> {
  const state = getRunningDaemon();
  if (!state) {
    clearDaemonState();
    return null;
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    clearDaemonState();
    return state;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isExpectedDaemonProcess(state)) {
      clearDaemonState();
      return state;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (isExpectedDaemonProcess(state)) {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  clearDaemonState();
  return state;
}
