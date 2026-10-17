import crypto from "node:crypto";

// The headers the sender must include, e.g.
//   X-Webhook-Timestamp: 1712345678
//   X-Webhook-Signature: sha256=3f2a...(64 hex characters)
// Node lowercases all incoming header names, so we look them up in lowercase.
const TIMESTAMP_HEADER = "x-webhook-timestamp";
const SIGNATURE_HEADER = "x-webhook-signature";

// "sha256=" followed by exactly 64 hex characters (32 bytes of HMAC-SHA256).
const SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;

// Unix time in whole seconds: 1 to 10 digits and nothing else.
// This rejects signs, decimals, spaces, and 13-digit millisecond timestamps.
const TIMESTAMP_PATTERN = /^[0-9]{1,10}$/;

/**
 * Derive one endpoint's signing secret from the master secret (WEBHOOK_SECRET).
 *
 * HKDF is a standard way to turn one master key into many independent keys.
 * Different endpoint IDs give unrelated secrets, and nobody can work backwards
 * from an endpoint secret to the master secret. Because the secret can always
 * be derived again, it never needs to be stored or returned by the API.
 */
function deriveEndpointSecret(masterSecret, endpointId) {
  const keyBytes = crypto.hkdfSync("sha256", masterSecret, "", `webhook-signer:endpoint:${endpointId}`, 32);

  return Buffer.from(keyBytes);
}

/**
 * Build the exact bytes that get signed:  <timestamp>.<raw body>
 * Example: 1712345678.{"event":"payment.success"}
 *
 * The timestamp is part of the signed message, so changing it breaks the
 * signature. That is what stops an attacker from "refreshing" an old request.
 */
function createSignedMessage(timestamp, rawBody) {
  return Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(rawBody)]);
}

/**
 * Compute the HMAC-SHA256 of the signed message using the shared secret.
 * Returns the raw 32-byte digest as a Buffer.
 */
function computeHmac(secret, timestamp, rawBody) {
  return crypto.createHmac("sha256", secret).update(createSignedMessage(timestamp, rawBody)).digest();
}

/**
 * Create the signature header value a sender should attach to a webhook.
 * Example result: "sha256=3f2a..."
 */
function signPayload(secret, timestamp, rawBody) {
  return "sha256=" + computeHmac(secret, timestamp, rawBody).toString("hex");
}

/**
 * Turn a timestamp string like "1712345678" into a number.
 * Returns null if it is not Unix time in whole seconds.
 */
function parseTimestamp(value) {
  if (!TIMESTAMP_PATTERN.test(value)) {
    return null;
  }

  return Number(value);
}

/**
 * Turn a header value like "sha256=abcd..." into the 32 signature bytes.
 * Returns null if the header is not in the expected format.
 */
function parseSignatureHeader(headerValue) {
  const match = SIGNATURE_PATTERN.exec(headerValue.trim());

  if (!match) {
    return null;
  }

  return Buffer.from(match[1], "hex");
}

/**
 * Compare two Buffers in constant time.
 *
 * crypto.timingSafeEqual throws if the lengths differ, so we check the
 * length first. A different length can never be a match anyway.
 */
function safeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

/**
 * Check that a webhook is well-formed, fresh, and authentic.
 *
 *   secret            the endpoint's HMAC secret (see deriveEndpointSecret)
 *   rawBody          the request body exactly as received (Buffer or string)
 *   timestampHeader   value of X-Webhook-Timestamp (or undefined)
 *   signatureHeader   value of X-Webhook-Signature (or undefined)
 *   toleranceSeconds  how far the timestamp may be from `now`, in either direction
 *   now               the current Unix time in seconds
 *
 * Returns { valid, status, code, reason }, for example:
 *   { valid: true,  status: 200, code: "VALID",             reason: "Valid signature" }
 *   { valid: false, status: 400, code: "MISSING_TIMESTAMP", reason: "Missing timestamp" }
 *   { valid: false, status: 401, code: "INVALID_SIGNATURE", reason: "Invalid signature" }
 *
 * 400 means a header is missing or malformed. 401 means the signature is
 * missing or wrong, or the timestamp is outside the allowed window.
 */
function verifyWebhook({ secret, rawBody, timestampHeader, signatureHeader, toleranceSeconds, now }) {
  // Step 1: is the request well-formed? These checks are cheap and need no secret.
  if (timestampHeader === undefined || timestampHeader === "") {
    return rejected(400, "MISSING_TIMESTAMP", "Missing timestamp");
  }

  const timestamp = parseTimestamp(timestampHeader);

  if (timestamp === null) {
    return rejected(400, "MALFORMED_TIMESTAMP", "Malformed timestamp");
  }

  if (signatureHeader === undefined || signatureHeader === "") {
    return rejected(401, "MISSING_SIGNATURE", "Missing signature");
  }

  const receivedSignature = parseSignatureHeader(signatureHeader);

  if (receivedSignature === null) {
    return rejected(400, "MALFORMED_SIGNATURE", "Malformed signature");
  }

  // Step 2: is it fresh? Reject before doing any crypto.
  // age > 0 means the timestamp is in the past, age < 0 means in the future.
  const age = now - timestamp;

  if (age > toleranceSeconds) {
    return rejected(401, "TIMESTAMP_TOO_OLD", "Timestamp too old");
  }

  if (age < -toleranceSeconds) {
    return rejected(401, "TIMESTAMP_IN_FUTURE", "Timestamp too far in the future");
  }

  // Step 3: is it authentic? Rebuild the signed message from the timestamp
  // exactly as received plus the raw body, and compare in constant time.
  const expectedSignature = computeHmac(secret, timestampHeader, rawBody);

  if (!safeEqual(receivedSignature, expectedSignature)) {
    return rejected(401, "INVALID_SIGNATURE", "Invalid signature");
  }

  return { valid: true, status: 200, code: "VALID", reason: "Valid signature" };
}

function rejected(status, code, reason) {
  return { valid: false, status, code, reason };
}

export {
  TIMESTAMP_HEADER,
  SIGNATURE_HEADER,
  deriveEndpointSecret,
  createSignedMessage,
  signPayload,
  parseTimestamp,
  parseSignatureHeader,
  safeEqual,
  verifyWebhook,
};
