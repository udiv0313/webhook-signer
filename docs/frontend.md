# Frontend

A small React app (Vite, plain JavaScript) for answering one question:
**what happened to this webhook?**

No router, no state library, no UI kit. React's own `useState` and `useEffect`
are enough for three pages.

## Architecture

```
frontend/src/
├── main.jsx                 mounts <App />
├── App.jsx                  which page is shown (plain React state)
├── config.js                public display config (VITE_WEBHOOK_BASE_URL)
├── terminal.js              openssl + curl commands that sign a webhook
├── diagnostics.js           verification code → checklist + "what happened / how to fix"
├── services/api.js          the ONLY file that calls fetch()
├── pages/
│   ├── DashboardPage.jsx    "Try it in 60 seconds" + endpoint table
│   ├── CreateEndpointPage.jsx
│   └── EndpointPage.jsx     details + tester + event list + inspector
└── components/
    ├── TryItPanel.jsx       one-click guided demo (creates an endpoint)
    ├── DemoGuide.jsx        the demo's steps: valid, tampered, inspect, replay
    ├── SecretReveal.jsx     a secret shown once, with Copy
    ├── WebhookTester.jsx    payload + scenario → POST test-webhooks
    ├── EventList.jsx        clickable event rows
    ├── RequestInspector.jsx request → verification → response
    ├── VerificationChecklist.jsx
    ├── StatusBadge.jsx      HTTP status / verdict / endpoint status badges
    ├── JsonBlock.jsx        readable, scrollable, size-capped JSON
    ├── ErrorMessage.jsx     one way to show every error
    └── CopyButton.jsx
```

Data flows one way: pages load data through `services/api.js`, keep it in
`useState`, and pass it down to components as props.

## How the browser talks to the backend

```
Browser ──► http://localhost:5173/api/...   (Vite dev server, same origin as the page)
                  │  proxy (vite.config.js)
                  ▼
            http://localhost:3000/api/...   (Node backend)
```

The page and the API calls share one origin (`localhost:5173`), so the browser
never makes a cross-origin request and **the backend needs no CORS headers**.
Vite forwards `/api/*` to the backend on the server side.

Why not call `http://localhost:3000` directly? A different port is a different
origin. The browser would block reading the responses unless the backend sent
`Access-Control-Allow-Origin`, and adding CORS to an unauthenticated API would
let that origin read webhook bodies. The proxy avoids the whole question during
development; in production you would serve the built frontend from the same
origin as the API.

## The API service layer

`services/api.js` exports one function per backend call:

| Function | Request | Returns |
| --- | --- | --- |
| `getEndpoints()` | `GET /api/endpoints` | array of endpoints |
| `createEndpoint(name)` | `POST /api/endpoints` | the new endpoint |
| `getEndpointEvents(id)` | `GET /api/endpoints/:id/events` | event summaries, newest first |
| `getEvent(id)` | `GET /api/events/:id` | one full event |
| `sendTestWebhook(id, { payload, scenario })` | `POST /api/endpoints/:id/test-webhooks` | `{ scenario, eventId, response }` |

Components never call `fetch()` directly. They call these functions and handle
either a result or an `ApiError`.

## How fetch() is used (and its traps)

All five functions go through one `request()` helper, which handles the things
`fetch()` does **not** do for you:

1. **`fetch()` only rejects on network failure.** A 404 or 500 is a *successful*
   fetch. So the helper wraps `fetch()` in `try/catch` for network errors
   (`NETWORK_ERROR`, status 0) and then checks `response.ok` itself.
2. **The body might not be JSON.** It reads `response.text()` first and then
   `JSON.parse`s it, so an HTML error page or empty body cannot crash the app
   (`MALFORMED_RESPONSE`).
3. **Error bodies have a known shape.** For non-2xx responses it uses the API's
   `{ error: { code, message } }`. If there is none (for example the Vite proxy
   returns an empty `502` when the backend is down), it explains that instead
   (`HTTP_ERROR`).
4. **Request bodies** are sent with `Content-Type: application/json` and
   `JSON.stringify`.

