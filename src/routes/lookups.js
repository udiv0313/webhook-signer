import { HttpError } from "../http/helpers.js";
import { ENDPOINT_ID_PATTERN } from "../lib/ids.js";

/**
 * Endpoint lookups shared by the routes. IDs are format-checked (400) before
 * any query, and missing or foreign endpoints both give the same 404.
 */

function checkEndpointIdFormat(endpointId) {
  if (!ENDPOINT_ID_PATTERN.test(endpointId)) {
    throw new HttpError(400, "INVALID_ENDPOINT_ID", "Endpoint IDs look like ep_ followed by 16 hex characters.");
  }
}

function endpointNotFound() {
  return new HttpError(404, "ENDPOINT_NOT_FOUND", "Webhook endpoint was not found.");
}

// Any workspace's endpoint. Only for receiving webhooks: senders have no
// workspace, and the endpoint ID in the URL is the address.
function findEndpoint(store, endpointId) {
  checkEndpointIdFormat(endpointId);

  const endpoint = store.getEndpoint(endpointId);

  if (!endpoint) {
    throw endpointNotFound();
  }

  return endpoint;
}

// An endpoint that belongs to the caller's workspace. Another workspace's
// endpoint gives the same 404 as one that does not exist, so IDs cannot be
// probed. workspace is null when the request has no valid workspace cookie.
function findOwnedEndpoint(store, workspace, endpointId) {
  checkEndpointIdFormat(endpointId);

  const endpoint = workspace === null ? null : store.getWorkspaceEndpoint(workspace.id, endpointId);

  if (!endpoint) {
    throw endpointNotFound();
  }

  return endpoint;
}

export { findEndpoint, findOwnedEndpoint };
