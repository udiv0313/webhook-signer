import { HttpStatusBadge } from "./StatusBadge.jsx";

// Clickable list of an endpoint's recent events (newest first), with the
// verdict, HTTP status and event type of each.

function formatTime(isoTime) {
  return new Date(isoTime).toLocaleTimeString();
}

// One clickable row per event: ✓/✕, event type, reason, HTTP status, time.
export default function EventList({ events, selectedEventId, onSelect }) {
  return (
    <ul className="event-list">
      {events.map((event) => {
        const { valid, code, reason } = event.verification;
        const selected = event.id === selectedEventId;

        return (
          <li key={event.id}>
            <button
              type="button"
              className={`event-row ${selected ? "event-row-selected" : ""}`}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(event.id)}
            >
              <span className={`event-icon ${valid ? "text-pass" : "text-fail"}`} aria-hidden="true">
                {valid ? "✓" : "✕"}
              </span>
              <span className="event-main">
                <span className="event-type mono">{event.eventType ?? "(no event type)"}</span>
                <span className="small muted">
                  {valid ? "Accepted" : `Rejected: ${reason}`} · <span className="mono">{code}</span>
                </span>
              </span>
              <span className="event-meta">
                <HttpStatusBadge status={event.responseStatus} />
                <span className="small muted">{formatTime(event.receivedAt)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
