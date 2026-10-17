import test from "node:test";
import assert from "node:assert/strict";
import { MASTER_SECRET, NOW, TOLERANCE, createEndpoint, startServer } from "../helpers.js";

// POST /api/endpoints/:endpointId/test-webhooks
// The server signs a test webhook itself and delivers it to its own webhook
// route, so the browser never needs a secret. Tested over real HTTP.

const PAYLOAD = '{"event":"payment.success","amount":4999}';

let app;
let endpoint;

test.beforeEach(async () => {
  app = await startServer({ testSenderEnabled: true });
  endpoint = await createEndpoint(app);
});

test.afterEach(() => {
  app.close();
});

function sendTest(body, { endpointId = endpoint.id, contentType = "application/json", client = app } = {}) {
  return client.fetch(`/api/endpoints/${endpointId}/test-webhooks`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function getEvent(eventId) {
  return (await app.fetch(`/api/events/${eventId}`)).json();
}

// --- Scenarios go through the real verification --------------------------------

const scenarios = [
  ["valid", 200, "VALID"],
  ["invalid_signature", 401, "INVALID_SIGNATURE"],
  ["tampered_body", 401, "INVALID_SIGNATURE"],
  ["expired_timestamp", 401, "TIMESTAMP_TOO_OLD"],
  ["missing_signature", 401, "MISSING_SIGNATURE"],
  ["malformed_timestamp", 400, "MALFORMED_TIMESTAMP"],
];

for (const [scenario, expectedStatus, expectedCode] of scenarios) {
  test(`scenario "${scenario}" → webhook answered ${expectedStatus} ${expectedCode}, and recorded`, async () => {
    const res = await sendTest({ payload: PAYLOAD, scenario });
    const result = await res.json();

    // The test-sender call itself succeeded; the webhook result is inside.
    assert.equal(res.status, 200);
    assert.equal(result.scenario, scenario);
    assert.equal(result.response.status, expectedStatus);
    assert.match(result.eventId, /^evt_[0-9a-f]{16}$/);

    const event = await getEvent(result.eventId);

    assert.equal(event.endpointId, endpoint.id);
    assert.equal(event.verification.code, expectedCode);
    assert.equal(event.response.status, expectedStatus);
    assert.deepEqual(event.response.body, result.response.body);
    assert.equal(event.request.headers["user-agent"], "webhook-signer-test-sender");
  });
}

test("the valid scenario sends the payload bytes exactly as given", async () => {
  const payload = '{\n  "pretty": true,\n  "name": "Zoë 🚀"\n}';

  const result = await (await sendTest({ payload, scenario: "valid" })).json();
  const event = await getEvent(result.eventId);

  assert.equal(result.response.status, 200);
  assert.equal(event.request.body, payload);
});

test("scenario defaults to valid", async () => {
  const result = await (await sendTest({ payload: PAYLOAD })).json();

  assert.equal(result.scenario, "valid");
  assert.equal(result.response.status, 200);
});

test("tampered_body adds a trailing newline after signing", async () => {
  const result = await (await sendTest({ payload: PAYLOAD, scenario: "tampered_body" })).json();
  const event = await getEvent(result.eventId);

  assert.equal(event.request.body, `${PAYLOAD}\n`);
});

test("expired_timestamp is outside the tolerance; malformed_timestamp is in milliseconds", async () => {
  const expired = await getEvent((await (await sendTest({ payload: PAYLOAD, scenario: "expired_timestamp" })).json()).eventId);
  const malformed = await getEvent((await (await sendTest({ payload: PAYLOAD, scenario: "malformed_timestamp" })).json()).eventId);

  assert.equal(expired.verification.timestampAgeSeconds, TOLERANCE + 60);
  assert.equal(malformed.request.headers["x-webhook-timestamp"], String(NOW * 1000));
});

test("the response never contains a secret or a full signature", async () => {
  const res = await sendTest({ payload: PAYLOAD, scenario: "valid" });
  const text = await res.text();

  assert.ok(!text.includes(MASTER_SECRET));
  assert.ok(!text.includes(endpoint.secret));
  assert.ok(!/sha256=[0-9a-f]{64}/.test(text));
});

// --- Guards ------------------------------------------------------------------

test("disabled by default → 403 TEST_SENDER_DISABLED", async () => {
  const locked = await startServer();

  try {
    const lockedEndpoint = await createEndpoint(locked);
    const res = await sendTest({ payload: PAYLOAD }, { client: locked, endpointId: lockedEndpoint.id });

    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "TEST_SENDER_DISABLED");
  } finally {
    locked.close();
  }
});

test("requires Content-Type: application/json → 415 otherwise (blocks cross-site form posts)", async () => {
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) {
    const res = await sendTest({ payload: PAYLOAD }, { contentType });

    assert.equal(res.status, 415, contentType);
    assert.equal((await res.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");
  }

  const withCharset = await sendTest({ payload: PAYLOAD }, { contentType: "application/json; charset=utf-8" });
  assert.equal(withCharset.status, 200);
  await withCharset.json();
});

test("unknown endpoint → 404, malformed endpoint ID → 400", async () => {
  const unknown = await sendTest({ payload: PAYLOAD }, { endpointId: "ep_0000000000000000" });
  const malformed = await sendTest({ payload: PAYLOAD }, { endpointId: "nope" });

  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "ENDPOINT_NOT_FOUND");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "INVALID_ENDPOINT_ID");
});

test("invalid input → 400", async () => {
  const cases = [
    ['{"payload":', "INVALID_JSON"],
    [{}, "VALIDATION_ERROR"],
    [{ payload: { event: "not a string" } }, "VALIDATION_ERROR"],
    [{ payload: PAYLOAD, scenario: "explode" }, "VALIDATION_ERROR"],
  ];

  for (const [body, code] of cases) {
    const res = await sendTest(body);

    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error.code, code);
  }
});

test("GET on the test-sender route → 405", async () => {
  const res = await fetch(`${app.baseUrl}/api/endpoints/${endpoint.id}/test-webhooks`);

  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  await res.json();
});
