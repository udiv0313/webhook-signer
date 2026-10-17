import { readBody, sendJson } from "../http/helpers.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, deriveEndpointSecret, verifyWebhook } from "../core/signature.js";
import { buildEvent, logWebhook } from "../events/recording.js";
import { findEndpoint } from "./lookups.js";

function webhookRoutes({ store, now, masterSecret, toleranceSeconds, maxBodyBytes }) {
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

    const result = verifyWebhook({
      secret: deriveEndpointSecret(masterSecret, endpoint.id),
      rawBody,
      timestampHeader: req.headers[TIMESTAMP_HEADER],
      signatureHeader: req.headers[SIGNATURE_HEADER],
      toleranceSeconds,
      now: currentTime,
    });

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
