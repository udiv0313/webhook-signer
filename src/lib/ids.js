import crypto from "node:crypto";

// IDs are a prefix plus 16 random hex characters, e.g. ep_3f9a1c0b7d2e4a68.
// Incoming IDs must match this shape before we use them for anything.
const ENDPOINT_ID_PATTERN = /^ep_[0-9a-f]{16}$/;
const EVENT_ID_PATTERN = /^evt_[0-9a-f]{16}$/;

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export { ENDPOINT_ID_PATTERN, EVENT_ID_PATTERN, generateId };
