import assert from "node:assert/strict";
import test from "node:test";
import {
  GeminiUpstream,
  createOpenAIStreamFromGemini,
} from "../dist/upstream.js";
import { normalizeBaseUrl } from "../dist/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const readAll = async (stream) => {
  const reader = stream.getReader();
  let result = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return result;
    result += decoder.decode(next.value, { stream: true });
  }
};

test("SSE conversion accepts fragmented multi-line data events", async () => {
  const payload = JSON.stringify(
    {
      response: {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "hello" }] },
            finishReason: "STOP",
          },
        ],
      },
    },
    null,
    2,
  );
  const event = `${payload
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n")}\n\n`;
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(event.slice(0, 17)));
      controller.enqueue(encoder.encode(event.slice(17)));
      controller.close();
    },
  });

  const output = await readAll(createOpenAIStreamFromGemini(source, "model"));
  assert.match(output, /"object":"chat\.completion\.chunk"/);
  assert.match(output, /"content":"hello"/);
  assert.ok(output.endsWith("data: [DONE]\n\n"));
});

test("downstream cancellation is propagated to the upstream SSE reader", async () => {
  let canceled = false;
  const source = new ReadableStream({
    pull() {
      // Keep the stream open until the downstream consumer cancels.
    },
    cancel() {
      canceled = true;
    },
  });
  const converted = createOpenAIStreamFromGemini(source, "model");
  await converted.getReader().cancel("test complete");
  assert.equal(canceled, true);
});

test("malformed SSE JSON fails instead of silently returning DONE", async () => {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: {not-json}\n\n"));
      controller.close();
    },
  });
  await assert.rejects(
    readAll(createOpenAIStreamFromGemini(source, "model")),
    /Malformed JSON/,
  );
});

test("Responses streaming is rejected with a protocol-specific error", async () => {
  const upstream = new GeminiUpstream({ auth: {} });
  const result = await upstream.responses({
    model: "model",
    input: "hello",
    stream: true,
  });
  assert.equal(result.kind, "error");
  assert.equal(result.status, 400);
  assert.equal(result.body.error.type, "unsupported_parameter");
});

test("upstream dispatches to configured custom url", async () => {
  let requestedUrl = null;
  const mockFetch = async (url) => {
    requestedUrl = url;
    return new Response(
      JSON.stringify({
        response: {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "custom url ok" }] },
              finishReason: "STOP",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const mockAuth = {
    ensureProjectId: async () => "test-project",
    getAccessToken: async () => "test-token",
  };
  const upstream = new GeminiUpstream({
    auth: mockAuth,
    fetch: mockFetch,
    url: "https://cloudcode-pa.googleapis.com/v1internal",
  });

  assert.equal(
    upstream.getBaseUrl(),
    "https://cloudcode-pa.googleapis.com/v1internal",
  );

  const result = await upstream.chatCompletions({
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.kind, "json");
  assert.equal(result.status, 200);
  assert.equal(
    requestedUrl,
    "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
  );
});

test("normalizeBaseUrl handles various URL formats", () => {
  assert.equal(
    normalizeBaseUrl("https://cloudcode-pa.googleapis.com/v1internal"),
    "https://cloudcode-pa.googleapis.com/v1internal",
  );
  assert.equal(
    normalizeBaseUrl("https://cloudcode-pa.googleapis.com/v1internal/"),
    "https://cloudcode-pa.googleapis.com/v1internal",
  );
  assert.equal(
    normalizeBaseUrl("https://cloudcode-pa.googleapis.com"),
    "https://cloudcode-pa.googleapis.com/v1internal",
  );
  assert.equal(
    normalizeBaseUrl("https://cloudcode-pa.googleapis.com/"),
    "https://cloudcode-pa.googleapis.com/v1internal",
  );
  assert.equal(
    normalizeBaseUrl("http://localhost:8080/custom/api"),
    "http://localhost:8080/custom/api",
  );
  assert.equal(
    normalizeBaseUrl(),
    "https://daily-cloudcode-pa.googleapis.com/v1internal",
  );
});
