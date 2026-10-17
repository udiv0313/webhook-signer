import { parseArgs } from "node:util";
import { isEndpointSecret } from "../core/secrets.js";
import { parseTimestamp, signPayload } from "../core/signature.js";

// Signing CLI: prints the headers needed to send a signed webhook.
//
// It signs with one endpoint's secret (whsec_...), which the API shows once,
// when the endpoint is created or its secret is rotated. The secret is read
// from an environment variable, not an argument, so it does not end up in
// your shell history or in the process list.
//
// Usage:
//   export WEBHOOK_ENDPOINT_SECRET='whsec_...'
//   node src/cli/sign.js '<payload>'
//   node src/cli/sign.js --timestamp=1712345678 '<payload>'
//
// Output (two header lines, e.g. for curl -H @file):
//   X-Webhook-Timestamp: 1712345678
//   X-Webhook-Signature: sha256=<64 hex characters>

const USAGE = `Usage: WEBHOOK_ENDPOINT_SECRET='whsec_...' node src/cli/sign.js [--timestamp=<unix seconds>] '<payload>'

Examples:
  export WEBHOOK_ENDPOINT_SECRET='whsec_...'   # shown when the endpoint was created
  node src/cli/sign.js '{"event":"payment.success","amount":4999}'
  node src/cli/sign.js --timestamp=1712345678 '{"event":"payment.success"}'`;

// Errors go to stderr so stdout only ever contains the header lines.
function fail(message) {
  console.error(`Error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

// The old interface derived secrets from the master secret and --endpoint.
// Say what changed instead of a generic "unknown option".
if (process.argv.slice(2).some((arg) => arg === "--endpoint" || arg.startsWith("--endpoint="))) {
  fail("--endpoint is no longer used. Each endpoint has its own secret: set WEBHOOK_ENDPOINT_SECRET to it.");
}

const secret = process.env.WEBHOOK_ENDPOINT_SECRET;

if (!secret) {
  fail("WEBHOOK_ENDPOINT_SECRET is not set. Use the secret shown when you created the endpoint (or rotate it to get a new one).");
}

if (!isEndpointSecret(secret)) {
  fail("WEBHOOK_ENDPOINT_SECRET does not look like an endpoint secret (whsec_ followed by 43 characters).");
}

// parseArgs is Node's built-in argument parser. It reads process.argv and
// separates the options from the payload ("positionals").
let parsed;

try {
  parsed = parseArgs({
    options: { timestamp: { type: "string" } },
    allowPositionals: true,
  });
} catch (error) {
  fail(error.message);
}

const { values, positionals } = parsed;

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

console.log(`X-Webhook-Timestamp: ${timestamp}`);
console.log(`X-Webhook-Signature: ${signPayload(secret, timestamp, payload)}`);
