// Database schema, as an ordered list of steps. Each step runs once, in its own
// transaction. PRAGMA user_version records how many steps have been applied, so
// a new step is just a new entry at the end of this list. Never edit a step
// that has already shipped: add a new one instead.

const MIGRATIONS = [
  // 1: workspaces, endpoints, events
  `
  CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,     -- sha256 of the cookie token, never the token itself
    created_at INTEGER NOT NULL,         -- Unix seconds
    expires_at INTEGER NOT NULL          -- Unix seconds
  );

  CREATE TABLE endpoints (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    status       TEXT NOT NULL,
    created_at   TEXT NOT NULL           -- ISO 8601
  );

  CREATE TABLE events (
    id                 TEXT PRIMARY KEY,
    endpoint_id        TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
    seq                INTEGER NOT NULL, -- insertion order; receivedAt has only second precision
    received_at        TEXT NOT NULL,    -- ISO 8601
    request_json       TEXT NOT NULL,
    verification_json  TEXT NOT NULL,
    response_status    INTEGER NOT NULL,
    response_body_json TEXT              -- null until the response has been sent
  );

  CREATE INDEX endpoints_by_workspace ON endpoints(workspace_id);
  CREATE INDEX events_by_endpoint ON events(endpoint_id, seq);
  `,

  // 2: each endpoint's random signing secret, encrypted (see core/secrets.js).
  // Null only for endpoints created before this migration; the server gives
  // those a new secret at startup.
  `
  ALTER TABLE endpoints ADD COLUMN secret_sealed TEXT;
  `,

  // 3: signatures already accepted, for replay protection. Kept only until the
  // request's timestamp leaves the tolerance window: after that the timestamp
  // check rejects the request anyway.
  `
  CREATE TABLE seen_signatures (
    endpoint_id    TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
    signature_hash TEXT NOT NULL,    -- sha256 of the signature, never the signature itself
    expires_at     INTEGER NOT NULL, -- Unix seconds
    PRIMARY KEY (endpoint_id, signature_hash)
  );

  CREATE INDEX seen_signatures_by_expiry ON seen_signatures(expires_at);
  `,
];

function runMigrations(db) {
  const { user_version: applied } = db.prepare("PRAGMA user_version").get();

  for (let index = applied; index < MIGRATIONS.length; index++) {
    db.exec("BEGIN");

    try {
      db.exec(MIGRATIONS[index]);
      // PRAGMA values cannot be bound as parameters; this is a number from our own code.
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export { MIGRATIONS, runMigrations };
