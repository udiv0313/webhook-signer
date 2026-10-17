import { useEffect, useState } from "react";
import { getEndpoints } from "../services/api.js";
import { webhookUrl } from "../config.js";
import ErrorMessage from "../components/ErrorMessage.jsx";
import TryItPanel from "../components/TryItPanel.jsx";
import { EndpointStatus } from "../components/StatusBadge.jsx";

// Home page: the "Try it in 60 seconds" demo and this workspace's endpoints.
export default function DashboardPage({ onOpenEndpoint, onCreateEndpoint, onStartDemo }) {
  const [endpoints, setEndpoints] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let ignore = false;

    setLoading(true);
    setError(null);
    getEndpoints()
      .then((data) => !ignore && setEndpoints(data))
      .catch((err) => !ignore && setError(err))
      .finally(() => !ignore && setLoading(false));

    return () => {
      ignore = true;
    };
  }, [reloadKey]);

  const reload = () => setReloadKey((key) => key + 1);

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <h1>Endpoints</h1>
          <p className="muted">
            Each endpoint is a URL that accepts signed webhooks. Open one to send a test webhook and inspect exactly
            what happened to it.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="button" onClick={reload} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button type="button" className="button button-primary" onClick={onCreateEndpoint}>
            + Create endpoint
          </button>
        </div>
      </div>

      <TryItPanel onStarted={onStartDemo} />

      {error && <ErrorMessage error={error} title="Could not load endpoints" onRetry={reload} />}

      {loading && endpoints === null && (
        <p className="muted" role="status">
          Loading endpoints…
        </p>
      )}

      {endpoints !== null && endpoints.length === 0 && (
        <div className="card empty-state">
          <p className="empty-title">No endpoints yet</p>
          <p className="muted">
            Create an endpoint to get a webhook URL. Endpoints belong to this browser and are deleted after 72
            hours.
          </p>
          <button type="button" className="button button-primary" onClick={onCreateEndpoint}>
            + Create endpoint
          </button>
        </div>
      )}

      {endpoints !== null && endpoints.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Endpoint</th>
                <th scope="col">Status</th>
                <th scope="col">Webhook URL</th>
                <th scope="col" className="num">
                  Recent events
                </th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <tr key={endpoint.id} className="clickable-row" onClick={() => onOpenEndpoint(endpoint.id)}>
                  <td>
                    <button type="button" className="link-button" onClick={() => onOpenEndpoint(endpoint.id)}>
                      {endpoint.name}
                    </button>
                    <div className="mono small muted">{endpoint.id}</div>
                  </td>
                  <td>
                    <EndpointStatus status={endpoint.status} />
                  </td>
                  <td className="mono small">POST {webhookUrl(endpoint.webhookPath)}</td>
                  <td className="num">
                    {endpoint.recentEventCount} {endpoint.recentEventCount === 1 ? "event" : "events"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
