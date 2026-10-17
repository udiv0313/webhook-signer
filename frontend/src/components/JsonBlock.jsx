// Readable, scrollable display for JSON (or any text).
//
//   value    a string (e.g. a raw webhook body) or an object (e.g. a response)
//   format   true: pretty-print JSON when possible
//            false: show the exact text, escaped so whitespace like \n is visible

const MAX_CHARACTERS = 20_000;

function toDisplayText(value, format) {
  if (typeof value !== "string") {
    return JSON.stringify(value, null, 2);
  }

  if (!format) {
    return JSON.stringify(value); // quotes and escapes: "{...}\n"
  }

  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value; // not JSON: show as-is
  }
}

export default function JsonBlock({ value, format = true, label }) {
  const text = toDisplayText(value, format);
  const truncated = text.length > MAX_CHARACTERS;

  return (
    <>
      {/* Exact view wraps so the end of the body (e.g. a trailing \n) is always visible. */}
      <pre className={format ? "code-block" : "code-block code-block-wrap"} tabIndex={0} aria-label={label}>
        {truncated ? text.slice(0, MAX_CHARACTERS) : text}
      </pre>
      {truncated && (
        <p className="small muted">
          Showing the first {MAX_CHARACTERS.toLocaleString()} of {text.length.toLocaleString()} characters.
        </p>
      )}
    </>
  );
}
