import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const packageMetadata = createRequire(import.meta.url)("../package.json") as {
  name: string;
  version: string;
};

export const PACKAGE_NAME = packageMetadata.name;
export const PACKAGE_VERSION = packageMetadata.version;

/**
 * Official Gemini CLI OAuth client credentials.
 * Public by design (installed desktop app); security is PKCE + per-user refresh token.
 * Source: google-gemini/gemini-cli packages/core/src/code_assist/oauth2.ts
 */
export const OAUTH_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
export const OAUTH_CLIENT_SECRET = "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";

export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "openid",
] as const;

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL =
  "https://www.googleapis.com/oauth2/v2/userinfo";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Cloud Code Assist private API (same as Gemini CLI / Antigravity). */
export const CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const CODE_ASSIST_API_VERSION = "v1internal";
export const CODE_ASSIST_BASE = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}`;

/** Production Cloud Code Assist API endpoint for corporate/enterprise subscriptions. */
export const CODE_ASSIST_PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const CODE_ASSIST_PROD_BASE = `${CODE_ASSIST_PROD_ENDPOINT}/${CODE_ASSIST_API_VERSION}`;

/**
 * Client metadata for Code Assist.
 * Free / individual (Antigravity) tier requires ideType=ANTIGRAVITY —
 * plain IDE_UNSPECIFIED returns UNSUPPORTED_CLIENT for free-tier.
 */
export function platformId(): string {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "DARWIN_ARM64" : "DARWIN_AMD64";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "WINDOWS_ARM64" : "WINDOWS_AMD64";
  }
  return process.arch === "arm64" ? "LINUX_ARM64" : "LINUX_AMD64";
}

export type IdeType =
  | "ANTIGRAVITY"
  | "GEMINI_CLI"
  | "VSCODE"
  | "INTELLIJ"
  | "IDE_UNSPECIFIED"
  | string;

export function clientMetadata(
  ideType: IdeType = "ANTIGRAVITY",
): string {
  return `ideType=${ideType},platform=${platformId()},pluginType=GEMINI`;
}

export const CODE_ASSIST_HEADERS = {
  "X-Goog-Api-Client": "gl-node/22.17.0",
  get "Client-Metadata"(): string {
    return clientMetadata("ANTIGRAVITY");
  },
} as const;

export function coreClientMetadata(
  ideType: IdeType = "ANTIGRAVITY",
): {
  ideType: string;
  platform: string;
  pluginType: string;
} {
  return {
    ideType,
    platform: platformId(),
    pluginType: "GEMINI",
  };
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 10551;
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export const DEFAULT_GEMINI_HOME = join(homedir(), ".gemini");
/** Shared with official Gemini CLI. */
export const DEFAULT_AUTH_FILE = join(DEFAULT_GEMINI_HOME, "oauth_creds.json");
/** Local cache for managed project id / email (gemini-oauth only). */
export const DEFAULT_STATE_FILE = join(DEFAULT_GEMINI_HOME, "gemini-oauth.json");

export const FREE_TIER_ID = "free-tier";
export const LEGACY_TIER_ID = "legacy-tier";
export const STANDARD_TIER_ID = "standard-tier";

export const ONBOARD_POLL_ATTEMPTS = 12;
export const ONBOARD_POLL_DELAY_MS = 2000;

/** Default model allowlist when discovery is not available. */
export const DEFAULT_MODELS = [
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3-pro-preview",
] as const;

export const REFRESH_SKEW_MS = 2 * 60 * 1000;

/** Prefer installed Gemini CLI version for User-Agent. */
export function resolveClientVersion(): string {
  if (process.env.GEMINI_CLI_VERSION?.trim()) {
    return process.env.GEMINI_CLI_VERSION.trim();
  }
  try {
    const pkgPath = join(
      // node_modules/@google/gemini-cli/package.json when globally installed
      process.env.npm_config_prefix ?? "/opt/homebrew",
      "lib/node_modules/@google/gemini-cli/package.json",
    );
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // ignore
  }
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("@google/gemini-cli/package.json") as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    // ignore
  }
  return "0.63.0";
}

/** Gemini CLI-compatible User-Agent used for OAuth token operations. */
export function userAgent(model = "gemini-code-assist"): string {
  return `GeminiCLI/${resolveClientVersion()}/${model} (${process.platform}; ${process.arch})`;
}

/**
 * User-Agent for loadCodeAssist / onboardUser.
 * Free-tier (individuals / Antigravity) rejects GeminiCLI UA with UNSUPPORTED_CLIENT.
 */
export function antigravityUserAgent(): string {
  return `antigravity/language-server/${resolveClientVersion()} ${process.platform}/${process.arch}`;
}

export function normalizeBaseUrl(input?: string): string {
  const envUrl =
    process.env.CODE_ASSIST_URL || process.env.CODE_ASSIST_ENDPOINT;
  const raw = (input?.trim() || envUrl?.trim() || CODE_ASSIST_BASE).replace(
    /\/+$/,
    "",
  );
  const defaultApiVersion =
    process.env.CODE_ASSIST_API_VERSION || CODE_ASSIST_API_VERSION;
  try {
    const parsed = new URL(raw);
    if (!parsed.pathname || parsed.pathname === "/") {
      return `${parsed.origin}/${defaultApiVersion}`;
    }
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw;
  }
}

export function methodUrl(
  method: string,
  streaming = false,
  baseUrl?: string,
): string {
  const base = normalizeBaseUrl(baseUrl);
  if (streaming) {
    return `${base}:${method}?alt=sse`;
  }
  return `${base}:${method}`;
}
