import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GeminiAuthStore } from "../dist/auth.js";
import { startGeminiOAuthServer } from "../dist/server.js";
import { createLogger, CODE_ASSIST_PROD_BASE } from "../dist/index.js";

const makeServer = async (options = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "gemini-oauth-test-"));
  const auth = new GeminiAuthStore({
    authFilePath: join(directory, "oauth.json"),
    stateFilePath: join(directory, "state.json"),
    projectId: "project-test",
    useAntigravityKeyring: false,
  });
  auth.saveOAuthTokens({ accessToken: "test-token", expiresIn: 3600 });
  const fetch = async () =>
    new Response(
      JSON.stringify({
        response: {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "ok" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            totalTokenCount: 2,
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const server = await startGeminiOAuthServer({
    auth,
    host: "127.0.0.1",
    port: 0,
    models: ["model-test"],
    fetch,
    maxBodyBytes: 256,
    ...options,
  });
  return {
    server,
    cleanup: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

test("server validates JSON shapes, size, and Responses stream mode", async () => {
  const { server, cleanup } = await makeServer();
  try {
    const health = await fetch(`${server.url.replace(/\/v1$/, "")}/health`);
    const healthBody = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.upstream, "daily-cloudcode-pa.googleapis.com");

    const nullChat = await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      body: "null",
    });
    assert.equal(nullChat.status, 400);

    const invalidMessage = await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model-test", messages: [null] }),
    });
    assert.equal(invalidMessage.status, 400);

    const responsesStream = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model-test", input: "hello", stream: true }),
    });
    assert.equal(responsesStream.status, 400);
    assert.equal((await responsesStream.json()).error.type, "unsupported_parameter");

    const oversized = await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(300),
    });
    assert.equal(oversized.status, 413);

    const valid = await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "model-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).choices[0].message.content, "ok");
  } finally {
    await cleanup();
  }
});

test("IPv6 server URLs use brackets", async (t) => {
  let fixture;
  try {
    fixture = await makeServer({ host: "::1" });
  } catch (error) {
    if (["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error?.code)) {
      t.skip("IPv6 loopback is unavailable");
      return;
    }
    throw error;
  }
  try {
    assert.match(fixture.server.url, /^http:\/\/\[::1\]:\d+\/v1$/);
  } finally {
    await fixture.cleanup();
  }
});

test("server uses configured production Code Assist url", async () => {
  const { server, cleanup } = await makeServer({
    url: CODE_ASSIST_PROD_BASE,
    logLevel: "silent",
  });
  try {
    const health = await fetch(`${server.url.replace(/\/v1$/, "")}/health`);
    const healthBody = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.upstream, "cloudcode-pa.googleapis.com");
    assert.equal(
      server.upstreamUrl,
      "https://cloudcode-pa.googleapis.com/v1internal",
    );
  } finally {
    await cleanup();
  }
});

test("server logger captures requests at info level and respects silent level", async () => {
  const logs = [];
  const writer = (level, line) => {
    logs.push({ level, line });
  };
  const logger = createLogger({ level: "info", writer });

  const { server, cleanup } = await makeServer({ logger });
  try {
    const modelsRes = await fetch(`${server.url}/models`);
    assert.equal(modelsRes.status, 200);

    const infoLogs = logs.filter((l) => l.level === "info");
    assert.ok(infoLogs.length >= 1);
    assert.ok(infoLogs.some((l) => l.line.includes("GET /v1/models 200")));
  } finally {
    await cleanup();
  }

  // Silent mode emits no logs
  const silentLogs = [];
  const silentLogger = createLogger({
    level: "silent",
    writer: (level, line) => silentLogs.push({ level, line }),
  });
  const silentFixture = await makeServer({ logger: silentLogger });
  try {
    await fetch(`${silentFixture.server.url}/models`);
    assert.equal(silentLogs.length, 0);
  } finally {
    await silentFixture.cleanup();
  }
});
