import {
  CODE_ASSIST_HEADERS,
  FREE_TIER_ID,
  LEGACY_TIER_ID,
  ONBOARD_POLL_ATTEMPTS,
  ONBOARD_POLL_DELAY_MS,
  antigravityUserAgent,
  coreClientMetadata,
  methodUrl,
} from "./constants.js";
import type { Logger } from "./logger.js";

export type LoadCodeAssistPayload = {
  cloudaicompanionProject?: string | { id?: string; name?: string };
  currentTier?: { id?: string; name?: string };
  paidTier?: { id?: string; name?: string };
  allowedTiers?: Array<{
    id?: string;
    isDefault?: boolean;
    userDefinedCloudaicompanionProject?: boolean;
  }>;
  ineligibleTiers?: Array<{
    reasonCode?: string;
    reasonMessage?: string;
    validationUrl?: string;
  }>;
};

export type OnboardUserPayload = {
  name?: string;
  done?: boolean;
  response?: {
    cloudaicompanionProject?: { id?: string; name?: string };
  };
};

export type ProjectResolveResult =
  | { ok: true; projectId: string; userTier?: string; email?: string }
  | { ok: false; error: string };

export type ResolveProjectOptions = {
  fetch?: typeof fetch;
  projectHint?: string;
  baseUrl?: string;
  url?: string;
  endpoint?: string;
  logger?: Logger;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const normalizeProjectId = (
  value: LoadCodeAssistPayload["cloudaicompanionProject"],
): string | undefined => {
  if (!value) return undefined;
  if (typeof value === "string") return value || undefined;
  return value.id || undefined;
};

type AllowedTier = NonNullable<LoadCodeAssistPayload["allowedTiers"]>[number];

const pickTier = (
  tiers: LoadCodeAssistPayload["allowedTiers"],
): AllowedTier | undefined => {
  if (!tiers || tiers.length === 0) return undefined;
  const free = tiers.find((t) => t.id === FREE_TIER_ID);
  if (free) return free;
  const def = tiers.find((t) => t.isDefault);
  return def ?? tiers[0];
};

export async function loadCodeAssist(
  accessToken: string,
  options: ResolveProjectOptions = {},
): Promise<LoadCodeAssistPayload | null> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const projectHint = options.projectHint;
  const baseUrl = options.baseUrl ?? options.url ?? options.endpoint;
  const metadata = {
    ...coreClientMetadata("ANTIGRAVITY"),
    duetProject: projectHint,
  };
  try {
    const targetUrl = methodUrl("loadCodeAssist", false, baseUrl);
    options.logger?.debug(`loadCodeAssist requesting ${targetUrl}`);
    const response = await fetchImpl(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        // Antigravity UA required for free-tier; GeminiCLI UA → UNSUPPORTED_CLIENT.
        "User-Agent": antigravityUserAgent(),
        ...CODE_ASSIST_HEADERS,
        "Client-Metadata": `ideType=ANTIGRAVITY,platform=${metadata.platform},pluginType=GEMINI`,
      },
      body: JSON.stringify({
        cloudaicompanionProject: projectHint,
        metadata,
      }),
      redirect: "error",
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `loadCodeAssist failed (${response.status}): ${text.slice(0, 400)}`,
      );
    }
    return (await response.json()) as LoadCodeAssistPayload;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("loadCodeAssist")) {
      throw err;
    }
    return null;
  }
}

