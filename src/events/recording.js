import { SIGNATURE_HEADER, TIMESTAMP_HEADER, parseTimestamp } from "../core/signature.js";
import { generateId } from "../lib/ids.js";
import { isoTime } from "../lib/time.js";

// Turns an incoming webhook into the event record shown in the inspector,
// and prints it to the console.

// Only these request headers are stored in events and logs. Everything else
// (Authorization, Cookie, ...) is dropped so credentials are never recorded.
const RECORDED_HEADERS = ["content-type", "content-length", "user-agent", TIMESTAMP_HEADER, SIGNATURE_HEADER];

// Keep "sha256=" plus the first 12 hex characters. Enough to compare with what
// the sender computed, but not a complete signature anyone could replay.
function truncateSignature(value) {
  return value.length > 19 ? `${value.slice(0, 19)}…` : value;
}

function pickRecordedHeaders(req) {
  const headers = {};

  for (const name of RECORDED_HEADERS) {
    const value = req.headers[name];

    if (value !== undefined) {
      headers[name] = name === SIGNATURE_HEADER ? truncateSignature(value) : value;
    }
  }

  return headers;
}

// For display only: the "event" (or "type") field of a JSON body, e.g.
// "payment.success". Returns null when the body is not JSON or has no such field.
function detectEventType(body) {
  if (body === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(body);
    const value = parsed?.event ?? parsed?.type;

    return typeof value === "string" ? value.slice(0, 100) : null;
  } catch {
    return null;
  }
}

// rawBody is null when the body was too large to read.
function buildEvent({ endpoint, req, rawBody, verification, status, currentTime }) {
  const timestamp = parseTimestamp(req.headers[TIMESTAMP_HEADER]);

  return {
    id: generateId("evt"),
    endpointId: endpoint.id,
    receivedAt: isoTime(currentTime),
    request: {
      method: req.method,
      path: new URL(req.url, "http://localhost").pathname, // no query string
      headers: pickRecordedHeaders(req),
      body: rawBody === null ? null : rawBody.toString("utf8"),
      bodyBytes: rawBody === null ? null : rawBody.length,
    },
    verification: {
      ...verification,
      timestampAgeSeconds: timestamp === null ? null : currentTime - timestamp,
    },
    response: { status },
  };
}

// The short form used in event lists: no request body or headers.
function toEventSummary(event) {
  const { valid, code, reason } = event.verification;

  return {
    id: event.id,
    receivedAt: event.receivedAt,
    eventType: detectEventType(event.request.body),
    verification: { valid, code, reason },
    responseStatus: event.response.status,
  };
}

// Print each webhook to the console. Uses the same safe data as the stored event.
function logWebhook(event) {
  const { request, verification } = event;

  console.log("\n--- Webhook Request ---");
  console.log(`Event:          ${event.id}`);
  console.log(`Endpoint:       ${event.endpointId}`);
  console.log(`Method / Path:  ${request.method} ${request.path}`);
  console.log(`Content-Type:   ${request.headers["content-type"] ?? "(none)"}`);
  console.log(`Timestamp:      ${request.headers[TIMESTAMP_HEADER] ?? "(none)"} (age: ${verification.timestampAgeSeconds ?? "?"}s)`);
  console.log(`Signature:      ${request.headers[SIGNATURE_HEADER] ?? "(none)"}`);
  console.log(`Raw body:       ${request.body ?? "(not read: too large)"}`);
  console.log(`Result:         ${event.response.status} ${verification.reason}`);
}

export { buildEvent, toEventSummary, logWebhook };
