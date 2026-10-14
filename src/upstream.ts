import { randomUUID } from "node:crypto";
import {
  CODE_ASSIST_HEADERS,
  DEFAULT_MODELS,
  clientMetadata,
  methodUrl,
  antigravityUserAgent,
  userAgent,
  normalizeBaseUrl,
  type IdeType,
} from "./constants.js";
import type { GeminiAuthStore } from "./auth.js";
import {
  createLogger,
  type Logger,
  type LogLevel,
} from "./logger.js";
import {
  buildCodeAssistBody,
  chatCompletionToResponses,
  geminiChunkToOpenAI,
  geminiResponseToOpenAI,
  responsesRequestToChat,
  type GeminiResponse,
  type GeminiStreamState,
  type OpenAIChatRequest,
} from "./convert.js";

const MAX_SSE_BUFFER_CHARS = 1024 * 1024;

export type UpstreamOptions = {
  auth: GeminiAuthStore;
  models?: string[];
  fetch?: typeof fetch;
  url?: string;
  endpoint?: string;
  baseUrl?: string;
  ideType?: IdeType;
  userProject?: string;
  userAgent?: string;
  logLevel?: LogLevel;
  logger?: Logger;
};

export class GeminiUpstream {
  private readonly auth: GeminiAuthStore;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly ideType: IdeType;
  private readonly userProject?: string;
  private readonly customUserAgent?: string;
  private models: string[];

  constructor(options: UpstreamOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? options.url ?? options.endpoint,
    );
    this.logger =
      options.logger ??
      createLogger({ level: options.logLevel, prefix: "upstream" });
    this.ideType = options.ideType ?? "ANTIGRAVITY";
    this.userProject = options.userProject;
    this.customUserAgent = options.userAgent;
    this.models = options.models?.length
      ? options.models
      : [...DEFAULT_MODELS];
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  listModelsCached(): string[] {
    return [...this.models];
  }

  async listModels(): Promise<string[]> {
    // Code Assist has no public models list; return configured allowlist.
    return this.listModelsCached();
  }

  private async authHeaders(
    model: string,
    streaming: boolean,
    projectId?: string,
  ): Promise<Record<string, string>> {
    const token = await this.auth.getAccessToken();
    const effectiveUa =
      this.customUserAgent ??
      (this.ideType === "ANTIGRAVITY"
        ? antigravityUserAgent()
        : userAgent(model));
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": effectiveUa,
      "x-activity-request-id": randomUUID(),
      "X-Goog-Api-Client": CODE_ASSIST_HEADERS["X-Goog-Api-Client"],
      "Client-Metadata": clientMetadata(this.ideType),
    };
    if (this.userProject) {
      headers["x-goog-user-project"] = this.userProject;
    }
    if (streaming) {
      headers.Accept = "text/event-stream";
    } else {
      headers.Accept = "application/json";
    }
    return headers;
  }

  private async doFetch(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<Response> {
    const run = async (forceRefresh = false): Promise<Response> => {
      if (forceRefresh) {
        this.logger.debug("Forcing token refresh for 401 retry");
        await this.auth.getAccessToken({ forceRefresh: true });
        headers.Authorization = `Bearer ${await this.auth.getAccessToken()}`;
      }
      return this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
      });
    };

    let response = await run(false);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {
        // best-effort connection cleanup before retrying
      });
      response = await run(true);
    }
    return response;
  }

  async chatCompletions(
    openAiRequest: OpenAIChatRequest,
  ): Promise<
    | { kind: "json"; status: number; body: unknown }
    | { kind: "stream"; status: number; stream: ReadableStream<Uint8Array> }
    | { kind: "error"; status: number; body: unknown }
  > {
    const projectId = await this.auth.ensureProjectId();
    const streaming = openAiRequest.stream === true;
    const model = openAiRequest.model || "gemini-2.5-flash";
    const url = methodUrl(
      streaming ? "streamGenerateContent" : "generateContent",
      streaming,
      this.baseUrl,
    );
    this.logger.debug(
      `Upstream request POST ${url} (model: ${model}, stream: ${streaming})`,
    );
    const envelope = buildCodeAssistBody(
      { ...openAiRequest, model },
      projectId,
    );
    const headers = await this.authHeaders(model, streaming, projectId);
    const response = await this.doFetch(
      url,
      headers,
      JSON.stringify(envelope),
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      this.logger.error(
        `Upstream error (${response.status}) from ${url}: ${errText.slice(0, 400)}`,
      );
      return {
        kind: "error",
        status: response.status,
        body: {
          error: {
            message: `Upstream error (${response.status}): ${errText.slice(0, 800)}`,
            type: "api_error",
            code: String(response.status),
          },
        },
      };
    }

    if (streaming && response.body) {
      return {
        kind: "stream",
        status: response.status,
        stream: createOpenAIStreamFromGemini(response.body, model),
      };
    }

    const geminiJson = (await response.json()) as Record<string, unknown>;
    const inner = (geminiJson.response ?? geminiJson) as GeminiResponse;
    return {
      kind: "json",
      status: 200,
      body: geminiResponseToOpenAI(inner, model),
    };
  }

  async responses(
    body: Record<string, unknown>,
  ): Promise<
    | { kind: "json"; status: number; body: unknown }
    | { kind: "stream"; status: number; stream: ReadableStream<Uint8Array> }
    | { kind: "error"; status: number; body: unknown }
  > {
    const chatReq = responsesRequestToChat(body);
    if (chatReq.stream) {
      return {
        kind: "error",
        status: 400,
        body: {
          error: {
            message:
              "Streaming is not supported by /v1/responses; use /v1/chat/completions",
            type: "unsupported_parameter",
            param: "stream",
          },
        },
      };
    }
    const result = await this.chatCompletions(chatReq);
    if (result.kind !== "json") return result;
    return {
      kind: "json",
      status: 200,
      body: chatCompletionToResponses(
        result.body as Record<string, unknown>,
        chatReq.model,
      ),
    };
  }
}

