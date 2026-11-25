import assert from "node:assert/strict";
import test from "node:test";
import {
  antigravityProxyCreds,
  parseAntigravityKeyringSecret,
} from "../dist/antigravity-keyring.js";

const sample = {
  token: {
    access_token: "access-token",
    refresh_token: "refresh-token",
    token_type: "Bearer",
    expiry: "2026-11-25T02:02:35.811Z",
  },
};

test("parse Linux Secret Service JSON without exposing a need to refresh via Gemini CLI", () => {
  const parsed = parseAntigravityKeyringSecret(JSON.stringify(sample));
  assert.equal(parsed?.accessToken, "access-token");
  assert.equal(parsed?.refreshToken, "refresh-token");
  assert.equal(parsed?.tokenType, "Bearer");
  assert.equal(parsed?.expiresAt?.toISOString(), "2026-11-25T02:02:35.811Z");
});

test("parse macOS Keychain prefix:base64 payload", () => {
  const encoded = Buffer.from(JSON.stringify(sample), "utf8").toString("base64");
  const parsed = parseAntigravityKeyringSecret(`6f:${encoded}`);
  assert.equal(parsed?.accessToken, "access-token");
  assert.equal(parsed?.refreshToken, "refresh-token");
  assert.equal(parsed?.expiresAt?.toISOString(), "2026-11-25T02:02:35.811Z");
});

test("parse a flat access token and numeric millisecond expiry", () => {
  const parsed = parseAntigravityKeyringSecret(
    JSON.stringify({
      access_token: "flat-access",
      expiry_date: Date.parse("2026-11-25T03:00:00.000Z"),
    }),
  );
  assert.equal(parsed?.accessToken, "flat-access");
  assert.equal(parsed?.refreshToken, undefined);
  assert.equal(parsed?.expiresAt?.toISOString(), "2026-11-25T03:00:00.000Z");
});

test("proxy credentials copied from the keyring omit the refresh token", () => {
  const parsed = parseAntigravityKeyringSecret(JSON.stringify(sample));
  const creds = antigravityProxyCreds(parsed);
  assert.equal(creds.access_token, "access-token");
  assert.equal(creds.source, "antigravity-keyring");
  assert.equal("refresh_token" in creds, false);
});

test("reject empty, non-json, and token-less secrets", () => {
  assert.equal(parseAntigravityKeyringSecret(""), null);
  assert.equal(parseAntigravityKeyringSecret(null), null);
  assert.equal(parseAntigravityKeyringSecret("not-a-secret"), null);
  assert.equal(parseAntigravityKeyringSecret(JSON.stringify({ token: {} })), null);
  assert.equal(parseAntigravityKeyringSecret("prefix:not-base64"), null);
});
