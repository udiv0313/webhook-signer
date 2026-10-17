# webhook-signer

Webhook signing, verification, replay protection and secret rotation, with a
web UI that shows exactly what happened to every request: what arrived, which
check passed or failed, why, and what the server answered.

- **Signed webhooks:** HMAC-SHA256 over `<timestamp>.<raw body>`, one random
  secret per endpoint (shown once, stored encrypted, rotatable).
- **Verification in order:** body size → headers → timestamp window →
  constant-time signature check → replay check. Every outcome is recorded.
- **Request inspector:** each check marked passed, failed or not checked, with
  "what happened" and "how to fix it".
- **Try it in 60 seconds:** a guided demo, plus an `openssl` + `curl` command
  that signs a webhook from any terminal.
- **Isolation without sign-up:** each browser gets an anonymous workspace
  (HttpOnly cookie, 72 hours).
- **Abuse protection:** rate limits, quotas, body size limit, security headers.

## Tech stack

| Layer | Choice |
| --- | --- |
| Backend | Node.js 24 (22.18+ works), native `node:http`, **no npm dependencies** |
| Storage | SQLite via Node's built-in `node:sqlite` |
| Crypto | `node:crypto`: HMAC-SHA256, AES-256-GCM, HKDF, `timingSafeEqual` |
| Frontend | React 19 + Vite |
| Tests | `node:test` (unit, integration over real HTTP, CLI as a child process) |
| Deployment | Docker (multi-stage), Fly.io config included |

## Architecture

```
            Browser                                  Any sender
  React app (same origin as the API)        (Stripe, curl, the signing CLI)
        │  /api/*  (workspace cookie)                    │ POST /api/webhooks/:id
        ▼                                                ▼
┌──────────────────────────── Node.js server (port 3000) ───────────────────────┐
│ app.js       security headers, rate limits, routing, errors, static web app   │
│ routes/      endpoints · events · webhooks · test sender · /health            │
│ workspaces   anonymous cookie → workspace (only a hash of the token is stored) │
│ core/        signature.js (HMAC, timestamp, replay fingerprint)                │
│              secrets.js   (random secrets, AES-256-GCM at rest)   ← no I/O     │
│ store/       SQLite: workspaces, endpoints, events, seen signatures            │
└────────────────────────────────────────────────────────────────────────────────┘
```

Dependencies only point downward (`server.js → app.js → routes/ → store/, core/`),
and `core/` knows nothing about HTTP or storage.

## Folder structure

```
src/
  server.js              entry point: read config, listen, graceful shutdown
  app.js                 createServer(): wiring, routing, errors, static files
  config.js              environment variables → settings
  workspaces.js          anonymous workspace sessions (cookie)
  core/                  signature.js, secrets.js: pure crypto, no I/O
  http/                  helpers, cookies, rate-limit, security-headers, static
  routes/                endpoints, events, webhooks, test-sender, health, lookups
  store/                 sqlite-store.js, migrations.js
  events/recording.js    request → stored event
  lib/                   IDs and time helpers
  cli/sign.js            signing CLI
frontend/src/            React app: pages/, components/, services/api.js
tests/                   unit/, integration/, cli/, helpers.js
docs/                    API reference, security notes, frontend, deployment
Dockerfile, docker-entrypoint.sh, fly.toml
```

## Local setup

Requires Node.js 22.18+ or 24.2+ and npm.

```bash
git clone https://github.com/udiv0313/webhook-signer.git
cd webhook-signer
cp .env.example .env
openssl rand -hex 32          # paste as WEBHOOK_SECRET in .env
npm --prefix frontend install
```

**Development** (hot reload, two terminals):

```bash
npm start                     # backend on :3000
npm --prefix frontend run dev # UI on http://localhost:5173 (proxies /api to :3000)
```

**Production mode locally** (one port):

```bash
npm run build && npm start    # http://localhost:3000
```

## Environment variables

Defaults and explanations are in [`.env.example`](.env.example). Never commit
`.env`.

