# API reference

Base URL (local): `http://localhost:3000`

All requests and responses use JSON, except webhook bodies, which are treated as
raw signed bytes. Data is stored in SQLite (`DATABASE_PATH`) and survives
restarts. There are no accounts: each browser gets an anonymous **workspace**
(see below), and can only see its own endpoints and events.

## Conventions

- A single resource is returned as a plain object. A list is wrapped in a named
  key, e.g. `{ "endpoints": [...] }`.
- IDs: endpoints look like `ep_` + 16 hex characters, events like `evt_` + 16
  hex characters. Anything else is rejected with `400` before any lookup.
- Every error has the same shape:

```json
{ "error": { "code": "ENDPOINT_NOT_FOUND", "message": "Webhook endpoint was not found." } }
```

Webhook responses also include a top-level `eventId`, so a sender can look up
its own request.

### Workspaces

- The first successful `POST /api/endpoints` without a valid workspace cookie
  creates a workspace and sets it:

  ```
  Set-Cookie: ws=<43 random base64url characters>; Path=/; Max-Age=259200; HttpOnly; SameSite=Lax
  ```

  `Secure` is added when `COOKIE_SECURE=true`. Browsers send the cookie back
  automatically on same-origin requests.
- A workspace lives `WORKSPACE_TTL_HOURS` (default 72) from creation and is never
  extended. After that its cookie is ignored and its endpoints and events are
  deleted.
- Requests without a valid cookie create nothing: `GET /api/endpoints` returns an
  empty list and every other management route returns `404`.
- **Another workspace's endpoint or event returns the same `404` as one that
  does not exist**, so IDs cannot be probed.
- `POST /api/webhooks/:endpointId` needs **no** cookie: external senders call it,
  and the endpoint ID in the URL is the address.

### Errors that can happen on any route

| Status | Code                 | When                                                        |
| ------ | -------------------- | ----------------------------------------------------------- |
| 404    | `ROUTE_NOT_FOUND`    | No route matches the path                                   |
| 405    | `METHOD_NOT_ALLOWED` | The path exists but not for this method. `Allow` header lists valid methods |
| 413    | `PAYLOAD_TOO_LARGE`  | Body larger than `WEBHOOK_MAX_BODY_SIZE` (default 1 MB)     |
| 429    | `RATE_LIMITED`       | More than 300 requests per minute from one IP. `Retry-After` says how many seconds to wait |
| 500    | `INTERNAL_ERROR`     | Unexpected server bug. Details go to the server console only |

---

## POST /api/endpoints

**Purpose:** create a webhook endpoint with its own random signing secret.
**This response is the only time the secret is returned**; afterwards it can
only be replaced (see rotate-secret). Limited to 10 per hour per IP, and 20
endpoints per workspace.

**Request headers:** `Content-Type: application/json`

**Request body:**

```json
{ "name": "Stripe Payments" }
```

`name` is required: a string of 1–100 characters (surrounding spaces are trimmed).

**Success: `201 Created`**

```json
{
  "id": "ep_85a64db45372ea34",
  "name": "Stripe Payments",
  "status": "active",
  "createdAt": "2026-10-11T10:21:24.000Z",
  "webhookPath": "/api/webhooks/ep_85a64db45372ea34",
  "recentEventCount": 0,
  "secret": "whsec_EXAMPLE000000000000000000000000000000000000"
}
```

**Errors**

| Status | Code               | When                                   |
| ------ | ------------------ | -------------------------------------- |
| 403    | `ENDPOINT_LIMIT_REACHED` | The workspace already has the maximum number of endpoints |
| 429    | `RATE_LIMITED`     | Too many endpoints created from this IP |
| 400    | `INVALID_JSON`     | Body is not valid JSON (or is empty)   |
| 400    | `VALIDATION_ERROR` | `name` missing, empty, not a string, or longer than 100 characters |
| 413    | `PAYLOAD_TOO_LARGE`| Body too large                         |

