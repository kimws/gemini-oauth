import { PACKAGE_NAME } from "./constants.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

export function parseLogLevel(value: unknown): LogLevel | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
    case "warning":
      return "warn";
    case "error":
      return "error";
    case "silent":
    case "off":
    case "none":
      return "silent";
    default:
      return null;
  }
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(prefix: string): Logger;
}

export type LogWriter = (level: LogLevel, line: string, args: unknown[]) => void;

const defaultLogWriter: LogWriter = (level, line, args) => {
  if (level === "error") {
    if (args.length > 0) {
      console.error(line, ...args);
    } else {
      process.stderr.write(`${line}\n`);
    }
  } else if (level === "warn") {
    if (args.length > 0) {
      console.warn(line, ...args);
    } else {
      process.stderr.write(`${line}\n`);
    }
  } else if (level === "debug") {
    if (args.length > 0) {
      console.debug(line, ...args);
    } else {
      process.stdout.write(`${line}\n`);
    }
  } else {
    // info
    if (args.length > 0) {
      console.info(line, ...args);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
};

export class ConsoleLogger implements Logger {
  readonly level: LogLevel;
  private readonly prefix?: string;
  private readonly levelValue: number;
  private readonly writer: LogWriter;

  constructor(
    level: LogLevel = "info",
    prefix?: string,
    writer: LogWriter = defaultLogWriter,
  ) {
    this.level = level;
    this.prefix = prefix;
    this.levelValue = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    this.writer = writer;
  }

  child(prefix: string): Logger {
    const combined = this.prefix ? `${this.prefix}:${prefix}` : prefix;
    return new ConsoleLogger(this.level, combined, this.writer);
  }

  private shouldLog(level: LogLevel): boolean {
    if (this.level === "silent") return false;
    return (LOG_LEVELS[level] ?? 0) >= this.levelValue;
  }

  private format(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(5);
    const pref = this.prefix ? ` [${this.prefix}]` : "";
    return `${timestamp} [${tag}]${pref} ${message}`;
  }

  debug(message: string, ...args: unknown[]): void {
    if (!this.shouldLog("debug")) return;
    this.writer("debug", this.format("debug", message), args);
  }

  info(message: string, ...args: unknown[]): void {
    if (!this.shouldLog("info")) return;
    this.writer("info", this.format("info", message), args);
  }

  warn(message: string, ...args: unknown[]): void {
    if (!this.shouldLog("warn")) return;
    this.writer("warn", this.format("warn", message), args);
  }

  error(message: string, ...args: unknown[]): void {
    if (!this.shouldLog("error")) return;
    this.writer("error", this.format("error", message), args);
  }
}

export const NOOP_LOGGER: Logger = new ConsoleLogger("silent");

export function createLogger(options?: {
  level?: LogLevel | string;
  prefix?: string;
  writer?: LogWriter;
}): Logger {
  const parsed = options?.level ? parseLogLevel(options.level) : null;
  const level = parsed ?? "info";
  return new ConsoleLogger(
    level,
    options?.prefix ?? PACKAGE_NAME,
    options?.writer,
  );
}
