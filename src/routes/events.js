import { HttpError, sendJson } from "../http/helpers.js";
import { EVENT_ID_PATTERN } from "../lib/ids.js";
import { toEventSummary } from "../events/recording.js";
import { findEndpoint } from "./lookups.js";

function eventRoutes({ store }) {
  // GET /api/endpoints/:endpointId/events   (newest first, summaries only)
  async function listEndpointEvents(req, res, [endpointId]) {
    const endpoint = findEndpoint(store, endpointId);

    sendJson(res, 200, { events: store.listEventsForEndpoint(endpoint.id).map(toEventSummary) });
  }

  // GET /api/events/:eventId   (full details)
  async function getEvent(req, res, [eventId]) {
    if (!EVENT_ID_PATTERN.test(eventId)) {
      throw new HttpError(400, "INVALID_EVENT_ID", "Event IDs look like evt_ followed by 16 hex characters.");
    }

    const event = store.getEvent(eventId);

    if (!event) {
      throw new HttpError(404, "EVENT_NOT_FOUND", "Webhook event was not found.");
    }

    sendJson(res, 200, event);
  }

  return [
    { method: "GET", pattern: /^\/api\/endpoints\/([^/]+)\/events$/, handler: listEndpointEvents },
    { method: "GET", pattern: /^\/api\/events\/([^/]+)$/, handler: getEvent },
  ];
}

export { eventRoutes };
