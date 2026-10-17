import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../src/store/migrations.js";
import { createSqliteStore } from "../../src/store/sqlite-store.js";

// The store on its own, without HTTP. Each test opens a fresh in-memory database.

const NOW = 1_700_000_000;

function openStore(options = {}) {
  return createSqliteStore({ path: ":memory:", ...options });
}

function addWorkspace(store, id, { expiresAt = NOW + 3600 } = {}) {
  store.insertWorkspace({ id, tokenHash: `hash-of-${id}`, createdAt: NOW, expiresAt });
}

function addEndpoint(store, workspaceId, id) {
  store.insertEndpoint(workspaceId, { id, name: id, status: "active", createdAt: "2023-11-14T22:13:20.000Z" }, `sealed-${id}`);
}

function makeEvent(id, endpointId) {
  return {
    id,
    endpointId,
    receivedAt: "2023-11-14T22:13:20.000Z",
    request: {
      method: "POST",
      path: `/api/webhooks/${endpointId}`,
      headers: { "content-type": "application/json" },
      body: '{"name":"Zoë 🚀"}',
      bodyBytes: 19,
    },
    verification: { valid: true, code: "VALID", reason: "Valid signature", timestampAgeSeconds: 0 },
    response: { status: 200 },
  };
}

test("migrations run once and are idempotent: reopening a database changes nothing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-signer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nested", "store.db"); // parent folder does not exist yet

  const first = createSqliteStore({ path: file });
  addWorkspace(first, "ws_a");
  first.close();

  const second = createSqliteStore({ path: file });
  second.close();

  const db = new DatabaseSync(file);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, MIGRATIONS.length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM workspaces").get().n, 1);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  db.close();
});

test("events come back with exactly the shape they were stored with", () => {
  const store = openStore();
  addWorkspace(store, "ws_a");
  addEndpoint(store, "ws_a", "ep_a");

  const event = makeEvent("evt_1", "ep_a");
  store.insertEvent(event);

  // Before the response is sent: no body.
  assert.deepEqual(store.getWorkspaceEvent("ws_a", "evt_1"), event);

  const responseBody = { received: true, eventId: "evt_1" };
  store.setEventResponseBody("evt_1", responseBody);

  assert.deepEqual(store.getWorkspaceEvent("ws_a", "evt_1"), { ...event, response: { status: 200, body: responseBody } });
  store.close();
});

test("events are listed newest first, even within the same second", () => {
  const store = openStore();
  addWorkspace(store, "ws_a");
  addEndpoint(store, "ws_a", "ep_a");

  for (const id of ["evt_1", "evt_2", "evt_3"]) {
    store.insertEvent(makeEvent(id, "ep_a"));
  }

  assert.deepEqual(
    store.listEventsForEndpoint("ep_a").map((event) => event.id),
    ["evt_3", "evt_2", "evt_1"],
  );
  store.close();
});

test("the event cap keeps the newest N per endpoint and never touches other endpoints", () => {
  const store = openStore({ maxEventsPerEndpoint: 2 });
  addWorkspace(store, "ws_a");
  addEndpoint(store, "ws_a", "ep_busy");
  addEndpoint(store, "ws_a", "ep_quiet");

  store.insertEvent(makeEvent("evt_quiet", "ep_quiet"));

  for (const id of ["evt_1", "evt_2", "evt_3", "evt_4"]) {
    store.insertEvent(makeEvent(id, "ep_busy"));
  }

  assert.deepEqual(
    store.listEventsForEndpoint("ep_busy").map((event) => event.id),
    ["evt_4", "evt_3"],
  );
  assert.equal(store.countEventsForEndpoint("ep_busy"), 2);
  assert.deepEqual(
    store.listEventsForEndpoint("ep_quiet").map((event) => event.id),
    ["evt_quiet"],
  );
  store.close();
});

