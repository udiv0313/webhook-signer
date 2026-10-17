import { sendJson } from "../http/helpers.js";

// GET /health, for the hosting platform's health checks and uptime monitors.
// 200 when the server can reach its database, 503 when it cannot, so the
// platform can restart it. Not rate limited, and reveals nothing sensitive.
function healthRoutes({ store }) {
  const startedAt = Date.now();

  async function health(req, res) {
    let database = "ok";

    try {
      store.ping();
    } catch (error) {
      console.error("Health check: database unavailable:", error);
      database = "unavailable";
    }

    const healthy = database === "ok";

    sendJson(res, healthy ? 200 : 503, {
      status: healthy ? "ok" : "error",
      checks: { database },
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  }

  return [{ method: "GET", pattern: /^\/health$/, handler: health }];
}

export { healthRoutes };