---

## GET /api/endpoints

**Purpose:** list the caller's endpoints, in creation order. Secrets are never
included. Without a workspace cookie the list is empty.

**Request headers / body:** none

**Success: `200 OK`**

```json
{
  "endpoints": [
    {
      "id": "ep_85a64db45372ea34",
      "name": "Stripe Payments",
      "status": "active",
      "createdAt": "2026-10-11T10:21:24.000Z",
      "webhookPath": "/api/webhooks/ep_85a64db45372ea34",
      "recentEventCount": 3
    }
  ]
}
```

`recentEventCount` is how many of the stored (most recent 100) events belong to
this endpoint.

**Errors:** only the general ones above.

---

## GET /health

**Purpose:** health check for the hosting platform and uptime monitors. Not
under `/api`, never rate limited, no cookie needed.

**Success: `200 OK`**

```json
{ "status": "ok", "checks": { "database": "ok" }, "uptimeSeconds": 3600 }
```

**`503 Service Unavailable`** with `"status": "error"` and
`"database": "unavailable"` when the database cannot be queried.

---

## POST /api/webhooks/:endpointId

**Purpose:** receive a signed webhook for one endpoint. The request is verified
(HMAC-SHA256 + timestamp window) and recorded as an event, whether it passes or not.

**Request headers**

| Header                | Value                                                  |
| --------------------- | ------------------------------------------------------ |
| `X-Webhook-Timestamp` | Unix time in whole seconds, e.g. `1791714084`          |
| `X-Webhook-Signature` | `sha256=` + hex HMAC-SHA256 of `<timestamp>.<raw body>`, using the endpoint's secret |
| `Content-Type`        | Optional. Recorded for debugging, not required         |

Use `WEBHOOK_ENDPOINT_SECRET='whsec_...' node src/cli/sign.js '<body>'` to generate both headers.
Limited to 120 requests per minute per endpoint; refused requests get `429` and
are not recorded.

**Request body:** any bytes (usually JSON). It is verified exactly as sent and
never parsed, so it does not have to be JSON.

**Success: `200 OK`**

```json
{ "received": true, "eventId": "evt_df8c5c89eedc7b21" }
```

**Errors**

| Status | Code                  | When                                                  |
| ------ | --------------------- | ----------------------------------------------------- |
| 400    | `INVALID_ENDPOINT_ID` | ID is not `ep_` + 16 hex characters (not recorded)    |
| 404    | `ENDPOINT_NOT_FOUND`  | No endpoint with this ID (not recorded)               |
| 400    | `MISSING_TIMESTAMP`   | No `X-Webhook-Timestamp`                              |
| 400    | `MALFORMED_TIMESTAMP` | Not Unix seconds (e.g. milliseconds, decimals, text)  |
| 401    | `MISSING_SIGNATURE`   | No `X-Webhook-Signature`                              |
| 400    | `MALFORMED_SIGNATURE` | Not `sha256=` + 64 hex characters                     |
| 401    | `TIMESTAMP_TOO_OLD`   | Older than `WEBHOOK_TOLERANCE_SECONDS`                |
| 401    | `TIMESTAMP_IN_FUTURE` | Further in the future than the tolerance             |
| 401    | `INVALID_SIGNATURE`   | HMAC does not match (wrong secret, changed body or timestamp) |
| 409    | `REPLAY_DETECTED`     | This exact request (same timestamp, body and signature) was already accepted. Recorded as an event |
| 413    | `PAYLOAD_TOO_LARGE`   | Body too large. Recorded, but never verified          |

Example error:

```json
{
  "error": { "code": "INVALID_SIGNATURE", "message": "Invalid signature" },
  "eventId": "evt_1275fdd942c0af73"
}
```

---

## GET /api/endpoints/:endpointId/events

**Purpose:** list recent webhook events for one endpoint, newest first. Returns
summaries; use `GET /api/events/:eventId` for full details.

