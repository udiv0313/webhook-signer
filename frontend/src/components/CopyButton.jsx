import { useState } from "react";

// Copies a value such as an endpoint ID, a webhook URL, or a newly shown secret.
export default function CopyButton({ value, label = "Copy" }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be blocked; the value is still visible to copy by hand.
    }
  }

  return (
    <button type="button" className="button button-small" onClick={handleCopy}>
      {copied ? "Copied" : label}
    </button>
  );
}
