import { createServer } from "./app.js";
import { loadConfig } from "./config.js";

// Entry point: `npm start` (or `node --env-file=.env src/server.js`).
// Reads settings from the environment and starts listening. All request
// handling lives in app.js, which tests import directly.

const { port, ...options } = loadConfig();

createServer(options).listen(port, () => {
  console.log(`Webhook API listening on http://localhost:${port}`);
  console.log(`Timestamp tolerance: ${options.toleranceSeconds} seconds`);
  console.log(`Max body size: ${options.maxBodyBytes} bytes`);
  console.log(`Test sender: ${options.testSenderEnabled ? "enabled (local requests only)" : "disabled"}`);
  console.log("Storage: in memory (all endpoints and events are lost on restart)");
});
