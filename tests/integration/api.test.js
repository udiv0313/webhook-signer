import test from "node:test";
import assert from "node:assert/strict";
import {
  MASTER_SECRET,
  MAX_BODY_BYTES,
  NOW,
  createEndpoint,
  postWebhook,
  signedHeaders,
  startServer,
} from "../helpers.js";

// The management API (endpoints, events) and HTTP error handling, tested over
// real HTTP. Each test starts its own server, so in-memory data never leaks
// between tests.

const BODY = '{"event":"payment.success","amount":4999}';
const UNKNOWN_ENDPOINT_ID = "ep_0000000000000000";

let app;

test.beforeEach(async () => {
  app = await startServer();
});

test.afterEach(() => {
  app.close();
});

function api(path, options) {
  return app.fetch(path, options);
}

function postJson(path, body) {
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

async function assertError(res, status, code) {
  assert.equal(res.status, status);

  const json = await res.json();
  assert.equal(json.error.code, code);
  assert.equal(typeof json.error.message, "string");

  return json;
}

// Endpoint secrets appear only in the response that created (or rotated)
// them. Every other response must contain neither them nor the master secret.
function assertNoSecrets(text, endpoint) {
  assert.ok(!text.includes(MASTER_SECRET), "master secret leaked");
  assert.ok(!text.includes(endpoint.secret), "endpoint secret leaked");
  assert.ok(!text.includes("whsec_"), "an endpoint secret leaked");
}

// An endpoint as GET /api/endpoints shows it: everything except the secret.
function withoutSecret({ secret, ...endpoint }) {
  return endpoint;
}

// --- 1. / 2. Endpoints -------------------------------------------------------

test("1. POST /api/endpoints creates an endpoint (201) and returns its random secret, once", async () => {
  const res = await postJson("/api/endpoints", JSON.stringify({ name: "Stripe Payments" }));
  const text = await res.text();
  const endpoint = JSON.parse(text);

  assert.equal(res.status, 201);
  assert.match(endpoint.id, /^ep_[0-9a-f]{16}$/);
  assert.deepEqual(endpoint, {
    id: endpoint.id,
    name: "Stripe Payments",
    status: "active",
    createdAt: "2023-11-14T22:13:20.000Z",
    webhookPath: `/api/webhooks/${endpoint.id}`,
    recentEventCount: 0,
    secret: endpoint.secret,
  });
  assert.match(endpoint.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.ok(!text.includes(MASTER_SECRET));
});

test("every endpoint gets a different random secret", async () => {
  const first = await createEndpoint(app, "First");
  const second = await createEndpoint(app, "Second");

  assert.notEqual(first.secret, second.secret);
});

test("2. GET /api/endpoints lists endpoints in creation order, without secrets", async () => {
  const first = await createEndpoint(app, "First");
  const second = await createEndpoint(app, "Second");

  const res = await api("/api/endpoints");
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text), { endpoints: [withoutSecret(first), withoutSecret(second)] });
  assertNoSecrets(text, first);
  assertNoSecrets(text, second);
});

test("GET /api/endpoints returns an empty list before anything is created", async () => {
  const res = await api("/api/endpoints");

  assert.deepEqual(await res.json(), { endpoints: [] });
});

test("endpoint names are trimmed", async () => {
  const endpoint = await createEndpoint(app, "  Spaced Name  ");

  assert.equal(endpoint.name, "Spaced Name");
});

test("invalid endpoint names → 400 VALIDATION_ERROR", async () => {
  const invalidBodies = [{}, { name: "" }, { name: "   " }, { name: 42 }, { name: "x".repeat(101) }, [], null];

  for (const body of invalidBodies) {
    await assertError(await postJson("/api/endpoints", JSON.stringify(body)), 400, "VALIDATION_ERROR");
  }
});

// --- 12. Malformed JSON ------------------------------------------------------

test("12. malformed JSON in POST /api/endpoints → 400 INVALID_JSON", async () => {
  for (const body of ['{"name":', "not json", ""]) {
    await assertError(await postJson("/api/endpoints", body), 400, "INVALID_JSON");
  }
});

// --- 3. Unknown / invalid IDs ------------------------------------------------

