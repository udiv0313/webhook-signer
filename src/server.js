import { createServer } from "./app.js";
import { loadConfig } from "./config.js";

// Entry point: `npm start` (or `node --env-file=.env src/server.js`).
// Reads settings from the environment and starts listening. All request
// handling lives in app.js, which tests import directly.

const SHUTDOWN_TIMEOUT_MS = 10_000;

const { port, ...options } = loadConfig();
const server = createServer(options);

server.listen(port, () => {
  console.log(`Webhook API listening on http://localhost:${port}`);
  console.log(`Timestamp tolerance: ${options.toleranceSeconds} seconds`);
  console.log(`Max body size: ${options.maxBodyBytes} bytes`);
  console.log(`Test sender: ${options.testSenderEnabled ? "enabled (own endpoints only, rate limited)" : "disabled"}`);
  console.log(`Storage: SQLite at ${options.databasePath}`);
  console.log(`Workspaces expire after ${options.workspaceTtlSeconds / 3600} hours; ${options.maxEventsPerEndpoint} events kept per endpoint`);
  console.log(`Workspace cookie: ${options.cookieSecure ? "Secure (HTTPS only)" : "not Secure (fine for local http)"}`);
  console.log(
    options.trustProxy > 0
      ? `Client IP: from X-Forwarded-For (behind ${options.trustProxy} ${options.trustProxy === 1 ? "proxy" : "proxies"})`
      : "Client IP: from the connection",
  );
  console.log(
    server.staticFileCount > 0
      ? `Web app: serving ${options.staticDir} (${server.staticFileCount} files)`
      : `Web app: not served (no ${options.staticDir}/index.html; run "npm run build", or use the Vite dev server)`,
  );
});

// Hosting platforms send SIGTERM before stopping or redeploying. Stop taking
// new connections, let requests in progress finish, close the database
// (server "close" event), then exit. Give up after a timeout.
function shutDown(signal) {
  console.log(`${signal} received: shutting down`);

  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
}

process.once("SIGTERM", () => shutDown("SIGTERM"));
process.once("SIGINT", () => shutDown("SIGINT"));
