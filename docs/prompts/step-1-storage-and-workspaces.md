We are implementing Step 1 only: SQLite storage + anonymous workspaces + ownership checks.
Do not start Step 2 (random per-endpoint secrets), Step 3 (rate limits, test sender redesign)
or Step 4 (deployment). Keep the HKDF secret derivation exactly as it is.

Before making changes, explain the implementation in simple terms, list the exact files you
will create or change, and wait for my confirmation.

## Goal

1. Endpoints and events survive a server restart.
2. Every visitor gets an isolated workspace without signing up. A visitor can only see and
   use their own endpoints and events.
3. One user can no longer push other users' events out of storage.

## Constraints

- No new npm dependencies. Use Node's built-in `node:sqlite` (`DatabaseSync`).
- Keep the current layering: routes talk to storage only through store methods.
  `core/` must stay free of HTTP and storage code.
- Keep every existing API path, status code, error shape and response field unchanged,
  except where this prompt says otherwise.
- All existing tests must still pass (adjust them only where ownership rules require it).

## 1. SQLite store

- Create `src/store/sqlite-store.js` exporting `createSqliteStore({ path, maxEventsPerEndpoint })`.
  It must provide every method `memory-store.js` has, plus the workspace methods below.
- Replace the in-memory store with it everywhere, including tests. Tests use `path: ":memory:"`.
  Delete `memory-store.js` once nothing uses it (one implementation, not two).
- On open: `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL` (file databases only),
  `PRAGMA busy_timeout = 5000`. Create the parent folder of the database file if missing.
- Schema migrations in `src/store/migrations.js`: an ordered list of SQL steps, applied using
  `PRAGMA user_version`, each in a transaction. Migration 1 creates:
  - `workspaces(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`
  - `endpoints(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)`
  - `events(id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE, seq INTEGER NOT NULL, received_at TEXT NOT NULL, request_json TEXT NOT NULL, verification_json TEXT NOT NULL, response_status INTEGER NOT NULL, response_body_json TEXT)`
  - Indexes: `endpoints(workspace_id)`, `events(endpoint_id, seq)`.
  `seq` is an increasing number used for ordering (two events can share the same second).
- Use prepared statements with `?` parameters only. Never build SQL from strings.
- Event retention: keep at most `maxEventsPerEndpoint` (default 50) events per endpoint.
  Insert + delete-oldest happen in one transaction. This replaces the global 100-event cap.
- Stored events must come back with exactly the same JSON shape as today.

## 2. Anonymous workspaces

- Cookie name `ws`. Value: 32 random bytes, base64url. Store only `sha256(token)` in
  `token_hash`, never the raw token. Workspace IDs look like `ws_` + 16 hex characters.
- Cookie attributes: `HttpOnly; SameSite=Lax; Path=/; Max-Age=<ttl>`, plus `Secure` when
  config `cookieSecure` is true (env `COOKIE_SECURE=true`, default false for local http).
- Lifetime: absolute, `WORKSPACE_TTL_HOURS` (default 72) from creation. No sliding renewal.
- A workspace is created only by `POST /api/endpoints` when the request has no valid cookie.
  Read-only requests without a valid cookie behave as an empty workspace and create nothing
  (so crawlers cannot fill the database).
- Invalid, unknown or expired cookie → treat as no cookie.
- Cleanup: delete expired workspaces (cascade deletes endpoints and events) at startup and
  every hour, using a timer that does not keep the process alive (`unref()`), and stopped
  when the server closes.
- Parse cookies by hand in `src/http/cookies.js` (small, tested). Put workspace resolution in
  `src/workspaces.js` (or a similarly named module), not inside each route.

## 3. Ownership rules

| Route | Rule |
|---|---|
| `POST /api/endpoints` | Endpoint belongs to the caller's workspace (create one if needed) |
| `GET /api/endpoints` | Only the caller's endpoints |
| `GET /api/endpoints/:id/events` | 404 `ENDPOINT_NOT_FOUND` unless the endpoint is the caller's |
| `GET /api/events/:id` | 404 `EVENT_NOT_FOUND` unless the event's endpoint is the caller's |
| `POST /api/endpoints/:id/test-webhooks` | 404 `ENDPOINT_NOT_FOUND` unless the endpoint is the caller's (existing guards stay) |
| `POST /api/webhooks/:id` | No cookie needed: external senders call it. Unchanged |

Use 404, not 403, for other workspaces' resources, so IDs cannot be probed for existence.
Ownership is checked in the store query (`WHERE workspace_id = ?`), not by filtering in JS.

## 4. Config

Add to `src/config.js` and `.env.example`, with comments in the existing style:
`DATABASE_PATH` (default `data/webhook-signer.db`), `WORKSPACE_TTL_HOURS` (default 72),
`WEBHOOK_MAX_EVENTS_PER_ENDPOINT` (default 50), `COOKIE_SECURE` (default false).
`createServer` receives these as options; only `server.js` reads the environment.
The startup log line says `Storage: SQLite at <path>`.
`node:sqlite` prints an ExperimentalWarning: add `--disable-warning=ExperimentalWarning`
to the `start` and `test` scripts.
Closing the server must also close the database (tests rely on this).

## 5. Frontend

Same-origin requests already send cookies, so no fetch changes should be needed. Verify it.
No new UI in this step. If an endpoint page gets 404 because the workspace expired, the
existing "create the endpoint again" message must still appear.

## 6. Tests (node:test, no new dependencies)

Add or update:
- Store (unit): migrations run once and are idempotent; per-endpoint event cap keeps the
  newest N; events keep their exact JSON shape; ordering is newest first.
- Persistence: create an endpoint and an event with a file database in a temp folder, close
  the server, open a new one on the same file, data is still there.
- Workspaces: first `POST /api/endpoints` sets the cookie with the right attributes; the raw
  token is not stored in the database; GET without a cookie returns an empty list and creates
  no workspace; an expired workspace's cookie is treated as no cookie; cleanup deletes
  expired workspaces and their endpoints and events.
- Isolation: workspace B gets 404 for workspace A's endpoint, events list, event detail and
  test sender; B's endpoint list never includes A's endpoints.
- Webhook receive still works with no cookie at all.
- Cookie parsing: missing header, several cookies, spaces, malformed pairs.
- Test helpers: update `tests/helpers.js` so requests can carry a workspace cookie.

## 7. Docs

Update README (Limitations, env table, storage), `docs/api.md` (the cookie, 404 for other
workspaces, retention per endpoint) and `docs/security.md` (token hashing, cookie flags,
why 404 instead of 403).

## Done when

- `npm test` passes with zero failures and no ExperimentalWarning output.
- Restarting `npm start` keeps endpoints and events.
- Two browsers (or one normal + one private window) see completely separate data.
- No new npm dependencies in package.json.
- At the end, summarize what changed, what you tested, and anything you were unsure about.
