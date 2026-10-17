import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { signPayload } from "../../src/core/signature.js";
import { MASTER_SECRET, NOW, createEndpoint, postWebhook, startServer } from "../helpers.js";

// These tests run the CLI as a real child process, exactly as a user would
// from a terminal, and check what it prints and its exit code.
// Most tests pass --timestamp so the output is the same on every run.

const CLI = path.join(import.meta.dirname, "..", "..", "src", "cli", "sign.js");
const PAYLOAD = '{"event":"payment.success","amount":4999}';
const SECRET = "whsec_" + "A".repeat(43);

// Only the variables we pass are visible to the CLI, so a real .env or shell
// variable can never leak into these tests.
function runCli(args, env = { WEBHOOK_ENDPOINT_SECRET: SECRET }) {
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

function assertFails(result, messagePattern) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, messagePattern);
}

test("prints the timestamp and signature headers, and never prints the secret", () => {
  const result = runCli([`--timestamp=${NOW}`, PAYLOAD]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `X-Webhook-Timestamp: ${NOW}\nX-Webhook-Signature: ${signPayload(SECRET, NOW, PAYLOAD)}\n`);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(SECRET));
});

test("different secrets give different signatures for the same payload", () => {
  const first = runCli([`--timestamp=${NOW}`, PAYLOAD]);
  const second = runCli([`--timestamp=${NOW}`, PAYLOAD], { WEBHOOK_ENDPOINT_SECRET: "whsec_" + "B".repeat(43) });

  assert.notEqual(
    parseHeaderLines(first.stdout)["X-Webhook-Signature"],
    parseHeaderLines(second.stdout)["X-Webhook-Signature"],
  );
});

test("options also work as two separate arguments", () => {
  const result = runCli(["--timestamp", String(NOW), PAYLOAD]);

  assert.equal(result.status, 0);
  assert.equal(parseHeaderLines(result.stdout)["X-Webhook-Timestamp"], String(NOW));
});

test("without --timestamp, the current time is used", () => {
  const before = Math.floor(Date.now() / 1000);
  const result = runCli([PAYLOAD]);
  const after = Math.floor(Date.now() / 1000);

  const timestamp = Number(parseHeaderLines(result.stdout)["X-Webhook-Timestamp"]);

  assert.equal(result.status, 0);
  assert.ok(timestamp >= before && timestamp <= after, `timestamp ${timestamp} not in [${before}, ${after}]`);
});

test("server accepts requests signed by the CLI with the endpoint's secret (API → CLI → HTTP → server)", async () => {
  const app = await startServer();

  try {
    const endpoint = await createEndpoint(app);
    const env = { WEBHOOK_ENDPOINT_SECRET: endpoint.secret };

    for (const payload of [PAYLOAD, '{\n  "pretty": true\n}', '{"name":"Zoë 🚀"}']) {
      const headers = parseHeaderLines(runCli([`--timestamp=${NOW}`, payload], env).stdout);
      const res = await postWebhook(app.baseUrl, endpoint.id, payload, headers);

      assert.equal(res.status, 200, `payload: ${payload}`);
      assert.equal((await res.json()).received, true);
    }

    // A CLI signature made with an old timestamp is rejected by the server.
    const oldHeaders = parseHeaderLines(runCli([`--timestamp=${NOW - 600}`, PAYLOAD], env).stdout);
    const res = await postWebhook(app.baseUrl, endpoint.id, PAYLOAD, oldHeaders);

    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "TIMESTAMP_TOO_OLD");
  } finally {
    app.close();
  }
});

test("fails with exit code 1 when WEBHOOK_ENDPOINT_SECRET is not set (the master secret is not enough)", () => {
  assertFails(runCli([PAYLOAD], {}), /WEBHOOK_ENDPOINT_SECRET is not set/);
  assertFails(runCli([PAYLOAD], { WEBHOOK_SECRET: MASTER_SECRET }), /WEBHOOK_ENDPOINT_SECRET is not set/);
});

test("fails with exit code 1 when WEBHOOK_ENDPOINT_SECRET is not an endpoint secret", () => {
  for (const value of ["secret", MASTER_SECRET, "whsec_short"]) {
    assertFails(runCli([PAYLOAD], { WEBHOOK_ENDPOINT_SECRET: value }), /does not look like an endpoint secret/);
  }
});

test("--endpoint (the old interface) explains what changed", () => {
  assertFails(runCli(["--endpoint=ep_0123456789abcdef", PAYLOAD]), /--endpoint is no longer used/);
  assertFails(runCli(["--endpoint", "ep_0123456789abcdef", PAYLOAD]), /--endpoint is no longer used/);
});

test("fails with exit code 1 for an invalid --timestamp", () => {
  for (const value of ["yesterday", "-60", "1.5", "1700000000000"]) {
    assertFails(runCli([`--timestamp=${value}`, PAYLOAD]), /--timestamp must be Unix time in whole seconds/);
  }
});

test("fails with exit code 1 for an unknown option", () => {
  assertFails(runCli(["--secret=oops", PAYLOAD]), /Unknown option/);
});

test("fails with exit code 1 when no payload is given", () => {
  assertFails(runCli([]), /No payload given/);
});

test("fails with exit code 1 when the payload is split into several arguments (forgot quotes)", () => {
  assertFails(runCli(['{"event":', '"payment.success"}']), /Expected 1 payload argument but got 2/);
});