Every failure becomes `ApiError { status, code, message }`, so the UI has one
error shape to display.

## Error, loading, and empty states

- **Loading:** each page shows "Loading…" (with `role="status"`) and disables
  its Refresh button while a request is in flight.
- **Errors:** `ErrorMessage` shows what failed, the HTTP status and error code,
  a hint for common causes (backend down, endpoint gone after a restart, test
  sender disabled), and a Try again button where retrying makes sense.
- **Empty:** no endpoints, no events, and no selected event each have their own
  message telling you what to do next.
- **Stale responses:** every `useEffect` that fetches uses an `ignore` flag, so a
  slow response for an old selection never overwrites a newer one.

Status is never shown by color alone: every badge has an icon (✓ ✕ – !) and
text ("HTTP 401 Unauthorized", "Rejected", "Not checked").

## The webhook tester

The tester does not use the endpoint's secret (the page does not keep it). It
sends the **payload text and a scenario** to the backend, which signs with the
secret it stores:

```
POST /api/endpoints/:id/test-webhooks
{ "payload": "<exact text from the textarea>", "scenario": "expired_timestamp" }
```

The backend signs it (breaking it on purpose for failure scenarios), delivers it
to its own real webhook route, and reports what that route answered. The page
then reloads the event list and opens the new event in the inspector.

Note the two levels of result: the tester call itself returns `200` ("the test
was sent"), and the webhook's own status (200, 401, 400…) is inside
`response.status`. A `403` or `404` from the tester means the test was **not**
sent.

The tester also shows the equivalent terminal commands (CLI + curl). You paste
the endpoint's secret into `WEBHOOK_ENDPOINT_SECRET` yourself.

## Live updates

The endpoint page checks for new events every 4 seconds, but only while the tab
is visible (switching back to the tab checks at once). Webhooks sent from a
terminal or another service appear without clicking Refresh. If a check fails,
the header shows "Live updates paused" instead of "Live", and the next
successful check resumes it. The list is only re-rendered when something
changed.

## Try it in 60 seconds

The dashboard's first card creates an endpoint and opens it with a guide. Each
step calls the real test sender, so every result is a real webhook through the
real verification: valid (200), tampered body (401), open the rejected event in
the inspector, replay (409). The guide also shows the endpoint's secret (it was
just created) and an `openssl` + `curl` command with that secret filled in,
so a visitor can send a signed webhook from their own terminal.

## The signing secret: shown once

The API returns an endpoint's secret only when it is created or rotated:

- **Create endpoint** shows the secret with a Copy button. Leaving the page is
  disabled until "I have saved the signing secret" is ticked, because the secret
  cannot be shown again.
- **Rotate secret** (endpoint page) asks for confirmation (the old secret stops
  working at once), then shows the new secret until you hide it.

The secret is held only in React state while it is on screen.

## Why secrets stay on the backend

Everything sent to a browser can be read by whoever uses it: the JavaScript
bundle, network responses, storage, and the URL. So:

- No secret is in the frontend source, the bundle, `localStorage`,
  `sessionStorage`, URLs, or logs. The frontend has no `console.log` calls.
  A newly created or rotated endpoint secret is displayed once and then
  dropped from memory.
- `VITE_*` variables are compiled into the JavaScript and are **public**. The
  only one used is `VITE_WEBHOOK_BASE_URL`, a URL for display.
- `API_PROXY_TARGET` has no `VITE_` prefix, so Vite uses it in
  `vite.config.js` only and never sends it to the browser.
- Signing happens on the backend (test sender) or in your terminal (CLI).
- The API returns an endpoint secret only on creation or rotation, and stored
  events keep only a truncated signature.

## Configuration

Copy `frontend/.env.example` to `frontend/.env` only if you need to change the
defaults:

| Variable | Default | Visible to the browser? | Purpose |
| --- | --- | --- | --- |
| `VITE_WEBHOOK_BASE_URL` | dev: `http://localhost:3000`; build: the page's own origin | **yes** (public) | Shown as the webhook URL |
| `API_PROXY_TARGET` | `http://localhost:3000` | no | Where Vite forwards `/api` |
