# webhook-signer
CLI-first webhook signing, verification, replay protection, and secret rotation toolkit.

Create webhook endpoints, receive signed webhooks on them, and see exactly what
happened to each request: what arrived, which verification step passed or
failed, why, and what the server answered. It comes with:

- a REST API (native Node.js, no dependencies),
- a signing CLI,
- a React web UI for sending test webhooks and inspecting them.

> **Prototype limitations:** all data is stored **in memory** and is lost when
> the backend restarts. There is **no authentication**. Run it locally only.
> See [Limitations](#limitations).

## Architecture

```
┌─────────────── Browser ───────────────┐
│  React UI (frontend/, Vite dev server) │      Terminal
│  never holds a secret                  │      node src/cli/sign.js  (reads .env)
└───────────────┬───────────────────────┘          │  curl
                │ /api/* (same origin, proxied by Vite)   │
                ▼                                     ▼
┌──────────────────── Backend (src/, port 3000) ─────────────────────┐
│ server.js     entry point: read config, start listening            │
│ app.js        routing + error handling                             │
│ routes/       endpoints, webhooks, events, test sender             │
│ store/        where endpoints + events are kept (in memory)        │
│ core/signature.js  HKDF, HMAC-SHA256, timestamp check,             │
│                    constant-time compare  ← all cryptography here  │
└─────────────────────────────────────────────────────────────────────┘
```

Dependencies only point downward: `server.js → app.js → routes/ → store/, events/, core/`.
Nothing in `core/` knows about HTTP or storage.

```
src/
  server.js              entry point (npm start)
  app.js                 createServer(): route table, error handling
  config.js              environment variables → settings
  core/signature.js      signing and verification (pure, no I/O)
  http/helpers.js        JSON responses, HttpError, body size limit
  routes/                one file per resource; each exports its routes
  store/memory-store.js  storage behind a small set of methods
  events/recording.js    request → stored event, console log
  lib/                   IDs and time helpers
  cli/sign.js            signing CLI
tests/
  unit/                  pure functions (signature)
  integration/           a real server on a random port
  cli/                   the CLI run as a child process
  helpers.js             shared test setup
frontend/                React + Vite web UI
docs/                    API reference, frontend, security notes
```

| Folder | What it is |
| --- | --- |
| `src/` | Backend: API server, signing/verification, CLI (`cli/sign.js`) |
| `tests/` | Backend tests (`node:test`) |
| `frontend/` | React + Vite web UI |
| `docs/` | [API reference](docs/api.md), [frontend](docs/frontend.md), [security notes](docs/security.md) |

## Backend setup

Requires Node.js 22.18+ or 24.2+. The backend has no dependencies.

```bash
cp .env.example .env
openssl rand -hex 32
```

Paste the generated value into `.env` in place of `your_secret_here`, with no
spaces around `=`. The server refuses to start with the placeholder.

| Variable                      | Default   | Meaning                                                      |
| ----------------------------- | --------- | ------------------------------------------------------------ |
| `WEBHOOK_SECRET`              | required  | Master secret. Each endpoint's secret is derived from it     |
| `WEBHOOK_TOLERANCE_SECONDS`   | `300`     | Allowed distance between webhook timestamp and server clock  |
| `WEBHOOK_MAX_BODY_SIZE`       | `1048576` | Largest accepted request body, in bytes (1 MB)               |
| `WEBHOOK_TEST_SENDER_ENABLED` | `false`   | Lets the UI send test webhooks (local requests only). `.env.example` sets it to `true` |
| `PORT`                        | `3000`    | Port the backend listens on                                  |

## Frontend setup

```bash
cd frontend
npm install
```

The defaults work as-is. Optional settings live in `frontend/.env` (copy from
`frontend/.env.example`). **Every `VITE_*` value is public**: it is bundled into
the browser JavaScript, so never put a secret there.

## Run both locally

**Terminal 1: backend**

```bash
npm start
```

**Terminal 2: frontend**

```bash
cd frontend
npm run dev
```

Open **http://localhost:5173**.

The browser only talks to the Vite dev server (port 5173), which forwards
`/api/*` to the backend (port 3000). Same origin, so no CORS is needed.

**Terminal 3 (optional): tests**

```bash
npm test
```

## Using the dashboard

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
| POST   | `/api/endpoints/:endpointId/test-webhooks`| Server-signed test webhook (local, opt-in)      |

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
endpoint secret = HKDF-SHA256(WEBHOOK_SECRET, "webhook-signer:endpoint:" + endpointId)
signed message  = <timestamp> + "." + <raw request body bytes>
signature       = "sha256=" + hex( HMAC-SHA256(endpoint secret, signed message) )
```

The server checks, in order, and stops at the first failure:

| # | Check                                                     | If it fails                             |
| - | --------------------------------------------------------- | --------------------------------------- |
| 0 | Endpoint ID is valid and exists                           | 400 `INVALID_ENDPOINT_ID` / 404 `ENDPOINT_NOT_FOUND` |
| 0 | Body is not larger than `WEBHOOK_MAX_BODY_SIZE`           | 413 `PAYLOAD_TOO_LARGE` (not verified)  |
| 1 | `X-Webhook-Timestamp` is present                          | 400 `MISSING_TIMESTAMP`                 |
| 2 | Timestamp is Unix seconds (1–10 digits)                   | 400 `MALFORMED_TIMESTAMP`               |
| 3 | `X-Webhook-Signature` is present                          | 401 `MISSING_SIGNATURE`                 |
| 4 | Signature is `sha256=` + 64 hex characters                | 400 `MALFORMED_SIGNATURE`               |
| 5 | Timestamp is not older than the tolerance                 | 401 `TIMESTAMP_TOO_OLD`                 |
| 6 | Timestamp is not further in the future than the tolerance | 401 `TIMESTAMP_IN_FUTURE`               |
| 7 | HMAC of `<timestamp>.<body>` matches (constant-time)      | 401 `INVALID_SIGNATURE`                 |
|   | All checks pass                                           | 200 `{"received":true,"eventId":"…"}`   |

**Why the timestamp:** HMAC proves who sent a request and that it was not
changed, but not *when*. A captured request replayed later is an exact copy, so
its signature is still valid. Because the timestamp is part of the signed
message, it cannot be refreshed without the secret, and the server rejects
timestamps outside the tolerance window. A replay *within* the window is still
accepted (see Limitations).

## Sending webhooks from the terminal

With the backend running:

```bash
# Create an endpoint and keep its ID
ENDPOINT_ID=$(curl -s -X POST http://localhost:3000/api/endpoints \
  -H "Content-Type: application/json" -d '{"name":"Stripe Payments"}' \
  | grep -o 'ep_[0-9a-f]\{16\}' | head -1)

# Sign a payload with the CLI (reads WEBHOOK_SECRET from .env)
BODY='{"event":"payment.success","amount":4999}'
node --env-file=.env src/cli/sign.js --endpoint=$ENDPOINT_ID "$BODY" > /tmp/webhook-headers.txt

# Valid webhook → 200
curl -i -X POST http://localhost:3000/api/webhooks/$ENDPOINT_ID \
  -H "Content-Type: application/json" -H @/tmp/webhook-headers.txt --data-binary "$BODY"

# Tampered body, old signature → 401 INVALID_SIGNATURE
curl -s -X POST http://localhost:3000/api/webhooks/$ENDPOINT_ID \
  -H @/tmp/webhook-headers.txt --data-binary '{"event":"payment.success","amount":1}'

# Expired timestamp → 401 TIMESTAMP_TOO_OLD
OLD_TIMESTAMP=$(( $(date +%s) - 600 ))
node --env-file=.env src/cli/sign.js --endpoint=$ENDPOINT_ID --timestamp=$OLD_TIMESTAMP "$BODY" > /tmp/webhook-old-headers.txt
curl -s -X POST http://localhost:3000/api/webhooks/$ENDPOINT_ID \
  -H @/tmp/webhook-old-headers.txt --data-binary "$BODY"

# Inspect what happened
curl -s http://localhost:3000/api/endpoints/$ENDPOINT_ID/events
curl -s http://localhost:3000/api/events/<eventId from a response above>
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

- **In-memory storage.** Endpoints and events are lost when the backend
  restarts. Old endpoint IDs then return `404 ENDPOINT_NOT_FOUND`; the UI tells
  you to create the endpoint again.
- **Only the 100 most recent events** (across all endpoints) are kept.
- **No authentication.** Anyone who can reach the backend can create endpoints
  and read events, including webhook bodies.
- **Test sender is a signing oracle.** It can make the server sign anything, so
  it is off by default, local-only, and JSON-only. Keep
  `WEBHOOK_TEST_SENDER_ENABLED=false` anywhere other people can reach the server.
- **One master secret.** Whoever holds `WEBHOOK_SECRET` can sign for every
  endpoint. A multi-tenant service would issue each customer a random secret.
- **Replays within the tolerance window** are still accepted. Stopping them
  needs persistent storage of processed event IDs.
- **No live updates.** The UI refreshes events after a test webhook or when you
  click Refresh; webhooks sent from the terminal appear after a refresh.
- **Development setup only.** The frontend runs on the Vite dev server with a
  proxy. A production deployment would serve the built frontend from the same
  origin as the API.
- **Single process.** Several backend instances would each have separate memory.

## Troubleshooting

- **UI shows "HTTP 502 … backend is probably not running"**: start it with
  `npm start` in the project root.
- **`403 TEST_SENDER_DISABLED`**: set `WEBHOOK_TEST_SENDER_ENABLED=true` in
  `.env` and restart the backend.
- **`404 ENDPOINT_NOT_FOUND` after a restart**: memory was cleared. Create the
  endpoint again.
- **`401 INVALID_SIGNATURE` you did not expect**: the body changed after
  signing, the wrong `--endpoint` was used, or the CLI and server use different
  `WEBHOOK_SECRET` values. Restart the backend after editing `.env`.
- **`401 TIMESTAMP_TOO_OLD` on a fresh request**: clocks differ, or a header file
  older than 5 minutes was reused. Re-run the CLI.
- **`400 MALFORMED_TIMESTAMP`**: usually milliseconds were sent instead of
  seconds.

More background: [docs/security.md](docs/security.md).
