import { execFileSync } from "node:child_process";

/**
 * Antigravity CLI (`agy`) stores the Google OAuth session in the OS keyring.
 * It does not reliably write ~/.gemini/antigravity-cli/antigravity-oauth-token.
 *
 * Both platforms use the same item identity:
 * - service / keychain service: `gemini`
 * - account / username: `antigravity`
 *
 * macOS Keychain password shape: `<prefix>:<base64 json>`
 * Linux Secret Service secret shape: raw JSON
 *
 * JSON shape, either wrapped or flat:
 * `{ "token": { "access_token", "refresh_token", "token_type", "expiry" } }`
 *
 * The Antigravity refresh token must not be sent to the Gemini CLI OAuth
 * client. That client returns `unauthorized_client`. Refresh by running
 * `agy models`, which updates this keyring item, then read it again.
 */
export type ParsedAntigravityToken = {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: Date;
};

const KEYRING_SERVICE = "gemini";
const KEYRING_ACCOUNT = "antigravity";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const expiryToDate = (raw: unknown): Date | undefined => {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const millis = raw > 10_000_000_000 ? raw : raw * 1000;
    return new Date(millis);
  }
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw.trim())) {
    const asNumber = Number(raw);
    const millis = asNumber > 10_000_000_000 ? asNumber : asNumber * 1000;
    return new Date(millis);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const tokenFromRecord = (record: Record<string, unknown>): ParsedAntigravityToken | null => {
  const token = isRecord(record.token) ? record.token : record;
  if (typeof token.access_token !== "string" || !token.access_token) return null;
  return {
    accessToken: token.access_token,
    refreshToken:
      typeof token.refresh_token === "string" && token.refresh_token
        ? token.refresh_token
        : undefined,
    tokenType: typeof token.token_type === "string" && token.token_type ? token.token_type : "Bearer",
    expiresAt: expiryToDate(token.expiry ?? token.expiry_date),
  };
};

const tryJson = (value: string | null): ParsedAntigravityToken | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? tokenFromRecord(parsed) : null;
  } catch {
    return null;
  }
};

const decodeBase64 = (value: string): string | null => {
  const compact = value.replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(compact)) return null;
  try {
    const decoded = Buffer.from(compact, "base64").toString("utf8");
    return decoded.includes("{") ? decoded : null;
  } catch {
    return null;
  }
};

/**
 * Credentials safe to hand to the proxy. The Antigravity refresh token is
 * intentionally absent so a Gemini CLI refresh cannot return unauthorized_client.
 */
export function antigravityProxyCreds(token: ParsedAntigravityToken): {
  access_token: string;
  token_type: string;
  expiry_date?: number;
  source: "antigravity-keyring";
} {
  return {
    access_token: token.accessToken,
    token_type: token.tokenType,
    ...(token.expiresAt ? { expiry_date: token.expiresAt.getTime() } : {}),
    source: "antigravity-keyring",
  };
}

/** Parse a macOS Keychain password or a Linux Secret Service secret. Never throws. */
export function parseAntigravityKeyringSecret(
  stored: string | null | undefined,
): ParsedAntigravityToken | null {
  const text = stored?.replace(/\0/g, "").trim() ?? "";
  if (!text) return null;
  const direct = tryJson(text);
  if (direct) return direct;
  const colon = text.indexOf(":");
  if (colon >= 0) {
    const decoded = tryJson(decodeBase64(text.slice(colon + 1)));
    if (decoded) return decoded;
  }
  return tryJson(decodeBase64(text));
};

const readCommand = (command: string, args: string[], timeout = 3000): string | null => {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
};

const LINUX_SECRET_PYTHON = `
import sys
try:
    import gi
    gi.require_version("Secret", "1")
    from gi.repository import Secret
    service = Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS)
    for collection in service.get_collections() or []:
        try:
            collection.load_items_sync()
        except Exception:
            continue
        for item in collection.get_items() or []:
            attrs = dict(item.get_attributes() or {})
            if attrs.get("service") != ${JSON.stringify(KEYRING_SERVICE)} or attrs.get("username") != ${JSON.stringify(KEYRING_ACCOUNT)}:
                continue
            if not item.load_secret_sync(None):
                continue
            secret = item.get_secret()
            value = secret.get_text() if secret else ""
            if value and value.strip():
                sys.stdout.write(value)
                raise SystemExit(0)
except Exception:
    pass
raise SystemExit(0)
`;

const readLinuxSecret = (): string | null => {
  const secretTool = readCommand(process.env.SECRET_TOOL_PATH ?? "secret-tool", [
    "lookup",
    "service",
    KEYRING_SERVICE,
    "username",
    KEYRING_ACCOUNT,
  ]);
  if (secretTool) return secretTool;
  return readCommand("python3", ["-c", LINUX_SECRET_PYTHON], 5000);
};

const readDarwinSecret = (): string | null =>
  readCommand("/usr/bin/security", [
    "find-generic-password",
    "-s",
    KEYRING_SERVICE,
    "-a",
    KEYRING_ACCOUNT,
    "-w",
  ]);

/** Read the raw keyring secret for this platform. Returns null when absent or locked. */
export function readAntigravityKeyringSecret(): string | null {
  if (process.platform === "darwin") return readDarwinSecret();
  if (process.platform === "linux") return readLinuxSecret();
  return null;
}
