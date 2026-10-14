import {
  GeminiAuthStore,
  GeminiUpstream,
  startGeminiOAuthServer,
  createLogger,
  normalizeBaseUrl,
  CODE_ASSIST_PROD_BASE,
  type AuthStoreOptions,
  type ServerOptions,
  type LogLevel,
} from "gemini-oauth";

const level: LogLevel = "debug";
const logger = createLogger({ level });

const authOptions: AuthStoreOptions = {
  useAntigravityKeyring: false,
  fetch,
  url: CODE_ASSIST_PROD_BASE,
  logLevel: level,
  logger,
};
const auth = new GeminiAuthStore(authOptions);
const upstream = new GeminiUpstream({
  auth,
  fetch,
  url: normalizeBaseUrl(CODE_ASSIST_PROD_BASE),
  logger,
});
const serverOptions: ServerOptions = {
  auth,
  port: 0,
  fetch,
  maxBodyBytes: 1024,
  url: CODE_ASSIST_PROD_BASE,
  logLevel: "info",
  logger,
};

void upstream;
void startGeminiOAuthServer(serverOptions);
