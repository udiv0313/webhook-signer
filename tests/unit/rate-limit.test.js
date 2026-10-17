import test from "node:test";
import assert from "node:assert/strict";
import { clientIp, createRateLimiter } from "../../src/http/rate-limit.js";

const RULE = { limit: 3, windowSeconds: 60 };

function limiterAt(clock) {
  return createRateLimiter({ now: () => clock.now });
}

test("allows `limit` requests per window, then refuses with the seconds left", () => {
  const clock = { now: 1000 };
  const limiter = limiterAt(clock);

  for (let i = 0; i < 3; i++) {
    assert.deepEqual(limiter.hit("b", "k", RULE), { allowed: true });
  }

  clock.now = 1015;
  assert.deepEqual(limiter.hit("b", "k", RULE), { allowed: false, retryAfterSeconds: 45 });
});

test("a new window starts once the old one ends", () => {
  const clock = { now: 1000 };
  const limiter = limiterAt(clock);

  for (let i = 0; i < 3; i++) limiter.hit("b", "k", RULE);

  clock.now = 1060;
  assert.deepEqual(limiter.hit("b", "k", RULE), { allowed: true });
});

test("buckets and keys are counted separately", () => {
  const limiter = limiterAt({ now: 1000 });

  for (let i = 0; i < 3; i++) limiter.hit("b", "k", RULE);

  assert.equal(limiter.hit("b", "k", RULE).allowed, false);
  assert.equal(limiter.hit("b", "other-key", RULE).allowed, true);
  assert.equal(limiter.hit("other-bucket", "k", RULE).allowed, true);
});

test("prune forgets ended windows only", () => {
  const clock = { now: 1000 };
  const limiter = limiterAt(clock);

  limiter.hit("b", "old", RULE);
  clock.now = 1030;
  limiter.hit("b", "new", RULE);
  clock.now = 1060;
  limiter.prune();

  assert.equal(limiter.size, 1);
});

test("clientIp uses the connection unless trustProxy is on", () => {
  const req = { socket: { remoteAddress: "10.0.0.1" }, headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" } };

  assert.equal(clientIp(req, false), "10.0.0.1");
  // Behind one proxy, the last entry is the address that proxy saw. Entries
  // before it were sent by the client and could be anything.
  assert.equal(clientIp(req, true), "198.51.100.7");
  assert.equal(clientIp({ ...req, headers: {} }, true), "10.0.0.1");
});

test("clientIp with N proxies takes the Nth entry from the end (e.g. Render: 2)", () => {
  // The client sent a fake first entry; proxy 1 appended the real client
  // (203.0.113.9); proxy 2 appended proxy 1's address (198.51.100.7).
  const req = {
    socket: { remoteAddress: "10.0.0.1" },
    headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9, 198.51.100.7" },
  };

  assert.equal(clientIp(req, 1), "198.51.100.7");
  assert.equal(clientIp(req, 2), "203.0.113.9");
  assert.equal(clientIp(req, 0), "10.0.0.1");

  // Fewer entries than proxies: the header is not trustworthy, use the connection.
  assert.equal(clientIp({ ...req, headers: { "x-forwarded-for": "203.0.113.9" } }, 2), "10.0.0.1");
});
