// Turns a verification result into a step-by-step checklist and a plain-English
// explanation of what went wrong and how to fix it.
//
// The backend checks a webhook in this order and stops at the first failure:
//   1. body size  2. headers present and well-formed  3. timestamp window  4. signature
// Steps after a failure never ran, so they are shown as "not checked", not as passed.

const STEPS = ["Body size", "Headers", "Timestamp", "Signature"];

// Which step (index into STEPS) each error code fails at.
const FAILED_STEP = {
  PAYLOAD_TOO_LARGE: 0,
  MISSING_TIMESTAMP: 1,
  MALFORMED_TIMESTAMP: 1,
  MISSING_SIGNATURE: 1,
  MALFORMED_SIGNATURE: 1,
  TIMESTAMP_TOO_OLD: 2,
  TIMESTAMP_IN_FUTURE: 2,
  INVALID_SIGNATURE: 3,
};

const PASS_DETAILS = [
  "Within the size limit",
  "Timestamp and signature headers present and well-formed",
  "Within the allowed time window",
  "Matches the body and timestamp that arrived",
];

const EXPLANATIONS = {
  VALID: {
    summary: "The signature matches the body that arrived and the timestamp is within the allowed window.",
    fix: null,
  },
  PAYLOAD_TOO_LARGE: {
    summary: "The body was larger than WEBHOOK_MAX_BODY_SIZE, so the server stopped reading it and never verified it.",
    fix: "Send a smaller payload, or raise WEBHOOK_MAX_BODY_SIZE on the server.",
  },
  MISSING_TIMESTAMP: {
    summary: "The X-Webhook-Timestamp header was not sent.",
    fix: "The sender must include X-Webhook-Timestamp with the current Unix time in seconds.",
  },
  MALFORMED_TIMESTAMP: {
    summary: "X-Webhook-Timestamp is not Unix time in whole seconds.",
    fix: "Send 10-digit seconds. A 13-digit value usually means the sender used milliseconds (Date.now()) instead of seconds.",
  },
  MISSING_SIGNATURE: {
    summary: "The X-Webhook-Signature header was not sent.",
    fix: "The sender must include X-Webhook-Signature: sha256=<64 hex characters>.",
  },
  MALFORMED_SIGNATURE: {
    summary: "X-Webhook-Signature is not sha256= followed by 64 hex characters.",
    fix: "Check the sha256= prefix, that the digest is hex (not base64), and that it was not cut off.",
  },
  TIMESTAMP_TOO_OLD: {
    summary: "The timestamp is older than the allowed window. A replayed (captured and re-sent) request looks exactly like this.",
    fix: "Sign every delivery, including retries, with a fresh timestamp. If the clocks differ, sync them with NTP.",
  },
  TIMESTAMP_IN_FUTURE: {
    summary: "The timestamp is further in the future than the allowed window.",
    fix: "The sender's clock is probably ahead of the server's. Sync both clocks with NTP.",
  },
  INVALID_SIGNATURE: {
    summary: "The headers and timestamp are fine, but the signature does not match the body that arrived.",
    fix: "Common causes: the body changed after signing (JSON re-serialized, a newline added), the wrong endpoint ID was used to sign, or the sender and server use different WEBHOOK_SECRET values.",
  },
};

// 600 → "600 s old", -30 → "30 s in the future"
export function describeAge(ageSeconds) {
  if (ageSeconds === null || ageSeconds === undefined) {
    return null;
  }

  return ageSeconds >= 0 ? `${ageSeconds} s old` : `${-ageSeconds} s in the future`;
}

// → [{ label, state: "pass" | "fail" | "skipped", detail }]
export function getChecklist(verification) {
  const { code, reason, timestampAgeSeconds } = verification;
  const failedAt = code === "VALID" ? STEPS.length : FAILED_STEP[code];
  const age = describeAge(timestampAgeSeconds);

  return STEPS.map((label, index) => {
    // Unknown code: we cannot say which steps ran.
    if (failedAt === undefined) {
      return { label, state: "skipped", detail: "Unknown result" };
    }

    if (index < failedAt) {
      const detail = index === 2 && age ? `${PASS_DETAILS[index]} (${age})` : PASS_DETAILS[index];
      return { label, state: "pass", detail };
    }

    if (index === failedAt) {
      const detail = index === 2 && age ? `${reason} (${age})` : reason;
      return { label, state: "fail", detail };
    }

    return { label, state: "skipped", detail: "Not checked: the request was rejected at an earlier step" };
  });
}

export function getExplanation(code) {
  return EXPLANATIONS[code] ?? { summary: "Unknown verification result.", fix: null };
}

const STATUS_TEXT = {
  200: "OK",
  201: "Created",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  500: "Internal Server Error",
  502: "Bad Gateway",
};

export function httpStatusText(status) {
  return STATUS_TEXT[status] ?? "";
}
