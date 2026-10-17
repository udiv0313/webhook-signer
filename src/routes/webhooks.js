import { readBody, sendJson } from "../http/helpers.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, parseTimestamp, signatureFingerprint, verifyWebhook } from "../core/signature.js";
import { buildEvent, logWebhook } from "../events/recording.js";
import { findEndpoint } from "./lookups.js";

/**
 * The public webhook receiver: POST /api/webhooks/:endpointId. Reads the raw
 * body, verifies it (size, headers, timestamp, signature, replay), records the
 * outcome as an event, and answers the sender. Needs no cookie.
 */

/** Returns the webhook route as { method, pattern, handler } entries. */
function webhookRoutes({ store, now, endpointSecret, rateLimit, toleranceSeconds, maxBodyBytes }) {
  function recordEvent(details) {
    const event = buildEvent(details);

    store.insertEvent(event);
    logWebhook(event);

    return event;
  }

  // Send a webhook response and keep an exact copy in the event, so the
  // inspector can show what the sender received.
  function respondToWebhook(res, event, status, payload, headers = {}) {
    store.setEventResponseBody(event.id, payload);
    sendJson(res, status, payload, headers);
  }

  // POST /api/webhooks/:endpointId
  async function receiveWebhook(req, res, [endpointId]) {
    const endpoint = findEndpoint(store, endpointId);

    // Before reading the body, so a flood costs no storage. Refused requests
    // are not recorded as events.
    rateLimit("receiveWebhook", endpoint.id);

    // Raw bytes, exactly as sent. Never parsed or re-serialized before verifying.
    let rawBody;

    try {
      rawBody = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error.code !== "PAYLOAD_TOO_LARGE") {
        throw error;
      }

      // Too big: record it so it can be debugged, but never verify it.
      const event = recordEvent({
        endpoint,
        req,
        rawBody: null,
        verification: { valid: false, code: error.code, reason: "Body too large; not verified" },
        status: 413,
        currentTime: now(),
      });

      const payload = { error: { code: error.code, message: error.message }, eventId: event.id };

      respondToWebhook(res, event, 413, payload, { Connection: "close" });
      return;
    }

    // All cryptography (HMAC, timestamp window, constant-time compare) lives in
    // core/signature.js. The route only supplies the inputs.
    const currentTime = now();

    let result = verifyWebhook({
      secret: endpointSecret(endpoint.id),
      rawBody,
      timestampHeader: req.headers[TIMESTAMP_HEADER],
      signatureHeader: req.headers[SIGNATURE_HEADER],
      toleranceSeconds,
      now: currentTime,
    });

    // Replay protection. A captured request re-sent within the tolerance
    // window has a valid signature and timestamp, so it passes every check
    // above. Remember each accepted signature until its timestamp expires, and
    // refuse a second delivery of the exact same request.
    if (result.valid) {
      const expiresAt = parseTimestamp(req.headers[TIMESTAMP_HEADER]) + toleranceSeconds + 1;
      const firstTime = store.rememberSignature(endpoint.id, signatureFingerprint(req.headers[SIGNATURE_HEADER]), expiresAt);

      if (!firstTime) {
        result = { valid: false, status: 409, code: "REPLAY_DETECTED", reason: "Replay detected" };
      }
    }

    const event = recordEvent({
      endpoint,
      req,
      rawBody,
      verification: { valid: result.valid, code: result.code, reason: result.reason },
      status: result.status,
      currentTime,
    });

    if (!result.valid) {
      const payload = { error: { code: result.code, message: result.reason }, eventId: event.id };

      respondToWebhook(res, event, result.status, payload);
      return;
    }

    respondToWebhook(res, event, 200, { received: true, eventId: event.id });
  }

  return [{ method: "POST", pattern: /^\/api\/webhooks\/([^/]+)$/, handler: receiveWebhook }];
}

export { webhookRoutes };
