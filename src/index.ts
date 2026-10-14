export {
  GeminiAuthStore,
  type GeminiSession,
  type GeminiOAuthCreds,
  type GeminiLocalState,
  type AuthStoreOptions,
} from "./auth.js";
export {
  startGeminiOAuthServer,
  type ServerOptions,
  type RunningServer,
} from "./server.js";
export {
  GeminiUpstream,
  createOpenAIStreamFromGemini,
  type UpstreamOptions,
} from "./upstream.js";
export {
  login,
  loginBrowser,
  loginDevice,
  type LoginOptions,
  type LoginResult,
} from "./oauth-login.js";
export {
  getRunningDaemon,
  stopDaemon,
  spawnDetachedServer,
  DAEMON_HOME,
  DAEMON_LOG_FILE,
  type DaemonState,
} from "./daemon.js";
export { resolveProject, loadCodeAssist, type ProjectResolveResult } from "./project.js";
export {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_AUTH_FILE,
  DEFAULT_STATE_FILE,
  CODE_ASSIST_ENDPOINT,
  CODE_ASSIST_BASE,
  CODE_ASSIST_PROD_ENDPOINT,
  CODE_ASSIST_PROD_BASE,
  normalizeBaseUrl,
  OAUTH_CLIENT_ID,
  DEFAULT_MODELS,
} from "./constants.js";
