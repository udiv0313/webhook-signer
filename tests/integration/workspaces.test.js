import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NOW, createClient, createEndpoint, postWebhook, signedHeaders, startServer } from "../helpers.js";

// Anonymous workspaces over real HTTP: the cookie, isolation between
// workspaces, expiry, and data surviving a restart.

const BODY = '{"event":"payment.success","amount":4999}';
const TTL_SECONDS = 72 * 60 * 60;

// A database file in a fresh temp folder, removed after the test.
function tempDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-signer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return path.join(dir, "test.db");
}

// Read the database file directly, the way someone with access to it could.
function queryDatabase(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });

  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function countRows(file, table) {
  return queryDatabase(file, `SELECT COUNT(*) AS n FROM ${table}`)[0].n;
}

// --- The cookie ---------------------------------------------------------------

test("the first POST /api/endpoints sets an HttpOnly workspace cookie; later ones reuse it", async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const res = await app.fetch("/api/endpoints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "First" }),
  });
  const [setCookie] = res.headers.getSetCookie();

  assert.equal(res.status, 201);
  assert.match(setCookie, /^ws=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=259200; HttpOnly; SameSite=Lax$/);
  await res.json();

  const second = await app.fetch("/api/endpoints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Second" }),
  });

  assert.deepEqual(second.headers.getSetCookie(), [], "no new workspace for a client that already has one");
  await second.json();
});

test("cookieSecure adds the Secure flag", async (t) => {
  const app = await startServer({ cookieSecure: true });
  t.after(() => app.close());

  await createEndpoint(app);

  assert.ok(app.cookie.startsWith("ws="));
  const res = await createClient(app.baseUrl).fetch("/api/endpoints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x" }),
  });

  assert.match(res.headers.getSetCookie()[0], /; Secure$/);
  await res.json();
});

test("the database stores only a hash of the token, never the token itself", async (t) => {
  const file = tempDatabase(t);
  const app = await startServer({ databasePath: file });
  t.after(() => app.close());

  await createEndpoint(app);
  const token = app.cookie.slice("ws=".length);
  const [workspace] = queryDatabase(file, "SELECT * FROM workspaces");

  assert.match(workspace.id, /^ws_[0-9a-f]{16}$/);
  assert.match(workspace.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(workspace.token_hash, token);
  assert.equal(workspace.expires_at - workspace.created_at, TTL_SECONDS);

  // Nowhere in the file either (WAL file included).
  for (const name of fs.readdirSync(path.dirname(file))) {
    assert.ok(!fs.readFileSync(path.join(path.dirname(file), name)).includes(token), `token found in ${name}`);
  }
});

// --- No workspace -------------------------------------------------------------

test("reading without a cookie shows an empty workspace and creates nothing", async (t) => {
  const file = tempDatabase(t);
  const app = await startServer({ databasePath: file });
  t.after(() => app.close());

  const list = await app.fetch("/api/endpoints");

  assert.deepEqual(await list.json(), { endpoints: [] });
  assert.deepEqual(list.headers.getSetCookie(), []);
  assert.equal((await app.fetch("/api/endpoints/ep_0000000000000000/events")).status, 404);
  assert.equal((await app.fetch("/api/events/evt_0000000000000000")).status, 404);
  assert.equal(countRows(file, "workspaces"), 0);
});

test("a failed POST /api/endpoints creates no workspace", async (t) => {
  const file = tempDatabase(t);
  const app = await startServer({ databasePath: file });
  t.after(() => app.close());

  for (const body of ["not json", JSON.stringify({ name: "" })]) {
    const res = await app.fetch("/api/endpoints", { method: "POST", headers: { "Content-Type": "application/json" }, body });

    assert.equal(res.status, 400);
    assert.deepEqual(res.headers.getSetCookie(), []);
    await res.json();
  }

  assert.equal(countRows(file, "workspaces"), 0);
});

test("malformed or unknown cookies are treated as no cookie", async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  await createEndpoint(app);

  for (const cookie of ["ws=", "ws=short", `ws=${"A".repeat(43)}`, "other=1"]) {
    const res = await createClient(app.baseUrl, { cookie }).fetch("/api/endpoints");

    assert.deepEqual(await res.json(), { endpoints: [] }, cookie);
  }
});

// --- Isolation ----------------------------------------------------------------

