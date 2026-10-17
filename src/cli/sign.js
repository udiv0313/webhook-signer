import { parseArgs } from "node:util";
import { deriveEndpointSecret, parseTimestamp, signPayload } from "../core/signature.js";

// Signing CLI: prints the headers needed to send a signed webhook to one endpoint.
//
// Usage:
//   node --env-file=.env src/cli/sign.js --endpoint=ep_3f9a1c0b7d2e4a68 '<payload>'
//   node --env-file=.env src/cli/sign.js --endpoint=ep_3f9a1c0b7d2e4a68 --timestamp=1712345678 '<payload>'
//
// Output (two header lines, e.g. for curl -H @file):
//   X-Webhook-Timestamp: 1712345678
//   X-Webhook-Signature: sha256=<64 hex characters>

const USAGE = `Usage: node --env-file=.env src/cli/sign.js --endpoint=<endpoint id> [--timestamp=<unix seconds>] '<payload>'

Examples:
  node --env-file=.env src/cli/sign.js --endpoint=ep_3f9a1c0b7d2e4a68 '{"event":"payment.success","amount":4999}'
  node --env-file=.env src/cli/sign.js --endpoint=ep_3f9a1c0b7d2e4a68 --timestamp=1712345678 '{"event":"payment.success"}'`;

// Errors go to stderr so stdout only ever contains the header lines.
function fail(message) {
  console.error(`Error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

const masterSecret = process.env.WEBHOOK_SECRET;

if (!masterSecret) {
  fail("WEBHOOK_SECRET is not set. Copy .env.example to .env and set a value.");
}

// parseArgs is Node's built-in argument parser. It reads process.argv and
// separates the options from the payload ("positionals").
let parsed;

try {
  parsed = parseArgs({
    options: { endpoint: { type: "string" }, timestamp: { type: "string" } },
    allowPositionals: true,
  });
} catch (error) {
  fail(error.message);
}

const { values, positionals } = parsed;

// Each endpoint has its own secret, so the CLI must know which endpoint to sign for.
if (!values.endpoint) {
  fail("--endpoint is required. Create one with POST /api/endpoints and use its id.");
}

if (positionals.length === 0) {
  fail("No payload given.");
}

// Without quotes the shell splits a payload on spaces into several arguments.
// Signing only the first piece would silently produce the wrong signature.
if (positionals.length > 1) {
  fail(`Expected 1 payload argument but got ${positionals.length}. Wrap the whole payload in single quotes.`);
}

// Default to the current time. --timestamp lets you sign with a specific time,
// for example an old one to see how the server rejects expired webhooks.
let timestamp = Math.floor(Date.now() / 1000);

if (values.timestamp !== undefined) {
  timestamp = parseTimestamp(values.timestamp);

  if (timestamp === null) {
    fail(`--timestamp must be Unix time in whole seconds, e.g. 1712345678 (got "${values.timestamp}").`);
  }
}

// Sign the payload exactly as given: no JSON parsing, no trimming, no added newline.
// The server must receive these same bytes, so send them with curl --data-binary.
const payload = positionals[0];
const endpointSecret = deriveEndpointSecret(masterSecret, values.endpoint);

console.log(`X-Webhook-Timestamp: ${timestamp}`);
console.log(`X-Webhook-Signature: ${signPayload(endpointSecret, timestamp, payload)}`);
