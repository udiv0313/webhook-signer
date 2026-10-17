// Public display configuration. Every VITE_* value is bundled into the browser
// JavaScript, so it must never hold a secret.

// Where webhook senders should POST, used to show full webhook URLs.
// In production the backend serves this page, so the page's own origin is the
// right default. In development the page comes from the Vite dev server, so
// the default is the backend's own address.
const DEFAULT_BASE_URL = import.meta.env.DEV ? "http://localhost:3000" : window.location.origin;

export const WEBHOOK_BASE_URL = (import.meta.env.VITE_WEBHOOK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");

export function webhookUrl(webhookPath) {
  return `${WEBHOOK_BASE_URL}${webhookPath}`;
}
