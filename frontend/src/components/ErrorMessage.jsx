// Shows an ApiError (see services/api.js) with what failed, the HTTP status,
// the error code, and a hint for the most common causes.

const HINTS = {
  NETWORK_ERROR: "Start the backend in another terminal with: npm start",
  ENDPOINT_NOT_FOUND: "Endpoints belong to the browser that created them and are deleted after 72 hours. Create it again.",
  EVENT_NOT_FOUND: "Only the 50 newest events per endpoint are kept, and events belong to the browser that created the endpoint.",
  TEST_SENDER_DISABLED: "Set WEBHOOK_TEST_SENDER_ENABLED=true in the backend's .env file and restart the backend.",
  RATE_LIMITED: "Too many requests from this browser or network. Wait for the time shown above, then try again.",
  ENDPOINT_LIMIT_REACHED: "This browser's workspace has reached its endpoint limit. Use an existing endpoint instead.",
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