test("workspace B gets 404 for everything that belongs to workspace A", async (t) => {
  const app = await startServer({ testSenderEnabled: true });
  t.after(() => app.close());

  const a = app;
  const b = createClient(app.baseUrl);

  const endpointA = await createEndpoint(a, "A's endpoint");
  const endpointB = await createEndpoint(b, "B's endpoint");
  const { eventId } = await (await postWebhook(app.baseUrl, endpointA.id, BODY, signedHeaders(endpointA, BODY))).json();

  // B sees only its own endpoint.
  assert.deepEqual(
    (await (await b.fetch("/api/endpoints")).json()).endpoints.map((endpoint) => endpoint.id),
    [endpointB.id],
  );

  // A's endpoint, events and event detail look exactly like missing ones to B.
  const eventsRes = await b.fetch(`/api/endpoints/${endpointA.id}/events`);
  assert.equal(eventsRes.status, 404);
  assert.equal((await eventsRes.json()).error.code, "ENDPOINT_NOT_FOUND");

  const eventRes = await b.fetch(`/api/events/${eventId}`);
  assert.equal(eventRes.status, 404);
  assert.equal((await eventRes.json()).error.code, "EVENT_NOT_FOUND");

  // B cannot make the server sign for A's endpoint.
  const testRes = await b.fetch(`/api/endpoints/${endpointA.id}/test-webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: BODY }),
  });
  assert.equal(testRes.status, 404);
  assert.equal((await testRes.json()).error.code, "ENDPOINT_NOT_FOUND");

  // A still sees all of its own data.
  assert.equal((await a.fetch(`/api/events/${eventId}`)).status, 200);
});

test("receiving a webhook needs no cookie (external senders do not have one)", async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const endpoint = await createEndpoint(app);
  const res = await postWebhook(app.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY));

  assert.equal(res.status, 200);
  assert.deepEqual(res.headers.getSetCookie(), []);
  assert.equal((await res.json()).received, true);
});

// --- Expiry -------------------------------------------------------------------

test("an expired workspace's cookie is treated as no cookie", async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const endpoint = await createEndpoint(app);

  app.clock.now = NOW + TTL_SECONDS - 1;
  assert.equal((await app.fetch(`/api/endpoints/${endpoint.id}/events`)).status, 200);

  app.clock.now = NOW + TTL_SECONDS;
  assert.deepEqual(await (await app.fetch("/api/endpoints")).json(), { endpoints: [] });
  assert.equal((await app.fetch(`/api/endpoints/${endpoint.id}/events`)).status, 404);

  // Creating an endpoint now starts a fresh workspace.
  const oldCookie = app.cookie;
  await createEndpoint(app);
  assert.notEqual(app.cookie, oldCookie);
});

test("startup cleanup deletes expired workspaces with their endpoints and events", async (t) => {
  const file = tempDatabase(t);

  const before = await startServer({ databasePath: file });
  const endpoint = await createEndpoint(before);
  await (await postWebhook(before.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY))).json();
  await before.close();

  assert.deepEqual([countRows(file, "workspaces"), countRows(file, "endpoints"), countRows(file, "events")], [1, 1, 1]);

  // Restart after the workspace has expired.
  const after = await startServer({ databasePath: file, now: () => NOW + TTL_SECONDS });
  t.after(() => after.close());

  assert.deepEqual([countRows(file, "workspaces"), countRows(file, "endpoints"), countRows(file, "events")], [0, 0, 0]);
});

// --- Persistence --------------------------------------------------------------

test("endpoints and events survive a restart", async (t) => {
  const file = tempDatabase(t);

  const first = await startServer({ databasePath: file });
  const endpoint = await createEndpoint(first, "Survivor");
  const { eventId } = await (await postWebhook(first.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY))).json();
  const eventBefore = await (await first.fetch(`/api/events/${eventId}`)).json();
  const cookie = first.cookie;
  await first.close();

  const second = await startServer({ databasePath: file });
  t.after(() => second.close());
  const browser = createClient(second.baseUrl, { cookie }); // same browser, new server process

  const { endpoints } = await (await browser.fetch("/api/endpoints")).json();
  const { secret, ...publicEndpoint } = endpoint;
  assert.deepEqual(endpoints, [{ ...publicEndpoint, recentEventCount: 1 }]);
  assert.deepEqual(await (await browser.fetch(`/api/events/${eventId}`)).json(), eventBefore);

  // Replay protection survives the restart: the same request is refused...
  const replay = await postWebhook(second.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY));
  assert.equal(replay.status, 409);
  await replay.json();

  // ...while a new delivery for the old endpoint is still verified and accepted.
  const res = await postWebhook(second.baseUrl, endpoint.id, BODY, signedHeaders(endpoint, BODY, { timestamp: NOW + 1 }));
  assert.equal(res.status, 200);
  await res.json();
});
