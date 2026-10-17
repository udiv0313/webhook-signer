import { httpStatusText } from "../diagnostics.js";

// Status is always shown as icon + text, never by color alone.

// e.g. "✓ HTTP 200 OK" or "✕ HTTP 401 Unauthorized"
export function HttpStatusBadge({ status }) {
  if (!status) {
    return <span className="badge badge-neutral">No response</span>;
  }

  const ok = status >= 200 && status < 300;

  return (
    <span className={`badge ${ok ? "badge-pass" : "badge-fail"}`}>
      <span aria-hidden="true">{ok ? "✓" : "✕"}</span> HTTP {status} {httpStatusText(status)}
    </span>
  );
}

// "✓ Accepted" / "✕ Rejected"
export function VerdictBadge({ valid }) {
  return (
    <span className={`badge ${valid ? "badge-pass" : "badge-fail"}`}>
      <span aria-hidden="true">{valid ? "✓" : "✕"}</span> {valid ? "Accepted" : "Rejected"}
    </span>
  );
}

// Endpoint status, e.g. "● Active"
export function EndpointStatus({ status }) {
  const active = status === "active";

  return (
    <span className={`badge ${active ? "badge-pass" : "badge-neutral"}`}>
      <span aria-hidden="true">●</span> {active ? "Active" : status}
    </span>
  );
}
