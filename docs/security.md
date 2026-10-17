# Security notes

A short explanation of the ideas this project relies on.

## HMAC

HMAC-SHA256 combines a **secret key** with a message and produces a 32-byte
value. Anyone can compute a plain SHA-256 hash, but only someone who knows the
secret can compute the HMAC. If the sender and receiver share a secret, a correct
HMAC proves the message came from someone holding that secret.

## Signature verification

The receiver never "decrypts" a signature. It recomputes the HMAC over the same
message with its own copy of the secret and checks that the result matches the
signature that was sent. Same secret + same message bytes → same signature.

In this project the signed message is:

```
<X-Webhook-Timestamp>.<raw request body>
```

## Timing-safe comparison

A normal comparison (`===`) stops at the first byte that differs, so it finishes
slightly faster for a "more wrong" guess. An attacker who measures response times
could use that to guess a valid signature byte by byte.
`crypto.timingSafeEqual` always compares every byte, so its timing reveals
nothing. It throws if the two values have different lengths, so we check the
length first and treat a mismatch as invalid.

## Replay attacks

An attacker who captures a valid request (from a log, a proxy, or a compromised
network) can send the exact same bytes again. The signature is still correct,
because nothing changed, so HMAC alone would accept it.

## Timestamp tolerance

The sender adds the current Unix time (`X-Webhook-Timestamp`) and includes it in
the signed message. The receiver rejects requests whose timestamp is more than
`WEBHOOK_TOLERANCE_SECONDS` away from its own clock, in either direction.

- A captured request stops working once it is older than the tolerance.
- The attacker cannot update the timestamp, because it is signed: changing it
  breaks the signature.
- The window allows for normal network delay and small clock differences.
  Keep server clocks synced (NTP).

A request replayed **within** the window would still pass, so there is one
more check.

## Replay protection

After a webhook passes every other check, the server records a fingerprint of
its signature (sha256 of the signature bytes) for that endpoint, until the
request's timestamp leaves the tolerance window. A second delivery of the same
request gets `409 REPLAY_DETECTED`.

- **Why the signature:** it covers the timestamp and the exact body, so it
  identifies one specific signed request. A legitimate retry is signed again
  with a new timestamp, so it has a different signature.
- **Atomic:** one `INSERT OR IGNORE` on a primary key, so two copies arriving
  at the same moment cannot both be accepted.
- **Bounded:** fingerprints older than the window are deleted every minute.
  After that the timestamp check rejects the request anyway.
- **Only a hash is stored,** never the signature (stored events keep only a
  short prefix of it too).
- Rejected requests are not remembered, so an honest request that failed (say,
  a wrong secret) can be sent again correctly.
- In SQLite, so it survives restarts.

## Response headers

Every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer` (URLs contain endpoint IDs), `X-Frame-Options: DENY`, and a
Content-Security-Policy. The page's policy allows scripts, styles and requests
only from its own origin (no inline scripts), so injected markup cannot run
code. API responses get `default-src 'none'`. Over HTTPS (`COOKIE_SECURE=true`)
`Strict-Transport-Security` is added too.

## Per-endpoint secrets

Each endpoint has its own random secret: `whsec_` + 32 random bytes.

- **Independent.** Secrets are not derived from anything, so knowing one (or the
  master secret) does not let you sign for any other endpoint.
- **Shown once.** The API returns a secret only in the response that created or
  rotated it. Lost secrets are replaced, never recovered.
- **Encrypted at rest.** The database stores each secret encrypted with
  AES-256-GCM, under a key derived from `WEBHOOK_SECRET` (HKDF). A copy of the
  database alone reveals nothing. GCM also detects tampering, and the endpoint
  ID is authenticated with the ciphertext, so a sealed secret copied onto
  another endpoint's row does not decrypt.
- **Rotation.** Replaces the secret at once. There is no overlap period, so the
  sender must switch immediately.
- **CLI.** Reads the secret from `WEBHOOK_ENDPOINT_SECRET`, not an argument, so
  it stays out of shell history and the process list.

## Test sender

The server can sign a test webhook on request. That is a "signing oracle": if
anyone could use it for any endpoint, they could produce valid webhooks without
knowing the secret. So it only works for endpoints in the caller's own
workspace, whose secret the caller was already shown, and is rate limited. (An
earlier version only allowed requests from localhost; behind a reverse proxy
every request looks local, so that check protected nothing.)

## Rate limits

In-memory fixed windows, answering `429` with `Retry-After`:

| What | Limit | Counted per |
| --- | --- | --- |
| Any request | 300 / minute | client IP |
| Create endpoint | 10 / hour | client IP |
| Endpoints per workspace | 20 | workspace |
| Receive webhook | 120 / minute | endpoint |
| Test webhook | 30 / minute | workspace |
| Rotate secret | 10 / hour | workspace |

- Webhooks over the limit are refused before the body is read and are not
  stored, so a flood costs neither memory nor disk.
- **Client IP behind a proxy.** Every request then comes from the proxy, so
  `TRUST_PROXY=true` takes the last `X-Forwarded-For` entry (the address the
  proxy saw). Leave it off without a proxy: clients could send any value.
- The test sender delivers to its own webhook route from the server's own
  address. Those deliveries carry a random per-process token, so they do not
  use up one shared per-IP budget for all users.

## Anonymous workspaces

Each browser gets a workspace, so visitors cannot see each other's endpoints or
events, without anyone signing up.

- **Token, not ID, in the cookie.** The cookie holds 32 random bytes (256 bits),
  which cannot be guessed. The workspace ID never leaves the server.
- **Only a hash is stored.** The database keeps `sha256(token)`. Someone who reads
  the database file (or a backup) cannot turn it into a working cookie. A fast
  hash is enough here: the token is random, so there is nothing to brute-force
  the way there would be with a password.
- **Cookie flags.** `HttpOnly`: page JavaScript cannot read it, so an XSS bug
  cannot steal it. `SameSite=Lax`: other sites cannot make the browser send it
  with cross-site POSTs. `Secure` (`COOKIE_SECURE=true`): only sent over HTTPS.
- **Fixed lifetime.** Workspaces expire `WORKSPACE_TTL_HOURS` after creation and
  are never extended. Expiry is checked on every request, not only through the
  cookie's `Max-Age`, so a copied cookie stops working on time too.
- **Ownership is checked in SQL** (`WHERE workspace_id = ?`), so no route can
  forget to filter.
- **404, not 403.** Another workspace's endpoint looks exactly like a missing
  one. A 403 would confirm that the ID exists.
- **Nothing is created by reading.** Only creating an endpoint creates a
  workspace, so crawlers and scanners cannot fill the database.

Limit: anyone who has the endpoint ID can still *send* webhooks to it. That is
by design (it is the webhook URL), and only correctly signed ones are accepted.

## What events store

Events are for debugging, so they keep the request, but not credentials:

- Only allow-listed headers are stored; `Authorization` and `Cookie` are dropped.
- The signature is stored truncated. Body + timestamp + full signature would be a
  complete request that anyone reading the events could replay within the
  tolerance window.

## Raw request bodies

The HMAC covers exact bytes. Parsing JSON and re-serializing it can change
spacing, key order, or escaping, which changes the bytes and breaks the
signature even for an honest request. The server keeps the body as raw bytes
(`Buffer`) and verifies it before doing anything else with it.
