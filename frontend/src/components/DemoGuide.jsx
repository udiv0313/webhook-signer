import { useState } from "react";
import { sendTestWebhook } from "../services/api.js";
import { webhookUrl } from "../config.js";
import { signAndSendCommands } from "../terminal.js";
import ErrorMessage from "./ErrorMessage.jsx";
import SecretReveal from "./SecretReveal.jsx";
import { HttpStatusBadge } from "./StatusBadge.jsx";

// Step-by-step guide on the demo endpoint's page (see STEPS below).

const DEMO_PAYLOAD = '{"event":"payment.success","amount":4999}';

// The guided demo, shown on the endpoint created by "Try it in 60 seconds".
// Each step uses the real test sender, so every result is a real webhook that
// went through the real verification, and appears in the event list.
const STEPS = [
  {
    id: "valid",
    scenario: "valid",
    title: "Send a correctly signed webhook",
    explain: "The server signs it with this endpoint's secret and delivers it to the webhook URL.",
    button: "Send valid webhook",
  },
  {
    id: "tampered",
    scenario: "tampered_body",
    title: "Change the body after signing",
    explain: "One newline is added after signing, as a proxy or middleware might. The signature no longer matches.",
    button: "Send tampered webhook",
  },
  {
    id: "inspect",
    title: "See why it was rejected",
    explain: "The inspector shows each check in order, which one failed, and how to fix it.",
    button: "Open the rejected event",
  },
  {
    id: "replay",
    scenario: "replay",
    title: "Replay a captured request",
    explain:
      "The exact same signed request is sent twice, as an attacker would after capturing it. Signature and timestamp are still valid, but the second copy is refused.",
    button: "Send the same request twice",
  },
];

export default function DemoGuide({ endpoint, secret, onSent, onSelectEvent }) {
  const [results, setResults] = useState({}); // step id → { status, code, eventId }
  const [busyStep, setBusyStep] = useState(null);
  const [error, setError] = useState(null);

  async function runStep(step) {
    setError(null);

    if (step.id === "inspect") {
      onSelectEvent(results.tampered.eventId);
      setResults((current) => ({ ...current, inspect: { done: true } }));
      return;
    }

    setBusyStep(step.id);

    try {
      const sent = await sendTestWebhook(endpoint.id, { payload: DEMO_PAYLOAD, scenario: step.scenario });
      const code = sent.response.body?.error?.code ?? "VALID";

      setResults((current) => ({ ...current, [step.id]: { status: sent.response.status, code, eventId: sent.eventId } }));
      onSent(sent.eventId);
    } catch (err) {
      setError(err);
    } finally {
      setBusyStep(null);
    }
  }

  const doneCount = STEPS.filter((step) => results[step.id]).length;

  return (
    <section className="card demo-guide" aria-labelledby="demo-title">
      <div className="card-header">
        <h2 id="demo-title">Guided demo</h2>
        <span className="small muted">
          {doneCount} of {STEPS.length} done
        </span>
      </div>

      <details className="demo-secret">
        <summary>This endpoint's signing secret (only available on this page, now)</summary>
        <SecretReveal secret={secret} title="Signing secret for the demo endpoint" />
      </details>

      <ol className="demo-steps">
        {STEPS.map((step, index) => {
          const result = results[step.id];
          const previousDone = index === 0 || Boolean(results[STEPS[index - 1].id]);

          return (
            <li key={step.id} className={`demo-step ${result ? "demo-step-done" : ""}`}>
              <div className="demo-step-text">
                <p className="demo-step-title">
                  <span aria-hidden="true">{result ? "✓" : index + 1}</span> {step.title}
                </p>
                <p className="small muted">{step.explain}</p>
                {result?.status && (
                  <p className="small">
                    Endpoint answered <HttpStatusBadge status={result.status} />{" "}
                    <span className="mono">{result.code}</span>
                  </p>
                )}
              </div>
              <button
                type="button"
                className={`button button-small ${!result && previousDone ? "button-primary" : ""}`}
                onClick={() => runStep(step)}
                disabled={!previousDone || busyStep !== null}
              >
                {busyStep === step.id ? "Sending…" : step.button}
              </button>
            </li>
          );
        })}
      </ol>

      {error && <ErrorMessage error={error} title="That step did not run" />}

      <details className="terminal">
        <summary>Now try it from your own terminal (needs only openssl and curl)</summary>
        <p className="small muted">
          Signs with this endpoint's secret and sends a fresh webhook. It appears in the event list within a few
          seconds. Run it twice in the same second and the second one is refused as a replay.
        </p>
        <pre className="code-block">
          {signAndSendCommands({ url: webhookUrl(endpoint.webhookPath), payload: DEMO_PAYLOAD, secret })}
        </pre>
      </details>
    </section>
  );
}