export async function onboardUser(
  accessToken: string,
  tierId: string,
  options: ResolveProjectOptions = {},
): Promise<string | undefined> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const projectHint = options.projectHint;
  const baseUrl = options.baseUrl ?? options.url ?? options.endpoint;
  try {
    const metadata = {
      ...coreClientMetadata("ANTIGRAVITY"),
      duetProject: projectHint,
    };
    const targetUrl = methodUrl("onboardUser", false, baseUrl);
    options.logger?.debug(`onboardUser requesting ${targetUrl}`);
    const response = await fetchImpl(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": antigravityUserAgent(),
        ...CODE_ASSIST_HEADERS,
        "Client-Metadata": `ideType=ANTIGRAVITY,platform=${metadata.platform},pluginType=GEMINI`,
      },
      body: JSON.stringify({
        tierId,
        cloudaicompanionProject: projectHint,
        metadata,
      }),
      redirect: "error",
    });
    if (!response.ok) {
      return undefined;
    }

    let payload = (await response.json()) as OnboardUserPayload;

    const base = targetUrl.replace(/:onboardUser$/, "");

    for (let attempt = 0; attempt < ONBOARD_POLL_ATTEMPTS; attempt += 1) {
      if (payload.done) break;
      if (!payload.name) break;
      await wait(ONBOARD_POLL_DELAY_MS);
      // LRO operations live at /v1internal/{operationName}
      const opResponse = await fetchImpl(`${base}/${payload.name}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": antigravityUserAgent(),
          ...CODE_ASSIST_HEADERS,
        },
        redirect: "error",
      });
      if (!opResponse.ok) return undefined;
      payload = (await opResponse.json()) as OnboardUserPayload;
    }

    if (!payload.done) return undefined;
    return payload.response?.cloudaicompanionProject?.id;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Cloud Code Assist project id for this account.
 * Prefer existing managed project; otherwise onboard free/default tier.
 */
export async function resolveProject(
  accessToken: string,
  options: ResolveProjectOptions = {},
): Promise<ProjectResolveResult> {
  let loadResult: LoadCodeAssistPayload | null;
  try {
    loadResult = await loadCodeAssist(accessToken, options);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!loadResult) {
    return { ok: false, error: "Failed to load Cloud Code Assist project" };
  }

  const existing = normalizeProjectId(loadResult.cloudaicompanionProject);
  if (existing) {
    return {
      ok: true,
      projectId: existing,
      userTier: loadResult.currentTier?.id ?? loadResult.paidTier?.id,
    };
  }

  // Project already set via env but not returned as managed — use the hint.
  if (options.projectHint && !/^\d+$/.test(options.projectHint)) {
    return {
      ok: true,
      projectId: options.projectHint,
      userTier: loadResult.currentTier?.id,
    };
  }

  // Prefer free-tier (Antigravity individuals); fall back to default/allowed.
  const tier = pickTier(loadResult.allowedTiers);
  const requiresUserProject = Boolean(
    tier?.userDefinedCloudaicompanionProject,
  );

  if (requiresUserProject && !options.projectHint) {
    return {
      ok: false,
      error:
        "This account requires a user-defined GCP project. " +
        "Set GOOGLE_CLOUD_PROJECT (or --project) to your project id, then retry.",
    };
  }

  if (!tier && loadResult.currentTier?.id) {
    return {
      ok: false,
      error:
        "Account is onboarded but no managed project ID was returned. " +
        "Set GOOGLE_CLOUD_PROJECT to your GCP project id, then retry.",
    };
  }

  if (!tier) {
    const ineligible = loadResult.ineligibleTiers?.[0];
    const reason =
      ineligible?.reasonMessage ??
      "Account not eligible for Gemini Code Assist free tier";
    const url = ineligible?.validationUrl
      ? ` Validation: ${ineligible.validationUrl}`
      : "";
    return { ok: false, error: `${reason}${url}` };
  }

  const tierId = tier.id ?? LEGACY_TIER_ID;
  const onboardedId = await onboardUser(accessToken, tierId, options);
  if (!onboardedId) {
    return {
      ok: false,
      error:
        "Onboarding failed — could not provision a managed project. " +
        "If free-tier is unavailable, set GOOGLE_CLOUD_PROJECT and use standard-tier.",
    };
  }

  return { ok: true, projectId: onboardedId, userTier: tierId };
}
