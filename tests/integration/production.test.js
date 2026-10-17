import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEndpoint, startServer } from "../helpers.js";

// Production behavior: /health, security headers, and serving the built
// frontend from the same origin. Uses a small fake build, not the real one,
// so these tests do not depend on running `npm run build` first.

const INDEX_HTML = '<!doctype html><title>Webhook Signer</title><script type="module" src="/assets/app-3f9a.js"></script>';
const APP_JS = 'console.log("app");';

function fakeBuild(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-signer-dist-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), INDEX_HTML);
  fs.writeFileSync(path.join(dir, "assets", "app-3f9a.js"), APP_JS);
  fs.writeFileSync(path.join(dir, "favicon.svg"), "<svg/>");

  return dir;
}

// --- /health ------------------------------------------------------------------

test("GET /health → 200 with the database check", async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  const res = await fetch(`${app.baseUrl}/health`);
  const json = await res.json();

  assert.equal(res.status, 200);
  assert.equal(json.status, "ok");
  assert.deepEqual(json.checks, { database: "ok" });
  assert.equal(typeof json.uptimeSeconds, "number");
});

test("GET /health is not rate limited (platform health checks must always get through)", async (t) => {
  const app = await startServer({ rateLimits: { api: { limit: 1, windowSeconds: 60 } } });
  t.after(() => app.close());

  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${app.baseUrl}/health`);
    assert.equal(res.status, 200);
    await res.json();
  }
});

// --- Security headers -----------------------------------------------------------

test("API responses carry security headers; HSTS only when served over HTTPS", async (t) => {
  const plain = await startServer();
  const https = await startServer({ cookieSecure: true });
  t.after(() => Promise.all([plain.close(), https.close()]));

  const res = await fetch(`${plain.baseUrl}/api/endpoints`);
  await res.json();

  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(res.headers.get("strict-transport-security"), null);

  const secure = await fetch(`${https.baseUrl}/api/endpoints`);
  await secure.json();
  assert.match(secure.headers.get("strict-transport-security"), /^max-age=\d+$/);
});

// --- Serving the built frontend -------------------------------------------------

test("serves index.html at / with a strict CSP and no caching", async (t) => {
  const app = await startServer({ staticDir: fakeBuild(t) });
  t.after(() => app.close());

  const res = await fetch(`${app.baseUrl}/`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(await res.text(), INDEX_HTML);
});

test("hashed assets are cached for a year; other files are revalidated", async (t) => {
  const app = await startServer({ staticDir: fakeBuild(t) });
  t.after(() => app.close());

  const js = await fetch(`${app.baseUrl}/assets/app-3f9a.js`);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await js.text(), APP_JS);

  const icon = await fetch(`${app.baseUrl}/favicon.svg`);
  assert.equal(icon.headers.get("content-type"), "image/svg+xml");
  assert.equal(icon.headers.get("cache-control"), "no-cache");
  await icon.text();
});

test("page URLs without a file extension get index.html; missing files get 404", async (t) => {
  const app = await startServer({ staticDir: fakeBuild(t) });
  t.after(() => app.close());

  const page = await fetch(`${app.baseUrl}/endpoints/ep_0123456789abcdef`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), INDEX_HTML);

  const missing = await fetch(`${app.baseUrl}/assets/old-build.js`);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Not found");
});

test("path traversal cannot read files outside the build", async (t) => {
  const app = await startServer({ staticDir: fakeBuild(t) });
  t.after(() => app.close());

  for (const attempt of ["/../package.json", "/%2e%2e/package.json", "/assets/..%2F..%2Fpackage.json", "/..%5c..%5cpackage.json"]) {
    const res = await fetch(`${app.baseUrl}${attempt}`);
    const text = await res.text();

    assert.ok(!text.includes('"name": "webhook-signer"'), attempt);
    assert.ok(res.status === 404 || text === INDEX_HTML, attempt);
  }
});

test("HEAD gets headers without a body", async (t) => {
  const app = await startServer({ staticDir: fakeBuild(t) });
  t.after(() => app.close());

  const res = await fetch(`${app.baseUrl}/`, { method: "HEAD" });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(INDEX_HTML)));
  assert.equal(await res.text(), "");
});

test("/api and /health are never answered with the web app", async (t) => {
  const app = await startServer({ staticDir: fakeBuild(t) });
  t.after(() => app.close());

  const api = await fetch(`${app.baseUrl}/api/nope`);
  assert.equal(api.status, 404);
  assert.equal((await api.json()).error.code, "ROUTE_NOT_FOUND");

  const health = await fetch(`${app.baseUrl}/health`);
  assert.equal((await health.json()).status, "ok");

  // Non-GET requests outside /api are not pages either.
  const post = await fetch(`${app.baseUrl}/`, { method: "POST" });
  assert.equal(post.status, 404);
  assert.equal((await post.json()).error.code, "ROUTE_NOT_FOUND");
});

test("without a build, only the API is served", async (t) => {
  const app = await startServer({ staticDir: path.join(os.tmpdir(), "does-not-exist-webhook-signer") });
  t.after(() => app.close());

  const res = await fetch(`${app.baseUrl}/`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "ROUTE_NOT_FOUND");
});

// --- Test sender: replay scenario ----------------------------------------------

test('test sender scenario "replay" sends the same signed request twice → 409 REPLAY_DETECTED', async (t) => {
  const app = await startServer({ testSenderEnabled: true });
  t.after(() => app.close());

  const endpoint = await createEndpoint(app);
  const res = await app.fetch(`/api/endpoints/${endpoint.id}/test-webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: '{"event":"payment.success"}', scenario: "replay" }),
  });
  const result = await res.json();

  assert.equal(res.status, 200);
  assert.equal(result.response.status, 409);
  assert.equal(result.response.body.error.code, "REPLAY_DETECTED");

  // Both deliveries are recorded: the accepted original and the refused copy.
  const { events } = await (await app.fetch(`/api/endpoints/${endpoint.id}/events`)).json();
  assert.deepEqual(
    events.map((event) => event.verification.code),
    ["REPLAY_DETECTED", "VALID"],
  );
});
