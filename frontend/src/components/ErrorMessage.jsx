// Shows an ApiError (see services/api.js) with what failed, the HTTP status,
// the error code, and a hint for the most common causes.

const HINTS = {
  NETWORK_ERROR: "Start the backend in another terminal with: npm start",
  ENDPOINT_NOT_FOUND: "Endpoints are stored in memory, so they disappear when the backend restarts. Create it again.",
  EVENT_NOT_FOUND: "Only the 100 most recent events are kept, and all events are cleared when the backend restarts.",
  TEST_SENDER_DISABLED: "Set WEBHOOK_TEST_SENDER_ENABLED=true in the backend's .env file and restart the backend.",
  TEST_SENDER_LOCAL_ONLY: "Open the UI on the same machine as the backend.",
};

export default function ErrorMessage({ error, title = "Request failed", onRetry }) {
  const hint = HINTS[error.code];

  return (
    <div className="alert alert-error" role="alert">
      <p className="alert-title">
        <span aria-hidden="true">✕</span> {title}
      </p>
      <p>{error.message}</p>
      <p className="mono small muted">
        {error.status ? `HTTP ${error.status}` : "No HTTP response"} · {error.code}
      </p>
      {hint && <p className="small">{hint}</p>}
      {onRetry && (
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
