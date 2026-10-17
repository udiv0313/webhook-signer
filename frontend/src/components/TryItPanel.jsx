import { useState } from "react";
import { createEndpoint } from "../services/api.js";
import ErrorMessage from "./ErrorMessage.jsx";

// The first thing a visitor sees: a one-click guided demo. It creates an
// endpoint, then the endpoint page walks through a valid webhook, a tampered
// one, why it failed, and a replay.
export default function TryItPanel({ onStarted }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  async function handleStart() {
    setStarting(true);
    setError(null);

    try {
      onStarted(await createEndpoint("Demo endpoint"));
    } catch (err) {
      setError(err);
      setStarting(false);
    }
  }

  return (
    <section className="card try-it" aria-labelledby="try-it-title">
      <h2 id="try-it-title">Try it in 60 seconds</h2>
      <p className="muted">
        See how signed webhooks are verified, and exactly why a bad one is rejected. Nothing to install.
      </p>
      <ol className="try-it-steps">
        <li>Create a demo endpoint with its own signing secret</li>
        <li>Send a correctly signed webhook: accepted</li>
        <li>Send one whose body changed after signing: rejected, and see why</li>
        <li>Re-send a captured request: blocked as a replay</li>
      </ol>
      <button type="button" className="button button-primary" onClick={handleStart} disabled={starting}>
        {starting ? "Creating demo endpoint…" : "Start the guided demo"}
      </button>
      {error && <ErrorMessage error={error} title="Could not start the demo" />}
    </section>
  );
}
