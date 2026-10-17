import crypto from "node:crypto";
import http from "node:http";
import { HttpError, sendError } from "./http/helpers.js";
import { clientIp, createRateLimiter } from "./http/rate-limit.js";
import { setSecurityHeaders } from "./http/security-headers.js";
import { loadStaticSite } from "./http/static.js";
import { createSecretBox, generateEndpointSecret } from "./core/secrets.js";
import { safeEqual } from "./core/signature.js";
import { currentUnixSeconds } from "./lib/time.js";
import { createSqliteStore } from "./store/sqlite-store.js";
import { createWorkspaceSessions } from "./workspaces.js";
import { endpointRoutes } from "./routes/endpoints.js";
import { eventRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { testSenderRoutes } from "./routes/test-sender.js";
import { webhookRoutes } from "./routes/webhooks.js";

/**
 * Application factory: builds the HTTP server with its storage, rate limiter,
 * workspace sessions and routes, and returns it without listening. The entry
 * point (server.js) and the tests both start servers through createServer().
 */

const DEFAULT_WORKSPACE_TTL_SECONDS = 72 * 60 * 60;
const DEFAULT_MAX_EVENTS_PER_ENDPOINT = 50;
const DEFAULT_MAX_ENDPOINTS_PER_WORKSPACE = 20;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const RATE_LIMIT_PRUNE_INTERVAL_MS = 60 * 1000;

// How many requests each bucket allows per window, and what it is counted by.
const DEFAULT_RATE_LIMITS = {
  api: { limit: 300, windowSeconds: 60 }, //               per client IP, every /api request
  createEndpoint: { limit: 10, windowSeconds: 60 * 60 }, // per client IP
  rotateSecret: { limit: 10, windowSeconds: 60 * 60 }, //   per workspace
  testWebhook: { limit: 30, windowSeconds: 60 }, //         per workspace
  receiveWebhook: { limit: 120, windowSeconds: 60 }, //     per endpoint
};

// Header the test sender adds to its own deliveries (see internalDelivery).
const INTERNAL_DELIVERY_HEADER = "x-webhook-signer-internal";

function requirePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number`);
  }
}

// Options:
//   masterSecret             WEBHOOK_SECRET; encrypts endpoint secrets at rest
//   toleranceSeconds         how far a webhook timestamp may be from the server's clock
//   maxBodyBytes             largest request body accepted; bigger bodies get 413
//   now                      function returning the current Unix time in seconds.
//                            Tests pass a fixed clock so results never depend on the real time.
//   testSenderEnabled        allow POST /api/endpoints/:id/test-webhooks (off by default)
//   databasePath             SQLite file; ":memory:" (the default) keeps nothing after close
//   maxEventsPerEndpoint     newest events kept per endpoint; older ones are deleted
//   maxEndpointsPerWorkspace endpoints one workspace may have
//   workspaceTtlSeconds      how long a workspace (and its data) lives after creation
//   cookieSecure             add the Secure flag to the workspace cookie (HTTPS only)
//   trustProxy               take the client IP from X-Forwarded-For (behind one proxy)
//   rateLimits               overrides for DEFAULT_RATE_LIMITS, per bucket
//   staticDir                built frontend to serve (frontend/dist); null serves only the API
//
// Closing the server also stops the timers and closes the database.
function createServer({
  masterSecret,
  toleranceSeconds,
  maxBodyBytes,
  now = currentUnixSeconds,
  testSenderEnabled = false,
  databasePath = ":memory:",
  maxEventsPerEndpoint = DEFAULT_MAX_EVENTS_PER_ENDPOINT,
  maxEndpointsPerWorkspace = DEFAULT_MAX_ENDPOINTS_PER_WORKSPACE,
  workspaceTtlSeconds = DEFAULT_WORKSPACE_TTL_SECONDS,
  cookieSecure = false,
  trustProxy = false,
  rateLimits = {},
  staticDir = null,
}) {
  if (!masterSecret) {
    throw new Error("masterSecret is required");
  }

  // Without valid limits, timestamp or size checks would silently pass.
  requirePositiveInteger("toleranceSeconds", toleranceSeconds);
  requirePositiveInteger("maxBodyBytes", maxBodyBytes);
  requirePositiveInteger("maxEventsPerEndpoint", maxEventsPerEndpoint);
  requirePositiveInteger("maxEndpointsPerWorkspace", maxEndpointsPerWorkspace);
  requirePositiveInteger("workspaceTtlSeconds", workspaceTtlSeconds);

  const limits = { ...DEFAULT_RATE_LIMITS, ...rateLimits };
  const store = createSqliteStore({ path: databasePath, maxEventsPerEndpoint });
  const sessions = createWorkspaceSessions({ store, now, ttlSeconds: workspaceTtlSeconds, cookieSecure });
  const secretBox = createSecretBox(masterSecret);
  const limiter = createRateLimiter({ now });
  const staticSite = staticDir === null ? null : loadStaticSite(staticDir);

  // Random per process. The test sender sends it with its own deliveries, so
  // they are not counted against the per-IP limit: they all come from this
  // server's own address, so all users would otherwise share one budget.
  const internalDelivery = { header: INTERNAL_DELIVERY_HEADER, token: crypto.randomBytes(32).toString("hex") };

  function isInternalDelivery(req) {
    const value = req.headers[INTERNAL_DELIVERY_HEADER];

    return typeof value === "string" && safeEqual(Buffer.from(value), Buffer.from(internalDelivery.token));
  }

  // Count one request in a bucket; throws 429 once the limit is used up.
  function rateLimit(bucket, key) {
    const result = limiter.hit(bucket, key, limits[bucket]);

    if (!result.allowed) {
      throw new HttpError(429, "RATE_LIMITED", `Too many requests. Try again in ${result.retryAfterSeconds} seconds.`, {
        headers: { "Retry-After": String(result.retryAfterSeconds) },
      });
    }
  }

  // The endpoint's signing secret, decrypted.
  function endpointSecret(endpointId) {
    const sealed = store.getSealedSecret(endpointId);

    try {
      return secretBox.open(sealed, endpointId);
    } catch (error) {
      throw new Error(
        `Cannot decrypt the signing secret of ${endpointId}. Was WEBHOOK_SECRET changed? Rotate the endpoint's secret to fix it.`,
        { cause: error },
      );
    }
  }

  // Endpoints created before secrets were random (database migration 2) get a
  // new secret now. Nobody has seen it; rotating shows a fresh one.
  const endpointsWithoutSecret = store.listEndpointIdsWithoutSecret();

  for (const endpointId of endpointsWithoutSecret) {
    store.setSealedSecret(endpointId, secretBox.seal(generateEndpointSecret(), endpointId));
  }

  if (endpointsWithoutSecret.length > 0) {
    console.log(`Gave ${endpointsWithoutSecret.length} older endpoint(s) a signing secret. Rotate it in the UI to see it.`);
  }

  // Expired workspaces are already invisible (lookups check expiry), so this
  // only frees space. A failure here must never take the server down.
  function deleteExpiredWorkspaces() {
    try {
      const deleted = store.deleteExpiredWorkspaces(now());

      if (deleted > 0) {
        console.log(`Deleted ${deleted} expired workspace(s)`);
      }
    } catch (error) {
      console.error("Workspace cleanup failed:", error);
    }
  }

  deleteExpiredWorkspaces();

  // unref(): these timers alone never keep the process running.
  const cleanupTimer = setInterval(deleteExpiredWorkspaces, CLEANUP_INTERVAL_MS).unref();
  // Every minute: forget ended rate-limit windows and replay fingerprints whose
  // timestamps have left the tolerance window.
  const pruneTimer = setInterval(() => {
    limiter.prune();

    try {
      store.deleteExpiredSignatures(now());
    } catch (error) {
      console.error("Replay cache cleanup failed:", error);
    }
  }, RATE_LIMIT_PRUNE_INTERVAL_MS).unref();

  // Everything a route needs, passed in rather than read from globals.
  const context = {
    store,
    sessions,
    secretBox,
    endpointSecret,
    rateLimit,
    clientIp: (req) => clientIp(req, trustProxy),
    internalDelivery,
    now,
    toleranceSeconds,
    maxBodyBytes,
    maxEndpointsPerWorkspace,
    testSenderEnabled,
  };

  // Each route is a method plus a path pattern. Parts in ( ) become params.
  const routes = [
    ...healthRoutes(context),
    ...endpointRoutes(context),
    ...eventRoutes(context),
    ...testSenderRoutes(context),
    ...webhookRoutes(context),
  ];

  async function handleRequest(req, res) {
    const path = new URL(req.url, "http://localhost").pathname;
    const isApi = path === "/api" || path.startsWith("/api/");

    // The web app: every GET outside /api and /health, when it has been built.
    if (!isApi && path !== "/health" && staticSite !== null && (req.method === "GET" || req.method === "HEAD")) {
      staticSite.serve(req, res, path);
      return;
    }

    if (isApi && !isInternalDelivery(req)) {
      rateLimit("api", context.clientIp(req));
    }

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

  const server = http.createServer(async (req, res) => {
    // cookieSecure means the site is served over HTTPS, so HSTS is safe to send.
    setSecurityHeaders(res, { https: cookieSecure });

    try {
      await handleRequest(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        // After a 413 we stop reading, so close the connection instead of reusing it.
        const headers = error.status === 413 ? { ...error.headers, Connection: "close" } : error.headers;

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

  server.staticFileCount = staticSite?.fileCount ?? 0;

  server.on("close", () => {
    clearInterval(cleanupTimer);
    clearInterval(pruneTimer);
    store.close();
  });

  return server;
}

export { DEFAULT_RATE_LIMITS, createServer };
