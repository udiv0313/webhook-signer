import { HttpError, sendJson } from "../http/helpers.js";
import { EVENT_ID_PATTERN } from "../lib/ids.js";
import { toEventSummary } from "../events/recording.js";
import { findOwnedEndpoint } from "./lookups.js";

/**
 * Event routes: an endpoint's recent event summaries and one event's full
 * details. Both return 404 for anything outside the caller's workspace.
 */

/** Returns the event routes as { method, pattern, handler } entries. */
function eventRoutes({ store, sessions }) {
  // GET /api/endpoints/:endpointId/events   (newest first, summaries only)
  async function listEndpointEvents(req, res, [endpointId]) {
    const endpoint = findOwnedEndpoint(store, sessions.find(req), endpointId);

    sendJson(res, 200, { events: store.listEventsForEndpoint(endpoint.id).map(toEventSummary) });
  }

  // GET /api/events/:eventId   (full details)
  async function getEvent(req, res, [eventId]) {
    if (!EVENT_ID_PATTERN.test(eventId)) {
      throw new HttpError(400, "INVALID_EVENT_ID", "Event IDs look like evt_ followed by 16 hex characters.");
    }

    // Another workspace's event gives the same 404 as one that does not exist.
    const workspace = sessions.find(req);
    const event = workspace === null ? null : store.getWorkspaceEvent(workspace.id, eventId);

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