**Request headers / body:** none

**Success: `200 OK`**

```json
{
  "events": [
    {
      "id": "evt_1275fdd942c0af73",
      "receivedAt": "2026-10-11T10:21:24.000Z",
      "eventType": "payment.success",
      "verification": { "valid": false, "code": "INVALID_SIGNATURE", "reason": "Invalid signature" },
      "responseStatus": 401
    },
    {
      "id": "evt_df8c5c89eedc7b21",
      "receivedAt": "2026-10-11T10:21:24.000Z",
      "eventType": "payment.success",
      "verification": { "valid": true, "code": "VALID", "reason": "Valid signature" },
      "responseStatus": 200
    }
  ]
}
```

`eventType` is the `event` (or `type`) field of a JSON body, for display only.
It is `null` when the body is not JSON or has no such string field.

Each endpoint keeps only its newest `WEBHOOK_MAX_EVENTS_PER_ENDPOINT` events
(default 50). Older ones are deleted; other endpoints are never affected.

**Errors**

| Status | Code                  | When                               |
| ------ | --------------------- | ---------------------------------- |
| 400    | `INVALID_ENDPOINT_ID` | ID is not `ep_` + 16 hex characters |
| 404    | `ENDPOINT_NOT_FOUND`  | No endpoint with this ID in your workspace |

---

## GET /api/events/:eventId

**Purpose:** full details of one webhook event, for debugging: what arrived,
whether it was verified, why it was rejected, and what was returned.

**Request headers / body:** none

**Success: `200 OK`**

```json
{
  "id": "evt_1275fdd942c0af73",
  "endpointId": "ep_85a64db45372ea34",
  "receivedAt": "2026-10-11T10:21:24.000Z",
  "request": {
    "method": "POST",
    "path": "/api/webhooks/ep_85a64db45372ea34",
    "headers": {
      "content-type": "application/json",
      "content-length": "38",
      "user-agent": "curl/8.7.1",
      "x-webhook-timestamp": "1791714084",
      "x-webhook-signature": "sha256=57e20ab5fd26…"
    },
    "body": "{\"event\":\"payment.success\",\"amount\":1}",
    "bodyBytes": 38
  },
  "verification": {
    "valid": false,
    "code": "INVALID_SIGNATURE",
    "reason": "Invalid signature",
    "timestampAgeSeconds": 0
  },
  "response": {
    "status": 401,
    "body": {
      "error": { "code": "INVALID_SIGNATURE", "message": "Invalid signature" },
      "eventId": "evt_1275fdd942c0af73"
    }
  }
}
```

Field notes:

- `request.headers` only contains the five headers shown. Others, such as
  `Authorization` or `Cookie`, are never stored.
- `x-webhook-signature` is truncated to its first 12 hex characters: enough to
  compare with what the sender computed, but not a replayable signature.
- `request.body` is `null` when the body was too large (413) and never read.
- `timestampAgeSeconds` is server time minus the webhook timestamp
  (negative = in the future, `null` = missing or malformed).
- `response.body` is the exact JSON the server sent back to the webhook sender.

**Errors**

| Status | Code               | When                                |
| ------ | ------------------ | ----------------------------------- |
| 400    | `INVALID_EVENT_ID` | ID is not `evt_` + 16 hex characters |
| 404    | `EVENT_NOT_FOUND`  | No such event in your workspace (or it was deleted) |

---

## POST /api/endpoints/:endpointId/rotate-secret

**Purpose:** replace an endpoint's signing secret. Returns the new secret, once.
The old secret stops working immediately. Only for the caller's own endpoints;
limited to 10 per hour per workspace.

**Request body:** none

**Success: `200 OK`**

```json
{ "secret": "whsec_EXAMPLE000000000000000000000000000000000000" }
```

**Errors**