export function createOpenAIStreamFromGemini(
  geminiStream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const chunkId = `chatcmpl-${randomUUID()}`;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let sourceDone = false;
  let closed = false;
  const pendingEvents: string[] = [];
  const reader = geminiStream.getReader();
  const state: GeminiStreamState = {
    toolCallIds: new Map(),
    sawToolCalls: false,
    sentRole: false,
  };

  const queueCompleteEvents = (): void => {
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    pendingEvents.push(...events);
  };

  const finish = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    if (closed) return;
    closed = true;
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const event = pendingEvents.shift();
          if (event !== undefined) {
            const result = processSseEvent(
              event,
              chunkId,
              model,
              controller,
              encoder,
              state,
            );
            if (result === "done") {
              sourceDone = true;
              await reader.cancel("upstream sent [DONE]").catch(() => {
                // best-effort
              });
              pendingEvents.length = 0;
              finish(controller);
              return;
            }
            if (result === "enqueued") return;
            continue;
          }

          if (sourceDone) {
            finish(controller);
            return;
          }

          const next = await reader.read();
          if (next.done) {
            sourceDone = true;
            buffer += decoder.decode();
            if (buffer.trim()) pendingEvents.push(buffer);
            buffer = "";
            continue;
          }

          buffer += decoder.decode(next.value, { stream: true });
          if (buffer.length > MAX_SSE_BUFFER_CHARS) {
            throw new Error("Upstream SSE event exceeded 1 MiB");
          }
          queueCompleteEvents();
        }
      } catch (error) {
        closed = true;
        controller.error(error);
        await reader.cancel(error).catch(() => {
          // best-effort
        });
      }
    },
    async cancel(reason) {
      closed = true;
      await reader.cancel(reason).catch(() => {
        // best-effort
      });
    },
  });
}

function processSseEvent(
  event: string,
  chunkId: string,
  model: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: GeminiStreamState,
): "done" | "enqueued" | "ignored" {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  if (!data) return "ignored";
  if (data === "[DONE]") return "done";

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch (error) {
    throw new Error("Malformed JSON in upstream SSE event", { cause: error });
  }
  const geminiBody = (parsed.response ?? parsed) as GeminiResponse;
  const chunk = geminiChunkToOpenAI(geminiBody, model, chunkId, state);
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  return "enqueued";
}
