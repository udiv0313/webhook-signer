// The only place the frontend talks to the backend.
//
// All paths are relative (/api/...). In development the Vite dev server forwards
// them to the backend (see vite.config.js), so the browser never makes a
// cross-origin request and the backend needs no CORS headers.
//
// No secrets are stored in the frontend. An endpoint's secret appears exactly
// once (in the create or rotate response) so the user can copy it; it is kept
// only in component state while shown. Signing test webhooks is done by the
// backend.

// Every failure becomes an ApiError, so components only handle one error shape.
//   status  HTTP status, or 0 when the request never got a response
//   code    the API's error code (e.g. ENDPOINT_NOT_FOUND) or a client-side one
export class ApiError extends Error {
  constructor({ status, code, message }) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = "GET", body } = {}) {
  let response;

  // 1. Network errors: fetch() only rejects when there is no HTTP response at
  //    all (server down, DNS, connection refused). It does NOT reject on 404/500.
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Could not reach the server. Check that the frontend dev server and the backend are running.",
    });
  }

  // 2. Read the body as text first, so a non-JSON response cannot crash us.
  const text = await response.text();
  let data = null;

  if (text !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError({
        status: response.status,
        code: "MALFORMED_RESPONSE",
        message: `Expected JSON from the API but got HTTP ${response.status} with: ${text.slice(0, 120)}`,
      });
    }
  }

  // 3. Non-2xx responses: use the API's { error: { code, message } } if present.
  if (!response.ok) {
    if (data?.error?.code) {
      throw new ApiError({ status: response.status, code: data.error.code, message: data.error.message });
    }

    // An empty 5xx usually means the Vite proxy could not reach the backend.
    throw new ApiError({
      status: response.status,
      code: "HTTP_ERROR",
      message:
        response.status >= 500
          ? `HTTP ${response.status} with no API error body. The backend is probably not running (npm start).`
          : `Request failed with HTTP ${response.status}.`,
    });
  }

  return data;
}

// GET /api/endpoints → [{ id, name, status, createdAt, webhookPath, recentEventCount }]
export async function getEndpoints() {
  const data = await request("/api/endpoints");
  return data.endpoints;
}

// POST /api/endpoints → the new endpoint, including its signing `secret`.
// This is the only response that contains it; GET /api/endpoints never does.
export function createEndpoint(name) {
  return request("/api/endpoints", { method: "POST", body: { name } });
}

// POST /api/endpoints/:id/rotate-secret → { secret }
// The old secret stops working immediately.
export function rotateEndpointSecret(endpointId) {
  return request(`/api/endpoints/${encodeURIComponent(endpointId)}/rotate-secret`, { method: "POST" });
}

// GET /api/endpoints/:id/events → newest-first event summaries
export async function getEndpointEvents(endpointId) {
  const data = await request(`/api/endpoints/${encodeURIComponent(endpointId)}/events`);
  return data.events;
}

// GET /api/events/:id → one full event (request, verification, response)
export function getEvent(eventId) {
  return request(`/api/events/${encodeURIComponent(eventId)}`);
}

// POST /api/endpoints/:id/test-webhooks → { scenario, eventId, response: { status, body } }
// The backend signs and delivers the webhook. A 200 here means "the test was
// sent"; the webhook's own result (200, 401, 400...) is in response.status.
export function sendTestWebhook(endpointId, { payload, scenario }) {
  return request(`/api/endpoints/${encodeURIComponent(endpointId)}/test-webhooks`, {
    method: "POST",
    body: { payload, scenario },
  });
}
