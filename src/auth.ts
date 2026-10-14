import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import {
  DEFAULT_AUTH_FILE,
  DEFAULT_STATE_FILE,
  GOOGLE_TOKEN_URL,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  REFRESH_SKEW_MS,
  userAgent,
} from "./constants.js";
import { resolveProject } from "./project.js";
import {
  createLogger,
  type Logger,
  type LogLevel,
} from "./logger.js";

/** Shape of `~/.gemini/oauth_creds.json` (official Gemini CLI). */
export type GeminiOAuthCreds = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  id_token?: string;
  /** Milliseconds since epoch (google-auth-library style). */
  expiry_date?: number;
  /** Some stores use seconds expiry. */
  expires_in?: number;
  [extra: string]: unknown;
};

export type GeminiLocalState = {
  projectId?: string;
  email?: string;
  userTier?: string;
  updatedAt?: string;
};

export type GeminiSession = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  email?: string;
  projectId?: string;
  userTier?: string;
  raw: GeminiOAuthCreds;
};

export type AuthStoreOptions = {
  authFilePath?: string;
  stateFilePath?: string;
  clientId?: string;
  clientSecret?: string;
  projectId?: string;
  fetch?: typeof fetch;
  /** Prefer the Antigravity macOS keyring session when available. */
  useAntigravityKeyring?: boolean;
  url?: string;
  endpoint?: string;
  baseUrl?: string;
  logLevel?: LogLevel;
  logger?: Logger;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ensureParent = (filePath: string): void => {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
};

export class GeminiAuthStore {
  readonly authFilePath: string;
  readonly stateFilePath: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly baseUrl?: string;
  readonly logger: Logger;
  private projectIdOverride?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly useAntigravityKeyring: boolean;
  private refreshPromise: Promise<GeminiSession> | null = null;
  private projectPromise: Promise<string> | null = null;

  /**
   * Antigravity CLI keeps its OAuth session in the OS keyring. New models can
   * be entitled there before they become available to the legacy Gemini CLI
   * OAuth client, so prefer that session when it is present and still valid.
   */
  private readAntigravityKeyringSession(
    allowRefresh = true,
  ): GeminiSession | null {
    if (!this.useAntigravityKeyring || process.platform !== "darwin") {
      return null;
    }

    try {
      const stored = execFileSync(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-s",
          "gemini",
          "-a",
          "antigravity",
          "-w",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000,
        },
      ).trim();
      const separator = stored.indexOf(":");
      if (separator < 0) return null;

      const decoded = Buffer.from(stored.slice(separator + 1), "base64").toString(
        "utf8",
      );
      const payload = JSON.parse(decoded) as {
        token?: {
          access_token?: string;
          refresh_token?: string;
          token_type?: string;
          expiry?: string;
        };
      };
      const token = payload.token;
      if (!token?.access_token) return null;

      const expiresAt = token.expiry ? new Date(token.expiry) : undefined;
      const expired =
        expiresAt && expiresAt.getTime() - REFRESH_SKEW_MS <= Date.now();
      if (expired && allowRefresh) {
        try {
          execFileSync(process.env.AGY_CLI_PATH ?? "agy", ["models"], {
            stdio: "ignore",
            timeout: 30_000,
          });
        } catch {
          return null;
        }
        return this.readAntigravityKeyringSession(false);
      }
      if (expired) return null;

      return {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt,
        projectId:
          process.env.GEMINI_OAUTH_ANTIGRAVITY_PROJECT ?? "default-cli-project",
        raw: {
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          token_type: token.token_type ?? "Bearer",
          expiry_date: expiresAt?.getTime(),
          source: "antigravity-keyring",
        },
      };
    } catch {
      return null;
    }
  }

  constructor(options: AuthStoreOptions = {}) {
    this.authFilePath = options.authFilePath ?? DEFAULT_AUTH_FILE;
    this.stateFilePath = options.stateFilePath ?? DEFAULT_STATE_FILE;
    this.clientId = options.clientId ?? OAUTH_CLIENT_ID;
    this.clientSecret = options.clientSecret ?? OAUTH_CLIENT_SECRET;
    this.projectIdOverride = options.projectId;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.useAntigravityKeyring = options.useAntigravityKeyring ?? true;
    this.baseUrl = options.baseUrl ?? options.url ?? options.endpoint;
    this.logger =
      options.logger ??
      createLogger({ level: options.logLevel, prefix: "auth" });
  }

  readCreds(): GeminiOAuthCreds | null {
    if (!existsSync(this.authFilePath)) return null;
    const raw = readFileSync(this.authFilePath, "utf8");
    if (!raw.trim()) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error(`Invalid auth file format: ${this.authFilePath}`);
    }
    return parsed as GeminiOAuthCreds;
  }

  writeCreds(creds: GeminiOAuthCreds): void {
    ensureParent(this.authFilePath);
    writeFileSync(this.authFilePath, `${JSON.stringify(creds, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(this.authFilePath, 0o600);
    } catch {
      // best-effort
    }
  }

  readLocalState(): GeminiLocalState {
    if (!existsSync(this.stateFilePath)) return {};
    try {
      const raw = readFileSync(this.stateFilePath, "utf8");
      if (!raw.trim()) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return {};
      return parsed as GeminiLocalState;
    } catch {
      return {};
    }
  }

  writeLocalState(state: GeminiLocalState): void {
    ensureParent(this.stateFilePath);
    writeFileSync(
      this.stateFilePath,
      `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    try {
      chmodSync(this.stateFilePath, 0o600);
    } catch {
      // best-effort
    }
  }

  hasCredentials(): boolean {
    try {
      if (this.readAntigravityKeyringSession()) return true;
      const creds = this.readCreds();
      return Boolean(creds?.access_token || creds?.refresh_token);
    } catch {
      return false;
    }
  }

  getSessionSnapshot(): GeminiSession | null {
    const antigravity = this.readAntigravityKeyringSession();
    if (antigravity) return antigravity;

    const creds = this.readCreds();
    if (!creds?.access_token && !creds?.refresh_token) return null;

    let expiresAt: Date | undefined;
    if (typeof creds.expiry_date === "number" && creds.expiry_date > 0) {
      expiresAt = new Date(creds.expiry_date);
    }

    const local = this.readLocalState();
    return {
      accessToken: creds.access_token ?? "",
      refreshToken: creds.refresh_token,
      expiresAt,
      email: local.email,
      projectId:
        this.projectIdOverride ??
        process.env.GOOGLE_CLOUD_PROJECT ??
        process.env.GOOGLE_CLOUD_PROJECT_ID ??
        local.projectId,
      userTier: local.userTier,
      raw: creds,
    };
  }

  private isExpired(session: GeminiSession, skewMs = REFRESH_SKEW_MS): boolean {
    if (!session.accessToken) return true;
    if (!session.expiresAt) return false;
    return session.expiresAt.getTime() - skewMs <= Date.now();
  }

  async getAccessToken(options?: { forceRefresh?: boolean }): Promise<string> {
    const session = await this.getSession(options);
    return session.accessToken;
  }

  async getSession(options?: { forceRefresh?: boolean }): Promise<GeminiSession> {
    const snap = this.getSessionSnapshot();
    if (!snap) {
      throw new Error(
        `No Gemini credentials found at ${this.authFilePath}. Run \`gemini\` (login) or \`gemini-oauth login\`.`,
      );
    }

    if (!options?.forceRefresh && !this.isExpired(snap) && snap.accessToken) {
      return snap;
    }

    if (!snap.refreshToken) {
      if (options?.forceRefresh || !snap.accessToken) {
        throw new Error(
          "Access token expired and no refresh_token is available. Run `gemini-oauth login` again.",
        );
      }
      return snap;
    }

    return this.refresh(snap);
  }

  private async refresh(session: GeminiSession): Promise<GeminiSession> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh(session).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(session: GeminiSession): Promise<GeminiSession> {
    if (!session.refreshToken) {
      throw new Error("Missing refresh_token");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": userAgent(),
      },
      body,
      redirect: "error",
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Token refresh failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("Token refresh returned non-JSON body");
    }

    const accessToken = payload.access_token;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error("Token refresh response missing access_token");
    }

    const refreshToken =
      typeof payload.refresh_token === "string" && payload.refresh_token
        ? payload.refresh_token
        : session.refreshToken;

    let expiryDate = session.raw.expiry_date;
    if (typeof payload.expires_in === "number") {
      expiryDate = Date.now() + payload.expires_in * 1000;
    }

    const next: GeminiOAuthCreds = {
      ...session.raw,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type:
        typeof payload.token_type === "string"
          ? payload.token_type
          : session.raw.token_type ?? "Bearer",
      expiry_date: expiryDate,
      scope:
        typeof payload.scope === "string" ? payload.scope : session.raw.scope,
      id_token:
        typeof payload.id_token === "string"
          ? payload.id_token
          : session.raw.id_token,
    };
    this.writeCreds(next);

    return {
      ...session,
      accessToken,
      refreshToken,
      expiresAt:
        typeof expiryDate === "number" ? new Date(expiryDate) : undefined,
      raw: next,
    };
  }

  /**
   * Persist a fresh OAuth grant into Gemini CLI `oauth_creds.json` so both
   * `gemini` and `gemini-oauth` share the same credentials.
   */
  saveOAuthTokens(tokens: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    expiryDate?: number;
    scope?: string;
    idToken?: string;
    tokenType?: string;
    email?: string;
    projectId?: string;
  }): GeminiSession {
    const prev = this.readCreds() ?? {};
    const expiryDate =
      typeof tokens.expiryDate === "number"
        ? tokens.expiryDate
        : typeof tokens.expiresIn === "number"
          ? Date.now() + tokens.expiresIn * 1000
          : prev.expiry_date;

    const creds: GeminiOAuthCreds = {
      ...prev,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken ?? prev.refresh_token,
      token_type: tokens.tokenType ?? prev.token_type ?? "Bearer",
      scope: tokens.scope ?? prev.scope,
      id_token: tokens.idToken ?? prev.id_token,
      expiry_date: expiryDate,
    };
    this.writeCreds(creds);

    if (tokens.email || tokens.projectId) {
      const local = this.readLocalState();
      this.writeLocalState({
        ...local,
        email: tokens.email ?? local.email,
        projectId: tokens.projectId ?? local.projectId,
      });
    }

    return {
      accessToken: creds.access_token!,
      refreshToken: creds.refresh_token,
      expiresAt:
        typeof expiryDate === "number" ? new Date(expiryDate) : undefined,
      email: tokens.email ?? this.readLocalState().email,
      projectId: tokens.projectId ?? this.readLocalState().projectId,
      raw: creds,
    };
  }

  async ensureProjectId(options?: { force?: boolean }): Promise<string> {
    if (this.projectIdOverride) return this.projectIdOverride;
    const fromEnv =
      process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
    if (fromEnv && !/^\d+$/.test(fromEnv)) {
      const local = this.readLocalState();
      if (local.projectId !== fromEnv) {
        this.writeLocalState({ ...local, projectId: fromEnv });
      }
      return fromEnv;
    }

    const antigravity = this.readAntigravityKeyringSession();
    if (antigravity?.projectId) return antigravity.projectId;

    if (!options?.force) {
      const cached = this.readLocalState().projectId;
      if (cached) return cached;
    }

    if (this.projectPromise) return this.projectPromise;
    this.projectPromise = this.doResolveProject().finally(() => {
      this.projectPromise = null;
    });
    return this.projectPromise;
  }

  private async doResolveProject(): Promise<string> {
    const token = await this.getAccessToken();
    const result = await resolveProject(token, {
      fetch: this.fetchImpl,
      projectHint:
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT_ID ||
        undefined,
      baseUrl: this.baseUrl,
      logger: this.logger,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    const local = this.readLocalState();
    this.writeLocalState({
      ...local,
      projectId: result.projectId,
      userTier: result.userTier ?? local.userTier,
      email: result.email ?? local.email,
    });
    return result.projectId;
  }

  clear(): void {
    if (existsSync(this.authFilePath)) {
      this.writeCreds({});
    }
    if (existsSync(this.stateFilePath)) {
      this.writeLocalState({});
    }
  }
}
