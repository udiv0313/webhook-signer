import { HttpError, parseJsonBody, readBody, sendJson } from "../http/helpers.js";
import { generateId } from "../lib/ids.js";
import { isoTime } from "../lib/time.js";

const MAX_NAME_LENGTH = 100;

function endpointRoutes({ store, now, maxBodyBytes }) {
  function toPublicEndpoint(endpoint) {
    return {
      ...endpoint,
      webhookPath: `/api/webhooks/${endpoint.id}`,
      recentEventCount: store.countEventsForEndpoint(endpoint.id),
    };
  }

  // POST /api/endpoints   body: { "name": "Stripe Payments" }
  async function createEndpoint(req, res) {
    const body = parseJsonBody(await readBody(req, maxBodyBytes));
    const name = typeof body?.name === "string" ? body.name.trim() : "";

    if (name === "" || name.length > MAX_NAME_LENGTH) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        `"name" must be a non-empty string of at most ${MAX_NAME_LENGTH} characters.`,
      );
    }

    const endpoint = { id: generateId("ep"), name, status: "active", createdAt: isoTime(now()) };
    store.insertEndpoint(endpoint);

    sendJson(res, 201, toPublicEndpoint(endpoint));
  }

  // GET /api/endpoints
  async function listEndpoints(req, res) {
    sendJson(res, 200, { endpoints: store.listEndpoints().map(toPublicEndpoint) });
  }

  return [
    { method: "POST", pattern: /^\/api\/endpoints$/, handler: createEndpoint },
    { method: "GET", pattern: /^\/api\/endpoints$/, handler: listEndpoints },
  ];
}

export { endpointRoutes };
