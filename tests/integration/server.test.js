import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createServer } from "../../src/app.js";
import { MASTER_SECRET, NOW, TOLERANCE, createEndpoint, postWebhook, signedHeaders, startServer } from "../helpers.js";

// Webhook verification and replay protection, tested over real HTTP against
// POST /api/webhooks/:endpointId. The server's clock is controlled by the test.

const BODY = '{"event":"payment.success","amount":4999}';

let app;
let endpoint;

// A fresh server per test: accepted signatures are remembered (replay
// protection), so tests must not share one.
test.beforeEach(async () => {
  app = await startServer();
  endpoint = await createEndpoint(app, "Payments");
});

test.afterEach(() => app.close());

function post(body, headers) {
  return postWebhook(app.baseUrl, endpoint.id, body, headers);
}

function signed(body, options) {
  return signedHeaders(endpoint, body, options);
}

async function assertAccepted(res) {
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.received, true);
  assert.match(json.eventId, /^evt_[0-9a-f]{16}$/);
}

async function assertRejected(res, status, code) {
  assert.equal(res.status, status);

  const json = await res.json();
  assert.equal(json.error.code, code);
  assert.match(json.eventId, /^evt_[0-9a-f]{16}$/);
}

// --- Replay protection -------------------------------------------------------

test("1. valid signature + current timestamp → 200", async () => {
  await assertAccepted(await post(BODY, signed(BODY)));
});

test("2. valid signature + old timestamp (1 hour ago) → 401", async () => {
  await assertRejected(await post(BODY, signed(BODY, { timestamp: NOW - 3600 })), 401, "TIMESTAMP_TOO_OLD");
});

test("3. valid signature + timestamp 1 hour in the future → 401", async () => {
  await assertRejected(await post(BODY, signed(BODY, { timestamp: NOW + 3600 })), 401, "TIMESTAMP_IN_FUTURE");
});

test("4. missing timestamp → 400", async () => {
  const { "X-Webhook-Signature": signature } = signed(BODY);

  await assertRejected(await post(BODY, { "X-Webhook-Signature": signature }), 400, "MISSING_TIMESTAMP");
});

test("5. malformed timestamp → 400", async () => {
  const malformed = [
    "yesterday",
    "-60", // negative
    "1700000000.5", // decimal
    "1e9", // exponent
    "1700000000000", // milliseconds instead of seconds
  ];

  for (const timestamp of malformed) {
    const res = await post(BODY, { ...signed(BODY), "X-Webhook-Timestamp": timestamp });

    await assertRejected(res, 400, "MALFORMED_TIMESTAMP");
  }
});

test("6. valid timestamp + signature made with the wrong secret → 401", async () => {
  await assertRejected(await post(BODY, signed(BODY, { secret: "wrong-secret" })), 401, "INVALID_SIGNATURE");
});

test("7. body modified after signing → 401", async () => {
  const tampered = '{"event":"payment.success","amount":1}';

  await assertRejected(await post(tampered, signed(BODY)), 401, "INVALID_SIGNATURE");
});

test("8. same valid request sent twice within the window → second is 409 REPLAY_DETECTED", async () => {
  const headers = signed(BODY);

  await assertAccepted(await post(BODY, headers));

  // A minute later: the timestamp alone would still pass, but the exact same
  // signature was already accepted.
  app.clock.now = NOW + 60;
  await assertRejected(await post(BODY, headers), 409, "REPLAY_DETECTED");
});

test("replays are refused whatever the hex case of the signature", async () => {
  const headers = signed(BODY);
  const upper = { ...headers, "X-Webhook-Signature": "sha256=" + headers["X-Webhook-Signature"].slice(7).toUpperCase() };

  await assertAccepted(await post(BODY, headers));
  await assertRejected(await post(BODY, upper), 409, "REPLAY_DETECTED");
});

test("the same body re-signed with a new timestamp is a new delivery, not a replay", async () => {
  await assertAccepted(await post(BODY, signed(BODY)));
  await assertAccepted(await post(BODY, signed(BODY, { timestamp: NOW + 1 })));
});

