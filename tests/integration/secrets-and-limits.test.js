import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient, createEndpoint, postWebhook, signedHeaders, startServer } from "../helpers.js";

// Random per-endpoint secrets (shown once, rotated, stored encrypted) and the
// rate limits and quotas, over real HTTP.

const BODY = '{"event":"payment.success","amount":4999}';

function tempDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-signer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return path.join(dir, "test.db");
}

function rotate(client, endpointId) {
  return client.fetch(`/api/endpoints/${endpointId}/rotate-secret`, { method: "POST" });
}

function sendTest(client, endpointId) {
  return client.fetch(`/api/endpoints/${endpointId}/test-webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: BODY }),
  });
}

async function assertRateLimited(res) {
  assert.equal(res.status, 429);
  assert.match(res.headers.get("retry-after"), /^[1-9][0-9]*$/);

  const json = await res.json();
  assert.equal(json.error.code, "RATE_LIMITED");
  assert.match(json.error.message, /Try again in \d+ seconds/);
}

// --- Secrets ------------------------------------------------------------------

test("the secret from POST /api/endpoints signs webhooks for that endpoint", async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const endpoint = await createEndpoint(app);
  const res = await postWebhook(app.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY));

  assert.equal(res.status, 200);
  await res.json();
});

test("rotating returns a new secret once; the old one stops working immediately", async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const endpoint = await createEndpoint(app);
  const res = await rotate(app, endpoint.id);
  const { secret } = await res.json();

  assert.equal(res.status, 200);
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(secret, endpoint.secret);

  const withOld = await postWebhook(app.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY));
  const withNew = await postWebhook(app.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY, { secret }));

  assert.equal(withOld.status, 401);
  assert.equal((await withOld.json()).error.code, "INVALID_SIGNATURE");
  assert.equal(withNew.status, 200);
  await withNew.json();
});

test("only the owner can rotate: other workspaces and visitors without a cookie get 404", async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const endpoint = await createEndpoint(app);
  const other = createClient(app.baseUrl);
  await createEndpoint(other);

  for (const client of [other, createClient(app.baseUrl)]) {
    const res = await rotate(client, endpoint.id);

    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "ENDPOINT_NOT_FOUND");
  }

  // The secret is unchanged.
  const res = await postWebhook(app.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY));
  assert.equal(res.status, 200);
  await res.json();
});

test("secrets are stored encrypted, never in plain text", async (t) => {
  const file = tempDatabase(t);
  const app = await startServer({ databasePath: file });
  t.after(() => app.close());

  const endpoint = await createEndpoint(app);
  const db = new DatabaseSync(file, { readOnly: true });
  const { secret_sealed: sealed } = db.prepare("SELECT secret_sealed FROM endpoints").get();
  db.close();

  assert.match(sealed, /^v1\./);

  for (const name of fs.readdirSync(path.dirname(file))) {
    const bytes = fs.readFileSync(path.join(path.dirname(file), name));
    assert.ok(!bytes.includes(endpoint.secret.slice("whsec_".length)), `secret found in ${name}`);
  }
});

test("endpoints from before random secrets get one at startup (rotate to see it)", async (t) => {
  const file = tempDatabase(t);

  const first = await startServer({ databasePath: file });
  const endpoint = await createEndpoint(first);
  await first.close();

  // Simulate an endpoint created before database migration 2.
  const db = new DatabaseSync(file);
  db.prepare("UPDATE endpoints SET secret_sealed = NULL").run();
  db.close();

  const second = await startServer({ databasePath: file });
  t.after(() => second.close());
  const browser = createClient(second.baseUrl, { cookie: first.cookie });

  const { secret } = await (await rotate(browser, endpoint.id)).json();
  const res = await postWebhook(second.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY, { secret }));

  assert.equal(res.status, 200);
  await res.json();
});

test("a server started with a different master secret cannot use stored secrets until they are rotated", async (t) => {
  const file = tempDatabase(t);

  const first = await startServer({ databasePath: file });
  const endpoint = await createEndpoint(first);
  await first.close();

  const second = await startServer({ databasePath: file, masterSecret: "a-different-master-secret" });
  t.after(() => second.close());
  const browser = createClient(second.baseUrl, { cookie: first.cookie });

  const before = await postWebhook(second.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY));
  assert.equal(before.status, 500);
  await before.json();

  const { secret } = await (await rotate(browser, endpoint.id)).json();
  const after = await postWebhook(second.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY, { secret }));
  assert.equal(after.status, 200);
  await after.json();
});

// --- Rate limits and quotas ---------------------------------------------------

test("creating endpoints is limited per IP, with Retry-After; the limit resets after the window", async (t) => {
  const app = await startServer({ rateLimits: { createEndpoint: { limit: 2, windowSeconds: 60 } } });
  t.after(() => app.close());

  await createEndpoint(app);
  await createEndpoint(createClient(app.baseUrl)); // new workspace, same IP

  const limited = await app.fetch("/api/endpoints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Third" }),
  });
  assert.equal(limited.headers.get("retry-after"), "60");
  await assertRateLimited(limited);

  app.clock.now += 60;
  assert.match((await createEndpoint(app)).id, /^ep_/);
});

test("a workspace can have at most maxEndpointsPerWorkspace endpoints", async (t) => {
  const app = await startServer({ maxEndpointsPerWorkspace: 2 });
  t.after(() => app.close());

  await createEndpoint(app);
  await createEndpoint(app);

  const res = await app.fetch("/api/endpoints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Third" }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "ENDPOINT_LIMIT_REACHED");

  // Another workspace is not affected.
  assert.match((await createEndpoint(createClient(app.baseUrl))).id, /^ep_/);
});

test("receiving webhooks is limited per endpoint; refused requests are not recorded", async (t) => {
  const app = await startServer({ rateLimits: { receiveWebhook: { limit: 2, windowSeconds: 60 } } });
  t.after(() => app.close());

  const busy = await createEndpoint(app, "Busy");
  const quiet = await createEndpoint(app, "Quiet");
  const send = (endpoint) => postWebhook(app.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY));

  for (let i = 0; i < 2; i++) {
    await (await send(busy)).json();
  }

  await assertRateLimited(await send(busy));

  const quietRes = await send(quiet);
  assert.equal(quietRes.status, 200, "other endpoints keep their own budget");
  await quietRes.json();

  const { events } = await (await app.fetch(`/api/endpoints/${busy.id}/events`)).json();
  assert.equal(events.length, 2);
});

test("test webhooks are limited per workspace", async (t) => {
  const app = await startServer({ testSenderEnabled: true, rateLimits: { testWebhook: { limit: 2, windowSeconds: 60 } } });
  t.after(() => app.close());

  const endpoint = await createEndpoint(app);

  for (let i = 0; i < 2; i++) {
    const res = await sendTest(app, endpoint.id);
    assert.equal(res.status, 200);
    await res.json();
  }

  await assertRateLimited(await sendTest(app, endpoint.id));

  // Another workspace has its own budget.
  const other = createClient(app.baseUrl);
  const otherEndpoint = await createEndpoint(other);
  const res = await sendTest(other, otherEndpoint.id);
  assert.equal(res.status, 200);
  await res.json();
});

test("the test sender's own deliveries do not use up the per-IP API limit", async (t) => {
  // Each test send is 2 requests to the server: the API call and the delivery.
  const app = await startServer({ testSenderEnabled: true, rateLimits: { api: { limit: 4, windowSeconds: 60 } } });
  t.after(() => app.close());

  const endpoint = await createEndpoint(app); // 1

  for (let i = 0; i < 3; i++) {
    app.clock.now += 1; // a new timestamp each time, so no send is a replay
    const res = await sendTest(app, endpoint.id); // 2, 3, 4 (deliveries not counted)
    assert.equal(res.status, 200);
    assert.equal((await res.json()).response.status, 200);
  }

  await assertRateLimited(await app.fetch("/api/endpoints")); // 5
});

test("a forged internal-delivery header does not bypass the per-IP limit", async (t) => {
  const app = await startServer({ rateLimits: { api: { limit: 1, windowSeconds: 60 } } });
  t.after(() => app.close());

  await (await app.fetch("/api/endpoints")).json();
  await assertRateLimited(await app.fetch("/api/endpoints", { headers: { "X-Webhook-Signer-Internal": "guess" } }));
});

test("rotating secrets is limited per workspace", async (t) => {
  const app = await startServer({ rateLimits: { rotateSecret: { limit: 1, windowSeconds: 3600 } } });
  t.after(() => app.close());

  const endpoint = await createEndpoint(app);

  const first = await rotate(app, endpoint.id);
  assert.equal(first.status, 200);
  await first.json();
  await assertRateLimited(await rotate(app, endpoint.id));
});

test("with trustProxy, limits apply per X-Forwarded-For client, not per proxy", async (t) => {
  const app = await startServer({ trustProxy: true, rateLimits: { api: { limit: 1, windowSeconds: 60 } } });
  t.after(() => app.close());

  const asClient = (ip) => fetch(`${app.baseUrl}/api/endpoints`, { headers: { "X-Forwarded-For": ip } });

  const first = await asClient("203.0.113.1");
  const second = await asClient("203.0.113.2");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  await first.json();
  await second.json();
  await assertRateLimited(await asClient("203.0.113.1"));
});