| Name | Purpose |
| --- | --- |
| `WEBHOOK_SECRET` | **Required.** Master key that encrypts endpoint secrets at rest |
| `PORT` | Port to listen on |
| `DATABASE_PATH` | SQLite file location |
| `WEBHOOK_TOLERANCE_SECONDS` | Allowed clock difference for webhook timestamps |
| `WEBHOOK_MAX_BODY_SIZE` | Largest accepted request body, in bytes |
| `WEBHOOK_MAX_EVENTS_PER_ENDPOINT` | Newest events kept per endpoint |
| `WORKSPACE_TTL_HOURS` | Lifetime of a browser's workspace and its data |
| `WORKSPACE_MAX_ENDPOINTS` | Endpoints allowed per workspace |
| `WEBHOOK_TEST_SENDER_ENABLED` | Enables the UI's test sender |
| `COOKIE_SECURE` | Marks the workspace cookie `Secure` and sends HSTS (HTTPS only) |
| `TRUST_PROXY` | Number of reverse proxies in front (`true` = 1; Render needs `2`), so the client IP comes from `X-Forwarded-For` |
| `FRONTEND_DIST` | Folder of the built web app to serve |

Frontend (optional, `frontend/.env`): `VITE_WEBHOOK_BASE_URL` (public, display
only) and `API_PROXY_TARGET` (dev proxy only).

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Start the server (reads `.env` if present) |
| `npm test` | Run all backend tests |
| `npm run build` | Install frontend dependencies and build `frontend/dist` |
| `npm --prefix frontend run dev` | Frontend dev server with hot reload |
| `node src/cli/sign.js '<body>'` | Print signed headers (needs `WEBHOOK_ENDPOINT_SECRET`) |

## Docker

```bash
docker build -t webhook-signer .
docker run --rm -p 3000:3000 \
  -e WEBHOOK_SECRET="$(openssl rand -hex 32)" \
  -e WEBHOOK_TEST_SENDER_ENABLED=true \
  -v webhook-data:/data \
  webhook-signer
```

Open http://localhost:3000. The image is multi-stage on a pinned
`node:24.9.0-bookworm-slim`, runs the server as the unprivileged `node` user,
exposes only port 3000, and has a `HEALTHCHECK` on `GET /health`. Keep the same
`WEBHOOK_SECRET` across restarts, or stored endpoint secrets become unreadable.

## Deployment

One process, one persistent volume for SQLite, HTTPS in front. Behind HTTPS set
`COOKIE_SECURE=true`; behind reverse proxies set `TRUST_PROXY` to their number
(`true` for one, `2` on Render). Run
exactly one instance (SQLite and the in-memory rate limits are per process).
Step-by-step guide (Fly.io config included): [docs/deploy.md](docs/deploy.md).

## Using the dashboard

**Try it in 60 seconds** (top of the Endpoints page) creates a demo endpoint and
walks through four steps: a valid webhook, a tampered one, why it was rejected,
and a replay. It also shows an `openssl` + `curl` command that signs a webhook
from any terminal, without this project.

1. **Endpoints** lists every endpoint with its status, webhook URL, and number
   of recent events. Click one to open it.
2. **Create endpoint**: enter a name (e.g. "Stripe Payments"). You get the
   endpoint ID and webhook URL. The signing secret is never shown: it stays on
   the server.
3. **Endpoint page**: on the left, the test sender and the recent events; on the
   right, the request inspector for the selected event.

### Sending a test webhook

On an endpoint page, edit the JSON payload, pick a scenario, and click
**Send webhook**. The backend signs the payload (the browser never sees the
secret), delivers it to the real webhook URL, and the new event opens in the
inspector.

| Scenario | Expected result |
| --- | --- |
| Valid webhook | ✓ 200 accepted |
| Signed with the wrong secret | ✕ 401 `INVALID_SIGNATURE` |
| Body changed after signing (newline added) | ✕ 401 `INVALID_SIGNATURE` |
| Expired timestamp (looks like a replay) | ✕ 401 `TIMESTAMP_TOO_OLD` |
| Missing signature header | ✕ 401 `MISSING_SIGNATURE` |
| Timestamp in milliseconds | ✕ 400 `MALFORMED_TIMESTAMP` |

"Send the same payload from your terminal" shows the equivalent CLI + curl
commands.

### Inspecting a failed webhook

Click any event. The inspector reads top to bottom, in the order things happened:

1. **Verdict**: accepted or rejected, the reason, and the HTTP status.
2. **Request**: method and path, the stored headers, and the body. Switch the
   body to **Exact bytes** to see it escaped, so invisible changes like a
   trailing `\n` show up.
3. **Verification**: each check in order (body size → headers → timestamp →
   signature) marked ✓ Passed, ✕ Failed, or – Not checked, followed by
   **What happened** and **How to fix it**.
4. **Response**: the exact JSON the server sent back.

Checks after the first failure never ran, so they are shown as **Not checked**.
For example, an expired request's signature is never verified, so the UI does
not claim it was valid.

## API overview

