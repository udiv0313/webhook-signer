// Shell commands that sign and send a webhook with only openssl and curl, so
// anyone can try an endpoint from their own terminal without this project.

// Wrap text in single quotes for a shell command, escaping any single quotes inside.
export function shellQuote(text) {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

const PLACEHOLDER_SECRET = "whsec_...";

// The signature is HMAC-SHA256 over "<timestamp>.<body>", with the whole
// endpoint secret (whsec_..., prefix included) as the key. printf '%s' sends
// the body bytes exactly, with no added newline.
//
// Without a known secret the commands contain a placeholder. They are then
// wrapped in ( ... ) with a check, so pasting them unchanged prints what to do
// instead of sending a request that can only fail with 401. (No # comments:
// zsh, the macOS default, does not treat them as comments when pasted.)
export function signAndSendCommands({ url, payload, secret = PLACEHOLDER_SECRET }) {
  const commands = [
    `SECRET=${shellQuote(secret)}`,
    `BODY=${shellQuote(payload)}`,
    `TS=$(date +%s)`,
    `SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')`,
    `curl -i -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "X-Webhook-Timestamp: $TS" \\\n  -H "X-Webhook-Signature: sha256=$SIG" \\\n  --data-binary "$BODY"`,
  ];

  if (secret !== PLACEHOLDER_SECRET) {
    return commands.join("\n");
  }

  const guard = `[ "$SECRET" != '${PLACEHOLDER_SECRET}' ] || { echo "First replace ${PLACEHOLDER_SECRET} with this endpoint's signing secret." >&2; exit 1; }`;

  return ["(", commands[0], guard, ...commands.slice(1), ")"].join("\n");
}
