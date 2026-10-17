import { useState } from "react";
import { createEndpoint } from "../services/api.js";
import { webhookUrl } from "../config.js";
import CopyButton from "../components/CopyButton.jsx";
import ErrorMessage from "../components/ErrorMessage.jsx";
import SecretReveal from "../components/SecretReveal.jsx";
import { EndpointStatus } from "../components/StatusBadge.jsx";

// Create an endpoint, then show its signing secret once. Leaving the page is
// only possible after the user confirms they saved the secret.
export default function CreateEndpointPage({ onOpenEndpoint, onCancel }) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  // The secret is gone once the user leaves this screen, so leaving is only
  // possible after they confirm they saved it.
  const [secretSaved, setSecretSaved] = useState(false);

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      setCreated(await createEndpoint(name));
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    const url = webhookUrl(created.webhookPath);

    return (
      <section className="page narrow">
        <div className="alert alert-pass" role="status">
          <p className="alert-title">
            <span aria-hidden="true">✓</span> Endpoint created
          </p>
        </div>

        <SecretReveal secret={created.secret} />

        <div className="card">
          <h2>{created.name}</h2>
          <dl className="details">
            <dt>Endpoint ID</dt>
            <dd>
              <span className="mono">{created.id}</span> <CopyButton value={created.id} />
            </dd>
            <dt>Webhook URL</dt>
            <dd>
              <span className="mono">POST {url}</span> <CopyButton value={url} />
            </dd>
            <dt>Status</dt>
            <dd>
              <EndpointStatus status={created.status} />
            </dd>
          </dl>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={secretSaved}
              onChange={(changeEvent) => setSecretSaved(changeEvent.target.checked)}
            />
            I have saved the signing secret
          </label>
          <div className="actions">
            <button
              type="button"
              className="button button-primary"
              disabled={!secretSaved}
              onClick={() => onOpenEndpoint(created.id)}
            >
              Open endpoint and send a test webhook
            </button>
            <button
              type="button"
              className="button"
              disabled={!secretSaved}
              onClick={() => {
                setCreated(null);
                setSecretSaved(false);
                setName("");
              }}
            >
              Create another
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="page narrow">
      <h1>Create endpoint</h1>
      <p className="muted">
        An endpoint is a URL that receives webhooks from one sender, for example Stripe. Every request to it is checked
        with that endpoint's own signing secret and recorded, so you can inspect what arrived and why it was accepted
        or rejected.
      </p>

      <form className="card" onSubmit={handleSubmit}>
        <label htmlFor="endpoint-name">Endpoint name</label>
        <input
          id="endpoint-name"
          type="text"
          placeholder="Stripe Payments"
          maxLength={100}
          required
          value={name}
          onChange={(changeEvent) => setName(changeEvent.target.value)}
        />
        <p className="small muted">A label for you. 1–100 characters.</p>

        {error && <ErrorMessage error={error} title="Could not create the endpoint" />}

        <div className="actions">
          <button type="submit" className="button button-primary" disabled={submitting}>
            {submitting ? "Creating…" : "Create endpoint"}
          </button>
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
