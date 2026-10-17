import CopyButton from "./CopyButton.jsx";

// Shows an endpoint's signing secret. The API returns it only once (when the
// endpoint is created or its secret is rotated), so this is the user's only
// chance to copy it. It lives only in React state while shown: it is never
// written to localStorage, the URL, or the console.
export default function SecretReveal({ secret, title = "Save your signing secret" }) {
  return (
    <div className="alert alert-warning" role="status">
      <p className="alert-title">
        <span aria-hidden="true">!</span> {title}
      </p>
      <p className="small">
        This is the only time it is shown. Store it where your webhook sender can use it, for example in an environment
        variable. If you lose it, rotate the secret to get a new one.
      </p>
      <div className="secret-row">
        <code className="secret-value" aria-label="Signing secret">
          {secret}
        </code>
        <CopyButton value={secret} label="Copy secret" />
      </div>
    </div>
  );
}