test("3. unknown endpoint → 404 ENDPOINT_NOT_FOUND (webhooks and events)", async () => {
  const headers = signedHeaders({ id: UNKNOWN_ENDPOINT_ID, secret: "whsec_unknown" }, BODY);

  await assertError(await postWebhook(app.baseUrl, UNKNOWN_ENDPOINT_ID, BODY, headers), 404, "ENDPOINT_NOT_FOUND");
  await assertError(await api(`/api/endpoints/${UNKNOWN_ENDPOINT_ID}/events`), 404, "ENDPOINT_NOT_FOUND");
});

test("endpoint IDs that are not in the ep_<16 hex> format → 400 INVALID_ENDPOINT_ID", async () => {
  for (const badId of ["123", "ep_XYZ", "ep_0123456789abcdef0", "..%2F..%2Fetc"]) {
    await assertError(await postWebhook(app.baseUrl, badId, BODY), 400, "INVALID_ENDPOINT_ID");
    await assertError(await api(`/api/endpoints/${badId}/events`), 400, "INVALID_ENDPOINT_ID");
  }
});

test("unknown or malformed event IDs → 404 EVENT_NOT_FOUND / 400 INVALID_EVENT_ID", async () => {
  await assertError(await api("/api/events/evt_0000000000000000"), 404, "EVENT_NOT_FOUND");
  await assertError(await api("/api/events/nope"), 400, "INVALID_EVENT_ID");
});

// --- 4. / 5. / 6. Receiving webhooks -----------------------------------------

test("4. valid webhook → 200 with an eventId", async () => {
  const endpoint = await createEndpoint(app);

  const res = await postWebhook(app.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY));
  const json = await res.json();

  assert.equal(res.status, 200);
  assert.equal(json.received, true);
  assert.match(json.eventId, /^evt_[0-9a-f]{16}$/);
});

test("5. invalid signature → 401 INVALID_SIGNATURE with an eventId", async () => {
  const endpoint = await createEndpoint(app);
  const headers = signedHeaders(endpoint, BODY, { secret: "wrong-secret" });

  const json = await assertError(await postWebhook(app.baseUrl, endpoint.id, BODY, headers), 401, "INVALID_SIGNATURE");

  assert.match(json.eventId, /^evt_[0-9a-f]{16}$/);
});

test("6. expired timestamp → 401 TIMESTAMP_TOO_OLD", async () => {
  const endpoint = await createEndpoint(app);
  const headers = signedHeaders(endpoint, BODY, { timestamp: NOW - 600 });

  await assertError(await postWebhook(app.baseUrl, endpoint.id, BODY, headers), 401, "TIMESTAMP_TOO_OLD");
});

// --- 7. / 8. / 9. Events -----------------------------------------------------