| Method | Path                                      | Purpose                                         |
| ------ | ----------------------------------------- | ----------------------------------------------- |
| POST   | `/api/endpoints`                          | Create a webhook endpoint                       |
| GET    | `/api/endpoints`                          | List endpoints (with recent event counts)       |
| POST   | `/api/webhooks/:endpointId`               | Receive a signed webhook                        |
| GET    | `/api/endpoints/:endpointId/events`       | Recent events for an endpoint (summaries)       |
| GET    | `/api/events/:eventId`                    | Full details of one event                       |
| POST   | `/api/endpoints/:endpointId/rotate-secret`| Replace the signing secret (shown once)        |
| POST   | `/api/endpoints/:endpointId/test-webhooks`| Server-signed test webhook (own endpoints, opt-in) |
| GET    | `/health`                                 | Health check for the hosting platform           |

Every error has the same shape:

```json
{ "error": { "code": "ENDPOINT_NOT_FOUND", "message": "Webhook endpoint was not found." } }
```

Full reference with every header, body, and error code: [docs/api.md](docs/api.md).

## Webhook verification flow

Every webhook carries two headers:

```
X-Webhook-Timestamp: 1712345678                       (Unix seconds)
X-Webhook-Signature: sha256=<64 hex characters>
```

```
endpoint secret = "whsec_" + 32 random bytes (base64url), shown once when the endpoint is created
signed message  = <timestamp> + "." + <raw request body bytes>
signature       = "sha256=" + hex( HMAC-SHA256(endpoint secret, signed message) )
```

The HMAC key is the whole secret string, `whsec_` included. The server stores it
encrypted (AES-256-GCM, key derived from `WEBHOOK_SECRET`). Rotating a secret
(UI button or `POST /api/endpoints/:id/rotate-secret`) shows a new one, once,
and the old one stops working immediately.

The server checks, in order, and stops at the first failure:

| # | Check                                                     | If it fails                             |
| - | --------------------------------------------------------- | --------------------------------------- |
| 0 | Endpoint ID is valid and exists                           | 400 `INVALID_ENDPOINT_ID` / 404 `ENDPOINT_NOT_FOUND` |
| 0 | Endpoint is under its rate limit (120/minute)             | 429 `RATE_LIMITED` (not recorded)      |
| 0 | Body is not larger than `WEBHOOK_MAX_BODY_SIZE`           | 413 `PAYLOAD_TOO_LARGE` (not verified)  |
| 1 | `X-Webhook-Timestamp` is present                          | 400 `MISSING_TIMESTAMP`                 |
| 2 | Timestamp is Unix seconds (1–10 digits)                   | 400 `MALFORMED_TIMESTAMP`               |
| 3 | `X-Webhook-Signature` is present                          | 401 `MISSING_SIGNATURE`                 |
| 4 | Signature is `sha256=` + 64 hex characters                | 400 `MALFORMED_SIGNATURE`               |
| 5 | Timestamp is not older than the tolerance                 | 401 `TIMESTAMP_TOO_OLD`                 |
| 6 | Timestamp is not further in the future than the tolerance | 401 `TIMESTAMP_IN_FUTURE`               |
| 7 | HMAC of `<timestamp>.<body>` matches (constant-time)      | 401 `INVALID_SIGNATURE`                 |
| 8 | This exact request was not already accepted              | 409 `REPLAY_DETECTED`                   |
|   | All checks pass                                           | 200 `{"received":true,"eventId":"…"}`   |

**Why the timestamp:** HMAC proves who sent a request and that it was not
changed, but not *when*. A captured request replayed later is an exact copy, so
its signature is still valid. Because the timestamp is part of the signed
message, it cannot be refreshed without the secret, and the server rejects
timestamps outside the tolerance window.

**Why check 8:** a replay *within* the window passes checks 1–7. So the server
remembers a fingerprint (sha256) of every accepted signature until its
timestamp leaves the window, and refuses a second delivery of the same request.
Senders must therefore sign every delivery, retries included, with a fresh
timestamp.

## Sending webhooks from the terminal

With the backend running:

