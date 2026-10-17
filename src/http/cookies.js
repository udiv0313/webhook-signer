// Minimal cookie reading and writing for the native HTTP server.

// "a=1; ws=abc" → { a: "1", ws: "abc" }
// Pairs without "=" or with an empty name are skipped. If a name appears more
// than once, the first value wins (the most specific one, per RFC 6265).
function parseCookies(header) {
  const cookies = {};

  if (typeof header !== "string") {
    return cookies;
  }

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();

    if (name !== "" && !Object.hasOwn(cookies, name)) {
      cookies[name] = value;
    }
  }

  return cookies;
}

// serializeCookie("ws", "abc", { maxAge: 60, secure: true })
//   → "ws=abc; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure"
// The value must already be cookie-safe (we only ever set base64url tokens).
function serializeCookie(name, value, { maxAge, secure = false }) {
  const parts = [`${name}=${value}`, "Path=/", `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];

  if (secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

export { parseCookies, serializeCookie };
