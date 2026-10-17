import crypto from "node:crypto";
import { HttpError, parseJsonBody, readBody, sendJson } from "../http/helpers.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, deriveEndpointSecret, signPayload } from "../core/signature.js";
import { findEndpoint } from "./lookups.js";

// Test sender: the server signs a test webhook (so the browser never needs the
// secret) and delivers it to itself through the normal webhook route.
// Each scenario breaks the request in one specific way, on purpose.
const TEST_SCENARIOS = [
  "valid",
  "invalid_signature",
  "tampered_body",
  "expired_timestamp",
  "missing_signature",
  "malformed_timestamp",
];
const TEST_SENDER_USER_AGENT = "webhook-signer-test-sender";
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

// "application/json; charset=utf-8" → true
function isJsonContentType(req) {
  const mediaType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();

  return mediaType === "application/json";
}

function testSenderRoutes({ store, now, masterSecret, toleranceSeconds, maxBodyBytes, testSenderEnabled }) {
  // Build a test webhook for one scenario. Signing uses the same functions as a
  // real sender (deriveEndpointSecret + signPayload); the secret never leaves here.
  function buildTestRequest(endpoint, payload, scenario) {
    const currentTime = now();
    const secret = deriveEndpointSecret(masterSecret, endpoint.id);

    let body = payload;
    let timestamp = String(currentTime);

    if (scenario === "expired_timestamp") {
      timestamp = String(currentTime - toleranceSeconds - 60);
    }

    if (scenario === "malformed_timestamp") {
      timestamp = String(currentTime * 1000); // milliseconds: a common sender bug
    }

    let signature = signPayload(secret, timestamp, payload);

    if (scenario === "invalid_signature") {
      signature = signPayload(crypto.randomBytes(32), timestamp, payload); // wrong secret
    }

    if (scenario === "tampered_body") {
      body = `${payload}\n`; // changed after signing, e.g. by middleware adding a newline
    }

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": TEST_SENDER_USER_AGENT,
      [TIMESTAMP_HEADER]: timestamp,
    };

    if (scenario !== "missing_signature") {
      headers[SIGNATURE_HEADER] = signature;
    }

    return { headers, body };
  }

  // POST /api/endpoints/:endpointId/test-webhooks
  // body: { "payload": "<exact webhook body>", "scenario": "valid" }
  //
  // This route can make the server sign anything, so it is guarded:
  //   - off unless WEBHOOK_TEST_SENDER_ENABLED=true
  //   - only callable from this machine (loopback)
  //   - only accepts Content-Type: application/json, which browsers cannot send
  //     cross-site without a CORS preflight that this server never approves
  async function sendTestWebhook(req, res, [endpointId]) {
    if (!testSenderEnabled) {
      throw new HttpError(403, "TEST_SENDER_DISABLED", "Test webhooks are disabled. Set WEBHOOK_TEST_SENDER_ENABLED=true.");
    }

    if (!LOOPBACK_ADDRESSES.includes(req.socket.remoteAddress)) {
      throw new HttpError(403, "TEST_SENDER_LOCAL_ONLY", "Test webhooks can only be sent from this machine.");
    }

    const endpoint = findEndpoint(store, endpointId);

    if (!isJsonContentType(req)) {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
    }

    const body = parseJsonBody(await readBody(req, maxBodyBytes));
    const payload = body?.payload;
    const scenario = body?.scenario ?? "valid";

    if (typeof payload !== "string") {
      throw new HttpError(400, "VALIDATION_ERROR", '"payload" must be a string: the exact webhook body to send.');
    }

    if (!TEST_SCENARIOS.includes(scenario)) {
      throw new HttpError(400, "VALIDATION_ERROR", `"scenario" must be one of: ${TEST_SCENARIOS.join(", ")}.`);
    }

    const testRequest = buildTestRequest(endpoint, payload, scenario);

    // Deliver through real HTTP to this same server, so the test webhook goes
    // through exactly the same route, size limit, verification, and recording.
    let delivery;

    try {
      delivery = await fetch(`http://127.0.0.1:${req.socket.localPort}/api/webhooks/${endpoint.id}`, {
        method: "POST",
        headers: testRequest.headers,
        body: testRequest.body,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new HttpError(502, "TEST_DELIVERY_FAILED", "The test webhook could not be delivered to this server.");
    }

    const responseBody = await delivery.json().catch(() => null);

    sendJson(res, 200, {
      scenario,
      eventId: responseBody?.eventId ?? null,
      response: { status: delivery.status, body: responseBody },
    });
  }

  return [{ method: "POST", pattern: /^\/api\/endpoints\/([^/]+)\/test-webhooks$/, handler: sendTestWebhook }];
}

export { testSenderRoutes };
