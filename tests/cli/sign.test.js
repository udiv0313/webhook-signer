import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { deriveEndpointSecret, signPayload } from "../../src/core/signature.js";
import { MASTER_SECRET, NOW, createEndpoint, postWebhook, startServer } from "../helpers.js";

// These tests run the CLI as a real child process, exactly as a user would
// from a terminal, and check what it prints and its exit code.
// Most tests pass --timestamp so the output is the same on every run.

const CLI = path.join(import.meta.dirname, "..", "..", "src", "cli", "sign.js");
const PAYLOAD = '{"event":"payment.success","amount":4999}';
const ENDPOINT_ID = "ep_0123456789abcdef";

// Only the variables we pass are visible to the CLI, so a real .env or shell
// WEBHOOK_SECRET can never leak into these tests.
function runCli(args, env = { WEBHOOK_SECRET: MASTER_SECRET }) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

// "Name: value\nName: value\n" → { Name: "value", Name: "value" }
function parseHeaderLines(output) {
  const headers = {};

  for (const line of output.trim().split("\n")) {
    const separator = line.indexOf(": ");
    headers[line.slice(0, separator)] = line.slice(separator + 2);
  }

  return headers;
}

test("prints the timestamp and signature headers for the endpoint, and never prints a secret", () => {
  const result = runCli([`--endpoint=${ENDPOINT_ID}`, `--timestamp=${NOW}`, PAYLOAD]);
  const endpointSecret = deriveEndpointSecret(MASTER_SECRET, ENDPOINT_ID);

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    `X-Webhook-Timestamp: ${NOW}\nX-Webhook-Signature: ${signPayload(endpointSecret, NOW, PAYLOAD)}\n`,
  );
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(MASTER_SECRET));
  assert.ok(!result.stdout.includes(endpointSecret.toString("hex")));
});

test("different endpoints get different signatures for the same payload", () => {
  const first = runCli([`--endpoint=${ENDPOINT_ID}`, `--timestamp=${NOW}`, PAYLOAD]);
  const second = runCli(["--endpoint=ep_fedcba9876543210", `--timestamp=${NOW}`, PAYLOAD]);

  assert.notEqual(
    parseHeaderLines(first.stdout)["X-Webhook-Signature"],
    parseHeaderLines(second.stdout)["X-Webhook-Signature"],
  );
});

test("options also work as two separate arguments", () => {
  const result = runCli(["--endpoint", ENDPOINT_ID, "--timestamp", String(NOW), PAYLOAD]);

  assert.equal(result.status, 0);
  assert.equal(parseHeaderLines(result.stdout)["X-Webhook-Timestamp"], String(NOW));
});

test("without --timestamp, the current time is used", () => {
  const before = Math.floor(Date.now() / 1000);
  const result = runCli([`--endpoint=${ENDPOINT_ID}`, PAYLOAD]);
  const after = Math.floor(Date.now() / 1000);

  const timestamp = Number(parseHeaderLines(result.stdout)["X-Webhook-Timestamp"]);

  assert.equal(result.status, 0);
  assert.ok(timestamp >= before && timestamp <= after, `timestamp ${timestamp} not in [${before}, ${after}]`);
});

test("server accepts requests signed by the CLI (API → CLI → HTTP → server)", async () => {
  const app = await startServer();

  try {
    const endpoint = await createEndpoint(app.baseUrl);

    for (const payload of [PAYLOAD, '{\n  "pretty": true\n}', '{"name":"Zoë 🚀"}']) {
      const headers = parseHeaderLines(runCli([`--endpoint=${endpoint.id}`, `--timestamp=${NOW}`, payload]).stdout);

      const res = await postWebhook(app.baseUrl, endpoint.id, payload, headers);

      assert.equal(res.status, 200, `payload: ${payload}`);
      assert.equal((await res.json()).received, true);
    }

    // A CLI signature made with an old timestamp is rejected by the server.
    const oldHeaders = parseHeaderLines(runCli([`--endpoint=${endpoint.id}`, `--timestamp=${NOW - 600}`, PAYLOAD]).stdout);
    const res = await postWebhook(app.baseUrl, endpoint.id, PAYLOAD, oldHeaders);

    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "TIMESTAMP_TOO_OLD");
  } finally {
    app.close();
  }
});

test("fails with exit code 1 when --endpoint is missing", () => {
  const result = runCli([PAYLOAD]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--endpoint is required/);
});

test("fails with exit code 1 for an invalid --timestamp", () => {
  for (const value of ["yesterday", "-60", "1.5", "1700000000000"]) {
    const result = runCli([`--endpoint=${ENDPOINT_ID}`, `--timestamp=${value}`, PAYLOAD]);

    assert.equal(result.status, 1, `value: ${value}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--timestamp must be Unix time in whole seconds/);
  }
});

test("fails with exit code 1 for an unknown option", () => {
  const result = runCli([`--endpoint=${ENDPOINT_ID}`, "--secret=oops", PAYLOAD]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown option/);
});

test("fails with exit code 1 when WEBHOOK_SECRET is not set", () => {
  const result = runCli([`--endpoint=${ENDPOINT_ID}`, PAYLOAD], {});

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /WEBHOOK_SECRET is not set/);
});

test("fails with exit code 1 when no payload is given", () => {
  const result = runCli([`--endpoint=${ENDPOINT_ID}`]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /No payload given/);
});

test("fails with exit code 1 when the payload is split into several arguments (forgot quotes)", () => {
  const result = runCli([`--endpoint=${ENDPOINT_ID}`, '{"event":', '"payment.success"}']);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Expected 1 payload argument but got 2/);
});
