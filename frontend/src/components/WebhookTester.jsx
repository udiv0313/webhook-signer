import { useState } from "react";
import { sendTestWebhook } from "../services/api.js";
import { webhookUrl } from "../config.js";
import { signAndSendCommands } from "../terminal.js";
import ErrorMessage from "./ErrorMessage.jsx";
import { HttpStatusBadge } from "./StatusBadge.jsx";

// "Send test webhook": the backend signs the payload (optionally broken on
// purpose for a failure scenario) and delivers it to the real webhook URL.
// Also shows equivalent openssl + curl commands for a terminal.

const DEFAULT_PAYLOAD = `{
  "event": "payment.success",
  "customer_id": "cus_123",
  "amount": 4999
}`;

// Each scenario is built and signed by the backend with the endpoint's secret;
// the tester never needs it.
const SCENARIOS = [
  { value: "valid", label: "Valid webhook", expected: "200 accepted" },
  { value: "invalid_signature", label: "Signed with the wrong secret", expected: "401 INVALID_SIGNATURE" },
  { value: "tampered_body", label: "Body changed after signing (newline added)", expected: "401 INVALID_SIGNATURE" },
  { value: "expired_timestamp", label: "Expired timestamp (looks like a replay)", expected: "401 TIMESTAMP_TOO_OLD" },
  { value: "missing_signature", label: "Missing signature header", expected: "401 MISSING_SIGNATURE" },
  { value: "malformed_timestamp", label: "Timestamp in milliseconds", expected: "400 MALFORMED_TIMESTAMP" },
  { value: "replay", label: "Same request sent twice (replay)", expected: "409 REPLAY_DETECTED" },
];

function isValidJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// `secret` is only known right after the endpoint was created (guided demo);
// otherwise the terminal commands show a placeholder to replace.
export default function WebhookTester({ endpoint, secret, onSent }) {
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

  const terminalCommands = signAndSendCommands({ url: webhookUrl(endpoint.webhookPath), payload, secret });

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
        {secret ? (
          <p className="small muted">Needs only openssl and curl. This endpoint's signing secret is already filled in.</p>
        ) : (
          <p className="small muted">
            Needs only openssl and curl. <strong>First replace whsec_... with this endpoint's signing secret</strong>{" "}
            (shown once, when the endpoint was created; lost it? Rotate the secret above). Pasted unchanged, the
            commands stop and tell you so. In this project you can also sign with the CLI:
            WEBHOOK_ENDPOINT_SECRET=... node src/cli/sign.js.
          </p>
        )}
        <pre className="code-block">{terminalCommands}</pre>
      </details>
    </section>
  );
}
