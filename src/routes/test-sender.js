import crypto from "node:crypto";
import { HttpError, parseJsonBody, readBody, sendJson } from "../http/helpers.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signPayload } from "../core/signature.js";
import { findOwnedEndpoint } from "./lookups.js";

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
  "replay",
];
const TEST_SENDER_USER_AGENT = "webhook-signer-test-sender";

// "application/json; charset=utf-8" → true
function isJsonContentType(req) {
  const mediaType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();

  return mediaType === "application/json";
}

/** Returns the test-sender route as { method, pattern, handler } entries. */
function testSenderRoutes({
  store,
  sessions,
  now,
  endpointSecret,
  rateLimit,
  internalDelivery,
  toleranceSeconds,
  maxBodyBytes,
  testSenderEnabled,
}) {
  // Build a test webhook for one scenario. Signing uses the same function as a
  // real sender (signPayload) with the endpoint's own secret, which never
  // leaves the server here.
  function buildTestRequest(endpoint, payload, scenario) {
    const currentTime = now();
    const secret = endpointSecret(endpoint.id);

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
  // This route makes the server sign with an endpoint's secret, so it is guarded:
  //   - off unless WEBHOOK_TEST_SENDER_ENABLED=true
  //   - only for endpoints in the caller's own workspace, whose secret the
  //     caller already received, so it reveals nothing new
  //   - rate limited per workspace
  //   - only accepts Content-Type: application/json, which browsers cannot send
  //     cross-site without a CORS preflight that this server never approves
  async function sendTestWebhook(req, res, [endpointId]) {
    if (!testSenderEnabled) {
      throw new HttpError(403, "TEST_SENDER_DISABLED", "Test webhooks are disabled. Set WEBHOOK_TEST_SENDER_ENABLED=true.");
    }

    // Only the caller's own endpoints can be signed for.
    const workspace = sessions.find(req);
    const endpoint = findOwnedEndpoint(store, workspace, endpointId);

    rateLimit("testWebhook", workspace.id);

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
    async function deliver() {
      try {
        return await fetch(`http://127.0.0.1:${req.socket.localPort}/api/webhooks/${endpoint.id}`, {
          method: "POST",
          // Marks this as the server's own delivery, so it does not count against
          // the per-IP limit that all users' test webhooks would otherwise share.
          headers: { ...testRequest.headers, [internalDelivery.header]: internalDelivery.token },
          body: testRequest.body,
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        throw new HttpError(502, "TEST_DELIVERY_FAILED", "The test webhook could not be delivered to this server.");
      }
    }

    // "replay" sends the identical signed request twice, like an attacker
    // re-sending a captured webhook. The second delivery is the one reported.
    if (scenario === "replay") {
      await (await deliver()).arrayBuffer();
    }

    const delivery = await deliver();
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
