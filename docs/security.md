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

Limit: a request replayed **within** the window is still accepted. Stopping that
requires remembering which webhooks were already processed (for example, by an
event ID), which needs storage.

## Per-endpoint secrets

Each endpoint signs with its own secret, derived from the master secret
(`WEBHOOK_SECRET`) and the endpoint ID with HKDF-SHA256 (`crypto.hkdfSync`).

- Different endpoints get unrelated secrets, so a signature for one endpoint is
  rejected by every other endpoint.
- The secret can always be derived again, so it is never stored, never returned
  by the API, and never logged. The CLI derives it the same way from the master
  secret and `--endpoint`.
- Trade-off: whoever holds the master secret can sign for every endpoint. That
  suits a prototype where you are both sender and receiver. A multi-tenant
  service would instead give each customer a random secret, shown once.

## What events store

Events are for debugging, so they keep the request, but not credentials:

- Only allow-listed headers are stored; `Authorization` and `Cookie` are dropped.
- The signature is stored truncated. Body + timestamp + full signature would be a
  complete request that anyone reading the (unauthenticated) events API could
  replay within the tolerance window.

## Raw request bodies

The HMAC covers exact bytes. Parsing JSON and re-serializing it can change
spacing, key order, or escaping, which changes the bytes and breaks the
signature even for an honest request. The server keeps the body as raw bytes
(`Buffer`) and verifies it before doing anything else with it.
