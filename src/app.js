import http from "node:http";
import { HttpError, sendError } from "./http/helpers.js";
import { currentUnixSeconds } from "./lib/time.js";
import { createMemoryStore } from "./store/memory-store.js";
import { endpointRoutes } from "./routes/endpoints.js";
import { eventRoutes } from "./routes/events.js";
import { testSenderRoutes } from "./routes/test-sender.js";
import { webhookRoutes } from "./routes/webhooks.js";

// Options:
//   masterSecret      WEBHOOK_SECRET; each endpoint's secret is derived from it
//   toleranceSeconds  how far a webhook timestamp may be from the server's clock
//   maxBodyBytes      largest request body accepted; bigger bodies get 413
//   now               function returning the current Unix time in seconds.
//                     Tests pass a fixed clock so results never depend on the real time.
//   testSenderEnabled allow POST /api/endpoints/:id/test-webhooks (off by default)
//   store             where endpoints and events are kept (in memory by default)
function createServer({
  masterSecret,
  toleranceSeconds,
  maxBodyBytes,
  now = currentUnixSeconds,
  testSenderEnabled = false,
  store = createMemoryStore(),
}) {
  if (!masterSecret) {
    throw new Error("masterSecret is required");
  }

  // Without valid limits, timestamp or size checks would silently pass.
  if (!Number.isInteger(toleranceSeconds) || toleranceSeconds <= 0) {
    throw new Error("toleranceSeconds must be a positive whole number");
  }

  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("maxBodyBytes must be a positive whole number");
  }

  // Everything a route needs, passed in rather than read from globals.
  const context = { store, now, masterSecret, toleranceSeconds, maxBodyBytes, testSenderEnabled };

  // Each route is a method plus a path pattern. Parts in ( ) become params.
  const routes = [
    ...endpointRoutes(context),
    ...eventRoutes(context),
    ...testSenderRoutes(context),
    ...webhookRoutes(context),
  ];

  async function handleRequest(req, res) {
    const path = new URL(req.url, "http://localhost").pathname;
    const pathMatches = routes.filter((route) => route.pattern.test(path));

    if (pathMatches.length === 0) {
      throw new HttpError(404, "ROUTE_NOT_FOUND", "No API route matches this path.");
    }

    const route = pathMatches.find((candidate) => candidate.method === req.method);

    // The path exists, but not for this HTTP method.
    if (!route) {
      const allowed = pathMatches.map((candidate) => candidate.method).join(", ");

      sendError(res, 405, "METHOD_NOT_ALLOWED", `Use ${allowed} for this path.`, { headers: { Allow: allowed } });
      return;
    }

    const params = route.pattern.exec(path).slice(1);

    await route.handler(req, res, params);
  }

  return http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        // After a 413 we stop reading, so close the connection instead of reusing it.
        const headers = error.status === 413 ? { Connection: "close" } : {};

        sendError(res, error.status, error.code, error.message, { headers });
        return;
      }

      // Unexpected bug: full details go to the server console only, never to the client.
      console.error("Unexpected error:", error);

      if (res.headersSent) {
        res.destroy();
        return;
      }

      sendError(res, 500, "INTERNAL_ERROR", "Something went wrong on the server.");
    }
  });
}

export { createServer };
