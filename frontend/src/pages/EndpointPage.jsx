import { useEffect, useState } from "react";
import { ApiError, getEndpointEvents, getEndpoints, rotateEndpointSecret } from "../services/api.js";
import { webhookUrl } from "../config.js";
import CopyButton from "../components/CopyButton.jsx";
import DemoGuide from "../components/DemoGuide.jsx";
import ErrorMessage from "../components/ErrorMessage.jsx";
import EventList from "../components/EventList.jsx";
import RequestInspector from "../components/RequestInspector.jsx";
import SecretReveal from "../components/SecretReveal.jsx";
import WebhookTester from "../components/WebhookTester.jsx";
import { EndpointStatus } from "../components/StatusBadge.jsx";

// How often the event list checks for new webhooks while the tab is visible.
const POLL_INTERVAL_MS = 4000;

// Same events, same results? Avoids re-rendering the list on every poll.
function sameEvents(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// One endpoint: its details, a test sender, its recent events, and the
// inspector for the selected event, all on one screen. `demo` (with the new
// endpoint's secret) is set when the page was opened from the guided demo.
export default function EndpointPage({ endpointId, demo, onBack }) {
  const [endpoint, setEndpoint] = useState(null);
  const [endpointError, setEndpointError] = useState(null);

  const [events, setEvents] = useState(null);
  const [eventsError, setEventsError] = useState(null);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsReloadKey, setEventsReloadKey] = useState(0);
  const [liveError, setLiveError] = useState(null);

  const [selectedEventId, setSelectedEventId] = useState(null);

  // A freshly rotated secret, shown once until the user dismisses it.
  const [newSecret, setNewSecret] = useState(null);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState(null);

  // Endpoint details. There is no GET /api/endpoints/:id, so find it in the list.
  useEffect(() => {
    let ignore = false;

    getEndpoints()
      .then((list) => {
        if (ignore) return;

        const found = list.find((candidate) => candidate.id === endpointId);

        if (found) {
          setEndpoint(found);
        } else {
          setEndpointError(
            new ApiError({ status: 404, code: "ENDPOINT_NOT_FOUND", message: `Endpoint ${endpointId} does not exist on the backend.` }),
          );
        }
      })
      .catch((err) => !ignore && setEndpointError(err));

    return () => {
      ignore = true;
    };
  }, [endpointId]);

  // Recent events (reloaded after each test webhook or on Refresh).
  useEffect(() => {
    let ignore = false;

    setEventsLoading(true);
    setEventsError(null);
    getEndpointEvents(endpointId)
      .then((data) => !ignore && setEvents(data))
      .catch((err) => !ignore && setEventsError(err))
      .finally(() => !ignore && setEventsLoading(false));

    return () => {
      ignore = true;
    };
  }, [endpointId, eventsReloadKey]);

  const reloadEvents = () => setEventsReloadKey((key) => key + 1);

  // Live updates: while this tab is visible, quietly check for new events every
  // few seconds, so webhooks sent from a terminal or another service show up on
  // their own. Hidden tabs do not poll; returning to the tab checks at once.
  useEffect(() => {
    let stopped = false;
    let inFlight = false;

    function poll() {
      if (stopped || inFlight || document.visibilityState !== "visible") {
        return;
      }

      inFlight = true;
      getEndpointEvents(endpointId)
        .then((data) => {
          if (stopped) return;
          setEvents((current) => (current !== null && sameEvents(current, data) ? current : data));
          setLiveError(null);
        })
        .catch((err) => !stopped && setLiveError(err))
        .finally(() => {
          inFlight = false;
        });
    }

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", poll);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [endpointId]);

  async function handleRotateSecret() {
    const confirmed = window.confirm(
      "Rotate the signing secret?\n\nThe current secret stops working immediately. Webhooks signed with it will be rejected (401) until the sender uses the new one.",
    );

    if (!confirmed) {
      return;
    }

    setRotating(true);
    setRotateError(null);

    try {
      const { secret } = await rotateEndpointSecret(endpointId);
      setNewSecret(secret);
    } catch (err) {
      setRotateError(err);
    } finally {
      setRotating(false);
    }
  }

  function handleTestSent(eventId) {
    if (eventId) {
      setSelectedEventId(eventId);
    }

    reloadEvents();
  }

  if (endpointError) {
    return (
      <section className="page">
        <button type="button" className="link-button" onClick={onBack}>
          ← All endpoints
        </button>
        <ErrorMessage error={endpointError} title="Could not open this endpoint" />
      </section>
    );
  }

  if (!endpoint) {
    return (
      <section className="page">
        <p className="muted" role="status">
          Loading endpoint…
        </p>
      </section>
    );
  }

  const url = webhookUrl(endpoint.webhookPath);

  return (
    <section className="page">
      <button type="button" className="link-button" onClick={onBack}>
        ← All endpoints
      </button>

      <div className="page-header">
        <div>
          <h1>
            {endpoint.name} <EndpointStatus status={endpoint.status} />
          </h1>
          <dl className="details details-inline">
            <dt>Endpoint ID</dt>
            <dd>
              <span className="mono">{endpoint.id}</span> <CopyButton value={endpoint.id} />
            </dd>
            <dt>Webhook URL</dt>
            <dd>
              <span className="mono">POST {url}</span> <CopyButton value={url} />
            </dd>
            <dt>Signing secret</dt>
            <dd>
              <span className="muted">Shown once, when it was created.</span>{" "}
              <button type="button" className="button button-small" onClick={handleRotateSecret} disabled={rotating}>
                {rotating ? "Rotating…" : "Rotate secret"}
              </button>
            </dd>
          </dl>
        </div>
      </div>

      {rotateError && <ErrorMessage error={rotateError} title="Could not rotate the secret" />}

      {newSecret && (
        <div className="rotated-secret">
          <SecretReveal secret={newSecret} title="New signing secret. The old one no longer works." />
          <button type="button" className="button" onClick={() => setNewSecret(null)}>
            I have saved it, hide the secret
          </button>
        </div>
      )}

      {demo && (
        <DemoGuide endpoint={endpoint} secret={demo.secret} onSent={handleTestSent} onSelectEvent={setSelectedEventId} />
      )}

      <div className="endpoint-grid">
        <div className="column">
          <WebhookTester endpoint={endpoint} secret={demo?.secret} onSent={handleTestSent} />

          <section className="card" aria-labelledby="events-title">
            <div className="card-header">
              <h2 id="events-title">Recent webhook events</h2>
              <div className="card-header-actions">
                <span className={`live-indicator small ${liveError ? "warning" : "muted"}`} role="status">
                  <span aria-hidden="true">●</span> {liveError ? "Live updates paused" : "Live"}
                </span>
                <button type="button" className="button button-small" onClick={reloadEvents} disabled={eventsLoading}>
                  {eventsLoading ? "Loading…" : "Refresh"}
                </button>
              </div>
            </div>

            {eventsError && <ErrorMessage error={eventsError} title="Could not load events" onRetry={reloadEvents} />}

            {eventsLoading && events === null && (
              <p className="muted" role="status">
                Loading events…
              </p>
            )}

            {events !== null && events.length === 0 && (
              <div className="empty-state">
                <p className="empty-title">No webhooks received yet</p>
                <p className="muted small">
                  Send a test webhook above, or send one from your terminal with curl. New events appear here on their
                  own.
                </p>
              </div>
            )}

            {events !== null && events.length > 0 && (
              <EventList events={events} selectedEventId={selectedEventId} onSelect={setSelectedEventId} />
            )}
          </section>
        </div>

        <div className="column inspector-column">
          {selectedEventId ? (
            <RequestInspector key={selectedEventId} eventId={selectedEventId} />
          ) : (
            <div className="card empty-state">
              <p className="empty-title">Request inspector</p>
              <p className="muted small">
                Select an event to see the request that arrived, each verification step, and the response that was
                sent back.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
