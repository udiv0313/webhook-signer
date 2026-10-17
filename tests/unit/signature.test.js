import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  createSignedMessage,
  parseTimestamp,
  safeEqual,
  signatureFingerprint,
  signPayload,
  verifyWebhook,
} from "../../src/core/signature.js";

const SECRET = "test-secret";
const BODY = Buffer.from('{"event":"payment.success","amount":4999}');
const TOLERANCE = 300;

// A fixed "current time", so no test depends on the real clock.
const NOW = 1_700_000_000;

// Verify a webhook as the server would at time NOW. By default the request is
// signed correctly at NOW; each test overrides only the part it cares about.
function verify({ timestamp = NOW, body = BODY, ...overrides } = {}) {
  return verifyWebhook({
    secret: SECRET,
    rawBody: body,
    timestampHeader: String(timestamp),
    signatureHeader: signPayload(SECRET, timestamp, body),
    toleranceSeconds: TOLERANCE,
    now: NOW,
    ...overrides,
  });
}

// --- Signing format ----------------------------------------------------------

test("the signed message is <timestamp>.<raw body>", () => {
  const message = createSignedMessage(1712345678, '{"event":"payment.success"}');

  assert.equal(message.toString(), '1712345678.{"event":"payment.success"}');
});

test("signPayload is sha256= followed by the hex HMAC of <timestamp>.<raw body>", () => {
  const expectedHex = crypto.createHmac("sha256", SECRET).update(`${NOW}.${BODY}`).digest("hex");

  assert.equal(signPayload(SECRET, NOW, BODY), "sha256=" + expectedHex);
});

test("changing only the timestamp changes the signature", () => {
  assert.notEqual(signPayload(SECRET, NOW, BODY), signPayload(SECRET, NOW + 1, BODY));
});

test("parseTimestamp accepts Unix seconds and rejects anything else", () => {
  assert.equal(parseTimestamp("1712345678"), 1712345678);
  assert.equal(parseTimestamp("0"), 0);

  for (const bad of ["", "abc", "-60", "1.5", "1e9", " 1712345678", "1712345678000", undefined]) {
    assert.equal(parseTimestamp(bad), null, `value: ${bad}`);
  }
});

// --- Verification ------------------------------------------------------------

test("valid signature + current timestamp → valid", () => {
  assert.deepEqual(verify(), { valid: true, status: 200, code: "VALID", reason: "Valid signature" });
});

test("uppercase hex in the signature is accepted", () => {
  const signatureHeader = signPayload(SECRET, NOW, BODY).replace(/[0-9a-f]{64}$/, (hex) => hex.toUpperCase());

  assert.equal(verify({ signatureHeader }).valid, true);
});

test("missing timestamp → 400 MISSING_TIMESTAMP", () => {
  assert.deepEqual(verify({ timestampHeader: undefined }), {
    valid: false,
    status: 400,
    code: "MISSING_TIMESTAMP",
    reason: "Missing timestamp",
  });
  assert.equal(verify({ timestampHeader: "" }).code, "MISSING_TIMESTAMP");
});

test("malformed timestamp → 400 MALFORMED_TIMESTAMP", () => {
  const result = verify({ timestampHeader: "yesterday" });

  assert.equal(result.status, 400);
  assert.equal(result.code, "MALFORMED_TIMESTAMP");
});

test("missing signature → 401 MISSING_SIGNATURE", () => {
  const result = verify({ signatureHeader: undefined });

  assert.equal(result.status, 401);
  assert.equal(result.code, "MISSING_SIGNATURE");
});

test("malformed signature → 400 MALFORMED_SIGNATURE", () => {
  const result = verify({ signatureHeader: "sha256=abc" });

  assert.equal(result.status, 400);
  assert.equal(result.code, "MALFORMED_SIGNATURE");
});

test("timestamp exactly at the tolerance boundary → valid (both directions)", () => {
  assert.equal(verify({ timestamp: NOW - TOLERANCE }).valid, true);
  assert.equal(verify({ timestamp: NOW + TOLERANCE }).valid, true);
});

test("timestamp one second outside the tolerance → 401 (both directions)", () => {
  const tooOld = verify({ timestamp: NOW - TOLERANCE - 1 });
  const tooNew = verify({ timestamp: NOW + TOLERANCE + 1 });

  assert.deepEqual([tooOld.status, tooOld.code, tooOld.reason], [401, "TIMESTAMP_TOO_OLD", "Timestamp too old"]);
  assert.deepEqual(
    [tooNew.status, tooNew.code, tooNew.reason],
    [401, "TIMESTAMP_IN_FUTURE", "Timestamp too far in the future"],
  );
});

test("tolerance comes from the caller, not from the verification logic", () => {
  assert.equal(verify({ timestamp: NOW - 100, toleranceSeconds: 100 }).valid, true);
  assert.equal(verify({ timestamp: NOW - 101, toleranceSeconds: 100 }).valid, false);
});

test("valid timestamp + signature made with the wrong secret → 401 INVALID_SIGNATURE", () => {
  const result = verify({ signatureHeader: signPayload("wrong-secret", NOW, BODY) });

  assert.deepEqual([result.status, result.code, result.reason], [401, "INVALID_SIGNATURE", "Invalid signature"]);
});

test("body modified after signing → INVALID_SIGNATURE", () => {
  const signatureHeader = signPayload(SECRET, NOW, BODY);
  const tampered = Buffer.from('{"event":"payment.success","amount":1}');

  assert.equal(verify({ body: tampered, signatureHeader }).code, "INVALID_SIGNATURE");
});

test("timestamp changed after signing (refreshed replay) → INVALID_SIGNATURE", () => {
  const capturedSignature = signPayload(SECRET, NOW - 3600, BODY);

  assert.equal(verify({ timestamp: NOW, signatureHeader: capturedSignature }).code, "INVALID_SIGNATURE");
});

test("checks run in order: format, then freshness, then signature", () => {
  // Malformed timestamp is reported even though the signature is also bad.
  assert.equal(verify({ timestampHeader: "abc", signatureHeader: "bad" }).code, "MALFORMED_TIMESTAMP");

  // An old timestamp is rejected before the (wrong) signature is ever checked.
  const wrongSecret = signPayload("wrong-secret", NOW - 3600, BODY);
  assert.equal(verify({ timestamp: NOW - 3600, signatureHeader: wrongSecret }).code, "TIMESTAMP_TOO_OLD");
});

test("safeEqual returns false (and does not throw) for buffers of different lengths", () => {
  assert.equal(safeEqual(Buffer.alloc(32), Buffer.alloc(31)), false);
  assert.equal(safeEqual(Buffer.alloc(32), Buffer.alloc(32)), true);
});

// --- Replay fingerprints -------------------------------------------------------

test("signatureFingerprint ignores hex case and never contains the signature", () => {
  const header = signPayload(SECRET, NOW, BODY);
  const upper = "sha256=" + header.slice("sha256=".length).toUpperCase();

  assert.match(signatureFingerprint(header), /^[0-9a-f]{64}$/);
  assert.equal(signatureFingerprint(header), signatureFingerprint(upper));
  assert.notEqual(signatureFingerprint(header), header.slice("sha256=".length));
  assert.notEqual(signatureFingerprint(header), signatureFingerprint(signPayload(SECRET, NOW + 1, BODY)));
});
