import { createServer } from "../src/app.js";
import { deriveEndpointSecret, signPayload } from "../src/core/signature.js";

// Shared setup for the HTTP tests. Not a test file itself (no .test.js suffix).

export const MASTER_SECRET = "test-master-secret";
export const TOLERANCE = 300;
export const MAX_BODY_BYTES = 1024;

// A fixed "current time", so no test depends on the real clock.
// 1_700_000_000 is 2023-11-14T22:13:20.000Z.
export const NOW = 1_700_000_000;

// Start a real server on a free port. Its clock reads `clock.now`, which a
// test can change to simulate time passing.
export async function startServer(options = {}) {
  const clock = { now: NOW };

  const server = createServer({
    masterSecret: MASTER_SECRET,
    toleranceSeconds: TOLERANCE,
    maxBodyBytes: MAX_BODY_BYTES,
    now: () => clock.now,
    ...options,
  });

  // Port 0 lets the OS pick any free port, so tests never clash with a running server.
  await new Promise((resolve) => server.listen(0, resolve));

  return { baseUrl: `http://localhost:${server.address().port}`, clock, close: () => server.close() };
}

export async function createEndpoint(baseUrl, name = "Test Endpoint") {
  const res = await fetch(`${baseUrl}/api/endpoints`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  return res.json();
}

// Headers a correct sender would send for `body`, signed for one endpoint.
export function signedHeaders(endpointId, body, { timestamp = NOW, secret = deriveEndpointSecret(MASTER_SECRET, endpointId) } = {}) {
  return {
    "X-Webhook-Timestamp": String(timestamp),
    "X-Webhook-Signature": signPayload(secret, timestamp, body),
  };
}

export function postWebhook(baseUrl, endpointId, body, headers = {}) {
  return fetch(`${baseUrl}/api/webhooks/${endpointId}`, { method: "POST", body, headers });
}
