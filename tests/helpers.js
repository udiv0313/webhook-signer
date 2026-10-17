import { createServer } from "../src/app.js";
import { signPayload } from "../src/core/signature.js";

// Shared setup for the HTTP tests. Not a test file itself (no .test.js suffix).

export const MASTER_SECRET = "test-master-secret";
export const TOLERANCE = 300;
export const MAX_BODY_BYTES = 1024;

// A fixed "current time", so no test depends on the real clock.
// 1_700_000_000 is 2023-11-14T22:13:20.000Z.
export const NOW = 1_700_000_000;

// Start a real server on a free port, with an in-memory database unless the
// test passes databasePath. Its clock reads `clock.now`, which a test can
// change to simulate time passing.
//
// The returned app has its own browser-like client: app.fetch(path) keeps the
// workspace cookie between requests, so one test's calls share a workspace.
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

  const baseUrl = `http://localhost:${server.address().port}`;
  const client = createClient(baseUrl);

  return {
    baseUrl,
    clock,
    fetch: client.fetch,
    get cookie() {
      return client.cookie;
    },
    // Resolves once the server and its database are closed.
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// A browser-like client: remembers the workspace cookie the server sets and
// sends it back on every later request. Each client is its own workspace.
// Pass `cookie` to start with an existing one.
export function createClient(baseUrl, { cookie = null } = {}) {
  const client = {
    cookie,

    async fetch(path, options = {}) {
      const headers = { ...options.headers };

      if (client.cookie !== null) {
        headers.Cookie = client.cookie;
      }

      const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
      const workspaceCookie = res.headers.getSetCookie().find((value) => value.startsWith("ws="));

      if (workspaceCookie) {
        client.cookie = workspaceCookie.split(";")[0]; // "ws=<token>"
      }

      return res;
    },
  };

  return client;
}

// Creates an endpoint in the client's workspace (an app from startServer, or a
// client from createClient). The result includes its one-time `secret`.
export async function createEndpoint(client, name = "Test Endpoint") {
  const res = await client.fetch("/api/endpoints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  return res.json();
}

// Headers a correct sender would send for `body`, signed with the endpoint's
// secret (as returned by createEndpoint) unless another one is given.
export function signedHeaders(endpoint, body, { timestamp = NOW, secret = endpoint.secret } = {}) {
  return {
    "X-Webhook-Timestamp": String(timestamp),
    "X-Webhook-Signature": signPayload(secret, timestamp, body),
  };
}

// Webhooks are sent without any cookie, like a real external sender.
export function postWebhook(baseUrl, endpointId, body, headers = {}) {
  return fetch(`${baseUrl}/api/webhooks/${endpointId}`, { method: "POST", body, headers });
}
