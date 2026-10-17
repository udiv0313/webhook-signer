import { HttpError, parseJsonBody, readBody, sendJson } from "../http/helpers.js";
import { generateEndpointSecret } from "../core/secrets.js";
import { generateId } from "../lib/ids.js";
import { isoTime } from "../lib/time.js";
import { findOwnedEndpoint } from "./lookups.js";

/**
 * Endpoint management routes: create (returns the signing secret once), list,
 * and rotate the signing secret. All are scoped to the caller's workspace.
 */

const MAX_NAME_LENGTH = 100;

/** Returns the endpoint routes as { method, pattern, handler } entries. */
function endpointRoutes({ store, sessions, secretBox, rateLimit, clientIp, now, maxBodyBytes, maxEndpointsPerWorkspace }) {
  function toPublicEndpoint(endpoint) {
    return {
      ...endpoint,
      webhookPath: `/api/webhooks/${endpoint.id}`,
      recentEventCount: store.countEventsForEndpoint(endpoint.id),
    };
  }

  // A new random secret, stored encrypted. The plain value is only ever
  // returned to the caller, once.
  function issueSecret(endpointId) {
    const secret = generateEndpointSecret();

    return { secret, sealed: secretBox.seal(secret, endpointId) };
  }

  // POST /api/endpoints   body: { "name": "Stripe Payments" }
  async function createEndpoint(req, res) {
    rateLimit("createEndpoint", clientIp(req));

    const body = parseJsonBody(await readBody(req, maxBodyBytes));
    const name = typeof body?.name === "string" ? body.name.trim() : "";

    if (name === "" || name.length > MAX_NAME_LENGTH) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        `"name" must be a non-empty string of at most ${MAX_NAME_LENGTH} characters.`,
      );
    }

    let workspace = sessions.find(req);

    if (workspace !== null && store.countEndpoints(workspace.id) >= maxEndpointsPerWorkspace) {
      throw new HttpError(
        403,
        "ENDPOINT_LIMIT_REACHED",
        `A workspace can have at most ${maxEndpointsPerWorkspace} endpoints.`,
      );
    }

    // The only place a workspace is created, and only after the input is valid,
    // so failed requests and read-only visits never leave empty workspaces behind.
    workspace ??= sessions.create(res);

    const endpoint = { id: generateId("ep"), name, status: "active", createdAt: isoTime(now()) };
    const { secret, sealed } = issueSecret(endpoint.id);

    store.insertEndpoint(workspace.id, endpoint, sealed);

    // The only response that contains the secret (besides rotating it).
    sendJson(res, 201, { ...toPublicEndpoint(endpoint), secret });
  }

  // GET /api/endpoints   (only the caller's workspace; empty without one)
  async function listEndpoints(req, res) {
    const workspace = sessions.find(req);
    const endpoints = workspace === null ? [] : store.listEndpoints(workspace.id);

    sendJson(res, 200, { endpoints: endpoints.map(toPublicEndpoint) });
  }

  // POST /api/endpoints/:endpointId/rotate-secret
  // Replaces the secret. The old one stops working immediately.
  async function rotateSecret(req, res, [endpointId]) {
    const workspace = sessions.find(req);
    const endpoint = findOwnedEndpoint(store, workspace, endpointId);

    rateLimit("rotateSecret", workspace.id);

    const { secret, sealed } = issueSecret(endpoint.id);
    store.setSealedSecret(endpoint.id, sealed);

    sendJson(res, 200, { secret });
  }

  return [
    { method: "POST", pattern: /^\/api\/endpoints$/, handler: createEndpoint },
    { method: "GET", pattern: /^\/api\/endpoints$/, handler: listEndpoints },
    { method: "POST", pattern: /^\/api\/endpoints\/([^/]+)\/rotate-secret$/, handler: rotateSecret },
  ];
}

export { endpointRoutes };
