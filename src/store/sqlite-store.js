import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migrations.js";

// SQLite storage for workspaces, endpoints and events, using Node's built-in
// node:sqlite. All calls are synchronous: SQLite runs in this process, and the
// queries here are small enough that this is simpler than async I/O.
//
// Routes only talk to storage through these methods. Every method that serves a
// browser request takes a workspaceId and filters by it in SQL, so one
// workspace can never read another's data.
//
// path ":memory:" gives a private database that disappears on close (tests).

const DEFAULT_MAX_EVENTS_PER_ENDPOINT = 50;

function toEndpoint(row) {
  return { id: row.id, name: row.name, status: row.status, createdAt: row.created_at };
}

// Rebuild exactly the event object the routes created.
function toEvent(row) {
  const response = { status: row.response_status };

  if (row.response_body_json !== null) {
    response.body = JSON.parse(row.response_body_json);
  }

  return {
    id: row.id,
    endpointId: row.endpoint_id,
    receivedAt: row.received_at,
    request: JSON.parse(row.request_json),
    verification: JSON.parse(row.verification_json),
    response,
  };
}

function createSqliteStore({ path: databasePath, maxEventsPerEndpoint = DEFAULT_MAX_EVENTS_PER_ENDPOINT }) {
  const inMemory = databasePath === ":memory:";

  if (!inMemory) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath);

  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  if (!inMemory) {
    db.exec("PRAGMA journal_mode = WAL");
  }

  runMigrations(db);

  // Run fn inside one transaction: either all of its writes happen, or none.
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");

    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // Prepared once, reused for every call. Values are always bound with ?,
  // never concatenated into the SQL.
  const statements = {
    insertWorkspace: db.prepare("INSERT INTO workspaces (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    findWorkspace: db.prepare("SELECT id, expires_at FROM workspaces WHERE token_hash = ? AND expires_at > ?"),
    deleteExpiredWorkspaces: db.prepare("DELETE FROM workspaces WHERE expires_at <= ?"),

    insertEndpoint: db.prepare(
      "INSERT INTO endpoints (id, workspace_id, name, status, created_at, secret_sealed) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    getSealedSecret: db.prepare("SELECT secret_sealed FROM endpoints WHERE id = ?"),
    setSealedSecret: db.prepare("UPDATE endpoints SET secret_sealed = ? WHERE id = ?"),
    listEndpointIdsWithoutSecret: db.prepare("SELECT id FROM endpoints WHERE secret_sealed IS NULL"),
    countEndpoints: db.prepare("SELECT COUNT(*) AS count FROM endpoints WHERE workspace_id = ?"),
    getEndpoint: db.prepare("SELECT * FROM endpoints WHERE id = ?"),
    getWorkspaceEndpoint: db.prepare("SELECT * FROM endpoints WHERE id = ? AND workspace_id = ?"),
    // rowid is insertion order: created_at only has second precision.
    listEndpoints: db.prepare("SELECT * FROM endpoints WHERE workspace_id = ? ORDER BY rowid"),

    countEvents: db.prepare("SELECT COUNT(*) AS count FROM events WHERE endpoint_id = ?"),
    nextEventSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events"),
    insertEvent: db.prepare(`
      INSERT INTO events (id, endpoint_id, seq, received_at, request_json, verification_json, response_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    // Keep only the newest maxEventsPerEndpoint events of one endpoint.
    trimEvents: db.prepare(`
      DELETE FROM events
      WHERE endpoint_id = ?
        AND seq NOT IN (SELECT seq FROM events WHERE endpoint_id = ? ORDER BY seq DESC LIMIT ?)
    `),
    setEventResponseBody: db.prepare("UPDATE events SET response_body_json = ? WHERE id = ?"),
    getWorkspaceEvent: db.prepare(`
      SELECT events.* FROM events
      JOIN endpoints ON endpoints.id = events.endpoint_id
      WHERE events.id = ? AND endpoints.workspace_id = ?
    `),
    listEvents: db.prepare("SELECT * FROM events WHERE endpoint_id = ? ORDER BY seq DESC"),

    rememberSignature: db.prepare(
      "INSERT OR IGNORE INTO seen_signatures (endpoint_id, signature_hash, expires_at) VALUES (?, ?, ?)",
    ),
    deleteExpiredSignatures: db.prepare("DELETE FROM seen_signatures WHERE expires_at <= ?"),

    ping: db.prepare("SELECT 1 AS ok"),
  };

  return {
    // --- Workspaces -----------------------------------------------------------

    insertWorkspace({ id, tokenHash, createdAt, expiresAt }) {
      statements.insertWorkspace.run(id, tokenHash, createdAt, expiresAt);
    },

    // The workspace for a token hash, or null if unknown or expired at `now`.
    findWorkspaceByTokenHash(tokenHash, now) {
      const row = statements.findWorkspace.get(tokenHash, now);

      return row ? { id: row.id, expiresAt: row.expires_at } : null;
    },

    // Deletes expired workspaces; their endpoints and events go with them
    // (ON DELETE CASCADE). Returns how many workspaces were deleted.
    deleteExpiredWorkspaces(now) {
      return Number(statements.deleteExpiredWorkspaces.run(now).changes);
    },

    // --- Endpoints ------------------------------------------------------------

    // sealedSecret is the endpoint's signing secret, already encrypted.
    // Endpoint objects returned by the store never include it.
    insertEndpoint(workspaceId, endpoint, sealedSecret) {
      statements.insertEndpoint.run(endpoint.id, workspaceId, endpoint.name, endpoint.status, endpoint.createdAt, sealedSecret);
    },

    // The encrypted signing secret, or null if the endpoint has none (yet).
    getSealedSecret(endpointId) {
      return statements.getSealedSecret.get(endpointId)?.secret_sealed ?? null;
    },

    setSealedSecret(endpointId, sealedSecret) {
      statements.setSealedSecret.run(sealedSecret, endpointId);
    },

    // Endpoints created before secrets existed (migration 2).
    listEndpointIdsWithoutSecret() {
      return statements.listEndpointIdsWithoutSecret.all().map((row) => row.id);
    },

    countEndpoints(workspaceId) {
      return statements.countEndpoints.get(workspaceId).count;
    },

    // Any workspace's endpoint. Only for receiving webhooks, where the sender
    // has no workspace and the endpoint ID itself is the address.
    getEndpoint(endpointId) {
      const row = statements.getEndpoint.get(endpointId);

      return row ? toEndpoint(row) : null;
    },

    getWorkspaceEndpoint(workspaceId, endpointId) {
      const row = statements.getWorkspaceEndpoint.get(endpointId, workspaceId);

      return row ? toEndpoint(row) : null;
    },

    // Oldest first.
    listEndpoints(workspaceId) {
      return statements.listEndpoints.all(workspaceId).map(toEndpoint);
    },

    // --- Events ---------------------------------------------------------------

    countEventsForEndpoint(endpointId) {
      return statements.countEvents.get(endpointId).count;
    },

    insertEvent(event) {
      transaction(() => {
        const { seq } = statements.nextEventSeq.get();

        statements.insertEvent.run(
          event.id,
          event.endpointId,
          seq,
          event.receivedAt,
          JSON.stringify(event.request),
          JSON.stringify(event.verification),
          event.response.status,
        );
        statements.trimEvents.run(event.endpointId, event.endpointId, maxEventsPerEndpoint);
      });
    },

    // Store the exact response body sent for a webhook, so the inspector can
    // show it. Does nothing if the event was already removed.
    setEventResponseBody(eventId, body) {
      statements.setEventResponseBody.run(JSON.stringify(body), eventId);
    },

    getWorkspaceEvent(workspaceId, eventId) {
      const row = statements.getWorkspaceEvent.get(eventId, workspaceId);

      return row ? toEvent(row) : null;
    },

    // Newest first. Callers must already have checked that the endpoint
    // belongs to the requesting workspace (getWorkspaceEndpoint).
    listEventsForEndpoint(endpointId) {
      return statements.listEvents.all(endpointId).map(toEvent);
    },

    // --- Replay protection ----------------------------------------------------

    // Records that a signature was accepted. Returns true the first time, false
    // if it was already recorded (a replay). One atomic statement, so two
    // copies arriving at the same moment cannot both be accepted.
    rememberSignature(endpointId, signatureHash, expiresAt) {
      return Number(statements.rememberSignature.run(endpointId, signatureHash, expiresAt).changes) === 1;
    },

    deleteExpiredSignatures(now) {
      return Number(statements.deleteExpiredSignatures.run(now).changes);
    },

    // Throws if the database cannot be queried (used by /health).
    ping() {
      statements.ping.get();
    },

    close() {
      if (db.isOpen) {
        db.close();
      }
    },
  };
}

export { createSqliteStore };
