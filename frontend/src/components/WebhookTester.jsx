import { useState } from "react";
import { sendTestWebhook } from "../services/api.js";
import { webhookUrl } from "../config.js";
import ErrorMessage from "./ErrorMessage.jsx";
import { HttpStatusBadge } from "./StatusBadge.jsx";

const DEFAULT_PAYLOAD = `{
  "event": "payment.success",
  "customer_id": "cus_123",
  "amount": 4999
}`;

// Each scenario is built and signed by the backend; the browser never sees a secret.
const SCENARIOS = [
  { value: "valid", label: "Valid webhook", expected: "200 accepted" },
  { value: "invalid_signature", label: "Signed with the wrong secret", expected: "401 INVALID_SIGNATURE" },
  { value: "tampered_body", label: "Body changed after signing (newline added)", expected: "401 INVALID_SIGNATURE" },
  { value: "expired_timestamp", label: "Expired timestamp (looks like a replay)", expected: "401 TIMESTAMP_TOO_OLD" },
  { value: "missing_signature", label: "Missing signature header", expected: "401 MISSING_SIGNATURE" },
  { value: "malformed_timestamp", label: "Timestamp in milliseconds", expected: "400 MALFORMED_TIMESTAMP" },
];

// Wrap text in single quotes for a shell command, escaping any single quotes inside.
function shellQuote(text) {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function isValidJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export default function WebhookTester({ endpoint, onSent }) {
  const [payload, setPayload] = useState(DEFAULT_PAYLOAD);
  const [scenario, setScenario] = useState("valid");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const selectedScenario = SCENARIOS.find((option) => option.value === scenario);

  async function handleSubmit(submitEvent) {
    submitEvent.preventDefault();
    setSending(true);
    setError(null);
    setResult(null);

    try {
      const sent = await sendTestWebhook(endpoint.id, { payload, scenario });
      setResult(sent);
      onSent(sent.eventId);
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  }

  const terminalCommands = [
    `BODY=${shellQuote(payload)}`,
    `node --env-file=.env src/cli/sign.js --endpoint=${endpoint.id} "$BODY" > /tmp/webhook-headers.txt`,
    `curl -i -X POST ${webhookUrl(endpoint.webhookPath)} \\\n  -H "Content-Type: application/json" \\\n  -H @/tmp/webhook-headers.txt \\\n  --data-binary "$BODY"`,
  ].join("\n");

  return (
    <section className="card" aria-labelledby="tester-title">
      <h2 id="tester-title">Send test webhook</h2>
      <p className="small muted">
        The backend signs this payload with the endpoint's secret and delivers it to the real webhook URL, so it goes
        through exactly the same verification as an external sender. Pick a scenario to see how each failure looks.
      </p>

      <form onSubmit={handleSubmit}>
        <label htmlFor="payload">Payload (sent byte-for-byte as typed)</label>
        <textarea
          id="payload"
          className="mono"
          rows={7}
          spellCheck={false}
          value={payload}
          onChange={(changeEvent) => setPayload(changeEvent.target.value)}
        />
        {!isValidJson(payload) && (
          <p className="small warning">
            <span aria-hidden="true">!</span> Not valid JSON. It will still be signed and sent exactly as typed.
          </p>
        )}

        <label htmlFor="scenario">Scenario</label>
        <select id="scenario" value={scenario} onChange={(changeEvent) => setScenario(changeEvent.target.value)}>
          {SCENARIOS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="small muted">
          Expected result: <span className="mono">{selectedScenario.expected}</span>
        </p>

        <button type="submit" className="button button-primary" disabled={sending}>
          {sending ? "Sending…" : "Send webhook"}
        </button>
      </form>

      <div aria-live="polite">
        {error && <ErrorMessage error={error} title="The test webhook was not sent" />}
        {result && (
          <div className={`alert ${result.response.status === 200 ? "alert-pass" : "alert-fail"}`}>
            <p className="alert-title">Sent. The webhook endpoint answered:</p>
            <p>
              <HttpStatusBadge status={result.response.status} />{" "}
              <span className="mono small">
                {result.response.body?.error?.code ?? (result.response.status === 200 ? "VALID" : "")}
              </span>
            </p>
            <p className="small muted">Full details are open in the inspector.</p>
          </div>
        )}
      </div>

      <details className="terminal">
        <summary>Send the same payload from your terminal</summary>
        <p className="small muted">
          Run from the project folder. The CLI reads WEBHOOK_SECRET from .env on your machine; it is never in the
          browser.
        </p>
        <pre className="code-block">{terminalCommands}</pre>
      </details>
    </section>
  );
}