test("7. + 8. a webhook is recorded as an event that can be retrieved in full", async () => {
  const endpoint = await createEndpoint(app);
  const headers = {
    ...signedHeaders(endpoint, BODY),
    "Content-Type": "application/json",
    Authorization: "Bearer should-not-be-stored",
    Cookie: "session=should-not-be-stored",
  };

  const { eventId } = await (await postWebhook(app.baseUrl, endpoint.id, BODY, headers)).json();

  const res = await api(`/api/events/${eventId}`);
  const text = await res.text();
  const event = JSON.parse(text);

  assert.equal(res.status, 200);
  assert.equal(event.id, eventId);
  assert.equal(event.endpointId, endpoint.id);
  assert.equal(event.receivedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(event.request.method, "POST");
  assert.equal(event.request.path, `/api/webhooks/${endpoint.id}`);
  assert.equal(event.request.body, BODY);
  assert.equal(event.request.bodyBytes, Buffer.byteLength(BODY));
  assert.equal(event.request.headers["content-type"], "application/json");
  assert.equal(event.request.headers["x-webhook-timestamp"], String(NOW));
  assert.deepEqual(event.verification, {
    valid: true,
    code: "VALID",
    reason: "Valid signature",
    timestampAgeSeconds: 0,
  });
  assert.deepEqual(event.response, { status: 200, body: { received: true, eventId } });

  // Credentials are never stored, and the signature is only kept as a short prefix.
  assert.equal(event.request.headers.authorization, undefined);
  assert.equal(event.request.headers.cookie, undefined);
  assert.ok(!text.includes("should-not-be-stored"));
  assert.match(event.request.headers["x-webhook-signature"], /^sha256=[0-9a-f]{12}…$/);
  assertNoSecrets(text, endpoint);
});

test("a rejected webhook's event explains why it was rejected", async () => {
  const endpoint = await createEndpoint(app);
  const headers = signedHeaders(endpoint, BODY, { timestamp: NOW - 600 });

  const { eventId } = await (await postWebhook(app.baseUrl, endpoint.id, BODY, headers)).json();
  const event = await (await api(`/api/events/${eventId}`)).json();

  assert.deepEqual(event.verification, {
    valid: false,
    code: "TIMESTAMP_TOO_OLD",
    reason: "Timestamp too old",
    timestampAgeSeconds: 600,
  });
  assert.deepEqual(event.response, {
    status: 401,
    body: { error: { code: "TIMESTAMP_TOO_OLD", message: "Timestamp too old" }, eventId },
  });
});

test("9. GET /api/endpoints/:id/events lists only that endpoint's events, newest first", async () => {
  const endpoint = await createEndpoint(app, "Mine");
  const other = await createEndpoint(app, "Other");

  const valid = await (await postWebhook(app.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY))).json();
  const invalid = await (await postWebhook(app.baseUrl, endpoint.id, BODY, { "X-Webhook-Timestamp": String(NOW) })).json();
  await (await postWebhook(app.baseUrl, other.id, BODY, signedHeaders(other, BODY))).json();

  const res = await api(`/api/endpoints/${endpoint.id}/events`);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    events: [
      {
        id: invalid.eventId,
        receivedAt: "2023-11-14T22:13:20.000Z",
        eventType: "payment.success",
        verification: { valid: false, code: "MISSING_SIGNATURE", reason: "Missing signature" },
        responseStatus: 401,
      },
      {
        id: valid.eventId,
        receivedAt: "2023-11-14T22:13:20.000Z",
        eventType: "payment.success",
        verification: { valid: true, code: "VALID", reason: "Valid signature" },
        responseStatus: 200,
      },
    ],
  });
});

test("event summaries show the event type when the body is JSON with an event/type field", async () => {
  const endpoint = await createEndpoint(app);

  for (const body of ['{"type":"customer.created"}', "plain text", '{"event":42}', "[]"]) {
    await (await postWebhook(app.baseUrl, endpoint.id, body, signedHeaders(endpoint, body))).json();
  }

  const { events } = await (await api(`/api/endpoints/${endpoint.id}/events`)).json();

  assert.deepEqual(
    events.map((event) => event.eventType),
    [null, null, null, "customer.created"],
  );
});

test("GET /api/endpoints includes how many recent events each endpoint has", async () => {
  const busy = await createEndpoint(app, "Busy");
  const quiet = await createEndpoint(app, "Quiet");

  for (let i = 0; i < 3; i++) {
    await (await postWebhook(app.baseUrl, busy.id, BODY, signedHeaders(busy, BODY))).json();
  }

  const { endpoints } = await (await api("/api/endpoints")).json();

  assert.deepEqual(
    endpoints.map((endpoint) => [endpoint.id, endpoint.recentEventCount]),
    [
      [busy.id, 3],
      [quiet.id, 0],
    ],
  );
});

test("an endpoint with no webhooks has an empty event list", async () => {
  const endpoint = await createEndpoint(app);

  assert.deepEqual(await (await api(`/api/endpoints/${endpoint.id}/events`)).json(), { events: [] });
});

test("only the newest events are kept, per endpoint: a busy endpoint never removes another's", async () => {
  const capped = await startServer({ maxEventsPerEndpoint: 3 });

  try {
    const busy = await createEndpoint(capped, "Busy");
    const quiet = await createEndpoint(capped, "Quiet");
    const send = async (endpoint) =>
      (await (await postWebhook(capped.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY))).json()).eventId;

    const quietEventId = await send(quiet);
    const busyEventIds = [];

    for (let i = 0; i < 5; i++) {
      busyEventIds.push(await send(busy));
    }

    const busyEvents = (await (await capped.fetch(`/api/endpoints/${busy.id}/events`)).json()).events;
    const quietEvents = (await (await capped.fetch(`/api/endpoints/${quiet.id}/events`)).json()).events;

    assert.deepEqual(
      busyEvents.map((event) => event.id),
      busyEventIds.slice(2).reverse(),
    );
    assert.deepEqual(
      quietEvents.map((event) => event.id),
      [quietEventId],
    );
    await assertError(await capped.fetch(`/api/events/${busyEventIds[0]}`), 404, "EVENT_NOT_FOUND");
  } finally {
    await capped.close();
  }
});