| Status | Code                  | When                                       |
| ------ | --------------------- | ------------------------------------------ |
| 400    | `INVALID_ENDPOINT_ID` | ID is not `ep_` + 16 hex characters        |
| 404    | `ENDPOINT_NOT_FOUND`  | No endpoint with this ID in your workspace |
| 429    | `RATE_LIMITED`        | Too many rotations                         |

---

## POST /api/endpoints/:endpointId/test-webhooks

**Purpose:** send a test webhook to an endpoint without having its secret at
hand. The server signs the payload with the endpoint's secret and delivers it **over real HTTP to its own**
`POST /api/webhooks/:endpointId`, so the test goes through exactly the same
size limit, verification, and event recording as an external webhook. This is
what the web UI's "Send test webhook" uses.

Because this route makes the server sign with an endpoint's secret, it is guarded:

- **Off by default.** Enabled only with `WEBHOOK_TEST_SENDER_ENABLED=true`.
- **Own endpoints only.** The endpoint must belong to the caller's workspace.
  The caller already received that secret, so the route reveals nothing new.
- **Rate limited.** 30 per minute per workspace.
- **JSON only.** `Content-Type: application/json` is required. Browsers cannot
  send that cross-site without a CORS preflight, which this server never
  approves, so a malicious web page cannot trigger it.

**Request headers:** `Content-Type: application/json`

**Request body:**

```json
{
  "payload": "{\"event\":\"payment.success\",\"amount\":4999}",
  "scenario": "valid"
}
```

- `payload` (required, string): the exact webhook body to send, byte for byte.
- `scenario` (optional, default `valid`): how to build the request.

| Scenario              | What the server does on purpose                        | Webhook result            |
| --------------------- | ------------------------------------------------------ | ------------------------- |
| `valid`               | Signs correctly at the current time                    | 200 `VALID`               |
| `invalid_signature`   | Signs with a random wrong secret                       | 401 `INVALID_SIGNATURE`   |
| `tampered_body`       | Signs, then adds a trailing newline to the body        | 401 `INVALID_SIGNATURE`   |
| `expired_timestamp`   | Signs correctly with a timestamp 60 s past the tolerance | 401 `TIMESTAMP_TOO_OLD` |
| `missing_signature`   | Leaves out `X-Webhook-Signature`                       | 401 `MISSING_SIGNATURE`   |
| `malformed_timestamp` | Sends the timestamp in milliseconds                    | 400 `MALFORMED_TIMESTAMP` |
| `replay`              | Sends the same correctly signed request twice; reports the second | 409 `REPLAY_DETECTED` |

Test requests are recorded like any other event, with
`user-agent: webhook-signer-test-sender`.

**Success: `200 OK`**: the test was delivered. The webhook's own result is inside:

```json
{
  "scenario": "tampered_body",
  "eventId": "evt_393d5b0185df4f91",
  "response": {
    "status": 401,
    "body": {
      "error": { "code": "INVALID_SIGNATURE", "message": "Invalid signature" },
      "eventId": "evt_393d5b0185df4f91"
    }
  }
}
```

No secret and no full signature is ever returned.

**Errors**

| Status | Code                     | When                                                    |
| ------ | ------------------------ | ------------------------------------------------------- |
| 403    | `TEST_SENDER_DISABLED`   | `WEBHOOK_TEST_SENDER_ENABLED` is not `true`             |
| 400    | `INVALID_ENDPOINT_ID`    | ID is not `ep_` + 16 hex characters                     |
| 404    | `ENDPOINT_NOT_FOUND`     | No endpoint with this ID in your workspace              |
| 415    | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type` is not `application/json`                |
| 400    | `INVALID_JSON`           | Body is not valid JSON                                  |
| 400    | `VALIDATION_ERROR`       | `payload` is not a string, or `scenario` is unknown     |
| 429    | `RATE_LIMITED`           | Too many test webhooks from this workspace              |
| 502    | `TEST_DELIVERY_FAILED`   | The server could not reach its own webhook route        |
