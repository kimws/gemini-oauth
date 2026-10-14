import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CODE_ASSIST_ENDPOINT,
  DEFAULT_HOST,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PORT,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "./constants.js";
import type { GeminiAuthStore } from "./auth.js";
import type { OpenAIChatRequest } from "./convert.js";
import { GeminiUpstream } from "./upstream.js";

export type ServerOptions = {
  host?: string;
  port?: number;
  auth: GeminiAuthStore;
  models?: string[];
  /** Maximum accepted JSON request size. Defaults to 10 MiB. */
  maxBodyBytes?: number;
  /** Optional fetch implementation, primarily for embedding and tests. */
  fetch?: typeof fetch;
  /** Custom Code Assist upstream URL / endpoint. */
  url?: string;
  endpoint?: string;
  baseUrl?: string;
};

export type RunningServer = {
  host: string;
  port: number;
  url: string;
  upstreamUrl: string;
  models: string[];
  close: () => Promise<void>;
};

class RequestBodyTooLargeError extends Error {}
class RequestAbortedError extends Error {}

const readBody = (
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    };
    const fail = (error: Error, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) {
        req.on("error", () => {
          // Ignore errors while discarding an oversized request.
        });
        req.resume();
      }
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        fail(
          new RequestBodyTooLargeError(
            `Request body exceeds ${maxBodyBytes} bytes`,
          ),
          true,
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes));
    };
    const onAborted = () => fail(new RequestAbortedError("Request aborted"));
    const onError = (error: Error) => fail(error);

    const declaredLength = Number(req.headers["content-length"]);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > maxBodyBytes
    ) {
      fail(
        new RequestBodyTooLargeError(
          `Request body exceeds ${maxBodyBytes} bytes`,
        ),
        true,
      );
      return;
    }

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validateChatRequest = (value: unknown): string | null => {
  if (!isRecord(value)) return "Request body must be a JSON object";
  if (typeof value.model !== "string" || !value.model.trim()) {
    return "Request must include a non-empty string model";
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    return "Request must include a non-empty messages array";
  }
  for (const [index, message] of value.messages.entries()) {
    if (!isRecord(message) || typeof message.role !== "string") {
      return `messages[${index}] must be an object with a string role`;
    }
    const content = message.content;
    if (
      content !== undefined &&
      content !== null &&
      typeof content !== "string" &&
      !Array.isArray(content)
    ) {
      return `messages[${index}].content must be a string, null, or array`;
    }
    if (
      Array.isArray(content) &&
      content.some((block) => {
        if (!isRecord(block) || typeof block.type !== "string") return true;
        if (block.type === "text") return typeof block.text !== "string";
        if (block.type === "image_url") {
          return (
            !isRecord(block.image_url) ||
            typeof block.image_url.url !== "string"
          );
        }
        return true;
      })
    ) {
      return `messages[${index}].content contains an invalid or unsupported block`;
    }
    if (
      message.tool_calls !== undefined &&
      (!Array.isArray(message.tool_calls) ||
        message.tool_calls.some((call) => {
          if (!isRecord(call) || !isRecord(call.function)) return true;
          return (
            typeof call.id !== "string" ||
            typeof call.function.name !== "string" ||
            typeof call.function.arguments !== "string"
          );
        }))
    ) {
      return `messages[${index}].tool_calls is invalid`;
    }
    if (message.name !== undefined && typeof message.name !== "string") {
      return `messages[${index}].name must be a string`;
    }
    if (
      message.tool_call_id !== undefined &&
      typeof message.tool_call_id !== "string"
    ) {
      return `messages[${index}].tool_call_id must be a string`;
    }
  }
  if (
    value.tools !== undefined &&
    (!Array.isArray(value.tools) ||
      value.tools.some(
        (tool) =>
          !isRecord(tool) ||
          tool.type !== "function" ||
          !isRecord(tool.function) ||
          typeof tool.function.name !== "string",
      ))
  ) {
    return "tools must contain valid function definitions";
  }
  for (const field of ["temperature", "top_p"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "number") {
      return `${field} must be a number`;
    }
  }
  for (const field of ["max_tokens", "max_completion_tokens"] as const) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      (!Number.isInteger(candidate) || (candidate as number) <= 0)
    ) {
      return `${field} must be a positive integer`;
    }
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    return "stream must be a boolean";
  }
  if (
    value.stop !== undefined &&
    typeof value.stop !== "string" &&
    (!Array.isArray(value.stop) ||
      value.stop.some((item) => typeof item !== "string"))
  ) {
    return "stop must be a string or an array of strings";
  }
  return null;
};

const validateResponsesRequest = (value: unknown): string | null => {
  if (!isRecord(value)) return "Request body must be a JSON object";
  if (
    value.model !== undefined &&
    (typeof value.model !== "string" || !value.model.trim())
  ) {
    return "model must be a non-empty string";
  }
  if (typeof value.input !== "string" && !Array.isArray(value.input)) {
    return "input must be a string or array";
  }
  if (
    value.instructions !== undefined &&
    typeof value.instructions !== "string"
  ) {
    return "instructions must be a string";
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    return "stream must be a boolean";
  }
  if (value.stream === true) {
    return "Streaming is not supported by /v1/responses; use /v1/chat/completions";
  }
  return null;
};

const sendJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const pipeStream = async (
  stream: ReadableStream<Uint8Array>,
  res: ServerResponse,
): Promise<void> => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const reader = stream.getReader();
  let upstreamDone = false;
  let clientClosed = false;
  const onClose = () => {
    clientClosed = true;
    if (!upstreamDone) {
      void reader.cancel("client disconnected").catch(() => {
        // best-effort cancellation
      });
    }
  };
  res.once("close", onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        upstreamDone = true;
        break;
      }
      if (value && !clientClosed) {
        const writable = res.write(Buffer.from(value));
        if (!writable) {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              res.off("drain", onDrain);
              res.off("close", onClosedWhileDraining);
              res.off("error", onError);
            };
            const onDrain = () => {
              cleanup();
              resolve();
            };
            const onClosedWhileDraining = () => {
              cleanup();
              reject(new Error("Client disconnected"));
            };
            const onError = (error: Error) => {
              cleanup();
              reject(error);
            };
            res.once("drain", onDrain);
            res.once("close", onClosedWhileDraining);
            res.once("error", onError);
          });
        }
      }
    }
    if (!clientClosed) res.end();
  } catch (err) {
    if (!res.destroyed) {
      res.destroy(err instanceof Error ? err : undefined);
    }
  } finally {
    res.off("close", onClose);
  }
};

export async function startGeminiOAuthServer(
  options: ServerOptions,
): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("maxBodyBytes must be a positive safe integer");
  }
  const upstream = new GeminiUpstream({
    auth: options.auth,
    models: options.models,
    fetch: options.fetch,
    url: options.url ?? options.endpoint ?? options.baseUrl,
  });

  // Ensure project is resolvable at startup so first request is faster.
  try {
    await options.auth.ensureProjectId();
  } catch (err) {
    console.warn(
      `[${PACKAGE_NAME}] project resolution deferred:`,
      err instanceof Error ? err.message : err,
    );
  }

  let models = options.models ?? (await upstream.listModels());

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && (path === "/" || path === "/health")) {
        const session = options.auth.getSessionSnapshot();
        const base = upstream.getBaseUrl();
        sendJson(res, 200, {
          ok: true,
          name: PACKAGE_NAME,
          version: PACKAGE_VERSION,
          upstream: new URL(base).hostname,
          project_id: session?.projectId ?? null,
          replay_state: "stateless",
        });
        return;
      }

      if (req.method === "GET" && path === "/v1/models") {
        models = await upstream.listModels();
        sendJson(res, 200, {
          object: "list",
          data: models.map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "google-oauth",
          })),
        });
        return;
      }

      if (req.method === "POST" && path === "/v1/chat/completions") {
        const bodyBuf = await readBody(req, maxBodyBytes);
        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyBuf.toString("utf8")) as unknown;
        } catch {
          sendJson(res, 400, {
            error: {
              message: "Invalid JSON body",
              type: "invalid_request_error",
            },
          });
          return;
        }
        const validationError = validateChatRequest(parsed);
        if (validationError) {
          sendJson(res, 400, {
            error: {
              message: validationError,
              type: "invalid_request_error",
            },
          });
          return;
        }

        const result = await upstream.chatCompletions(
          parsed as OpenAIChatRequest,
        );
        if (result.kind === "stream") {
          await pipeStream(result.stream, res);
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      if (req.method === "POST" && path === "/v1/responses") {
        const bodyBuf = await readBody(req, maxBodyBytes);
        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyBuf.toString("utf8")) as unknown;
        } catch {
          sendJson(res, 400, {
            error: {
              message: "Invalid JSON body",
              type: "invalid_request_error",
            },
          });
          return;
        }
        const validationError = validateResponsesRequest(parsed);
        if (validationError) {
          sendJson(res, 400, {
            error: {
              message: validationError,
              type:
                isRecord(parsed) && parsed.stream === true
                  ? "unsupported_parameter"
                  : "invalid_request_error",
            },
          });
          return;
        }
        const result = await upstream.responses(
          parsed as Record<string, unknown>,
        );
        if (result.kind === "stream") {
          await pipeStream(result.stream, res);
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      sendJson(res, 404, {
        error: {
          message: `Route not found: ${req.method} ${path}`,
          type: "not_found_error",
        },
      });
    } catch (err) {
      if (err instanceof RequestAbortedError) {
        if (!res.destroyed) res.destroy();
        return;
      }
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : undefined);
        return;
      }
      if (err instanceof RequestBodyTooLargeError) {
        sendJson(res, 413, {
          error: {
            message: err.message,
            type: "request_too_large",
          },
        });
        return;
      }
      sendJson(res, 500, {
        error: {
          message:
            err instanceof Error ? err.message : "Unexpected server error",
          type: "server_error",
        },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const boundHost = addr.address === "::" ? host : addr.address;
  const boundPort = addr.port;
  const urlHost = boundHost.includes(":") ? `[${boundHost}]` : boundHost;

  return {
    host: boundHost,
    port: boundPort,
    url: `http://${urlHost}:${boundPort}/v1`,
    upstreamUrl: upstream.getBaseUrl(),
    models,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