// --- 10. Body size limit -----------------------------------------------------

test("10. oversized webhook body → 413, not verified, recorded as an event", async () => {
  const endpoint = await createEndpoint(app);
  const bigBody = "x".repeat(MAX_BODY_BYTES + 1);

  const res = await postWebhook(app.baseUrl, endpoint.id, bigBody, signedHeaders(endpoint, bigBody));
  const json = await assertError(res, 413, "PAYLOAD_TOO_LARGE");

  const event = await (await api(`/api/events/${json.eventId}`)).json();

  assert.equal(event.request.body, null);
  assert.deepEqual(event.verification, {
    valid: false,
    code: "PAYLOAD_TOO_LARGE",
    reason: "Body too large; not verified",
    timestampAgeSeconds: 0,
  });
  assert.equal(event.response.status, 413);
  assert.equal(event.response.body.error.code, "PAYLOAD_TOO_LARGE");
});

test("a body exactly at the limit is accepted", async () => {
  const endpoint = await createEndpoint(app);
  const body = "x".repeat(MAX_BODY_BYTES);

  const res = await postWebhook(app.baseUrl, endpoint.id, body, signedHeaders(endpoint, body));

  assert.equal(res.status, 200);
  await res.json();
});

test("oversized body sent without Content-Length (chunked) → 413", async () => {
  const endpoint = await createEndpoint(app);
  const chunk = new TextEncoder().encode("y".repeat(500));
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 5; i++) controller.enqueue(chunk);
      controller.close();
    },
  });

  const res = await fetch(`${app.baseUrl}/api/webhooks/${endpoint.id}`, { method: "POST", body: stream, duplex: "half" });

  await assertError(res, 413, "PAYLOAD_TOO_LARGE");
});

test("oversized body on POST /api/endpoints → 413", async () => {
  const body = JSON.stringify({ name: "x".repeat(MAX_BODY_BYTES) });

  await assertError(await postJson("/api/endpoints", body), 413, "PAYLOAD_TOO_LARGE");
});

// --- 11. Routing errors ------------------------------------------------------

test("11. unsupported HTTP method → 405 METHOD_NOT_ALLOWED with an Allow header", async () => {
  const endpoint = await createEndpoint(app);

  const cases = [
    ["DELETE", "/api/endpoints", "POST, GET"],
    ["GET", `/api/webhooks/${endpoint.id}`, "POST"],
    ["POST", `/api/events/evt_0000000000000000`, "GET"],
    ["PUT", `/api/endpoints/${endpoint.id}/events`, "GET"],
  ];

  for (const [method, path, allowed] of cases) {
    const res = await api(path, { method });

    assert.equal(res.headers.get("allow"), allowed, `${method} ${path}`);
    await assertError(res, 405, "METHOD_NOT_ALLOWED");
  }
});

test("unknown routes → 404 ROUTE_NOT_FOUND (including the old POST /webhook)", async () => {
  await assertError(await api("/"), 404, "ROUTE_NOT_FOUND");
  await assertError(await api("/webhook", { method: "POST", body: BODY }), 404, "ROUTE_NOT_FOUND");
  await assertError(await api("/api/endpoints/"), 404, "ROUTE_NOT_FOUND");
});

test("query strings do not affect routing", async () => {
  const res = await api("/api/endpoints?page=2");

  assert.equal(res.status, 200);
  await res.json();
});

// --- 500 ---------------------------------------------------------------------

test("an unexpected error → 500 INTERNAL_ERROR without leaking details", async () => {
  let broken = false;
  const fragile = await startServer({
    now: () => {
      if (broken) {
        throw new Error("internal detail that must not leak");
      }

      return NOW;
    },
  });

  try {
    const endpoint = await createEndpoint(fragile);
    broken = true;

    const res = await postWebhook(fragile.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY));
    const text = await res.text();

    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(text), {
      error: { code: "INTERNAL_ERROR", message: "Something went wrong on the server." },
    });
    assert.ok(!text.includes("internal detail"));
  } finally {
    fragile.close();
  }
});