```bash
# Create an endpoint. -c/-b keep the workspace cookie, like a browser would.
curl -s -c /tmp/jar -b /tmp/jar -X POST http://localhost:3000/api/endpoints \
  -H "Content-Type: application/json" -d '{"name":"Stripe Payments"}' > /tmp/endpoint.json

# Keep its ID and its secret (the secret is only in this one response)
ENDPOINT_ID=$(node -p 'require("/tmp/endpoint.json").id')
export WEBHOOK_ENDPOINT_SECRET=$(node -p 'require("/tmp/endpoint.json").secret')
rm /tmp/endpoint.json

# Sign a payload with the CLI (reads WEBHOOK_ENDPOINT_SECRET)
BODY='{"event":"payment.success","amount":4999}'
node src/cli/sign.js "$BODY" > /tmp/webhook-headers.txt

# Valid webhook → 200
curl -i -X POST http://localhost:3000/api/webhooks/$ENDPOINT_ID \
  -H "Content-Type: application/json" -H @/tmp/webhook-headers.txt --data-binary "$BODY"

# Tampered body, old signature → 401 INVALID_SIGNATURE
curl -s -X POST http://localhost:3000/api/webhooks/$ENDPOINT_ID \
  -H @/tmp/webhook-headers.txt --data-binary '{"event":"payment.success","amount":1}'

# Expired timestamp → 401 TIMESTAMP_TOO_OLD
OLD_TIMESTAMP=$(( $(date +%s) - 600 ))
node src/cli/sign.js --timestamp=$OLD_TIMESTAMP "$BODY" > /tmp/webhook-old-headers.txt
curl -s -X POST http://localhost:3000/api/webhooks/$ENDPOINT_ID \
  -H @/tmp/webhook-old-headers.txt --data-binary "$BODY"

# Inspect what happened (needs the workspace cookie)
curl -s -b /tmp/jar http://localhost:3000/api/endpoints/$ENDPOINT_ID/events
curl -s -b /tmp/jar http://localhost:3000/api/events/<eventId from a response above>
```

Use `--data-binary`, not `-d`: `-d` can change the body (for example, strip
newlines from files), which breaks the signature. Events sent from the terminal
show up in the web UI too.

## Body size limit

Bodies larger than `WEBHOOK_MAX_BODY_SIZE` (default 1 MB) get
`413 PAYLOAD_TOO_LARGE`. If `Content-Length` already says it is too big, nothing
is read; otherwise the server stops collecting as soon as the limit is passed.
The webhook is never verified, the connection is closed, and an event is still
recorded (with `body: null`) so it can be inspected.

## Limitations

- **Anonymous workspaces, no accounts.** Data belongs to a browser cookie. A
  different browser, a private window, or cleared cookies means a new, empty
  workspace. Workspaces and their data are deleted 72 hours after creation.
- **Only the 50 newest events per endpoint** are kept.
- **Rate limits are in memory.** They reset on restart, and several server
  processes would each count separately. Limits: 300 requests/minute per IP,
  10 new endpoints/hour per IP, 20 endpoints per workspace, 120 webhooks/minute
  per endpoint, 30 test webhooks/minute and 10 rotations/hour per workspace.
- **Rotation has no overlap.** The old secret stops working at once, so senders
  must switch immediately. Real providers accept both for a while.
- **`WEBHOOK_SECRET` decrypts every endpoint secret.** Keep it out of the
  database's backups. Changing it makes stored secrets unreadable (rotate them).
- **Live updates poll.** The endpoint page checks for new events every 4
  seconds while the tab is visible (no WebSockets).
- **Single process.** SQLite is one file on one machine, and rate limits are in
  memory; several backend instances would need a shared database and store.
- **Deployment files are untested here.** The Dockerfile and `fly.toml` were
  written without Docker available; see the checklist in docs/deploy.md.

## Troubleshooting

- **UI shows "HTTP 502 … backend is probably not running"**: start it with
  `npm start` in the project root.
- **`403 TEST_SENDER_DISABLED`**: set `WEBHOOK_TEST_SENDER_ENABLED=true` in
  `.env` and restart the backend.
- **`404 ENDPOINT_NOT_FOUND` in the UI**: the endpoint belongs to another
  browser's workspace, or your workspace expired (72 hours). Create it again.
- **`401 INVALID_SIGNATURE` you did not expect**: the body changed after
  signing, `WEBHOOK_ENDPOINT_SECRET` holds another endpoint's secret, or the
  secret was rotated since you copied it.
- **`429 RATE_LIMITED`**: wait the number of seconds in `Retry-After`.
- **`409 REPLAY_DETECTED`**: the same signed request was sent twice. Sign again
  (new timestamp) for every delivery.
- **`500` with "Cannot decrypt the signing secret" in the server log**:
  `WEBHOOK_SECRET` changed. Rotate that endpoint's secret.
- **`401 TIMESTAMP_TOO_OLD` on a fresh request**: clocks differ, or a header file
  older than 5 minutes was reused. Re-run the CLI.
- **`400 MALFORMED_TIMESTAMP`**: usually milliseconds were sent instead of
  seconds.

More background: [docs/security.md](docs/security.md).