test("a rejected request is not remembered: sending it correctly afterwards works", async () => {
  const headers = signed(BODY);

  await assertRejected(await post(`${BODY}\n`, headers), 401, "INVALID_SIGNATURE");
  await assertAccepted(await post(BODY, headers));
});

test("replay protection is per endpoint", async () => {
  const other = await createEndpoint(app, "Other");
  const sameSecretHeaders = signed(BODY);

  await assertAccepted(await post(BODY, sameSecretHeaders));
  // Different endpoint, different secret: its own fresh request is accepted.
  await assertAccepted(await postWebhook(app.baseUrl, other.id, BODY, signedHeaders(other, BODY)));
});

test("9. timestamp exactly at the tolerance boundary → 200 (both directions)", async () => {
  await assertAccepted(await post(BODY, signed(BODY, { timestamp: NOW - TOLERANCE })));
  await assertAccepted(await post(BODY, signed(BODY, { timestamp: NOW + TOLERANCE })));
});

test("10. timestamp one second outside the tolerance → 401 (both directions)", async () => {
  await assertRejected(await post(BODY, signed(BODY, { timestamp: NOW - TOLERANCE - 1 })), 401, "TIMESTAMP_TOO_OLD");
  await assertRejected(await post(BODY, signed(BODY, { timestamp: NOW + TOLERANCE + 1 })), 401, "TIMESTAMP_IN_FUTURE");
});

test("captured request replayed after the window has passed → 401", async () => {
  const captured = signed(BODY);

  await assertAccepted(await post(BODY, captured));

  // Six minutes later, an attacker resends the exact same request.
  app.clock.now = NOW + 360;
  await assertRejected(await post(BODY, captured), 401, "TIMESTAMP_TOO_OLD");
});

test("attacker refreshes the timestamp but reuses the captured signature → 401", async () => {
  const captured = signed(BODY, { timestamp: NOW - 3600 });
  const refreshed = { ...captured, "X-Webhook-Timestamp": String(NOW) };

  await assertRejected(await post(BODY, refreshed), 401, "INVALID_SIGNATURE");
});

test("the tolerance is configurable per server", async () => {
  const strict = await startServer({ toleranceSeconds: 60 });

  try {
    const strictEndpoint = await createEndpoint(strict);
    const headers = signedHeaders(strictEndpoint, BODY, { timestamp: NOW - 61 });

    await assertRejected(await postWebhook(strict.baseUrl, strictEndpoint.id, BODY, headers), 401, "TIMESTAMP_TOO_OLD");
  } finally {
    strict.close();
  }
});

// --- Per-endpoint secrets ----------------------------------------------------

test("a signature made for one endpoint is rejected by another endpoint", async () => {
  const other = await createEndpoint(app, "Other");

  await assertRejected(await post(BODY, signedHeaders(other, BODY)), 401, "INVALID_SIGNATURE");
});

test("signing with the master secret is rejected (only the endpoint's own secret works)", async () => {
  await assertRejected(await post(BODY, signed(BODY, { secret: MASTER_SECRET })), 401, "INVALID_SIGNATURE");
});

// --- Signature checks (from Milestones 1 and 2) -------------------------------

test("missing signature → 401", async () => {
  await assertRejected(await post(BODY, { "X-Webhook-Timestamp": String(NOW) }), 401, "MISSING_SIGNATURE");
});

test("malformed signature → 400", async () => {
  const validHex = signed(BODY)["X-Webhook-Signature"].slice("sha256=".length);

  const malformed = [
    "not-a-signature",
    validHex, // missing "sha256=" prefix
    "md5=" + validHex, // wrong algorithm
    "sha256=" + "z".repeat(64), // right length, but not hex
  ];

  for (const signature of malformed) {
    const res = await post(BODY, { ...signed(BODY), "X-Webhook-Signature": signature });

    await assertRejected(res, 400, "MALFORMED_SIGNATURE");
  }
});

