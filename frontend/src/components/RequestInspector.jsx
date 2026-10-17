import { useEffect, useState } from "react";
import { getEvent } from "../services/api.js";
import ErrorMessage from "./ErrorMessage.jsx";
import JsonBlock from "./JsonBlock.jsx";
import VerificationChecklist from "./VerificationChecklist.jsx";
import { HttpStatusBadge, VerdictBadge } from "./StatusBadge.jsx";

// Everything about one webhook, in the order it happened:
// what was received → how it was verified → what the server answered.
export default function RequestInspector({ eventId }) {
  const [event, setEvent] = useState(null);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showExactBody, setShowExactBody] = useState(false);

  useEffect(() => {
    let ignore = false; // drop responses that arrive after the user picked another event

    setError(null);
    getEvent(eventId)
      .then((data) => !ignore && setEvent(data))
      .catch((err) => !ignore && setError(err));

    return () => {
      ignore = true;
    };
  }, [eventId, reloadKey]);

  if (error) {
    return (
      <section className="card">
        <ErrorMessage error={error} title="Could not load this event" onRetry={() => setReloadKey((key) => key + 1)} />
      </section>
    );
  }

  if (!event) {
    return (
      <section className="card">
        <p className="muted" role="status">
          Loading event…
        </p>
      </section>
    );
  }

  const { request, verification, response } = event;

  return (
    <section className="card inspector" aria-label="Request inspector">
      <div className={`verdict ${verification.valid ? "verdict-pass" : "verdict-fail"}`}>
        <span className="verdict-icon" aria-hidden="true">
          {verification.valid ? "✓" : "✕"}
        </span>
        <div className="verdict-text">
          <p className="verdict-title">{verification.valid ? "Webhook accepted" : "Webhook rejected"}</p>
          <p>
            {verification.reason} · <span className="mono">{verification.code}</span>
          </p>
        </div>
        <HttpStatusBadge status={response.status} />
      </div>
      <p className="small muted mono">
        {event.id} · received {new Date(event.receivedAt).toLocaleString()}
      </p>

      <h3 className="section-title">1. Request</h3>
      <p className="request-line mono">
        <strong>{request.method}</strong> {request.path}
      </p>

      <h4>Headers</h4>
      <dl className="header-list">
        {Object.entries(request.headers).map(([name, value]) => (
          <div key={name} className="header-row">
            <dt className="mono">{name}</dt>
            <dd className="mono">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="small muted">
        Only these headers are stored (credentials like Authorization are dropped). The signature is cut to its first
        12 characters so a stored event can never be replayed.
      </p>

      <div className="body-header">
        <h4>
          Body <span className="small muted">({request.bodyBytes === null ? "not read" : `${request.bodyBytes} bytes`})</span>
        </h4>
        {request.body !== null && (
          <div className="toggle" role="group" aria-label="Body view">
            <button type="button" aria-pressed={!showExactBody} onClick={() => setShowExactBody(false)}>
              Formatted
            </button>
            <button type="button" aria-pressed={showExactBody} onClick={() => setShowExactBody(true)}>
              Exact bytes
            </button>
          </div>
        )}
      </div>
      {request.body === null ? (
        <p className="muted">The body was larger than the size limit, so the server never read it.</p>
      ) : (
        <>
          <JsonBlock value={request.body} format={!showExactBody} label="Request body" />
          <p className="small muted">
            {showExactBody
              ? "Escaped so that spaces and newlines are visible. The signature covers exactly these bytes."
              : "Formatted for reading only. The signature covers the exact bytes; switch to Exact bytes to compare."}
          </p>
        </>
      )}

      <h3 className="section-title">2. Verification</h3>
      <VerificationChecklist verification={verification} />

      <h3 className="section-title">3. Response</h3>
      <p>
        <HttpStatusBadge status={response.status} /> <VerdictBadge valid={verification.valid} />
      </p>
      {response.body ? (
        <JsonBlock value={response.body} label="Response body" />
      ) : (
        <p className="muted">Response body was not recorded.</p>
      )}
    </section>
  );
}
