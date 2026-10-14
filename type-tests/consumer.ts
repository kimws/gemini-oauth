import {
  GeminiAuthStore,
  GeminiUpstream,
  startGeminiOAuthServer,
  normalizeBaseUrl,
  CODE_ASSIST_PROD_BASE,
  type AuthStoreOptions,
  type ServerOptions,
} from "gemini-oauth";

const authOptions: AuthStoreOptions = {
  useAntigravityKeyring: false,
  fetch,
  url: CODE_ASSIST_PROD_BASE,
};
const auth = new GeminiAuthStore(authOptions);
const upstream = new GeminiUpstream({
  auth,
  fetch,
  url: normalizeBaseUrl(CODE_ASSIST_PROD_BASE),
});
const serverOptions: ServerOptions = {
  auth,
  port: 0,
  fetch,
  maxBodyBytes: 1024,
  url: CODE_ASSIST_PROD_BASE,
};

void upstream;
void startGeminiOAuthServer(serverOptions);
