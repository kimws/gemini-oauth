import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const runCli = (...args) =>
  spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
  });

test("CLI version comes from package.json", () => {
  const result = runCli("--version");
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), `gemini-oauth ${packageJson.version}`);
});

test("CLI rejects invalid ports before starting auth or a server", () => {
  for (const value of ["0", "1.5", "65536", "not-a-port"]) {
    const result = runCli("--port", value);
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /Invalid --port/, value);
  }
});

test("CLI rejects invalid login timeouts", () => {
  const result = runCli("login", "--timeout-ms", "0", "--no-open");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid --timeout-ms/);
});

test("CLI requires explicit opt-in for a non-loopback bind", () => {
  const result = runCli("--host", "0.0.0.0");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /without --allow-remote/);
});

test("CLI rejects invalid URLs", () => {
  for (const value of ["not-a-url", "ftp://invalid-protocol.com"]) {
    const result = runCli("--url", value);
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /Invalid --url/, value);
  }
});

test("CLI help lists --url option", () => {
  const result = runCli("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--url <url>/);
});

test("package bin metadata uses a publish-safe relative path", () => {
  assert.equal(packageJson.bin["gemini-oauth"], "dist/cli.js");
});
