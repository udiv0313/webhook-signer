// Reads server settings from environment variables. Only the entry point
// (server.js) calls loadConfig(); everything else receives plain values, so
// tests can pass their own settings without touching process.env.

const DEFAULT_PORT = 3000;
const DEFAULT_TOLERANCE_SECONDS = 300;
const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MB

// The value .env.example ships with. Running with it would mean using a secret
// that anyone can read in the repository.
const PLACEHOLDER_SECRET = "your_secret_here";

// Read a positive whole number from the environment, or exit with a clear message.
function readPositiveInteger(name, defaultValue) {
  const text = process.env[name] || String(defaultValue);

  if (!/^[0-9]+$/.test(text) || Number(text) === 0) {
    console.error(`${name} must be a positive whole number (got "${text}").`);
    process.exit(1);
  }

  return Number(text);
}

// Returns the server settings, or exits the process if any of them are invalid.
function loadConfig() {
  const masterSecret = process.env.WEBHOOK_SECRET;

  if (!masterSecret || masterSecret === PLACEHOLDER_SECRET) {
    console.error("WEBHOOK_SECRET is not set. Copy .env.example to .env and set a real value.");
    process.exit(1);
  }

  return {
    masterSecret,
    toleranceSeconds: readPositiveInteger("WEBHOOK_TOLERANCE_SECONDS", DEFAULT_TOLERANCE_SECONDS),
    maxBodyBytes: readPositiveInteger("WEBHOOK_MAX_BODY_SIZE", DEFAULT_MAX_BODY_BYTES),
    port: Number(process.env.PORT || DEFAULT_PORT),
    testSenderEnabled: process.env.WEBHOOK_TEST_SENDER_ENABLED === "true",
  };
}

export { loadConfig };
