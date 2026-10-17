// Public display configuration. Every VITE_* value is bundled into the browser
// JavaScript, so it must never hold a secret.

// Where webhook senders should POST (the backend), used to show full webhook URLs.
export const WEBHOOK_BASE_URL = (import.meta.env.VITE_WEBHOOK_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

export function webhookUrl(webhookPath) {
  return `${WEBHOOK_BASE_URL}${webhookPath}`;
}
