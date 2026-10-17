// In-memory storage for endpoints and events. Everything here is lost when the
// server stops.
//
// Routes only talk to storage through these methods, so another store (for
// example SQLite) can replace this one by providing the same methods.
// Returned objects must be treated as read-only: change stored data only
// through a store method.

// Only the most recent events are kept, so memory cannot grow forever.
const DEFAULT_MAX_EVENTS = 100;

function createMemoryStore({ maxEvents = DEFAULT_MAX_EVENTS } = {}) {
  // Endpoints hold no secret: it is derived from the master secret when needed.
  const endpoints = new Map(); // id → { id, name, status, createdAt }
  const events = []; // oldest first, at most maxEvents

  return {
    insertEndpoint(endpoint) {
      endpoints.set(endpoint.id, endpoint);
    },

    getEndpoint(endpointId) {
      return endpoints.get(endpointId) ?? null;
    },

    // Oldest first.
    listEndpoints() {
      return [...endpoints.values()];
    },

    countEventsForEndpoint(endpointId) {
      return events.filter((event) => event.endpointId === endpointId).length;
    },

    insertEvent(event) {
      events.push(event);

      if (events.length > maxEvents) {
        events.shift();
      }
    },

    // Store the exact response body sent for a webhook, so the inspector can
    // show it. Does nothing if the event was already removed.
    setEventResponseBody(eventId, body) {
      const event = events.find((candidate) => candidate.id === eventId);

      if (event) {
        event.response.body = body;
      }
    },

    getEvent(eventId) {
      return events.find((candidate) => candidate.id === eventId) ?? null;
    },

    // Newest first.
    listEventsForEndpoint(endpointId) {
      return events.filter((event) => event.endpointId === endpointId).reverse();
    },
  };
}

export { createMemoryStore };