test("signature with the wrong length → 400, and the server keeps working", async () => {
  const validHex = signed(BODY)["X-Webhook-Signature"].slice("sha256=".length);

  const wrongLengths = [
    "sha256=" + validHex.slice(0, 62), // one byte too short
    "sha256=" + validHex + "ab", // one byte too long
    "sha256=" + "a".repeat(1000), // far too long
  ];

  for (const signature of wrongLengths) {
    const res = await post(BODY, { ...signed(BODY), "X-Webhook-Signature": signature });

    await assertRejected(res, 400, "MALFORMED_SIGNATURE");
  }

  // crypto.timingSafeEqual throws on buffers of different lengths. If that ever
  // happened, the request would crash. A valid request afterwards proves the
  // server is still healthy.
  await assertAccepted(await post(BODY, signed(BODY)));
});

test("same JSON data with different formatting → 401, because the exact bytes are signed", async () => {
  const compact = '{"event":"payment.success","amount":4999}';
  const pretty = '{\n  "event": "payment.success",\n  "amount": 4999\n}';

  // Both strings hold the same data once parsed...
  assert.deepEqual(JSON.parse(compact), JSON.parse(pretty));

  // ...but they are different bytes, so a signature for one does not match the other.
  await assertRejected(await post(pretty, signed(compact)), 401, "INVALID_SIGNATURE");

  // Signing the exact bytes that are sent works.
  await assertAccepted(await post(pretty, signed(pretty)));
});

test("non-ASCII body bytes are verified exactly", async () => {
  const body = '{"name":"Zoë 🚀"}';

  await assertAccepted(await post(body, signed(body)));
});

test("webhook bodies do not have to be JSON (they are opaque signed bytes)", async () => {
  const body = "plain text, not JSON";

  await assertAccepted(await post(body, signed(body)));
});

// --- Configuration ------------------------------------------------------------

test("createServer refuses invalid options", () => {
  const valid = { masterSecret: MASTER_SECRET, toleranceSeconds: 300, maxBodyBytes: 1024 };

  assert.throws(() => createServer({ ...valid, masterSecret: "" }), /masterSecret/);

  for (const toleranceSeconds of [undefined, 0, -5, 1.5, "300"]) {
    assert.throws(() => createServer({ ...valid, toleranceSeconds }), /toleranceSeconds/);
  }

  for (const maxBodyBytes of [undefined, 0, -1, 1.5, "1024"]) {
    assert.throws(() => createServer({ ...valid, maxBodyBytes }), /maxBodyBytes/);
  }
});

test("server process exits with an error for bad configuration", () => {
  const SERVER = path.join(import.meta.dirname, "..", "..", "src", "server.js");

  const badConfigs = [
    [{}, /WEBHOOK_SECRET is not set/],
    [{ WEBHOOK_SECRET: "your_secret_here" }, /WEBHOOK_SECRET is not set/],
    [{ WEBHOOK_SECRET: MASTER_SECRET, WEBHOOK_TOLERANCE_SECONDS: "five minutes" }, /WEBHOOK_TOLERANCE_SECONDS/],
    [{ WEBHOOK_SECRET: MASTER_SECRET, WEBHOOK_TOLERANCE_SECONDS: "0" }, /WEBHOOK_TOLERANCE_SECONDS/],
    [{ WEBHOOK_SECRET: MASTER_SECRET, WEBHOOK_MAX_BODY_SIZE: "1MB" }, /WEBHOOK_MAX_BODY_SIZE/],
    [{ WEBHOOK_SECRET: MASTER_SECRET, TRUST_PROXY: "yes" }, /TRUST_PROXY/],
  ];

  for (const [env, expectedError] of badConfigs) {
    const result = spawnSync(process.execPath, [SERVER], { env, encoding: "utf8" });

    assert.equal(result.status, 1, `env: ${JSON.stringify(env)}`);
    assert.match(result.stderr, expectedError);
  }
});
