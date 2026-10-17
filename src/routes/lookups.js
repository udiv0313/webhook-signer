import { HttpError } from "../http/helpers.js";
import { ENDPOINT_ID_PATTERN } from "../lib/ids.js";

// Shared by every route that takes an endpoint ID from the URL.
function findEndpoint(store, endpointId) {
  if (!ENDPOINT_ID_PATTERN.test(endpointId)) {
    throw new HttpError(400, "INVALID_ENDPOINT_ID", "Endpoint IDs look like ep_ followed by 16 hex characters.");
  }

  const endpoint = store.getEndpoint(endpointId);

  if (!endpoint) {
    throw new HttpError(404, "ENDPOINT_NOT_FOUND", "Webhook endpoint was not found.");
  }

  return endpoint;
}

export { findEndpoint };