test("workspace queries never return another workspace's endpoints or events", () => {
  const store = openStore();
  addWorkspace(store, "ws_a");
  addWorkspace(store, "ws_b");
  addEndpoint(store, "ws_a", "ep_a");
  store.insertEvent(makeEvent("evt_a", "ep_a"));

  assert.equal(store.getWorkspaceEndpoint("ws_b", "ep_a"), null);
  assert.equal(store.getWorkspaceEvent("ws_b", "evt_a"), null);
  assert.deepEqual(store.listEndpoints("ws_b"), []);

  assert.equal(store.getWorkspaceEndpoint("ws_a", "ep_a").id, "ep_a");
  assert.equal(store.getWorkspaceEvent("ws_a", "evt_a").id, "evt_a");
  store.close();
});

test("an expired workspace is not found, and cleanup deletes it with its endpoints and events", () => {
  const store = openStore();
  addWorkspace(store, "ws_old", { expiresAt: NOW });
  addWorkspace(store, "ws_new", { expiresAt: NOW + 1 });
  addEndpoint(store, "ws_old", "ep_old");
  addEndpoint(store, "ws_new", "ep_new");
  store.insertEvent(makeEvent("evt_old", "ep_old"));

  assert.equal(store.findWorkspaceByTokenHash("hash-of-ws_old", NOW), null, "expired at exactly expires_at");
  assert.equal(store.findWorkspaceByTokenHash("hash-of-ws_new", NOW).id, "ws_new");

  assert.equal(store.deleteExpiredWorkspaces(NOW), 1);

  assert.equal(store.getEndpoint("ep_old"), null);
  assert.equal(store.countEventsForEndpoint("ep_old"), 0);
  assert.equal(store.getEndpoint("ep_new").id, "ep_new");
  store.close();
});

test("an endpoint cannot belong to a workspace that does not exist (foreign keys are on)", () => {
  const store = openStore();

  assert.throws(() => addEndpoint(store, "ws_missing", "ep_a"), /FOREIGN KEY/);
  store.close();
});

test("sealed secrets are kept apart from endpoint objects", () => {
  const store = openStore();
  addWorkspace(store, "ws_a");
  addEndpoint(store, "ws_a", "ep_a");

  assert.equal(store.getSealedSecret("ep_a"), "sealed-ep_a");
  assert.equal("secret" in store.getEndpoint("ep_a"), false);
  assert.deepEqual(Object.keys(store.listEndpoints("ws_a")[0]), ["id", "name", "status", "createdAt"]);

  store.setSealedSecret("ep_a", "rotated");
  assert.equal(store.getSealedSecret("ep_a"), "rotated");
  assert.equal(store.getSealedSecret("ep_missing"), null);
  assert.equal(store.countEndpoints("ws_a"), 1);
  store.close();
});

test("rememberSignature is true the first time only; expired fingerprints are deleted", () => {
  const store = openStore();
  addWorkspace(store, "ws_a");
  addEndpoint(store, "ws_a", "ep_a");
  addEndpoint(store, "ws_a", "ep_b");

  assert.equal(store.rememberSignature("ep_a", "fp1", NOW + 300), true);
  assert.equal(store.rememberSignature("ep_a", "fp1", NOW + 300), false, "same endpoint, same signature: replay");
  assert.equal(store.rememberSignature("ep_b", "fp1", NOW + 300), true, "fingerprints are per endpoint");
  assert.equal(store.rememberSignature("ep_a", "fp2", NOW + 10), true);

  assert.equal(store.deleteExpiredSignatures(NOW + 10), 1);
  assert.equal(store.rememberSignature("ep_a", "fp2", NOW + 20), true, "forgotten after expiry");
  store.close();
});

test("ping succeeds on an open database and throws once it is closed", () => {
  const store = openStore();

  store.ping();
  store.close();
  assert.throws(() => store.ping());
});

test("close() can be called twice", () => {
  const store = openStore();

  store.close();
  store.close();
});
