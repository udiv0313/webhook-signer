import { useEffect, useState } from "react";
import { ApiError, getEndpointEvents, getEndpoints } from "../services/api.js";
import { webhookUrl } from "../config.js";
import CopyButton from "../components/CopyButton.jsx";
import ErrorMessage from "../components/ErrorMessage.jsx";
import EventList from "../components/EventList.jsx";
import RequestInspector from "../components/RequestInspector.jsx";
import WebhookTester from "../components/WebhookTester.jsx";
import { EndpointStatus } from "../components/StatusBadge.jsx";

// One endpoint: its details, a test sender, its recent events, and the
// inspector for the selected event, all on one screen.
export default function EndpointPage({ endpointId, onBack }) {
  const [endpoint, setEndpoint] = useState(null);
  const [endpointError, setEndpointError] = useState(null);

  const [events, setEvents] = useState(null);
  const [eventsError, setEventsError] = useState(null);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsReloadKey, setEventsReloadKey] = useState(0);

  const [selectedEventId, setSelectedEventId] = useState(null);

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
            <dd className="muted">Kept on the server, never sent to the browser</dd>
          </dl>
        </div>
      </div>

      <div className="endpoint-grid">
        <div className="column">
          <WebhookTester endpoint={endpoint} onSent={handleTestSent} />

          <section className="card" aria-labelledby="events-title">
            <div className="card-header">
              <h2 id="events-title">Recent webhook events</h2>
              <button type="button" className="button button-small" onClick={reloadEvents} disabled={eventsLoading}>
                {eventsLoading ? "Loading…" : "Refresh"}
              </button>
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
                <p className="muted small">Send a test webhook above, or send one from your terminal with curl.</p>
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
