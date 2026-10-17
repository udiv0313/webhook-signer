// Small helpers for the native Node HTTP server: JSON responses, consistent
// errors, and reading request bodies with a size limit.

// An error that should become a specific HTTP response, e.g.
//   throw new HttpError(404, "ENDPOINT_NOT_FOUND", "Webhook endpoint was not found.");
// `headers` are added to the response (e.g. Retry-After on a 429).
// Anything thrown that is NOT an HttpError becomes a generic 500.
class HttpError extends Error {
  constructor(status, code, message, { headers = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

// Every error response has the same shape:
//   { "error": { "code": "ENDPOINT_NOT_FOUND", "message": "Webhook endpoint was not found." } }
// `extra` adds top-level fields, e.g. the eventId of a rejected webhook.
function sendError(res, status, code, message, { headers = {}, extra = {} } = {}) {
  sendJson(res, status, { error: { code, message }, ...extra }, headers);
}

function payloadTooLarge(maxBytes) {
  return new HttpError(413, "PAYLOAD_TOO_LARGE", `Request body is larger than ${maxBytes} bytes.`);
}

/**
 * Read the whole request body as raw bytes (a Buffer), but never more than
 * maxBytes. Rejects with a 413 HttpError as soon as the limit is exceeded:
 *   - immediately, if the Content-Length header already says it is too big
 *   - otherwise, while counting bytes as the chunks arrive
 * Once over the limit, nothing more is collected.
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"]);

    if (declaredLength > maxBytes) {
      reject(payloadTooLarge(maxBytes));
      return;
    }

    const chunks = [];
    let receivedBytes = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      if (tooLarge) {
        return;
      }

      receivedBytes += chunk.length;

      if (receivedBytes > maxBytes) {
        tooLarge = true;
        chunks.length = 0; // free what was collected so far
        reject(payloadTooLarge(maxBytes));
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Parse a request body as JSON, or throw a 400.
function parseJsonBody(rawBody) {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

export { HttpError, sendJson, sendError, readBody, parseJsonBody };
